import { AnaliseCliente } from '../ai/ai.service';
import { ClienteRisco } from '../clientes/clientes.types';

export interface ClienteContexto {
  contexto: string;
  autor: string | null;
  atualizado_em: string;
}

export interface ClienteComAnalise {
  cliente: ClienteRisco;
  analise: AnaliseCliente | null;
  contexto: ClienteContexto | null;
  erro?: true;
}

export interface EntidadeDetalhe {
  entidade_id: number;
  entidade: string;
  acoes_30d: number;
  acoes_90d: number;
  negativas_30d: number;
  negativas_90d: number;
  automatizadas_30d: number;
  usuarios_distintos_30d: number;
  ultima_acao: string | null;
}

export interface OrigemDetalhe {
  origem_id: number;
  origem: string;
  acoes_30d: number;
  acoes_90d: number;
}

export interface TendenciaSemanal {
  entidade: string;
  semana_inicio: string;
  acoes: number;
}

export interface DetalheCliente {
  owner_id: string;
  nome_cliente: string;
  por_entidade: EntidadeDetalhe[];
  por_origem: OrigemDetalhe[];
  tendencia_semanal: TendenciaSemanal[];
}
