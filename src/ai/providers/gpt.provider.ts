import { Logger } from '@nestjs/common';
import { ClienteRisco } from '../../clientes/clientes.types';
import { AnaliseCliente } from '../ai.service';
import { IAiProvider, parseRespostaLote } from './ai-provider.interface';
import { buildChurnPromptLote } from '../prompts';

export class GptProvider implements IAiProvider {
  readonly nome = 'GPT';
  readonly modelo: string;
  private token: string;
  private logger = new Logger('GptProvider');

  constructor(token: string, modelo: string) {
    this.token = token;
    this.modelo = modelo;
  }

  async analisarLote(clientes: ClienteRisco[]): Promise<Map<string, AnaliseCliente>> {
    this.logger.log(`Lote de ${clientes.length} clientes → ${this.modelo}`);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        model: this.modelo,
        max_tokens: 8000,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: buildChurnPromptLote(clientes) }],
      }),
    });

    if (!res.ok) throw new Error(`GPT ${res.status}: ${await res.text()}`);

    const data: any = await res.json();
    const raw: string = data.choices?.[0]?.message?.content ?? '[]';
    return parseRespostaLote(raw);
  }
}
