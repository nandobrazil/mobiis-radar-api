# AI Prompts — Mobiis Radar

> Documentação dos prompts e da lógica determinística em `src/ai/prompts.ts`.
> Cada seção corresponde a um bloco independente do arquivo — apto para uso como slide de apresentação.

---

## Slide 1 — Visão Geral da Arquitetura

```
                    ┌─────────────────────────────────────┐
                    │          prompts.ts                  │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │  1. CONTEXTO_PLATAFORMA       │   │
                    │  │     (constante compartilhada) │   │
                    │  └──────────────┬───────────────┘   │
                    │                 │                    │
                    │  ┌──────────────▼───────────────┐   │
                    │  │  2. Score Determinístico      │   │  → sem IA, sem custo
                    │  │     calcularScoreDetalhado()  │   │
                    │  │     sugerirPerfil()           │   │
                    │  └──────────────┬───────────────┘   │
                    │                 │                    │
                    │  ┌──────────────▼───────────────┐   │
                    │  │  3. Alertas Determinísticos   │   │  → sem IA, sem custo
                    │  │     gerarAlertas()            │   │
                    │  └──────────────┬───────────────┘   │
                    │                 │                    │
                    │  ┌──────────────▼───────────────┐   │
                    │  │  4. Prompt Churn (lote)       │   │  → 1 chamada por chunk
                    │  │     buildChurnPromptLote()    │   │
                    │  └──────────────────────────────┘   │
                    │                                      │
                    │  ┌──────────────────────────────┐   │
                    │  │  5. Prompt Match CNAE         │   │  → 1 chamada por busca
                    │  │     buildMatchCnaePrompt()    │   │
                    │  └──────────────────────────────┘   │
                    └─────────────────────────────────────┘
```

**Princípio:** tudo que pode ser calculado deterministicamente **não passa pela IA**.
A IA é chamada apenas onde há julgamento contextual que os números sozinhos não capturam.

---

## Slide 2 — Contexto da Plataforma (`CONTEXTO_PLATAFORMA`)

**O que é:** constante de texto injetada em todos os prompts de churn. Funciona como "briefing fixo" da Mobiis para o modelo.

**Conteúdo:**

| Regra de negócio | Por que importa |
|---|---|
| Core = Cargas e Reservas | Queda no core é o sinal mais crítico de churn |
| API/Automação = lock-in técnico | Alto custo de saída atenua risco aparente |
| Queda de `usuarios_ativos` | Sinal precoce de abandono gradual de equipe |
| Ações negativas (cancel/delete) | Frustração ativa — mais urgente que inatividade passiva |
| Uso concentrado fora do core | Cliente sem engajamento real no produto |
| `taxa_diaria_anterior` = baseline real | Referência histórica para contextualizar ausências |

**Onde é usado:** injetado no início de `buildChurnPromptLote()`.

---

## Slide 3 — Score Determinístico (`calcularScoreDetalhado`)

**O que é:** cálculo de 0–100 feito em código, sem IA. Serve como **âncora** para o modelo — ele ajusta no máximo ±10 pontos.

**Parte dos 7 fatores e seus pesos máximos:**

| Fator | Penalidade máx | Bônus máx | Critério |
|---|---|---|---|
| Inatividade | −65 pts | — | Proporcional ao baseline histórico do cliente |
| Volume recente (30d) | −30 pts | — | Zero ações com histórico existente |
| Tendência de uso | −28 pts | +5 pts | Variação % vs média mensal dos 90d |
| Ações negativas | −22 pts | — | > 30% das ações são cancel/delete |
| Profundidade de equipe | −12 pts | +3 pts | Nenhum vs. 3+ usuários ativos |
| Engajamento no core | −12 pts | +5 pts | % de ações em Cargas/Reservas |
| Integração técnica | — | +8 pts | > 50% de ações via API/Automação |

**Saída:**
```typescript
{ score: number; breakdown: FatorScore[] }
// FatorScore = { fator, delta, descricao }
```

**Por que não usar só a IA?** O score determinístico é auditável, explicável e gratuito. A IA só corrige o que o cálculo não consegue capturar (sazonalidade, contexto CS, padrões atípicos).

---

## Slide 4 — Perfil Sugerido (`sugerirPerfil`)

**O que é:** classificação determinística do perfil de uso. O LLM confirma ou corrige.

