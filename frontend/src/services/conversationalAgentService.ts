import type { ConversationalAIProviderId } from '@/constants/conversationalAIProviders'
import { apiUrl } from './apiBaseUrl'

export type ConversationalObjective = 'citas' | 'ventas' | 'datos' | 'filtrar' | 'custom'
export type ConversationalSuccessAction = 'book_appointment' | 'ready_for_human' | 'ready_to_buy' | 'send_goal_url' | 'send_trigger_link' | 'internal_signal' | 'none'
export type ConversationStatus = 'active' | 'paused' | 'human' | 'skipped' | 'completed' | 'discarded'
export type ConversationSignal = 'ready_for_human' | 'ready_to_schedule' | 'ready_to_buy' | 'appointment_booked' | 'purchase_completed' | 'discarded'
export type ClosingStrategyMode = 'system' | 'custom'
export type ConversationalPersuasionLevel = 'low' | 'medium' | 'high'
export type ConversationalLanguageLevel = 'professional' | 'intermediate' | 'colloquial'
export type AgentResponseDelayMode = 'none' | 'fixed' | 'random'
export type AgentResponseDelayUnit = 'seconds' | 'minutes'
export type AgentReplyDeliveryMode = 'single' | 'split'
export type AgentFollowUpUnit = 'minutes' | 'hours'

export const CONVERSATIONAL_AGENT_ENTRY_CONFLICT_CODE = 'CONVERSATIONAL_AGENT_ENTRY_CONFLICT'

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

export interface ConversationalAgentEntryConflict {
  agentId: string
  agentName: string
  candidateName: string
  candidateEntry: string
  existingEntry: string
  reason: string
}

export class ConversationalAgentRequestError extends Error {
  code?: string
  conflicts?: ConversationalAgentEntryConflict[]
  businessPromptStatus?: ConversationalBusinessPromptStatus

  constructor(message: string, payload: Record<string, any> | null = null) {
    super(message)
    this.name = 'ConversationalAgentRequestError'
    this.code = payload?.code
    this.conflicts = Array.isArray(payload?.conflicts) ? payload.conflicts : undefined
    this.businessPromptStatus = payload?.businessPromptStatus
  }
}

