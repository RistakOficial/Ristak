import { DEFAULT_AI_MODEL, aiModelOptionGroups, aiModelOptions, getKnownAIModel } from './aiModels'

export type ConversationalAIProviderId = 'openai' | 'gemini' | 'claude' | 'deepseek'

export interface ConversationalAIModelOption {
  value: string
  label: string
  description: string
}

export interface ConversationalAIModelGroup {
  label: string
  options: ConversationalAIModelOption[]
}

export interface ConversationalAIProviderOption {
  id: ConversationalAIProviderId
  label: string
  description: string
  defaultModel: string
  modelGroups: ConversationalAIModelGroup[]
}

const geminiModelGroups: ConversationalAIModelGroup[] = [
  {
    label: 'Gemini actuales',
    options: [
      { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', description: 'Modelo rápido y fuerte para conversaciones de alto volumen.' },
      { value: 'gemini-3-flash', label: 'Gemini 3 Flash', description: 'Frontier con costo bajo para respuestas ágiles.' },
      { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', description: 'Más capacidad para conversaciones complejas.' },
      { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite', description: 'Opción ligera para ahorrar más en chats simples.' }
    ]
  },
  {
    label: 'Gemini 2.5',
    options: [
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', description: 'Buen balance de velocidad, costo y razonamiento.' },
      { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', description: 'La opción más económica de la familia 2.5.' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', description: 'Más precisión para casos difíciles.' }
    ]
  }
]

const claudeModelGroups: ConversationalAIModelGroup[] = [
  {
    label: 'Claude actuales',
    options: [
      { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', description: 'Rápido y económico para alto volumen de chats.' },
      { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Mejor balance entre inteligencia, velocidad y costo.' }
    ]
  },
  {
    label: 'Claude alta capacidad',
    options: [
      { value: 'claude-opus-4-8', label: 'Claude Opus 4.8', description: 'Más capacidad para conversaciones complejas y cierres delicados.' },
      { value: 'claude-fable-5', label: 'Claude Fable 5', description: 'El modelo más capaz de Anthropic para casos donde el costo se justifica.' }
    ]
  }
]

const deepSeekModelGroups: ConversationalAIModelGroup[] = [
  {
    label: 'DeepSeek actuales',
    options: [
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Modelo económico para conversación diaria.' },
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Más capacidad cuando el cierre requiere más criterio.' }
    ]
  },
  {
    label: 'Compatibilidad legacy',
    options: [
      { value: 'deepseek-chat', label: 'deepseek-chat', description: 'Alias compatible para modo sin razonamiento.' },
      { value: 'deepseek-reasoner', label: 'deepseek-reasoner', description: 'Alias compatible para modo con razonamiento.' }
    ]
  }
]

export const conversationalAIProviderOptions: ConversationalAIProviderOption[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'Default del sistema y el más integrado con Ristak.',
    defaultModel: DEFAULT_AI_MODEL,
    modelGroups: aiModelOptionGroups
  },
  {
    id: 'gemini',
    label: 'Gemini',
    description: 'Alternativa de Google para bajar costo por conversación.',
    defaultModel: 'gemini-3.5-flash',
    modelGroups: geminiModelGroups
  },
  {
    id: 'claude',
    label: 'Claude',
    description: 'Alternativa de Anthropic con buen balance de criterio y costo.',
    defaultModel: 'claude-haiku-4-5',
    modelGroups: claudeModelGroups
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Opción muy barata para alto volumen de chats.',
    defaultModel: 'deepseek-v4-flash',
    modelGroups: deepSeekModelGroups
  }
]

const providerIds = new Set<ConversationalAIProviderId>(conversationalAIProviderOptions.map((provider) => provider.id))

export function getKnownConversationalAIProvider(value?: string | null): ConversationalAIProviderId {
  const providerId = String(value || '').trim().toLowerCase() as ConversationalAIProviderId
  return providerIds.has(providerId) ? providerId : 'openai'
}

export function getConversationalAIProviderOption(value?: string | null) {
  const providerId = getKnownConversationalAIProvider(value)
  return conversationalAIProviderOptions.find((provider) => provider.id === providerId) || conversationalAIProviderOptions[0]
}

export function getConversationalModelOptions(providerId?: string | null) {
  return getConversationalAIProviderOption(providerId).modelGroups.flatMap((group) => group.options)
}

export function getDefaultConversationalModel(providerId?: string | null) {
  return getConversationalAIProviderOption(providerId).defaultModel
}

export function getKnownConversationalModel(providerId?: string | null, model?: string | null) {
  const provider = getKnownConversationalAIProvider(providerId)
  if (provider === 'openai') return getKnownAIModel(model)
  const modelOptions = getConversationalModelOptions(provider)
  return modelOptions.some((option) => option.value === model)
    ? String(model)
    : getDefaultConversationalModel(provider)
}

export function getConversationalModelLabel(providerId?: string | null, model?: string | null) {
  const provider = getKnownConversationalAIProvider(providerId)
  if (provider === 'openai') {
    return aiModelOptions.find((option) => option.value === getKnownAIModel(model))?.label || DEFAULT_AI_MODEL
  }
  const knownModel = getKnownConversationalModel(provider, model)
  return getConversationalModelOptions(provider).find((option) => option.value === knownModel)?.label || knownModel
}
