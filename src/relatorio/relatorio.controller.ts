import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RelatorioService } from './relatorio.service';
import { ClienteComAnalise, DetalheCliente } from './relatorio.types';

@ApiTags('Relatorio')
@Controller('relatorio')
export class RelatorioController {
  constructor(private relatorioService: RelatorioService) {}

  @Get('top20')
  @ApiOperation({
    summary: 'Top 20 clientes em risco de churn',
    description: 'Busca os 50 candidatos com maior risco via heurística SQL, analisa com Claude AI e retorna os 20 com maior score_ia.',
  })
  @ApiResponse({ status: 200, description: 'Lista de até 20 clientes ordenada por score_ia decrescente.' })
  getTop20(): Promise<ClienteComAnalise[]> {
    return this.relatorioService.getTop20();
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
