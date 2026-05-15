import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MapaService } from './mapa.service';

@ApiTags('Mapa')
@Controller('mapa')
export class MapaController {
  constructor(private mapaService: MapaService) {}

  @Get('owners')
  @ApiOperation({
    summary: 'Lista owners para o mapa',
    description: 'Retorna todos os owners com cidade, UF e país para exibição no mapa. Resultado cacheado em memória até meia-noite.',
  })
  @ApiResponse({ status: 200, description: 'Lista de owners com localização.' })
  getOwners() {
    return this.mapaService.getOwners();
  }
}
