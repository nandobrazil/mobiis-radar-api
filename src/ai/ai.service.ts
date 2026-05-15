import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildChurnPromptLote } from './prompts';
import { ClienteRisco } from '../clientes/clientes.types';

export interface AnaliseCliente {
  nivel_risco: 'ALTO' | 'MEDIO' | 'BAIXO';
  score_ia: number;
  resumo: string;
  motivos: string[];
  acao_recomendada: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic;

  constructor(private config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
  }

  async analisarLote(clientes: ClienteRisco[]): Promise<Map<string, AnaliseCliente>> {
    this.logger.log(`Analisando lote de ${clientes.length} clientes via Claude Haiku`);

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8000,
      messages: [{ role: 'user', content: buildChurnPromptLote(clientes) }],
    });

    const raw = (response.content[0] as any).text as string;
    const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

    const result = new Map<string, AnaliseCliente>();
    try {
      const lista: (AnaliseCliente & { owner_id: string })[] = JSON.parse(json);
      for (const item of lista) {
        const { owner_id, ...analise } = item;
        result.set(owner_id, analise);
      }
    } catch (e) {
      this.logger.error(`Falha ao parsear resposta do lote: ${(e as Error).message}`);
    }

    return result;
  }
}
