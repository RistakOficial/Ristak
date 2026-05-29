export type AIAgentRole = 'user' | 'assistant'

export interface AIAgentMessage {
  id?: string
  role: AIAgentRole
  content: string
  sources?: Array<{
    title: string
    url: string
  }>
  createdAt?: string
}

export interface AIAgentConfigStatus {
  configured: boolean
  model: string
  tokenPreview: string | null
  businessContext: string
  marketContext: string
  idealCustomer: string
  locationContext: string
  competitorsContext: string
  brandVoice: string
  researchDomains: string
  webSearchEnabled: boolean
  updatedAt: string | null
}

export interface AIAgentConfigInput {
  apiKey?: string
  businessContext: string
  marketContext: string
  idealCustomer: string
  locationContext: string
  competitorsContext: string
  brandVoice: string
  researchDomains: string
  webSearchEnabled: boolean
}

export interface AIAgentViewContext {
  path: string
  title: string
  routeLabel: string
  visibleText: string
}

export interface AIAgentChatResult {
  reply: string
  model: string
  sources?: Array<{
    title: string
    url: string
  }>
  usage?: unknown
}

const API_BASE_URL = import.meta.env.VITE_API_URL || ''

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token')

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/ai-agent${endpoint}`, {
    ...options,
    headers: {
      ...getAuthHeaders(),
      ...options.headers
    }
  })

  let payload: any = null

  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new Error(payload?.error || payload?.message || 'Error en el agente AI')
  }

  return (payload?.data ?? payload) as T
}

export const aiAgentService = {
  getConfig(): Promise<AIAgentConfigStatus> {
    return request<AIAgentConfigStatus>('/config')
  },

  saveConfig(config: AIAgentConfigInput): Promise<AIAgentConfigStatus> {
    return request<AIAgentConfigStatus>('/config', {
      method: 'POST',
      body: JSON.stringify(config)
    })
  },

  async deleteConfig(): Promise<void> {
    await request('/config', {
      method: 'DELETE'
    })
  },

  sendMessage(messages: AIAgentMessage[], viewContext: AIAgentViewContext): Promise<AIAgentChatResult> {
    return request<AIAgentChatResult>('/chat', {
      method: 'POST',
      body: JSON.stringify({ messages, viewContext })
    })
  }
}
