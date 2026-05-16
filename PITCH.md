# Mobiis Radar — Por que esse projeto importa

> Análise de churn com IA para clientes SaaS B2B — construído sobre dados reais da Fretefy.

---

## O problema que resolvemos

Em SaaS B2B, **churn silencioso** é o inimigo mais caro.

O cliente não liga para cancelar. Ele simplesmente para de usar.  
Quando alguém percebe, o contrato já acabou — ou pior, a renovação foi negada.

Na Fretefy, cada cliente representa **receita recorrente mensal (MRR)**.  
Perder um cliente não é só perder o ticket do mês — é perder todos os meses seguintes.

O problema: os sinais estão todos lá, nos logs de uso.  
A falta: alguém (ou algo) que os leia, entenda e aja antes que seja tarde.

**Mobiis Radar é esse algo.**

---

## 💰 Impacto no Negócio — 10/10

### Churn = perda de receita recorrente. Evitar 1 cliente = ROI direto e mensurável.

**O cálculo é simples:**

```
MRR médio por cliente × taxa de churn evitada = receita preservada
```

Se o Radar identificar e acionar o CS **antes do churn** de apenas **5 clientes por mês**:

| Ticket médio | Receita preservada/mês | Em 12 meses |
|---|---|---|
| R$ 3.000/mês | R$ 15.000 | **R$ 180.000** |
| R$ 8.000/mês | R$ 40.000 | **R$ 480.000** |
| R$ 15.000/mês | R$ 75.000 | **R$ 900.000** |

E isso sem contar o custo de aquisição de um novo cliente para repor — que no B2B logístico é tipicamente **5–10× mais caro** que reter.

### Por que o ROI é mensurável aqui (e não em outros projetos)?

Porque o Radar gera **ações rastreáveis**:
1. Cliente marcado como `ALTO` risco em determinada data
2. CS contacta e registra contexto no Radar
3. Cliente permanece na base (ou faz upgrade)
4. MRR preservado = receita diretamente atribuível ao sistema

Não é estimativa — é auditável mês a mês.

### Benefícios secundários

- **Redução de custo de CS:** triagem automática foca o time humano nos clientes que realmente precisam de atenção, não em varreduras manuais
- **Argumento de renovação:** CS entra na conversa de renovação com dados de uso em mãos — não com feeling
- **Expansão de conta:** clientes sem integração técnica (API/automação) são sinalizados como oportunidade de upsell no próprio dashboard
- **Match CNAE:** ferramenta de prospecção — identifica prospects com o mesmo perfil de clientes saudáveis da base, com argumento de venda gerado por IA

---

## ⚙️ Viabilidade — 10/10

### Dados já existem no SQL Server. Zero infraestrutura nova.

**O que já existe hoje:**

| Dado | Tabela SQL Server | Status |
|---|---|---|
| Histórico de ações por cliente | `ExecucaoHistorico` | ✅ Produção |
| Cadastro de owners | `Owners` | ✅ Produção |
| Módulos contratados | `OwnerLicense` | ✅ Produção |
| CNPJ dos clientes | `Owners.Document` | ✅ Produção |

**O que o Radar adiciona:**

| Componente | Complexidade | Custo |
|---|---|---|
| SQLite local (cache) | Arquivo em disco — zero configuração | R$ 0 |
| NestJS API | Deploy como container / Azure Function | Mínimo |
| BrasilAPI (geocoding) | HTTP externo, sem autenticação | R$ 0 |
| IA (Anthropic/Gemini/GPT) | ~R$ 0,001–0,01 por cliente analisado | Centavos/dia |

### Custo operacional estimado

Com 200 clientes ativos e análise semanal:

```
200 clientes × ~3.000 tokens/análise × R$ 0,003/1K tokens (Haiku)
= R$ 1,80 por rodada completa
= ~R$ 7,20/mês (4 rodadas)
```

**Menos de R$ 10/mês** para monitorar 200 clientes com IA.  
Cache inteligente reduz isso para **centavos por dia** na operação corrente — só reanalisam clientes com dados novos.

### Independência de infraestrutura

