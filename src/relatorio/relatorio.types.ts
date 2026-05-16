import { AnaliseCliente } from '../ai/ai.service';
import { FatorScore, Alerta } from '../ai/prompts';
import { ClienteRisco } from '../clientes/clientes.types';
import { OwnerLocalizacao } from '../mapa/mapa.types';

export interface ClienteContexto {
  contexto: string;
  autor: string | null;
  atualizado_em: string;
}

export interface ClienteComAnalise {
  cliente: ClienteRisco;
  analise: AnaliseCliente | null;
  contexto: ClienteContexto | null;
  owner: OwnerLocalizacao | null;
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

export interface MetricasDerivadas {
  acoes_periodo_anterior_60d: number;
  taxa_diaria_30d: number;
  taxa_diaria_anterior: number;
  variacao_uso_pct: number | null;
  pct_negativos: number;
  pct_core: number;
  pct_automatizado: number;
  score_saude_base: number;
  perfil_sugerido: string;
}

export interface AnaliseIaDetalhada extends AnaliseCliente {
  ajuste_ia: number;
  perfil_confirmado: boolean;
}

export interface ParametrosAnalise {
  owner_id: string;
  nome_cliente: string;
  metricas_brutas: ClienteRisco;
  metricas_derivadas: MetricasDerivadas;
  score_breakdown: FatorScore[];
  analise_ia: AnaliseIaDetalhada | null;
  alertas: Alerta[];
  contexto_cs: ClienteContexto | null;
}

export { FatorScore, Alerta };

export interface CnaeMatch {
  owner_id: string;
  nome: string;
  documento: string | null;
  municipio: string | null;
  uf: string | null;
  lat: number | null;
  lng: number | null;
  modulos: string[];
  cnae_fiscal: number | null;
  cnae_fiscal_descricao: string | null;
  similaridade: 'EXATO' | 'DIVISAO';
  cnaes_em_comum: { codigo: number; descricao: string }[];
  analise: AnaliseCliente | null;
}

export interface InsightsCnae {
  total_clientes_similares: number;
  modulos_mais_usados: { modulo: string; count: number; percentual: number }[];
  uf_com_mais_clientes: { uf: string; count: number }[];
  argumento_venda: string;
}

export interface MatchCnaeResult {
  matches: CnaeMatch[];
  insights: InsightsCnae;
}

export interface MatchCnaeInput {
  cnae_fiscal: number;
  cnae_fiscal_descricao?: string;
  cnaes_secundarios?: { codigo: number; descricao: string }[];
  [key: string]: any; // aceita payload completo da BrasilAPI
}
