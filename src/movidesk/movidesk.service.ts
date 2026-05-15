import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MovideskTicket, MovideskResumo, TicketFiltros, TicketsCliente } from './movidesk.types';

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

  constructor(private config: ConfigService) {
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
