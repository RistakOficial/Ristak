import type { ConversationalAIProviderId } from '@/constants/conversationalAIProviders'
import {
  DEFAULT_AGENT_GOAL_WORKFLOW,
  type AgentGoalWorkflowConfig,
  type AgentIdentityMode,
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
}

export function buildInitialAgentWizardDraft(defaultName: string): AgentWizardDraft {
  return {
    name: defaultName,
    objective: 'citas',
    customObjective: '',
    identityMode: 'business',
    identityCustomName: '',
    successAction: 'ready_for_human',
    requiredData: '',
    persuasionLevel: 'high',
    languageLevel: 'intermediate',
    calendarId: null,
    paymentMode: 'full_payment',
    askDeposit: false,
    depositAmount: null,
    contactScope: 'all'
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

  return workflow
}

export function buildOverridesFromDraft(
  draft: AgentWizardDraft,
  accountCurrency: string,
  fallbackName: string,
  defaults: { aiProvider?: ConversationalAIProviderId; model?: string } = {}
): ConversationalAgentDefInput {
  return {
    name: draft.name.trim() || fallbackName,
    objective: draft.objective,
    customObjective: draft.objective === 'custom' ? draft.customObjective.trim() : '',
    identityMode: draft.identityMode,
    identityCustomName: draft.identityMode === 'custom' ? draft.identityCustomName.trim() : '',
    successAction: draft.successAction,
    requiredData: draft.requiredData.trim(),
    persuasionLevel: draft.persuasionLevel,
    languageLevel: draft.languageLevel,
    goalWorkflow: buildGoalWorkflowFromDraft(draft, accountCurrency),
    defaultCalendarId: isAgentWizardCitasBooking(draft) ? draft.calendarId : null,
    contactScope: draft.contactScope,
    ...(defaults.aiProvider ? { aiProvider: defaults.aiProvider } : {}),
    ...(defaults.model ? { model: defaults.model } : {})
  }
}
