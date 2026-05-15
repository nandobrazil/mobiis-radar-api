import { AnaliseCliente } from '../ai/ai.service';
import { ClienteRisco } from '../clientes/clientes.types';

export interface ClienteComAnalise {
  cliente: ClienteRisco;
  analise: AnaliseCliente | null;
  erro?: true;
}
