import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DatabaseService } from '../database/database.service';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private db: DatabaseService) {}

  @Get()
  @ApiOperation({ summary: 'Healthcheck', description: 'Verifica a conectividade com o banco de dados.' })
  @ApiResponse({ status: 200, description: '{ status: "ok" | "degraded", database: "up" | "down", timestamp }' })
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
