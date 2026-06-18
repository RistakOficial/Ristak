import type { ConversationalAIProviderId } from '@/constants/conversationalAIProviders'
import { apiUrl } from './apiBaseUrl'

export type ConversationalObjective = 'citas' | 'ventas' | 'datos' | 'filtrar' | 'custom'
export type ConversationalSuccessAction = 'book_appointment' | 'ready_for_human' | 'ready_to_buy' | 'send_goal_url' | 'send_trigger_link' | 'internal_signal' | 'none'
export type ConversationStatus = 'active' | 'paused' | 'human' | 'skipped' | 'completed' | 'discarded'
export type ConversationSignal = 'ready_for_human' | 'ready_to_schedule' | 'ready_to_buy' | 'appointment_booked' | 'purchase_completed' | 'discarded'
export type ClosingStrategyMode = 'system' | 'custom'
export type AgentResponseDelayMode = 'none' | 'fixed' | 'random'
export type AgentResponseDelayUnit = 'seconds' | 'minutes'
export type AgentReplyDeliveryMode = 'single' | 'split'

export interface ConversationalAIProviderStatus {
  id: ConversationalAIProviderId
  label: string
  connected: boolean
  default: boolean
  tokenPreview: string | null
  needsReconnect: boolean
  connectionIssue: string | null
  canDelete: boolean
  defaultModel: string
}

export interface ConversationalBusinessPromptStatus {
  ready: boolean
  status: string
  extractionStatus: string
  extractionError: string | null
  businessName: string | null
  industry: string | null
  updatedAt: string | null
  summary: string | null
}

export interface AgentResponseDelayConfig {
  mode: AgentResponseDelayMode
  fixedValue: number
  fixedUnit: AgentResponseDelayUnit
  minValue: number
  maxValue: number
  rangeUnit: AgentResponseDelayUnit
}

export interface AgentReplyDeliveryConfig {
  mode: AgentReplyDeliveryMode
  splitMessagesEnabled: boolean
  minMessageLengthToSplit: number
  maxBubbles: number
  minBubbleLength: number
  maxBubbleLength: number
  targetChars: number
  randomizeSplitting: boolean
  delayBetweenBubblesEnabled: boolean
  minDelaySeconds: number
  maxDelaySeconds: number
}

export type AgentGoalOwner = 'human' | 'ai' | 'url'

export interface AgentGoalWorkflowConfig {
  appointments: {
    owner: AgentGoalOwner
    calendarId: string | null
    url: string
    trackingParam: string
  }
  sales: {
    owner: AgentGoalOwner
    productId: string
    priceId: string
    productName: string
    priceName: string
    amount: number | null
    currency: string
    url: string
    trackingParam: string
  }
  data: {
    afterComplete: 'human'
  }
  qualification: {
    questions: string
    qualifies: string
    disqualifies: string
  }
  triggerLink: {
    triggerLinkId: string
    triggerLinkPublicId: string
    triggerLinkName: string
    triggerLinkUrl: string
  }
}

export interface ConversationalAgentConfig {
  enabled: boolean
  aiProvider: ConversationalAIProviderId
  model: string
  objective: ConversationalObjective
  customObjective: string
  successAction: ConversationalSuccessAction
  requiredData: string
  handoffRules: string
  extraInstructions: string
  allowEmojis: boolean
  hideAttended: boolean
  hideAttendedNotifications: boolean
  defaultCalendarId: string | null
  closingStrategyMode: ClosingStrategyMode
  closingStrategyCustom: string
  updatedAt: string | null
  objectives?: Array<{ id: string; label: string }>
  successActions?: Array<{ id: string; label: string }>
  systemClosingStrategy?: string
  businessPromptStatus?: ConversationalBusinessPromptStatus
  aiProviders?: ConversationalAIProviderStatus[]
}

export interface ConversationalAgentConfigInput {
  enabled?: boolean
  aiProvider?: ConversationalAIProviderId
  model?: string
  objective?: ConversationalObjective
  customObjective?: string
  successAction?: ConversationalSuccessAction
  requiredData?: string
  handoffRules?: string
  extraInstructions?: string
  allowEmojis?: boolean
  hideAttended?: boolean
  hideAttendedNotifications?: boolean
  defaultCalendarId?: string | null
  closingStrategyMode?: ClosingStrategyMode
  closingStrategyCustom?: string
}

export type ConditionCategory =
  | 'channel'
  | 'message'
  | 'tags'
  | 'contact'
  | 'appointments'
  | 'payments'
  | 'ads'
  | 'schedule'

export type ConditionChannel = 'whatsapp' | 'instagram' | 'messenger' | 'webchat' | 'sms' | 'email'
export type ConditionOffsetUnit = 'minutes' | 'hours' | 'days'

