import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';
import { DatabaseService } from '../database/database.service';
import { MovideskTicket, MovideskResumo, TicketFiltros, TicketsCliente, IndicadoresMovidesk } from './movidesk.types';

const INDICADOR_FIELDS = 'id,baseStatus,urgency,category,createdDate,resolvedIn';

const BASE_URL = 'https://api.movidesk.com/public/v1';

const TICKET_FIELDS = [
  'id', 'type', 'subject', 'category', 'urgency', 'status', 'baseStatus',
  'origin', 'ownerTeam', 'createdDate', 'resolvedIn', 'closedIn', 'lastUpdate',
  'serviceFirstLevelId', 'serviceFull', 'tags',
].join(',');

@Injectable()
export class MovideskService {
  private readonly logger = new Logger(MovideskService.name);
  private readonly token: string;

  constructor(
    private config: ConfigService,
    private db: DatabaseService,
  ) {
    this.token = this.config.getOrThrow<string>('MOVIDESK_TOKEN');
  }

  async getTickets(filtros: TicketFiltros = {}): Promise<MovideskTicket[]> {
    const params = new URLSearchParams({ token: this.token, $select: TICKET_FIELDS, '$expand': 'clients' });

    const filters: string[] = [];
    if (filtros.status)    filters.push(`baseStatus eq '${filtros.status}'`);
    if (filtros.categoria) filters.push(`category eq '${filtros.categoria}'`);
    if (filtros.de)        filters.push(`createdDate ge ${filtros.de}T00:00:00Z`);
    if (filtros.ate)       filters.push(`createdDate le ${filtros.ate}T23:59:59Z`);
    if (filtros.cliente)   filters.push(`clients/any(c: contains(c/businessName,'${filtros.cliente}'))`);
    if (filters.length)    params.set('$filter', filters.join(' and '));

    params.set('$top',  String(Math.min(filtros.top  ?? 50, 200)));
    params.set('$skip', String(filtros.skip ?? 0));

    return this.request<MovideskTicket[]>(`/tickets?${params}`);
  }

  async getTicket(id: number): Promise<MovideskTicket> {
    const params = new URLSearchParams({
      token: this.token,
      $select: TICKET_FIELDS,
      '$expand': 'clients,actions',
    });
    return this.request<MovideskTicket>(`/tickets/${id}?${params}`);
  }

  async getResumo(periodoDias = 90): Promise<MovideskResumo> {
    const de = new Date();
    de.setDate(de.getDate() - periodoDias);
    const deStr = de.toISOString().split('T')[0];

    const params = new URLSearchParams({
      token: this.token,
      $select: 'id,baseStatus,category,urgency,createdDate,resolvedIn',
      '$expand': 'clients',
      $top: '1000',
      $filter: `createdDate ge ${deStr}T00:00:00Z`,
    });

    const tickets = await this.request<MovideskTicket[]>(`/tickets?${params}`);

    const por_status: Record<string, number> = {};
    const por_categoria: Record<string, number> = {};
    const por_urgencia: Record<string, number> = {};
    const tempos: number[] = [];

    for (const t of tickets) {
      por_status[t.baseStatus]    = (por_status[t.baseStatus]    ?? 0) + 1;
      por_categoria[t.category]   = (por_categoria[t.category]   ?? 0) + 1;
      por_urgencia[t.urgency]     = (por_urgencia[t.urgency]     ?? 0) + 1;
      if (t.resolvedIn) {
        const horas = (new Date(t.resolvedIn).getTime() - new Date(t.createdDate).getTime()) / 3_600_000;
        if (horas > 0) tempos.push(horas);
      }
    }

    const abertos     = (por_status['New'] ?? 0);
    const emAndamento = (por_status['InAttendance'] ?? 0) + (por_status['Stopped'] ?? 0);
    const encerrados  = (por_status['Resolved'] ?? 0) + (por_status['Closed'] ?? 0) + (por_status['Canceled'] ?? 0);
    const tMedio      = tempos.length ? tempos.reduce((a, b) => a + b, 0) / tempos.length : null;

    return {
      periodo_dias: periodoDias,
      total: tickets.length,
      por_status,
      por_categoria,
      por_urgencia,
      tempo_medio_resolucao_horas: tMedio !== null ? Math.round(tMedio * 10) / 10 : null,
      abertos,
      em_andamento: emAndamento,
      encerrados,
    };
  }

  async getTicketsPorCliente(nomeEmpresa: string): Promise<TicketsCliente> {
    const params = new URLSearchParams({
      token: this.token,
      $select: TICKET_FIELDS,
      '$expand': 'clients',
      $top: '200',
      $filter: `clients/any(c: contains(c/businessName,'${nomeEmpresa}'))`,
    });

    const tickets = await this.request<MovideskTicket[]>(`/tickets?${params}`);

    const abertos = tickets.filter(t => ['New', 'InProgress', 'Stopped'].includes(t.baseStatus)).length;

    return {
      empresa: nomeEmpresa,
      total: tickets.length,
      abertos,
      tickets,
    };
  }

