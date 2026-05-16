import { Injectable, Logger } from '@nestjs/common';
import { CacheService, OwnerGeoRow, OwnerListaRow } from '../cache/cache.service';
import { DatabaseService } from '../database/database.service';
import { OwnerLocalizacao } from './mapa.types';

const NOMINATIM_UA = 'mobiis-radar/1.0 (contato interno)';
const BRASILAPI_BASE = 'https://brasilapi.com.br/api/cnpj/v1';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';
const PHOTON_BASE = 'https://photon.komoot.io/api';

const MODULE_NAMES: Record<string, string> = {
  '48F19D74-254C-42F6-9D74-A7ADCBBDAD75': 'Cargas',
  'B8C66705-FBB8-4751-BA55-C6E718DD08E3': 'Frota',
  '37898966-5155-4A7B-A803-53A49328A036': 'Oferecimento',
  'C196AA7E-B034-4FFA-B27A-B1FF2292175E': 'OferecimentoRestrito',
  'B32BDFE3-831D-4713-BF05-431D9936E683': 'FormacaoCargas',
  'CE21F801-07C9-4E69-8E20-D82FFDCD369A': 'FormacaoImpressaoEtiquetas',
  '5757A1F3-FCBB-4417-8A6D-AB212B587373': 'KpiCargas',
  '01DC0461-3656-4276-9A6D-268499F7B52A': 'HubCargas',
  '26E47DB1-7F6A-46D3-910F-14EC5BEECF48': 'PersonalizacaoKanbanCargas',
  'D9F0AB03-49DC-47D4-833F-ECBA153B71C2': 'HubIntegracao',
  '63CEEC2B-8E89-400A-98E1-3B725DA583D9': 'Auditoria',
  '5FEF627D-FFE7-4769-BC57-B8C880578AA0': 'PortalAcompanhamento',
  'BCCBA80C-D6E7-4AA8-830B-28DBBBEA3317': 'Relatorios',
  '086127D0-7205-4303-A95B-09C0792739A3': 'PortalAgendamentoDoca',
  '5CEBBC5E-6844-4309-A9B2-5BBA359C264D': 'CrossDocking',
  '3E749E4F-F294-4C64-8A11-35322BD50E4F': 'AutomacaoAlertas',
  '8812C8A7-0935-432E-A475-BAA390116AF9': 'CargasRestrito',
  '58559C1C-B774-417A-BC8F-224F9144BDDD': 'Checklist',
  'F912F29B-D6ED-42E0-818D-BB8F5182FD9E': 'Dashboards',
  'AF85F73C-C4BE-44A2-AA98-AA6A794DE7E0': 'Painel',
  'E9C52F84-2C85-4C5F-8C90-F0255C5D9F61': 'Acordos',
  '640BA6E4-E79A-4B2C-ACF7-A7F18483E656': 'MIA',
  '881F3C1C-6CE8-4FBD-8144-F5D41AECBEE3': 'ValidacaoComprovantes',
};

@Injectable()
export class MapaService {
  private readonly logger = new Logger(MapaService.name);

  constructor(
    private db: DatabaseService,
    private cache: CacheService,
  ) {}

