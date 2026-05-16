import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as sql from 'mssql';
import { ConfigService } from '@nestjs/config';
import { ClientesService } from '../clientes/clientes.service';
import { AiService, AnaliseCliente } from '../ai/ai.service';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { ClienteRisco } from '../clientes/clientes.types';
import { calcularParametrosRaw, gerarAlertas } from '../ai/prompts';
import { OwnerLocalizacao } from '../mapa/mapa.types';
import { ClienteComAnalise, DetalheCliente, EntidadeDetalhe, OrigemDetalhe, ParametrosAnalise, TendenciaSemanal } from './relatorio.types';

@Injectable()
export class RelatorioService {
  private readonly logger = new Logger(RelatorioService.name);
  private readonly allowNoCache: boolean;
  private analiseEmAndamento: Promise<ClienteComAnalise[]> | null = null;

  constructor(
    private clientesService: ClientesService,
    private aiService: AiService,
    private cache: CacheService,
    private db: DatabaseService,
    private config: ConfigService,
  ) {
    this.allowNoCache = this.config.get('ALLOW_NO_CACHE') === 'true';
  }

  async getTodos(nocache = false): Promise<ClienteComAnalise[]> {
    // Requisições simultâneas compartilham o mesmo processo em andamento
    if (!nocache && this.analiseEmAndamento) {
      this.logger.log('Análise já em andamento — aguardando resultado existente');
      return this.analiseEmAndamento;
    }

    const promise = this.executarAnalise(nocache);
    if (!nocache) this.analiseEmAndamento = promise;
    try {
      return await promise;
    } finally {
      if (this.analiseEmAndamento === promise) this.analiseEmAndamento = null;
    }
  }

  private async executarAnalise(nocache = false): Promise<ClienteComAnalise[]> {
    const skipCache = nocache && this.allowNoCache;
    const clientes = await this.clientesService.getTodos(skipCache);
    this.logger.log(`Total de clientes: ${clientes.length} | skipCache=${skipCache}`);

    const ownerMap = this.cache.getOwnerInfoMap();
    const contextos = this.cache.getAllContextos();

    const comCache: ClienteComAnalise[] = [];
    const semCache: ClienteRisco[] = [];

    for (const c of clientes) {
      const ctx = contextos.get(c.owner_id);
      const hash = this.cache.hashCliente(c, ctx?.contexto);
      const cached = !skipCache && this.cache.getAnalise(c.owner_id, hash);
      if (cached) {
        comCache.push({ cliente: c, analise: cached, contexto: ctx ?? null, owner: buildOwnerLocalizacao(ownerMap.get(c.owner_id)) });
      } else {
        semCache.push(c);
      }
    }

    this.logger.log(`Cache: ${comCache.length} hit(s), ${semCache.length} a analisar`);

    const novos: ClienteComAnalise[] = [];
    // Chunk de 3: menos viés de comparação relativa entre clientes,
    // ~50% mais barato que individual, delay menor por gerar menos tokens por chamada
    const CHUNK = 3;
    const DELAY_MS = 2000;
    for (let i = 0; i < semCache.length; i += CHUNK) {
      if (i > 0) await sleep(DELAY_MS);
      const chunk = semCache.slice(i, i + CHUNK);
      this.logger.log(`Analisando chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(semCache.length / CHUNK)} (${chunk.length} clientes)`);
      const chunkContextos = new Map(
        chunk.flatMap(c => {
          const ctx = contextos.get(c.owner_id);
          return ctx ? [[c.owner_id, ctx.contexto]] : [];
        })
      );
      const analises = await this.aiService.analisarLote(chunk, chunkContextos);
      for (const c of chunk) {
        const ctx = contextos.get(c.owner_id);
        const hash = this.cache.hashCliente(c, ctx?.contexto);
        const analise = analises.get(c.owner_id) ?? null;
        if (analise) this.cache.saveAnalise(c.owner_id, hash, analise);
        novos.push({ cliente: c, analise, contexto: ctx ?? null, owner: buildOwnerLocalizacao(ownerMap.get(c.owner_id)), erro: analise ? undefined : true });
      }
    }

    const NIVEL_ORDEM: Record<string, number> = { ALTO: 0, MEDIO: 1, BAIXO: 2, INDEFINIDO: 3 };
    return [...comCache, ...novos].sort((a, b) => {
      const na = NIVEL_ORDEM[a.analise?.nivel_risco ?? 'INDEFINIDO'];
      const nb = NIVEL_ORDEM[b.analise?.nivel_risco ?? 'INDEFINIDO'];
      if (na !== nb) return na - nb;
      // Dentro do mesmo nível: score menor = mais urgente = aparece primeiro
      return (a.analise?.score_ia ?? 50) - (b.analise?.score_ia ?? 50);
    });
  }

