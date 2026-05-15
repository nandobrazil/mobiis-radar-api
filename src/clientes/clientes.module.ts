import { Module } from '@nestjs/common';
import { ClientesService } from './clientes.service';

@Module({
  providers: [ClientesService],
  exports: [ClientesService],
})
export class ClientesModule {}
