import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MovideskController } from './movidesk.controller';
import { MovideskService } from './movidesk.service';

@Module({
  imports: [ConfigModule],
  controllers: [MovideskController],
  providers: [MovideskService],
  exports: [MovideskService],
})
export class MovideskModule {}
