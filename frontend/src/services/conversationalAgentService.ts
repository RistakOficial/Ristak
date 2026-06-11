export type ConversationalObjective = 'citas' | 'ventas' | 'datos' | 'filtrar' | 'detectar' | 'custom'
export type ConversationalSuccessAction = 'book_appointment' | 'ready_for_human' | 'ready_to_buy' | 'internal_signal' | 'none'
export type ConversationStatus = 'active' | 'paused' | 'human' | 'skipped' | 'completed' | 'discarded'
export type ConversationSignal = 'ready_for_human' | 'ready_to_schedule' | 'ready_to_buy' | 'appointment_booked' | 'discarded'
export type ClosingStrategyMode = 'system' | 'custom'

export interface ConversationalAgentConfig {
  enabled: boolean
  objective: ConversationalObjective
  customObjective: string
  successAction: ConversationalSuccessAction
  requiredData: string
  handoffRules: string
  extraInstructions: string
  allowEmojis: boolean
  hideAttended: boolean
  defaultCalendarId: string | null
  closingStrategyMode: ClosingStrategyMode
  closingStrategyCustom: string
  updatedAt: string | null
  objectives?: Array<{ id: string; label: string }>
  successActions?: Array<{ id: string; label: string }>
  systemClosingStrategy?: string
}

export interface ConversationalAgentConfigInput {
  enabled?: boolean
  objective?: ConversationalObjective
  customObjective?: string
  successAction?: ConversationalSuccessAction
  requiredData?: string
  handoffRules?: string
  extraInstructions?: string
  allowEmojis?: boolean
  hideAttended?: boolean
  defaultCalendarId?: string | null
  closingStrategyMode?: ClosingStrategyMode
  closingStrategyCustom?: string
}

export type ConditionCategory =
  | 'channel'
  | 'message'
  | 'tags'
  | 'appointments'
  | 'payments'
  | 'assignee'
  | 'ads'
  | 'contact'
  | 'schedule'
  | 'business_phone'

export type ConditionChannel = 'whatsapp' | 'instagram' | 'messenger' | 'webchat' | 'sms' | 'email'
export type ConditionOffsetUnit = 'minutes' | 'hours' | 'days'

/**
 * Una condición del constructor: categoría → operador → valores.
 * Los operadores válidos por categoría viven en el catálogo del componente
 * (y se validan también en backend).
 */
export interface AgentCondition {
  category: ConditionCategory
  operator: string
  value?: string
  values?: string[]
  calendarId?: string
  date?: string
  dateEnd?: string
  amount?: number
  amountMax?: number
  offsetValue?: number
  offsetUnit?: ConditionOffsetUnit
  timeStart?: string
  timeEnd?: string
}

export interface AgentFilterOptions {
  ads: Array<{ id: string; name: string; campaign: string | null; detected: boolean }>
  businessPhones: Array<{ id: string; label: string }>
}

export interface ConditionGroup {
  conditions: AgentCondition[]
}

export interface AgentFilters {
  /** Inicia si ALGÚN grupo (O) cumple TODAS sus condiciones (Y). Sin grupos = siempre. */
  entry: { groups: ConditionGroup[] }
  /** Suelta la conversación si algún grupo se cumple completo. Sin grupos = nunca. */
  exit: { groups: ConditionGroup[] }
}

export type SuccessExtraType = 'add_tag' | 'remove_tag' | 'set_custom_field'

export interface AgentSuccessExtra {
  type: SuccessExtraType
  tag?: string
  field?: string
  value?: string
}

export interface ConversationalAgentDef {
  id: string
  name: string
  enabled: boolean
  position: number
  objective: ConversationalObjective
  customObjective: string
  successAction: ConversationalSuccessAction
  successExtras: AgentSuccessExtra[]
  requiredData: string
  handoffRules: string
  extraInstructions: string
  allowEmojis: boolean
  defaultCalendarId: string | null
  closingStrategyMode: ClosingStrategyMode
  closingStrategyCustom: string
  filters: AgentFilters
  createdAt: string | null
  updatedAt: string | null
}

