import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { AnaliseCliente } from '../ai/ai.service';

export interface HistoricoOwner {
  owner_id: string;
  nome_cliente: string;
  dias_historico: number;
  acoes_90d: number;
  acoes_30d: number;
  acoes_core_30d: number;
  acoes_core_90d: number;
  acoes_negativas_30d: number;
  entidades_utilizadas: number;
  usuarios_ativos: number;
  acoes_automatizadas_30d: number;
}

@Injectable()
export class CacheService implements OnModuleInit {
  private db: Database.Database;
  private readonly logger = new Logger(CacheService.name);

  constructor(private sqlServer: DatabaseService) {}

  async onModuleInit() {
    this.initSqlite();
    await this.syncDatasNovas();
  }

  // ─── Setup SQLite ──────────────────────────────────────────────────────────

  private initSqlite() {
    const fs = require('fs');
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');

    this.db = new Database('./data/radar-cache.db');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS atividades_diarias (
        owner_id   TEXT    NOT NULL,
        data       TEXT    NOT NULL,
        acoes      INTEGER NOT NULL DEFAULT 0,
        acoes_core INTEGER NOT NULL DEFAULT 0,
        acoes_neg  INTEGER NOT NULL DEFAULT 0,
        acoes_auto INTEGER NOT NULL DEFAULT 0,
        usuarios   INTEGER NOT NULL DEFAULT 0,
        entidades  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (owner_id, data)
      );

      CREATE TABLE IF NOT EXISTS owners_cache (
        owner_id TEXT PRIMARY KEY,
        nome     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_log (
        data TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_ativ_data ON atividades_diarias (data);

      -- Análises cacheadas por hash dos dados — válidas enquanto os dados não mudarem
      CREATE TABLE IF NOT EXISTS analises_cache (
        owner_id         TEXT NOT NULL PRIMARY KEY,
        data_hash        TEXT NOT NULL,
        nivel_risco      TEXT NOT NULL,
        score_ia         INTEGER NOT NULL,
        resumo           TEXT NOT NULL,
        motivos          TEXT NOT NULL,
        acao_recomendada TEXT NOT NULL,
        cached_at        TEXT NOT NULL
      );
    `);
    this.logger.log('SQLite inicializado em ./data/radar-cache.db');
  }

  // ─── Sync: busca do SQL Server apenas datas faltantes ─────────────────────

  async syncDatasNovas() {
    const hoje = this.toDateStr(new Date());
    const inicio90d = this.toDateStr(this.diasAtras(90));

    const jaSync = new Set<string>(
      (this.db.prepare('SELECT data FROM sync_log').all() as { data: string }[]).map(r => r.data)
    );

    const faltando: string[] = [];
    const cursor = new Date(inicio90d);
    while (cursor.toISOString().slice(0, 10) < hoje) {
      const ds = this.toDateStr(cursor);
      if (!jaSync.has(ds)) faltando.push(ds);
      cursor.setDate(cursor.getDate() + 1);
    }

    if (faltando.length === 0) {
      this.logger.log('Cache: nenhuma data nova para sincronizar');
      return;
    }

    this.logger.log(`Sincronizando ${faltando.length} datas (${faltando[0]} → ${faltando[faltando.length - 1]})...`);

    const result = await this.sqlServer.connection.request()
      .input('dataMin', faltando[0])
      .input('dataMax', faltando[faltando.length - 1])
      .query(`
        SELECT
          e.OwnerId                                                              AS owner_id,
          o.Name                                                                 AS nome_cliente,
          CONVERT(VARCHAR(10), e.DhExecucao, 23)                                AS data,
          COUNT(*)                                                               AS acoes,
          SUM(CASE WHEN e.Entidade IN (1,5) THEN 1 ELSE 0 END)                 AS acoes_core,
          SUM(CASE WHEN e.TipoAcao IN (9,12,14) THEN 1 ELSE 0 END)             AS acoes_neg,
          SUM(CASE WHEN e.OrigemExecucao IN (2,4,5) THEN 1 ELSE 0 END)         AS acoes_auto,
          COUNT(DISTINCT e.UsuarioExecucaoId)                                    AS usuarios,
          COUNT(DISTINCT e.Entidade)                                             AS entidades
        FROM ExecucaoHistorico e WITH (NOLOCK)
        INNER JOIN Owners o ON o.Id = e.OwnerId
        WHERE e.DhExecucao >= @dataMin
          AND e.DhExecucao < DATEADD(DAY, 1, CONVERT(DATE, @dataMax))
          AND e.OwnerId IS NOT NULL
        GROUP BY e.OwnerId, o.Name, CONVERT(VARCHAR(10), e.DhExecucao, 23)
      `);

    const insOwner = this.db.prepare(
      'INSERT OR REPLACE INTO owners_cache (owner_id, nome) VALUES (?, ?)'
    );
    const insAtiv = this.db.prepare(
      'INSERT OR REPLACE INTO atividades_diarias (owner_id, data, acoes, acoes_core, acoes_neg, acoes_auto, usuarios, entidades) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insSync = this.db.prepare('INSERT OR IGNORE INTO sync_log (data) VALUES (?)');

    const salvarTudo = this.db.transaction((rows: any[], datas: string[]) => {
      for (const r of rows) {
        insOwner.run(r.owner_id, r.nome_cliente);
        insAtiv.run(r.owner_id, r.data, r.acoes, r.acoes_core, r.acoes_neg, r.acoes_auto, r.usuarios, r.entidades);
      }
      for (const d of datas) insSync.run(d);
    });

    salvarTudo(result.recordset, faltando);
    this.logger.log(`Cache: ${result.recordset.length} registros salvos para ${faltando.length} datas`);
  }

  async forceSync(): Promise<void> {
    this.db.prepare('DELETE FROM sync_log').run();
    this.logger.log('forceSync: sync_log limpo — re-sincronizando 90 dias do SQL Server');
    await this.syncDatasNovas();
  }

  // ─── Leitura: agrega histórico do SQLite (até ontem) ──────────────────────

  getHistoricoTodos(): Map<string, HistoricoOwner> {
    const rows = this.db.prepare(`
      SELECT
        a.owner_id,
        o.nome                                                                              AS nome_cliente,
        CAST(julianday('now') - julianday(MAX(a.data)) AS INTEGER)                          AS dias_historico,
        SUM(a.acoes)                                                                        AS acoes_90d,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes      ELSE 0 END)        AS acoes_30d,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes_core ELSE 0 END)        AS acoes_core_30d,
        SUM(a.acoes_core)                                                                   AS acoes_core_90d,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes_neg  ELSE 0 END)        AS acoes_negativas_30d,
        MAX(CASE WHEN a.data >= date('now','-29 days') THEN a.entidades  ELSE 0 END)        AS entidades_utilizadas,
        MAX(CASE WHEN a.data >= date('now','-29 days') THEN a.usuarios   ELSE 0 END)        AS usuarios_ativos,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes_auto ELSE 0 END)        AS acoes_automatizadas_30d
      FROM atividades_diarias a
      INNER JOIN owners_cache o ON o.owner_id = a.owner_id
      WHERE a.data >= date('now','-89 days')
        AND a.data < date('now')
      GROUP BY a.owner_id, o.nome
    `).all() as HistoricoOwner[];

    const map = new Map<string, HistoricoOwner>();
    for (const r of rows) map.set(r.owner_id, r);
    return map;
  }

  getHistoricoPorOwner(ownerId: string): HistoricoOwner | null {
    return this.db.prepare(`
      SELECT
        a.owner_id,
        o.nome                                                                              AS nome_cliente,
        CAST(julianday('now') - julianday(MAX(a.data)) AS INTEGER)                          AS dias_historico,
        SUM(a.acoes)                                                                        AS acoes_90d,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes      ELSE 0 END)        AS acoes_30d,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes_core ELSE 0 END)        AS acoes_core_30d,
        SUM(a.acoes_core)                                                                   AS acoes_core_90d,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes_neg  ELSE 0 END)        AS acoes_negativas_30d,
        MAX(CASE WHEN a.data >= date('now','-29 days') THEN a.entidades  ELSE 0 END)        AS entidades_utilizadas,
        MAX(CASE WHEN a.data >= date('now','-29 days') THEN a.usuarios   ELSE 0 END)        AS usuarios_ativos,
        SUM(CASE WHEN a.data >= date('now','-29 days') THEN a.acoes_auto ELSE 0 END)        AS acoes_automatizadas_30d
      FROM atividades_diarias a
      INNER JOIN owners_cache o ON o.owner_id = a.owner_id
      WHERE a.owner_id = ?
        AND a.data >= date('now','-89 days')
        AND a.data < date('now')
      GROUP BY a.owner_id, o.nome
    `).get(ownerId) as HistoricoOwner | null;
  }

  // ─── Cache de análises Claude (invalidado por hash dos dados) ────────────

  // Fingerprint determinístico das métricas — se mudar algum número, o hash muda
  hashCliente(c: { dias_sem_atividade: number; acoes_90d: number; acoes_30d: number; acoes_core_30d: number; acoes_core_90d: number; acoes_negativas_30d: number; entidades_utilizadas: number; usuarios_ativos: number; acoes_automatizadas_30d: number }): string {
    return [
      c.dias_sem_atividade,
      c.acoes_90d,
      c.acoes_30d,
      c.acoes_core_30d,
      c.acoes_core_90d,
      c.acoes_negativas_30d,
      c.entidades_utilizadas,
      c.usuarios_ativos,
      c.acoes_automatizadas_30d,
    ].join('|');
  }

  // Retorna análise cacheada só se o hash bater — dados iguais = análise válida
  getAnalise(ownerId: string, hash: string): AnaliseCliente | null {
    const row = this.db.prepare(
      'SELECT * FROM analises_cache WHERE owner_id = ? AND data_hash = ?'
    ).get(ownerId, hash) as any;

    if (!row) return null;
    return {
      nivel_risco: row.nivel_risco,
      score_ia: row.score_ia,
      resumo: row.resumo,
      motivos: JSON.parse(row.motivos),
      acao_recomendada: row.acao_recomendada,
    };
  }

  saveAnalise(ownerId: string, hash: string, analise: AnaliseCliente): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO analises_cache
        (owner_id, data_hash, nivel_risco, score_ia, resumo, motivos, acao_recomendada, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerId,
      hash,
      analise.nivel_risco   ?? 'BAIXO',
      analise.score_ia      ?? 0,
      analise.resumo        ?? '',
      JSON.stringify(analise.motivos ?? []),
      analise.acao_recomendada ?? '',
      new Date().toISOString(),
    );
  }

  // ─── Utilitários ──────────────────────────────────────────────────────────

  private toDateStr(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private diasAtras(n: number): Date {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  }
}
