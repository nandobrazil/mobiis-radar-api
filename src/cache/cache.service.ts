import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  constructor(
    private sqlServer: DatabaseService,
    private config: ConfigService,
  ) {}

  async onModuleInit() {
    this.initSqlite();
    await this.syncDatasNovas();
  }

  // ─── Setup SQLite ──────────────────────────────────────────────────────────

  private initSqlite() {
    const fs = require('fs');
    if (!fs.existsSync('./data')) fs.mkdirSync('./data');

    const dbName = (this.config.get<string>('DB_NAME') ?? 'default').replace(/[^a-z0-9_-]/gi, '_');
    const dbPath = `./data/radar-cache-${dbName}.db`;
    this.logger.log(`SQLite: ${dbPath}`);
    this.db = new Database(dbPath);
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
        owner_id          TEXT NOT NULL PRIMARY KEY,
        data_hash         TEXT NOT NULL,
        nivel_risco       TEXT NOT NULL,
        score_ia          INTEGER NOT NULL,
        perfil_uso        TEXT NOT NULL DEFAULT 'MODERADO',
        padrao_historico  TEXT NOT NULL DEFAULT '',
        resumo            TEXT NOT NULL,
        motivos           TEXT NOT NULL,
        acao_recomendada  TEXT NOT NULL,
        cached_at         TEXT NOT NULL
      );

      -- Contexto escrito pelo CS por cliente — permanente, nunca expira
      CREATE TABLE IF NOT EXISTS cliente_contexto (
        owner_id      TEXT PRIMARY KEY,
        contexto      TEXT NOT NULL,
        autor         TEXT,
        atualizado_em TEXT NOT NULL
      );

      -- Lista de owners do SQL Server (TTL de 7 dias)
      CREATE TABLE IF NOT EXISTS owners_lista (
        owner_id   TEXT PRIMARY KEY,
        nome       TEXT,
        tipo       INTEGER,
        status     INTEGER,
        documento  TEXT,
        synced_at  TEXT NOT NULL
      );

      -- Endereço enriquecido por CNPJ via BrasilAPI (permanente — nunca re-busca)
      CREATE TABLE IF NOT EXISTS owners_geo (
        documento   TEXT PRIMARY KEY,
        cep         TEXT,
        logradouro  TEXT,
        numero      TEXT,
        complemento TEXT,
        bairro      TEXT,
        municipio   TEXT,
        uf          TEXT,
        fonte       TEXT NOT NULL DEFAULT 'brasilapi',
        buscado_em  TEXT NOT NULL
      );

      -- Lat/lng por cidade+uf via Nominatim (permanente — nunca re-busca)
      CREATE TABLE IF NOT EXISTS cidades_geo (
        chave      TEXT PRIMARY KEY,
        municipio  TEXT,
        uf         TEXT,
        lat        REAL,
        lng        REAL,
        buscado_em TEXT NOT NULL
      );
    `);
    // Migrações para bancos existentes sem as colunas novas
    for (const migration of [
      "ALTER TABLE analises_cache ADD COLUMN perfil_uso TEXT NOT NULL DEFAULT 'MODERADO'",
      "ALTER TABLE analises_cache ADD COLUMN padrao_historico TEXT NOT NULL DEFAULT ''",
    ]) {
      try { this.db.prepare(migration).run(); } catch { /* coluna já existe */ }
    }
    // Migração: tabela de contexto CS (pode não existir em bancos antigos)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cliente_contexto (
        owner_id      TEXT PRIMARY KEY,
        contexto      TEXT NOT NULL,
        autor         TEXT,
        atualizado_em TEXT NOT NULL
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
          AND o.LicenseType = 3
          AND o.Status = 1
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

  // Fingerprint determinístico das métricas + contexto CS.
  // Qualquer mudança nos números OU no contexto invalida o cache e força nova análise.
  hashCliente(
    c: { dias_sem_atividade: number; acoes_90d: number; acoes_30d: number; acoes_core_30d: number; acoes_core_90d: number; acoes_negativas_30d: number; entidades_utilizadas: number; usuarios_ativos: number; acoes_automatizadas_30d: number },
    contexto?: string,
  ): string {
    return [
      this.bucketDias(c.dias_sem_atividade),
      c.acoes_90d,
      c.acoes_30d,
      c.acoes_core_30d,
      c.acoes_core_90d,
      c.acoes_negativas_30d,
      c.entidades_utilizadas,
      c.usuarios_ativos,
      c.acoes_automatizadas_30d,
      ...(contexto ? [contexto] : []),
    ].join('|');
  }

  // Agrupa dias_sem_atividade em faixas — evita invalidação diária por +1 dia
  private bucketDias(dias: number): string {
    if (dias === 0)   return '0';
    if (dias <= 7)    return '1-7';
    if (dias <= 15)   return '8-15';
    if (dias <= 30)   return '16-30';
    if (dias <= 60)   return '31-60';
    if (dias <= 90)   return '61-90';
    return '91+';
  }

  // ─── Contexto CS por cliente (permanente) ─────────────────────────────────

  getContexto(ownerId: string): ClienteContextoRow | null {
    return this.db.prepare(
      'SELECT * FROM cliente_contexto WHERE owner_id = ?'
    ).get(ownerId) as ClienteContextoRow | null;
  }

  saveContexto(ownerId: string, contexto: string, autor?: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO cliente_contexto (owner_id, contexto, autor, atualizado_em)
      VALUES (?, ?, ?, ?)
    `).run(ownerId, contexto, autor ?? null, new Date().toISOString());
  }

  deleteContexto(ownerId: string): void {
    this.db.prepare('DELETE FROM cliente_contexto WHERE owner_id = ?').run(ownerId);
  }

  getAllContextos(): Map<string, ClienteContextoRow> {
    const rows = this.db.prepare('SELECT * FROM cliente_contexto').all() as ClienteContextoRow[];
    return new Map(rows.map(r => [r.owner_id, r]));
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
      perfil_uso: row.perfil_uso ?? 'MODERADO',
      padrao_historico: row.padrao_historico ?? '',
      resumo: row.resumo,
      motivos: JSON.parse(row.motivos),
      acao_recomendada: row.acao_recomendada,
    };
  }

  saveAnalise(ownerId: string, hash: string, analise: AnaliseCliente): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO analises_cache
        (owner_id, data_hash, nivel_risco, score_ia, perfil_uso, padrao_historico, resumo, motivos, acao_recomendada, cached_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ownerId,
      hash,
      analise.nivel_risco       ?? 'BAIXO',
      analise.score_ia          ?? 0,
      analise.perfil_uso        ?? 'MODERADO',
      analise.padrao_historico  ?? '',
      analise.resumo            ?? '',
      JSON.stringify(analise.motivos ?? []),
      analise.acao_recomendada  ?? '',
      new Date().toISOString(),
    );
  }

  // ─── Owners lista (TTL 7 dias) ────────────────────────────────────────────

  isOwnersListStale(): boolean {
    const row = this.db.prepare(
      'SELECT synced_at FROM owners_lista ORDER BY synced_at DESC LIMIT 1'
    ).get() as { synced_at: string } | undefined;
    if (!row) return true;
    const idadeMs = Date.now() - new Date(row.synced_at).getTime();
    return idadeMs > 7 * 24 * 60 * 60 * 1000;
  }

  getOwnersList(): OwnerListaRow[] | null {
    if (this.isOwnersListStale()) return null;
    return this.db.prepare('SELECT * FROM owners_lista').all() as OwnerListaRow[];
  }

  saveOwnersList(owners: OwnerListaRow[]): void {
    const now = new Date().toISOString();
    const del = this.db.prepare('DELETE FROM owners_lista');
    const ins = this.db.prepare(
      'INSERT OR REPLACE INTO owners_lista (owner_id, nome, tipo, status, documento, synced_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    this.db.transaction(() => {
      del.run();
      for (const o of owners) ins.run(o.owner_id, o.nome, o.tipo, o.status, o.documento, now);
    })();
  }

  // ─── Geo por CNPJ (permanente) ────────────────────────────────────────────

  getOwnerGeo(documento: string): OwnerGeoRow | null {
    return this.db.prepare(
      'SELECT * FROM owners_geo WHERE documento = ?'
    ).get(documento) as OwnerGeoRow | null;
  }

  saveOwnerGeo(geo: OwnerGeoRow): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO owners_geo
        (documento, cep, logradouro, numero, complemento, bairro, municipio, uf, fonte, buscado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      geo.documento, geo.cep, geo.logradouro, geo.numero,
      geo.complemento, geo.bairro, geo.municipio, geo.uf,
      geo.fonte, new Date().toISOString(),
    );
  }

  // ─── Geo por cidade/UF (permanente) ───────────────────────────────────────

  getCidadeGeo(municipio: string, uf: string): CidadeGeoRow | null {
    const chave = `${municipio.toUpperCase()}|${uf.toUpperCase()}`;
    return this.db.prepare(
      'SELECT * FROM cidades_geo WHERE chave = ?'
    ).get(chave) as CidadeGeoRow | null;
  }

  saveCidadeGeo(municipio: string, uf: string, lat: number | null, lng: number | null): void {
    const chave = `${municipio.toUpperCase()}|${uf.toUpperCase()}`;
    this.db.prepare(`
      INSERT OR REPLACE INTO cidades_geo (chave, municipio, uf, lat, lng, buscado_em)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(chave, municipio, uf, lat, lng, new Date().toISOString());
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

export interface OwnerListaRow {
  owner_id: string;
  nome: string;
  tipo: number;
  status: number;
  documento: string | null;
  synced_at?: string;
}

export interface OwnerGeoRow {
  documento: string;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  uf: string | null;
  fonte: string;
  buscado_em?: string;
}

export interface CidadeGeoRow {
  chave?: string;
  municipio: string;
  uf: string;
  lat: number | null;
  lng: number | null;
  buscado_em?: string;
}

export interface ClienteContextoRow {
  owner_id: string;
  contexto: string;
  autor: string | null;
  atualizado_em: string;
}
