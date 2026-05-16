import { Logger } from '@nestjs/common';
import { ClienteRisco } from '../../clientes/clientes.types';
import { AnaliseCliente } from '../ai.service';
import { IAiProvider, parseRespostaLote } from './ai-provider.interface';
import { buildChurnPromptLote } from '../prompts';

export class GeminiProvider implements IAiProvider {
  readonly nome = 'GEMINI';
  readonly modelo: string;
  private token: string;
  private logger = new Logger('GeminiProvider');

  constructor(token: string, modelo: string) {
    this.token = token;
    this.modelo = modelo;
  }

  async analisarLote(clientes: ClienteRisco[], contextos?: Map<string, string>): Promise<Map<string, AnaliseCliente>> {
    this.logger.log(`Lote de ${clientes.length} clientes → ${this.modelo}`);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.modelo}:generateContent?key=${this.token}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildChurnPromptLote(clientes, contextos) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });

    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);

    const data: any = await res.json();
    const raw: string = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    this.logger.debug(`Raw Gemini response:\n${raw}`);
    if (!raw) {
      this.logger.error(`Gemini retornou content vazio. Full response: ${JSON.stringify(data)}`);
      return new Map();
    }
    return parseRespostaLote(raw, this.nome);
  }
}