/**
 * Parámetro opcional de una condición: subcategoría (field) → operador → valor.
 * En Citas y Pagos los parámetros se evalúan en conjunto sobre el mismo registro.
 */
export interface AgentConditionParam {
  field: string
  operator: string
  value?: string
  values?: string[]
  date?: string
  dateEnd?: string
  amount?: number
  amountMax?: number
  offsetValue?: number
  offsetUnit?: ConditionOffsetUnit
  timeStart?: string
  timeEnd?: string
  fieldKey?: string
}

/**
 * Condición jerárquica: la categoría sola ya dispara con su significado base
 * ("agendó una cita", "vino de anuncio"); los params la afinan opcionalmente.
 */
export interface AgentCondition {
  category: ConditionCategory
  params: AgentConditionParam[]
}

export interface AgentFilterOptions {
  ads: Array<{ id: string; name: string; campaign: string | null; detected: boolean }>
  businessPhones: Array<{ id: string; label: string }>
  customFields: Array<{ key: string; label: string }>
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
  aiProvider: ConversationalAIProviderId
  model: string
  position: number
  objective: ConversationalObjective
  customObjective: string
  successAction: ConversationalSuccessAction
  successExtras: AgentSuccessExtra[]
  requiredData: string
  handoffRules: string
  extraInstructions: string
  allowEmojis: boolean
  hideAttended: boolean
  hideAttendedNotifications: boolean
  defaultCalendarId: string | null
  closingStrategyMode: ClosingStrategyMode
  closingStrategyCustom: string
  systemClosingStrategy?: string
  responseDelay: AgentResponseDelayConfig
  replyDelivery: AgentReplyDeliveryConfig
  goalWorkflow: AgentGoalWorkflowConfig
  filters: AgentFilters
  createdAt: string | null
  updatedAt: string | null
}

export type ConversationalAgentDefInput = Partial<Omit<ConversationalAgentDef, 'id' | 'createdAt' | 'updatedAt' | 'systemClosingStrategy'>>

export interface ConversationAgentState {
  contactId: string
  agentId: string | null
  status: ConversationStatus
  signal: ConversationSignal | null
  signalReason: string | null
  signalSummary: string | null
  signalAt: string | null
  lastInboundMessageId: string | null
  lastAnsweredInboundMessageId: string | null
  lastReplyAt: string | null
  updatedBy: string | null
  closingContext?: Record<string, string>
  updatedAt: string | null
  contactName?: string | null
  contactPhone?: string | null
}

export type ConversationStateAction = 'pause' | 'resume' | 'take_over' | 'skip' | 'activate' | 'clear_signal'

export interface ConversationalAgentTestResult {
  reply: string
  replyParts?: string[]
  replyPartDelaysMs?: number[]
  responseDelayMs?: number
  suppressed: boolean
  actions: Array<{ type: string; [key: string]: unknown }>
  aiProvider: ConversationalAIProviderId
  model: string
}

export interface ConversationalAgentEvent {
  id: string
  contactId: string | null
  eventType: string
  detail: unknown
  createdAt: string
}

export interface ConversationalAgentMetricByAgent {
  agentId: string
  name: string
  enabled: boolean
  aiProvider: ConversationalAIProviderId
  model: string
  assignedConversations: number
  completedConversations: number
  pausedConversations: number
  humanTakeovers: number
  skippedConversations: number
  discardedConversations: number
  totalConversations: number
  lastActivityAt: string | null
}

export interface ConversationalAgentMetrics {
  totalAgents: number
  activeAgents: number
  assignedConversations: number
  agentsWithAssignedConversations: number
  completedConversations: number
  pausedConversations: number
  humanTakeovers: number
  skippedConversations: number
  discardedConversations: number
  totalTrackedConversations: number
  totalEvents: number
  successEvents: number
  errorEvents: number
  assignedEvents: number
  replyEvents: number
  successRate: number
  byAgent: ConversationalAgentMetricByAgent[]
}

export interface ConversationalAgentLiveCache {
  config: ConversationalAgentConfig | null
  states: ConversationAgentState[]
  agents: ConversationalAgentDef[]
  savedAt: number
}

export const CONVERSATIONAL_AGENT_LIVE_CACHE_EVENT = 'ristak-conversational-agent-live-cache'

const LIVE_CACHE_KEY = 'ristak_conversational_agent_live_cache_v1'
const VALID_CONVERSATIONAL_SUCCESS_ACTIONS = new Set<ConversationalSuccessAction>([
  'book_appointment',
  'ready_for_human',
  'ready_to_buy',
  'send_goal_url',
  'send_trigger_link',
  'internal_signal',
  'none'
])
const VALID_CONVERSATIONAL_AI_PROVIDERS = new Set<ConversationalAIProviderId>(['openai', 'gemini', 'claude', 'deepseek'])