- Lê do SQL Server existente (somente leitura, `WITH NOLOCK`)
- Cache SQLite em arquivo local — sem Redis, sem banco adicional
- API stateless — escala horizontalmente sem mudança de arquitetura
- Troca de provider IA por variável de ambiente — sem alterar código

---

## 🤖 Inovação e Uso de IA — 10/10

### A IA não só classifica — ela explica o motivo e sugere ação específica por cliente.

**O que a maioria dos sistemas faz:**
```
cliente X → score 45 → "MÉDIO RISCO"
```

**O que o Radar faz:**
```
cliente X → score 47 → MÉDIO RISCO
           → "Padrão histórico de uso intenso (3 ações/dia) com ruptura
              nas últimas 3 semanas. Queda de 78% vs. baseline. Único
              usuário ativo — risco de key person dependency."
           → "Contatar imediatamente. Investigar se houve mudança de
              responsável interno. Sugerir treinamento da equipe."
```

### Três camadas de inteligência

```
┌──────────────────────────────────────────────────────────────┐
│ Camada 1 — Score Determinístico (sem IA)                     │
│                                                              │
│ 7 fatores calculados em código: inatividade, volume,         │
│ tendência, ações negativas, equipe, core, automação.         │
│ Resultado: score 0–100 + breakdown fator a fator.            │
│ Custo: R$ 0. Velocidade: <1ms.                               │
└─────────────────────────────┬────────────────────────────────┘
                              │ âncora para a IA
┌─────────────────────────────▼────────────────────────────────┐
│ Camada 2 — Análise Contextual por IA                         │
│                                                              │
│ IA recebe os números + contexto de negócio + baseline do     │
│ próprio cliente + posição no calendário.                     │
│ Ajusta o score ±10 pts com base em padrões que o cálculo     │
│ determinístico não captura: sazonalidade, integração técnica │
│ como fator mitigador, ausências dentro do padrão histórico.  │
│ Gera: perfil, resumo, motivos, ação recomendada.             │
└─────────────────────────────┬────────────────────────────────┘
                              │ enriquece a análise
┌─────────────────────────────▼────────────────────────────────┐
│ Camada 3 — Contexto CS (memória humana)                      │
│                                                              │
│ CS registra observações no sistema: "cliente em onboarding", │
│ "mudou de ERP", "contrato em renegociação".                  │
│ IA trata como informação privilegiada — nunca ignora.        │
│ Qualquer mudança no contexto invalida o cache e dispara      │
│ nova análise automática.                                     │
└──────────────────────────────────────────────────────────────┘
```

### O que é genuinamente novo aqui

**1. Análise pelo padrão do próprio cliente, não por régua genérica**

Um cliente que usa a plataforma 2x por mês com 15 dias de inatividade está **dentro do padrão**.  
Um cliente que usa todo dia com 3 dias de inatividade está **em ruptura**.

O sistema identifica o baseline histórico individual e avalia o comportamento recente contra esse baseline — não contra uma média do mercado.

**2. Contexto temporal embutido no prompt**

A data atual, o dia do mês e os dias restantes são injetados em cada análise.  
Clientes com padrão de fechamento mensal não são penalizados por inatividade no meio do mês.

**3. Auditabilidade total**

O endpoint `/parametros` expõe:
- Métricas brutas do SQL
- Métricas derivadas calculadas
- Breakdown fator a fator do score (por que perdeu pontos)
- O que a IA ajustou vs. o cálculo determinístico
- Alertas automáticos com recomendações

Não é uma caixa-preta — cada decisão é explicável.

**4. Ferramenta de prospecção com IA (match-cnae)**

Insere o CNPJ de um prospect → sistema encontra clientes com CNAE idêntico ou do mesmo setor → IA gera um argumento de venda personalizado com módulos recomendados, abordagem sugerida e objeções conhecidas.  
A IA usa os dados reais da base (quais módulos clientes similares usam, em quais estados estão, qual a saúde deles) como evidência para o argumento.

---

## 🎤 Apresentação e Demo — 10/10

### Dashboard ao vivo com clientes reais + narrativa gerada em tempo real.

