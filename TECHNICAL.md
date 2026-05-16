# Mobiis Radar — Documentação Técnica

> Backend NestJS para análise de churn de clientes Fretefy com IA, cache em SQLite e enriquecimento via BrasilAPI.

---

## Stack

| Camada | Tecnologia |
|---|---|
| Framework | NestJS (TypeScript) |
| Banco principal | SQL Server (mssql) — dados transacionais da Fretefy |
| Cache local | SQLite (better-sqlite3) — leituras rápidas, zero latência de rede |
| IA | Anthropic Claude / Google Gemini / OpenAI GPT (troca por env var) |
| Geocoding | BrasilAPI (CNPJ) + Nominatim + Photon (fallback lat/lng) |
| Documentação | Swagger (`/docs`) |

---

## Arquitetura Geral

```
                        ┌─────────────────────────────────────────┐
                        │              SQL Server                  │
                        │  ExecucaoHistorico │ Owners │ OwnerLicense│
                        └────────────┬────────────────────────────┘
                                     │ sync diário (datas faltantes)
                                     ▼
                        ┌─────────────────────────────────────────┐
                        │             SQLite (./data/)             │
                        │  atividades_diarias  │  owners_cache     │
                        │  owners_lista        │  owners_geo       │
                        │  cidades_geo         │  analises_cache   │
                        │  cliente_contexto    │  match_cnae_cache │
                        └────────────┬────────────────────────────┘
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                 ▼
             Score / Perfil    Prompt IA         BrasilAPI / Geo
             (determinístico)  (por chunk)       (enriquecimento)
                    │                │
                    └────────────────┘
                                     │
                        ┌────────────▼────────────────┐
                        │         REST API             │
                        │   /relatorio  │  /mapa       │
                        └─────────────────────────────┘
```

---

## Módulos NestJS

| Módulo | Responsabilidade |
|---|---|
| `DatabaseModule` | Conexão com SQL Server via `mssql`, singleton |
| `CacheModule` | SQLite local — sync, leitura, escrita, hashing |
| `ClientesModule` | Query de métricas de clientes do SQL Server |
| `AiModule` | Abstração de provider IA (Anthropic/Gemini/GPT) |
| `RelatorioModule` | Orquestra análise de churn + endpoints de resultado |
| `MapaModule` | Enriquecimento geo via BrasilAPI/Nominatim/Photon |

---

## SQL Server — Consultas Principais

### 1. Métricas de atividade por cliente (ClientesService)

Fonte: `ExecucaoHistorico` + `Owners`  
Filtros fixos: `o.LicenseType = 3` | `o.Status = 1` | `o.Type IN (1, 3)`

```sql
SELECT
  CAST(e.OwnerId AS VARCHAR(36))                                       AS owner_id,
  o.Name                                                               AS nome_cliente,
  DATEDIFF(DAY, MAX(e.DhExecucao), GETDATE())                         AS dias_sem_atividade,
  COUNT(*)                                                             AS acoes_90d,
  SUM(CASE WHEN e.DhExecucao >= DATEADD(DAY,-30,GETDATE()) THEN 1 ELSE 0 END) AS acoes_30d,
  SUM(CASE WHEN ... AND e.Entidade IN (1,5) THEN 1 ELSE 0 END)       AS acoes_core_30d,
  SUM(CASE WHEN ... AND e.TipoAcao IN (9,12,14,21) THEN 1 ELSE 0 END) AS acoes_negativas_30d,
  COUNT(DISTINCT CASE WHEN ... THEN e.UsuarioExecucaoId END)          AS usuarios_ativos,
  SUM(CASE WHEN ... AND e.OrigemExecucao IN (2,4,5) THEN 1 ELSE 0 END) AS acoes_automatizadas_30d,
  COUNT(DISTINCT CASE WHEN ... THEN e.Entidade END)                   AS entidades_utilizadas
FROM ExecucaoHistorico e WITH (NOLOCK)
INNER JOIN Owners o ON o.Id = e.OwnerId
WHERE e.DhExecucao >= DATEADD(DAY,-90,GETDATE())
  AND o.LicenseType = 3 AND o.Status = 1 AND o.Type IN (1, 3)
GROUP BY e.OwnerId, o.Name
```

**Entidades core (Entidade IN (1,5)):** Carga e Reservas  
**Ações negativas (TipoAcao IN (9,12,14,21)):** cancelamentos, exclusões, desativações  
**Origens automatizadas (OrigemExecucao IN (2,4,5)):** API, Automação, Processo automático

---

### 2. Lista de owners com módulos (MapaService)

Busca owners com seus módulos de licença via `STRING_AGG`:

