import { ClienteRisco } from '../clientes/clientes.types';

const CONTEXTO_PLATAFORMA = `
- Core do produto: Cargas e Reservas — entregam o valor principal; queda aqui é o sinal mais crítico
- Uso via API/Automação = integração técnica profunda = custo de saída alto = risco real menor
- Equipe encolhendo (queda de usuarios_ativos) é sinal precoce de abandono gradual
- Ações negativas (cancelamentos, exclusões, desativações) = frustração ativa — mais grave que inatividade passiva
- Uso concentrado fora do core (TabelaFrete, Acordo) = cliente sem engajamento real no valor do produto
- Volume alto de ações com pct_core caindo = cliente migrando o core para outro sistema, mantendo apenas periférico
- taxa_diaria_anterior é o baseline real do cliente — use-a para contextualizar qualquer ausência recente`.trim();

// ─── Score determinístico (âncora para o LLM) ────────────────────────────────
// O LLM recebe esse score e pode ajustar ±10 com base em padrões identificados.
// Representa saúde: 0 = churn iminente, 100 = muito saudável.
function calcularScoreSaude(c: ClienteRisco, taxaDiariaAnterior: number): number {
  let score = 100;

  // Inatividade — penalidade proporcional ao baseline histórico do cliente
  if (c.dias_sem_atividade > 0) {
    // Se o cliente nunca foi muito ativo (baixo baseline), ausência pesa menos
    const pesoInatividade = taxaDiariaAnterior < 0.1 ? 0.4 : taxaDiariaAnterior < 0.5 ? 0.7 : 1.0;
    if (c.dias_sem_atividade > 60) score -= Math.round(65 * pesoInatividade);
    else if (c.dias_sem_atividade > 30) score -= Math.round(45 * pesoInatividade);
    else if (c.dias_sem_atividade > 15) score -= Math.round(20 * pesoInatividade);
    else if (c.dias_sem_atividade > 7) score -= Math.round(8 * pesoInatividade);
  }

  // Volume recente vs baseline histórico
  if (c.acoes_30d === 0 && c.acoes_90d > 0) score -= 30;
  else if (c.acoes_30d < 5 && c.acoes_30d > 0) score -= 18;
  else if (c.acoes_30d < 20) score -= 8;

  // Tendência: 30d vs média mensal dos 90d
  const mediaMensal90d = c.acoes_90d / 3;
  if (mediaMensal90d > 2) {
    const variacao = (c.acoes_30d - mediaMensal90d) / mediaMensal90d;
    if (variacao < -0.8) score -= 28;
    else if (variacao < -0.5) score -= 18;
    else if (variacao < -0.2) score -= 8;
    else if (variacao > 0.3) score += 5;
  }

  // Proporção de ações negativas
  if (c.acoes_30d > 0) {
    const pctNeg = c.acoes_negativas_30d / c.acoes_30d;
    if (pctNeg > 0.3) score -= 22;
    else if (pctNeg > 0.1) score -= 10;
    else if (pctNeg > 0) score -= 4;
  }

  // Profundidade de equipe
  if (c.usuarios_ativos === 0) score -= 12;
  else if (c.usuarios_ativos === 1) score -= 2;
  else if (c.usuarios_ativos >= 3) score += 3;

  // Engajamento no core
  if (c.acoes_30d > 0) {
    const pctCore = c.acoes_core_30d / c.acoes_30d;
    if (pctCore === 0) score -= 12;
    else if (pctCore < 0.3) score -= 6;
    else if (pctCore > 0.7) score += 5;
  }

  // Bônus por integração técnica (automação = custo de saída alto)
  if (c.acoes_automatizadas_30d > 0) {
    const pctAuto = c.acoes_automatizadas_30d / Math.max(c.acoes_30d, 1);
    if (pctAuto > 0.5) score += 8;
    else if (pctAuto > 0.2) score += 4;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─── Perfil sugerido deterministicamente (o LLM confirma ou corrige) ─────────
function sugerirPerfil(
  c: ClienteRisco,
  variacaoUsoPct: number | null,
  pctAuto: number,
  taxaDiariaAnterior: number,
): string {
  if (c.dias_sem_atividade > 30 && c.acoes_30d === 0) return 'INATIVO';
  if (pctAuto > 50) return 'AUTOMATIZADO';
  if (c.acoes_30d > 50 && c.usuarios_ativos >= 2 && c.acoes_core_30d / Math.max(c.acoes_30d, 1) > 0.5) return 'POWER_USER';
  if (variacaoUsoPct !== null && variacaoUsoPct < -40 && c.acoes_90d > 10) return 'EM_DECLINIO';
  if (c.acoes_90d < 20 && (variacaoUsoPct === null || variacaoUsoPct >= 0)) return 'NOVO_ADOTANDO';
  if (taxaDiariaAnterior < 0.15 && c.acoes_30d > 0) return 'ESPORADICO';
  return 'MODERADO';
}

// ─── Métricas derivadas para o payload ───────────────────────────────────────
function calcularMetricas(c: ClienteRisco) {
  const acoes_periodo_anterior_60d = c.acoes_90d - c.acoes_30d;

  // Taxas diárias — permitem comparar intensidade sem depender de volume absoluto
  const taxa_diaria_30d = parseFloat((c.acoes_30d / 30).toFixed(2));
  const taxa_diaria_anterior = parseFloat((acoes_periodo_anterior_60d / 60).toFixed(2));

  // variacao_uso_pct: positivo = crescimento vs baseline, negativo = queda, null = sem baseline
  const mediaMensal90d = c.acoes_90d / 3;
  const variacao_uso_pct = mediaMensal90d > 2
    ? Math.max(-100, Math.min(500, Math.round(((c.acoes_30d - mediaMensal90d) / mediaMensal90d) * 100)))
    : null;

  const pct_negativos = c.acoes_30d > 0
    ? Math.round((c.acoes_negativas_30d / c.acoes_30d) * 100)
    : 0;

  const pct_core = c.acoes_30d > 0
    ? Math.round((c.acoes_core_30d / c.acoes_30d) * 100)
    : 0;

  const pct_automatizado = c.acoes_30d > 0
    ? Math.round((c.acoes_automatizadas_30d / c.acoes_30d) * 100)
    : 0;

  const score_saude_base = calcularScoreSaude(c, taxa_diaria_anterior);
  const perfil_sugerido = sugerirPerfil(c, variacao_uso_pct, pct_automatizado, taxa_diaria_anterior);

  return {
    acoes_periodo_anterior_60d,
    taxa_diaria_30d,
    taxa_diaria_anterior,
    variacao_uso_pct,
    pct_negativos,
    pct_core,
    pct_automatizado,
    score_saude_base,
    perfil_sugerido,
  };
}

function contextoCalendario(): string {
  const hoje = new Date();
  const diaDoMes = hoje.getDate();
  const diasNoMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0).getDate();
  const diasRestantes = diasNoMes - diaDoMes;
  const dataStr = hoje.toLocaleDateString('pt-BR', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
  });
  return `${dataStr} — dia ${diaDoMes}/${diasNoMes}, faltam ${diasRestantes} dias para o fim do mês`;
}