export function isConversationalAgentEntryConflictError(error: unknown): error is ConversationalAgentRequestError {
  return (
    error instanceof ConversationalAgentRequestError &&
    error.code === CONVERSATIONAL_AGENT_ENTRY_CONFLICT_CODE
  )
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

export interface AgentFollowUpStepConfig {
  enabled: boolean
  value: number
  unit: AgentFollowUpUnit
}

export interface AgentFollowUpConfig {
  enabled: boolean
  first: AgentFollowUpStepConfig
  second: AgentFollowUpStepConfig
  strategy: string
}

export type AgentGoalOwner = 'human' | 'ai' | 'url'
export type AgentDepositMode = 'fixed' | 'range'
export type AgentSalesPaymentMode = 'full_payment' | 'deposit'
export type AgentCompletionMode = 'notify_only' | 'assign_user'
export type AgentIdentityMode = 'business' | 'user' | 'custom' | 'agent'

export interface AgentGoalWorkflowConfig {
  appointments: {
    owner: AgentGoalOwner
    calendarId: string | null
    url: string
    trackingParam: string
    allowOverlappingAppointments: boolean
  }
  sales: {
    owner: AgentGoalOwner
    productId: string
    priceId: string
    productName: string
    priceName: string
    amount: number | null
    currency: string
    paymentMode: AgentSalesPaymentMode
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
  deposit: {
    enabled: boolean
    mode: AgentDepositMode
    amount: number | null
    minAmount: number | null
    maxAmount: number | null
    currency: string
  }
  completion: {
    mode: AgentCompletionMode
    userId: string
    userName: string
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
  persuasionLevel: ConversationalPersuasionLevel
  languageLevel: ConversationalLanguageLevel
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
  persuasionLevel?: ConversationalPersuasionLevel
  languageLevel?: ConversationalLanguageLevel
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

export type ConditionChannel = 'chat' | 'whatsapp' | 'instagram' | 'messenger' | 'webchat' | 'sms' | 'email'
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
  identityMode: AgentIdentityMode
  identityUserId: string
  identityUserName: string
  identityCustomName: string
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
  persuasionLevel: ConversationalPersuasionLevel
  languageLevel: ConversationalLanguageLevel
  systemClosingStrategy?: string
  responseDelay: AgentResponseDelayConfig
  replyDelivery: AgentReplyDeliveryConfig
  followUp: AgentFollowUpConfig
  goalWorkflow: AgentGoalWorkflowConfig
  filters: AgentFilters
  createdAt: string | null
  updatedAt: string | null
}

export type ConversationalAgentDefInput = Partial<Omit<ConversationalAgentDef, 'id' | 'createdAt' | 'updatedAt' | 'systemClosingStrategy'>>

export interface ConversationAgentState {
  id?: string | null
  contactId: string
  agentId: string | null
  agentName?: string | null
  status: ConversationStatus
  pausedUntilAt?: string | null
  signal: ConversationSignal | null
  signalReason: string | null
  signalSummary: string | null
  signalAt: string | null
  lastInboundMessageId: string | null
  lastAnsweredInboundMessageId: string | null
  lastReplyAt: string | null
  followUpBaseMessageId?: string | null
  followUpSentCount?: number
  followUpLastSentAt?: string | null
  activatedAt?: string | null
  activationSource?: 'manual' | 'automatic' | string | null
  activatedBy?: string | null
  updatedBy: string | null
  agentEnabled?: boolean | null
  agentHideAttendedNotifications?: boolean | null
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

export type ConversationalAgentTestAttachmentKind = 'image' | 'audio' | 'video' | 'document' | 'pdf' | 'text' | 'file'

export interface ConversationalAgentTestAttachment {
  kind: ConversationalAgentTestAttachmentKind
  name: string
  mimeType?: string
  size?: number
  dataUrl?: string
  thumbnailDataUrl?: string
  text?: string
  durationMs?: number
}

export interface ConversationalAgentTestMessage {
  role: 'user' | 'assistant'
  content: string
  attachments?: ConversationalAgentTestAttachment[]
}

export interface ConversationalAgentEvent {
  id: string
  contactId: string | null
  eventType: string
  detail: unknown
  createdAt: string
}

export interface ConversationalAgentCompletionEvent {
  id: string
  contactId: string | null
  signal: Exclude<ConversationSignal, 'discarded'>
  icon: string
  title: string
  actionSummary: string
  summary: string
  reason: string
  status: string
  createdAt: string
  agentId: string | null
  objectiveCompleted: boolean
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

export interface ResetAgentSkippedContactsResult {
  agentId: string
  resetCount: number
}

export interface ConversationalAgentLiveCache {
  config: ConversationalAgentConfig | null
  states: ConversationAgentState[]
  agents: ConversationalAgentDef[]
  savedAt: number
}

export const CONVERSATIONAL_AGENT_LIVE_CACHE_EVENT = 'ristak-conversational-agent-live-cache'

const LIVE_CACHE_KEY = 'ristak_conversational_agent_live_cache_v1'
const VALID_AGENT_IDENTITY_MODES = new Set<AgentIdentityMode>(['business', 'user', 'custom', 'agent'])
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
const COMPLETION_SIGNAL_META: Record<Exclude<ConversationSignal, 'discarded'>, { label: string; icon: string }> = {
  ready_for_human: { label: 'Objetivo concretado', icon: '✅' },
  ready_to_schedule: { label: 'Listo para agendar', icon: '📅' },
  ready_to_buy: { label: 'Listo para cobrar', icon: '💳' },
  appointment_booked: { label: 'Cita agendada', icon: '📅' },
  purchase_completed: { label: 'Pago completado', icon: '💰' }
}
const COMPLETION_SIGNAL_SET = new Set<Exclude<ConversationSignal, 'discarded'>>(Object.keys(COMPLETION_SIGNAL_META) as Array<Exclude<ConversationSignal, 'discarded'>>)

export const DEFAULT_AGENT_GOAL_WORKFLOW: AgentGoalWorkflowConfig = {
  appointments: {
    owner: 'human',
    calendarId: null,
    url: '',
    trackingParam: 'ristak_goal_id',
    allowOverlappingAppointments: false
  },
  sales: {
    owner: 'human',
    productId: '',
    priceId: '',
    productName: '',
    priceName: '',
    amount: null,
    currency: '',
    paymentMode: 'full_payment',
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
  },
  deposit: {
    enabled: false,
    mode: 'fixed',
    amount: null,
    minAmount: null,
    maxAmount: null,
    currency: ''
  },
  completion: {
    mode: 'notify_only',
    userId: '',
    userName: ''
  }
}

const DEFAULT_AGENT_FOLLOW_UP: AgentFollowUpConfig = {
  enabled: false,
  first: {
    enabled: true,
    value: 30,
    unit: 'minutes'
  },
  second: {
    enabled: false,
    value: 2,
    unit: 'hours'
  },
  strategy: [
    'Lee el historial y el contexto actual antes de escribir.',
    'Abre la conversación con un solo mensaje natural, corto y contextual.',
    'No menciones que es seguimiento automático ni que pasó cierto tiempo.',
    'Retoma el último punto útil que dejó la persona y deja una razón clara para responder.',
    'No cobres, no agendes y no ejecutes acciones de avance en este mensaje.'
  ].join(' ')
}

function normalizeConversationalSuccessAction(value?: unknown): ConversationalSuccessAction {
  const action = String(value || '').trim() as ConversationalSuccessAction
  return VALID_CONVERSATIONAL_SUCCESS_ACTIONS.has(action) ? action : 'ready_for_human'
}

function normalizeConversationalAIProvider(value?: unknown): ConversationalAIProviderId {
  const provider = String(value || '').trim().toLowerCase() as ConversationalAIProviderId
  return VALID_CONVERSATIONAL_AI_PROVIDERS.has(provider) ? provider : 'openai'
}

function normalizeAgentIdentityMode(value?: unknown): AgentIdentityMode {
  const mode = String(value || '').trim() as AgentIdentityMode
  return VALID_AGENT_IDENTITY_MODES.has(mode) ? mode : 'business'
}

function normalizeShortText(value?: unknown, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength)
}

function normalizeConversationalPersuasionLevel(value?: unknown): ConversationalPersuasionLevel {
  const level = String(value || '').trim().toLowerCase()
  return level === 'low' || level === 'medium' || level === 'high' ? level : 'high'
}

function normalizeConversationalLanguageLevel(value?: unknown): ConversationalLanguageLevel {
  const level = String(value || '').trim().toLowerCase()
  return level === 'professional' || level === 'intermediate' || level === 'colloquial' ? level : 'intermediate'
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
  const appointments = (agent.goalWorkflow?.appointments || {}) as Partial<AgentGoalWorkflowConfig['appointments']> & {
    allow_overlapping_appointments?: unknown
    allowOverlaps?: unknown
    allow_overlaps?: unknown
  }
  const allowOverlappingAppointments = [
    appointments.allowOverlappingAppointments,
    appointments.allow_overlapping_appointments,
    appointments.allowOverlaps,
    appointments.allow_overlaps
  ].some((value) => {
    const normalized = String(value || '').trim().toLowerCase()
    return value === true || value === 1 || ['1', 'true', 'yes', 'on'].includes(normalized)
  })

  return {
    ...agent,
    aiProvider: normalizeConversationalAIProvider(agent.aiProvider),
    identityMode: normalizeAgentIdentityMode(agent.identityMode),
    identityUserId: normalizeShortText(agent.identityUserId),
    identityUserName: normalizeShortText(agent.identityUserName),
    identityCustomName: normalizeShortText(agent.identityCustomName),
    successAction: normalizeConversationalSuccessAction(agent.successAction),
    persuasionLevel: normalizeConversationalPersuasionLevel(agent.persuasionLevel),
    languageLevel: normalizeConversationalLanguageLevel(agent.languageLevel),
    followUp: {
      ...DEFAULT_AGENT_FOLLOW_UP,
      ...((agent.followUp || {}) as Partial<AgentFollowUpConfig>),
      first: {
        ...DEFAULT_AGENT_FOLLOW_UP.first,
        ...((agent.followUp?.first || {}) as Partial<AgentFollowUpStepConfig>)
      },
      second: {
        ...DEFAULT_AGENT_FOLLOW_UP.second,
        ...((agent.followUp?.second || {}) as Partial<AgentFollowUpStepConfig>)
      }
    },
    goalWorkflow: {
      ...DEFAULT_AGENT_GOAL_WORKFLOW,
      ...((agent.goalWorkflow || {}) as Partial<AgentGoalWorkflowConfig>),
      appointments: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.appointments,
        ...appointments,
        allowOverlappingAppointments
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
      },
      deposit: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.deposit,
        ...((agent.goalWorkflow?.deposit || {}) as Partial<AgentGoalWorkflowConfig['deposit']>)
      },
      completion: {
        ...DEFAULT_AGENT_GOAL_WORKFLOW.completion,
        ...((agent.goalWorkflow?.completion || {}) as Partial<AgentGoalWorkflowConfig['completion']>)
      }
    }
  }
}

function normalizeAgentDefs(agents: ConversationalAgentDef[] = []) {
  return agents.map(normalizeAgentDef)
}

function getRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return value === null || value === undefined ? '' : String(value).trim()
}

const LEGACY_COMPLETION_LABELS = [
  'Resultado',
  'Motivo',
  'Situacion',
  'Situación',
  'Por que ahora',
  'Por qué ahora',
  'Fondo detectado',
  'Ya intento',
  'Ya intentó',
  'Impacto',
  'Freno',
  'Quiere lograr',
  'Quiere evitar',
  'Urgencia',
  'Decision',
  'Decisión',
  'Interes',
  'Interés',
  'Disponibilidad',
  'Notas',
  'Resumen'
]

function getLegacyCompletionValue(text: string, label: string) {
  const marker = `${label}:`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const valueStart = start + marker.length
  let end = text.length
  for (const candidate of LEGACY_COMPLETION_LABELS) {
    if (candidate === label) continue
    const next = text.indexOf(`. ${candidate}:`, valueStart)
    if (next >= 0 && next < end) end = next
  }
  return text.slice(valueStart, end).replace(/^\s+|\s+$/g, '')
}

function formatHumanDateFromSummary(summary = '') {
  const match = summary.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  if (!match) return ''
  const date = new Date(match[0])
  if (Number.isNaN(date.getTime())) return ''
  try {
    const parts = new Intl.DateTimeFormat('es-MX', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).formatToParts(date)
    const get = (type: string) => parts.find((part) => part.type === type)?.value || ''
    const weekday = get('weekday')
    const day = get('day')
    const month = get('month')
    const hour = get('hour')
    const minute = get('minute')
    const period = get('dayPeriod').replace(/\s+/g, '').toLowerCase()
    if (!day || !month || !hour || !minute) return ''
    const clock = minute === '00' ? `${hour} ${period}` : `${hour}:${minute} ${period}`
    return `el ${weekday ? `${weekday} ` : ''}${day} de ${month} a las ${clock}`
  } catch {
    return ''
  }
}

function parseCompactPayment(summary = '') {
  const match = summary.match(/(?:^|[·\s])([0-9]+(?:[.,][0-9]+)?)\s*([A-Z]{3})?\s*$/)
  if (!match) return ''
  const amount = Number(match[1].replace(',', '.'))
  if (!Number.isFinite(amount) || amount <= 0) return ''
  const formatted = amount.toLocaleString('es-MX', {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: amount % 1 === 0 ? 0 : 2
  })
  return `$${formatted}${match[2] ? ` ${match[2]}` : ''}`
}

function buildLegacyActionSummary(signal: Exclude<ConversationSignal, 'discarded'>, summary: string, reason: string) {
  const result = getLegacyCompletionValue(summary, 'Resultado') || summary
  if (signal === 'appointment_booked') {
    const date = formatHumanDateFromSummary(result)
    return date ? `Agendó cita para ${date}` : 'Agendó una cita'
  }
  if (signal === 'purchase_completed') {
    const money = parseCompactPayment(result)
    return money ? `Pagó ${money}` : 'Pago completado'
  }
  if (signal === 'ready_to_buy') return 'Quedó listo para pagar'
  if (signal === 'ready_to_schedule') return 'Quedó listo para agendar'
  return reason || result || 'Objetivo concretado'
}

function normalizeCompletionEvent(event: ConversationalAgentEvent): ConversationalAgentCompletionEvent | null {
  if (event.eventType !== 'signal_set' || !event.detail || typeof event.detail !== 'object') return null
  const detail = event.detail as Record<string, unknown>
  const signal = getRecordString(detail, 'signal') as Exclude<ConversationSignal, 'discarded'>
  if (!COMPLETION_SIGNAL_SET.has(signal)) return null

  const status = getRecordString(detail, 'status')
  const agentId = getRecordString(detail, 'agentId') || null
  const objectiveCompleted = detail.objectiveCompleted === true
  if (status !== 'completed' || !agentId || !objectiveCompleted) return null

  const meta = COMPLETION_SIGNAL_META[signal]
  const rawSummary = getRecordString(detail, 'summary')
  const reason = getRecordString(detail, 'reason')
  const actionSummary = getRecordString(detail, 'actionSummary') || buildLegacyActionSummary(signal, rawSummary, reason)
  const summary = Object.prototype.hasOwnProperty.call(detail, 'summary')
    ? rawSummary
    : reason
  return {
    id: event.id,
    contactId: event.contactId,
    signal,
    icon: meta.icon,
    title: meta.label,
    actionSummary: actionSummary || meta.label,
    summary,
    reason,
    status,
    createdAt: event.createdAt,
    agentId,
    objectiveCompleted
  }
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
  const sameState = (item: ConversationAgentState) => (
    item.id && state.id
      ? item.id === state.id
      : item.contactId === state.contactId && (item.agentId || '') === (state.agentId || '')
  )
  writeConversationalAgentLiveCache({
    states: [
      state,
      ...states.filter((item) => !sameState(item))
    ]
  }, { notify: true })
}

function applyCachedAgentUpdate(agent: ConversationalAgentDef) {
  const current = readConversationalAgentLiveCache()
  if (!current) return

  writeConversationalAgentLiveCache({
    agents: current.agents.map((item) => (item.id === agent.id ? agent : item)),
    states: current.states.map((state) => (
      state.agentId === agent.id
        ? {
            ...state,
            agentName: agent.name || state.agentName,
            agentEnabled: agent.enabled,
            agentHideAttendedNotifications: agent.hideAttendedNotifications
          }
        : state
    ))
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
    throw new ConversationalAgentRequestError(
      payload?.error || payload?.message || 'Error en el agente conversacional',
      payload
    )
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
    applyCachedAgentUpdate(agent)
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

  async resetAgentSkippedContacts(agentId: string): Promise<ResetAgentSkippedContactsResult> {
    const result = await request<ResetAgentSkippedContactsResult>(`/agents/${encodeURIComponent(agentId)}/reset-skipped`, {
      method: 'POST'
    })
    const current = readConversationalAgentLiveCache()
    if (current) {
      const updatedAt = new Date().toISOString()
      writeConversationalAgentLiveCache({
        states: current.states.map((state) => (
          state.agentId === agentId && state.status === 'skipped'
            ? { ...state, status: 'active', pausedUntilAt: null, updatedBy: 'user', updatedAt }
            : state
        ))
      }, { notify: true })
    }
    return result
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

  getStates(contactId: string): Promise<ConversationAgentState[]> {
    return request<ConversationAgentState[]>(`/states/${encodeURIComponent(contactId)}?includeAll=1`)
  },

  async updateState(
    contactId: string,
    action: ConversationStateAction,
    options: { agentId?: string; pausedUntilAt?: string } = {}
  ): Promise<ConversationAgentState> {
    const state = await request<ConversationAgentState>(`/states/${encodeURIComponent(contactId)}`, {
      method: 'POST',
      body: JSON.stringify({
        action,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(options.pausedUntilAt ? { pausedUntilAt: options.pausedUntilAt } : {})
      })
    })
    updateCachedAgentState(state)
    return state
  },

  testAgent(
    messages: ConversationalAgentTestMessage[],
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

  listEvents(params: { contactId?: string; limit?: number; kind?: 'completion' } = {}): Promise<ConversationalAgentEvent[]> {
    const search = new URLSearchParams()
    if (params.contactId) search.set('contactId', params.contactId)
    if (params.limit) search.set('limit', String(params.limit))
    if (params.kind) search.set('kind', params.kind)
    const query = search.toString()
    return request<ConversationalAgentEvent[]>(`/events${query ? `?${query}` : ''}`)
  },

  async listCompletionEvents(params: { contactId?: string; limit?: number } = {}): Promise<ConversationalAgentCompletionEvent[]> {
    const events = await conversationalAgentService.listEvents({ ...params, kind: 'completion' })
    return events
      .map(normalizeCompletionEvent)
      .filter((event): event is ConversationalAgentCompletionEvent => Boolean(event))
  }
}
