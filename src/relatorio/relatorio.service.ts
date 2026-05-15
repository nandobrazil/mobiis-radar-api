import { Injectable, Logger } from '@nestjs/common';
import { ClientesService } from '../clientes/clientes.service';
import { AiService, AnaliseCliente } from '../ai/ai.service';
import { CacheService } from '../cache/cache.service';
import { ClienteRisco } from '../clientes/clientes.types';
import { ClienteComAnalise } from './relatorio.types';

@Injectable()
export class RelatorioService {
  private readonly logger = new Logger(RelatorioService.name);

  constructor(
    private clientesService: ClientesService,
    private aiService: AiService,
    private cache: CacheService,
  ) {}

  async getTop20(): Promise<ClienteComAnalise[]> {
    const candidatos = await this.clientesService.getCandidatos(50);
    const analisados = await Promise.all(candidatos.map((c) => this.enriquecer(c)));

    return analisados
      .sort((a, b) => (b.analise?.score_ia ?? -1) - (a.analise?.score_ia ?? -1))
      .slice(0, 20);
  }

  async getCliente(ownerId: string): Promise<ClienteComAnalise> {
    const cliente = await this.clientesService.getByOwnerId(ownerId);
    return this.enriquecer(cliente);
  }

  private async enriquecer(cliente: ClienteRisco): Promise<ClienteComAnalise> {
    const hash = this.cache.hashCliente(cliente);

    // Dados idênticos ao da última análise → reutiliza sem chamar a Claude
    const cached = this.cache.getAnalise(cliente.owner_id, hash);
    if (cached) {
      this.logger.debug(`Cache hit: ${cliente.nome_cliente} (hash=${hash})`);
      return { cliente, analise: cached };
    }

    try {
      const raw = await this.aiService.analisarRiscoCliente(cliente);
      const analise: AnaliseCliente = JSON.parse(raw);
      this.cache.saveAnalise(cliente.owner_id, hash, analise);
      return { cliente, analise };
    } catch {
      return { cliente, analise: null, erro: true };
    }
  }
}
