import { ClienteRisco } from '../../clientes/clientes.types';
import { AnaliseCliente } from '../ai.service';

export interface IAiProvider {
  readonly nome: string;
  readonly modelo: string;
  analisarLote(clientes: ClienteRisco[]): Promise<Map<string, AnaliseCliente>>;
}

export function parseRespostaLote(raw: string): Map<string, AnaliseCliente> {
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const parsed = JSON.parse(json);

  // GPT com json_object retorna objeto wrapper; extraímos o primeiro valor que for array
  const lista: (AnaliseCliente & { owner_id: string })[] = Array.isArray(parsed)
    ? parsed
    : (Object.values(parsed).find(v => Array.isArray(v)) as any) ?? [];

  const result = new Map<string, AnaliseCliente>();
  for (const item of lista) {
    const { owner_id, ...analise } = item;
    result.set(owner_id, analise);
  }
  return result;
}
