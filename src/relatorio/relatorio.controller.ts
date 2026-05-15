import { Controller, Get, Param } from '@nestjs/common';
import { RelatorioService } from './relatorio.service';
import { ClienteComAnalise } from './relatorio.types';

@Controller('relatorio')
export class RelatorioController {
  constructor(private relatorioService: RelatorioService) {}

  @Get('top20')
  getTop20(): Promise<ClienteComAnalise[]> {
    return this.relatorioService.getTop20();
  }

  @Get('cliente/:ownerId')
  getCliente(@Param('ownerId') ownerId: string): Promise<ClienteComAnalise> {
    return this.relatorioService.getCliente(ownerId);
  }
}
