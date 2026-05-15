import { Module } from '@nestjs/common';
import { RelatorioController } from './relatorio.controller';
import { RelatorioService } from './relatorio.service';
import { ClientesModule } from '../clientes/clientes.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [ClientesModule, AiModule],
  controllers: [RelatorioController],
  providers: [RelatorioService],
})
export class RelatorioModule {}
