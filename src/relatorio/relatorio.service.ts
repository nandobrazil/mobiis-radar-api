import { HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as sql from 'mssql';
import { ConfigService } from '@nestjs/config';
import { ClientesService } from '../clientes/clientes.service';
import { AiService, AnaliseCliente } from '../ai/ai.service';
import { CacheService } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { ClienteRisco } from '../clientes/clientes.types';
import { calcularParametrosRaw, gerarAlertas, buildMatchCnaePrompt, InsightsCnaeIA, calcularProbabilidadeChurn60d, buildInsightsPrompt, buildPlanoAcaoPrompt, InsightsPayload } from '../ai/prompts';
import { OwnerLocalizacao } from '../mapa/mapa.types';
import { ClienteComAnalise, DetalheCliente, EntidadeDetalhe, MatchCnaeInput, MatchCnaeResult, OrigemDetalhe, ParametrosAnalise, PlanoAcao, RelatorioInsights, TendenciaSemanal } from './relatorio.types';

export interface StatusAnalise {
  processando: boolean;
  iniciado_em: string | null;
  chunks_total: number | null;
  chunks_concluidos: number | null;
  clientes_total: number | null;
  clientes_analisados: number | null;
}

@Injectable()
export class RelatorioService {
  private readonly logger = new Logger(RelatorioService.name);
  private readonly allowNoCache: boolean;
  private analiseEmAndamento: Promise<ClienteComAnalise[]> | null = null;
  private statusAnalise: StatusAnalise = {
    processando: false,
    iniciado_em: null,
    chunks_total: null,
    chunks_concluidos: null,
    clientes_total: null,
    clientes_analisados: null,
  };

  constructor(
    private clientesService: ClientesService,
    private aiService: AiService,
    private cache: CacheService,
    private db: DatabaseService,
    private config: ConfigService,
  ) {
    this.allowNoCache = this.config.get('ALLOW_NO_CACHE') === 'true';
  }

  getStatus(): StatusAnalise {
    return { ...this.statusAnalise };
  }

  async getTodos(nocache = false): Promise<ClienteComAnalise[]> {
    if (!nocache && this.analiseEmAndamento) {
      this.logger.log('Análise já em andamento — aguardando resultado existente');
      return this.analiseEmAndamento;
    }

    const promise = this.executarAnalise(nocache);
    this.analiseEmAndamento = promise;
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
        comCache.push({ cliente: c, analise: cached, contexto: ctx ?? null, owner: buildOwnerLocalizacao(ownerMap.get(c.owner_id)), probabilidade_churn_60d: calcularProbabilidadeChurn60d(cached, c) });
      } else {
        semCache.push(c);
      }
    }

    this.logger.log(`Cache: ${comCache.length} hit(s), ${semCache.length} a analisar`);

    const novos: ClienteComAnalise[] = [];
    const CHUNK = 3;
    const DELAY_MS = 2000;

    const semCacheOrdenado = [...semCache].sort((a, b) =>
      calcularParametrosRaw(a).metricas_derivadas.score_saude_base -
      calcularParametrosRaw(b).metricas_derivadas.score_saude_base
    );

    const totalChunks = Math.ceil(semCacheOrdenado.length / CHUNK);
    const chunks: ClienteRisco[][] = Array.from({ length: totalChunks }, () => []);
    semCacheOrdenado.forEach((c, i) => chunks[i % totalChunks].push(c));

    this.statusAnalise = {
      processando: true,
      iniciado_em: new Date().toISOString(),
      chunks_total: totalChunks,
      chunks_concluidos: 0,
      clientes_total: semCache.length,
      clientes_analisados: 0,
    };

    try {
      for (let ci = 0; ci < chunks.length; ci++) {
        if (ci > 0) await sleep(DELAY_MS);
        const chunk = chunks[ci];
        this.logger.log(`Analisando chunk ${ci + 1}/${chunks.length} (${chunk.length} clientes)`);
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
          novos.push({ cliente: c, analise, contexto: ctx ?? null, owner: buildOwnerLocalizacao(ownerMap.get(c.owner_id)), probabilidade_churn_60d: calcularProbabilidadeChurn60d(analise, c), erro: analise ? undefined : true });
        }
        this.statusAnalise.chunks_concluidos = ci + 1;
        this.statusAnalise.clientes_analisados = novos.length;
      }
    } finally {
      this.statusAnalise = {
        processando: false,
        iniciado_em: null,
        chunks_total: null,
        chunks_concluidos: null,
        clientes_total: null,
        clientes_analisados: null,
      };
    }

    const NIVEL_ORDEM: Record<string, number> = { ALTO: 0, MEDIO: 1, BAIXO: 2, INDEFINIDO: 3 };
    return [...comCache, ...novos].sort((a, b) => {
      // Sem análise vai sempre ao final
      if (!a.analise && !b.analise) return 0;
      if (!a.analise) return 1;
      if (!b.analise) return -1;
      const na = NIVEL_ORDEM[a.analise.nivel_risco];
      const nb = NIVEL_ORDEM[b.analise.nivel_risco];
      if (na !== nb) return na - nb;
      // Mesmo nível: score menor = mais urgente = aparece primeiro
      return a.analise.score_ia - b.analise.score_ia;
    });
  }

  async getCliente(ownerId: string): Promise<ClienteComAnalise> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    const ctx = this.cache.getContexto(ownerId);
    const hash = this.cache.hashCliente(cliente, ctx?.contexto);
    const analise = this.cache.getAnalise(cliente.owner_id, hash) ?? null;
    const owner = buildOwnerLocalizacao(this.cache.getOwnerInfoMap().get(ownerId));
    return { cliente, analise, contexto: ctx ?? null, owner, probabilidade_churn_60d: calcularProbabilidadeChurn60d(analise, cliente) };
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
    return { cliente, analise, contexto: ctx ?? null, owner, probabilidade_churn_60d: calcularProbabilidadeChurn60d(analise, cliente), erro: analise ? undefined : true };
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

  async matchCnae(input: MatchCnaeInput, nocache = false): Promise<MatchCnaeResult> {
    const cacheKey = [input.cnae_fiscal, ...(input.cnaes_secundarios ?? []).map(c => c.codigo).sort((a, b) => a - b)].join(',');

    const allInputCnaes = new Set<number>([input.cnae_fiscal]);
    const inputDivisoes = new Set<string>([String(input.cnae_fiscal).substring(0, 2)]);

    for (const c of input.cnaes_secundarios ?? []) {
      allInputCnaes.add(c.codigo);
      inputDivisoes.add(String(c.codigo).substring(0, 2));
    }

    const ownerInfoMap = this.cache.getOwnerInfoMap();
    const matches: import('./relatorio.types').CnaeMatch[] = [];

    for (const [owner_id, info] of ownerInfoMap) {
      const { lista, geo } = info;
      if (!geo?.cnae_fiscal) continue;

      const ownerCnaes: { codigo: number; descricao: string }[] = [
        { codigo: geo.cnae_fiscal, descricao: geo.cnae_fiscal_descricao ?? '' },
      ];
      if (geo.cnaes_secundarios) {
        try { ownerCnaes.push(...JSON.parse(geo.cnaes_secundarios)); } catch {}
      }

      // Match EXATO: código idêntico em qualquer CNAE do prospect
      const cnaesEmComum = ownerCnaes.filter(c => allInputCnaes.has(c.codigo));

      // Match DIVISAO: mesmo setor (2 dígitos) mas código diferente
      const porDivisao = ownerCnaes.filter(c =>
        inputDivisoes.has(String(c.codigo).substring(0, 2)) && !allInputCnaes.has(c.codigo)
      );

      const similaridade = cnaesEmComum.length > 0 ? 'EXATO'
        : porDivisao.length > 0 ? 'DIVISAO'
        : null;
      if (!similaridade) continue;

      matches.push({
        owner_id,
        nome: lista.nome,
        documento: lista.documento ?? null,
        municipio: geo.municipio ?? null,
        uf: geo.uf ?? null,
        lat: geo.lat ?? null,
        lng: geo.lng ?? null,
        modulos: lista.modules ? lista.modules.split(',').filter(Boolean) : [],
        cnae_fiscal: geo.cnae_fiscal,
        cnae_fiscal_descricao: geo.cnae_fiscal_descricao ?? null,
        similaridade,
        cnaes_em_comum: cnaesEmComum.length > 0 ? cnaesEmComum : porDivisao,
        analise: this.cache.getAnaliseByOwner(owner_id),
      });
    }

    matches.sort((a, b) => {
      if (a.similaridade !== b.similaridade) return a.similaridade === 'EXATO' ? -1 : 1;
      return b.cnaes_em_comum.length - a.cnaes_em_comum.length;
    });

    const stats = calcularStatsCnae(matches);

    if (!nocache) {
      const cached = this.cache.getMatchCnaeCache(cacheKey);
      if (cached) {
        if (matches.length <= cached.total_matches) {
          this.logger.log(`match-cnae: cache hit (${cached.total_matches} matches cached, ${matches.length} atuais)`);
          return { ...cached.result, de_cache: true };
        }
        this.logger.log(`match-cnae: cache invalidado — ${matches.length} matches > ${cached.total_matches} em cache`);
        this.cache.deleteMatchCnaeCache(cacheKey);
      }
    }

    const insights = await this.gerarInsightsCnaeIA(input, matches, stats);
    const result: MatchCnaeResult = { matches, insights, de_cache: false };
    this.cache.saveMatchCnaeCache(cacheKey, matches.length, result);
    return result;
  }

  private async gerarInsightsCnaeIA(
    input: MatchCnaeInput,
    matches: import('./relatorio.types').CnaeMatch[],
    stats: { modulos_mais_usados: { modulo: string; count: number; percentual: number }[]; uf_com_mais_clientes: { uf: string; count: number }[] },
  ): Promise<import('./relatorio.types').InsightsCnae> {
    const prompt = buildMatchCnaePrompt(
      { cnae_fiscal: input.cnae_fiscal, cnae_fiscal_descricao: input.cnae_fiscal_descricao, cnaes_secundarios: input.cnaes_secundarios },
      matches.map(m => ({
        nome: m.nome,
        uf: m.uf,
        municipio: m.municipio,
        modulos: m.modulos,
        similaridade: m.similaridade,
        cnaes_em_comum: m.cnaes_em_comum,
        analise: m.analise ? { nivel_risco: m.analise.nivel_risco, score_ia: m.analise.score_ia, perfil_uso: m.analise.perfil_uso, resumo: m.analise.resumo } : null,
      })),
      stats,
    );

    this.logger.log(`match-cnae: chamando IA para insights (${matches.length} matches)`);
    const raw = await this.aiService.completar(prompt);
    this.logger.debug(`match-cnae raw IA:\n${raw}`);

    let ia: InsightsCnaeIA = {
      argumento_venda: '',
      diferenciais: [],
      modulos_recomendados: [],
      abordagem_sugerida: '',
      oportunidades: [],
      riscos_conhecidos: [],
    };

    try {
      const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      ia = JSON.parse(json);
    } catch {
      this.logger.error(`match-cnae: falha ao parsear resposta da IA: ${raw}`);
    }

    return {
      total_clientes_similares: matches.length,
      ...stats,
      argumento_venda: ia.argumento_venda,
      diferenciais: ia.diferenciais ?? [],
      modulos_recomendados: ia.modulos_recomendados ?? [],
      abordagem_sugerida: ia.abordagem_sugerida,
      oportunidades: ia.oportunidades ?? [],
      riscos_conhecidos: ia.riscos_conhecidos ?? [],
    };
  }

  async getInsights(nocache = false): Promise<RelatorioInsights> {
    const clientes = await this.clientesService.getTodos();
    const ownerMap = this.cache.getOwnerInfoMap();

    // Coleta apenas clientes com análise em cache
    const analisados: { cliente: import('../clientes/clientes.types').ClienteRisco; analise: import('../ai/ai.service').AnaliseCliente; info: ReturnType<typeof ownerMap.get> }[] = [];
    for (const c of clientes) {
      const analise = this.cache.getAnaliseByOwner(c.owner_id);
      if (analise) analisados.push({ cliente: c, analise, info: ownerMap.get(c.owner_id) });
    }

    if (analisados.length === 0) {
      throw new HttpException(
        { message: 'Nenhum cliente analisado ainda. Execute GET /relatorio/clientes primeiro.' }, 202
      );
    }

    const resumo = {
      total_analisados: analisados.length,
      alto_risco: analisados.filter(a => a.analise.nivel_risco === 'ALTO').length,
      medio_risco: analisados.filter(a => a.analise.nivel_risco === 'MEDIO').length,
      baixo_risco: analisados.filter(a => a.analise.nivel_risco === 'BAIXO').length,
    };

    const cacheKey = `${resumo.total_analisados}|${resumo.alto_risco}|${resumo.medio_risco}`;
    if (!nocache) {
      const cached = this.cache.getInsightsCache(cacheKey);
      if (cached) return { ...cached.result, de_cache: true };
    }

    // Agregação por setor
    const setorMap = new Map<string, { total: number; alto: number; scores: number[] }>();
    for (const { analise, info } of analisados) {
      const setor = info?.geo?.cnae_fiscal_descricao ?? 'Setor não informado';
      if (!setorMap.has(setor)) setorMap.set(setor, { total: 0, alto: 0, scores: [] });
      const s = setorMap.get(setor)!;
      s.total++;
      if (analise.nivel_risco === 'ALTO') s.alto++;
      s.scores.push(analise.score_ia);
    }
    const por_setor = [...setorMap.entries()]
      .map(([setor, s]) => ({ setor, total: s.total, alto: s.alto, score_medio: Math.round(s.scores.reduce((a, b) => a + b, 0) / s.scores.length) }))
      .sort((a, b) => b.alto - a.alto);

    // Agregação por módulo
    const moduloMap = new Map<string, { total: number; em_risco: number }>();
    for (const { analise, info } of analisados) {
      const mods = (info?.lista.modules ?? '').split(',').filter(Boolean);
      for (const mod of mods) {
        if (!moduloMap.has(mod)) moduloMap.set(mod, { total: 0, em_risco: 0 });
        const m = moduloMap.get(mod)!;
        m.total++;
        if (analise.nivel_risco === 'ALTO' || analise.nivel_risco === 'MEDIO') m.em_risco++;
      }
    }
    const por_modulo = [...moduloMap.entries()]
      .map(([modulo, m]) => ({ modulo, total: m.total, em_risco: m.em_risco }))
      .sort((a, b) => b.em_risco - a.em_risco);

    // Padrões
    const mkOwners = (arr: typeof analisados) => arr.slice(0, 20).map(a => ({ id: a.cliente.owner_id, nome: a.cliente.nome_cliente }));
    const derivadasMap = new Map(analisados.map(a => [a.cliente.owner_id, calcularParametrosRaw(a.cliente).metricas_derivadas]));
    const padroes: InsightsPayload['padroes'] = {
      queda_acima_40pct:       { count: 0, owners: [] },
      inativo_com_historico:   { count: 0, owners: [] },
      usuario_unico_em_risco:  { count: 0, owners: [] },
      sem_uso_core:            { count: 0, owners: [] },
      saudaveis_sem_automacao: { count: 0, owners: [] },
      saudaveis_multimodulo:   { count: 0, owners: [] },
    };
    for (const a of analisados) {
      const d = derivadasMap.get(a.cliente.owner_id)!;
      const o = { id: a.cliente.owner_id, nome: a.cliente.nome_cliente };
      if (d.variacao_uso_pct !== null && d.variacao_uso_pct <= -40) { padroes.queda_acima_40pct.count++; padroes.queda_acima_40pct.owners.push(o); }
      if (a.cliente.dias_sem_atividade >= 30 && a.cliente.acoes_90d > 10) { padroes.inativo_com_historico.count++; padroes.inativo_com_historico.owners.push(o); }
      if (a.cliente.usuarios_ativos === 1 && a.analise.nivel_risco !== 'BAIXO') { padroes.usuario_unico_em_risco.count++; padroes.usuario_unico_em_risco.owners.push(o); }
      if (a.cliente.acoes_30d > 0 && d.pct_core === 0) { padroes.sem_uso_core.count++; padroes.sem_uso_core.owners.push(o); }
      if (a.analise.nivel_risco === 'BAIXO' && d.pct_automatizado === 0 && a.cliente.acoes_30d > 10) { padroes.saudaveis_sem_automacao.count++; padroes.saudaveis_sem_automacao.owners.push(o); }
      const nMods = (a.info?.lista.modules ?? '').split(',').filter(Boolean).length;
      if (a.analise.nivel_risco === 'BAIXO' && nMods >= 3) { padroes.saudaveis_multimodulo.count++; padroes.saudaveis_multimodulo.owners.push(o); }
    }

    const top_risco = analisados
      .filter(a => a.analise.nivel_risco === 'ALTO' || a.analise.nivel_risco === 'MEDIO')
      .sort((a, b) => a.analise.score_ia - b.analise.score_ia)
      .slice(0, 10)
      .map(a => ({
        owner_id: a.cliente.owner_id,
        nome: a.cliente.nome_cliente,
        score: a.analise.score_ia,
        nivel: a.analise.nivel_risco,
        dias_sem: a.cliente.dias_sem_atividade,
        variacao: derivadasMap.get(a.cliente.owner_id)?.variacao_uso_pct ?? null,
        modulos: (a.info?.lista.modules ?? '').split(',').filter(Boolean),
        prob_60d: calcularProbabilidadeChurn60d(a.analise, a.cliente) ?? 0,
      }));

    const payload: InsightsPayload = { resumo, por_setor, por_modulo, padroes, top_risco };
    this.logger.log(`insights: chamando IA (${analisados.length} clientes analisados)`);
    const raw = await this.aiService.completar(buildInsightsPrompt(payload));
    this.logger.debug(`insights raw IA:\n${raw}`);

    let insightsIA: any[] = [];
    try {
      const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      insightsIA = JSON.parse(json);
    } catch { this.logger.error(`insights: falha ao parsear IA: ${raw}`); }

    const insights = insightsIA.map(i => ({
      tipo: i.tipo,
      titulo: i.titulo,
      descricao: i.descricao,
      clientes_afetados: i.owner_ids?.length ?? 0,
      owner_ids: i.owner_ids ?? [],
      acao_sugerida: i.acao_sugerida,
    }));

    const acoes_priorizadas = top_risco.map(c => ({
      owner_id: c.owner_id,
      nome: c.nome,
      probabilidade_churn_60d: c.prob_60d,
      nivel_risco: c.nivel,
      score_ia: c.score,
      acao_recomendada: analisados.find(a => a.cliente.owner_id === c.owner_id)?.analise.acao_recomendada ?? '',
    }));

    const result: RelatorioInsights = {
      gerado_em: new Date().toISOString(),
      de_cache: false,
      total_clientes_analisados: analisados.length,
      insights,
      acoes_priorizadas,
    };
    this.cache.saveInsightsCache(cacheKey, result);
    return result;
  }

  async getPlano(ownerId: string, nocache = false): Promise<PlanoAcao> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    const ctx = this.cache.getContexto(ownerId);
    const hash = this.cache.hashCliente(cliente, ctx?.contexto);
    const analise = this.cache.getAnalise(cliente.owner_id, hash);

    if (!analise) {
      throw new NotFoundException(`Nenhuma análise em cache para "${ownerId}". Execute POST /relatorio/cliente/${ownerId}/reprocessar primeiro.`);
    }

    if (!nocache) {
      const cached = this.cache.getPlanoCache(ownerId, hash);
      if (cached) return { ...cached, de_cache: true };
    }

    const { metricas_derivadas } = calcularParametrosRaw(cliente);
    const probabilidade = calcularProbabilidadeChurn60d(analise, cliente);
    const prompt = buildPlanoAcaoPrompt(cliente, analise, metricas_derivadas, ctx?.contexto ?? null, probabilidade);

    this.logger.log(`plano: chamando IA para ${cliente.nome_cliente}`);
    const raw = await this.aiService.completar(prompt);

    let planoIA: any = { prioridade: 'MEDIA', objetivo: '', passos: [], metricas_a_monitorar: [], sinal_de_sucesso: '' };
    try {
      const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      planoIA = JSON.parse(json);
    } catch { this.logger.error(`plano: falha ao parsear IA: ${raw}`); }

    const result: PlanoAcao = {
      owner_id: ownerId,
      nome_cliente: cliente.nome_cliente,
      probabilidade_churn_60d: probabilidade,
      prioridade: planoIA.prioridade ?? 'MEDIA',
      objetivo: planoIA.objetivo ?? '',
      passos: planoIA.passos ?? [],
      metricas_a_monitorar: planoIA.metricas_a_monitorar ?? [],
      sinal_de_sucesso: planoIA.sinal_de_sucesso ?? '',
      gerado_em: new Date().toISOString(),
      de_cache: false,
    };
    this.cache.savePlanoCache(ownerId, hash, result);
    return result;
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

function calcularStatsCnae(matches: import('./relatorio.types').CnaeMatch[]) {
  const total = matches.length;

  const moduloCount = new Map<string, number>();
  for (const m of matches) {
    for (const mod of m.modulos) {
      moduloCount.set(mod, (moduloCount.get(mod) ?? 0) + 1);
    }
  }
  const modulos_mais_usados = [...moduloCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([modulo, count]) => ({ modulo, count, percentual: total > 0 ? Math.round((count / total) * 100) : 0 }));

  const ufCount = new Map<string, number>();
  for (const m of matches) {
    if (m.uf) ufCount.set(m.uf, (ufCount.get(m.uf) ?? 0) + 1);
  }
  const uf_com_mais_clientes = [...ufCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([uf, count]) => ({ uf, count }));

  return { modulos_mais_usados, uf_com_mais_clientes };
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
