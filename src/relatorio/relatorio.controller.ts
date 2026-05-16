import { Body, Controller, Delete, Get, HttpCode, HttpException, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { RelatorioService, StatusAnalise } from './relatorio.service';
import { ClienteComAnalise, DetalheCliente, MatchCnaeInput, MatchCnaeResult, ParametrosAnalise } from './relatorio.types';

@ApiTags('Relatorio')
@Controller('relatorio')
export class RelatorioController {
  constructor(private relatorioService: RelatorioService) {}

  @Get('status')
  @ApiOperation({
    summary: 'Status do processamento em andamento',
    description: 'Retorna o progresso da análise em lote (chunks concluídos, clientes analisados). Use para polling no frontend enquanto processando=true.',
  })
  @ApiResponse({ status: 200, description: 'Status atual.' })
  getStatus(): StatusAnalise {
    return this.relatorioService.getStatus();
  }

  @Get('clientes')
  @ApiOperation({
    summary: 'Todos os clientes com análise de churn',
    description: 'Retorna todos os clientes com análise de risco. Retorna 202 se a análise ainda está em andamento — faça polling em GET /relatorio/status e tente novamente quando processando=false.',
  })
  @ApiQuery({ name: 'nocache', required: false, description: 'true = ignora cache e reprocessa via IA (só funciona se ALLOW_NO_CACHE=true no servidor)' })
  @ApiResponse({ status: 200, description: 'Lista completa de clientes ordenada por risco/score.' })
  @ApiResponse({ status: 202, description: 'Análise em andamento — tente novamente em breve.' })
  async getTodos(@Query('nocache') nocache?: string): Promise<ClienteComAnalise[]> {
    const status = this.relatorioService.getStatus();
    if (status.processando && nocache !== 'true') {
      throw new HttpException(status, 202);
    }
    return this.relatorioService.getTodos(nocache === 'true');
  }

  @Post('match-cnae')
  @ApiOperation({
    summary: 'Match de CNAE contra base de clientes para argumento de venda',
    description: 'Recebe o payload completo da BrasilAPI (ou apenas cnae_fiscal + cnaes_secundarios) e retorna clientes na base com CNAEs idênticos (EXATO) ou do mesmo setor (DIVISAO), com os módulos que cada um usa e insights gerados por IA para argumentação de venda. O resultado é cacheado por combinação de CNAEs e invalidado automaticamente se novos owners forem encontrados. Use ?nocache=true para forçar reprocessamento via IA.',
  })
  @ApiQuery({ name: 'nocache', required: false, description: 'true = ignora cache e reprocessa insights via IA' })
  @ApiBody({ schema: { properties: { cnae_fiscal: { type: 'number' }, cnae_fiscal_descricao: { type: 'string' }, cnaes_secundarios: { type: 'array' } } } })
  @ApiResponse({ status: 200, description: 'Resultado fresco processado pela IA. de_cache=false.' })
  @ApiResponse({ status: 203, description: 'Resultado servido do cache. de_cache=true.' })
  async matchCnae(@Body() body: MatchCnaeInput, @Query('nocache') nocache?: string): Promise<MatchCnaeResult> {
    const result = await this.relatorioService.matchCnae(body, nocache === 'true');
    if (result.de_cache) throw new HttpException(result, 203);
    return result;
  }

  @Get('cliente/:ownerId')
  @ApiOperation({
    summary: 'Análise individual de um cliente',
    description: 'Retorna métricas e a análise em cache para o owner. Para forçar nova análise via IA, use POST /relatorio/cliente/:id/reprocessar.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner (ex: DB42A861-9DD3-442E-9861-B7F9AB244BF8)' })
  @ApiResponse({ status: 200, description: 'Dados do cliente com análise de risco.' })
  @ApiResponse({ status: 404, description: 'Owner não encontrado.' })
  getCliente(@Param('ownerId') ownerId: string): Promise<ClienteComAnalise> {
    return this.relatorioService.getCliente(ownerId);
  }

  @Post('cliente/:ownerId/reprocessar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reprocessa a análise de um cliente individualmente via IA',
    description: 'Chama a IA com apenas este cliente (máxima acurácia, sem viés de comparação com outros). Atualiza o cache e retorna o resultado. Use este endpoint para o botão "Reprocessar" do frontend.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner' })
  @ApiResponse({ status: 200, description: 'Análise atualizada.' })
  @ApiResponse({ status: 404, description: 'Owner não encontrado.' })
  reprocessar(@Param('ownerId') ownerId: string): Promise<ClienteComAnalise> {
    return this.relatorioService.reprocessarCliente(ownerId);
  }

  @Get('cliente/:ownerId/contexto')
  @ApiOperation({ summary: 'Lê o contexto CS de um cliente' })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner' })
  @ApiResponse({ status: 200, description: 'Contexto salvo pelo CS.' })
  @ApiResponse({ status: 404, description: 'Nenhum contexto salvo para esse cliente.' })
  getContexto(@Param('ownerId') ownerId: string) {
    const ctx = this.relatorioService.getContexto(ownerId);
    if (!ctx) throw new NotFoundException('Nenhum contexto salvo para esse cliente.');
    return ctx;
  }

  @Post('cliente/:ownerId/contexto')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Salva ou atualiza o contexto CS de um cliente',
    description: 'O contexto é incluído no prompt da IA nas próximas análises. Qualquer alteração invalida o cache e força re-análise automática.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner' })
  @ApiBody({ schema: { properties: { contexto: { type: 'string' }, autor: { type: 'string' } }, required: ['contexto'] } })
  @ApiResponse({ status: 200, description: 'Contexto salvo.' })
  saveContexto(
    @Param('ownerId') ownerId: string,
    @Body() body: { contexto: string; autor?: string },
  ) {
    if (!body?.contexto?.trim()) {
      throw new NotFoundException('Campo "contexto" é obrigatório e não pode ser vazio.');
    }
    this.relatorioService.saveContexto(ownerId, body.contexto.trim(), body.autor);
    return { ok: true, owner_id: ownerId };
  }

  @Delete('cliente/:ownerId/contexto')
  @HttpCode(200)
  @ApiOperation({ summary: 'Remove o contexto CS de um cliente' })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner' })
  @ApiResponse({ status: 200, description: 'Contexto removido.' })
  deleteContexto(@Param('ownerId') ownerId: string) {
    this.relatorioService.deleteContexto(ownerId);
    return { ok: true, owner_id: ownerId };
  }

  @Get('cliente/:ownerId/parametros')
  @ApiOperation({
    summary: 'Parâmetros utilizados pela IA para chegar nas conclusões',
    description: 'Expõe as métricas brutas do SQL, as métricas derivadas calculadas antes do prompt, o breakdown fator-a-fator do score base, o que a IA ajustou vs o cálculo determinístico, e alertas sobre o que está errado ou pode melhorar. Usa o cache existente — não chama a IA novamente.',
  })
  @ApiParam({ name: 'ownerId', description: 'GUID do owner' })
  @ApiResponse({ status: 200, description: 'Parâmetros completos da análise.' })
  @ApiResponse({ status: 404, description: 'Owner não encontrado.' })
  getParametros(@Param('ownerId') ownerId: string): Promise<ParametrosAnalise> {
    return this.relatorioService.getParametros(ownerId);
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
