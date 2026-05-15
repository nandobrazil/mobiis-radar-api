export interface OwnerLocalizacao {
  id: string;
  nome: string;
  tipo: number;
  cidade: string | null;
  uf: string | null;
  pais: number | null;
  status: number;
}
