import { OpenAIProvider } from '@openai/agents'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { decrypt, encrypt } from '../utils/encryption.js'
import { logger } from '../utils/logger.js'
import {
  getAIAgentStatus,
  getOpenAIApiKey
} from './aiAgentService.js'

export const DEFAULT_CONVERSATIONAL_AI_PROVIDER = 'openai'

const REQUEST_TIMEOUT_MS = 30_000
const PROVIDER_ID_PATTERN = /^[a-z0-9_-]{2,40}$/

export const CONVERSATIONAL_AI_PROVIDER_DEFINITIONS = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: process.env.OPENAI_CONVERSATIONAL_AGENT_MODEL || 'gpt-5.4-nano',
    supportsMultimodalInputs: true,
    canDelete: false,
    managedBy: 'ai_agent_config'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    defaultModel: process.env.GEMINI_CONVERSATIONAL_AGENT_MODEL || 'gemini-3.5-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    configKey: 'conversational_ai_provider_gemini_api_key_encrypted',
    supportsMultimodalInputs: true,
    canDelete: true
  },
  {
    id: 'claude',
    label: 'Claude',
    defaultModel: process.env.CLAUDE_CONVERSATIONAL_AGENT_MODEL || 'claude-haiku-4-5',
    baseURL: 'https://api.anthropic.com/v1/',
    configKey: 'conversational_ai_provider_claude_api_key_encrypted',
    supportsMultimodalInputs: false,
    canDelete: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: process.env.DEEPSEEK_CONVERSATIONAL_AGENT_MODEL || 'deepseek-v4-flash',
    baseURL: 'https://api.deepseek.com',
    configKey: 'conversational_ai_provider_deepseek_api_key_encrypted',
    supportsMultimodalInputs: false,
    canDelete: true
  }
]

const PROVIDERS_BY_ID = new Map(CONVERSATIONAL_AI_PROVIDER_DEFINITIONS.map((provider) => [provider.id, provider]))

function cleanProviderId(value) {
  const providerId = String(value || '').trim().toLowerCase()
  return PROVIDER_ID_PATTERN.test(providerId) ? providerId : ''
}

export function normalizeConversationalAIProvider(value) {
  const providerId = cleanProviderId(value)
  return PROVIDERS_BY_ID.has(providerId) ? providerId : DEFAULT_CONVERSATIONAL_AI_PROVIDER
}

export function getConversationalAIProviderDefinition(value) {
  return PROVIDERS_BY_ID.get(normalizeConversationalAIProvider(value)) || PROVIDERS_BY_ID.get(DEFAULT_CONVERSATIONAL_AI_PROVIDER)
}

export function getDefaultConversationalModelForProvider(value) {
  return getConversationalAIProviderDefinition(value).defaultModel
}

function maskApiKey(apiKey) {
  const clean = String(apiKey || '').trim()
  if (!clean || clean.length < 12) return '****'
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`
}

function buildProviderStatus(provider, patch = {}) {
  return {
    id: provider.id,
    label: provider.label,
    connected: false,
    default: provider.id === DEFAULT_CONVERSATIONAL_AI_PROVIDER,
    tokenPreview: null,
    needsReconnect: false,
    connectionIssue: null,
    canDelete: provider.canDelete,
    defaultModel: provider.defaultModel,
    ...patch
  }
}

async function getEncryptedProviderKey(provider) {
  if (!provider.configKey) return null
  return getAppConfig(provider.configKey)
}

async function getStoredProviderApiKey(provider) {
  if (provider.id === 'openai') {
    return getOpenAIApiKey()
  }

  const encrypted = await getEncryptedProviderKey(provider)
  if (!encrypted) return null

  try {
    return decrypt(encrypted)
  } catch (error) {
    logger.warn(`[Agente conversacional] No se pudo leer la llave de ${provider.label}: ${error.message}`)
    const credentialError = new Error(`${provider.label} necesita reconectarse. Borra la conexión y pega otra API key.`)
    credentialError.statusCode = 409
    credentialError.code = 'CONVERSATIONAL_AI_PROVIDER_RECONNECT_REQUIRED'
    throw credentialError
  }
}

async function getProviderStatus(provider) {
  if (provider.id === 'openai') {
    const status = await getAIAgentStatus({})
    return buildProviderStatus(provider, {
      connected: Boolean(status.configured && !status.needsReconnect),
      tokenPreview: status.tokenPreview || null,
      needsReconnect: Boolean(status.needsReconnect),
      connectionIssue: status.connectionIssue || null
    })
  }

  const encrypted = await getEncryptedProviderKey(provider)
  if (!encrypted) return buildProviderStatus(provider)

  try {
    const apiKey = decrypt(encrypted)
    return buildProviderStatus(provider, {
      connected: true,
      tokenPreview: maskApiKey(apiKey)
    })
  } catch (error) {
    logger.warn(`[Agente conversacional] Llave guardada inválida para ${provider.label}: ${error.message}`)
    return buildProviderStatus(provider, {
      needsReconnect: true,
      connectionIssue: `${provider.label} necesita reconectarse.`,
      tokenPreview: 'Requiere reconexión'
    })
  }
}

export async function listConversationalAIProviders() {
  return Promise.all(CONVERSATIONAL_AI_PROVIDER_DEFINITIONS.map(getProviderStatus))
}

function readProviderError(payload, fallback) {
  if (payload?.error?.message) return payload.error.message
  if (typeof payload?.message === 'string') return payload.message
  return fallback
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function verifyProviderApiKey(provider, apiKey) {
  const response = await fetchWithTimeout(`${provider.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: provider.defaultModel,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4
    })
  })

  if (response.ok) return

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  const error = new Error(readProviderError(payload, `No se pudo validar la API key de ${provider.label}.`))
  error.statusCode = response.status === 401 || response.status === 403 ? 401 : 400
  throw error
}

