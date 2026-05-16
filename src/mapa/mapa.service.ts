import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { CacheService, OwnerGeoRow, OwnerListaRow } from '../cache/cache.service';
import { OwnerLocalizacao } from './mapa.types';

const NOMINATIM_UA = 'mobiis-radar/1.0 (contato interno)';
const BRASILAPI_BASE = 'https://brasilapi.com.br/api/cnpj/v1';
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search';

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
      };
    });
  }

  // ─── Enriquecimento geo ───────────────────────────────────────────────────

  private async enriquecerGeo(
    owners: OwnerListaRow[],
  ): Promise<Map<string, OwnerGeoRow & { lat: number | null; lng: number | null }>> {
    const result = new Map<string, OwnerGeoRow & { lat: number | null; lng: number | null }>();

    // Fase 1: BrasilAPI por CNPJ — lote de 5 paralelos
    const semGeo = owners.filter(o => o.documento && limparCnpj(o.documento).length === 14);
    const totalNovos = semGeo.filter(o => !this.cache.getOwnerGeo(limparCnpj(o.documento!))).length;
    if (totalNovos > 0) {
      this.logger.log(`BrasilAPI: ${totalNovos} CNPJs novos a buscar`);
    }

    const LOTE = 2;
    for (let i = 0; i < semGeo.length; i += LOTE) {
      const lote = semGeo.slice(i, i + LOTE);
      await Promise.all(lote.map(o => this.garantirGeoOwner(o)));
      if (i + LOTE < semGeo.length) await sleep(1500);
    }

    // Fase 2: Nominatim por cidade+UF — sequencial (1 req/seg)
    const cidadesNovas = new Set<string>();
    for (const o of owners) {
      const doc = limparCnpj(o.documento ?? '');
      if (doc.length !== 14) continue;
      const geo = this.cache.getOwnerGeo(doc);
      if (geo?.municipio && geo.uf) {
        const chave = `${geo.municipio.toUpperCase()}|${geo.uf.toUpperCase()}`;
        if (!this.cache.getCidadeGeo(geo.municipio, geo.uf)) {
          cidadesNovas.add(chave);
        }
      }
    }

    if (cidadesNovas.size > 0) {
      this.logger.log(`Nominatim: ${cidadesNovas.size} cidades novas a geocodificar`);
      for (const chave of cidadesNovas) {
        const [municipio, uf] = chave.split('|');
        const coords = await this.buscarNominatim(municipio, uf);
        this.cache.saveCidadeGeo(municipio, uf, coords?.lat ?? null, coords?.lng ?? null);
        await sleep(1100); // Respeita limite de 1 req/s do Nominatim
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
    if (this.cache.getOwnerGeo(doc)) return; // já está em cache permanente
    const geo = await this.buscarBrasilApi(doc);
    this.cache.saveOwnerGeo(geo);
  }

  // ─── BrasilAPI ────────────────────────────────────────────────────────────

  private async buscarBrasilApi(cnpj: string): Promise<OwnerGeoRow> {
    const vazio: OwnerGeoRow = {
      documento: cnpj,
      cep: null, logradouro: null, numero: null, complemento: null,
      bairro: null, municipio: null, uf: null,
      fonte: 'nao_encontrado',
    };

    try {
      const res = await fetch(`${BRASILAPI_BASE}/${cnpj}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!res.ok) {
        this.logger.warn(`BrasilAPI ${cnpj}: HTTP ${res.status}`);
        return vazio;
      }

      const d = await res.json() as Record<string, string>;
      return {
        documento: cnpj,
        cep: d.cep ?? null,
        logradouro: d.logradouro ?? null,
        numero: d.numero ?? null,
        complemento: d.complemento || null,
        bairro: d.bairro ?? null,
        municipio: d.municipio ?? null,
        uf: d.uf ?? null,
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

  // ─── SQL Server ───────────────────────────────────────────────────────────

  private async fetchOwnersFromSql(): Promise<OwnerListaRow[]> {
    const result = await this.db.connection.request().query(`
      SELECT
        Id          AS owner_id,
        Name        AS nome,
        Type        AS tipo,
        Status      AS status,
        OwnerDocumentoNumero AS documento
      FROM Owners WITH (NOLOCK)
      WHERE Status != 3
        AND Type = 3
        AND LicenseType = 3
    `);
    return result.recordset;
  }
}

function limparCnpj(doc: string): string {
  return doc.replace(/\D/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
