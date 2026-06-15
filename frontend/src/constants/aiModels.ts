export const DEFAULT_AI_MODEL = 'gpt-5.4-nano'

export const aiModelOptionGroups = [
  {
    label: 'GPT-5.5 y GPT-5.4',
    options: [
      { value: 'gpt-5.5', label: 'GPT-5.5', description: 'El más nuevo para análisis complejo, criterio y trabajo profesional.' },
      { value: 'gpt-5.5-pro', label: 'GPT-5.5 pro', description: 'Más cómputo para respuestas más precisas; puede tardar más.' },
      { value: 'gpt-5.4', label: 'GPT-5.4', description: 'Frontier fuerte con mejor balance de costo.' },
      { value: 'gpt-5.4-pro', label: 'GPT-5.4 pro', description: 'Versión pro de GPT-5.4 para más precisión.' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini', description: 'Rápido y más barato para alto volumen.' },
      { value: 'gpt-5.4-nano', label: 'GPT-5.4 nano', description: 'El más económico de la familia GPT-5.4.' }
    ]
  },
  {
    label: 'GPT-5 anteriores',
    options: [
      { value: 'gpt-5.2', label: 'GPT-5.2', description: 'Modelo frontier anterior para trabajo profesional.' },
      { value: 'gpt-5.2-pro', label: 'GPT-5.2 pro', description: 'Versión pro anterior con más precisión.' },
      { value: 'gpt-5.1', label: 'GPT-5.1', description: 'Modelo anterior para tareas de agente y código.' },
      { value: 'gpt-5', label: 'GPT-5', description: 'Modelo GPT-5 original.' },
      { value: 'gpt-5-pro', label: 'GPT-5 pro', description: 'Versión pro de GPT-5.' },
      { value: 'gpt-5-mini', label: 'GPT-5 mini', description: 'Más rápido y económico que GPT-5.' },
      { value: 'gpt-5-nano', label: 'GPT-5 nano', description: 'Más barato y rápido para tareas simples.' }
    ]
  },
  {
    label: 'Modelos usados en ChatGPT',
    options: [
      { value: 'chat-latest', label: 'chat-latest', description: 'Modelo instantáneo actual usado en ChatGPT; OpenAI lo puede actualizar.' },
      { value: 'gpt-5.3-chat-latest', label: 'GPT-5.3 Chat', description: 'Snapshot instantáneo GPT-5.3 usado en ChatGPT.' },
      { value: 'gpt-5.2-chat-latest', label: 'GPT-5.2 Chat', description: 'Snapshot GPT-5.2 usado en ChatGPT.' },
      { value: 'gpt-5.1-chat-latest', label: 'GPT-5.1 Chat', description: 'Versión ChatGPT anterior.' },
      { value: 'gpt-5-chat-latest', label: 'GPT-5 Chat', description: 'Versión GPT-5 usada antes en ChatGPT.' },
      { value: 'chatgpt-4o-latest', label: 'ChatGPT-4o', description: 'Alias anterior de GPT-4o usado en ChatGPT.' }
    ]
  },
  {
    label: 'GPT-4 y legacy',
    options: [
      { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Modelo no razonador fuerte.' },
      { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini', description: 'Versión más rápida de GPT-4.1.' },
      { value: 'gpt-4.1-nano', label: 'GPT-4.1 nano', description: 'Versión más económica de GPT-4.1.' },
      { value: 'gpt-4o', label: 'GPT-4o', description: 'Modelo rápido y flexible anterior.' },
      { value: 'gpt-4o-mini', label: 'GPT-4o mini', description: 'Modelo económico para tareas enfocadas.' },
      { value: 'gpt-4.5-preview', label: 'GPT-4.5 Preview', description: 'Modelo preview legacy.' },
      { value: 'gpt-4-turbo', label: 'GPT-4 Turbo', description: 'Modelo GPT-4 Turbo legacy.' },
      { value: 'gpt-4-turbo-preview', label: 'GPT-4 Turbo Preview', description: 'Preview legacy de GPT-4 Turbo.' },
      { value: 'gpt-4', label: 'GPT-4', description: 'Modelo GPT-4 original.' },
      { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo', description: 'Modelo legacy barato para chat.' }
    ]
  },
  {
    label: 'Razonamiento y búsqueda',
    options: [
      { value: 'o3-pro', label: 'o3-pro', description: 'Razonamiento con más cómputo.' },
      { value: 'o3', label: 'o3', description: 'Modelo de razonamiento anterior.' },
      { value: 'o4-mini', label: 'o4-mini', description: 'Razonamiento rápido y económico.' },
      { value: 'o3-mini', label: 'o3-mini', description: 'Modelo de razonamiento pequeño legacy.' },
      { value: 'o1-pro', label: 'o1-pro', description: 'Razonamiento o1 con más cómputo.' },
      { value: 'o1', label: 'o1', description: 'Modelo o-series anterior.' },
      { value: 'o1-mini', label: 'o1-mini', description: 'Versión pequeña legacy de o1.' },
      { value: 'o1-preview', label: 'o1 preview', description: 'Preview legacy de o1.' },
      { value: 'gpt-4o-search-preview', label: 'GPT-4o Search Preview', description: 'Modelo legacy orientado a búsqueda.' },
      { value: 'gpt-4o-mini-search-preview', label: 'GPT-4o mini Search Preview', description: 'Modelo pequeño legacy orientado a búsqueda.' }
    ]
  },
  {
    label: 'Codex, deep research y open-weight',
    options: [
      { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'Modelo optimizado para programación/agentes de código.' },
      { value: 'gpt-5.2-codex', label: 'GPT-5.2-Codex', description: 'Codex anterior para tareas largas de código.' },
      { value: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', description: 'Codex GPT-5.1 legacy.' },
      { value: 'gpt-5.1-codex-max', label: 'GPT-5.1-Codex-Max', description: 'Codex para tareas largas legacy.' },
      { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex mini', description: 'Codex mini legacy.' },
      { value: 'gpt-5-codex', label: 'GPT-5-Codex', description: 'Codex GPT-5 legacy.' },
      { value: 'codex-mini-latest', label: 'codex-mini-latest', description: 'Codex mini legacy.' },
      { value: 'o3-deep-research', label: 'o3-deep-research', description: 'Modelo especializado en investigación profunda.' },
      { value: 'o4-mini-deep-research', label: 'o4-mini-deep-research', description: 'Investigación profunda más rápida/económica.' },
      { value: 'gpt-oss-120b', label: 'gpt-oss-120b', description: 'Modelo open-weight grande.' },
      { value: 'gpt-oss-20b', label: 'gpt-oss-20b', description: 'Modelo open-weight más ligero.' }
    ]
  }
]

export const aiModelOptions = aiModelOptionGroups.flatMap((group) => group.options)

export function getKnownAIModel(value?: string | null) {
  return aiModelOptions.some((option) => option.value === value) ? String(value) : DEFAULT_AI_MODEL
}
