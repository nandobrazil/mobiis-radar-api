import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MovideskController } from './movidesk.controller';
import { MovideskService } from './movidesk.service';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [MovideskController],
  providers: [MovideskService],
  exports: [MovideskService],
})
export class MovideskModule {}