```sql
SELECT
  CAST(o.Id AS VARCHAR(36)) AS owner_id,
  o.Name                    AS nome,
  o.Type                    AS tipo,
  o.Status                  AS status,
  o.Document                AS documento,
  STRING_AGG(CAST(ol.LicenseId AS VARCHAR(36)), ',') AS modules
FROM Owners o WITH (NOLOCK)
LEFT JOIN OwnerLicense ol WITH (NOLOCK) ON ol.OwnerId = o.Id
WHERE o.LicenseType = 3 AND o.Status = 1 AND o.Type IN (1, 3)
GROUP BY o.Id, o.Name, o.Type, o.Status, o.Document
```

Os UUIDs de `LicenseId` são mapeados para nomes legíveis via `MODULE_NAMES` (23 entradas) antes de salvar no SQLite.

---

### 3. Detalhe de atividade por entidade (RelatorioService)

Para o endpoint `/relatorio/cliente/:id/detalhe` — breakdown dos últimos 90 dias:

```sql
SELECT
  e.Entidade,
  SUM(CASE WHEN DhExecucao >= DATEADD(DAY,-30,GETDATE()) THEN 1 ELSE 0 END) AS acoes_30d,
  COUNT(*) AS acoes_90d,
  -- negativas, automatizadas, usuarios_distintos, ultima_acao
FROM ExecucaoHistorico e WITH (NOLOCK)
WHERE e.OwnerId = @ownerId AND e.DhExecucao >= DATEADD(DAY,-90,GETDATE())
GROUP BY e.Entidade
```

Tendência semanal (4 semanas): agrupamento por `DATEADD(WEEK, DATEDIFF(WEEK, 0, DhExecucao), 0)`.

---

## SQLite — Estrutura de Cache

### Tabelas

| Tabela | Chave | TTL / Invalidação |
|---|---|---|
| `atividades_diarias` | `(owner_id, data)` | Permanente; sync apenas datas faltantes |
| `owners_cache` | `owner_id` | Permanente; atualizado no sync diário |
| `sync_log` | `data` | Controla quais datas já foram sincronizadas |
| `analises_cache` | `owner_id` | Invalidado por hash dos dados |
| `cliente_contexto` | `owner_id` | Permanente; atualizado por ação do CS |
| `owners_lista` | `owner_id` | TTL de 7 dias |
| `owners_geo` | `documento (CNPJ)` | Permanente (BrasilAPI não re-busca) |
| `cidades_geo` | `municipio\|uf` | Permanente (Nominatim não re-busca) |
| `match_cnae_cache` | `cnae_fiscal,...cnaes_secundarios` | Invalidado se novos owners encontrados |

### Estratégias de invalidação por tabela

**`analises_cache` — hash-based**
```
hash = bucket(dias_sem_atividade) | acoes_90d | acoes_30d | acoes_core_30d |
       acoes_core_90d | acoes_negativas_30d | entidades | usuarios | auto | [contexto]
```
- `dias_sem_atividade` é agrupado em faixas (0, 1-7, 8-15, 16-30, 31-60, 61-90, 91+) para evitar invalidação diária por +1 dia.
- Qualquer mudança nos números OU no contexto CS invalida o cache e força nova análise.

**`owners_lista` — TTL fixo**
- Recriada completamente a cada 7 dias via `saveOwnersList()`.
- `forceSync` deleta e re-sincroniza imediatamente.

**`match_cnae_cache` — por crescimento de matches**
- Chave: `cnae_fiscal,sorted(cnaes_secundarios[].codigo)`.
- Ao buscar: se `currentMatches.length > cached.total_matches` → invalida e reprocessa via IA.
- `?nocache=true` força reprocessamento independente.

---

## Fluxo de Sync Diário

```
onModuleInit()
    │
    ▼
syncDatasNovas()
    ├── Lê sync_log → descobre datas não sincronizadas (janela de 90 dias)
    ├── Query SQL Server: ExecucaoHistorico por intervalo de datas faltantes
    ├── Insere em atividades_diarias (UPSERT por owner_id + data)
    ├── Atualiza owners_cache
    └── Marca datas em sync_log
```

Apenas datas ausentes são buscadas — se hoje já foi sincronizado, a query SQL não é executada.

---

## Pipeline de Análise de Churn

```
getTodos() / getCliente()
    │
    ├── Cache hit? ──────────────────────────────────────► retorna direto (0 tokens)
    │      (hash dos dados bate com analises_cache)
    │
    └── Cache miss ──► calcularParametrosRaw()
                           ├── metricas_derivadas (taxa_diaria, variacao_uso_pct, ...)
                           ├── score_saude_base (0-100, determinístico)
                           └── perfil_sugerido (POWER_USER, MODERADO, ...)
                                │
                                ▼
                       buildChurnPromptLote()  (chunk de 3 clientes)
                                │
                                ▼
                       IA Provider (Anthropic / Gemini / GPT)
                       temperature: 0 (respostas determinísticas)
                                │
                                ▼
                       parseRespostaLote()  →  Map<owner_id, AnaliseCliente>
                                │
                                ▼
                       saveAnalise()  →  analises_cache (SQLite)
```

