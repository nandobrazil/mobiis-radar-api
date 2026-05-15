import { ClienteRisco } from '../clientes/clientes.types';

const CONTEXTO = `CONTEXTO DA PLATAFORMA Fretefy (TMS/YMS)
- Core do produto: Cargas e Reservas — principal indicador de valor entregue
- Clientes inativos >30 dias raramente retornam sem intervenção ativa do CS
- Ações negativas = cancelamentos, exclusões, desativações
- Queda em automação/API pode sinalizar migração técnica para concorrente
- Poucos usuários ativos + queda no core = abandono gradual da equipe
- Muitas ações mas maioria negativa = risco maior do que inatividade simples
- Uso concentrado fora do core = cliente sem engajamento real na plataforma`;

function metricas(c: ClienteRisco) {
  const queda_uso_pct = c.acoes_90d > 0
    ? Math.round((1 - c.acoes_30d / (c.acoes_90d / 3)) * 100)
    : 100;
  const pct_negativos = c.acoes_30d > 0
    ? Math.round((c.acoes_negativas_30d / c.acoes_30d) * 100)
    : 0;
  const pct_core = c.acoes_30d > 0
    ? Math.round((c.acoes_core_30d / c.acoes_30d) * 100)
    : 0;
  return { queda_uso_pct, pct_negativos, pct_core };
}

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
    ...metricas(c),
  }));

  return `Você é um analista sênior de Customer Success da Fretefy, plataforma de gestão logística TMS/YMS.
Analise a lista de clientes abaixo e determine o risco de churn de cada um. Você é o motor de decisão — não há score pré-calculado.

${CONTEXTO}

CLIENTES (${clientes.length}):
${JSON.stringify(payload, null, 2)}

Retorne APENAS um JSON array válido, sem markdown, sem texto adicional.
Um objeto por cliente, preservando o owner_id exato do input:
[
  {
    "owner_id": "<mesmo owner_id do input>",
    "nivel_risco": "ALTO" | "MEDIO" | "BAIXO",
    "score_ia": <inteiro 0–100, 100 = churn iminente>,
    "resumo": "<1 frase descrevendo a situação>",
    "motivos": ["<motivo 1>", "<motivo 2>"],
    "acao_recomendada": "<1 ação concreta para o CS nas próximas 48h>"
  }
]

Definições: ALTO=intervenção urgente, MEDIO=alerta/acompanhamento, BAIXO=saudável.
Baseie-se exclusivamente nos dados fornecidos.`;
}
