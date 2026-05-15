import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OwnerLocalizacao } from './mapa.types';

@Injectable()
export class MapaService {
  private cache: OwnerLocalizacao[] | null = null;
  private cacheExpiraEm: Date | null = null;

  constructor(private db: DatabaseService) {}

  async getOwners(): Promise<OwnerLocalizacao[]> {
    if (this.cache && this.cacheExpiraEm && new Date() < this.cacheExpiraEm) {
      return this.cache;
    }

    // Type = 3 (Embarcador) + LicenseType = 3 (licença ativa relevante)
    const result = await this.db.connection.request().query(`
      SELECT
        Id          AS id,
        Name        AS nome,
        Type        AS tipo,
        OwnerCidade AS cidade,
        OwnerUF     AS uf,
        OwnerPais   AS pais,
        Status      AS status,
        OwnerDocumentoNumero AS documento
      FROM Owners WITH (NOLOCK)
      WHERE Status != 3
        AND Type = 3
        AND LicenseType = 3
    `);

    this.cache = result.recordset;
    this.cacheExpiraEm = this.meianoiteDeHoje();
    return this.cache;
  }

  private meianoiteDeHoje(): Date {
    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    amanha.setHours(0, 0, 0, 0);
    return amanha;
  }
}
