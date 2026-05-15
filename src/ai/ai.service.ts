import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildChurnPrompt } from './prompts';

export interface AnaliseCliente {
  nivel_risco: 'ALTO' | 'MEDIO' | 'BAIXO';
  score_ia: number;
  resumo: string;
  motivos: string[];
  acao_recomendada: string;
}

@Injectable()
export class AiService {
  private client: Anthropic;

  constructor(private config: ConfigService) {
    this.client = new Anthropic({
      apiKey: this.config.get<string>('ANTHROPIC_API_KEY'),
    });
  }


  async analisarRiscoCliente(cliente: any): Promise<string> {
    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: buildChurnPrompt(cliente),
      }],
    });

    const raw = (response.content[0] as any).text as string;
    return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  }
}
