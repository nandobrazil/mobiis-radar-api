import { Injectable, NotFoundException } from '@nestjs/common';
import * as sql from 'mssql';
import { DatabaseService } from '../database/database.service';
import { CacheService, HistoricoOwner } from '../cache/cache.service';
import { ClienteRisco } from './clientes.types';

// Entidade IN (1,5)         → core: Carga, Reserva
// TipoAcao IN (9,12,14)     → negativas: Cancelamento, Exclusão, Desativação
// OrigemExecucao IN (2,4,5) → API / Automação
const QUERY_HOJE = `
  SELECT
    e.OwnerId                                                       AS owner_id,
    o.Name                                                          AS nome_cliente,
    COUNT(*)                                                        AS acoes,
    SUM(CASE WHEN e.Entidade IN (1,5) THEN 1 ELSE 0 END)           AS acoes_core,
    SUM(CASE WHEN e.TipoAcao IN (9,12,14) THEN 1 ELSE 0 END)       AS acoes_neg,
    SUM(CASE WHEN e.OrigemExecucao IN (2,4,5) THEN 1 ELSE 0 END)   AS acoes_auto,
    COUNT(DISTINCT e.UsuarioExecucaoId)                              AS usuarios,
    COUNT(DISTINCT e.Entidade)                                       AS entidades
  FROM ExecucaoHistorico e WITH (NOLOCK)
  INNER JOIN Owners o ON o.Id = e.OwnerId
  WHERE CAST(e.DhExecucao AS DATE) = CAST(GETDATE() AS DATE)
    AND e.OwnerId IS NOT NULL
    AND o.LicenseType = 3
    AND o.Status = 1
    AND o.Type = 3
  GROUP BY e.OwnerId, o.Name
`;

const HOJE_TTL_MS = 10 * 60 * 1000; // 10 minutos

@Injectable()
export class ClientesService {
  private hojeCache: { data: Map<string, any>; ts: number } | null = null;

  constructor(
    private db: DatabaseService,
    private cache: CacheService,
  ) {}

  async getTodos(nocache = false): Promise<ClienteRisco[]> {
    if (nocache) {
      await this.cache.forceSync();
      this.hojeCache = null;
    }

    const [historico, hoje] = await Promise.all([
      Promise.resolve(this.cache.getHistoricoTodos()),
      this.queryHojeCached(),
    ]);

    const merged = this.merge(historico, hoje);
    return [...merged.values()];
  }

  async getByOwnerId(ownerId: string, nocache = false): Promise<ClienteRisco> {
    if (nocache) await this.cache.forceSync();

    const [historico, hoje] = await Promise.all([
      Promise.resolve(this.cache.getHistoricoPorOwner(ownerId)),
      this.queryHojePorOwner(ownerId),
    ]);

    if (!historico && !hoje) {
      throw new NotFoundException(`Cliente com owner_id "${ownerId}" não encontrado`);
    }

    const merged = this.merge(
      historico ? new Map([[ownerId, historico]]) : new Map(),
      hoje ? new Map([[ownerId, hoje]]) : new Map(),
    );

    return merged.get(ownerId)!;
  }

  // ─── Queries SQL Server (só hoje) ─────────────────────────────────────────

  private async queryHojeCached(): Promise<Map<string, any>> {
    const agora = Date.now();
    if (this.hojeCache && agora - this.hojeCache.ts < HOJE_TTL_MS) {
      return this.hojeCache.data;
    }
    const data = await this.queryHoje();
    this.hojeCache = { data, ts: agora };
    return data;
  }

  private async queryHoje(): Promise<Map<string, any>> {
    const result = await this.db.connection.request().query(QUERY_HOJE);
    return this.toMap(result.recordset);
  }

  private async queryHojePorOwner(ownerId: string): Promise<any | null> {
    const result = await this.db.connection.request()
      .input('ownerId', sql.UniqueIdentifier, ownerId)
      .query(`
        SELECT
          e.OwnerId                                                       AS owner_id,
          o.Name                                                          AS nome_cliente,
          COUNT(*)                                                        AS acoes,
          SUM(CASE WHEN e.Entidade IN (1,5) THEN 1 ELSE 0 END)           AS acoes_core,
          SUM(CASE WHEN e.TipoAcao IN (9,12,14) THEN 1 ELSE 0 END)       AS acoes_neg,
          SUM(CASE WHEN e.OrigemExecucao IN (2,4,5) THEN 1 ELSE 0 END)   AS acoes_auto,
          COUNT(DISTINCT e.UsuarioExecucaoId)                              AS usuarios,
          COUNT(DISTINCT e.Entidade)                                       AS entidades
        FROM ExecucaoHistorico e WITH (NOLOCK)
        INNER JOIN Owners o ON o.Id = e.OwnerId
        WHERE CAST(e.DhExecucao AS DATE) = CAST(GETDATE() AS DATE)
          AND e.OwnerId = @ownerId
          AND o.LicenseType = 3
          AND o.Status = 1
          AND o.Type = 3
        GROUP BY e.OwnerId, o.Name
      `);
    return result.recordset[0] ?? null;
  }

  // ─── Merge: histórico SQLite + delta de hoje ───────────────────────────────

  private merge(
    historico: Map<string, HistoricoOwner>,
    hoje: Map<string, any>,
  ): Map<string, ClienteRisco> {
    const result = new Map<string, ClienteRisco>();

    for (const [id, h] of historico) {
      const t = hoje.get(id);
      result.set(id, {
        owner_id: id,
        nome_cliente: h.nome_cliente,
        dias_sem_atividade: t ? 0 : h.dias_historico + 1,
        acoes_90d: h.acoes_90d + (t?.acoes ?? 0),
        acoes_30d: h.acoes_30d + (t?.acoes ?? 0),
        acoes_core_30d: h.acoes_core_30d + (t?.acoes_core ?? 0),
        acoes_core_90d: h.acoes_core_90d + (t?.acoes_core ?? 0),
        acoes_negativas_30d: h.acoes_negativas_30d + (t?.acoes_neg ?? 0),
        entidades_utilizadas: Math.max(h.entidades_utilizadas, t?.entidades ?? 0),
        usuarios_ativos: Math.max(h.usuarios_ativos, t?.usuarios ?? 0),
        acoes_automatizadas_30d: h.acoes_automatizadas_30d + (t?.acoes_auto ?? 0),
      });
    }

    // Owners ativos só hoje (sem histórico nos últimos 90 dias)
    for (const [id, t] of hoje) {
      if (!result.has(id)) {
        result.set(id, {
          owner_id: id,
          nome_cliente: t.nome_cliente,
          dias_sem_atividade: 0,
          acoes_90d: t.acoes,
          acoes_30d: t.acoes,
          acoes_core_30d: t.acoes_core,
          acoes_core_90d: t.acoes_core,
          acoes_negativas_30d: t.acoes_neg,
          entidades_utilizadas: t.entidades,
          usuarios_ativos: t.usuarios,
          acoes_automatizadas_30d: t.acoes_auto,
        });
      }
    }

    return result;
  }

  private toMap(rows: any[]): Map<string, any> {
    return new Map(rows.map(r => [r.owner_id, r]));
  }
}
