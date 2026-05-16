export interface MovideskCliente {
  id: string;
  personType: number; // 1=pessoa, 2=empresa
  profileType: number;
  businessName: string;
  email: string;
  phone: string | null;
  isDeleted: boolean;
}

export interface MovideskTicket {
  id: number;
  type: number;
  subject: string;
  category: string;
  urgency: string;
  status: string;
  baseStatus: string;
  origin: number;
  ownerTeam: string | null;
  createdDate: string;
  resolvedIn: string | null;
  closedIn: string | null;
  lastUpdate: string;
  serviceFirstLevelId: number | null;
  serviceFull: string[];
  tags: string[];
  clients: MovideskCliente[];
}

export interface TicketFiltros {
  status?: string;        // baseStatus: New | InAttendance | Stopped | Resolved | Closed | Canceled
  categoria?: string;
  cliente?: string;       // busca por businessName (contains)
  de?: string;            // ISO date
  ate?: string;           // ISO date
  top?: number;
  skip?: number;
}

export interface MovideskResumo {
  periodo_dias: number;
  total: number;
  por_status: Record<string, number>;
  por_categoria: Record<string, number>;
  por_urgencia: Record<string, number>;
  tempo_medio_resolucao_horas: number | null;
  abertos: number;
  em_andamento: number;
  encerrados: number;
}

export interface TicketsCliente {
  empresa: string;
  total: number;
  abertos: number;
  tickets: MovideskTicket[];
}

export interface IndicadoresMovidesk {
  owner_id: string;
  nome_cliente: string;
  emails_vinculados: string[];

  // Volume
  total_tickets: number;
  tickets_90d: number;
  tickets_30d: number;

  // Status
  tickets_abertos: number;      // New + InAttendance
  tickets_pendentes: number;    // Stopped
  tickets_encerrados: number;   // Closed + Resolved + Canceled

  // Severidade
  tickets_alta_urgencia: number; // urgência >= 3 (Alta, Muito alta)

  // SLA
  tempo_medio_resolucao_horas: number | null;

  // Tendência (30d vs ritmo anterior)
  tendencia: 'crescendo' | 'estavel' | 'caindo';
  tendencia_delta_pct: number;

  // Categorias
  por_categoria: Record<string, number>;

  // Score de risco via suporte (0-100, maior = mais risco de churn)
  score_suporte: number;
}
