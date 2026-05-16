export interface CnaeSecundario {
  codigo: number;
  descricao: string;
}

export interface OwnerLocalizacao {
  id: string;
  nome: string;
  tipo: number;
  status: number;
  documento: string | null;
  // Endereço (BrasilAPI via CNPJ)
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
  // Perfil da empresa (BrasilAPI)
  razao_social: string | null;
  nome_fantasia: string | null;
  cnae_fiscal: number | null;
  cnae_fiscal_descricao: string | null;
  cnaes_secundarios: CnaeSecundario[] | null;
  porte: string | null;
  natureza_juridica: string | null;
  capital_social: number | null;
  data_inicio_atividade: string | null;
  opcao_pelo_simples: boolean | null;
}
