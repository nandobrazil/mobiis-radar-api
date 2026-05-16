import { ClienteRisco } from '../clientes/clientes.types';
import { AnaliseCliente } from './ai.service';

export interface FatorScore {
  fator: string;
  delta: number;
  descricao: string;
}

export interface Alerta {
  tipo: 'ERRO' | 'ATENCAO' | 'MELHORIA';
  parametro: string;
  mensagem: string;
}

const CONTEXTO_PLATAFORMA = `
- Core do produto: Cargas e Reservas — entregam o valor principal; queda aqui é o sinal mais crítico
- Uso via API/Automação = integração técnica profunda = custo de saída alto = risco real menor
- Equipe encolhendo (queda de usuarios_ativos) é sinal precoce de abandono gradual
- Ações negativas (cancelamentos, exclusões, desativações) = frustração ativa — mais grave que inatividade passiva
- Uso concentrado fora do core (TabelaFrete, Acordo) = cliente sem engajamento real no valor do produto
- Volume alto de ações com pct_core caindo = cliente migrando o core para outro sistema, mantendo apenas periférico
- taxa_diaria_anterior é o baseline real do cliente — use-a para contextualizar qualquer ausência recente`.trim();

// ─── Score determinístico com breakdown ──────────────────────────────────────
function calcularScoreDetalhado(c: ClienteRisco, taxaDiariaAnterior: number): { score: number; breakdown: FatorScore[] } {
  const breakdown: FatorScore[] = [];
  let score = 100;

  // Inatividade — penalidade proporcional ao baseline histórico do cliente
  const pesoInatividade = taxaDiariaAnterior < 0.1 ? 0.4 : taxaDiariaAnterior < 0.5 ? 0.7 : 1.0;
  let deltaInatividade = 0;
  let descrInatividade = 'Ativo recentemente — sem penalidade';
  if (c.dias_sem_atividade > 60) {
    deltaInatividade = -Math.round(65 * pesoInatividade);
    descrInatividade = `${c.dias_sem_atividade}d sem atividade (> 60d), peso baseline ${pesoInatividade}`;
  } else if (c.dias_sem_atividade > 30) {
    deltaInatividade = -Math.round(45 * pesoInatividade);
    descrInatividade = `${c.dias_sem_atividade}d sem atividade (> 30d), peso baseline ${pesoInatividade}`;
  } else if (c.dias_sem_atividade > 15) {
    deltaInatividade = -Math.round(20 * pesoInatividade);
    descrInatividade = `${c.dias_sem_atividade}d sem atividade (> 15d), peso baseline ${pesoInatividade}`;
  } else if (c.dias_sem_atividade > 7) {
    deltaInatividade = -Math.round(8 * pesoInatividade);
    descrInatividade = `${c.dias_sem_atividade}d sem atividade (> 7d), peso baseline ${pesoInatividade}`;
  }
  score += deltaInatividade;
  breakdown.push({ fator: 'Inatividade', delta: deltaInatividade, descricao: descrInatividade });

  // Volume recente vs baseline histórico
  let deltaVolume = 0;
  let descrVolume = `${c.acoes_30d} ações em 30d — volume adequado`;
  if (c.acoes_30d === 0 && c.acoes_90d > 0) { deltaVolume = -30; descrVolume = 'Zero ações nos últimos 30d apesar de histórico existente'; }
  else if (c.acoes_30d < 5 && c.acoes_30d > 0) { deltaVolume = -18; descrVolume = `Apenas ${c.acoes_30d} ações em 30d — volume muito baixo`; }
  else if (c.acoes_30d < 20) { deltaVolume = -8; descrVolume = `${c.acoes_30d} ações em 30d — abaixo de 20`; }
  score += deltaVolume;
  breakdown.push({ fator: 'Volume recente (30d)', delta: deltaVolume, descricao: descrVolume });

  // Tendência: 30d vs média mensal dos 90d
  const mediaMensal90d = c.acoes_90d / 3;
  let deltaTendencia = 0;
  let descrTendencia = 'Histórico insuficiente para calcular tendência';
  if (mediaMensal90d > 2) {
    const variacao = (c.acoes_30d - mediaMensal90d) / mediaMensal90d;
    const varPct = Math.round(variacao * 100);
    if (variacao < -0.8) { deltaTendencia = -28; descrTendencia = `Queda de ${-varPct}% vs baseline mensal — colapso de uso`; }
    else if (variacao < -0.5) { deltaTendencia = -18; descrTendencia = `Queda de ${-varPct}% vs baseline mensal — queda significativa`; }
    else if (variacao < -0.2) { deltaTendencia = -8; descrTendencia = `Queda de ${-varPct}% vs baseline mensal — leve declínio`; }
    else if (variacao > 0.3) { deltaTendencia = 5; descrTendencia = `Crescimento de +${varPct}% vs baseline mensal`; }
    else { descrTendencia = `Variação de ${varPct}% vs baseline — estável`; }
  }
  score += deltaTendencia;
  breakdown.push({ fator: 'Tendência de uso', delta: deltaTendencia, descricao: descrTendencia });

  // Proporção de ações negativas
  let deltaNeg = 0;
  let descrNeg = 'Nenhuma ação negativa registrada';
  if (c.acoes_30d > 0) {
    const pctNeg = c.acoes_negativas_30d / c.acoes_30d;
    const pctNegPct = Math.round(pctNeg * 100);
    if (pctNeg > 0.3) { deltaNeg = -22; descrNeg = `${pctNegPct}% de ações negativas — frustração crítica (> 30%)`; }
    else if (pctNeg > 0.1) { deltaNeg = -10; descrNeg = `${pctNegPct}% de ações negativas — sinal de alerta (> 10%)`; }
    else if (pctNeg > 0) { deltaNeg = -4; descrNeg = `${pctNegPct}% de ações negativas — impacto leve`; }
    else { descrNeg = 'Nenhuma ação negativa — engajamento limpo'; }
  }
  score += deltaNeg;
  breakdown.push({ fator: 'Ações negativas', delta: deltaNeg, descricao: descrNeg });

  // Profundidade de equipe
  let deltaEquipe = 0;
  let descrEquipe = `${c.usuarios_ativos} usuários ativos — adequado`;
  if (c.usuarios_ativos === 0) { deltaEquipe = -12; descrEquipe = 'Nenhum usuário ativo — risco máximo de abandono'; }
  else if (c.usuarios_ativos === 1) { deltaEquipe = -2; descrEquipe = 'Usuário único — risco de key person dependency'; }
  else if (c.usuarios_ativos >= 3) { deltaEquipe = 3; descrEquipe = `${c.usuarios_ativos} usuários ativos — equipe saudável`; }
  score += deltaEquipe;
  breakdown.push({ fator: 'Profundidade de equipe', delta: deltaEquipe, descricao: descrEquipe });

  // Engajamento no core
  let deltaCore = 0;
  let descrCore = 'Sem ações no período — não aplicável';
  if (c.acoes_30d > 0) {
    const pctCore = c.acoes_core_30d / c.acoes_30d;
    const pctCorePct = Math.round(pctCore * 100);
    if (pctCore === 0) { deltaCore = -12; descrCore = 'Zero engajamento no core (Cargas/Reservas)'; }
    else if (pctCore < 0.3) { deltaCore = -6; descrCore = `${pctCorePct}% no core — uso concentrado em módulos periféricos`; }
    else if (pctCore > 0.7) { deltaCore = 5; descrCore = `${pctCorePct}% no core — excelente engajamento no produto principal`; }
    else { descrCore = `${pctCorePct}% no core — engajamento moderado`; }
  }
  score += deltaCore;
  breakdown.push({ fator: 'Engajamento no core', delta: deltaCore, descricao: descrCore });

  // Integração técnica (automação)
  let deltaAuto = 0;
  let descrAuto = 'Sem ações automatizadas — sem lock-in técnico';
  if (c.acoes_automatizadas_30d > 0) {
    const pctAuto = c.acoes_automatizadas_30d / Math.max(c.acoes_30d, 1);
    const pctAutoPct = Math.round(pctAuto * 100);
    if (pctAuto > 0.5) { deltaAuto = 8; descrAuto = `${pctAutoPct}% automatizado — integração profunda, custo de saída alto`; }
    else if (pctAuto > 0.2) { deltaAuto = 4; descrAuto = `${pctAutoPct}% automatizado — integração presente`; }
    else { descrAuto = `${pctAutoPct}% automatizado — integração marginal`; }
  }
  score += deltaAuto;
  breakdown.push({ fator: 'Integração técnica (automação)', delta: deltaAuto, descricao: descrAuto });

  return { score: Math.max(0, Math.min(100, Math.round(score))), breakdown };
}