  async getIndicadoresPorOwner(ownerId: string): Promise<IndicadoresMovidesk | null> {
    // 1. Busca emails dos usuários deste owner no SQL Server
    const emailsResult = await this.db.connection.request()
      .input('ownerId', sql.UniqueIdentifier, ownerId)
      .query<{ Email: string; Name: string }>(`
        SELECT DISTINCT u.Email, o.Name
        FROM Users u
        INNER JOIN Owners o ON o.Id = u.OwnerId
        WHERE u.OwnerId = @ownerId
          AND u.Email IS NOT NULL
          AND u.Email != ''
      `);

    const emails = emailsResult.recordset.map(r => r.Email).slice(0, 15);
    const nomeCliente = emailsResult.recordset[0]?.Name ?? ownerId;

    if (!emails.length) return null;

    // 2. Busca tickets no Movidesk para cada email (em paralelo, deduplica por id)
    const ticketsPorEmail = await Promise.all(
      emails.map(email => this.ticketsPorEmail(email)),
    );

    const ticketMap = new Map<number, MovideskTicket>();
    for (const lista of ticketsPorEmail)
      for (const t of lista)
        if (!ticketMap.has(t.id)) ticketMap.set(t.id, t);

    const tickets = [...ticketMap.values()];
    if (!tickets.length) return null;

    // 3. Calcula indicadores
    const agora = Date.now();
    const ms30d = 30 * 86_400_000;
    const ms90d = 90 * 86_400_000;

    const tickets90d = tickets.filter(t => agora - new Date(t.createdDate).getTime() <= ms90d);
    const tickets30d = tickets90d.filter(t => agora - new Date(t.createdDate).getTime() <= ms30d);
    const tickets60_90d = tickets90d.filter(t => {
      const age = agora - new Date(t.createdDate).getTime();
      return age > ms30d && age <= ms90d;
    });

    const abertos    = tickets90d.filter(t => ['New', 'InAttendance'].includes(t.baseStatus)).length;
    const pendentes  = tickets90d.filter(t => t.baseStatus === 'Stopped').length;
    const encerrados = tickets90d.filter(t => ['Closed', 'Resolved', 'Canceled'].includes(t.baseStatus)).length;

    const altaUrgencia = tickets90d.filter(t => {
      const nivel = parseInt(t.urgency?.split(' ')[0] ?? '0', 10);
      return nivel >= 3;
    }).length;

    const tempos: number[] = [];
    for (const t of tickets90d) {
      if (t.resolvedIn) {
        const h = (new Date(t.resolvedIn).getTime() - new Date(t.createdDate).getTime()) / 3_600_000;
        if (h > 0) tempos.push(h);
      }
    }
    const tempoMedio = tempos.length
      ? Math.round((tempos.reduce((a, b) => a + b, 0) / tempos.length) * 10) / 10
      : null;

    // Tendência: compara ritmo 30d atual vs ritmo dos 30d anteriores (60-90d atrás)
    const ritmoAnterior = tickets60_90d.length;
    const delta = ritmoAnterior > 0
      ? Math.round(((tickets30d.length - ritmoAnterior) / ritmoAnterior) * 100)
      : tickets30d.length > 0 ? 100 : 0;
    const tendencia = delta >= 20 ? 'crescendo' : delta <= -20 ? 'caindo' : 'estavel';

    const por_categoria: Record<string, number> = {};
    for (const t of tickets90d) {
      const cat = t.category ?? 'Sem categoria';
      por_categoria[cat] = (por_categoria[cat] ?? 0) + 1;
    }

    // Score 0-100
    const n = Math.max(tickets90d.length, 1);
    const ptAbertos   = (abertos / n) * 30;
    const ptUrgencia  = (altaUrgencia / n) * 25;
    const ptSla       = tempoMedio !== null ? Math.min(tempoMedio / 168, 1) * 20 : 0;
    const ptTendencia = tendencia === 'crescendo' ? Math.min(delta / 100, 1) * 15 : 0;
    const ptVolume    = Math.min(tickets90d.length / 10, 1) * 10;
    const score_suporte = Math.round(ptAbertos + ptUrgencia + ptSla + ptTendencia + ptVolume);

    return {
      owner_id: ownerId,
      nome_cliente: nomeCliente,
      emails_vinculados: emails,
      total_tickets: tickets.length,
      tickets_90d: tickets90d.length,
      tickets_30d: tickets30d.length,
      tickets_abertos: abertos,
      tickets_pendentes: pendentes,
      tickets_encerrados: encerrados,
      tickets_alta_urgencia: altaUrgencia,
      tempo_medio_resolucao_horas: tempoMedio,
      tendencia,
      tendencia_delta_pct: delta,
      por_categoria,
      score_suporte,
    };
  }

  private async ticketsPorEmail(email: string): Promise<MovideskTicket[]> {
    const params = new URLSearchParams({
      token: this.token,
      $select: INDICADOR_FIELDS,
      $top: '200',
      $filter: `clients/any(c: c/email eq '${email}')`,
    });
    try {
      return await this.request<MovideskTicket[]>(`/tickets?${params}`);
    } catch {
      this.logger.warn(`Falha ao buscar tickets para ${email}`);
      return [];
    }
  }

  private async request<T>(path: string): Promise<T> {
    const url = `${BASE_URL}${path}`;
    this.logger.debug(`GET ${url.replace(this.token, '***')}`);

    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Movidesk ${res.status}: ${body}`);
    }
    return res.json() as Promise<T>;
  }
}