export async function connectConversationalAIProvider(providerId, apiKey) {
  const provider = getConversationalAIProviderDefinition(providerId)
  if (provider.id === 'openai') {
    const error = new Error('OpenAI se conecta desde la sección General del Agente AI.')
    error.statusCode = 400
    throw error
  }

  const cleanKey = String(apiKey || '').trim()
  if (cleanKey.length < 12) {
    const error = new Error(`Pega una API key válida de ${provider.label}.`)
    error.statusCode = 400
    throw error
  }

  await verifyProviderApiKey(provider, cleanKey)
  await setAppConfig(provider.configKey, encrypt(cleanKey))
  return listConversationalAIProviders()
}

export async function deleteConversationalAIProvider(providerId) {
  const provider = getConversationalAIProviderDefinition(providerId)
  if (provider.id === 'openai') {
    const error = new Error('OpenAI se administra desde la sección General del Agente AI.')
    error.statusCode = 400
    throw error
  }

  await db.run('DELETE FROM app_config WHERE config_key = ?', [provider.configKey])
  const fallbackModel = getDefaultConversationalModelForProvider(DEFAULT_CONVERSATIONAL_AI_PROVIDER)
  await db.run(`
    UPDATE conversational_agent_config
    SET ai_provider = ?, model = ?, updated_at = CURRENT_TIMESTAMP
    WHERE ai_provider = ?
  `, [DEFAULT_CONVERSATIONAL_AI_PROVIDER, fallbackModel, provider.id]).catch(() => {})
  await db.run(`
    UPDATE conversational_agents
    SET ai_provider = ?, model = ?, updated_at = CURRENT_TIMESTAMP
    WHERE ai_provider = ?
  `, [DEFAULT_CONVERSATIONAL_AI_PROVIDER, fallbackModel, provider.id]).catch(() => {})
  return listConversationalAIProviders()
}

export async function resolveConversationalAIRuntime(providerId) {
  const provider = getConversationalAIProviderDefinition(providerId)
  const apiKey = await getStoredProviderApiKey(provider)
  if (!apiKey) {
    const error = new Error(`Conecta ${provider.label} antes de usarlo en el agente conversacional.`)
    error.statusCode = 409
    error.code = 'CONVERSATIONAL_AI_PROVIDER_NOT_CONNECTED'
    throw error
  }

  const modelProvider = provider.id === 'openai'
    ? new OpenAIProvider({ apiKey })
    : new OpenAIProvider({ apiKey, baseURL: provider.baseURL, useResponses: false })

  return {
    providerId: provider.id,
    providerLabel: provider.label,
    apiKey,
    modelProvider,
    supportsAISplitting: provider.id === 'openai',
    supportsMultimodalInputs: provider.supportsMultimodalInputs === true
  }
}