const DEFAULT_AGENT_GOAL_WORKFLOW: AgentGoalWorkflowConfig = {
  appointments: {
    owner: 'human',
    calendarId: null,
    url: '',
    trackingParam: 'ristak_goal_id'
  },
  sales: {
    owner: 'human',
    productId: '',
    priceId: '',
    productName: '',
    priceName: '',
    amount: null,
    currency: '',
    url: '',
    trackingParam: 'ristak_goal_id'
  },
  data: {
    afterComplete: 'human'
  },
  qualification: {
    questions: '',
    qualifies: '',
    disqualifies: ''
  },
  triggerLink: {
    triggerLinkId: '',
    triggerLinkPublicId: '',
    triggerLinkName: '',
    triggerLinkUrl: ''
  }
}

function normalizeConversationalSuccessAction(value?: unknown): ConversationalSuccessAction {
  const action = String(value || '').trim() as ConversationalSuccessAction
  return VALID_CONVERSATIONAL_SUCCESS_ACTIONS.has(action) ? action : 'ready_for_human'
}

function normalizeConversationalAIProvider(value?: unknown): ConversationalAIProviderId {
  const provider = String(value || '').trim().toLowerCase() as ConversationalAIProviderId
  return VALID_CONVERSATIONAL_AI_PROVIDERS.has(provider) ? provider : 'openai'
}

function normalizeAgentConfig<T extends ConversationalAgentConfig | null | undefined>(config: T): T {
  if (!config) return config
  return {
    ...config,
    aiProvider: normalizeConversationalAIProvider(config.aiProvider),
    successAction: normalizeConversationalSuccessAction(config.successAction)
  }
}

function normalizeAgentDef<T extends ConversationalAgentDef>(agent: T): T {
  return {
    ...agent,
    aiProvider: normalizeConversationalAIProvider(agent.aiProvider),
    successAction: normalizeConversationalSuccessAction(agent.successAction),
    goalWorkflow: {
      ...DEFAULT_AGENT_GOAL_WORKFLOW,
      ...((agent.goalWorkflow || {}) as Partial<AgentGoalWorkflowConfig>),
      appointments: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.appointments,
        ...((agent.goalWorkflow?.appointments || {}) as Partial<AgentGoalWorkflowConfig['appointments']>)
      },
      sales: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.sales,
        ...((agent.goalWorkflow?.sales || {}) as Partial<AgentGoalWorkflowConfig['sales']>)
      },
      data: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.data,
        ...((agent.goalWorkflow?.data || {}) as Partial<AgentGoalWorkflowConfig['data']>)
      },
      qualification: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.qualification,
        ...((agent.goalWorkflow?.qualification || {}) as Partial<AgentGoalWorkflowConfig['qualification']>)
      },
      triggerLink: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.triggerLink,
        ...((agent.goalWorkflow?.triggerLink || {}) as Partial<AgentGoalWorkflowConfig['triggerLink']>)
      }
    }
  }
}

function normalizeAgentDefs(agents: ConversationalAgentDef[] = []) {
  return agents.map(normalizeAgentDef)
}

