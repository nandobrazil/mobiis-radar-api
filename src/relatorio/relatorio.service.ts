import { Injectable } from '@nestjs/common';
import { ClientesService } from '../clientes/clientes.service';
import { AiService, AnaliseCliente } from '../ai/ai.service';
import { ClienteRisco } from '../clientes/clientes.types';
import { ClienteComAnalise } from './relatorio.types';

@Injectable()
export class RelatorioService {
  constructor(
    private clientesService: ClientesService,
    private aiService: AiService,
  ) {}

  async getTop20(): Promise<ClienteComAnalise[]> {
    // SQL seleciona candidatos por heurística simples; IA decide o ranking final.
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
    try {
      const raw = await this.aiService.analisarRiscoCliente(cliente);
      const analise: AnaliseCliente = JSON.parse(raw);
      return { cliente, analise };
    } catch {
      return { cliente, analise: null, erro: true };
    }
  }
}
