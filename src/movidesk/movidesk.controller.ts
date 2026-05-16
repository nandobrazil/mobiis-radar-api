import { Controller, Get, Param, Query, ParseIntPipe, DefaultValuePipe, NotFoundException } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MovideskService } from './movidesk.service';
import { MovideskTicket, MovideskResumo, TicketsCliente, IndicadoresMovidesk } from './movidesk.types';

@ApiTags('Movidesk')
@Controller('movidesk')
export class MovideskController {
  constructor(private movidesk: MovideskService) {}

  @Get('tickets')
  @ApiOperation({
    summary: 'Lista tickets',
    description: 'Retorna tickets do Movidesk com filtros opcionais. Máximo 200 por chamada.',
  })
  @ApiQuery({ name: 'status',    required: false, description: 'baseStatus: New | InAttendance | Stopped | Resolved | Closed | Canceled' })
  @ApiQuery({ name: 'categoria', required: false, description: 'Categoria do ticket (ex: Solicitação, Atendimento)' })
  @ApiQuery({ name: 'cliente',   required: false, description: 'Busca por nome da empresa no campo clients.businessName' })
  @ApiQuery({ name: 'de',        required: false, description: 'Data início (YYYY-MM-DD)' })
  @ApiQuery({ name: 'ate',       required: false, description: 'Data fim (YYYY-MM-DD)' })
  @ApiQuery({ name: 'top',       required: false, description: 'Limite de resultados (padrão 50, máx 200)' })
  @ApiQuery({ name: 'skip',      required: false, description: 'Offset para paginação' })
  @ApiResponse({ status: 200, description: 'Lista de tickets.' })
  getTickets(
    @Query('status') status?: string,
    @Query('categoria') categoria?: string,
    @Query('cliente') cliente?: string,
    @Query('de') de?: string,
    @Query('ate') ate?: string,
    @Query('top', new DefaultValuePipe(50), ParseIntPipe) top?: number,
    @Query('skip', new DefaultValuePipe(0), ParseIntPipe) skip?: number,
  ): Promise<MovideskTicket[]> {
    return this.movidesk.getTickets({ status, categoria, cliente, de, ate, top, skip });
  }

  @Get('resumo')
  @ApiOperation({
    summary: 'Resumo estatístico de tickets',
    description: 'Agrega tickets dos últimos N dias: totais por status, categoria, urgência e tempo médio de resolução.',
  })
  @ApiQuery({ name: 'dias', required: false, description: 'Período em dias (padrão 90)' })
  @ApiResponse({ status: 200, description: 'Estatísticas agregadas.' })
  getResumo(
    @Query('dias', new DefaultValuePipe(90), ParseIntPipe) dias: number,
  ): Promise<MovideskResumo> {
    return this.movidesk.getResumo(dias);
  }

  @Get('cliente/:nome')
  @ApiOperation({
    summary: 'Tickets de uma empresa',
    description: 'Retorna todos os tickets vinculados a uma empresa pelo nome (busca parcial). Útil para correlacionar suporte com risco de churn.',
  })
  @ApiParam({ name: 'nome', description: 'Nome (parcial) da empresa (ex: GERDAU, Ambev)' })
  @ApiResponse({ status: 200, description: 'Tickets da empresa com contagem de abertos.' })
  getCliente(@Param('nome') nome: string): Promise<TicketsCliente> {
    return this.movidesk.getTicketsPorCliente(nome);
  }

  @Get('tickets/:id')
  @ApiOperation({
    summary: 'Detalhe de um ticket',
    description: 'Retorna o ticket completo incluindo clientes e ações/comentários.',
  })
  @ApiParam({ name: 'id', description: 'ID numérico do ticket' })
  @ApiResponse({ status: 200, description: 'Dados completos do ticket.' })
  getTicket(@Param('id', ParseIntPipe) id: number): Promise<MovideskTicket> {
    return this.movidesk.getTicket(id);
  }

  @Get('indicadores/:ownerId')
  @ApiOperation({
    summary: 'Indicadores de suporte por owner',
    description: 'Vincula tickets do Movidesk ao owner via e-mails dos usuários (Users.Email → Movidesk clients.email). Retorna score_suporte (0-100) e indicadores de risco de churn via suporte: tickets abertos, urgência alta, SLA e tendência de crescimento.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner (ex: DB42A861-9DD3-442E-9861-B7F9AB244BF8)' })
  @ApiResponse({ status: 200, description: 'Indicadores de suporte do owner.' })
  @ApiResponse({ status: 404, description: 'Owner sem usuários ou sem tickets no Movidesk.' })
  async getIndicadores(@Param('ownerId') ownerId: string): Promise<IndicadoresMovidesk> {
    const result = await this.movidesk.getIndicadoresPorOwner(ownerId);
    if (!result) throw new NotFoundException(`Nenhum ticket Movidesk encontrado para owner "${ownerId}"`);
    return result;
  }
}
