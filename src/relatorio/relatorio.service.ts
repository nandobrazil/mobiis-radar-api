import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as sql from 'mssql';
import { ClientesService } from '../clientes/clientes.service';
import { AiService, AnaliseCliente } from '../ai/ai.service';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { ClienteRisco } from '../clientes/clientes.types';
import { ClienteComAnalise, DetalheCliente, EntidadeDetalhe, OrigemDetalhe, TendenciaSemanal } from './relatorio.types';

@Injectable()
export class RelatorioService {
  private readonly logger = new Logger(RelatorioService.name);

  constructor(
    private clientesService: ClientesService,
    private aiService: AiService,
    private cache: CacheService,
    private db: DatabaseService,
  ) {}

  async getTop20(): Promise<ClienteComAnalise[]> {
    const candidatos = await this.clientesService.getCandidatos(50);
    const analisados = await Promise.all(candidatos.map((c) => this.enriquecer(c)));

    return analisados
      .sort((a, b) => (b.analise?.score_ia ?? -1) - (a.analise?.score_ia ?? -1))
      .slice(0, 20);
  }

  async getCliente(ownerId: string): Promise<ClienteComAnalise> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    return this.enriquecer(cliente);
  }

  async getDetalhe(ownerId: string): Promise<DetalheCliente> {
    const [nomeCliente, entidades, origens, tendencia] = await Promise.all([
      this.queryOwnerName(ownerId),
      this.queryPorEntidade(ownerId),
      this.queryPorOrigem(ownerId),
      this.queryTendenciaSemanal(ownerId),
    ]);

    if (!entidades.length && !origens.length) {
      throw new NotFoundException(`Owner "${ownerId}" sem atividade nos últimos 90 dias`);
    }

    return { owner_id: ownerId, nome_cliente: nomeCliente ?? ownerId, por_entidade: entidades, por_origem: origens, tendencia_semanal: tendencia };
  }

  private async queryOwnerName(ownerId: string): Promise<string | null> {
    const r = await this.db.connection.request()
      .input('ownerId', sql.UniqueIdentifier, ownerId)
      .query(`SELECT TOP 1 Name FROM Owners WHERE Id = @ownerId`);
    return r.recordset[0]?.Name ?? null;
  }

  private async queryPorEntidade(ownerId: string): Promise<EntidadeDetalhe[]> {
    const result = await this.db.connection.request()
      .input('ownerId', sql.UniqueIdentifier, ownerId)
      .query(`
        SELECT
          e.Entidade AS entidade_id,
          CASE e.Entidade
            WHEN 1 THEN 'Carga'
            WHEN 2 THEN 'TabelaFrete'
            WHEN 3 THEN 'Acordo'
            WHEN 4 THEN 'BloqueioDoca'
            WHEN 5 THEN 'Reservas'
            WHEN 6 THEN 'RegrasCalculoFrete'
            ELSE CAST(e.Entidade AS VARCHAR)
          END AS entidade,
          SUM(CASE WHEN e.DhExecucao >= DATEADD(DAY,-30,GETDATE()) THEN 1 ELSE 0 END) AS acoes_30d,
          COUNT(*) AS acoes_90d,
          SUM(CASE WHEN e.DhExecucao >= DATEADD(DAY,-30,GETDATE()) AND e.TipoAcao IN (9,12,14,21) THEN 1 ELSE 0 END) AS negativas_30d,
          SUM(CASE WHEN e.TipoAcao IN (9,12,14,21) THEN 1 ELSE 0 END) AS negativas_90d,
          SUM(CASE WHEN e.DhExecucao >= DATEADD(DAY,-30,GETDATE()) AND e.OrigemExecucao IN (2,4,5) THEN 1 ELSE 0 END) AS automatizadas_30d,
          COUNT(DISTINCT CASE WHEN e.DhExecucao >= DATEADD(DAY,-30,GETDATE()) THEN e.UsuarioExecucaoId END) AS usuarios_distintos_30d,
          MAX(e.DhExecucao) AS ultima_acao
        FROM ExecucaoHistorico e WITH (NOLOCK)
        WHERE e.OwnerId = @ownerId
          AND e.DhExecucao >= DATEADD(DAY,-90,GETDATE())
        GROUP BY e.Entidade
        ORDER BY acoes_30d DESC
      `);

    return result.recordset.map(r => ({
      entidade_id: r.entidade_id,
      entidade: r.entidade,
      acoes_30d: r.acoes_30d,
      acoes_90d: r.acoes_90d,
      negativas_30d: r.negativas_30d,
      negativas_90d: r.negativas_90d,
      automatizadas_30d: r.automatizadas_30d,
      usuarios_distintos_30d: r.usuarios_distintos_30d,
      ultima_acao: r.ultima_acao ? new Date(r.ultima_acao).toISOString() : null,
    }));
  }

  private async queryPorOrigem(ownerId: string): Promise<OrigemDetalhe[]> {
    const result = await this.db.connection.request()
      .input('ownerId', sql.UniqueIdentifier, ownerId)
      .query(`
        SELECT
          e.OrigemExecucao AS origem_id,
          CASE e.OrigemExecucao
            WHEN 1 THEN 'Plataforma'
            WHEN 2 THEN 'API'
            WHEN 3 THEN 'Aplicativo'
            WHEN 4 THEN 'Automação'
            WHEN 5 THEN 'Processo automático'
            ELSE CAST(e.OrigemExecucao AS VARCHAR)
          END AS origem,
          SUM(CASE WHEN e.DhExecucao >= DATEADD(DAY,-30,GETDATE()) THEN 1 ELSE 0 END) AS acoes_30d,
          COUNT(*) AS acoes_90d
        FROM ExecucaoHistorico e WITH (NOLOCK)
        WHERE e.OwnerId = @ownerId
          AND e.DhExecucao >= DATEADD(DAY,-90,GETDATE())
        GROUP BY e.OrigemExecucao
        ORDER BY acoes_30d DESC
      `);

    return result.recordset.map(r => ({
      origem_id: r.origem_id,
      origem: r.origem,
      acoes_30d: r.acoes_30d,
      acoes_90d: r.acoes_90d,
    }));
  }

  private async queryTendenciaSemanal(ownerId: string): Promise<TendenciaSemanal[]> {
    const result = await this.db.connection.request()
      .input('ownerId', sql.UniqueIdentifier, ownerId)
      .query(`
        SELECT
          CASE e.Entidade
            WHEN 1 THEN 'Carga'
            WHEN 2 THEN 'TabelaFrete'
            WHEN 3 THEN 'Acordo'
            WHEN 4 THEN 'BloqueioDoca'
            WHEN 5 THEN 'Reservas'
            WHEN 6 THEN 'RegrasCalculoFrete'
            ELSE CAST(e.Entidade AS VARCHAR)
          END AS entidade,
          CONVERT(VARCHAR(10), DATEADD(WEEK, DATEDIFF(WEEK, 0, e.DhExecucao), 0), 23) AS semana_inicio,
          COUNT(*) AS acoes
        FROM ExecucaoHistorico e WITH (NOLOCK)
        WHERE e.OwnerId = @ownerId
          AND e.DhExecucao >= DATEADD(WEEK,-4,GETDATE())
        GROUP BY e.Entidade, DATEADD(WEEK, DATEDIFF(WEEK, 0, e.DhExecucao), 0)
        ORDER BY semana_inicio ASC, entidade ASC
      `);

    return result.recordset.map(r => ({
      entidade: r.entidade,
      semana_inicio: r.semana_inicio,
      acoes: r.acoes,
    }));
  }

  private async enriquecer(cliente: ClienteRisco): Promise<ClienteComAnalise> {
    const hash = this.cache.hashCliente(cliente);

    // Dados idênticos ao da última análise → reutiliza sem chamar a Claude
    const cached = this.cache.getAnalise(cliente.owner_id, hash);
    if (cached) {
      this.logger.debug(`Cache hit: ${cliente.nome_cliente} (hash=${hash})`);
      return { cliente, analise: cached };
    }

    try {
      const raw = await this.aiService.analisarRiscoCliente(cliente);
      const analise: AnaliseCliente = JSON.parse(raw);
      this.cache.saveAnalise(cliente.owner_id, hash, analise);
      return { cliente, analise };
    } catch {
      return { cliente, analise: null, erro: true };
    }
  }
}
