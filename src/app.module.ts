import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { ClientesModule } from './clientes/clientes.module';
import { AiModule } from './ai/ai.module';
import { RelatorioModule } from './relatorio/relatorio.module';
import { MapaModule } from './mapa/mapa.module';
import { CacheModule } from './cache/cache.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    CacheModule,
    ClientesModule,
    AiModule,
    RelatorioModule,
    MapaModule,
    HealthModule,
  ],
})
export class AppModule {}