function getLocalStorage() {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readConversationalAgentLiveCache(): ConversationalAgentLiveCache | null {
  const storage = getLocalStorage()
  if (!storage) return null

  try {
    const parsed = JSON.parse(storage.getItem(LIVE_CACHE_KEY) || 'null') as Partial<ConversationalAgentLiveCache> | null
    if (!parsed || typeof parsed !== 'object') return null
    return {
      config: normalizeAgentConfig(parsed.config || null),
      states: Array.isArray(parsed.states) ? parsed.states : [],
      agents: Array.isArray(parsed.agents) ? normalizeAgentDefs(parsed.agents) : [],
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0
    }
  } catch {
    storage.removeItem(LIVE_CACHE_KEY)
    return null
  }
}

function writeConversationalAgentLiveCache(
  patch: Partial<Omit<ConversationalAgentLiveCache, 'savedAt'>>,
  options: { notify?: boolean } = {}
) {
  const storage = getLocalStorage()
  if (!storage) return

  const current = readConversationalAgentLiveCache()
  const next: ConversationalAgentLiveCache = {
    config: patch.config !== undefined ? normalizeAgentConfig(patch.config) : current?.config || null,
    states: patch.states !== undefined ? patch.states : current?.states || [],
    agents: patch.agents !== undefined ? normalizeAgentDefs(patch.agents) : current?.agents || [],
    savedAt: Date.now()
  }

  try {
    storage.setItem(LIVE_CACHE_KEY, JSON.stringify(next))
    if (options.notify) {
      window.dispatchEvent(new CustomEvent(CONVERSATIONAL_AGENT_LIVE_CACHE_EVENT, { detail: next }))
    }
  } catch {
    // La API sigue siendo la fuente de verdad; el cache solo evita parpadeos.
  }
}

function updateCachedAgentState(state: ConversationAgentState) {
  const current = readConversationalAgentLiveCache()
  const states = current?.states || []
  writeConversationalAgentLiveCache({
    states: [
      state,
      ...states.filter((item) => item.contactId !== state.contactId)
    ]
  }, { notify: true })
}

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('auth_token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(`/api/conversational-agent${endpoint}`), {
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
  async getConfig(): Promise<ConversationalAgentConfig> {
    const config = normalizeAgentConfig(await request<ConversationalAgentConfig>('/config'))
    writeConversationalAgentLiveCache({ config })
    return config
  },

  async saveConfig(config: ConversationalAgentConfigInput): Promise<ConversationalAgentConfig> {
    const next = normalizeAgentConfig(await request<ConversationalAgentConfig>('/config', {
      method: 'POST',
      body: JSON.stringify(config)
    }))
    writeConversationalAgentLiveCache({ config: next }, { notify: true })
    return next
  },

  listAIProviders(): Promise<ConversationalAIProviderStatus[]> {
    return request<ConversationalAIProviderStatus[]>('/ai-providers')
  },

  connectAIProvider(providerId: ConversationalAIProviderId, apiKey: string): Promise<ConversationalAIProviderStatus[]> {
    return request<ConversationalAIProviderStatus[]>(`/ai-providers/${encodeURIComponent(providerId)}`, {
      method: 'POST',
      body: JSON.stringify({ apiKey })
    })
  },

  deleteAIProvider(providerId: ConversationalAIProviderId): Promise<ConversationalAIProviderStatus[]> {
    return request<ConversationalAIProviderStatus[]>(`/ai-providers/${encodeURIComponent(providerId)}`, {
      method: 'DELETE'
    })
  },

  async listAgents(): Promise<ConversationalAgentDef[]> {
    const agents = normalizeAgentDefs(await request<ConversationalAgentDef[]>('/agents'))
    writeConversationalAgentLiveCache({ agents })
    return agents
  },

  getFilterOptions(): Promise<AgentFilterOptions> {
    return request<AgentFilterOptions>('/filter-options')
  },

  getMetrics(): Promise<ConversationalAgentMetrics> {
    return request<ConversationalAgentMetrics>('/metrics')
  },

  async createAgent(input: ConversationalAgentDefInput = {}): Promise<ConversationalAgentDef> {
    const agent = normalizeAgentDef(await request<ConversationalAgentDef>('/agents', {
      method: 'POST',
      body: JSON.stringify(input)
    }))
    const current = readConversationalAgentLiveCache()
    writeConversationalAgentLiveCache({ agents: [...(current?.agents || []), agent] }, { notify: true })
    return agent
  },

  async updateAgent(agentId: string, input: ConversationalAgentDefInput): Promise<ConversationalAgentDef> {
    const agent = normalizeAgentDef(await request<ConversationalAgentDef>(`/agents/${encodeURIComponent(agentId)}`, {
      method: 'PUT',
      body: JSON.stringify(input)
    }))
    const current = readConversationalAgentLiveCache()
    if (current) {
      writeConversationalAgentLiveCache({
        agents: current.agents.map((item) => (item.id === agent.id ? agent : item))
      }, { notify: true })
    }
    return agent
  },

  async deleteAgent(agentId: string): Promise<void> {
    await request(`/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })
    const current = readConversationalAgentLiveCache()
    if (current) {
      writeConversationalAgentLiveCache({
        agents: current.agents.filter((agent) => agent.id !== agentId)
      }, { notify: true })
    }
  },

  async listStates(params: { signal?: string; statuses?: string[] } = {}): Promise<ConversationAgentState[]> {
    const search = new URLSearchParams()
    if (params.signal) search.set('signal', params.signal)
    if (params.statuses?.length) search.set('statuses', params.statuses.join(','))
    const query = search.toString()
    const states = await request<ConversationAgentState[]>(`/states${query ? `?${query}` : ''}`)
    if (!params.signal && !params.statuses?.length) {
      writeConversationalAgentLiveCache({ states })
    }
    return states
  },

  getState(contactId: string): Promise<ConversationAgentState | null> {
    return request<ConversationAgentState | null>(`/states/${encodeURIComponent(contactId)}`)
  },

  async updateState(
    contactId: string,
    action: ConversationStateAction,
    options: { agentId?: string } = {}
  ): Promise<ConversationAgentState> {
    const state = await request<ConversationAgentState>(`/states/${encodeURIComponent(contactId)}`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...(options.agentId ? { agentId: options.agentId } : {})
      })
    })
    updateCachedAgentState(state)
    return state
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
