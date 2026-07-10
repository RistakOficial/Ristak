import {
  getDefaultConversationalModel,
  getKnownConversationalAIProvider,
  getKnownConversationalModel,
  type ConversationalAIProviderId
} from '@/constants/conversationalAIProviders'
import {
  DEFAULT_AGENT_GOAL_WORKFLOW,
  type AgentCompletionMode,
  type AgentGoalWorkflowConfig,
  type AgentIdentityMode,
  type AgentReplyDeliveryConfig,
  type AgentReplyDeliveryMode,
  type AgentResponseDelayConfig,
  type AgentResponseDelayMode,
  type AgentResponseDelayUnit,
  type AgentSalesPaymentMode,
  type ConversationalAgentDefInput,
  type ConversationalContactScope,
  type ConversationalLanguageLevel,
  type ConversationalObjective,
  type ConversationalPersuasionLevel,
  type ConversationalSuccessAction
} from '@/services/conversationalAgentService'

export interface AgentWizardDraft {
  name: string
  aiProvider: ConversationalAIProviderId
  model: string
  objective: ConversationalObjective
  customObjective: string
  identityMode: AgentIdentityMode
  identityCustomName: string
  successAction: ConversationalSuccessAction
  requiredData: string
  persuasionLevel: ConversationalPersuasionLevel
  languageLevel: ConversationalLanguageLevel
  calendarId: string | null
  paymentMode: AgentSalesPaymentMode
  askDeposit: boolean
  depositAmount: number | null
  contactScope: ConversationalContactScope
  extraInstructions: string
  handoffRules: string
  responseDelay: AgentResponseDelayConfig
  replyDelivery: AgentReplyDeliveryConfig
  hideAttendedNotifications: boolean
  completionMode: AgentCompletionMode
  completionUserId: string
  completionUserName: string
  goalUrl: string
  trackingParam: string
  identityUserId: string
  identityUserName: string
}

export const DEFAULT_AGENT_RESPONSE_DELAY: AgentResponseDelayConfig = {
  mode: 'none',
  fixedValue: 10,
  fixedUnit: 'seconds',
  minValue: 1,
  maxValue: 10,
  rangeUnit: 'minutes'
}

export const DEFAULT_AGENT_REPLY_DELIVERY: AgentReplyDeliveryConfig = {
  mode: 'split',
  splitMessagesEnabled: true,
  minMessageLengthToSplit: 120,
  maxBubbles: 6,
  minBubbleLength: 20,
  maxBubbleLength: 350,
  targetChars: 350,
  randomizeSplitting: true,
  delayBetweenBubblesEnabled: true,
  minDelaySeconds: 2,
  maxDelaySeconds: 7
}

const DEFAULT_TRACKING_PARAM = 'ristak_goal_id'

function normalizeDelayMode(value?: unknown): AgentResponseDelayMode {
  return value === 'fixed' || value === 'random' ? value : 'none'
}

function normalizeDelayUnit(value?: unknown): AgentResponseDelayUnit {
  return value === 'minutes' ? 'minutes' : 'seconds'
}

function normalizeReplyDeliveryMode(value?: unknown): AgentReplyDeliveryMode {
  return value === 'single' ? 'single' : 'split'
}

function normalizeCompletionMode(value?: unknown): AgentCompletionMode {
  return value === 'assign_user' ? 'assign_user' : 'notify_only'
}

export function buildInitialAgentWizardDraft(
  defaultName: string,
  defaults: { aiProvider?: ConversationalAIProviderId; model?: string } = {}
): AgentWizardDraft {
  const defaultProvider = getKnownConversationalAIProvider(defaults.aiProvider)
  const defaultModel = getKnownConversationalModel(
    defaultProvider,
    defaults.model || getDefaultConversationalModel(defaultProvider)
  )

  return {
    name: defaultName,
    aiProvider: defaultProvider,
    model: defaultModel,
    objective: 'citas',
    customObjective: '',
    identityMode: 'business',
    identityCustomName: '',
    identityUserId: '',
    identityUserName: '',
    successAction: 'ready_for_human',
    requiredData: '',
    persuasionLevel: 'medium',
    languageLevel: 'intermediate',
    calendarId: null,
    paymentMode: 'full_payment',
    askDeposit: false,
    depositAmount: null,
    contactScope: 'new_only',
    extraInstructions: '',
    handoffRules: '',
    responseDelay: { ...DEFAULT_AGENT_RESPONSE_DELAY },
    replyDelivery: { ...DEFAULT_AGENT_REPLY_DELIVERY },
    hideAttendedNotifications: false,
    completionMode: 'notify_only',
    completionUserId: '',
    completionUserName: '',
    goalUrl: '',
    trackingParam: DEFAULT_TRACKING_PARAM
  }
}

export function isAgentWizardCitasBooking(draft: AgentWizardDraft) {
  return draft.objective === 'citas' && draft.successAction === 'book_appointment'
}

export function isAgentWizardVentasCharging(draft: AgentWizardDraft) {
  return draft.objective === 'ventas' && draft.successAction === 'ready_to_buy'
}