export type ConversationalAgentDefInput = Partial<Omit<ConversationalAgentDef, 'id' | 'createdAt' | 'updatedAt'>>

export interface ConversationAgentState {
  contactId: string
  status: ConversationStatus
  signal: ConversationSignal | null
  signalReason: string | null
  signalSummary: string | null
  signalAt: string | null
  lastInboundMessageId: string | null
  lastReplyAt: string | null
  updatedBy: string | null
  updatedAt: string | null
  contactName?: string | null
  contactPhone?: string | null
}

export type ConversationStateAction = 'pause' | 'resume' | 'take_over' | 'skip' | 'activate' | 'clear_signal'

export interface ConversationalAgentTestResult {
  reply: string
  suppressed: boolean
  actions: Array<{ type: string; [key: string]: unknown }>
  model: string
}

export interface ConversationalAgentEvent {
  id: string
  contactId: string | null
  eventType: string
  detail: unknown
  createdAt: string
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
  const response = await fetch(`${API_BASE_URL}/api/conversational-agent${endpoint}`, {
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
    throw new Error(payload?.error || payload?.message || 'Error en el agente conversacional')
  }

  return (payload?.data ?? payload) as T
}

export const conversationalAgentService = {
  getConfig(): Promise<ConversationalAgentConfig> {
    return request<ConversationalAgentConfig>('/config')
  },

  saveConfig(config: ConversationalAgentConfigInput): Promise<ConversationalAgentConfig> {
    return request<ConversationalAgentConfig>('/config', {
      method: 'POST',
      body: JSON.stringify(config)
    })
  },

  listAgents(): Promise<ConversationalAgentDef[]> {
    return request<ConversationalAgentDef[]>('/agents')
  },

  getFilterOptions(): Promise<AgentFilterOptions> {
    return request<AgentFilterOptions>('/filter-options')
  },

  createAgent(input: ConversationalAgentDefInput = {}): Promise<ConversationalAgentDef> {
    return request<ConversationalAgentDef>('/agents', {
      method: 'POST',
      body: JSON.stringify(input)
    })
  },

  updateAgent(agentId: string, input: ConversationalAgentDefInput): Promise<ConversationalAgentDef> {
    return request<ConversationalAgentDef>(`/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(input)
    })
  },

  async deleteAgent(agentId: string): Promise<void> {
    await request(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })
  },

  listStates(params: { signal?: string; statuses?: string[] } = {}): Promise<ConversationAgentState[]> {
    const search = new URLSearchParams()
    if (params.signal) search.set('signal', params.signal)
    if (params.statuses?.length) search.set('statuses', params.statuses.join(','))
    const query = search.toString()
    return request<ConversationAgentState[]>(`/states${query ? `?${query}` : ''}`)
  },

  getState(contactId: string): Promise<ConversationAgentState | null> {
    return request<ConversationAgentState | null>(`/states/${encodeURIComponent(contactId)}`)
  },

  updateState(contactId: string, action: ConversationStateAction): Promise<ConversationAgentState> {
    return request<ConversationAgentState>(`/states/${encodeURIComponent(contactId)}`, {
      method: 'POST',
      body: JSON.stringify({ action })
    })
  },

  testAgent(
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    options: { config?: ConversationalAgentDefInput; agentId?: string } = {}
  ): Promise<ConversationalAgentTestResult> {
    return request<ConversationalAgentTestResult>('/test', {
      method: 'POST',
      body: JSON.stringify({
        messages,
        ...(options.config ? { config: options.config } : {}),
        ...(options.agentId ? { agentId: options.agentId } : {})
      })
    })
  },

  listEvents(params: { contactId?: string; limit?: number } = {}): Promise<ConversationalAgentEvent[]> {
    const search = new URLSearchParams()
    if (params.contactId) search.set('contactId', params.contactId)
    if (params.limit) search.set('limit', String(params.limit))
    const query = search.toString()
    return request<ConversationalAgentEvent[]>(`/events${query ? `?${query}` : ''}`)
  }
}