| Perfil | Critério determinístico |
|---|---|
| `INATIVO` | > 30 dias sem atividade e zero ações em 30d |
| `AUTOMATIZADO` | > 50% das ações via API/Automação |
| `POWER_USER` | > 50 ações/30d, 2+ usuários, > 50% no core |
| `EM_DECLINIO` | Queda > 40% vs histórico com histórico relevante |
| `NOVO_ADOTANDO` | Histórico < 20 ações e sem queda |
| `ESPORADICO` | Taxa histórica < 0.15 ações/dia |
| `MODERADO` | Nenhum dos acima |

**Saída:** string com o perfil. Injetada no payload do prompt como `perfil_sugerido`.

---

## Slide 5 — Alertas Determinísticos (`gerarAlertas`)

**O que é:** geração de alertas sem IA, exibidos no endpoint `/relatorio/cliente/:id/parametros`.

**Três categorias:**

```
ERRO      → ação urgente recomendada
ATENCAO   → monitorar / investigar
MELHORIA  → oportunidade de expansão de uso
```

**Regras de disparo:**

| Tipo | Parâmetro | Gatilho |
|---|---|---|
| ERRO | `variacao_uso_pct` | Queda ≥ 50% vs baseline |
| ERRO | `pct_negativos` | > 20% das ações são negativas |
| ERRO | `pct_core` | Uso ativo mas zero ações no core |
| ERRO | `usuarios_ativos` | Zero usuários ativos |
| ATENCAO | `variacao_uso_pct` | Queda entre 25–49% |
| ATENCAO | `pct_negativos` | Entre 10–20% de ações negativas |
| ATENCAO | `pct_core` | > 10 ações mas < 20% no core |
| ATENCAO | `usuarios_ativos` | Apenas 1 usuário (key person risk) |
| ATENCAO | `score_ia` | IA ajustou o score em mais de ±5 pts |
| ATENCAO | `perfil_uso` | IA divergiu do perfil calculado |
| ATENCAO | `contexto_cs` | Cliente em risco ALTO/MEDIO sem contexto CS |
| MELHORIA | `pct_automatizado` | > 20 ações mas zero via API/Automação |
| MELHORIA | `usuarios_ativos` | ≤ 1 usuário com uso ativo |

---

## Slide 6 — Prompt de Churn em Lote (`buildChurnPromptLote`)

**O que é:** prompt principal da plataforma. Analisa N clientes em uma única chamada de IA.

**Estrutura do prompt:**

```
[Persona]
Analista especializado em padrão de comportamento SaaS B2B

[Contexto fixo]
CONTEXTO_PLATAFORMA (regras de negócio da Mobiis)

[Data de referência]
Data atual + posição no mês (para avaliar ausências sazonais)

[Instruções de análise — 5 passos]
1. Identifique o baseline histórico (taxa_diaria_anterior)
2. Compare comportamento recente vs. padrão esperado
3. Avalie qualidade do engajamento (core, automação, negativos)
4. Considere o contexto temporal (posição no mês/semana)
5. Classifique pelo padrão DO CLIENTE, não por regras genéricas

[Regras de saída obrigatórias]
- score_ia = âncora ± 10 pts
- Coerência score ↔ nível: ALTO=0-39, MEDIO=40-69, BAIXO=70-100
- perfil_uso: confirmar ou corrigir perfil_sugerido
- motivos: padrões comportamentais, nunca números isolados

[Contexto CS]
Tratado como informação privilegiada — nunca ignorado

[Payload]
JSON com todos os clientes do chunk + métricas derivadas

[Instrução de saída]
JSON array sem markdown, um objeto por cliente
```

**Output por cliente:**
```json
{
  "owner_id": "...",
  "nivel_risco": "ALTO|MEDIO|BAIXO|INDEFINIDO",
  "score_ia": 0-100,
  "perfil_uso": "POWER_USER|MODERADO|...",
  "padrao_historico": "1 frase do baseline",
  "resumo": "1 frase do comportamento atual",
  "motivos": ["padrão 1", "padrão 2"],
  "acao_recomendada": "ação específica"
}
```

**Métricas derivadas injetadas no payload (além das brutas do SQL):**

| Métrica | Fórmula |
|---|---|
| `taxa_diaria_30d` | `acoes_30d / 30` |
| `taxa_diaria_anterior` | `(acoes_90d - acoes_30d) / 60` |
| `variacao_uso_pct` | `((acoes_30d - media_mensal_90d) / media_mensal_90d) × 100` |
| `pct_negativos` | `acoes_negativas_30d / acoes_30d` |
| `pct_core` | `acoes_core_30d / acoes_30d` |
| `pct_automatizado` | `acoes_automatizadas_30d / acoes_30d` |
| `score_saude_base` | Score determinístico (slide 3) |
| `perfil_sugerido` | Perfil determinístico (slide 4) |

