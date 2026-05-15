import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RelatorioService } from './relatorio.service';
import { ClienteComAnalise, DetalheCliente } from './relatorio.types';

@ApiTags('Relatorio')
@Controller('relatorio')
export class RelatorioController {
  constructor(private relatorioService: RelatorioService) {}

  @Get('clientes')
  @ApiOperation({
    summary: 'Todos os clientes com análise de churn',
    description: 'Retorna todos os clientes com análise de risco gerada pelo Claude Haiku em lote. Clientes com dados inalterados usam cache — Claude só é chamado para quem tem mudança nas métricas.',
  })
  @ApiResponse({ status: 200, description: 'Lista completa de clientes ordenada por score_ia decrescente.' })
  getTodos(): Promise<ClienteComAnalise[]> {
    return this.relatorioService.getTodos();
  }

  @Get('cliente/:ownerId')
  @ApiOperation({
    summary: 'Análise individual de um cliente',
    description: 'Retorna métricas de comportamento e análise de churn gerada pela Claude AI para o owner informado.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner (ex: DB42A861-9DD3-442E-9861-B7F9AB244BF8)' })
  @ApiResponse({ status: 200, description: 'Dados do cliente com análise de risco.' })
  @ApiResponse({ status: 404, description: 'Owner não encontrado.' })
  getCliente(@Param('ownerId') ownerId: string): Promise<ClienteComAnalise> {
    return this.relatorioService.getCliente(ownerId);
  }

  @Get('cliente/:ownerId/detalhe')
  @ApiOperation({
    summary: 'Histórico detalhado por entidade',
    description: 'Retorna breakdown dos últimos 90 dias por tipo de entidade (Carga, TabelaFrete, Acordo, etc.), mix de origens (Plataforma/API/Automação) e tendência semanal das últimas 4 semanas.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner (ex: DB42A861-9DD3-442E-9861-B7F9AB244BF8)' })
  @ApiResponse({ status: 200, description: 'Breakdown detalhado de atividade por entidade.' })
  @ApiResponse({ status: 404, description: 'Owner sem atividade nos últimos 90 dias.' })
  getDetalhe(@Param('ownerId') ownerId: string): Promise<DetalheCliente> {
    return this.relatorioService.getDetalhe(ownerId);
  }
}
