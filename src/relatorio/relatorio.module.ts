import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RelatorioController } from './relatorio.controller';
import { RelatorioService } from './relatorio.service';
import { ClientesModule } from '../clientes/clientes.module';
import { AiModule } from '../ai/ai.module';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [ConfigModule, ClientesModule, AiModule, DatabaseModule],
  controllers: [RelatorioController],
  providers: [RelatorioService],
})
export class RelatorioModule {}
