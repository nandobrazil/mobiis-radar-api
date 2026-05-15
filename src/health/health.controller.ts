import { Controller, Get } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Controller('health')
export class HealthController {
  constructor(private db: DatabaseService) {}

  @Get()
  async check() {
    const dbOk = await this.db.connection
      .request()
      .query('SELECT 1')
      .then(() => true)
      .catch(() => false);

    return {
      status: dbOk ? 'ok' : 'degraded',
      database: dbOk ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    };
  }
}