  async getOwners(nocache = false): Promise<OwnerLocalizacao[]> {
    // 1. Owner list: SQL Server com TTL de 7 dias no SQLite
    let owners: OwnerListaRow[];
    const cached = !nocache && this.cache.getOwnersList();
    if (cached) {
      this.logger.log(`owners_lista: ${cached.length} do cache SQLite`);
      owners = cached;
    } else {
      if (nocache) {
        const removidos = this.cache.clearGeoNaoEncontrado();
        if (removidos > 0) this.logger.log(`nocache: ${removidos} entradas nao_encontrado removidas para re-fetch`);
      }
      owners = await this.fetchOwnersFromSql();
      this.cache.saveOwnersList(owners);
      this.logger.log(`owners_lista: ${owners.length} buscados do SQL Server`);
    }

    // 2. Enriquecer com geo — fase 1: BrasilAPI por CNPJ (paralelo, lote de 5)
    const geoMap = await this.enriquecerGeo(owners);

    // 3. Montar resposta final
    return owners.map(o => {
      const geo = geoMap.get(o.owner_id);
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
        cnaes_secundarios: geo?.cnaes_secundarios
          ? JSON.parse(geo.cnaes_secundarios)
          : null,
        porte: geo?.porte ?? null,
        natureza_juridica: geo?.natureza_juridica ?? null,
        capital_social: geo?.capital_social ?? null,
        data_inicio_atividade: geo?.data_inicio_atividade ?? null,
        opcao_pelo_simples: geo?.opcao_pelo_simples ?? null,
      };
    });
  }

  exportGeo() {
    return this.cache.exportGeo();
  }

  importGeo(data: any) {
    const resultado = this.cache.importGeo(data);
    this.logger.log(`importGeo: ${resultado.owners} CNPJs e ${resultado.cidades} cidades importados`);
    return resultado;
  }

  // ─── Enriquecimento geo ───────────────────────────────────────────────────

  private async enriquecerGeo(
    owners: OwnerListaRow[],
  ): Promise<Map<string, OwnerGeoRow & { lat: number | null; lng: number | null }>> {
    const result = new Map<string, OwnerGeoRow & { lat: number | null; lng: number | null }>();

    // Fase 1: BrasilAPI por CNPJ — apenas CNPJs ainda não cacheados
    const comCnpj = owners.filter(o => o.documento && limparCnpj(o.documento).length === 14);
    const novos = comCnpj.filter(o => !this.cache.getOwnerGeo(limparCnpj(o.documento!)));

    if (novos.length > 0) {
      this.logger.log(`BrasilAPI: ${novos.length} CNPJs novos a buscar (${comCnpj.length - novos.length} já em cache)`);
      for (let i = 0; i < novos.length; i++) {
        await this.garantirGeoOwner(novos[i]);
        if (i < novos.length - 1) await sleep(2000);
      }
    } else {
      this.logger.log(`BrasilAPI: todos os ${comCnpj.length} CNPJs já em cache`);
    }

    // Fase 2: Nominatim por cidade+UF — apenas cidades ainda não cacheadas
    const cidadesNovas = new Set<string>();
    for (const o of comCnpj) {
      const geo = this.cache.getOwnerGeo(limparCnpj(o.documento!));
      if (geo?.municipio && geo.uf) {
        const chave = `${geo.municipio.toUpperCase()}|${geo.uf.toUpperCase()}`;
        if (!this.cache.getCidadeGeo(geo.municipio, geo.uf)) {
          cidadesNovas.add(chave);
        }
      }
    }

    if (cidadesNovas.size > 0) {
      this.logger.log(`Geocodificando ${cidadesNovas.size} cidades novas`);
      const chaves = [...cidadesNovas];
      for (let i = 0; i < chaves.length; i++) {
        const [municipio, uf] = chaves[i].split('|');
        let coords = await this.buscarNominatim(municipio, uf);
        if (!coords) {
          await sleep(500);
          coords = await this.buscarPhoton(municipio, uf);
        }
        this.cache.saveCidadeGeo(municipio, uf, coords?.lat ?? null, coords?.lng ?? null);
        if (i < chaves.length - 1) await sleep(1100); // 1 req/s — não dorme após o último
      }
    }

    // Fase 3: Montar mapa de resultado
    for (const o of owners) {
      const doc = limparCnpj(o.documento ?? '');
      if (doc.length !== 14) continue;
      const geo = this.cache.getOwnerGeo(doc);
      if (!geo || geo.fonte === 'nao_encontrado') continue;
      const cidade = geo.municipio && geo.uf
        ? this.cache.getCidadeGeo(geo.municipio, geo.uf)
        : null;
      result.set(o.owner_id, {
        ...geo,
        lat: cidade?.lat ?? null,
        lng: cidade?.lng ?? null,
      });
    }

    return result;
  }

  private async garantirGeoOwner(owner: OwnerListaRow): Promise<void> {
    const doc = limparCnpj(owner.documento!);
    if (this.cache.getOwnerGeo(doc)) return;
    const geo = await this.buscarBrasilApi(doc);
    if (geo.fonte !== 'erro_transitorio') this.cache.saveOwnerGeo(geo);
  }

  // ─── BrasilAPI ────────────────────────────────────────────────────────────

  private async buscarBrasilApi(cnpj: string, tentativa = 1): Promise<OwnerGeoRow> {
    const vazio: OwnerGeoRow = {
      documento: cnpj,
      cep: null, logradouro: null, numero: null, complemento: null,
      bairro: null, municipio: null, uf: null,
      fonte: 'nao_encontrado',
    };

    try {
      const res = await fetch(`${BRASILAPI_BASE}/${cnpj}`, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; mobiis-radar/1.0)',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        if (res.status === 404) {
          // 404 = CNPJ genuinamente não cadastrado — salva como nao_encontrado permanente
          this.logger.log(`BrasilAPI ${cnpj}: não encontrado na Receita Federal`);
          return vazio;
        }
        if (res.status === 403 && tentativa < 4) {
          // 403 = possível rate limit (BrasilAPI não usa 429) — retenta com backoff
          const delay = tentativa * 5000;
          this.logger.warn(`BrasilAPI ${cnpj}: 403 (tentativa ${tentativa}/3) — aguardando ${delay / 1000}s`);
          await sleep(delay);
          return this.buscarBrasilApi(cnpj, tentativa + 1);
        }
        // 403 após 3 tentativas ou outro status: não cacheia, tenta novamente na próxima execução
        this.logger.warn(`BrasilAPI ${cnpj}: HTTP ${res.status} após ${tentativa} tentativa(s) — pulando sem cachear`);
        return { ...vazio, fonte: 'erro_transitorio' };
      }

      const d = await res.json() as Record<string, any>;
      return {
        documento: cnpj,
        cep: d.cep ?? null,
        logradouro: d.logradouro ?? null,
        numero: d.numero ?? null,
        complemento: d.complemento || null,
        bairro: d.bairro ?? null,
        municipio: d.municipio ?? null,
        uf: d.uf ?? null,
        razao_social: d.razao_social ?? null,
        nome_fantasia: d.nome_fantasia || null,
        cnae_fiscal: d.cnae_fiscal ?? null,
        cnae_fiscal_descricao: d.cnae_fiscal_descricao ?? null,
        cnaes_secundarios: d.cnaes_secundarios?.length
          ? JSON.stringify(d.cnaes_secundarios.map((c: any) => ({ codigo: c.codigo, descricao: c.descricao })))
          : null,
        porte: d.porte ?? null,
        natureza_juridica: d.natureza_juridica ?? null,
        capital_social: d.capital_social ?? null,
        data_inicio_atividade: d.data_inicio_atividade ?? null,
        opcao_pelo_simples: d.opcao_pelo_simples ?? null,
        fonte: 'brasilapi',
      };
    } catch (e) {
      this.logger.warn(`BrasilAPI ${cnpj}: ${(e as Error).message}`);
      return vazio;
    }
  }

  // ─── Nominatim ────────────────────────────────────────────────────────────

  private async buscarNominatim(municipio: string, uf: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const params = new URLSearchParams({
        city: municipio,
        state: uf,
        country: 'Brazil',
        format: 'json',
        limit: '1',
      });

      const res = await fetch(`${NOMINATIM_BASE}?${params}`, {
        headers: { 'User-Agent': NOMINATIM_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        this.logger.warn(`Nominatim ${municipio}/${uf}: HTTP ${res.status}`);
        return null;
      }

      const data = await res.json() as Array<{ lat: string; lon: string }>;
      if (!data.length) {
        this.logger.warn(`Nominatim ${municipio}/${uf}: sem resultado`);
        return null;
      }

      return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
    } catch (e) {
      this.logger.warn(`Nominatim ${municipio}/${uf}: ${(e as Error).message}`);
      return null;
    }
  }

  private async buscarPhoton(municipio: string, uf: string): Promise<{ lat: number; lng: number } | null> {
    try {
      const params = new URLSearchParams({
        q: `${municipio}, ${uf}, Brasil`,
        limit: '1',
        lang: 'pt',
      });

      const res = await fetch(`${PHOTON_BASE}?${params}`, {
        headers: { 'User-Agent': NOMINATIM_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        this.logger.warn(`Photon ${municipio}/${uf}: HTTP ${res.status}`);
        return null;
      }

      const data = await res.json() as { features: Array<{ geometry: { coordinates: [number, number] } }> };
      if (!data.features?.length) {
        this.logger.warn(`Photon ${municipio}/${uf}: sem resultado`);
        return null;
      }

      // Photon retorna [lng, lat]
      const [lng, lat] = data.features[0].geometry.coordinates;
      this.logger.log(`Photon ${municipio}/${uf}: encontrado (${lat}, ${lng})`);
      return { lat, lng };
    } catch (e) {
      this.logger.warn(`Photon ${municipio}/${uf}: ${(e as Error).message}`);
      return null;
    }
  }

  // ─── SQL Server ───────────────────────────────────────────────────────────

  private async fetchOwnersFromSql(): Promise<OwnerListaRow[]> {
    const result = await this.db.connection.request().query(`
      SELECT
        o.Id                     AS owner_id,
        o.Name                   AS nome,
        o.Type                   AS tipo,
        o.Status                 AS status,
        o.OwnerDocumentoNumero   AS documento,
        STRING_AGG(CAST(ol.ModuleId AS VARCHAR(50)), ',') AS modules
      FROM Owners o WITH (NOLOCK)
      LEFT JOIN OwnerLicense ol WITH (NOLOCK) ON ol.OwnerId = o.Id
      WHERE o.Status = 1
        AND o.Type IN (1, 3)
        AND o.LicenseType = 3
      GROUP BY o.Id, o.Name, o.Type, o.Status, o.OwnerDocumentoNumero
    `);
    return result.recordset.map(r => ({
      ...r,
      modules: r.modules
        ? r.modules.split(',')
            .map((id: string) => MODULE_NAMES[id.trim().toUpperCase()] ?? null)
            .filter(Boolean)
            .join(',')
        : null,
    }));
  }
}

function limparCnpj(doc: string): string {
  return doc.replace(/\D/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
