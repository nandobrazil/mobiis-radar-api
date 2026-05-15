import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClienteRisco } from '../clientes/clientes.types';
import { IAiProvider } from './providers/ai-provider.interface';
import { AnthropicProvider } from './providers/anthropic.provider';
import { GeminiProvider } from './providers/gemini.provider';
import { GptProvider } from './providers/gpt.provider';

export interface AnaliseCliente {
  nivel_risco: 'ALTO' | 'MEDIO' | 'BAIXO';
  score_ia: number;
  resumo: string;
  motivos: string[];
  acao_recomendada: string;
}

@Injectable()
export class AiService implements OnModuleInit {
  private readonly logger = new Logger(AiService.name);
  private provider: IAiProvider;

  constructor(private config: ConfigService) {}

  onModuleInit() {
    this.provider = this.createProvider();
    this.logger.log(`Provider ativo: ${this.provider.nome} / modelo: ${this.provider.modelo}`);
  }

  async analisarLote(clientes: ClienteRisco[]): Promise<Map<string, AnaliseCliente>> {
    return this.provider.analisarLote(clientes);
  }

  private createProvider(): IAiProvider {
    const nome = (this.config.getOrThrow<string>('AI_PROVIDER')).toUpperCase();

    switch (nome) {
      case 'ANTHROPIC':
        return new AnthropicProvider(
          this.config.getOrThrow('ANTHROPIC_TOKEN'),
          this.config.getOrThrow('ANTHROPIC_MODELO'),
        );
      case 'GEMINI':
        return new GeminiProvider(
          this.config.getOrThrow('GEMINI_TOKEN'),
          this.config.getOrThrow('GEMINI_MODELO'),
        );
      case 'GPT':
        return new GptProvider(
          this.config.getOrThrow('GPT_TOKEN'),
          this.config.getOrThrow('GPT_MODELO'),
        );
      default:
        throw new Error(`AI_PROVIDER "${nome}" inválido. Valores aceitos: ANTHROPIC, GEMINI, GPT`);
    }
  }
}
