export interface OwnerLocalizacao {
  id: string;
  nome: string;
  tipo: number;
  status: number;
  documento: string | null;
  // Endereço enriquecido (BrasilAPI via CNPJ)
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  municipio: string | null;
  uf: string | null;
  // Coordenadas (Nominatim via cidade+UF)
  lat: number | null;
  lng: number | null;
}
