import { ClienteRisco } from '../../clientes/clientes.types';
import { AnaliseCliente } from '../ai.service';

export interface IAiProvider {
  readonly nome: string;
  readonly modelo: string;
  analisarLote(clientes: ClienteRisco[]): Promise<Map<string, AnaliseCliente>>;
}

export function parseRespostaLote(raw: string): Map<string, AnaliseCliente> {
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const lista: (AnaliseCliente & { owner_id: string })[] = JSON.parse(json);
  const result = new Map<string, AnaliseCliente>();
  for (const item of lista) {
    const { owner_id, ...analise } = item;
    result.set(owner_id, analise);
  }
  return result;
}