---

## Slide 7 — Prompt de Match CNAE (`buildMatchCnaePrompt`)

**O que é:** prompt para gerar um argumento de venda personalizado dado o CNAE de um prospect e os clientes similares já na base.

**Entrada:**
```
- cnae_fiscal + descricao do prospect
- cnaes_secundarios[]
- Lista de clients similares (EXATO ou DIVISAO)
  com: nome, UF, módulos em uso, saúde/score/perfil
- Estatísticas do segmento: módulos mais usados, presença por UF
```

**Estrutura do prompt:**

```
[Persona]
Consultor especializado em vendas B2B de TMS/YMS para logística

[Contexto da plataforma]
Core: Cargas e Reservas | Módulos complementares | Diferencial: API/Automação

[Prospect em análise]
CNAE principal + secundários

[Base de clientes similares]
EXATO: [lista com módulos, saúde, UF]
DIVISAO: [lista com módulos, saúde, UF]

[Estatísticas do segmento]
Módulos mais adotados + presença por estado

[Instrução contextual]
Se sem dados → analisar pelo CNAE/setor
Se com dados → usar padrões de adoção como evidência

[Instrução de saída]
JSON com 6 campos
```

**Output:**
```json
{
  "argumento_venda":      "2-3 frases de abertura para o primeiro contato",
  "diferenciais":         ["diferencial relevante para esse setor", "..."],
  "modulos_recomendados": ["módulo mais crítico para esse perfil", "..."],
  "abordagem_sugerida":   "como conduzir a descoberta com esse tipo de empresa",
  "oportunidades":        ["oportunidade específica para esse CNAE", "..."],
  "riscos_conhecidos":    ["objeção comum para esse perfil", "..."]
}
```

**Cache:** resultado salvo em SQLite por combinação de CNAEs. Invalidado se novos owners forem encontrados ou `?nocache=true`.
**HTTP:** `200` = processado pela IA agora | `203` = servido do cache (`de_cache: true`).

---

## Slide 8 — Fluxo Completo de Análise de Churn

```
SQL Server (90 dias)
        │
        ▼
  SQLite (cache diário)
        │
        ▼
  calcularParametrosRaw()          ← determinístico, gratuito
  ├── metricas_derivadas
  ├── score_saude_base (0-100)
  ├── perfil_sugerido
  └── score_breakdown (7 fatores)
        │
        ├──► Sem cache ──► buildChurnPromptLote()  ──► IA (chunk de 3)
        │                       │
        │                       ▼
        │                  AnaliseCliente
        │                  ├── nivel_risco
        │                  ├── score_ia (âncora ± 10)
        │                  ├── perfil_uso
        │                  ├── padrao_historico
        │                  ├── resumo
        │                  ├── motivos[]
        │                  └── acao_recomendada
        │
        └──► Com cache ──► retorna direto (zero tokens)

        ▼
  gerarAlertas()                   ← determinístico, gratuito
  └── ERRO / ATENCAO / MELHORIA

        ▼
  ClienteComAnalise (response final)
  ├── cliente    (métricas brutas SQL)
  ├── analise    (output da IA)
  ├── contexto   (texto CS)
  └── owner      (geo + módulos)
```

---

## Slide 9 — Custo e Volume de Tokens

| Operação | Tokens estimados | Frequência |
|---|---|---|
| Chunk de churn (3 clientes) | ~2.000–4.000 input + ~600 output | Por análise nova |
| Reprocessar 1 cliente | ~1.500–2.500 input + ~200 output | Por clique em "Reprocessar" |
| Match CNAE (insights de venda) | ~1.000–2.000 input + ~400 output | Por busca nova (cacheada) |
| Score determinístico | 0 tokens | Sempre |
| Alertas | 0 tokens | Sempre |
| Leitura de cache | 0 tokens | Sempre |

**Estratégias de economia:**
- Cache por hash dos dados — reanálise só quando os números mudarem
- Cache por combinação de CNAEs — match-cnae não chama IA na segunda vez
- Chunks de 3 com distribuição stripe — reduz viés por comparação entre clientes
- `temperature: 0` em todos os providers — respostas determinísticas, sem variação por retentativa
