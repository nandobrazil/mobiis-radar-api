import Anthropic from '@anthropic-ai/sdk';
import { Logger } from '@nestjs/common';
import { ClienteRisco } from '../../clientes/clientes.types';
import { AnaliseCliente } from '../ai.service';
import { IAiProvider, parseRespostaLote } from './ai-provider.interface';
import { buildChurnPromptLote } from '../prompts';

export class AnthropicProvider implements IAiProvider {
  readonly nome = 'ANTHROPIC';
  readonly modelo: string;
  private client: Anthropic;
  private logger = new Logger('AnthropicProvider');

  constructor(token: string, modelo: string) {
    this.client = new Anthropic({ apiKey: token });
    this.modelo = modelo;
  }

  async analisarLote(clientes: ClienteRisco[]): Promise<Map<string, AnaliseCliente>> {
    this.logger.log(`Lote de ${clientes.length} clientes → ${this.modelo}`);

    const response = await this.client.messages.create({
      model: this.modelo,
      max_tokens: 8000,
      messages: [{ role: 'user', content: buildChurnPromptLote(clientes) }],
    });

    const raw = (response.content[0] as any).text as string;
    return parseRespostaLote(raw);
  }
}
