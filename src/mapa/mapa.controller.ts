import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MapaService } from './mapa.service';

@ApiTags('Mapa')
@Controller('mapa')
export class MapaController {
  constructor(private mapaService: MapaService) {}

  @Get('owners')
  @ApiOperation({
    summary: 'Lista owners para o mapa',
    description: 'Retorna owners com endereço e coordenadas enriquecidos via BrasilAPI + Nominatim. Use nocache=true para forçar re-fetch do SQL Server.',
  })
  @ApiQuery({ name: 'nocache', required: false, type: Boolean })
  getOwners(@Query('nocache') nocache?: string) {
    return this.mapaService.getOwners(nocache === 'true');
  }

  @Get('geo/export')
  @ApiOperation({
    summary: 'Exporta cache de geo (owners_geo + cidades_geo)',
    description: 'Retorna JSON com todo o cache de endereços e coordenadas. Use para mover o cache entre ambientes (ex: local → servidor com IP bloqueado).',
  })
  exportGeo() {
    return this.mapaService.exportGeo();
  }

  @Post('geo/import')
  @ApiOperation({
    summary: 'Importa cache de geo (owners_geo + cidades_geo)',
    description: 'Recebe o JSON exportado por GET /mapa/geo/export e grava no SQLite local. Faz upsert — não apaga dados existentes.',
  })
  @ApiBody({ description: 'JSON gerado por GET /mapa/geo/export' })
  @ApiResponse({ status: 201, description: '{ owners: N, cidades: M }' })
  importGeo(@Body() body: any) {
    return this.mapaService.importGeo(body);
  }
}