**Distribuição stripe nos chunks:** clientes ordenados por `score_saude_base` e distribuídos round-robin entre os chunks (`item i → chunk i % totalChunks`). Garante que cada chunk tenha clientes de todos os níveis de risco, evitando viés de ancoragem da IA.

---

## Enriquecimento Geográfico

### Fluxo de enriquecimento de CNPJ

```
owner com documento (CNPJ)
    │
    ├── owners_geo hit? ──────────────────────────────► usa dados cacheados
    │
    └── owners_geo miss ──► BrasilAPI /cnpj/v1/{cnpj}
                                 ├── razao_social, nome_fantasia
                                 ├── cnae_fiscal + cnaes_secundarios
                                 ├── porte, natureza_juridica
                                 └── municipio, uf, cep
                                          │
                                          ▼
                               saveOwnerGeo()  →  owners_geo (permanente)
```

### Fallback para lat/lng

```
municipio + uf
    │
    ├── cidades_geo hit? ─────────────────────────────► usa lat/lng cacheados
    │
    └── cidades_geo miss ──► Nominatim (OpenStreetMap)
                                  │
                             falhou? ──► Photon (fallback)
                                  │
                             saveCidadeGeo()  →  cidades_geo (permanente)
```

---

## Endpoints REST

### `/relatorio`

| Método | Path | Descrição | Cache |
|---|---|---|---|
| GET | `/status` | Progresso do processamento em lote | — |
| GET | `/clientes` | Todos os clientes com análise | analises_cache |
| GET | `/cliente/:id` | Análise individual (só cache) | analises_cache |
| POST | `/cliente/:id/reprocessar` | Força nova análise via IA (1 cliente) | Atualiza cache |
| GET | `/cliente/:id/parametros` | Score breakdown + alertas + métricas derivadas | analises_cache |
| GET | `/cliente/:id/detalhe` | Histórico 90d por entidade, origem e tendência semanal | — (SQL direto) |
| GET | `/cliente/:id/contexto` | Contexto CS salvo | cliente_contexto |
| POST | `/cliente/:id/contexto` | Salva/atualiza contexto CS | Invalida analises_cache |
| DELETE | `/cliente/:id/contexto` | Remove contexto CS | — |
| POST | `/match-cnae` | Match de CNAE + insights IA para argumentação de venda | match_cnae_cache |

**Status codes especiais:**
- `202` em `GET /clientes` enquanto análise em andamento — frontend faz polling em `/status`
- `203` em `POST /match-cnae` quando resultado vem do cache (`de_cache: true`)

### `/mapa`

| Método | Path | Descrição |
|---|---|---|
| GET | `/owners` | Owners com lat/lng para mapa |
| GET | `/forceSync` | Limpa cache e re-sincroniza tudo do zero |

---

## Configuração (`.env`)

```env
# SQL Server
DB_SERVER=...
DB_NAME=...
DB_USER=...
DB_PASSWORD=...
DB_PORT=1433

# IA — escolha um provider
AI_PROVIDER=ANTHROPIC          # ANTHROPIC | GEMINI | GPT
ANTHROPIC_TOKEN=sk-ant-...
ANTHROPIC_MODELO=claude-haiku-4-5-20251001
GEMINI_TOKEN=...
GEMINI_MODELO=gemini-2.5-flash-lite
GPT_TOKEN=sk-...
GPT_MODELO=gpt-4o-mini

# Flags
ALLOW_NO_CACHE=false           # true = permite ?nocache=true nos endpoints
```

---

## Providers de IA — Abstração

Todos os providers implementam `IAiProvider`:

```typescript
interface IAiProvider {
  readonly nome: string;
  readonly modelo: string;
  analisarLote(clientes, contextos?): Promise<Map<string, AnaliseCliente>>;
  completar(prompt: string): Promise<string>;  // usado pelo match-cnae
}
```

Troca de provider sem alterar código — apenas `AI_PROVIDER` no `.env` e restart.

**Configuração comum em todos os providers:** `temperature: 0` — respostas determinísticas, sem variação entre retentativas. Retry automático em 429 (rate limit) com backoff de 30s/60s/90s (Anthropic).

---

## Segurança e Performance

- `WITH (NOLOCK)` em todas as queries SQL Server — leitura sem bloquear operações transacionais
- `analiseEmAndamento: Promise` — deduplicação de chamadas concorrentes; segunda chamada aguarda a primeira sem disparar nova IA
- `bucketDias()` — agrupa `dias_sem_atividade` em faixas para evitar invalidação de cache diária por +1 dia
- Delay de 2s entre chunks — evita rate limit dos providers de IA
- Score com `Math.max(0, Math.min(100, ...))` — nunca extrapola os limites