export function buildGoalWorkflowFromDraft(draft: AgentWizardDraft, accountCurrency: string): AgentGoalWorkflowConfig {
  const workflow: AgentGoalWorkflowConfig = {
    ...DEFAULT_AGENT_GOAL_WORKFLOW,
    appointments: { ...DEFAULT_AGENT_GOAL_WORKFLOW.appointments },
    sales: { ...DEFAULT_AGENT_GOAL_WORKFLOW.sales },
    data: { ...DEFAULT_AGENT_GOAL_WORKFLOW.data },
    qualification: { ...DEFAULT_AGENT_GOAL_WORKFLOW.qualification },
    triggerLink: { ...DEFAULT_AGENT_GOAL_WORKFLOW.triggerLink },
    deposit: { ...DEFAULT_AGENT_GOAL_WORKFLOW.deposit },
    completion: { ...DEFAULT_AGENT_GOAL_WORKFLOW.completion }
  }

  if (isAgentWizardCitasBooking(draft)) {
    workflow.appointments = { ...workflow.appointments, owner: 'ai', calendarId: draft.calendarId }
    if (draft.askDeposit) {
      workflow.deposit = { ...workflow.deposit, enabled: true, mode: 'fixed', amount: draft.depositAmount, currency: accountCurrency }
    }
  }

  if (isAgentWizardVentasCharging(draft)) {
    workflow.sales = { ...workflow.sales, owner: 'ai', paymentMode: draft.paymentMode, currency: accountCurrency }
    if (draft.paymentMode === 'deposit') {
      workflow.deposit = { ...workflow.deposit, enabled: true, mode: 'fixed', amount: draft.depositAmount, currency: accountCurrency }
    }
  }

  if (draft.objective === 'citas' && draft.successAction === 'send_goal_url') {
    workflow.appointments = {
      ...workflow.appointments,
      owner: 'url',
      calendarId: draft.calendarId,
      url: draft.goalUrl.trim(),
      trackingParam: draft.trackingParam.trim() || DEFAULT_TRACKING_PARAM
    }
  }

  if (draft.objective === 'ventas' && draft.successAction === 'send_goal_url') {
    workflow.sales = {
      ...workflow.sales,
      owner: 'url',
      url: draft.goalUrl.trim(),
      trackingParam: draft.trackingParam.trim() || DEFAULT_TRACKING_PARAM,
      currency: accountCurrency
    }
  }

  workflow.completion = {
    ...workflow.completion,
    mode: normalizeCompletionMode(draft.completionMode),
    userId: draft.completionMode === 'assign_user' ? draft.completionUserId.trim() : '',
    userName: draft.completionMode === 'assign_user' ? draft.completionUserName.trim() : ''
  }

  return workflow
}

export function buildOverridesFromDraft(
  draft: AgentWizardDraft,
  accountCurrency: string,
  fallbackName: string,
  defaults: { aiProvider?: ConversationalAIProviderId; model?: string } = {}
): ConversationalAgentDefInput {
  const selectedProvider = getKnownConversationalAIProvider(defaults.aiProvider || draft.aiProvider)
  const selectedModel = getKnownConversationalModel(
    selectedProvider,
    defaults.model || draft.model || getDefaultConversationalModel(selectedProvider)
  )

  return {
    name: draft.name.trim() || fallbackName,
    aiProvider: selectedProvider,
    model: selectedModel,
    objective: draft.objective,
    customObjective: draft.objective === 'custom' ? draft.customObjective.trim() : '',
    identityMode: draft.identityMode,
    identityCustomName: draft.identityMode === 'custom' ? draft.identityCustomName.trim() : '',
    identityUserId: draft.identityMode === 'user' ? draft.identityUserId.trim() : '',
    identityUserName: draft.identityMode === 'user' ? draft.identityUserName.trim() : '',
    successAction: draft.successAction,
    requiredData: draft.requiredData.trim(),
    handoffRules: draft.handoffRules.trim(),
    persuasionLevel: draft.persuasionLevel,
    languageLevel: draft.languageLevel,
    extraInstructions: draft.extraInstructions.trim(),
    responseDelay: {
      ...DEFAULT_AGENT_RESPONSE_DELAY,
      ...draft.responseDelay,
      mode: normalizeDelayMode(draft.responseDelay.mode),
      fixedUnit: normalizeDelayUnit(draft.responseDelay.fixedUnit),
      rangeUnit: normalizeDelayUnit(draft.responseDelay.rangeUnit)
    },
    replyDelivery: {
      ...DEFAULT_AGENT_REPLY_DELIVERY,
      ...draft.replyDelivery,
      mode: normalizeReplyDeliveryMode(draft.replyDelivery.mode),
      splitMessagesEnabled: draft.replyDelivery.mode === 'split' || Boolean(draft.replyDelivery.splitMessagesEnabled)
    },
    hideAttended: false,
    hideAttendedNotifications: draft.hideAttendedNotifications,
    goalWorkflow: buildGoalWorkflowFromDraft(draft, accountCurrency),
    defaultCalendarId: isAgentWizardCitasBooking(draft) ? draft.calendarId : null,
    contactScope: draft.contactScope
  }
}
