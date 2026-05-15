import { Controller, Get } from '@nestjs/common';
import { MapaService } from './mapa.service';

@Controller('mapa')
export class MapaController {
  constructor(private mapaService: MapaService) {}

  @Get('owners')
  getOwners() {
    return this.mapaService.getOwners();
  }
}