function calcularScoreSaude(c: ClienteRisco, taxaDiariaAnterior: number): number {
  return calcularScoreDetalhado(c, taxaDiariaAnterior).score;
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

// ─── API pública: parâmetros expostos para o endpoint de transparência ────────
export function calcularParametrosRaw(c: ClienteRisco) {
  const acoes_periodo_anterior_60d = c.acoes_90d - c.acoes_30d;
  const taxa_diaria_30d = parseFloat((c.acoes_30d / 30).toFixed(2));
  const taxa_diaria_anterior = parseFloat((acoes_periodo_anterior_60d / 60).toFixed(2));
  const mediaMensal90d = c.acoes_90d / 3;
  const variacao_uso_pct = mediaMensal90d > 2
    ? Math.max(-100, Math.min(500, Math.round(((c.acoes_30d - mediaMensal90d) / mediaMensal90d) * 100)))
    : null;
  const pct_negativos = c.acoes_30d > 0 ? Math.round((c.acoes_negativas_30d / c.acoes_30d) * 100) : 0;
  const pct_core = c.acoes_30d > 0 ? Math.round((c.acoes_core_30d / c.acoes_30d) * 100) : 0;
  const pct_automatizado = c.acoes_30d > 0 ? Math.round((c.acoes_automatizadas_30d / c.acoes_30d) * 100) : 0;
  const { score: score_saude_base, breakdown: score_breakdown } = calcularScoreDetalhado(c, taxa_diaria_anterior);
  const perfil_sugerido = sugerirPerfil(c, variacao_uso_pct, pct_automatizado, taxa_diaria_anterior);

  return {
    metricas_derivadas: {
      acoes_periodo_anterior_60d,
      taxa_diaria_30d,
      taxa_diaria_anterior,
      variacao_uso_pct,
      pct_negativos,
      pct_core,
      pct_automatizado,
      score_saude_base,
      perfil_sugerido,
    },
    score_breakdown,
  };
}

export function gerarAlertas(
  c: ClienteRisco,
  derivadas: ReturnType<typeof calcularParametrosRaw>['metricas_derivadas'],
  analise: AnaliseCliente | null,
  temContexto: boolean,
): Alerta[] {
  const alertas: Alerta[] = [];

  // Divergência de perfil: IA corrigiu o cálculo determinístico
  if (analise && analise.perfil_uso !== derivadas.perfil_sugerido) {
    alertas.push({
      tipo: 'ATENCAO',
      parametro: 'perfil_uso',
      mensagem: `IA classificou como "${analise.perfil_uso}" mas o cálculo determinístico sugeria "${derivadas.perfil_sugerido}". Revise se faz sentido para este cliente.`,
    });
  }

  // Ajuste grande de score pela IA
  if (analise) {
    const ajuste = analise.score_ia - derivadas.score_saude_base;
    if (Math.abs(ajuste) > 5) {
      const sinal = ajuste > 0 ? '+' : '';
      alertas.push({
        tipo: 'ATENCAO',
        parametro: 'score_ia',
        mensagem: `IA ajustou o score em ${sinal}${ajuste} pontos (base determinística: ${derivadas.score_saude_base} → score IA: ${analise.score_ia}). Se o ajuste parecer incorreto, adicione um contexto CS para guiar a análise.`,
      });
    }
  }

  // Queda acentuada no uso
  if (derivadas.variacao_uso_pct !== null && derivadas.variacao_uso_pct <= -50) {
    alertas.push({
      tipo: 'ERRO',
      parametro: 'variacao_uso_pct',
      mensagem: `Queda de ${-derivadas.variacao_uso_pct}% no uso vs baseline histórico — declínio acentuado. Investigar motivo imediatamente.`,
    });
  } else if (derivadas.variacao_uso_pct !== null && derivadas.variacao_uso_pct <= -25) {
    alertas.push({
      tipo: 'ATENCAO',
      parametro: 'variacao_uso_pct',
      mensagem: `Queda de ${-derivadas.variacao_uso_pct}% no uso vs baseline — monitorar tendência nas próximas semanas.`,
    });
  }

  // Ações negativas elevadas
  if (derivadas.pct_negativos > 20) {
    alertas.push({
      tipo: 'ERRO',
      parametro: 'pct_negativos',
      mensagem: `${derivadas.pct_negativos}% das ações nos últimos 30d são negativas (cancelamentos/exclusões). Contato urgente recomendado.`,
    });
  } else if (derivadas.pct_negativos > 10) {
    alertas.push({
      tipo: 'ATENCAO',
      parametro: 'pct_negativos',
      mensagem: `${derivadas.pct_negativos}% das ações são negativas — volume acima do esperado, monitorar evolução.`,
    });
  }

  // Zero engajamento no core
  if (c.acoes_30d > 0 && derivadas.pct_core === 0) {
    alertas.push({
      tipo: 'ERRO',
      parametro: 'pct_core',
      mensagem: 'Nenhuma ação no core do produto (Cargas/Reservas) nos últimos 30d. Cliente pode estar usando periférico sem real adoção — risco de migração para outro sistema.',
    });
  } else if (c.acoes_30d > 10 && derivadas.pct_core < 20) {
    alertas.push({
      tipo: 'ATENCAO',
      parametro: 'pct_core',
      mensagem: `Apenas ${derivadas.pct_core}% das ações no core — uso concentrado em módulos periféricos. Verificar se está migrando o core para outro sistema.`,
    });
  }

  // Nenhum usuário ativo
  if (c.usuarios_ativos === 0) {
    alertas.push({
      tipo: 'ERRO',
      parametro: 'usuarios_ativos',
      mensagem: 'Nenhum usuário ativo nos últimos 30d. Verificar se o cliente ainda tem acesso ativo e se há bloqueio de conta.',
    });
  } else if (c.usuarios_ativos === 1) {
    alertas.push({
      tipo: 'ATENCAO',
      parametro: 'usuarios_ativos',
      mensagem: 'Apenas 1 usuário ativo — key person dependency. Se esse usuário sair da empresa, o cliente some junto.',
    });
  }

  // Cliente em risco sem contexto CS
  if (!temContexto && analise && (analise.nivel_risco === 'ALTO' || analise.nivel_risco === 'MEDIO')) {
    alertas.push({
      tipo: 'ATENCAO',
      parametro: 'contexto_cs',
      mensagem: `Cliente com risco ${analise.nivel_risco} sem contexto CS registrado. Adicione observações via POST /relatorio/cliente/:id/contexto para melhorar a precisão da análise.`,
    });
  }

  // Melhorias possíveis
  if (derivadas.pct_automatizado === 0 && c.acoes_30d > 20) {
    alertas.push({
      tipo: 'MELHORIA',
      parametro: 'pct_automatizado',
      mensagem: 'Cliente sem integração técnica (API/automação). Apresentar recursos de automação pode aumentar o lock-in e reduzir risco de churn.',
    });
  }
  if (c.usuarios_ativos <= 1 && c.acoes_30d > 5) {
    alertas.push({
      tipo: 'MELHORIA',
      parametro: 'usuarios_ativos',
      mensagem: 'Incentivar expansão de usuários na conta — mais usuários = maior stickiness e menor risco de abandono.',
    });
  }

  return alertas;
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
export function buildChurnPromptLote(
  clientes: ClienteRisco[],
  contextos: Map<string, string> = new Map(),
): string {
  const payload = clientes.map(c => {
    const base = {
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
    };
    const ctx = contextos.get(c.owner_id);
    return ctx ? { ...base, contexto_cs: ctx } : base;
  });

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

## Contexto do CS (quando presente)
Alguns clientes têm um campo contexto_cs — texto escrito pelo time interno de Customer Success explicando situações específicas daquele cliente: sazonalidade, mudanças internas, motivo de queda de uso, negociação em andamento, etc.
- Trate esse campo como informação privilegiada de quem acompanha o cliente de perto
- Use para interpretar os números de forma mais precisa (ex: "queda esperada pois cliente está em onboarding de novo módulo")
- Quando o contexto contradisser o sinal dos dados, justifique explicitamente no resumo
- Nunca ignore o contexto_cs — ele sempre enriquece a análise

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
