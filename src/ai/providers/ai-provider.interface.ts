import { ClienteRisco } from '../../clientes/clientes.types';
import { AnaliseCliente } from '../ai.service';

export interface IAiProvider {
  readonly nome: string;
  readonly modelo: string;
  analisarLote(clientes: ClienteRisco[], contextos?: Map<string, string>): Promise<Map<string, AnaliseCliente>>;
  completar(prompt: string): Promise<string>;
}

export function parseRespostaLote(raw: string, providerNome = 'AI'): Map<string, AnaliseCliente> {
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    console.error(`[${providerNome}] JSON inválido recebido:\n${raw}`);
    throw new Error(`${providerNome}: resposta não é JSON válido — ${(e as Error).message}`);
  }

  // GPT com json_object retorna objeto wrapper; extraímos o primeiro valor que for array
  const lista: (AnaliseCliente & { owner_id: string })[] = Array.isArray(parsed)
    ? parsed
    : (Object.values(parsed as object).find(v => Array.isArray(v)) as any) ?? [];

  if (!lista.length) {
    console.error(`[${providerNome}] Nenhum item encontrado no parsed. Raw:\n${raw}`);
  }

  const result = new Map<string, AnaliseCliente>();
  for (const item of lista) {
    const { owner_id, ...analise } = item;
    if (!owner_id) {
      console.warn(`[${providerNome}] Item sem owner_id ignorado:`, JSON.stringify(item));
      continue;
    }
    result.set(owner_id, analise);
  }
  return result;
}