// ─── Prompt principal ─────────────────────────────────────────────────────────
export function buildChurnPromptLote(clientes: ClienteRisco[]): string {
  const payload = clientes.map(c => ({
    owner_id: c.owner_id,
    nome: c.nome_cliente,
    dias_sem_atividade: c.dias_sem_atividade,
    acoes_90d: c.acoes_90d,
    acoes_30d: c.acoes_30d,
    acoes_core_30d: c.acoes_core_30d,
    acoes_core_90d: c.acoes_core_90d,
    acoes_negativas_30d: c.acoes_negativas_30d,
    entidades_utilizadas: c.entidades_utilizadas,
    usuarios_ativos: c.usuarios_ativos,
    acoes_automatizadas_30d: c.acoes_automatizadas_30d,
    ...calcularMetricas(c),
  }));

  return `Você é analista especializado em padrão de comportamento de clientes SaaS B2B, com foco em detecção antecipada de churn.

## Plataforma: Fretefy (TMS/YMS)
${CONTEXTO_PLATAFORMA}

## Data de referência
Hoje: ${contextoCalendario()}
Considere esta informação ao avaliar ausências — clientes com padrão mensal ou quinzenal podem ter inatividade esperada dependendo de onde estamos no calendário.

## Como analisar cada cliente

**1. Identifique o padrão histórico (baseline)**
Use taxa_diaria_anterior (dias 31–90) como referência do comportamento histórico real:
- taxa_diaria_anterior < 0.1 → padrão esporádico (usa algumas vezes por mês, ausências são normais)
- taxa_diaria_anterior 0.1–0.5 → padrão semanal (usa algumas vezes por semana)
- taxa_diaria_anterior > 0.5 → padrão regular/intenso (usa praticamente todo dia)
Use acoes_periodo_anterior_60d para confirmar se o histórico é consistente ou irregular.

**2. Compare o comportamento recente com o padrão esperado**
- taxa_diaria_30d vs taxa_diaria_anterior: houve mudança real de intensidade?
- variacao_uso_pct: positivo = crescimento, negativo = queda vs baseline. null = sem baseline (cliente novo)
- A ausência atual (dias_sem_atividade) é anômala PARA ESSE CLIENTE? Um cliente com taxa 0.05/dia com 15 dias inativo está dentro do padrão. Um com taxa 2.0/dia com 7 dias inativo não está.

**3. Avalie a qualidade do engajamento**
- pct_core alto: cliente usa o produto para o que ele foi feito
- pct_automatizado > 20: integração técnica presente — custo de saída é alto, atenua risco aparente
- pct_negativos elevado: frustração ativa, mais urgente que inatividade passiva
- Queda de usuarios_ativos entre períodos: sinal de abandono gradual de equipe

**4. Considere o contexto temporal**
Em que ponto do mês/semana estamos? Clientes com padrão concentrado (ex: fechamento de mês) podem ter ausência natural no período atual.

**5. Classifique pelo padrão do cliente, não por regras genéricas**
- ALTO: quebra clara de padrão consistente, sem explicação pelo comportamento histórico
- MEDIO: enfraquecimento gradual, inconsistência crescente ou sinais de migração parcial
- BAIXO: comportamento dentro do padrão esperado para esse perfil
- INDEFINIDO: histórico insuficiente (acoes_90d < 5) ou irregular demais para traçar padrão confiável

## Regras obrigatórias de saída

**score_ia** = saúde do cliente (0 = churn iminente, 100 = saudável)
- Use score_saude_base como âncora; ajuste no máximo ±10 pontos com base nos padrões identificados
- Coerência obrigatória: ALTO = 0–39 | MEDIO = 40–69 | BAIXO = 70–100 | INDEFINIDO = 30–60

**perfil_uso** — confirme ou corrija perfil_sugerido. Valores aceitos:
POWER_USER | MODERADO | AUTOMATIZADO | ESPORADICO | EM_DECLINIO | NOVO_ADOTANDO | INATIVO

**padrao_historico** — 1 frase descrevendo o padrão de uso identificado no baseline (dias 31–90)
Exemplo: "Uso regular intenso (~3 ações/dia) com equipe de 4 usuários ativos no core"
Exemplo: "Padrão esporádico com 2–3 ações semanais concentradas em Cargas"

**motivos** — padrões comportamentais identificados, NÃO números isolados
✓ "Padrão regular sem quebra detectada — ausência atual dentro do esperado"
✓ "Integração API ativa eleva custo de saída, mitigando o risco aparente de declínio"
✓ "Queda progressiva no uso do core sugere migração parcial para outro sistema"
✓ "Usuário único concentra risco — saída de uma pessoa = abandono total"
✗ "60 dias sem atividade" — já está nos dados, não acrescenta análise

**resumo** — 1 frase descrevendo o comportamento e o risco considerando o perfil desse cliente específico

## O que NÃO fazer
- Não aplique "sem uso há X dias = risco Y" de forma genérica
- Não compare um cliente com outros — analise cada um pelo seu próprio histórico
- Não classifique como risco um cliente cujo padrão natural é uso esporádico
- Não ignore o contexto de integração técnica ao avaliar ausências curtas

CLIENTES (${clientes.length}):
${JSON.stringify(payload)}

Retorne APENAS JSON array válido, sem markdown. Um objeto por cliente na mesma ordem do input:
[{"owner_id":"<mesmo do input>","nivel_risco":"ALTO"|"MEDIO"|"BAIXO"|"INDEFINIDO","score_ia":<0-100>,"perfil_uso":"<perfil>","padrao_historico":"<1 frase>","resumo":"<1 frase>","motivos":["<padrão 1>","<padrão 2>"],"acao_recomendada":"<ação específica para o perfil>"}]

Retorne TODOS os ${clientes.length} clientes.`;
}
