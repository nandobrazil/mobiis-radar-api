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

  return `Você é analista sênior de CS da Fretefy (TMS/YMS). Determine o risco de churn de cada cliente abaixo.

${CONTEXTO}

CLIENTES (${clientes.length}):
${JSON.stringify(payload)}

Retorne APENAS JSON array válido, sem markdown. Um objeto por cliente:
[{"owner_id":"<mesmo do input>","nivel_risco":"ALTO"|"MEDIO"|"BAIXO","score_ia":<0-100>,"resumo":"<1 frase curta>","motivos":["<motivo 1>","<motivo 2>"],"acao_recomendada":"<1 ação curta>"}]

ALTO=urgente, MEDIO=alerta, BAIXO=saudável. Baseie-se exclusivamente nos dados. Retorne TODOS os ${clientes.length} clientes.`;
}