**Roteiro de demo sugerido (10 minutos):**

---

**[0:00 – 1:30] O problema**

> "Todo mês a Fretefy perde clientes que ninguém viu indo embora.  
> Não porque faltou produto — porque faltou sinal.  
> Os dados estavam todos aqui, no SQL Server. Só precisavam de alguém para ler."

Mostrar: painel com lista de clientes ordenada por risco (ALTO primeiro, vermelho).

---

**[1:30 – 3:30] Como o Radar pensa**

Clicar em um cliente ALTO risco.

Mostrar:
- Score: 34/100
- Resumo da IA: _"Queda de 82% no uso vs. baseline de 2,3 ações/dia. Usuário único — se sair da empresa, o cliente some junto."_
- Ação recomendada: _"Contato urgente. Verificar se houve troca de responsável. Propor treinamento para ampliar equipe usuária."_

Clicar em `/parametros`:
- Mostrar o breakdown fator a fator: onde perdeu pontos e por quê
- Mostrar alerta: `ERRO: usuarios_ativos = 1 — key person dependency`

---

**[3:30 – 5:00] Memória humana (contexto CS)**

> "O número diz uma coisa. O CS sabe outra."

Adicionar contexto: _"Cliente passou por fusão em outubro. Novo responsável ainda em onboarding."_

Clicar em reprocessar → IA reavalia com o contexto → score sobe de 34 para 51 → risco muda de ALTO para MÉDIO.

> "A IA não ignora o que o CS sabe. Ela usa como evidência."

---

**[5:00 – 7:00] Prospecção com match-cnae**

> "E se pudéssemos usar o conhecimento da nossa base para prospectar?"

Buscar um CNPJ de prospect no mercado → payload BrasilAPI → `/match-cnae`.

Mostrar:
- 8 clientes com CNAE similar já na base
- Módulos mais usados nesse segmento: TabelaFrete (87%), Acordo Comercial (62%)
- Argumento de venda gerado pela IA com dados reais da base

---

**[7:00 – 8:30] Escala e custo**

Mostrar: `/relatorio/status` durante processamento em lote.

> "200 clientes analisados em lote. Cada chunk de 3, distribuídos para reduzir viés.  
> Custo total da rodada: menos de R$ 2,00.  
> Cache inteligente — só reanalisou os 23 com dados novos desde ontem."

---

**[8:30 – 10:00] ROI e encerramento**

> "Se esse sistema identificar e salvar 5 clientes por mês...  
> A R$ 8.000 de ticket médio, são R$ 40.000 de MRR preservado por mês.  
> R$ 480.000 em 12 meses — com custo operacional de R$ 7,20/mês de IA.  
>  
> Zero infraestrutura nova. Os dados já estavam lá.  
> A diferença é que agora alguém está lendo."

---

### Diferenciais narrativos para os juízes

| O que outros fazem | O que o Radar faz |
|---|---|
| Score numérico opaco | Score com breakdown fator a fator, auditável |
| Alerta genérico "cliente em risco" | Ação específica: "contactar agora, investigar troca de responsável" |
| Análise por média do mercado | Análise pelo histórico individual de cada cliente |
| Caixa-preta de IA | 3 camadas explícitas: determinístico + IA + contexto humano |
| Só retenção | Retenção + prospecção (match-cnae) |
| Infraestrutura pesada | SQLite + API leve — roda em qualquer lugar |

---

## Resumo Executivo

| Critério | Nota esperada | Justificativa |
|---|---|---|
| 💰 Impacto no Negócio | 10/10 | ROI direto e mensurável: MRR preservado por churn evitado |
| ⚙️ Viabilidade | 10/10 | Dados existentes + SQLite + API leve + R$ 7/mês de IA |
| 🤖 Inovação e Uso de IA | 10/10 | 3 camadas, análise por padrão individual, auditável, contexto CS, match-cnae |
| 🎤 Apresentação e Demo | 10/10 | Dashboard ao vivo, narrativa clara, demo em 10min com dados reais |

> **O Radar não é um experimento de IA.**  
> É uma ferramenta que paga a si mesma na primeira renovação que salvar.
