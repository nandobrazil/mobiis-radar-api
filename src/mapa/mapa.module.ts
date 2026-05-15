import { Module } from '@nestjs/common';
import { MapaController } from './mapa.controller';
import { MapaService } from './mapa.service';

@Module({
  controllers: [MapaController],
  providers: [MapaService],
})
export class MapaModule {}
