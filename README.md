# mobiis-radar

API de radar de churn — identifica os clientes com maior risco de abandono e gera análise via Claude AI.

## Setup

```bash
# 1. Instalar dependências
npm install

# 2. Criar o arquivo de variáveis de ambiente
cp .env.example .env
# Editar .env com as credenciais reais

# 3. Rodar em modo desenvolvimento
npm run start:dev
```

A API sobe em `http://localhost:3000`.

## Variáveis de ambiente

| Variável          | Descrição                                    |
|-------------------|----------------------------------------------|
| `DB_HOST`         | Host do SQL Server (ex: `servidor.exemplo.com`) |
| `DB_NAME`         | Nome do banco de dados                       |
| `DB_USER`         | Usuário SQL                                  |
| `DB_PASS`         | Senha SQL                                    |
| `ANTHROPIC_API_KEY` | Chave da API Anthropic (Claude)            |

## Endpoints

### `GET /relatorio/top20`
Retorna os 20 clientes com maior risco, ordenados por `dias_sem_login` decrescente. Cada cliente vem com análise de churn gerada pela Claude.

**Resposta de exemplo:**
```json
[
  {
    "cliente": {
      "owner_id": "123",
      "nome_empresa": "Transportes XYZ",
      "dias_sem_login": 45,
      "fretes_ultimos_30d": 2,
      "fretes_ultimos_90d": 8,
      "tickets_abertos": 3,
      "ticket_medio": 1250.00
    },
    "analise": {
      "nivel_risco": "ALTO",
      "score": 82,
      "motivos": ["45 dias sem acesso à plataforma", "queda de 75% no volume de fretes"],
      "acao_recomendada": "Ligar hoje para o gestor comercial e oferecer desconto de reativação"
    }
  }
]
```

Se a Claude falhar para um cliente, o campo `analise` vem `null` e aparece `"erro": true`.

### `GET /relatorio/cliente/:ownerId`
Retorna análise individual de um cliente pelo `owner_id`.

Retorna **404** se o cliente não for encontrado.

## Ajustando as queries SQL

As queries ficam em `src/clientes/clientes.service.ts`. Os nomes atuais são **placeholders** — edite conforme o schema real:

| Placeholder       | O que representa                          |
|-------------------|-------------------------------------------|
| `clientes`        | Tabela principal de clientes/empresas     |
| `c.owner_id`      | Identificador único do cliente            |
| `c.nome_empresa`  | Nome da empresa                           |
| `logs_acesso`     | Tabela de log de acessos                  |
| `la.data_acesso`  | Data/hora do acesso                       |
| `fretes`          | Tabela de fretes/cotações                 |
| `f.data_frete`    | Data do frete                             |
| `f.valor`         | Valor monetário do frete                  |
| `tickets`         | Tabela de tickets de suporte              |
| `t.status`        | Status do ticket (valor `'aberto'`)       |

Todos os JOINs usam `owner_id` como chave de ligação. Ajuste conforme necessário.

## Ajustando o prompt da Claude

O prompt está em `src/ai/ai.service.ts`, método `analisarCliente`. Edite o texto para adaptar ao contexto do negócio ou para incluir mais campos quando as queries forem refinadas.
