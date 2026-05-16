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

  async analisarLote(clientes: ClienteRisco[], contextos?: Map<string, string>): Promise<Map<string, AnaliseCliente>> {
    this.logger.log(`Lote de ${clientes.length} clientes → ${this.modelo}`);
    const prompt = buildChurnPromptLote(clientes, contextos);

    const raw = await this.chamarComRetry(prompt);
    this.logger.debug(`Raw Anthropic response:\n${raw}`);
    return parseRespostaLote(raw, this.nome);
  }

  async completar(prompt: string): Promise<string> {
    return this.chamarComRetry(prompt);
  }

  private async chamarComRetry(prompt: string, tentativa = 1): Promise<string> {
    try {
      const response = await this.client.messages.create({
        model: this.modelo,
        max_tokens: 8000,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      });
      return (response.content[0] as any).text as string;
    } catch (e: any) {
      const status = e?.status ?? e?.error?.status;
      if (status === 429 && tentativa < 4) {
        const delay = tentativa * 30000; // 30s, 60s, 90s
        this.logger.warn(`429 rate limit — aguardando ${delay / 1000}s (tentativa ${tentativa}/3)`);
        await new Promise(r => setTimeout(r, delay));
        return this.chamarComRetry(prompt, tentativa + 1);
      }
      throw e;
    }
  }
}
