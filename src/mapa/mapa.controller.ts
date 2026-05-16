import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MapaService } from './mapa.service';

@ApiTags('Mapa')
@Controller('mapa')
export class MapaController {
  constructor(private mapaService: MapaService) {}

  @Get('owners')
  @ApiOperation({
    summary: 'Lista owners para o mapa',
    description: 'Retorna owners com endereço e coordenadas enriquecidos via BrasilAPI + Nominatim. Lista de owners: cache SQLite de 7 dias. Geo por CNPJ: permanente (nunca re-busca). Use nocache=true para forçar re-fetch do SQL Server.',
  })
  @ApiQuery({ name: 'nocache', required: false, type: Boolean, description: 'true = força re-fetch do SQL Server (geo permanece em cache)' })
  @ApiResponse({ status: 200, description: 'Lista de owners com endereço e lat/lng.' })
  getOwners(@Query('nocache') nocache?: string) {
    return this.mapaService.getOwners(nocache === 'true');
  }
}