  async getCliente(ownerId: string): Promise<ClienteComAnalise> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    const ctx = this.cache.getContexto(ownerId);
    const hash = this.cache.hashCliente(cliente, ctx?.contexto);
    const analise = this.cache.getAnalise(cliente.owner_id, hash) ?? null;
    const owner = buildOwnerLocalizacao(this.cache.getOwnerInfoMap().get(ownerId));
    return { cliente, analise, contexto: ctx ?? null, owner };
  }

  async reprocessarCliente(ownerId: string): Promise<ClienteComAnalise> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    const ctx = this.cache.getContexto(ownerId);
    const hash = this.cache.hashCliente(cliente, ctx?.contexto);
    const owner = buildOwnerLocalizacao(this.cache.getOwnerInfoMap().get(ownerId));

    const contextos = ctx ? new Map([[ownerId, ctx.contexto]]) : new Map<string, string>();
    const analises = await this.aiService.analisarLote([cliente], contextos);
    const analise = analises.get(cliente.owner_id) ?? null;
    if (analise) this.cache.saveAnalise(cliente.owner_id, hash, analise);
    return { cliente, analise, contexto: ctx ?? null, owner, erro: analise ? undefined : true };
  }

  getContexto(ownerId: string) {
    return this.cache.getContexto(ownerId);
  }

  saveContexto(ownerId: string, contexto: string, autor?: string) {
    this.cache.saveContexto(ownerId, contexto, autor);
  }

  deleteContexto(ownerId: string) {
    this.cache.deleteContexto(ownerId);
  }

  async getParametros(ownerId: string): Promise<ParametrosAnalise> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    const ctx = this.cache.getContexto(ownerId);
    const hash = this.cache.hashCliente(cliente, ctx?.contexto);
    const analise = this.cache.getAnalise(cliente.owner_id, hash) ?? null;

    const { metricas_derivadas, score_breakdown } = calcularParametrosRaw(cliente);
    const alertas = gerarAlertas(cliente, metricas_derivadas, analise, !!ctx);

    const analise_ia = analise
      ? {
          ...analise,
          ajuste_ia: analise.score_ia - metricas_derivadas.score_saude_base,
          perfil_confirmado: analise.perfil_uso === metricas_derivadas.perfil_sugerido,
        }
      : null;

    return {
      owner_id: ownerId,
      nome_cliente: cliente.nome_cliente,
      metricas_brutas: cliente,
      metricas_derivadas,
      score_breakdown,
      analise_ia,
      alertas,
      contexto_cs: ctx ?? null,
    };
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

}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildOwnerLocalizacao(
  info: { lista: import('../cache/cache.service').OwnerListaRow; geo: (import('../cache/cache.service').OwnerGeoRow & { lat: number | null; lng: number | null }) | null } | undefined,
): OwnerLocalizacao | null {
  if (!info) return null;
  const { lista: o, geo } = info;
  return {
    id: o.owner_id,
    nome: o.nome,
    tipo: o.tipo,
    status: o.status,
    documento: o.documento ?? null,
    cep: geo?.cep ?? null,
    logradouro: geo?.logradouro ?? null,
    numero: geo?.numero ?? null,
    complemento: geo?.complemento ?? null,
    bairro: geo?.bairro ?? null,
    municipio: geo?.municipio ?? null,
    uf: geo?.uf ?? null,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    razao_social: geo?.razao_social ?? null,
    nome_fantasia: geo?.nome_fantasia ?? null,
    cnae_fiscal: geo?.cnae_fiscal ?? null,
    cnae_fiscal_descricao: geo?.cnae_fiscal_descricao ?? null,
    cnaes_secundarios: geo?.cnaes_secundarios ? JSON.parse(geo.cnaes_secundarios) : null,
    porte: geo?.porte ?? null,
    natureza_juridica: geo?.natureza_juridica ?? null,
    capital_social: geo?.capital_social ?? null,
    data_inicio_atividade: geo?.data_inicio_atividade ?? null,
    opcao_pelo_simples: geo?.opcao_pelo_simples ?? null,
  };
}
