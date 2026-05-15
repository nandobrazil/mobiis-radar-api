import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as sql from 'mssql';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private pool: sql.ConnectionPool;
  private readonly logger = new Logger(DatabaseService.name);

  constructor(private config: ConfigService) {}

  private get config_() {
    return {
      server: this.config.get<string>('DB_HOST'),
      port: parseInt(this.config.get<string>('DB_PORT') ?? '1433', 10),
      database: this.config.get<string>('DB_NAME'),
      user: this.config.get<string>('DB_USER'),
      password: this.config.get<string>('DB_PASS'),
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 15000,
      requestTimeout: 60000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    };
  }

  async onModuleInit() {
    await this.connect();
  }

  async onModuleDestroy() {
    await this.pool?.close();
  }

  private async connect() {
    this.pool = new sql.ConnectionPool(this.config_);
    this.pool.on('error', async (err) => {
      this.logger.error(`Pool error: ${err.message} — reconectando em 5s`);
      setTimeout(() => this.connect(), 5000);
    });
    await this.pool.connect();
    this.logger.log('Conexão com SQL Server estabelecida');
  }

  get connection(): sql.ConnectionPool {
    return this.pool;
  }
}
