import { ClienteRisco } from '../clientes/clientes.types';

export function buildChurnPrompt(cliente: ClienteRisco): string {
  const queda_uso = cliente.acoes_90d > 0
    ? Math.round((1 - cliente.acoes_30d / (cliente.acoes_90d / 3)) * 100)
    : 100;

  const proporcao_negativos = cliente.acoes_30d > 0
    ? Math.round((cliente.acoes_negativas_30d / cliente.acoes_30d) * 100)
    : 0;

  const proporcao_core_30d = cliente.acoes_30d > 0
    ? Math.round((cliente.acoes_core_30d / cliente.acoes_30d) * 100)
    : 0;

  return `Você é um analista sênior de Customer Success da Fretefy, plataforma de gestão logística e TMS/YMS.

Sua tarefa é analisar os dados brutos de comportamento do cliente abaixo e determinar, com seu próprio raciocínio, o risco de churn. Não existe score pré-calculado — você é o motor de decisão.

CONTEXTO DA PLATAFORMA
- Clientes usam a Fretefy para gestão de cargas, reservas, tabelas de frete, acordos e regras de cálculo
- Uso do core (Cargas + Reservas) é o principal indicador de valor entregue
- Clientes inativos por mais de 30 dias raramente retornam sem intervenção ativa do CS
- Ações negativas = cancelamentos, exclusões e desativações
- Automação via API indica integração técnica — queda nesse canal pode sinalizar migração para concorrente

DADOS BRUTOS DO CLIENTE: ${cliente.nome_cliente}
- Dias sem qualquer atividade: ${cliente.dias_sem_atividade}
- Ações totais (últimos 90 dias): ${cliente.acoes_90d}
- Ações totais (últimos 30 dias): ${cliente.acoes_30d} — queda estimada de ${queda_uso}% vs ritmo anterior
- Ações no core/Cargas+Reservas (30d): ${cliente.acoes_core_30d} (${proporcao_core_30d}% do uso recente)
- Ações no core/Cargas+Reservas (90d): ${cliente.acoes_core_90d}
- Ações negativas (30d): ${cliente.acoes_negativas_30d} (${proporcao_negativos}% do total recente)
- Módulos distintos utilizados (30d): ${cliente.entidades_utilizadas} de 6 disponíveis
- Usuários ativos distintos (30d): ${cliente.usuarios_ativos}
- Ações via API/Automação (30d): ${cliente.acoes_automatizadas_30d}

PADRÕES A CONSIDERAR — combinações não óbvias importam:
- Muitas ações mas maioria negativa → risco maior do que inatividade simples
- Automação alta + queda de uso manual → pode estar migrando integração para concorrente
- Poucos usuários ativos + queda no core → abandono gradual da equipe
- Uso concentrado em módulos não-core → cliente usando só periféricos, sem engajamento real
- Inatividade total recente mas histórico alto → ruptura abrupta, investigar causa

Retorne APENAS JSON válido, sem markdown, sem texto adicional:
{
  "nivel_risco": "ALTO" | "MEDIO" | "BAIXO",
  "score_ia": <inteiro 0–100, sendo 100 churn iminente>,
  "resumo": "<uma frase descrevendo a situação do cliente>",
  "motivos": ["<motivo concreto 1>", "<motivo concreto 2>", "<motivo 3 se relevante>"],
  "acao_recomendada": "<ação direta e específica para o CS executar nas próximas 48h>"
}

Definições:
- ALTO: intervenção urgente, risco iminente
- MEDIO: sinais de alerta, acompanhamento próximo
- BAIXO: cliente saudável, manutenção de relacionamento
- Motivos baseados exclusivamente nos dados acima, sem invenção
- Acao_recomendada deve ser prática, não genérica`;
}
