import {
  getDefaultConversationalModel,
  getKnownConversationalAIProvider,
  getKnownConversationalModel,
  type ConversationalAIProviderId
} from '@/constants/conversationalAIProviders'
import {
  DEFAULT_AGENT_ATTENTION,
  DEFAULT_AGENT_DEPOSIT_METHODS,
  DEFAULT_AGENT_GOAL_WORKFLOW,
  DEFAULT_CONVERSATIONAL_PROMPT_CONFIG,
  DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS,
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
  type ConversationalCapabilitiesConfig,
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
  productId: string
  priceId: string
  productName: string
  priceName: string
  priceAmount: number | null
  askDeposit: boolean
  depositAmount: number | null
  depositPaymentLink: boolean
  depositBankTransfer: boolean
  depositBankTransferDetails: string
  contactScope: ConversationalContactScope
  extraInstructions: string
  handoffRules: string
  pastClientsToHuman: boolean
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
    productId: '',
    priceId: '',
    productName: '',
    priceName: '',
    priceAmount: null,
    askDeposit: false,
    depositAmount: null,
    depositPaymentLink: DEFAULT_AGENT_DEPOSIT_METHODS.paymentLink,
    depositBankTransfer: DEFAULT_AGENT_DEPOSIT_METHODS.bankTransfer,
    depositBankTransferDetails: '',
    contactScope: 'new_only',
    extraInstructions: DEFAULT_CONVERSATIONAL_USER_INSTRUCTIONS,
    handoffRules: '',
    pastClientsToHuman: false,
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

function buildWizardEditableInstructions(draft: AgentWizardDraft) {
  const sections = [draft.extraInstructions.trim()]
  if (draft.requiredData.trim()) {
    sections.push([
      'Datos o criterios que debes obtener y confirmar durante la conversación:',
      draft.requiredData.trim()
    ].join('\n'))
  }
  return sections.filter(Boolean).join('\n\n')
}

function buildWizardHandoffRules(draft: AgentWizardDraft) {
  const rules = [draft.handoffRules.trim()]
  if (draft.objective === 'citas' && draft.successAction === 'ready_for_human') {
    rules.push('Cuando la persona quiera agendar y ya estén claros sus datos necesarios, pasa la conversación al equipo para concretar la cita.')
  }
  if (draft.objective === 'ventas' && draft.successAction === 'ready_for_human') {
    rules.push('Cuando la persona quiera comprar y ya estén claros el producto o servicio que necesita, pasa la conversación al equipo para concretar la venta.')
  }
  return rules.filter(Boolean).join('\n')
}

function buildWizardCustomGoalDescription(draft: AgentWizardDraft) {
  if (draft.objective === 'datos') {
    return `Reúne y confirma estos datos antes de entregar la conversación al equipo:\n${draft.requiredData.trim()}`
  }
  if (draft.objective === 'filtrar') {
    return `Confirma estos criterios de calificación y entrega la conversación al equipo únicamente cuando se cumplan:\n${draft.requiredData.trim()}`
  }
  return draft.customObjective.trim()
}

export function buildGoalWorkflowFromDraft(draft: AgentWizardDraft, accountCurrency: string): AgentGoalWorkflowConfig {
  const workflow: AgentGoalWorkflowConfig = {
    ...DEFAULT_AGENT_GOAL_WORKFLOW,
    appointments: { ...DEFAULT_AGENT_GOAL_WORKFLOW.appointments },
    sales: { ...DEFAULT_AGENT_GOAL_WORKFLOW.sales },
    data: { ...DEFAULT_AGENT_GOAL_WORKFLOW.data },
    qualification: { ...DEFAULT_AGENT_GOAL_WORKFLOW.qualification },
    triggerLink: { ...DEFAULT_AGENT_GOAL_WORKFLOW.triggerLink },
    deposit: { ...DEFAULT_AGENT_GOAL_WORKFLOW.deposit, methods: { ...DEFAULT_AGENT_DEPOSIT_METHODS } },
    completion: { ...DEFAULT_AGENT_GOAL_WORKFLOW.completion },
    attention: { ...DEFAULT_AGENT_ATTENTION, pastClientsToHuman: draft.pastClientsToHuman }
  }

  const buildDepositFromDraft = (): AgentGoalWorkflowConfig['deposit'] => ({
    ...workflow.deposit,
    enabled: true,
    mode: 'fixed',
    amount: draft.depositAmount,
    currency: accountCurrency,
    methods: {
      paymentLink: draft.depositPaymentLink,
      bankTransfer: draft.depositBankTransfer
    },
    bankTransferDetails: draft.depositBankTransfer ? draft.depositBankTransferDetails.trim() : ''
  })

  // El calendario aplica a TODAS las variantes de citas: agenda un humano, la IA o un enlace.
  if (draft.objective === 'citas') {
    workflow.appointments = { ...workflow.appointments, calendarId: draft.calendarId }
  }

  if (draft.objective === 'ventas') {
    workflow.sales = {
      ...workflow.sales,
      productId: draft.productId,
      priceId: draft.priceId,
      productName: draft.productName,
      priceName: draft.priceName,
      amount: draft.priceAmount,
      currency: accountCurrency
    }
  }

  if (isAgentWizardCitasBooking(draft)) {
    workflow.appointments = { ...workflow.appointments, owner: 'ai', calendarId: draft.calendarId }
    if (draft.askDeposit) {
      workflow.deposit = buildDepositFromDraft()
    }
  }

  if (isAgentWizardVentasCharging(draft)) {
    workflow.sales = { ...workflow.sales, owner: 'ai', paymentMode: draft.paymentMode, currency: accountCurrency }
    if (draft.paymentMode === 'deposit') {
      workflow.deposit = buildDepositFromDraft()
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

export function buildCapabilitiesFromDraft(
  draft: AgentWizardDraft,
  accountCurrency: string
): ConversationalCapabilitiesConfig {
  const workflow = buildGoalWorkflowFromDraft(draft, accountCurrency)
  const items: ConversationalCapabilitiesConfig['items'] = []

  if (isAgentWizardCitasBooking(draft)) {
    items.push({
      id: 'schedule_appointment',
      enabled: true,
      calendarId: draft.calendarId || '',
      allowOverlaps: false
    })
  }

  if (isAgentWizardVentasCharging(draft) || (isAgentWizardCitasBooking(draft) && draft.askDeposit)) {
    items.push({
      id: 'collect_payment',
      enabled: true,
      productId: workflow.sales.productId,
      priceId: workflow.sales.priceId,
      paymentMode: draft.objective === 'ventas' ? draft.paymentMode : 'deposit',
      amount: workflow.sales.amount,
      currency: accountCurrency,
      deposit: workflow.deposit
    })
  }

  if (draft.successAction === 'send_goal_url' || draft.successAction === 'send_trigger_link') {
    items.push({
      id: 'send_link',
      enabled: true,
      // El runtime nuevo no usa contact_id editable como prueba de cierre. Un
      // enlace configurado se envía de forma segura y la meta sólo se completa
      // cuando exista evidencia autenticada aparte.
      linkKind: 'verified_goal',
      triggerLinkId: workflow.triggerLink.triggerLinkId,
      url: draft.goalUrl.trim(),
      trackingParam: draft.trackingParam.trim() || DEFAULT_TRACKING_PARAM
    })
  }

  items.push({
    id: 'handoff_human',
    enabled: true,
    rules: buildWizardHandoffRules(draft),
    userId: draft.completionMode === 'assign_user' ? draft.completionUserId.trim() : '',
    userName: draft.completionMode === 'assign_user' ? draft.completionUserName.trim() : '',
    pastClientsToHuman: draft.pastClientsToHuman
  })

  if (draft.objective === 'custom' || draft.objective === 'datos' || draft.objective === 'filtrar') {
    items.push({
      id: 'custom_goal',
      enabled: true,
      description: buildWizardCustomGoalDescription(draft),
      completion: draft.successAction === 'send_trigger_link' ? 'send_link' : 'handoff'
    })
  }

  return { schemaVersion: 1, items }
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
  const editableInstructions = buildWizardEditableInstructions(draft)

  return {
    name: draft.name.trim() || fallbackName,
    runtimeMode: 'tool_calling_v2',
    promptConfig: {
      ...DEFAULT_CONVERSATIONAL_PROMPT_CONFIG,
      editableText: editableInstructions
    },
    capabilitiesConfig: buildCapabilitiesFromDraft(draft, accountCurrency),
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
    extraInstructions: editableInstructions,
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
    defaultCalendarId: draft.objective === 'citas' ? draft.calendarId : null,
    contactScope: draft.contactScope
  }
}
