import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Bot, CalendarCheck, CheckCircle2, ChevronDown, CircleSlash, CreditCard, FileText, Image as ImageIcon, KeyRound, Link2, LockKeyhole, Pause, PauseCircle, Play, Plus, RotateCcw, ShieldCheck, Target, Trash2, UserCheck, Users, Video, Wand2, X } from 'lucide-react'
import { Badge, Button, Card, CustomSelect, KpiCard, Modal, NumberInput, PageHeader, Switch, TabList, TagPicker } from '@/components/common'
import {
  PhoneChatPreview,
  PhoneChatPreviewAttachmentMenu,
  PhoneChatPreviewComposer,
  PhoneChatPreviewDraftAttachments,
  PhoneChatPreviewEmojiPicker,
  PhoneChatPreviewVoiceComposer,
  type PhoneChatPreviewAttachment,
  type PhoneChatPreviewMessage
} from '@/components/phone/PhoneChatPreview'
import {
  conversationalAIProviderOptions,
  getConversationalAIProviderOption,
  getConversationalModelLabel,
  getDefaultConversationalModel,
  getKnownConversationalAIProvider,
  getKnownConversationalModel,
  type ConversationalAIProviderId
} from '@/constants/conversationalAIProviders'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useAIAgentAvailability, useAppConfig } from '@/hooks'
import {
  conversationalAgentService,
  isConversationalAgentEntryConflictError,
  DEFAULT_AGENT_ATTENTION,
  DEFAULT_AGENT_DEPOSIT_METHODS,
  DEFAULT_CONVERSATIONAL_PROMPT_CONFIG,
  type AgentAttentionConfig,
  type AgentFilterOptions,
  type AgentCompletionMode,
  type AgentDepositMethodsConfig,
  type AgentDepositMode,
  type AgentIdentityMode,
  type AgentFollowUpConfig,
  type AgentFollowUpStepConfig,
  type AgentFollowUpUnit,
  type AgentGoalWorkflowConfig,
  type AgentReplyDeliveryConfig,
  type AgentReplyDeliveryMode,
  type AgentResponseDelayConfig,
  type AgentResponseDelayMode,
  type AgentResponseDelayUnit,
  type AgentSalesPaymentMode,
  type AgentSuccessExtra,
  type ConversationalAIProviderStatus,
  type ConversationalBusinessPromptStatus,
  type ConversationalAgentConfig,
  type ConversationalAgentDef,
  type ConversationalAgentDefInput,
  type ConversationalAgentEntryConflict,
  type ConversationalCapabilitiesConfig,
  type ConversationalCapabilityId,
  type ConversationalCapabilityItem,
  type ConversationalCapabilityManifestItem,
  type ConversationalAgentMetrics,
  type ConversationalContactScope,
  type ConversationalLanguageLevel,
  type ConversationalPersuasionLevel,
  type ConversationalAgentTestAttachment,
  type ConversationalAgentTestMessage,
  type ConversationalAgentTestResult,
  type ConversationalObjective,
  type ConversationalSuccessAction,
  type SuccessExtraType
} from '@/services/conversationalAgentService'
import { ACCOUNT_CURRENCY_CONFIG_KEY, getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import { userAccessService, type TeamUser } from '@/services/userAccessService'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import { triggerLinksService, type TriggerLink } from '@/services/triggerLinksService'
import apiClient from '@/services/apiClient'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
import { formatCurrency } from '@/utils/format'
import { ConditionBuilder } from './ConditionBuilder'
import { AgentCreationWizard } from './AgentCreationWizard'
import styles from './AIAgentSettings.module.css'
import { describeConversationalPreviewAction } from './conversationalPreviewAction'

const AUTOSAVE_DELAY_MS = 900
const DEFAULT_CONVERSATIONAL_AGENT_ROUTE_BASE = '/ai-agent/conversational'

const buildConversationalAgentPath = (agentId?: string | null, routeBase = DEFAULT_CONVERSATIONAL_AGENT_ROUTE_BASE) => (
  agentId ? `${routeBase}/${encodeURIComponent(agentId)}` : routeBase
)

const objectiveOptions: Array<{ value: ConversationalObjective; label: string; description: string }> = [
  { value: 'citas', label: 'Agendar citas', description: 'Debe llevar a la persona hasta una cita. Ejemplo: que termine pidiendo día y hora.' },
  { value: 'ventas', label: 'Cerrar ventas', description: 'Debe llevar a la persona a comprar. Ejemplo: que pida cómo pagar.' },
  { value: 'datos', label: 'Pedir datos', description: 'Debe pedir lo que falte. Ejemplo: nombre, teléfono o correo.' },
  { value: 'filtrar', label: 'Filtrar curiosos', description: 'Debe ver si la persona sí va en serio. Ejemplo: separar quien pregunta nomás por ver.' },
  { value: 'custom', label: 'Objetivo propio', description: 'Escribe tú la meta. Ejemplo: que pida una propuesta formal.' }
]

// Iniciativa: cuánto guía hacia el siguiente paso sin sacrificar claridad ni consentimiento.
const persuasionLevelTabs: Array<{ value: ConversationalPersuasionLevel; label: string; description: string }> = [
  { value: 'low', label: 'Atención', description: 'Resuelve y orienta; sólo propone avanzar cuando la persona lo pide claramente.' },
  { value: 'medium', label: 'Guía', description: 'Entiende la situación y facilita el siguiente paso con tacto. Recomendado.' },
  { value: 'high', label: 'Proactivo', description: 'Detecta oportunidades y propone avanzar cuando hay evidencia, sin presionar.' }
]
const persuasionLevelHelp: Record<ConversationalPersuasionLevel, string> = {
  low: 'Prioriza responder y deja respirar. Avanza sólo cuando la persona lo pide explícitamente.',
  medium: 'Acompaña y guía con mano ligera, siempre resolviendo antes de proponer.',
  high: 'Propone el siguiente paso con más iniciativa, pero sólo cuando hay señales suficientes y sin presión.'
}

// Lenguaje: el registro con el que habla. Fuerza la calibración del guion.
const languageLevelTabs: Array<{ value: ConversationalLanguageLevel; label: string; description: string }> = [
  { value: 'professional', label: 'Ejecutivo', description: 'Pulido, formal y cuidado, pero siempre humano. Para marcas premium y tratos serios.' },
  { value: 'intermediate', label: 'Cómplice', description: 'Natural y cercano, ni acartonado ni vulgar. El punto dulce (recomendado).' },
  { value: 'colloquial', label: 'Casual', description: 'Relajado y de chat, adaptándose a la persona sin forzar modismos.' }
]
const languageLevelHelp: Record<ConversationalLanguageLevel, string> = {
  professional: 'Sube la pulcritud: frases completas, sin abreviaciones ni modismos corrientes.',
  intermediate: 'Deja que el agente calibre el tono al interlocutor y al giro del negocio, como hoy.',
  colloquial: 'Usa un ritmo informal y natural; los modismos sólo aparecen si la persona ya los usa.'
}

const agentIdentityModeOptions: Array<{ value: AgentIdentityMode; label: string; description: string }> = [
  { value: 'business', label: 'Representante del negocio', description: 'Habla como equipo: nosotros te podemos ayudar.' },
  { value: 'user', label: 'Persona del equipo', description: 'Se presenta con el nombre de un administrador o usuario.' },
  { value: 'custom', label: 'Nombre personalizado', description: 'Escribes exactamente cómo debe decir que se llama.' },
  { value: 'agent', label: 'Nombre del agente', description: 'Usa el nombre configurado arriba para presentarse.' }
]

const successActionLabels: Record<ConversationalSuccessAction, { label: string; description: string }> = {
  book_appointment: { label: 'Que la cita quede agendada', description: 'El agendamiento se confirma sólo cuando ya hay día, hora y calendario reales.' },
  ready_for_human: { label: 'Que un humano lo confirme', description: 'La IA detecta intención real y pasa el chat al equipo para confirmar el objetivo.' },
  ready_to_buy: { label: 'Que se confirme el pago', description: 'La venta se confirma cuando el pago real queda validado.' },
  send_goal_url: { label: 'Mandar enlace verificable', description: 'Manda un enlace conectado a Ristak y espera la confirmación real de la cita o el pago.' },
  send_trigger_link: { label: 'Mandar enlace y detenerse', description: 'Manda un enlace y se detiene cuando lo tocan. Ejemplo: link de WhatsApp, formulario o página.' },
  internal_signal: { label: 'Que un humano lo confirme', description: 'La IA detecta intención real y pasa el chat al equipo para confirmar el objetivo.' },
  none: { label: 'Que un humano lo confirme', description: 'La IA detecta intención real y pasa el chat al equipo para confirmar el objetivo.' }
}

type GoalExecutionOption = {
  value: ConversationalSuccessAction
  label: string
  description: string
}

const goalExecutionOptionsByObjective: Record<ConversationalObjective, GoalExecutionOption[]> = {
  citas: [
    { value: 'ready_for_human', label: 'Un humano', description: 'La IA detecta intención real, detiene el bot y avisa para que el equipo agende.' },
    { value: 'book_appointment', label: 'El agente IA', description: 'La IA confirma un horario real y agenda la cita en el calendario.' },
    { value: 'send_goal_url', label: 'La IA mandando un enlace', description: 'La IA manda un enlace conectado a Ristak y la meta se completa sólo cuando la cita queda confirmada.' }
  ],
  ventas: [
    { value: 'ready_for_human', label: 'Un humano', description: 'La IA detecta intención de compra, detiene el bot y avisa para que el equipo cierre.' },
    { value: 'ready_to_buy', label: 'El agente IA', description: 'La IA guía el pago y la venta se completa cuando el pago queda confirmado.' },
    { value: 'send_goal_url', label: 'La IA mandando un enlace', description: 'La IA manda un enlace conectado a Ristak y la meta se completa sólo cuando el pago queda confirmado.' }
  ],
  datos: [
    { value: 'ready_for_human', label: 'Un humano', description: 'La IA junta los datos y avisa para que el equipo continúe.' }
  ],
  filtrar: [
    { value: 'ready_for_human', label: 'Un humano', description: 'La IA filtra la conversación y avisa cuando la persona ya vale atención.' }
  ],
  custom: [
    { value: 'ready_for_human', label: 'Un humano', description: 'La IA detecta que el objetivo está listo y avisa al equipo.' },
    { value: 'send_trigger_link', label: 'La IA mandando un enlace', description: 'La IA manda un enlace y detiene el bot cuando la persona lo abre.' }
  ]
}

const DEFAULT_GOAL_TRACKING_PARAM = 'ristak_goal_id'

const attendedChatActionOptions = [
  {
    value: 'keep_visible',
    label: 'Sí',
    description: 'Sí, avísame cuando lleguen mensajes aunque el agente IA esté tomando la conversación.'
  },
  {
    value: 'mute_only',
    label: 'No',
    description: 'No, silencia las notificaciones hasta que el agente IA termine o pase el chat al equipo.'
  }
] as const

type AttendedChatActionValue = (typeof attendedChatActionOptions)[number]['value']

const depositModeOptions: Array<{ value: AgentDepositMode; label: string }> = [
  { value: 'fixed', label: 'Valor único' },
  { value: 'range', label: 'Rango' }
]

const salesPaymentModeOptions: Array<{ value: AgentSalesPaymentMode; label: string }> = [
  { value: 'full_payment', label: 'Venta completa' },
  { value: 'deposit', label: 'Solicitar anticipo' }
]

const appointmentOverlapOptions: Array<{ value: BinaryChoice; label: string }> = [
  { value: 'no', label: 'No, cuidar horarios únicos' },
  { value: 'yes', label: 'Sí, permitir mismo horario' }
]

const completionModeOptions: Array<{ value: AgentCompletionMode; label: string }> = [
  { value: 'notify_only', label: 'Pasar a humano y notificar' },
  { value: 'assign_user', label: 'Asignar usuario y notificar' }
]

const extraTypeOptions: Array<{ value: SuccessExtraType; label: string }> = [
  { value: 'add_tag', label: 'Agregar etiqueta' },
  { value: 'remove_tag', label: 'Quitar etiqueta' },
  { value: 'set_custom_field', label: 'Cambiar campo personalizado' }
]

const responseDelayModeOptions: Array<{ value: AgentResponseDelayMode; label: string }> = [
  { value: 'none', label: 'No esperar' },
  { value: 'fixed', label: 'Esperar tiempo fijo' },
  { value: 'random', label: 'Aleatorio en un rango' }
]

const responseDelayUnitOptions: Array<{ value: AgentResponseDelayUnit; label: string }> = [
  { value: 'seconds', label: 'Segundos' },
  { value: 'minutes', label: 'Minutos' }
]

type BinaryChoice = 'yes' | 'no'

const binaryChoiceOptions: Array<{ value: BinaryChoice; label: string }> = [
  { value: 'yes', label: 'Sí' },
  { value: 'no', label: 'No' }
]

const followUpUnitOptions: Array<{ value: AgentFollowUpUnit; label: string }> = [
  { value: 'minutes', label: 'Minutos' },
  { value: 'hours', label: 'Horas' }
]

const defaultResponseDelay: AgentResponseDelayConfig = {
  mode: 'none',
  fixedValue: 10,
  fixedUnit: 'seconds',
  minValue: 1,
  maxValue: 10,
  rangeUnit: 'minutes'
}

const defaultReplyDelivery: AgentReplyDeliveryConfig = {
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

const MAX_FOLLOW_UP_MINUTES = 23 * 60
const defaultFollowUpStrategy = [
  'Lee el historial y el contexto actual antes de escribir.',
  'Abre la conversación con un solo mensaje natural, corto y contextual.',
  'No menciones que es seguimiento automático ni que pasó cierto tiempo.',
  'Retoma el último punto útil que dejó la persona y deja una razón clara para responder.',
  'No cobres, no agendes y no ejecutes acciones de avance en este mensaje.'
].join(' ')

const defaultFollowUp: AgentFollowUpConfig = {
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
  strategy: defaultFollowUpStrategy
}

const defaultGoalWorkflow: AgentGoalWorkflowConfig = {
  appointments: {
    owner: 'human',
    calendarId: null,
    url: '',
    trackingParam: DEFAULT_GOAL_TRACKING_PARAM,
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
    trackingParam: DEFAULT_GOAL_TRACKING_PARAM
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
    currency: '',
    methods: { ...DEFAULT_AGENT_DEPOSIT_METHODS },
    bankTransferDetails: ''
  },
  completion: {
    mode: 'notify_only',
    userId: '',
    userName: ''
  },
  attention: { ...DEFAULT_AGENT_ATTENTION }
}

interface ProductPrice {
  id?: string
  _id?: string
  localId?: string
  name?: string
  amount?: number
  price?: number
  currency?: string
}

interface ProductItem {
  id?: string
  _id?: string
  localId?: string
  name: string
  description?: string
  currency?: string
  prices?: ProductPrice[]
}

function getProductId(product?: ProductItem | null) {
  return product?.id || product?._id || product?.localId || ''
}

function getPriceId(price?: ProductPrice | null) {
  return price?.id || price?._id || price?.localId || ''
}

function getPrimaryPrice(product?: ProductItem | null) {
  return Array.isArray(product?.prices) ? product.prices[0] || null : null
}

function getPriceAmount(price?: ProductPrice | null) {
  return Number(price?.amount ?? price?.price ?? 0) || 0
}

function normalizeCurrencyCode(value?: string | null) {
  return String(value || '').trim().toUpperCase().slice(0, 12)
}

function getWorkflowSalesPaymentMode(workflow: {
  sales?: Partial<AgentGoalWorkflowConfig['sales']>
  deposit?: Partial<AgentGoalWorkflowConfig['deposit']>
}): AgentSalesPaymentMode {
  const paymentMode = workflow.sales?.paymentMode
  if (paymentMode === 'deposit' || paymentMode === 'full_payment') return paymentMode
  return workflow.deposit?.enabled ? 'deposit' : 'full_payment'
}

function getSuccessActionInfo(
  action: ConversationalSuccessAction,
  objective: ConversationalObjective,
  workflow?: AgentGoalWorkflowConfig
) {
  const salesPaymentMode = workflow ? getWorkflowSalesPaymentMode(workflow) : 'full_payment'
  const requiresAppointmentDeposit = objective === 'citas' && Boolean(workflow?.deposit?.enabled)

  if (action === 'send_trigger_link') {
    return {
      label: 'Mandar enlace y detenerse',
      description: 'Manda un enlace y se detiene cuando la persona lo toca. Ejemplo: link de formulario o página.'
    }
  }
  if (action === 'ready_for_human') {
    if (objective === 'citas') {
      return {
        label: requiresAppointmentDeposit ? 'Que un humano valide el anticipo y confirme la cita' : 'Que un humano confirme la cita',
        description: requiresAppointmentDeposit
          ? 'La IA pide comprobante del anticipo y pasa el chat cuando el equipo debe validar y confirmar.'
          : 'La IA detecta que ya quiere agendar y pasa el chat al equipo para concretar.'
      }
    }
    if (objective === 'ventas') {
      return {
        label: salesPaymentMode === 'deposit' ? 'Que un humano valide el anticipo y cierre la venta' : 'Que un humano confirme la venta',
        description: salesPaymentMode === 'deposit'
          ? 'La IA pide comprobante del anticipo y pasa el chat para que el equipo valide y cierre.'
          : 'La IA detecta intención de compra y pasa el chat al equipo para confirmar el pago.'
      }
    }
    if (objective === 'datos') {
      return {
        label: 'Que el equipo reciba los datos',
        description: 'La IA junta los datos clave y pasa el chat al equipo.'
      }
    }
    if (objective === 'filtrar') {
      return {
        label: 'Que el equipo reciba al contacto filtrado',
        description: 'La IA califica la conversación y pasa al equipo sólo lo que ya vale atender.'
      }
    }
  }
  if (action === 'book_appointment') {
    return {
      label: requiresAppointmentDeposit ? 'Que se valide el anticipo y la cita quede agendada' : 'Que la cita quede agendada',
      description: requiresAppointmentDeposit
        ? 'La IA sólo agenda después de recibir comprobante del anticipo y confirmar un horario real.'
        : 'La IA confirma horario real y agenda la cita en el calendario.'
    }
  }
  if (action === 'ready_to_buy' && objective === 'ventas') {
    return {
      label: salesPaymentMode === 'deposit' ? 'Que se valide el comprobante del anticipo' : 'Que se confirme el pago completo',
      description: salesPaymentMode === 'deposit'
        ? 'La venta avanza cuando el contacto manda comprobante y el monto coincide con el anticipo configurado.'
        : 'La venta se concreta cuando el pago real queda confirmado o el comprobante coincide con el valor del producto.'
    }
  }
  if (action !== 'send_goal_url') return successActionLabels[action] || successActionLabels.ready_for_human
  if (objective === 'citas') {
    return {
      label: requiresAppointmentDeposit ? 'Que se valide el anticipo y el enlace confirme la cita' : 'Que el enlace confirme la cita',
      description: requiresAppointmentDeposit
        ? 'La IA manda el enlace sólo después del comprobante; la meta se confirma cuando el enlace devuelve la cita real.'
        : 'La meta se confirma cuando el enlace devuelve la cita real.'
    }
  }
  if (objective === 'ventas') {
    return {
      label: salesPaymentMode === 'deposit' ? 'Que se valide el anticipo y el enlace confirme la compra' : 'Que el enlace confirme el pago',
      description: salesPaymentMode === 'deposit'
        ? 'La IA manda el enlace sólo después del comprobante; la meta se confirma cuando llega la compra o pago real.'
        : 'La meta se confirma cuando el enlace devuelve la compra o pago real.'
    }
  }
  return successActionLabels.send_goal_url
}

function toMetricNumber(value: unknown) {
  const nextValue = Number(value)
  return Number.isFinite(nextValue) ? nextValue : 0
}

function formatMetricInteger(value: unknown) {
  return Math.max(0, Math.round(toMetricNumber(value))).toLocaleString('es-MX')
}

function formatMetricPercent(value: unknown) {
  const percent = Math.max(0, Math.min(100, Math.round(toMetricNumber(value))))
  return `${percent}%`
}

function normalizePositivePlanLimit(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.floor(number)
}

function getConversationalDashboardMetrics(
  metrics: ConversationalAgentMetrics | null,
  agents: ConversationalAgentDef[]
) {
  return {
    totalAgents: agents.length,
    activeAgents: agents.filter((agent) => agent.enabled).length,
    agentsWithAssignedConversations: metrics?.agentsWithAssignedConversations ?? 0,
    assignedConversations: metrics?.assignedConversations ?? 0,
    completedConversations: metrics?.completedConversations ?? 0,
    successRate: metrics?.successRate ?? 0,
    errorEvents: metrics?.errorEvents ?? 0,
    skippedConversations: metrics?.skippedConversations ?? 0,
    pausedConversations: metrics?.pausedConversations ?? 0
  }
}

function objectiveCanConfigurePaymentRequirement(objective: ConversationalObjective) {
  return objective === 'citas' || objective === 'ventas'
}

function getGoalExecutionOptions(objective: ConversationalObjective) {
  return goalExecutionOptionsByObjective[objective] || goalExecutionOptionsByObjective.custom
}

function getSelectedGoalExecutionInfo(
  action: ConversationalSuccessAction,
  objective: ConversationalObjective,
  workflow?: AgentGoalWorkflowConfig
) {
  const options = getGoalExecutionOptions(objective)
  return options.find((option) => option.value === action) ||
    options.find((option) => option.value === getObjectiveSuccessAction(objective, workflow || defaultGoalWorkflow)) ||
    options[0]
}

function getGoalExecutionQuestion(objective: ConversationalObjective) {
  if (objective === 'citas') return '¿Quién debería agendar la cita?'
  if (objective === 'ventas') return '¿Quién debería cerrar el pago?'
  if (objective === 'datos') return '¿Quién debería recibir los datos?'
  if (objective === 'filtrar') return '¿Quién debería atender al contacto filtrado?'
  return '¿Quién debería completar el objetivo?'
}

const systemReplyDeliveryDefaults: Pick<
  AgentReplyDeliveryConfig,
  'minMessageLengthToSplit' | 'maxBubbles' | 'minBubbleLength' | 'maxBubbleLength' | 'targetChars' | 'randomizeSplitting' | 'delayBetweenBubblesEnabled'
> = {
  minMessageLengthToSplit: defaultReplyDelivery.minMessageLengthToSplit,
  maxBubbles: defaultReplyDelivery.maxBubbles,
  minBubbleLength: defaultReplyDelivery.minBubbleLength,
  maxBubbleLength: defaultReplyDelivery.maxBubbleLength,
  targetChars: defaultReplyDelivery.targetChars,
  randomizeSplitting: true,
  delayBetweenBubblesEnabled: true
}

const MAX_TEST_REPLY_DELAY_MS = 60_000
const MAX_TEST_ATTACHMENT_BYTES = 18 * 1024 * 1024
const MAX_TEST_TEXT_ATTACHMENT_BYTES = 750 * 1024
const MAX_TEST_ATTACHMENTS = 6
const TEST_VIDEO_THUMBNAIL_MAX_SIZE = 900
const TEST_MEDIA_TTL_MS = 30 * 60 * 1000
const TEST_MEDIA_CACHE_DB_NAME = 'ristak_conversational_agent_practice_media'
const TEST_MEDIA_CACHE_STORE = 'practice-media'
const TEST_MEDIA_CACHE_PREFIX = 'agent-practice'
const TEST_MEDIA_EXPIRED_NOTICE = 'Expiró el contenido de prueba. Reinicia el chat o recarga la ventana para continuar con las pruebas.'
const MIN_TEST_VOICE_RECORDING_MS = 600
const MAX_TEST_VOICE_RECORDING_MS = 3 * 60 * 1000
const TEST_VOICE_WAVE_BAR_COUNT = 38
const TEST_VOICE_WAVE_MIN_HEIGHT = 4
const TEST_VOICE_WAVE_MAX_HEIGHT = 30
const TEST_VOICE_WAVE_UPDATE_MS = 55
const TEST_VOICE_WAVE_SILENCE_THRESHOLD = 3
const TEST_VOICE_WAVE_SIGNAL_RANGE = 28
const TEST_PHOTO_ATTACHMENT_ACCEPT = 'image/*'
const TEST_VIDEO_ATTACHMENT_ACCEPT = 'video/*'
const TEST_FILE_ATTACHMENT_ACCEPT = [
  'audio/*',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  '.json',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/json'
].join(',')
const TEST_VOICE_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4'
]
const TEST_TEXT_EXTENSIONS = new Set(['txt', 'csv', 'json', 'md', 'html', 'xml'])

type TestAttachment = ConversationalAgentTestAttachment & PhoneChatPreviewAttachment & {
  id: string
  cacheKey?: string
  uploadedAt?: number
  expiresAt?: number
}
type TestMessage = {
  role: 'user' | 'assistant'
  content: string
  attachments?: TestAttachment[]
  internal?: boolean
}

function createTestMediaCacheKey(id: string) {
  return `${TEST_MEDIA_CACHE_PREFIX}:${id}`
}

function createTestMediaExpiry(now = Date.now()) {
  return {
    uploadedAt: now,
    expiresAt: now + TEST_MEDIA_TTL_MS
  }
}

function openTestMediaCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB no disponible'))
      return
    }

    const request = indexedDB.open(TEST_MEDIA_CACHE_DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(TEST_MEDIA_CACHE_STORE)) {
        db.createObjectStore(TEST_MEDIA_CACHE_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('No se pudo abrir cache local'))
  })
}

async function saveTestAttachmentToLocalCache(attachment: TestAttachment) {
  if (!attachment.cacheKey) return
  const db = await openTestMediaCache()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(TEST_MEDIA_CACHE_STORE, 'readwrite')
    const store = transaction.objectStore(TEST_MEDIA_CACHE_STORE)
    store.put({ ...attachment, cachedAt: Date.now() }, attachment.cacheKey)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo guardar cache local'))
  }).finally(() => db.close())
}

async function clearExpiredTestMediaCache(now = Date.now()) {
  const db = await openTestMediaCache()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(TEST_MEDIA_CACHE_STORE, 'readwrite')
    const store = transaction.objectStore(TEST_MEDIA_CACHE_STORE)
    const request = store.openCursor()

    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const value = cursor.value as Partial<TestAttachment> | undefined
      if (Number(value?.expiresAt || 0) <= now) {
        cursor.delete()
      }
      cursor.continue()
    }
    request.onerror = () => reject(request.error || new Error('No se pudo limpiar cache local'))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo limpiar cache local'))
  }).finally(() => db.close())
}

async function clearTestMediaCache() {
  const db = await openTestMediaCache()
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(TEST_MEDIA_CACHE_STORE, 'readwrite')
    transaction.objectStore(TEST_MEDIA_CACHE_STORE).clear()
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error || new Error('No se pudo limpiar cache local'))
  }).finally(() => db.close())
}

function cacheTestAttachment(attachment: TestAttachment) {
  void saveTestAttachmentToLocalCache(attachment).catch(() => undefined)
}

function testAttachmentExpired(attachment: TestAttachment | null | undefined, now = Date.now()) {
  return Boolean(attachment?.expiresAt && attachment.expiresAt <= now)
}

function testMessageHasExpiredAttachment(message: TestMessage, now = Date.now()) {
  return (message.attachments || []).some((attachment) => testAttachmentExpired(attachment, now))
}

function getNextTestMediaExpiration(messages: TestMessage[], draftAttachments: TestAttachment[], voiceDraft: TestAttachment | null) {
  const expirations = [
    ...messages.flatMap((message) => (message.attachments || []).map((attachment) => attachment.expiresAt || 0)),
    ...draftAttachments.map((attachment) => attachment.expiresAt || 0),
    voiceDraft?.expiresAt || 0
  ].filter((value) => value > 0)

  return expirations.length ? Math.min(...expirations) : null
}

function getFileExtension(name = '') {
  const match = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)
  return match?.[1] || ''
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo'))
    reader.readAsDataURL(file)
  })
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el audio'))
    reader.readAsDataURL(blob)
  })
}

function createVideoThumbnailDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
      resolve('')
      return
    }

    const objectUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    let settled = false
    const timeoutId = window.setTimeout(() => finish(''), 5000)

    function cleanup() {
      window.clearTimeout(timeoutId)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(objectUrl)
    }

    function finish(value: string) {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    function drawFrame() {
      try {
        const sourceWidth = video.videoWidth || 0
        const sourceHeight = video.videoHeight || 0
        if (!sourceWidth || !sourceHeight) {
          finish('')
          return
        }

        const scale = Math.min(1, TEST_VIDEO_THUMBNAIL_MAX_SIZE / Math.max(sourceWidth, sourceHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(sourceWidth * scale))
        canvas.height = Math.max(1, Math.round(sourceHeight * scale))

        const context = canvas.getContext('2d')
        if (!context) {
          finish('')
          return
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        finish(canvas.toDataURL('image/jpeg', 0.82))
      } catch {
        finish('')
      }
    }

    video.muted = true
    video.playsInline = true
    video.preload = 'metadata'
    video.onerror = () => finish('')
    video.onloadeddata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      if (!duration || duration <= 0.25) {
        drawFrame()
      }
    }
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      const targetSecond = duration > 1.2 ? Math.min(1, duration - 0.1) : 0
      if (!targetSecond) return

      video.onseeked = () => drawFrame()
      try {
        video.currentTime = targetSecond
      } catch {
        drawFrame()
      }
    }

    video.src = objectUrl
    video.load()
  })
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el texto'))
    reader.readAsText(file)
  })
}

function inferTestAttachmentKind(file: File): ConversationalAgentTestAttachment['kind'] {
  const mimeType = file.type.toLowerCase()
  const extension = getFileExtension(file.name)
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (mimeType.startsWith('text/') || mimeType === 'application/json' || TEST_TEXT_EXTENSIONS.has(extension)) return 'text'
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension)) return 'document'
  return 'file'
}

function canReadTextAttachment(file: File) {
  const kind = inferTestAttachmentKind(file)
  return kind === 'text' && file.size <= MAX_TEST_TEXT_ATTACHMENT_BYTES
}

async function createTestAttachment(file: File): Promise<TestAttachment> {
  const kind = inferTestAttachmentKind(file)
  const [dataUrl, text, thumbnailDataUrl] = await Promise.all([
    readFileAsDataUrl(file),
    canReadTextAttachment(file) ? readFileAsText(file) : Promise.resolve(undefined),
    kind === 'video' ? createVideoThumbnailDataUrl(file) : Promise.resolve(undefined)
  ])
  const id = `test-attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const expiry = createTestMediaExpiry()
  return {
    id,
    kind,
    name: file.name || `archivo.${getFileExtension(file.name) || 'bin'}`,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    dataUrl,
    cacheKey: createTestMediaCacheKey(id),
    ...expiry,
    ...(thumbnailDataUrl ? { thumbnailDataUrl } : {}),
    ...(text ? { text: text.slice(0, 18_000) } : {})
  }
}

function toTestPayloadMessage(message: TestMessage): ConversationalAgentTestMessage {
  return {
    role: message.role,
    content: message.content,
    attachments: (message.attachments || []).map((attachment) => ({
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      dataUrl: attachment.dataUrl,
      thumbnailDataUrl: attachment.thumbnailDataUrl,
      text: attachment.text,
      durationMs: attachment.durationMs
    }))
  }
}

function getAttachmentMessageLabel(attachments: TestAttachment[] = []) {
  if (!attachments.length) return ''
  if (attachments.length === 1) {
    const [attachment] = attachments
    if (attachment.kind === 'audio') return 'Nota de voz'
    if (attachment.kind === 'image') return attachment.name || 'Imagen'
    if (attachment.kind === 'video') return attachment.name || 'Video'
    return attachment.name || 'Archivo'
  }
  return `${attachments.length} archivos adjuntos`
}

function getSupportedTestVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined') return ''
  return TEST_VOICE_MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ''
}

function createTestVoiceBars() {
  return Array.from({ length: TEST_VOICE_WAVE_BAR_COUNT }, () => TEST_VOICE_WAVE_MIN_HEIGHT)
}

function getTestVoiceBarHeight(samples: Uint8Array) {
  const average = samples.reduce((sum, value) => sum + Math.abs(value - 128), 0) / samples.length
  const gatedLevel = average <= TEST_VOICE_WAVE_SILENCE_THRESHOLD
    ? 0
    : Math.min(1, (average - TEST_VOICE_WAVE_SILENCE_THRESHOLD) / TEST_VOICE_WAVE_SIGNAL_RANGE)
  const responsiveLevel = Math.sqrt(gatedLevel)

  return Math.round(TEST_VOICE_WAVE_MIN_HEIGHT + responsiveLevel * (TEST_VOICE_WAVE_MAX_HEIGHT - TEST_VOICE_WAVE_MIN_HEIGHT))
}

function getTestVoiceAudioContextConstructor() {
  const audioWindow = window as Window & {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }

  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null
}

function normalizeTestResponseDelay(value: unknown) {
  const delayMs = Number(value)
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  return Math.round(delayMs)
}

function normalizeTestReplyDelay(value: unknown) {
  const delayMs = Number(value)
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 0
  return Math.min(Math.round(delayMs), MAX_TEST_REPLY_DELAY_MS)
}

function waitForTestReplyDelay(delayMs: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, delayMs))
}

function agentToInput(agent: ConversationalAgentDef): ConversationalAgentDefInput {
  const {
    id: _id,
    createdAt: _c,
    updatedAt: _u,
    systemClosingStrategy: _s,
    closingStrategyMode: _m,
    closingStrategyCustom: _custom,
    capabilityManifest: _capabilityManifest,
    migrationCapabilitiesConfig: _migrationCapabilitiesConfig,
    ...rest
  } = agent as ConversationalAgentDef & { systemClosingStrategy?: string }
  return rest
}

function getAgentResponseDelay(agent: ConversationalAgentDef): AgentResponseDelayConfig {
  return { ...defaultResponseDelay, ...((agent.responseDelay || {}) as Partial<AgentResponseDelayConfig>) }
}

function getAgentReplyDelivery(agent: ConversationalAgentDef): AgentReplyDeliveryConfig {
  return { ...defaultReplyDelivery, ...((agent.replyDelivery || {}) as Partial<AgentReplyDeliveryConfig>) }
}

function getAgentFollowUp(agent: ConversationalAgentDef): AgentFollowUpConfig {
  const followUp = (agent.followUp || {}) as Partial<AgentFollowUpConfig>
  return {
    ...defaultFollowUp,
    ...followUp,
    first: {
      ...defaultFollowUp.first,
      ...((followUp.first || {}) as Partial<AgentFollowUpStepConfig>),
      enabled: true
    },
    second: {
      ...defaultFollowUp.second,
      ...((followUp.second || {}) as Partial<AgentFollowUpStepConfig>)
    },
    strategy: String(followUp.strategy || defaultFollowUp.strategy)
  }
}

function getAgentGoalWorkflow(agent: ConversationalAgentDef): AgentGoalWorkflowConfig {
  const workflow = (agent.goalWorkflow || {}) as Partial<AgentGoalWorkflowConfig>
  const sales = (workflow.sales || {}) as Partial<AgentGoalWorkflowConfig['sales']>
  const deposit = (workflow.deposit || {}) as Partial<AgentGoalWorkflowConfig['deposit']>
  return {
    ...defaultGoalWorkflow,
    ...workflow,
    appointments: {
      ...defaultGoalWorkflow.appointments,
      ...((workflow.appointments || {}) as Partial<AgentGoalWorkflowConfig['appointments']>)
    },
    sales: {
      ...defaultGoalWorkflow.sales,
      ...sales,
      paymentMode: getWorkflowSalesPaymentMode({ sales, deposit })
    },
    data: {
      ...defaultGoalWorkflow.data,
      ...((workflow.data || {}) as Partial<AgentGoalWorkflowConfig['data']>)
    },
    qualification: {
      ...defaultGoalWorkflow.qualification,
      ...((workflow.qualification || {}) as Partial<AgentGoalWorkflowConfig['qualification']>)
    },
    triggerLink: {
      ...defaultGoalWorkflow.triggerLink,
      ...((workflow.triggerLink || {}) as Partial<AgentGoalWorkflowConfig['triggerLink']>)
    },
    deposit: {
      ...defaultGoalWorkflow.deposit,
      ...deposit,
      methods: {
        ...DEFAULT_AGENT_DEPOSIT_METHODS,
        ...((deposit.methods || {}) as Partial<AgentDepositMethodsConfig>)
      }
    },
    completion: {
      ...defaultGoalWorkflow.completion,
      ...((workflow.completion || {}) as Partial<AgentGoalWorkflowConfig['completion']>)
    },
    attention: {
      ...DEFAULT_AGENT_ATTENTION,
      ...((workflow.attention || {}) as Partial<AgentAttentionConfig>)
    }
  }
}

function getFollowUpDelayMinutes(step: AgentFollowUpStepConfig) {
  return Math.max(1, Number(step.value) || 1) * (step.unit === 'hours' ? 60 : 1)
}

function getFollowUpMaxValue(unit: AgentFollowUpUnit) {
  return unit === 'hours' ? 23 : MAX_FOLLOW_UP_MINUTES
}

function clampFollowUpStepValue(value: number, unit: AgentFollowUpUnit) {
  return Math.min(Math.max(Math.round(Number(value) || 1), 1), getFollowUpMaxValue(unit))
}

function getFollowUpStepLabel(step: AgentFollowUpStepConfig) {
  const value = Number(step.value) || 0
  if (step.unit === 'hours') return `${value} ${value === 1 ? 'hora' : 'horas'}`
  return `${value} ${value === 1 ? 'minuto' : 'minutos'}`
}

function getFollowUpError(followUp: AgentFollowUpConfig) {
  if (!followUp.enabled) return ''
  const firstDelay = getFollowUpDelayMinutes(followUp.first)
  if (firstDelay > MAX_FOLLOW_UP_MINUTES) return 'Revisa el tiempo del seguimiento.'
  if (followUp.second.enabled) {
    const secondDelay = getFollowUpDelayMinutes(followUp.second)
    if (secondDelay > MAX_FOLLOW_UP_MINUTES || secondDelay <= firstDelay) return 'Revisa el orden de los seguimientos.'
  }
  if (!followUp.strategy.trim()) return 'Falta la estrategia de seguimiento.'
  return ''
}

function getResponseDelayError(delay: AgentResponseDelayConfig) {
  if (delay.mode === 'random' && Number(delay.minValue) > Number(delay.maxValue)) return 'Revisa el rango de espera.'
  return ''
}

function getReplyDeliveryError(delivery: AgentReplyDeliveryConfig) {
  if ((delivery.splitMessagesEnabled || delivery.mode === 'split') && Number(delivery.minDelaySeconds) > Number(delivery.maxDelaySeconds)) {
    return 'Revisa el rango de pausa entre globos.'
  }
  return ''
}

function getAgentIdentityError(agent: ConversationalAgentDef) {
  if (agent.identityMode === 'custom' && !String(agent.identityCustomName || '').trim()) {
    return 'Escribe el nombre visible del agente.'
  }
  if (agent.identityMode === 'user' && !String(agent.identityUserName || agent.identityUserId || '').trim()) {
    return 'Elige la persona del equipo con la que se va a identificar.'
  }
  return ''
}

function getAgentCalendarError(agent: ConversationalAgentDef) {
  if (agent.objective !== 'citas') return ''
  const calendarId = agent.goalWorkflow?.appointments?.calendarId || agent.defaultCalendarId
  return calendarId ? '' : 'Elige el calendario para las citas antes de guardar.'
}

function getAgentDepositError(agent: ConversationalAgentDef) {
  const workflow = getAgentGoalWorkflow(agent)
  const depositApplies = (agent.objective === 'citas' && workflow.deposit.enabled) ||
    (agent.objective === 'ventas' && getWorkflowSalesPaymentMode(workflow) === 'deposit')
  if (!depositApplies) return ''
  const methods = workflow.deposit.methods || DEFAULT_AGENT_DEPOSIT_METHODS
  if (!methods.paymentLink && !methods.bankTransfer) return 'Activa al menos un método para cobrar el anticipo.'
  if (methods.bankTransfer && !String(workflow.deposit.bankTransferDetails || '').trim()) {
    return 'Escribe los datos de transferencia para el anticipo.'
  }
  return ''
}

function isSafeConversationalUrl(value: string) {
  try {
    const parsed = new URL(String(value || '').trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function getNativeCapabilityItemError(
  item: ConversationalCapabilityItem,
  allItems: ConversationalCapabilityItem[]
) {
  if (!item.enabled) return ''
  if (item.id === 'schedule_appointment' && !item.calendarId) return 'Selecciona el calendario de la capacidad para agendar.'
  if (item.id === 'collect_payment') {
    if (item.paymentMode === 'deposit' || item.deposit?.enabled) {
      const deposit = item.deposit || defaultGoalWorkflow.deposit
      const validFixed = deposit.mode !== 'range' && Number(deposit.amount) > 0
      const validRange = deposit.mode === 'range' && Number(deposit.minAmount) > 0 && Number(deposit.maxAmount) >= Number(deposit.minAmount)
      if (!validFixed && !validRange) return 'Configura el monto verificable del anticipo.'
      if (!deposit.methods?.paymentLink && !deposit.methods?.bankTransfer) return 'Activa un método para cobrar el anticipo.'
      if (deposit.methods?.bankTransfer && !String(deposit.bankTransferDetails || '').trim()) return 'Escribe los datos de transferencia.'
    } else if (!item.productId || !item.priceId) {
      return 'Selecciona el producto y precio reales de la capacidad para cobrar.'
    }
  }
  if (item.id === 'send_link') {
    const hasConfiguredLink = item.linkKind === 'trigger'
      ? Boolean(String(item.triggerLinkId || item.url || '').trim())
      : isSafeConversationalUrl(item.url)
    if (!hasConfiguredLink) return 'Escribe un enlace http o https válido.'
  }
  if (item.id === 'custom_goal') {
    if (!String(item.description || '').trim()) return 'Describe el objetivo propio.'
    if (item.completion === 'send_link') {
      const link = allItems.find((candidate) => candidate.id === 'send_link' && candidate.enabled)
      if (!link || getNativeCapabilityItemError(link, allItems)) {
        return 'Activa y configura Mandar enlace para completar este objetivo.'
      }
    }
  }
  return ''
}

function getNativeCapabilityError(agent: ConversationalAgentDef) {
  if (agent.runtimeMode !== 'tool_calling_v2') return ''
  const items = agent.capabilitiesConfig?.items || []
  for (const item of items) {
    const error = getNativeCapabilityItemError(item, items)
    if (error) return error
  }
  return ''
}

function getAgentValidationError(agent: ConversationalAgentDef) {
  return getAgentIdentityError(agent) ||
    (agent.runtimeMode === 'tool_calling_v2'
      ? (agent.enabled ? getNativeCapabilityError(agent) : '')
      : (getAgentCalendarError(agent) || getAgentDepositError(agent))) ||
    getResponseDelayError(getAgentResponseDelay(agent)) ||
    getReplyDeliveryError(getAgentReplyDelivery(agent)) ||
    getFollowUpError(getAgentFollowUp(agent))
}

function mergeGoalWorkflow(
  base: AgentGoalWorkflowConfig,
  patch: Partial<AgentGoalWorkflowConfig>
): AgentGoalWorkflowConfig {
  return {
    ...base,
    ...patch,
    appointments: {
      ...base.appointments,
      ...((patch.appointments || {}) as Partial<AgentGoalWorkflowConfig['appointments']>)
    },
    sales: {
      ...base.sales,
      ...((patch.sales || {}) as Partial<AgentGoalWorkflowConfig['sales']>)
    },
    data: {
      ...base.data,
      ...((patch.data || {}) as Partial<AgentGoalWorkflowConfig['data']>)
    },
    qualification: {
      ...base.qualification,
      ...((patch.qualification || {}) as Partial<AgentGoalWorkflowConfig['qualification']>)
    },
    triggerLink: {
      ...base.triggerLink,
      ...((patch.triggerLink || {}) as Partial<AgentGoalWorkflowConfig['triggerLink']>)
    },
    deposit: {
      ...base.deposit,
      ...((patch.deposit || {}) as Partial<AgentGoalWorkflowConfig['deposit']>),
      methods: {
        ...DEFAULT_AGENT_DEPOSIT_METHODS,
        ...((base.deposit.methods || {}) as Partial<AgentDepositMethodsConfig>),
        ...((patch.deposit?.methods || {}) as Partial<AgentDepositMethodsConfig>)
      }
    },
    completion: {
      ...base.completion,
      ...((patch.completion || {}) as Partial<AgentGoalWorkflowConfig['completion']>)
    },
    attention: {
      ...DEFAULT_AGENT_ATTENTION,
      ...((base.attention || {}) as Partial<AgentAttentionConfig>),
      ...((patch.attention || {}) as Partial<AgentAttentionConfig>)
    }
  }
}

function getObjectiveSuccessAction(objective: ConversationalObjective, workflow: AgentGoalWorkflowConfig): ConversationalSuccessAction {
  if (objective === 'citas') {
    if (workflow.appointments.owner === 'ai') return 'book_appointment'
    if (workflow.appointments.owner === 'url') return 'send_goal_url'
  }
  if (objective === 'ventas') {
    if (workflow.sales.owner === 'ai') return 'ready_to_buy'
    if (workflow.sales.owner === 'url') return 'send_goal_url'
  }
  return 'ready_for_human'
}

function getAttendedChatActionValue(agent: Pick<ConversationalAgentDef, 'hideAttended' | 'hideAttendedNotifications'>): AttendedChatActionValue {
  if (agent.hideAttendedNotifications) return 'mute_only'
  return 'keep_visible'
}

function getAttendedChatActionPatch(value: AttendedChatActionValue): Pick<ConversationalAgentDefInput, 'hideAttended' | 'hideAttendedNotifications'> {
  return {
    hideAttended: false,
    hideAttendedNotifications: value === 'mute_only'
  }
}

function getDelayUnitLabel(unit: AgentResponseDelayUnit, value: number) {
  if (unit === 'minutes') return Number(value) === 1 ? 'minuto' : 'minutos'
  return Number(value) === 1 ? 'segundo' : 'segundos'
}

function getResponseDelaySummary(delay: AgentResponseDelayConfig) {
  if (delay.mode === 'fixed') {
    return `${delay.fixedValue} ${getDelayUnitLabel(delay.fixedUnit, delay.fixedValue)}`
  }
  if (delay.mode === 'random') {
    return `${delay.minValue} a ${delay.maxValue} ${getDelayUnitLabel(delay.rangeUnit, delay.maxValue)}`
  }
  return ''
}

function getResponseDelayHelp(delay: AgentResponseDelayConfig) {
  if (delay.mode === 'fixed') {
    return `Espera ${getResponseDelaySummary(delay)} antes de contestar. Ejemplo: la persona escribe y el agente responde después de esa pausa.`
  }
  if (delay.mode === 'random') {
    return `Escoge un tiempo entre ${getResponseDelaySummary(delay)}. Ejemplo: a veces contesta en 3 minutos y a veces en 7.`
  }
  return 'Contesta en cuanto tiene lista la respuesta. Ejemplo: no espera minutos extra.'
}

function getReplyDeliveryHelp(delivery: AgentReplyDeliveryConfig) {
  if (delivery.splitMessagesEnabled || delivery.mode === 'split') {
    return `Parte textos largos en globitos. Ejemplo: manda una idea, espera ${delivery.minDelaySeconds} a ${delivery.maxDelaySeconds} segundos y manda otra.`
  }
  return 'Manda todo junto en un solo globo. Ejemplo: una respuesta completa en un mensaje.'
}

function getFollowUpSummary(followUp: AgentFollowUpConfig) {
  if (!followUp.enabled) return ''
  const parts = [`seguimiento a ${getFollowUpStepLabel(followUp.first)}`]
  if (followUp.second.enabled) parts.push(`2do a ${getFollowUpStepLabel(followUp.second)}`)
  return parts.join(' · ')
}

function isBusinessPromptReady(status?: ConversationalBusinessPromptStatus | null) {
  return Boolean(status?.ready)
}

function getBusinessPromptStatusText(status?: ConversationalBusinessPromptStatus | null) {
  if (status?.ready) {
    const business = [status.businessName, status.industry].filter(Boolean).join(' · ')
    return business ? `Adaptada a ${business}` : 'Prompt interno listo'
  }
  if (!status || status.status === 'empty') return 'Falta describir el negocio'
  if (status.status === 'needs_more_context') return 'Falta más contexto del negocio'
  if (status.status === 'needs_openai') return 'Falta preparar el prompt con OpenAI'
  if (status.status === 'failed') return 'No se pudo preparar el prompt'
  return 'Preparando prompt interno'
}

function getBusinessPromptBlockerText(status?: ConversationalBusinessPromptStatus | null) {
  if (status?.ready) return ''
  if (status?.extractionError) return status.extractionError
  if (!status || status.status === 'empty') {
    return 'Antes de publicar agentes, describe el negocio en Ristak AI para que Ristak parametrice el guión de fábrica.'
  }
  if (status.status === 'needs_more_context') {
    return 'Agrega más detalle del negocio: qué vende, a quién atiende, cómo opera y qué debe evitar.'
  }
  if (status.status === 'needs_openai') {
    return 'Conecta OpenAI y guarda la descripción del negocio para generar el prompt interno.'
  }
  if (status.status === 'failed') {
    return 'Vuelve a guardar la descripción del negocio para regenerar la estrategia interna.'
  }
  return 'Ristak está preparando el prompt interno. Espera a que quede listo antes de publicar.'
}

function getTeamUserDisplayName(user?: TeamUser | null) {
  if (!user) return ''
  return user.fullName || user.email || user.phone || user.username || `Usuario ${user.id}`
}

function getAgentIdentityHelper({
  mode,
  agentName,
  businessName,
  selectedUserName,
  customName,
  teamUsersLoading,
  hasTeamUsers
}: {
  mode: AgentIdentityMode
  agentName: string
  businessName: string
  selectedUserName: string
  customName: string
  teamUsersLoading: boolean
  hasTeamUsers: boolean
}) {
  if (mode === 'business') {
    return `Se presenta como parte de ${businessName || 'el negocio'} y habla en plural cuando corresponda: nosotros te podemos ayudar.`
  }
  if (mode === 'user') {
    if (teamUsersLoading) return 'Cargando usuarios activos para elegir con qué nombre se presenta.'
    if (!hasTeamUsers) return 'No hay usuarios activos disponibles. Usa nombre personalizado o nombre del agente.'
    return selectedUserName
      ? `Se presenta como ${selectedUserName} y habla en primera persona.`
      : 'Elige la persona del equipo con la que se va a identificar.'
  }
  if (mode === 'custom') {
    return customName
      ? `Se presenta como ${customName} y responde en primera persona si le preguntan quién es.`
      : 'Escribe el nombre visible que debe usar. Ejemplo: Marcos, Raúl o Robot 34.'
  }
  return `Se presenta como ${agentName || 'el nombre del agente'} y usa ese nombre si le preguntan quién es.`
}

interface QuestionSelectOption<T extends string> {
  value: T
  label: string
  disabled?: boolean
}

interface QuestionSelectOptionGroup<T extends string> {
  label: string
  options: Array<QuestionSelectOption<T>>
}

type QuestionSelectEntry<T extends string> = QuestionSelectOption<T> | QuestionSelectOptionGroup<T>

const isQuestionSelectOptionGroup = <T extends string>(entry: QuestionSelectEntry<T>): entry is QuestionSelectOptionGroup<T> => (
  'options' in entry
)

interface QuestionSelectRowProps<T extends string> {
  question: string
  helper?: string
  error?: string
  value: T
  options: Array<QuestionSelectEntry<T>>
  selectLabel?: string
  children?: React.ReactNode
  onChange: (value: T) => void
}

function QuestionSelectRow<T extends string>({
  question,
  helper,
  error,
  value,
  options,
  selectLabel,
  children,
  onChange
}: QuestionSelectRowProps<T>) {
  const visibleChildren = React.Children
    .toArray(children)
    .filter((child) => child !== null && child !== undefined)
  const renderOption = (option: QuestionSelectOption<T>) => (
    <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
  )

  return (
    <div className={`${styles.configQuestion} ${visibleChildren.length ? styles.configQuestionOpen : ''}`}>
      <div className={styles.configQuestionHeader}>
        <div className={styles.configQuestionCopy}>
          <span>{question}</span>
          {(helper || error) && (
            <small className={error ? styles.helperError : ''}>{error || helper}</small>
          )}
        </div>
        <CustomSelect
          className={styles.configQuestionSelect}
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
          portal
          aria-label={selectLabel || question}
        >
          {options.map((entry) => (
            isQuestionSelectOptionGroup(entry)
              ? (
                <optgroup key={`group-${entry.label}`} label={entry.label}>
                  {entry.options.map(renderOption)}
                </optgroup>
              )
              : renderOption(entry)
          ))}
        </CustomSelect>
      </div>
      {visibleChildren.length > 0 && (
        <div className={styles.configQuestionBody}>
          {visibleChildren}
        </div>
      )}
    </div>
  )
}

interface AgentCardProps {
  agent: ConversationalAgentDef
  aiProviders: ConversationalAIProviderStatus[]
  calendars: Calendar[]
  products: ProductItem[]
  productsLoading: boolean
  triggerLinks: TriggerLink[]
  triggerLinksLoading: boolean
  filterOptions?: AgentFilterOptions
  businessPromptStatus?: ConversationalBusinessPromptStatus | null
  onConnectProvider: (providerId: ConversationalAIProviderId) => void
  onBack: () => void
  onChange: (patch: ConversationalAgentDefInput) => void
  onFlushSave: () => Promise<ConversationalAgentDef | null>
  onDelete: () => void
}

const nativeCapabilityMeta: Record<ConversationalCapabilityId, {
  label: string
  description: string
  Icon: React.ComponentType<{ size?: number }>
}> = {
  schedule_appointment: {
    label: 'Agendar cita',
    description: 'Consulta espacios reales y crea la cita en el calendario elegido.',
    Icon: CalendarCheck
  },
  collect_payment: {
    label: 'Cobrar',
    description: 'Manda un cobro amarrado a un precio real. El link no cuenta como pago.',
    Icon: CreditCard
  },
  send_link: {
    label: 'Mandar enlace',
    description: 'Entrega el enlace configurado sin exponer seguimiento ni códigos internos.',
    Icon: Link2
  },
  handoff_human: {
    label: 'Pasar a un humano',
    description: 'Entrega el chat y su contexto cuando debe continuar una persona.',
    Icon: Users
  },
  custom_goal: {
    label: 'Objetivo propio',
    description: 'Persigue la meta que escribas y la cierra por una salida segura.',
    Icon: Wand2
  }
}

function getNativeCapability<T extends ConversationalCapabilityItem['id']>(
  config: ConversationalCapabilitiesConfig,
  id: T
): Extract<ConversationalCapabilityItem, { id: T }> | null {
  return (config.items.find((item) => item.id === id) || null) as Extract<ConversationalCapabilityItem, { id: T }> | null
}

function buildNativeCapabilityFromAgent(
  agent: ConversationalAgentDef,
  id: ConversationalCapabilityId,
  calendars: Calendar[],
  accountCurrency: string
): ConversationalCapabilityItem {
  const workflow = getAgentGoalWorkflow(agent)
  const existing = getNativeCapability(agent.capabilitiesConfig, id)
  if (existing) return { ...existing, enabled: true } as ConversationalCapabilityItem

  if (id === 'schedule_appointment') {
    return {
      id,
      enabled: true,
      calendarId: workflow.appointments.calendarId || agent.defaultCalendarId || (calendars.length === 1 ? calendars[0].id : ''),
      allowOverlaps: false
    }
  }
  if (id === 'collect_payment') {
    return {
      id,
      enabled: true,
      productId: workflow.sales.productId || '',
      priceId: workflow.sales.priceId || '',
      paymentMode: agent.objective === 'citas' && workflow.deposit.enabled
        ? 'deposit'
        : getWorkflowSalesPaymentMode(workflow),
      amount: workflow.sales.amount,
      currency: accountCurrency,
      deposit: {
        ...workflow.deposit,
        currency: accountCurrency,
        methods: { ...DEFAULT_AGENT_DEPOSIT_METHODS, ...(workflow.deposit.methods || {}) }
      }
    }
  }
  if (id === 'send_link') {
    const target = agent.objective === 'ventas' ? workflow.sales : workflow.appointments
    return {
      id,
      enabled: true,
      linkKind: 'verified_goal',
      triggerLinkId: '',
      url: target.url || workflow.triggerLink.triggerLinkUrl || '',
      trackingParam: target.trackingParam || 'ristak_goal_id'
    }
  }
  if (id === 'handoff_human') {
    return {
      id,
      enabled: true,
      rules: agent.handoffRules || '',
      userId: workflow.completion.userId || '',
      userName: workflow.completion.userName || '',
      pastClientsToHuman: Boolean(workflow.attention?.pastClientsToHuman)
    }
  }
  return {
    id: 'custom_goal',
    enabled: true,
    description: agent.customObjective || '',
    completion: 'handoff'
  }
}

interface NativeConversationBuilderProps {
  agent: ConversationalAgentDef
  calendars: Calendar[]
  products: ProductItem[]
  productsLoading: boolean
  teamUsers: TeamUser[]
  teamUsersLoading: boolean
  accountCurrency: string
  onChange: (patch: ConversationalAgentDefInput) => void
}

const NativeConversationBuilder: React.FC<NativeConversationBuilderProps> = ({
  agent,
  calendars,
  products,
  productsLoading,
  teamUsers,
  teamUsersLoading,
  accountCurrency,
  onChange
}) => {
  const { showToast } = useNotification()
  const capabilities = agent.capabilitiesConfig || { schemaVersion: 1, items: [] }

  const updateCapability = (next: ConversationalCapabilityItem, { pause = true } = {}) => {
    const exists = capabilities.items.some((item) => item.id === next.id)
    const items = exists
      ? capabilities.items.map((item) => (item.id === next.id ? next : item))
      : [...capabilities.items, next]
    onChange({
      capabilitiesConfig: { schemaVersion: 1, items },
      ...(pause && agent.enabled ? { enabled: false } : {})
    })
    if (pause && agent.enabled) {
      showToast('info', 'Agente en pausa', 'Configura y prueba la nueva capacidad antes de volver a publicarlo.')
    }
  }

  const toggleCapability = (id: ConversationalCapabilityId, enabled: boolean) => {
    const current = getNativeCapability(capabilities, id)
    const next = enabled
      ? buildNativeCapabilityFromAgent(agent, id, calendars, accountCurrency)
      : ({ ...(current || buildNativeCapabilityFromAgent(agent, id, calendars, accountCurrency)), enabled: false } as ConversationalCapabilityItem)
    updateCapability(next, { pause: true })
  }

  const migrateToV2 = () => {
    onChange({
      runtimeMode: 'tool_calling_v2',
      enabled: false,
      promptConfig: agent.promptConfig || {
        ...DEFAULT_CONVERSATIONAL_PROMPT_CONFIG,
        editableText: String(agent.extraInstructions || '').trim() || DEFAULT_CONVERSATIONAL_PROMPT_CONFIG.editableText
      },
      capabilitiesConfig: agent.migrationCapabilitiesConfig || capabilities
    })
    showToast('info', 'Motor nuevo preparado', 'El agente quedó en pausa. Pruébalo abajo y publícalo cuando te guste cómo responde.')
  }

  if (agent.runtimeMode !== 'tool_calling_v2') {
    return (
      <div className={styles.nativeMigrationNotice}>
        <div className={styles.nativeMigrationIcon}><LockKeyhole size={20} /></div>
        <div className={styles.nativeMigrationCopy}>
          <strong>Este agente sigue usando el motor anterior</strong>
          <span>Prepáralo con conversación directa y herramientas nativas. Se pausará para que lo pruebes antes de reemplazar lo que hoy está atendiendo.</span>
        </div>
        <Button variant="secondary" onClick={migrateToV2}>Preparar motor nuevo</Button>
      </div>
    )
  }

  const scheduleCapability = getNativeCapability(capabilities, 'schedule_appointment')
  const paymentCapability = getNativeCapability(capabilities, 'collect_payment')
  const linkCapability = getNativeCapability(capabilities, 'send_link')
  const handoffCapability = getNativeCapability(capabilities, 'handoff_human')
  const customCapability = getNativeCapability(capabilities, 'custom_goal')
  const selectedProduct = products.find((product) => getProductId(product) === paymentCapability?.productId) || null
  const productPrices = selectedProduct?.prices || []
  const manifestById = new Map<ConversationalCapabilityId, ConversationalCapabilityManifestItem>(
    (agent.capabilityManifest || []).map((item) => [item.id, item])
  )

  const capabilityRows: Array<{
    id: ConversationalCapabilityId
    item: ConversationalCapabilityItem | null
    settings: React.ReactNode
  }> = [
    {
      id: 'schedule_appointment',
      item: scheduleCapability,
      settings: scheduleCapability?.enabled ? (
        <div className={styles.nativeCapabilitySettings}>
          <label className={styles.label}>Calendario</label>
          <CustomSelect
            value={scheduleCapability.calendarId}
            onChange={(event) => updateCapability({ ...scheduleCapability, calendarId: event.target.value, allowOverlaps: false })}
            portal
          >
            <option value="">Elegir calendario activo</option>
            {calendars.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </CustomSelect>
          <p className={styles.helper}>El modelo no puede cambiar este calendario ni sobreagendar. Cada espacio se vuelve a comprobar al confirmar.</p>
        </div>
      ) : null
    },
    {
      id: 'collect_payment',
      item: paymentCapability,
      settings: paymentCapability?.enabled ? (
        <div className={styles.nativeCapabilitySettings}>
          <label className={styles.label}>Tipo de cobro</label>
          <CustomSelect
            value={paymentCapability.paymentMode}
            onChange={(event) => updateCapability({
              ...paymentCapability,
              paymentMode: event.target.value === 'deposit' ? 'deposit' : 'full_payment',
              deposit: { ...paymentCapability.deposit, enabled: event.target.value === 'deposit', currency: accountCurrency }
            })}
            portal
          >
            <option value="full_payment">Pago completo de un producto</option>
            <option value="deposit">Anticipo</option>
          </CustomSelect>
          {paymentCapability.paymentMode === 'full_payment' ? (
            <div className={styles.nativeInlineFields}>
              <div className={styles.field}>
                <label className={styles.label}>Producto</label>
                <CustomSelect
                  value={paymentCapability.productId}
                  onChange={(event) => updateCapability({
                    ...paymentCapability,
                    productId: event.target.value,
                    priceId: '',
                    amount: null,
                    currency: accountCurrency
                  })}
                  disabled={productsLoading}
                  portal
                >
                  <option value="">{productsLoading ? 'Cargando productos...' : 'Elegir producto real'}</option>
                  {products.map((product) => <option key={getProductId(product)} value={getProductId(product)}>{product.name}</option>)}
                </CustomSelect>
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Precio</label>
                <CustomSelect
                  value={paymentCapability.priceId}
                  onChange={(event) => {
                    const price = productPrices.find((item) => getPriceId(item) === event.target.value) || null
                    updateCapability({
                      ...paymentCapability,
                      priceId: getPriceId(price),
                      amount: price ? getPriceAmount(price) : null,
                      currency: normalizeCurrencyCode(price?.currency || selectedProduct?.currency || accountCurrency)
                    })
                  }}
                  disabled={!selectedProduct}
                  portal
                >
                  <option value="">Elegir precio real</option>
                  {productPrices.map((price) => (
                    <option key={getPriceId(price)} value={getPriceId(price)}>
                      {price.name || 'Precio'} · {formatCurrency(getPriceAmount(price), normalizeCurrencyCode(price.currency || selectedProduct?.currency || accountCurrency))}
                    </option>
                  ))}
                </CustomSelect>
              </div>
            </div>
          ) : (
            <>
              <label className={styles.label}>Cómo se define el anticipo</label>
              <CustomSelect
                value={paymentCapability.deposit.mode || 'fixed'}
                onChange={(event) => updateCapability({
                  ...paymentCapability,
                  deposit: {
                    ...paymentCapability.deposit,
                    enabled: true,
                    mode: event.target.value === 'range' ? 'range' : 'fixed',
                    currency: accountCurrency
                  }
                })}
                portal
              >
                <option value="fixed">Monto exacto</option>
                <option value="range">Rango acordado con la persona</option>
              </CustomSelect>
              <div className={styles.nativeInlineFields}>
                {paymentCapability.deposit.mode === 'range' ? (
                  <>
                    <div className={styles.field}>
                      <label className={styles.label}>Mínimo</label>
                      <NumberInput
                        value={paymentCapability.deposit.minAmount || ''}
                        min={0}
                        step={0.01}
                        onValueChange={(minAmount) => updateCapability({
                          ...paymentCapability,
                          deposit: { ...paymentCapability.deposit, enabled: true, mode: 'range', minAmount, currency: accountCurrency }
                        })}
                      />
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Máximo</label>
                      <NumberInput
                        value={paymentCapability.deposit.maxAmount || ''}
                        min={0}
                        step={0.01}
                        onValueChange={(maxAmount) => updateCapability({
                          ...paymentCapability,
                          deposit: { ...paymentCapability.deposit, enabled: true, mode: 'range', maxAmount, currency: accountCurrency }
                        })}
                      />
                    </div>
                  </>
                ) : (
                  <div className={styles.field}>
                    <label className={styles.label}>Monto del anticipo</label>
                    <NumberInput
                      value={paymentCapability.deposit.amount || ''}
                      min={0}
                      step={0.01}
                      onValueChange={(amount) => updateCapability({
                        ...paymentCapability,
                        deposit: { ...paymentCapability.deposit, enabled: true, mode: 'fixed', amount, currency: accountCurrency }
                      })}
                    />
                  </div>
                )}
                <div className={styles.nativePaymentMethods}>
                  <label>
                    <Switch
                      checked={Boolean(paymentCapability.deposit.methods?.paymentLink)}
                      onChange={(paymentLink) => updateCapability({
                        ...paymentCapability,
                        deposit: {
                          ...paymentCapability.deposit,
                          methods: { ...DEFAULT_AGENT_DEPOSIT_METHODS, ...paymentCapability.deposit.methods, paymentLink }
                        }
                      })}
                      aria-label="Cobrar anticipo con link"
                    />
                    Link de pago
                  </label>
                  <label>
                    <Switch
                      checked={Boolean(paymentCapability.deposit.methods?.bankTransfer)}
                      onChange={(bankTransfer) => updateCapability({
                        ...paymentCapability,
                        deposit: {
                          ...paymentCapability.deposit,
                          methods: { ...DEFAULT_AGENT_DEPOSIT_METHODS, ...paymentCapability.deposit.methods, bankTransfer }
                        }
                      })}
                      aria-label="Aceptar comprobante para revisión"
                    />
                    Transferencia con revisión
                  </label>
                </div>
              </div>
              {paymentCapability.deposit.methods?.bankTransfer && (
                <textarea
                  className={styles.textarea}
                  value={paymentCapability.deposit.bankTransferDetails || ''}
                  rows={3}
                  placeholder="Banco, titular y datos para transferir"
                  onChange={(event) => updateCapability({
                    ...paymentCapability,
                    deposit: { ...paymentCapability.deposit, bankTransferDetails: event.target.value }
                  })}
                />
              )}
              <p className={styles.helper}>Una foto de comprobante queda pendiente de revisión; jamás se toma como dinero confirmado por sí sola.</p>
            </>
          )}
        </div>
      ) : null
    },
    {
      id: 'send_link',
      item: linkCapability,
      settings: linkCapability?.enabled ? (
        <div className={styles.nativeCapabilitySettings}>
          <label className={styles.label}>Enlace que puede mandar</label>
          <input
            className={styles.input}
            value={linkCapability.url}
            placeholder="https://tu-negocio.com/siguiente-paso"
            onChange={(event) => updateCapability({ ...linkCapability, linkKind: 'verified_goal', triggerLinkId: '', url: event.target.value })}
          />
          <p className={styles.helper}>Abrir el enlace no confirma una cita ni un pago. Esos resultados necesitan evidencia real aparte.</p>
        </div>
      ) : null
    },
    {
      id: 'handoff_human',
      item: handoffCapability,
      settings: handoffCapability?.enabled ? (
        <div className={styles.nativeCapabilitySettings}>
          <label className={styles.label}>Cuándo debe pasarlo</label>
          <textarea
            className={styles.textarea}
            value={handoffCapability.rules}
            rows={3}
            placeholder="Ejemplo: facturación, quejas, excepciones o cuando pida hablar con alguien"
            onChange={(event) => updateCapability({ ...handoffCapability, rules: event.target.value })}
          />
          <label className={styles.label}>Persona asignada (opcional)</label>
          <CustomSelect
            value={handoffCapability.userId}
            onChange={(event) => {
              const user = teamUsers.find((item) => item.id === event.target.value) || null
              updateCapability({
                ...handoffCapability,
                userId: user?.id || '',
                userName: getTeamUserDisplayName(user)
              })
            }}
            disabled={teamUsersLoading}
            portal
          >
            <option value="">Sólo avisar al equipo</option>
            {teamUsers.map((user) => <option key={user.id} value={user.id}>{getTeamUserDisplayName(user)}</option>)}
          </CustomSelect>
          <div className={styles.nativePaymentMethods}>
            <label>
              <Switch
                checked={Boolean(handoffCapability.pastClientsToHuman)}
                onChange={(pastClientsToHuman) => updateCapability({
                  ...handoffCapability,
                  pastClientsToHuman
                })}
                aria-label="Pasar clientes existentes al equipo"
              />
              Clientes existentes van con tu equipo
            </label>
          </div>
          <p className={styles.helper}>Ristak comprueba pagos o citas anteriores antes de aplicar esta regla; no se decide por una palabra suelta.</p>
        </div>
      ) : null
    },
    {
      id: 'custom_goal',
      item: customCapability,
      settings: customCapability?.enabled ? (
        <div className={styles.nativeCapabilitySettings}>
          <label className={styles.label}>Resultado que debe conseguir</label>
          <textarea
            className={styles.textarea}
            value={customCapability.description}
            rows={3}
            placeholder="Ejemplo: reunir los datos para preparar una cotización formal"
            onChange={(event) => updateCapability({ ...customCapability, description: event.target.value })}
          />
          <label className={styles.label}>Qué pasa cuando se cumple</label>
          <CustomSelect
            value={customCapability.completion}
            onChange={(event) => updateCapability({
              ...customCapability,
              completion: event.target.value === 'send_link' ? 'send_link' : 'handoff'
            })}
            portal
          >
            <option value="handoff">Entregar al equipo</option>
            <option value="send_link">Mandar el enlace configurado</option>
          </CustomSelect>
          <p className={styles.helper}>{customCapability.completion === 'send_link'
            ? 'También debes activar Mandar enlace. Enviar o abrir el link no confirma una cita ni un pago por sí solo.'
            : 'Al completarlo, el chat pasa al equipo con el contexto reunido.'}</p>
        </div>
      ) : null
    }
  ]

  const enabledManifest = capabilityRows
    .filter((row) => row.item?.enabled)
    .map((row) => {
      const item = row.item as ConversationalCapabilityItem
      const localError = getNativeCapabilityItemError(item, capabilities.items)
      const persisted = manifestById.get(row.id)
      return {
        id: row.id,
        label: persisted?.label || nativeCapabilityMeta[row.id].label,
        locked: true as const,
        enabled: true,
        ready: !localError,
        summary: persisted?.summary || nativeCapabilityMeta[row.id].description,
        missingConfiguration: localError ? [localError] : []
      }
    })

  return (
    <>
      <div className={styles.nativeRuntimeHeader}>
        <div>
          <Badge variant="info">Flujo directo</Badge>
          <span>Una sola IA conversa y usa herramientas nativas.</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({
            runtimeMode: 'legacy_v1',
            enabled: false,
            extraInstructions: agent.promptConfig?.editableText ?? agent.extraInstructions
          })}
        >
          Volver al motor anterior
        </Button>
      </div>

      <div className={styles.agentSection}>
        <h3 className={styles.sectionTitle}>1. Instrucciones de tu agente</h3>
        <p className={styles.agentSectionHint}>Esta zona es tuya. La plantilla ya funciona; puedes dejarla, editarla o borrarla completa.</p>
        <textarea
          className={`${styles.textarea} ${styles.nativePromptTextarea}`}
          value={agent.promptConfig?.editableText ?? ''}
          rows={12}
          placeholder="Escribe aquí cómo debe atender, qué debe saber y cómo quieres que hable."
          onChange={(event) => onChange({
            promptConfig: {
              ...(agent.promptConfig || DEFAULT_CONVERSATIONAL_PROMPT_CONFIG),
              editableText: event.target.value
            }
          })}
        />
        <p className={styles.helper}>Aunque borres todo, las herramientas, validaciones y datos reales siguen protegidos por Ristak.</p>
      </div>

      <div className={styles.agentSection}>
        <h3 className={styles.sectionTitle}>2. Capacidades</h3>
        <p className={styles.agentSectionHint}>Activa varias si las necesitas. Cada una pide sólo la configuración que hace falta para operar.</p>
        <div className={styles.nativeCapabilityList}>
          {capabilityRows.map(({ id, item, settings }) => {
            const meta = nativeCapabilityMeta[id]
            const Icon = meta.Icon
            return (
              <div key={id} className={styles.nativeCapabilityRow} data-enabled={item?.enabled ? 'true' : undefined}>
                <div className={styles.nativeCapabilityHeading}>
                  <span className={styles.nativeCapabilityIcon}><Icon size={18} /></span>
                  <div>
                    <strong>{meta.label}</strong>
                    <span>{meta.description}</span>
                  </div>
                  <Switch
                    checked={Boolean(item?.enabled)}
                    onChange={(enabled) => toggleCapability(id, enabled)}
                    aria-label={`${enabledManifest.some((entry) => entry.id === id) ? 'Desactivar' : 'Activar'} ${meta.label}`}
                  />
                </div>
                {settings}
              </div>
            )
          })}
        </div>
      </div>

      <div className={`${styles.agentSection} ${styles.nativeLockedZone}`}>
        <div className={styles.nativeLockedTitle}>
          <LockKeyhole size={18} />
          <div>
            <h3 className={styles.sectionTitle}>Protección de Ristak</h3>
            <p className={styles.agentSectionHint}>Zona blindada · visible, pero no editable.</p>
          </div>
        </div>
        <div className={styles.nativeManifestList}>
          {enabledManifest.length ? enabledManifest.map((item) => (
            <div key={item.id} className={styles.nativeManifestItem}>
              <CheckCircle2 size={16} />
              <div>
                <strong>{item.label}</strong>
                <span>{item.summary}</span>
                {item.missingConfiguration.map((message) => <small key={message}>{message}</small>)}
              </div>
              <Badge variant={!item.ready ? 'warning' : (agent.enabled ? 'success' : 'info')}>
                {!item.ready
                  ? 'Falta configurar'
                  : (agent.enabled ? 'Validada al publicar' : 'Lista para validar')}
              </Badge>
            </div>
          )) : (
            <p className={styles.helper}>Activa una capacidad para ver aquí sus protecciones operativas.</p>
          )}
        </div>
      </div>
    </>
  )
}

function getProviderStatus(aiProviders: ConversationalAIProviderStatus[], providerId: ConversationalAIProviderId) {
  return aiProviders.find((provider) => provider.id === providerId) || null
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, aiProviders, calendars, products, productsLoading, triggerLinks, triggerLinksLoading, filterOptions, businessPromptStatus, onConnectProvider, onBack, onChange, onFlushSave, onDelete }) => {
  const { showToast } = useNotification()
  const { labels } = useLabels()
  const leadLowerLabel = formatCrmLabelLower(labels.lead, DEFAULT_CRM_LABELS.lead)
  const detectedLocaleDefaults = getDetectedAccountLocaleDefaults()
  const [accountCurrencyConfig] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedLocaleDefaults.currency)
  const [testMessages, setTestMessages] = useState<TestMessage[]>([])
  const [testInput, setTestInput] = useState('')
  const [testAttachments, setTestAttachments] = useState<TestAttachment[]>([])
  const [testAttachmentMenuOpen, setTestAttachmentMenuOpen] = useState(false)
  const [testEmojiPickerOpen, setTestEmojiPickerOpen] = useState(false)
  const [testPracticeExpired, setTestPracticeExpired] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testVoiceRecording, setTestVoiceRecording] = useState(false)
  const [testVoiceProcessing, setTestVoiceProcessing] = useState(false)
  const [testVoiceDraft, setTestVoiceDraft] = useState<TestAttachment | null>(null)
  const [testVoiceElapsedMs, setTestVoiceElapsedMs] = useState(0)
  const [testVoicePlaying, setTestVoicePlaying] = useState(false)
  const [testVoiceBars, setTestVoiceBars] = useState(() => createTestVoiceBars())
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  const [teamUsersLoading, setTeamUsersLoading] = useState(false)
  const [guidanceOpen, setGuidanceOpen] = useState({
    requiredData: false,
    handoffRules: false
  })
  const testComposerInputRef = useRef<HTMLInputElement | null>(null)
  const testPhotoInputRef = useRef<HTMLInputElement | null>(null)
  const testFileInputRef = useRef<HTMLInputElement | null>(null)
  const testVideoInputRef = useRef<HTMLInputElement | null>(null)
  const testVoiceRecorderRef = useRef<MediaRecorder | null>(null)
  const testVoiceStreamRef = useRef<MediaStream | null>(null)
  const testVoiceAudioContextRef = useRef<AudioContext | null>(null)
  const testVoiceAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const testVoiceAnalyserRef = useRef<AnalyserNode | null>(null)
  const testVoiceSamplesRef = useRef<Uint8Array | null>(null)
  const testVoiceAnimationFrameRef = useRef<number | null>(null)
  const testVoiceLastWaveUpdateRef = useRef(0)
  const testVoiceChunksRef = useRef<Blob[]>([])
  const testVoiceStartedAtRef = useRef(0)
  const testVoiceTimerRef = useRef<number | null>(null)
  const testVoiceSendAfterStopRef = useRef(false)
  const testVoiceDiscardRef = useRef(false)
  const testVoiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const testPracticeExpiredRef = useRef(false)

  useEffect(() => () => {
    cleanupTestVoiceRecorder()
  }, [])

  useEffect(() => {
    setGuidanceOpen({
      requiredData: false,
      handoffRules: false
    })
  }, [agent.id])

  useEffect(() => {
    testPracticeExpiredRef.current = testPracticeExpired
  }, [testPracticeExpired])

  useEffect(() => {
    void clearExpiredTestMediaCache().catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    setTeamUsersLoading(true)
    userAccessService.listUsers()
      .then((users) => {
        if (!alive) return
        setTeamUsers(users.filter((user) => user.isActive))
      })
      .catch(() => {
        if (alive) setTeamUsers([])
      })
      .finally(() => {
        if (alive) setTeamUsersLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const selectedObjective = objectiveOptions.find((option) => option.value === agent.objective) || objectiveOptions[0]
  const localizedGoalExecutionOptionsByObjective = useMemo<Record<ConversationalObjective, GoalExecutionOption[]>>(() => ({
    ...goalExecutionOptionsByObjective,
    filtrar: goalExecutionOptionsByObjective.filtrar.map((option) => (
      option.value === 'ready_for_human'
        ? {
            ...option,
            label: `Que el equipo reciba al ${leadLowerLabel} filtrado`,
            description: `La IA califica la conversación y pasa al equipo sólo lo que ya vale atender.`
          }
        : option
    ))
  }), [leadLowerLabel])
  const getLocalizedGoalExecutionOptions = useCallback((objective: ConversationalObjective) => (
    localizedGoalExecutionOptionsByObjective[objective] || localizedGoalExecutionOptionsByObjective.custom
  ), [localizedGoalExecutionOptionsByObjective])
  const getLocalizedSelectedGoalExecutionInfo = useCallback((
    action: ConversationalSuccessAction,
    objective: ConversationalObjective,
    workflow?: AgentGoalWorkflowConfig
  ) => {
    const options = getLocalizedGoalExecutionOptions(objective)
    return options.find((option) => option.value === action) ||
      options.find((option) => option.value === getObjectiveSuccessAction(objective, workflow || defaultGoalWorkflow)) ||
      options[0]
  }, [getLocalizedGoalExecutionOptions])
  const getLocalizedGoalExecutionQuestion = useCallback((objective: ConversationalObjective) => {
    if (objective === 'filtrar') return `¿Quién debería atender al ${leadLowerLabel} filtrado?`
    return getGoalExecutionQuestion(objective)
  }, [leadLowerLabel])
  const selectedProviderId = getKnownConversationalAIProvider(agent.aiProvider)
  const selectedProvider = getConversationalAIProviderOption(selectedProviderId)
  const selectedProviderStatus = getProviderStatus(aiProviders, selectedProviderId)
  const selectedProviderConnected = Boolean(selectedProviderStatus?.connected)
  const selectedAgentModelValue = getKnownConversationalModel(selectedProviderId, agent.model)
  const selectedAgentModel = selectedProvider.modelGroups
    .flatMap((group) => group.options)
    .find((option) => option.value === selectedAgentModelValue)
  const selectedAgentModelOptions = selectedProvider.modelGroups.map((group) => ({
    label: group.label,
    options: group.options.map((option) => ({
      value: option.value,
      label: option.label
    }))
  }))
  const selectedAttendedChatActionValue = getAttendedChatActionValue(agent)
  const selectedAttendedChatAction = attendedChatActionOptions.find((option) => option.value === selectedAttendedChatActionValue) || attendedChatActionOptions[0]
  const businessPromptReady = isBusinessPromptReady(businessPromptStatus)
  const promptStatusText = getBusinessPromptStatusText(businessPromptStatus)
  const promptBlockerText = getBusinessPromptBlockerText(businessPromptStatus)
  const legacyBusinessPromptBlocked = agent.runtimeMode !== 'tool_calling_v2' && !businessPromptReady
  const publishValidationError = getAgentValidationError({ ...agent, enabled: true })
  const entryCount = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
  const exitCount = agent.filters.exit.groups.reduce((total, group) => total + group.conditions.length, 0)
  const customFieldOptions = filterOptions?.customFields || []
  const responseDelay = getAgentResponseDelay(agent)
  const responseDelaySummary = getResponseDelaySummary(responseDelay)
  const replyDelivery = getAgentReplyDelivery(agent)
  const humanMessagesEnabled = replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split'
  const followUp = getAgentFollowUp(agent)
  const followUpSummary = getFollowUpSummary(followUp)
  const responseDelayError = getResponseDelayError(responseDelay)
  const replyDeliveryError = getReplyDeliveryError(replyDelivery)
  const followUpError = getFollowUpError(followUp)
  const identityError = getAgentIdentityError(agent)
  const requiredDataConfigOpen = guidanceOpen.requiredData || Boolean(String(agent.requiredData || '').trim())
  const handoffRulesConfigOpen = guidanceOpen.handoffRules || Boolean(String(agent.handoffRules || '').trim())
  const goalWorkflow = getAgentGoalWorkflow(agent)
  const deposit = goalWorkflow.deposit
  const completion = goalWorkflow.completion
  const goalExecutionOptions = getLocalizedGoalExecutionOptions(agent.objective)
  const selectedGoalExecutionInfo = getLocalizedSelectedGoalExecutionInfo(agent.successAction, agent.objective, goalWorkflow)
  const selectedGoalExecutionAction = selectedGoalExecutionInfo.value
  const paymentRequirementConfigAvailable = objectiveCanConfigurePaymentRequirement(agent.objective)
  const showAiAppointmentSettings = agent.objective === 'citas' && selectedGoalExecutionAction === 'book_appointment'
  const showAiSalesSettings = agent.objective === 'ventas' && selectedGoalExecutionAction === 'ready_to_buy'
  const showPaymentRequirementSettings = paymentRequirementConfigAvailable && (showAiAppointmentSettings || showAiSalesSettings)
  const showGoalUrlSettings = selectedGoalExecutionAction === 'send_goal_url' && (agent.objective === 'citas' || agent.objective === 'ventas')
  const showTriggerLinkSettings = selectedGoalExecutionAction === 'send_trigger_link'
  const showCompletionSettings = selectedGoalExecutionAction === 'book_appointment' ||
    selectedGoalExecutionAction === 'ready_to_buy' ||
    selectedGoalExecutionAction === 'send_goal_url' ||
    selectedGoalExecutionAction === 'send_trigger_link'
  const completionMode = completion.mode === 'assign_user' ? 'assign_user' : 'notify_only'
  const selectedCompletionUser = teamUsers.find((user) => user.id === completion.userId) || null
  const teamUserOptions = [
    { value: '', label: teamUsersLoading ? 'Cargando usuarios...' : 'Elegir usuario' },
    ...teamUsers.map((user) => ({
      value: user.id,
      label: getTeamUserDisplayName(user)
    }))
  ]
  const selectedIdentityMode: AgentIdentityMode = agent.identityMode || 'business'
  const selectedIdentityUser = teamUsers.find((user) => user.id === agent.identityUserId) || null
  const selectedIdentityUserName = getTeamUserDisplayName(selectedIdentityUser) || agent.identityUserName || ''
  const businessIdentityName = businessPromptStatus?.businessName || 'el negocio'
  const identityHelper = getAgentIdentityHelper({
    mode: selectedIdentityMode,
    agentName: agent.name,
    businessName: businessIdentityName,
    selectedUserName: selectedIdentityUserName,
    customName: agent.identityCustomName || '',
    teamUsersLoading,
    hasTeamUsers: teamUsers.length > 0
  })
  const goalUrlConfig = agent.objective === 'ventas' ? goalWorkflow.sales : goalWorkflow.appointments
  const goalUrlLabel = agent.objective === 'ventas' ? 'Enlace del pedido' : 'Enlace del calendario'
  const goalUrlPlaceholder = agent.objective === 'ventas' ? 'https://tutienda.com/checkout' : 'https://calendly.com/tu-negocio/cita'
  const selectedGoalCalendarId = goalWorkflow.appointments.calendarId || agent.defaultCalendarId || ''
  const selectedSalesProduct = products.find((product) => getProductId(product) === goalWorkflow.sales.productId) || null
  const selectedSalesPrice = selectedSalesProduct
    ? (selectedSalesProduct.prices || []).find((price) => getPriceId(price) === goalWorkflow.sales.priceId) || getPrimaryPrice(selectedSalesProduct)
    : null
  const accountCurrency = normalizeCurrencyCode(accountCurrencyConfig || detectedLocaleDefaults.currency)
  const depositCurrency = accountCurrency
  const salesPaymentMode = getWorkflowSalesPaymentMode(goalWorkflow)
  const depositEnabledForForm = agent.objective === 'ventas' ? salesPaymentMode === 'deposit' : deposit.enabled
  const depositHelper = agent.objective === 'ventas'
    ? 'El agente sólo avanzará cuando reciba comprobante y el pago solicitado coincida con este valor. Se usa la moneda configurada en la cuenta.'
    : 'El agente sólo avanzará cuando reciba comprobante y el anticipo coincida con este valor. Se usa la moneda configurada en la cuenta.'
  const selectedTriggerLink = triggerLinks.find((link) => link.id === goalWorkflow.triggerLink.triggerLinkId) || null
  const triggerLinkOptions = [
    { value: '', label: triggerLinksLoading ? 'Cargando enlaces...' : 'Elegir enlace' },
    ...triggerLinks.map((link) => ({ value: link.id, label: link.name }))
  ]
  const productOptions = [
    { value: '', label: productsLoading ? 'Cargando productos...' : 'Elegir producto del sistema' },
    ...products.map((product) => ({ value: getProductId(product), label: product.name }))
  ]
  const priceOptions = selectedSalesProduct
    ? [
        { value: '', label: 'Precio base' },
        ...(selectedSalesProduct.prices || []).map((price) => ({
          value: getPriceId(price),
          label: `${price.name || 'Precio'} · ${formatCurrency(getPriceAmount(price), accountCurrency)}`
        }))
      ]
    : [{ value: '', label: 'Selecciona producto primero' }]
  const testVoicePanelActive = testVoiceRecording || testVoiceProcessing || Boolean(testVoiceDraft)
  const hasTestConversation = testPracticeExpired || testMessages.length > 0 || Boolean(testInput.trim()) || testAttachments.length > 0 || Boolean(testVoiceDraft) || testVoiceRecording

  useEffect(() => {
    if (!testVoicePanelActive && !testing) return
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
  }, [testVoicePanelActive, testing])

  const testPreviewMessages: PhoneChatPreviewMessage[] = testPracticeExpired
    ? [{
        id: 'test-media-expired',
        direction: 'system',
        body: TEST_MEDIA_EXPIRED_NOTICE,
        internal: true
      }]
    : testMessages.map((message, index) => ({
        id: `test-${index}`,
        direction: message.internal ? 'system' : message.role === 'user' ? 'outbound' : 'inbound',
        body: message.content || getAttachmentMessageLabel(message.attachments || []),
        attachments: (message.attachments || []).map((attachment): PhoneChatPreviewAttachment => ({
          id: attachment.id,
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          size: attachment.size,
          dataUrl: attachment.dataUrl,
          thumbnailDataUrl: attachment.thumbnailDataUrl,
          durationMs: attachment.durationMs
        })),
        internal: message.internal,
        time: message.internal ? undefined : '11:48'
      }))

  const updateExtra = (index: number, patch: Partial<AgentSuccessExtra>) => {
    onChange({ successExtras: agent.successExtras.map((extra, i) => (i === index ? { ...extra, ...patch } : extra)) })
  }

  const updateResponseDelay = (patch: Partial<AgentResponseDelayConfig>) => {
    const next = { ...responseDelay, ...patch }
    const error = getResponseDelayError(next)
    if (error) {
      showToast('warning', 'Rango inválido', error)
      return
    }
    onChange({ responseDelay: next })
  }

  const updateReplyDelivery = (patch: Partial<AgentReplyDeliveryConfig>) => {
    const next = { ...replyDelivery, ...patch }
    const error = getReplyDeliveryError(next)
    if (error) {
      showToast('warning', 'Rango inválido', error)
      return
    }
    onChange({ replyDelivery: next })
  }

  const updateFollowUp = (patch: Partial<AgentFollowUpConfig>) => {
    onChange({ followUp: { ...followUp, ...patch } })
  }

  const updateFollowUpStep = (stepKey: 'first' | 'second', patch: Partial<AgentFollowUpStepConfig>) => {
    const currentStep = followUp[stepKey]
    const unit = (patch.unit || currentStep.unit) as AgentFollowUpUnit
    const rawValue = patch.value === undefined ? currentStep.value : patch.value
    const nextStep: AgentFollowUpStepConfig = {
      ...currentStep,
      ...patch,
      unit,
      value: clampFollowUpStepValue(rawValue, unit)
    }
    if (stepKey === 'first') nextStep.enabled = true
    const nextFollowUp = { ...followUp, [stepKey]: nextStep }
    const error = getFollowUpError(nextFollowUp)
    if (error && error !== 'Falta la estrategia de seguimiento.') {
      showToast('warning', 'Seguimiento inválido', error)
      return
    }
    updateFollowUp({ [stepKey]: nextStep } as Partial<AgentFollowUpConfig>)
  }

  const updateGoalWorkflow = (patch: Partial<AgentGoalWorkflowConfig>) => {
    onChange({ goalWorkflow: mergeGoalWorkflow(goalWorkflow, patch) })
  }

  const updateDeposit = (patch: Partial<AgentGoalWorkflowConfig['deposit']>) => {
    const nextDeposit = { ...goalWorkflow.deposit, ...patch }
    if ((nextDeposit.enabled || patch.enabled) && !normalizeCurrencyCode(nextDeposit.currency)) {
      nextDeposit.currency = depositCurrency || accountCurrency
    }
    updateGoalWorkflow({ deposit: nextDeposit })
  }

  const depositMethods = deposit.methods || DEFAULT_AGENT_DEPOSIT_METHODS
  const updateDepositMethods = (patch: Partial<AgentDepositMethodsConfig>) => {
    updateDeposit({ methods: { ...depositMethods, ...patch } })
  }

  const updateSalesPaymentMode = (paymentMode: AgentSalesPaymentMode) => {
    const needsDeposit = paymentMode === 'deposit'
    updateGoalWorkflow({
      sales: { ...goalWorkflow.sales, paymentMode },
      deposit: {
        ...goalWorkflow.deposit,
        enabled: needsDeposit,
        currency: needsDeposit
          ? accountCurrency
          : goalWorkflow.deposit.currency
      }
    })
  }

  const updateCompletion = (patch: Partial<AgentGoalWorkflowConfig['completion']>) => {
    updateGoalWorkflow({ completion: { ...goalWorkflow.completion, ...patch } })
  }

  const updateIdentityMode = (identityMode: AgentIdentityMode) => {
    if (identityMode === 'user') {
      const user = selectedIdentityUser || teamUsers[0] || null
      onChange({
        identityMode,
        identityUserId: user?.id || '',
        identityUserName: getTeamUserDisplayName(user),
        identityCustomName: ''
      })
      return
    }

    onChange({
      identityMode,
      identityUserId: '',
      identityUserName: '',
      identityCustomName: identityMode === 'custom' ? agent.identityCustomName || '' : ''
    })
  }

  const getTriggerLinkWorkflow = (triggerLink?: TriggerLink | null): AgentGoalWorkflowConfig['triggerLink'] => ({
    triggerLinkId: triggerLink?.id || '',
    triggerLinkPublicId: triggerLink?.publicId || '',
    triggerLinkName: triggerLink?.name || '',
    triggerLinkUrl: triggerLink?.publicUrl || ''
  })

  const handleProviderSelect = (providerId: ConversationalAIProviderId) => {
    const status = getProviderStatus(aiProviders, providerId)
    if (!status?.connected) {
      onConnectProvider(providerId)
      return
    }

    const currentProvider = getKnownConversationalAIProvider(agent.aiProvider)
    onChange({
      aiProvider: providerId,
      model: getKnownConversationalModel(
        providerId,
        currentProvider === providerId ? agent.model : getDefaultConversationalModel(providerId)
      )
    })
  }

  const handleObjectiveChange = (objective: ConversationalObjective) => {
    const options = getLocalizedGoalExecutionOptions(objective)
    const objectiveAction = getObjectiveSuccessAction(objective, goalWorkflow)
    const nextAction = options.some((option) => option.value === agent.successAction)
      ? agent.successAction
      : options.some((option) => option.value === objectiveAction)
        ? objectiveAction
        : options[0]?.value || 'ready_for_human'
    onChange({
      objective,
      ...buildGoalExecutionPatch(nextAction, objective)
    })
  }

  const buildGoalExecutionPatch = (
    successAction: ConversationalSuccessAction,
    objective: ConversationalObjective = agent.objective
  ): ConversationalAgentDefInput => {
    const patch: ConversationalAgentDefInput = { successAction }
    let nextGoalWorkflow: AgentGoalWorkflowConfig | null = null
    if (objective === 'citas') {
      const owner = successAction === 'book_appointment' ? 'ai' : successAction === 'send_goal_url' ? 'url' : 'human'
      // El calendario lo elige el usuario explícitamente: aquí solo se conserva el ya elegido.
      const calendarId = goalWorkflow.appointments.calendarId || agent.defaultCalendarId || null
      nextGoalWorkflow = mergeGoalWorkflow(goalWorkflow, {
        appointments: { ...goalWorkflow.appointments, owner, calendarId },
        ...(owner === 'ai' ? {} : { deposit: { ...goalWorkflow.deposit, enabled: false } })
      })
      if (owner === 'ai') patch.defaultCalendarId = calendarId
    }
    if (objective === 'ventas') {
      const owner = successAction === 'ready_to_buy' ? 'ai' : successAction === 'send_goal_url' ? 'url' : 'human'
      nextGoalWorkflow = mergeGoalWorkflow(nextGoalWorkflow || goalWorkflow, {
        sales: {
          ...goalWorkflow.sales,
          owner,
          paymentMode: owner === 'ai' ? goalWorkflow.sales.paymentMode : 'full_payment'
        },
        ...(owner === 'ai' ? {} : { deposit: { ...goalWorkflow.deposit, enabled: false } })
      })
    }
    if (successAction === 'send_trigger_link') {
      nextGoalWorkflow = mergeGoalWorkflow(nextGoalWorkflow || goalWorkflow, {
        triggerLink: getTriggerLinkWorkflow(selectedTriggerLink || triggerLinks[0] || null)
      })
    }
    if (nextGoalWorkflow) patch.goalWorkflow = nextGoalWorkflow
    return patch
  }

  const handleGoalExecutionChange = (successAction: ConversationalSuccessAction) => {
    const patch = buildGoalExecutionPatch(successAction)
    onChange(patch)
  }

  const updateGoalUrl = (patch: { url?: string; trackingParam?: string }) => {
    if (agent.objective === 'ventas') {
      updateGoalWorkflow({ sales: { ...goalWorkflow.sales, ...patch } })
      return
    }
    updateGoalWorkflow({ appointments: { ...goalWorkflow.appointments, ...patch } })
  }

  const updateSalesProduct = (productId: string) => {
    const product = products.find((item) => getProductId(item) === productId) || null
    const price = getPrimaryPrice(product)
    updateGoalWorkflow({
      sales: {
        ...goalWorkflow.sales,
        productId: product ? getProductId(product) : '',
        priceId: getPriceId(price),
        productName: product?.name || '',
        priceName: price?.name || '',
        amount: price ? getPriceAmount(price) : null,
        currency: accountCurrency
      }
    })
  }

  const updateSalesPrice = (priceId: string) => {
    if (!selectedSalesProduct) return
    const price = (selectedSalesProduct.prices || []).find((item) => getPriceId(item) === priceId) || getPrimaryPrice(selectedSalesProduct)
    updateGoalWorkflow({
      sales: {
        ...goalWorkflow.sales,
        priceId: getPriceId(price),
        priceName: price?.name || '',
        amount: price ? getPriceAmount(price) : null,
        currency: accountCurrency
      }
    })
  }

  const updateTriggerLinkGoal = (triggerLinkId: string) => {
    const triggerLink = triggerLinks.find((link) => link.id === triggerLinkId) || null
    updateGoalWorkflow({ triggerLink: getTriggerLinkWorkflow(triggerLink) })
  }

  function clearTestVoiceTimer() {
    if (testVoiceTimerRef.current !== null) {
      window.clearInterval(testVoiceTimerRef.current)
      testVoiceTimerRef.current = null
    }
  }

  function stopTestVoiceWaveform() {
    if (testVoiceAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(testVoiceAnimationFrameRef.current)
      testVoiceAnimationFrameRef.current = null
    }

    try {
      testVoiceAudioSourceRef.current?.disconnect()
    } catch {
      // Best effort cleanup: Safari may already disconnect when tracks stop.
    }
    testVoiceAudioSourceRef.current = null
    testVoiceAnalyserRef.current = null
    testVoiceSamplesRef.current = null

    if (testVoiceAudioContextRef.current) {
      testVoiceAudioContextRef.current.close().catch(() => undefined)
      testVoiceAudioContextRef.current = null
    }
  }

  function startTestVoiceWaveform(stream: MediaStream) {
    stopTestVoiceWaveform()
    const AudioContextConstructor = getTestVoiceAudioContextConstructor()
    if (!AudioContextConstructor) return

    try {
      const audioContext = new AudioContextConstructor()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)

      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      const samples = new Uint8Array(analyser.fftSize)
      source.connect(analyser)

      testVoiceAudioContextRef.current = audioContext
      testVoiceAudioSourceRef.current = source
      testVoiceAnalyserRef.current = analyser
      testVoiceSamplesRef.current = samples
      testVoiceLastWaveUpdateRef.current = 0
      if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => undefined)
      }

      const drawWave = (timestamp: number) => {
        const currentAnalyser = testVoiceAnalyserRef.current
        const currentSamples = testVoiceSamplesRef.current
        if (!currentAnalyser || !currentSamples) return

        if (timestamp - testVoiceLastWaveUpdateRef.current > TEST_VOICE_WAVE_UPDATE_MS) {
          currentAnalyser.getByteTimeDomainData(currentSamples)
          const nextHeight = getTestVoiceBarHeight(currentSamples)
          setTestVoiceBars((current) => [...current.slice(1), nextHeight])
          testVoiceLastWaveUpdateRef.current = timestamp
        }

        testVoiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)
      }

      testVoiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)
    } catch {
      stopTestVoiceWaveform()
    }
  }

  function stopTestVoiceStream() {
    stopTestVoiceWaveform()
    testVoiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    testVoiceStreamRef.current = null
  }

  function cleanupTestVoiceRecorder() {
    clearTestVoiceTimer()
    const recorder = testVoiceRecorderRef.current
    if (recorder) {
      recorder.ondataavailable = null
      recorder.onstop = null
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // El navegador puede marcar inactive justo al limpiar; no afecta la prueba.
        }
      }
    }
    testVoiceRecorderRef.current = null
    stopTestVoiceStream()
    setTestVoiceBars(createTestVoiceBars())
  }

  const expireTestPracticeMedia = useCallback(() => {
    testPracticeExpiredRef.current = true
    cleanupTestVoiceRecorder()
    testVoiceAudioRef.current?.pause()
    setTestMessages([])
    setTestInput('')
    setTestAttachments([])
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    setTesting(false)
    setTestVoiceDraft(null)
    setTestVoiceRecording(false)
    setTestVoiceProcessing(false)
    setTestVoiceElapsedMs(0)
    setTestVoicePlaying(false)
    setTestVoiceBars(createTestVoiceBars())
    setTestPracticeExpired(true)
    void clearTestMediaCache().catch(() => undefined)
  }, [])

  useEffect(() => {
    if (testPracticeExpired) return
    const expiresAt = getNextTestMediaExpiration(testMessages, testAttachments, testVoiceDraft)
    if (!expiresAt) return

    const delayMs = expiresAt - Date.now()
    if (delayMs <= 0) {
      expireTestPracticeMedia()
      return
    }

    const timer = window.setTimeout(expireTestPracticeMedia, Math.min(delayMs, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [expireTestPracticeMedia, testAttachments, testMessages, testPracticeExpired, testVoiceDraft])

  async function submitTestMessage(input: { content?: string; attachments?: TestAttachment[]; clearComposer?: boolean }) {
    const content = String(input.content ?? '').trim()
    const attachments = input.attachments || []
    if (testPracticeExpired || testing || (!content && attachments.length === 0)) return

    const now = Date.now()
    if (attachments.some((attachment) => testAttachmentExpired(attachment, now)) || testMessages.some((message) => testMessageHasExpiredAttachment(message, now))) {
      expireTestPracticeMedia()
      return
    }

    const userMessage: TestMessage = {
      role: 'user',
      content,
      ...(attachments.length ? { attachments } : {})
    }
    const nextMessages: TestMessage[] = [...testMessages.filter((m) => !m.internal), userMessage]

    setTestMessages((current) => [...current, userMessage])
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    if (input.clearComposer !== false) {
      setTestInput('')
      setTestAttachments([])
    }
    setTesting(true)

    try {
      const agentForTest = await onFlushSave()
      const effectiveAgent = agentForTest || agent
      const result: ConversationalAgentTestResult = await conversationalAgentService.testAgent(
        nextMessages.map(toTestPayloadMessage),
        { config: agentToInput(effectiveAgent), agentId: effectiveAgent.id }
      )

      const responseDelayMs = normalizeTestResponseDelay(result.responseDelayMs)
      if (responseDelayMs > 0) {
        await waitForTestReplyDelay(responseDelayMs)
      }
      if (testPracticeExpiredRef.current) return

      for (const action of result.actions || []) {
        if (testPracticeExpiredRef.current) return
        setTestMessages((current) => [
          ...current,
          { role: 'assistant', content: describeConversationalPreviewAction(action), internal: true }
        ])
      }

      const visibleReplies = result.replyParts?.length ? result.replyParts : (result.reply ? [result.reply] : [])
      if (visibleReplies.length) {
        for (let index = 0; index < visibleReplies.length; index += 1) {
          const delayMs = normalizeTestReplyDelay(result.replyPartDelaysMs?.[index])
          if (index > 0 && delayMs > 0) {
            await waitForTestReplyDelay(delayMs)
          }
          if (testPracticeExpiredRef.current) return
          setTestMessages((current) => [...current, { role: 'assistant', content: visibleReplies[index] }])
        }
      } else if (result.suppressed) {
        if (testPracticeExpiredRef.current) return
        setTestMessages((current) => [...current, { role: 'assistant', content: '⚙︎ El agente decidió no responder (acción interna o silencio).', internal: true }])
      }
    } catch (error: any) {
      if (!testPracticeExpiredRef.current) {
        showToast('error', 'Prueba fallida', error?.message || 'No se pudo probar el agente')
      }
    } finally {
      if (!testPracticeExpiredRef.current) {
        setTesting(false)
      }
    }
  }

  const handleSendTestMessage = () => {
    if (testPracticeExpired) return
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    void submitTestMessage({
      content: testInput,
      attachments: testAttachments,
      clearComposer: true
    })
  }

  const handleOpenTestAttachmentPicker = () => {
    if (testPracticeExpired || testing || testVoicePanelActive) return
    setTestEmojiPickerOpen(false)
    setTestAttachmentMenuOpen((current) => !current)
  }

  const handlePickTestAttachment = (kind: 'photo' | 'file' | 'video') => {
    if (testPracticeExpired || testing || testVoicePanelActive) return
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    if (kind === 'photo') {
      testPhotoInputRef.current?.click()
      return
    }
    if (kind === 'video') {
      testVideoInputRef.current?.click()
      return
    }
    testFileInputRef.current?.click()
  }

  const handleToggleTestEmojiPicker = () => {
    if (testPracticeExpired || testing || testVoicePanelActive) return
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen((current) => !current)
  }

  const handleSelectTestEmoji = (emoji: string) => {
    if (testPracticeExpired || testing || testVoicePanelActive) return
    const input = testComposerInputRef.current

    setTestInput((current) => {
      if (!input) return `${current}${emoji}`

      const start = input.selectionStart ?? current.length
      const end = input.selectionEnd ?? start
      const next = `${current.slice(0, start)}${emoji}${current.slice(end)}`
      const cursorPosition = start + emoji.length

      window.requestAnimationFrame(() => {
        input.focus()
        input.setSelectionRange(cursorPosition, cursorPosition)
      })

      return next
    })
  }

  const handleTestAttachmentInputChange: React.ChangeEventHandler<HTMLInputElement> = async (event) => {
    const files = Array.from(event.currentTarget.files || [])
    event.currentTarget.value = ''
    if (!files.length || testPracticeExpired || testing) return

    const availableSlots = Math.max(0, MAX_TEST_ATTACHMENTS - testAttachments.length)
    if (availableSlots <= 0) {
      showToast('warning', 'Límite de archivos', `Puedes probar hasta ${MAX_TEST_ATTACHMENTS} adjuntos por mensaje.`)
      return
    }

    const acceptedFiles = files.slice(0, availableSlots)
    const oversized = acceptedFiles.find((file) => file.size > MAX_TEST_ATTACHMENT_BYTES)
    if (oversized) {
      showToast('error', 'Archivo muy pesado', `${oversized.name} supera el límite de 18 MB para pruebas.`)
      return
    }

    try {
      const attachments = await Promise.all(acceptedFiles.map(createTestAttachment))
      attachments.forEach(cacheTestAttachment)
      setTestAttachments((current) => [...current, ...attachments].slice(0, MAX_TEST_ATTACHMENTS))
      if (files.length > acceptedFiles.length) {
        showToast('warning', 'Algunos archivos no se agregaron', `El demo acepta ${MAX_TEST_ATTACHMENTS} adjuntos por mensaje.`)
      }
    } catch (error: any) {
      showToast('error', 'No se pudo leer el archivo', error?.message || 'Intenta con otro archivo.')
    }
  }

  const handleRemoveTestAttachment = (attachmentId: string) => {
    if (testPracticeExpired || testing) return
    setTestAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }

  const handleStopTestVoiceRecording = () => {
    if (testVoiceRecorderRef.current?.state === 'recording') {
      setTestVoiceProcessing(true)
      testVoiceRecorderRef.current.stop()
    }
  }

  const handleStartTestVoiceRecording = async () => {
    if (testPracticeExpired || testing || testVoiceRecording || testVoiceProcessing) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('error', 'Audio no disponible', 'Este navegador no permite grabar notas de voz aquí.')
      return
    }

    setTestVoiceProcessing(true)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = getSupportedTestVoiceMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      setTestAttachmentMenuOpen(false)
      setTestEmojiPickerOpen(false)
      testVoiceStreamRef.current = stream
      testVoiceRecorderRef.current = recorder
      testVoiceChunksRef.current = []
      testVoiceStartedAtRef.current = Date.now()
      testVoiceSendAfterStopRef.current = false
      testVoiceDiscardRef.current = false
      setTestVoiceDraft(null)
      setTestVoiceElapsedMs(0)
      setTestVoiceBars(createTestVoiceBars())
      startTestVoiceWaveform(stream)

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          testVoiceChunksRef.current.push(event.data)
        }
      }
      recorder.onstop = async () => {
        clearTestVoiceTimer()
        stopTestVoiceStream()
        testVoiceRecorderRef.current = null
        setTestVoiceRecording(false)
        setTestVoiceProcessing(true)

        const durationMs = Math.max(0, Date.now() - testVoiceStartedAtRef.current)
        const chunks = testVoiceChunksRef.current
        const sendAfterStop = testVoiceSendAfterStopRef.current
        const discard = testVoiceDiscardRef.current
        testVoiceSendAfterStopRef.current = false
        testVoiceDiscardRef.current = false

        if (discard) {
          setTestVoiceBars(createTestVoiceBars())
          setTestVoiceProcessing(false)
          return
        }

        try {
          const type = recorder.mimeType || mimeType || 'audio/webm'
          const blob = new Blob(chunks, { type })
          if (durationMs < MIN_TEST_VOICE_RECORDING_MS || blob.size === 0) {
            showToast('warning', 'Nota muy corta', 'Graba tantito más para que el agente pueda escuchar algo útil.')
            return
          }
          if (blob.size > MAX_TEST_ATTACHMENT_BYTES) {
            showToast('error', 'Audio muy pesado', 'La nota de voz supera el límite de 18 MB para pruebas.')
            return
          }

          const dataUrl = await readBlobAsDataUrl(blob)
          const id = `test-voice-${Date.now()}`
          const expiry = createTestMediaExpiry()
          const attachment: TestAttachment = {
            id,
            kind: 'audio',
            name: `nota-de-voz.${type.includes('mp4') ? 'm4a' : 'webm'}`,
            mimeType: type,
            size: blob.size,
            durationMs,
            dataUrl,
            cacheKey: createTestMediaCacheKey(id),
            ...expiry
          }
          cacheTestAttachment(attachment)

          if (sendAfterStop) {
            setTestVoiceDraft(null)
            await submitTestMessage({ content: '', attachments: [attachment], clearComposer: false })
          } else {
            setTestVoiceDraft(attachment)
          }
        } catch (error: any) {
          showToast('error', 'No se pudo preparar el audio', error?.message || 'Intenta grabarlo otra vez.')
        } finally {
          setTestVoiceProcessing(false)
        }
      }

      recorder.start()
      setTestVoiceRecording(true)
      setTestVoiceProcessing(false)
      testVoiceTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - testVoiceStartedAtRef.current
        setTestVoiceElapsedMs(elapsed)
        if (elapsed >= MAX_TEST_VOICE_RECORDING_MS) {
          handleStopTestVoiceRecording()
        }
      }, 160)
    } catch (error: any) {
      cleanupTestVoiceRecorder()
      setTestVoiceRecording(false)
      setTestVoiceProcessing(false)
      showToast('error', 'No se pudo grabar', error?.message || 'Revisa el permiso del micrófono e intenta de nuevo.')
    }
  }

  const handleCancelTestVoiceDraft = () => {
    if (testPracticeExpired) return
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    if (testVoiceRecording) {
      testVoiceSendAfterStopRef.current = false
      testVoiceDiscardRef.current = true
      testVoiceChunksRef.current = []
      handleStopTestVoiceRecording()
    }
    testVoiceAudioRef.current?.pause()
    setTestVoicePlaying(false)
    setTestVoiceDraft(null)
    setTestVoiceElapsedMs(0)
    setTestVoiceBars(createTestVoiceBars())
  }

  const handleTestVoicePrimary = () => {
    if (testPracticeExpired) return
    if (testVoiceRecording) {
      handleStopTestVoiceRecording()
      return
    }

    const audio = testVoiceAudioRef.current
    if (!audio) return
    if (testVoicePlaying) {
      audio.pause()
      setTestVoicePlaying(false)
      return
    }
    audio.play()
      .then(() => setTestVoicePlaying(true))
      .catch(() => showToast('error', 'No se pudo escuchar', 'Toca el audio otra vez.'))
  }

  const handleSendTestVoice = () => {
    if (testPracticeExpired) return
    if (testVoiceRecording) {
      testVoiceSendAfterStopRef.current = true
      handleStopTestVoiceRecording()
      return
    }
    if (!testVoiceDraft) return
    const attachment = testVoiceDraft
    setTestVoiceDraft(null)
    setTestVoiceElapsedMs(0)
    setTestVoicePlaying(false)
    setTestVoiceBars(createTestVoiceBars())
    void submitTestMessage({ content: '', attachments: [attachment], clearComposer: false })
  }

  const handleResetTestChat = () => {
    if (testing) return
    testPracticeExpiredRef.current = false
    cleanupTestVoiceRecorder()
    setTestMessages([])
    setTestInput('')
    setTestAttachments([])
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    setTestVoiceDraft(null)
    setTestVoiceRecording(false)
    setTestVoiceProcessing(false)
    setTestVoiceElapsedMs(0)
    setTestVoicePlaying(false)
    setTestVoiceBars(createTestVoiceBars())
    setTestPracticeExpired(false)
    void clearTestMediaCache().catch(() => undefined)
  }

  const appointmentSchedulingSettings = agent.objective === 'citas' ? (
    <>
      <div className={styles.field}>
        <label className={styles.label}>Calendario</label>
        <CustomSelect
          value={selectedGoalCalendarId}
          onChange={(event) => {
            const calendarId = event.target.value || null
            onChange({
              defaultCalendarId: calendarId,
              goalWorkflow: mergeGoalWorkflow(goalWorkflow, {
                appointments: { ...goalWorkflow.appointments, calendarId }
              })
            })
          }}
          placeholder={calendars.length === 0 ? 'No hay calendarios activos' : 'Elegir calendario'}
          portal
          disabled={calendars.length === 0}
        >
          {calendars.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
          ))}
        </CustomSelect>
        <p className={styles.helper}>El agente ofrecerá los espacios disponibles de este calendario.</p>
      </div>

      {showAiAppointmentSettings && (
        <div className={styles.field}>
          <label className={styles.label}>Empalme de citas</label>
          <CustomSelect
            value={goalWorkflow.appointments.allowOverlappingAppointments ? 'yes' : 'no'}
            onChange={(event) => {
              updateGoalWorkflow({
                appointments: {
                  ...goalWorkflow.appointments,
                  owner: 'ai',
                  allowOverlappingAppointments: event.target.value === 'yes'
                }
              })
            }}
            portal
          >
            {appointmentOverlapOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </CustomSelect>
          <p className={styles.helper}>
            Si está apagado, la IA sólo ofrece horarios sin otra cita. Si está prendido, puede agendar varias personas en el mismo horario.
          </p>
        </div>
      )}
    </>
  ) : null

  const paymentRequirementSettings = showPaymentRequirementSettings ? (
    <div className={styles.depositConfigBlock}>
      <div className={styles.inlineFields}>
        {agent.objective === 'ventas' ? (
          <div className={styles.field}>
            <label className={styles.label}>Tipo de venta</label>
            <CustomSelect
              value={salesPaymentMode}
              onChange={(event) => updateSalesPaymentMode(event.target.value as AgentSalesPaymentMode)}
              portal
            >
              {salesPaymentModeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </CustomSelect>
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label}>Pedir anticipo</label>
            <CustomSelect
              value={deposit.enabled ? 'yes' : 'no'}
              onChange={(event) => updateDeposit({ enabled: event.target.value === 'yes' })}
              portal
            >
              {binaryChoiceOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </CustomSelect>
          </div>
        )}

        {depositEnabledForForm && (
          <div className={styles.field}>
            <label className={styles.label}>Tipo de valor</label>
            <CustomSelect
              value={deposit.mode}
              onChange={(event) => updateDeposit({ mode: event.target.value as AgentDepositMode })}
              portal
            >
              {depositModeOptions.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </CustomSelect>
          </div>
        )}
      </div>

      {depositEnabledForForm && (
        <>
          <div className={styles.depositAmountFields}>
            {deposit.mode === 'range' ? (
              <>
                <div className={styles.field}>
                  <label className={styles.label}>Desde</label>
                  <div className={styles.moneyInputWrap}>
                    <span className={styles.moneyPrefix}>$</span>
                    <NumberInput
                      className={`${styles.input} ${styles.moneyInput}`}
                      min={0}
                      step={50}
                      value={deposit.minAmount ?? ''}
                      onValueChange={(value) => updateDeposit({ minAmount: value })}
                    />
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.label}>Hasta</label>
                  <div className={styles.moneyInputWrap}>
                    <span className={styles.moneyPrefix}>$</span>
                    <NumberInput
                      className={`${styles.input} ${styles.moneyInput}`}
                      min={0}
                      step={50}
                      value={deposit.maxAmount ?? ''}
                      onValueChange={(value) => updateDeposit({ maxAmount: value })}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.field}>
                <label className={styles.label}>Monto</label>
                <div className={styles.moneyInputWrap}>
                  <span className={styles.moneyPrefix}>$</span>
                  <NumberInput
                    className={`${styles.input} ${styles.moneyInput}`}
                    min={0}
                    step={50}
                    value={deposit.amount ?? ''}
                    onValueChange={(value) => updateDeposit({ amount: value })}
                  />
                </div>
              </div>
            )}
          </div>
          <p className={styles.helper}>
            {depositHelper}
          </p>

          <div className={styles.field}>
            <label className={styles.label}>Cómo puede pagar el anticipo</label>
            <div className={styles.depositMethodList}>
              <div className={styles.depositMethodRow}>
                <Switch
                  checked={depositMethods.paymentLink}
                  onChange={(next) => updateDepositMethods({ paymentLink: next })}
                  aria-label="Cobrar el anticipo con link de pago"
                />
                <span>Link de pago</span>
              </div>
              <div className={styles.depositMethodRow}>
                <Switch
                  checked={depositMethods.bankTransfer}
                  onChange={(next) => updateDepositMethods({ bankTransfer: next })}
                  aria-label="Cobrar el anticipo por transferencia bancaria"
                />
                <span>Transferencia bancaria</span>
              </div>
            </div>
            {!depositMethods.paymentLink && !depositMethods.bankTransfer && (
              <p className={`${styles.helper} ${styles.helperError}`}>
                Activa al menos un método para cobrar el anticipo.
              </p>
            )}
          </div>

          {depositMethods.bankTransfer && (
            <div className={styles.fieldWide}>
              <label className={styles.label}>Datos para transferencia</label>
              <textarea
                className={styles.textarea}
                value={deposit.bankTransferDetails || ''}
                placeholder="Banco, CLABE o cuenta, titular…"
                onChange={(event) => updateDeposit({ bankTransferDetails: event.target.value })}
                rows={3}
                maxLength={1200}
              />
              <p className={styles.helper}>
                El agente compartirá estos datos y pedirá foto del comprobante; la IA valida el monto y registra el anticipo.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  ) : null

  const goalUrlSettings = showGoalUrlSettings ? (
    <>
      {agent.objective === 'ventas' && (
        <>
          <div className={styles.field}>
            <label className={styles.label}>Producto del pedido</label>
            <CustomSelect
              value={goalWorkflow.sales.productId}
              onChange={(event) => updateSalesProduct(event.target.value)}
              portal
              disabled={productsLoading || products.length === 0}
            >
              {productOptions.map((option) => (
                <option key={option.value || 'empty-product'} value={option.value}>{option.label}</option>
              ))}
            </CustomSelect>
            <p className={styles.helper}>Ejemplo: si vendes un curso, aquí eliges ese curso.</p>
          </div>

          {selectedSalesProduct && (
            <div className={styles.field}>
              <label className={styles.label}>Precio del pedido</label>
              <CustomSelect
                value={goalWorkflow.sales.priceId}
                onChange={(event) => updateSalesPrice(event.target.value)}
                portal
              >
                {priceOptions.map((option) => (
                  <option key={option.value || 'base-price'} value={option.value}>{option.label}</option>
                ))}
              </CustomSelect>
              {selectedSalesPrice && (
                <p className={styles.helper}>
                  {selectedSalesProduct.name} · {formatCurrency(getPriceAmount(selectedSalesPrice), accountCurrency)}
                </p>
              )}
            </div>
          )}
        </>
      )}

      <div className={styles.fieldWide}>
        <label className={styles.label}>{goalUrlLabel}</label>
        <input
          className={styles.input}
          value={goalUrlConfig.url}
          placeholder={goalUrlPlaceholder}
          onChange={(event) => updateGoalUrl({ url: event.target.value })}
        />
        <p className={styles.helper}>
          {agent.objective === 'ventas'
            ? 'Debe ser una página conectada a Ristak que confirme el pago real. Si no puede confirmarlo, el agente pasará el chat a una persona.'
            : 'Debe ser una página conectada a Ristak que confirme la cita real. Si no puede confirmarla, el agente pasará el chat a una persona.'}
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>Código para reconocer el enlace</label>
        <input
          className={styles.input}
          value={goalUrlConfig.trackingParam ?? ''}
          placeholder={DEFAULT_GOAL_TRACKING_PARAM}
          onChange={(event) => updateGoalUrl({ trackingParam: event.target.value })}
          onBlur={() => {
            if (!goalUrlConfig.trackingParam?.trim()) updateGoalUrl({ trackingParam: DEFAULT_GOAL_TRACKING_PARAM })
          }}
        />
        <p className={styles.helper}>
          Permite relacionar el resultado real con esta conversación.
        </p>
      </div>

      <div className={styles.fieldWide}>
        <label className={styles.label}>Cómo sabe que ya pasó</label>
        <p className={styles.helper}>
          {agent.objective === 'ventas'
            ? 'Ristak sólo marca la meta cuando la página conectada confirma el pago con su ID real.'
            : 'Ristak sólo marca la meta cuando la página conectada confirma la cita con su ID real.'}
        </p>
      </div>
    </>
  ) : null

  const triggerLinkSettings = showTriggerLinkSettings ? (
    <>
      <div className={styles.field}>
        <label className={styles.label}>Enlace que va a mandar</label>
        <CustomSelect
          value={goalWorkflow.triggerLink.triggerLinkId}
          onChange={(event) => updateTriggerLinkGoal(event.target.value)}
          portal
          disabled={triggerLinksLoading || triggerLinks.length === 0}
        >
          {triggerLinkOptions.map((option) => (
            <option key={option.value || 'empty-trigger-link'} value={option.value}>{option.label}</option>
          ))}
        </CustomSelect>
        <p className={styles.helper}>
          Ejemplo: manda un link y deja de contestar cuando la persona lo abre.
        </p>
      </div>

      <div className={styles.fieldWide}>
        <label className={styles.label}>Qué pasa al tocarlo</label>
        <p className={styles.helper}>
          {selectedTriggerLink
            ? `Ejemplo: si toca "${selectedTriggerLink.name}", el chat pasa al equipo.`
            : 'Ejemplo: elige un link para saber cuándo la persona lo abrió.'}
        </p>
      </div>
    </>
  ) : null

  const goalExecutionSettings = appointmentSchedulingSettings || goalUrlSettings || triggerLinkSettings ? (
    <div className={styles.agentOpsGrid}>
      {appointmentSchedulingSettings}
      {goalUrlSettings}
      {triggerLinkSettings}
    </div>
  ) : null

  return (
    <div className={styles.agentDetailLayout}>
      <Card padding="md" className={styles.conversationAgentCard}>
        <div className={styles.agentDetailTopbar}>
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft size={16} />
            Volver
          </Button>
          <div className={styles.agentStickyActions}>
            <Badge variant={agent.enabled ? 'success' : 'neutral'}>
              {agent.enabled ? 'Publicado' : 'En pausa'}
            </Badge>
            <Button
              variant={agent.enabled ? 'secondary' : 'primary'}
              onClick={() => onChange({ enabled: !agent.enabled })}
              disabled={!agent.enabled && (legacyBusinessPromptBlocked || Boolean(publishValidationError))}
              title={!agent.enabled ? (publishValidationError || (legacyBusinessPromptBlocked ? promptBlockerText : undefined)) : undefined}
            >
              {agent.enabled ? <Pause size={16} /> : <Play size={16} />}
              {agent.enabled ? 'Pausar' : 'Publicar'}
            </Button>
          </div>
        </div>

        <div className={styles.agentConfigColumn}>
          <div className={styles.agentCardHeader}>
            <span className={`${styles.iconBox} ${agent.enabled ? '' : styles.iconBoxMuted}`}>
              <Bot size={20} />
            </span>
            <input
              className={styles.agentNameInput}
              value={agent.name}
              onChange={(event) => onChange({ name: event.target.value })}
              placeholder="Nombre del agente"
              aria-label="Nombre del agente"
            />
            <div className={styles.agentCardActions}>
              <button type="button" className={styles.iconButton} onClick={onDelete} aria-label={`Eliminar ${agent.name}`}>
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          <p className={styles.agentCardSummary}>
            {agent.runtimeMode === 'tool_calling_v2'
              ? `${(agent.capabilitiesConfig?.items || []).filter((item) => item.enabled).length} capacidades activas · herramientas protegidas`
              : `${selectedObjective.label} · ${selectedGoalExecutionInfo.label}`}
            {entryCount > 0
              ? ` · entra con ${entryCount} ${entryCount === 1 ? 'regla' : 'reglas'}`
              : ' · entra con cualquier chat'}
            {exitCount > 0 ? ` · se suelta con ${exitCount}` : ''}
            {responseDelaySummary ? ` · espera ${responseDelaySummary}` : ''}
            {replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split' ? ' · responde en partes' : ''}
            {followUpSummary ? ` · ${followUpSummary}` : ''}
          </p>
          {legacyBusinessPromptBlocked && (
            <div className={styles.promptReadinessNotice}>
              <strong>{promptStatusText}</strong>
              <span>{promptBlockerText}</span>
            </div>
          )}

          <NativeConversationBuilder
            agent={agent}
            calendars={calendars}
            products={products}
            productsLoading={productsLoading}
            teamUsers={teamUsers}
            teamUsersLoading={teamUsersLoading}
            accountCurrency={accountCurrency}
            onChange={onChange}
          />

          {agent.runtimeMode !== 'tool_calling_v2' && (
          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>1. Personalidad e instrucciones</h3>
            <p className={styles.agentSectionHint}>
              Define cómo se presenta, qué tono usa y qué reglas de negocio mandan por encima de la configuración normal.
            </p>
            <div className={styles.configQuestionList}>
              <QuestionSelectRow
                question="¿Cómo quieres que se identifique el agente?"
                helper={identityHelper}
                error={identityError}
                value={selectedIdentityMode}
                options={agentIdentityModeOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                  disabled: option.value === 'user' && (teamUsersLoading || teamUsers.length === 0)
                }))}
                selectLabel="Identidad del agente"
                onChange={updateIdentityMode}
              >
                {selectedIdentityMode === 'user' && teamUsers.length > 0 && (
                  <div className={styles.inlineFields}>
                    <div className={styles.field}>
                      <label className={styles.label}>Persona visible</label>
                      <CustomSelect
                        value={agent.identityUserId || ''}
                        onChange={(event) => {
                          const user = teamUsers.find((item) => item.id === event.target.value) || null
                          onChange({
                            identityUserId: user?.id || '',
                            identityUserName: getTeamUserDisplayName(user),
                            identityCustomName: ''
                          })
                        }}
                        portal
                      >
                        {teamUserOptions.map((option) => (
                          <option key={option.value || 'identity-empty-user'} value={option.value}>{option.label}</option>
                        ))}
                      </CustomSelect>
                    </div>
                  </div>
                )}

                {selectedIdentityMode === 'custom' && (
                  <div className={styles.inlineFields}>
                    <div className={styles.field}>
                      <label className={styles.label}>Nombre visible</label>
                      <input
                        className={styles.input}
                        value={agent.identityCustomName || ''}
                        placeholder="Ejemplo: Marcos, Raúl o Robot 34"
                        onChange={(event) => onChange({ identityCustomName: event.target.value })}
                      />
                    </div>
                  </div>
                )}
              </QuestionSelectRow>

              <div className={styles.configQuestion}>
                <div className={styles.field}>
                  <label className={styles.label}>Qué tan persuasivo debe ser</label>
                  <TabList
                    fullWidth
                    tabs={persuasionLevelTabs}
                    activeTab={agent.persuasionLevel}
                    onTabChange={(value) => onChange({ persuasionLevel: value as ConversationalPersuasionLevel })}
                  />
                  <p className={styles.helper}>{persuasionLevelHelp[agent.persuasionLevel]}</p>
                </div>
              </div>

              <div className={styles.configQuestion}>
                <div className={styles.field}>
                  <label className={styles.label}>Cómo debe hablar</label>
                  <TabList
                    fullWidth
                    tabs={languageLevelTabs}
                    activeTab={agent.languageLevel}
                    onTabChange={(value) => onChange({ languageLevel: value as ConversationalLanguageLevel })}
                  />
                  <p className={styles.helper}>{languageLevelHelp[agent.languageLevel]}</p>
                </div>
              </div>

              <div className={styles.configQuestion}>
                <div className={styles.field}>
                  <label className={styles.label}>Personalización y capacitación del asistente</label>
                  <textarea
                    className={styles.textarea}
                    value={agent.extraInstructions}
                    placeholder={'Ejemplo:\n- No des el valor ni rangos hasta saber qué servicio quiere, cuál es su problema y qué resultado busca\n- Si pregunta precio sin contexto, pide primero que explique su caso\n- Si preguntan por el color rosa, di que no hay\n- Para agendar cita, primero deben decir si tienen estado clínico; si no, NO los agendas'}
                    onChange={(event) => onChange({ extraInstructions: event.target.value })}
                    rows={5}
                  />
                  <p className={styles.helper}>
                    Reglas del negocio que siempre debe cumplir. Esto personaliza conducta, límites, datos que debe pedir y casos especiales; el prompt de fábrica de Ristak se usa por dentro y no se edita desde aquí.
                  </p>
                  <div className={styles.guidanceExamples} aria-label="Ejemplos de personalización y capacitación">
                    <span>Ejemplos que sí van aquí:</span>
                    <ul>
                      <li>No des precio hasta conocer el problema o reto completo.</li>
                      <li>No prometas resultados garantizados ni tiempos que no estén confirmados.</li>
                      <li>Si falta nombre, servicio o teléfono, pídelo antes de pasar a humano.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
          )}

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>{agent.runtimeMode === 'tool_calling_v2' ? '3' : '2'}. Operación técnica del chat</h3>
            <p className={styles.agentSectionHint}>
              Configura el motor de IA, tiempos, formato de mensajes, notificaciones y recordatorios.
            </p>
            <div className={styles.configQuestionList}>
              <QuestionSelectRow
                question="¿Qué IA va a contestar?"
                helper={`Es el cerebro que escribe los mensajes. Ejemplo: ${selectedProvider.label} contesta este agente.`}
                value={selectedProviderId}
                options={conversationalAIProviderOptions.map((provider) => {
                  const status = getProviderStatus(aiProviders, provider.id)
                  const connected = Boolean(status?.connected)
                  return {
                    value: provider.id,
                    label: `${provider.label} · ${connected ? 'Conectado' : 'Toca para conectar'}`
                  }
                })}
                selectLabel="IA del agente"
                onChange={(providerId) => handleProviderSelect(getKnownConversationalAIProvider(providerId))}
              >
                <div className={styles.inlineMeta}>
                  <Badge variant={selectedProviderConnected ? 'success' : 'neutral'}>
                    {selectedProviderConnected ? 'Conectado' : 'Toca para conectar'}
                  </Badge>
                  {selectedProviderStatus?.needsReconnect && (
                    <span className={styles.helperWarning}>{selectedProviderStatus.connectionIssue || `${selectedProvider.label} necesita reconectarse.`}</span>
                  )}
                </div>
              </QuestionSelectRow>

              <QuestionSelectRow
                question={`¿Qué modelo de ${selectedProvider.label} va a usar?`}
                helper={`Elige el modelo exacto que va a escribir. Ejemplo: ${selectedAgentModel?.label || selectedAgentModelValue} se usa sólo en este agente.`}
                value={selectedAgentModelValue}
                options={selectedAgentModelOptions}
                selectLabel={`Modelo de ${selectedProvider.label}`}
                onChange={(model) => onChange({ model })}
              />

              <QuestionSelectRow
                question="¿Cuánto debe esperar antes de contestar?"
                helper={getResponseDelayHelp(responseDelay)}
                error={responseDelayError}
                value={responseDelay.mode}
                options={responseDelayModeOptions}
                selectLabel="Espera antes de responder"
                onChange={(mode) => updateResponseDelay({ mode })}
              >
                {responseDelay.mode === 'fixed' && (
                  <div className={styles.inlineFields}>
                    <div className={`${styles.field} ${styles.delayNumberField}`}>
                      <label className={styles.label}>Tiempo</label>
                      <NumberInput
                        className={`${styles.input} ${styles.delayNumberInput}`}
                        min={0}
                        step={1}
                        value={responseDelay.fixedValue}
                        onValueChange={(fixedValue) => updateResponseDelay({ fixedValue })}
                      />
                    </div>
                    <div className={`${styles.field} ${styles.delayUnitField}`}>
                      <label className={styles.label}>Unidad</label>
                      <CustomSelect
                        value={responseDelay.fixedUnit}
                        onChange={(event) => updateResponseDelay({ fixedUnit: event.target.value as AgentResponseDelayUnit })}
                        portal
                      >
                        {responseDelayUnitOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </CustomSelect>
                    </div>
                  </div>
                )}

                {responseDelay.mode === 'random' && (
                  <div className={styles.inlineFields}>
                    <div className={`${styles.field} ${styles.delayNumberField}`}>
                      <label className={styles.label}>Mínimo</label>
                      <NumberInput
                        className={`${styles.input} ${styles.delayNumberInput}`}
                        min={0}
                        step={1}
                        value={responseDelay.minValue}
                        onValueChange={(minValue) => updateResponseDelay({ minValue })}
                      />
                    </div>
                    <div className={`${styles.field} ${styles.delayNumberField}`}>
                      <label className={styles.label}>Máximo</label>
                      <NumberInput
                        className={`${styles.input} ${styles.delayNumberInput}`}
                        min={0}
                        step={1}
                        value={responseDelay.maxValue}
                        onValueChange={(maxValue) => updateResponseDelay({ maxValue })}
                      />
                    </div>
                    <div className={`${styles.field} ${styles.delayUnitField}`}>
                      <label className={styles.label}>Unidad</label>
                      <CustomSelect
                        value={responseDelay.rangeUnit}
                        onChange={(event) => updateResponseDelay({ rangeUnit: event.target.value as AgentResponseDelayUnit })}
                        portal
                      >
                        {responseDelayUnitOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </CustomSelect>
                    </div>
                  </div>
                )}
              </QuestionSelectRow>

              <QuestionSelectRow
                question="¿Quieres que mande mensajes como persona?"
                helper={getReplyDeliveryHelp(replyDelivery)}
                error={replyDeliveryError}
                value={humanMessagesEnabled ? 'yes' : 'no'}
                options={binaryChoiceOptions}
                selectLabel="Modo mensajes humanos"
                onChange={(value) => {
                  const enabled = value === 'yes'
                  updateReplyDelivery({
                    mode: (enabled ? 'split' : 'single') as AgentReplyDeliveryMode,
                    splitMessagesEnabled: enabled,
                    ...(enabled ? systemReplyDeliveryDefaults : {})
                  })
                }}
              >
                {humanMessagesEnabled && (
                  <div className={`${styles.inlineFields} ${styles.selectAlignedFields}`}>
                    <div className={`${styles.field} ${styles.delayNumberField}`}>
                      <label className={styles.label}>Pausa mínima</label>
                      <NumberInput
                        className={`${styles.input} ${styles.delayNumberInput}`}
                        min={0}
                        max={60}
                        step={1}
                        value={replyDelivery.minDelaySeconds}
                        onValueChange={(minDelaySeconds) => updateReplyDelivery({ minDelaySeconds })}
                      />
                    </div>
                    <div className={`${styles.field} ${styles.delayNumberField}`}>
                      <label className={styles.label}>Pausa máxima</label>
                      <NumberInput
                        className={`${styles.input} ${styles.delayNumberInput}`}
                        min={0}
                        max={60}
                        step={1}
                        value={replyDelivery.maxDelaySeconds}
                        onValueChange={(maxDelaySeconds) => updateReplyDelivery({ maxDelaySeconds })}
                      />
                    </div>
                  </div>
                )}
              </QuestionSelectRow>

              <QuestionSelectRow
                question="¿Quieres recibir notificaciones mientras el agente IA toma la conversación?"
                helper={selectedAttendedChatAction.description}
                value={selectedAttendedChatActionValue}
                options={attendedChatActionOptions.map((option) => ({ value: option.value, label: option.label }))}
                selectLabel="Notificaciones mientras el agente atiende"
                onChange={(value) => onChange(getAttendedChatActionPatch(value as AttendedChatActionValue))}
              />

              <QuestionSelectRow
                question="¿Quieres mandar un recordatorio?"
                helper="Sólo se manda si la persona no responde. Ejemplo: el agente retoma lo último que hablaron."
                value={followUp.enabled ? 'yes' : 'no'}
                options={binaryChoiceOptions}
                selectLabel="Seguimiento del contacto"
                onChange={(value) => {
                  const enabled = value === 'yes'
                  updateFollowUp({
                    enabled,
                    first: { ...followUp.first, enabled: true },
                    second: { ...followUp.second, enabled: enabled ? followUp.second.enabled : false },
                    strategy: followUp.strategy || defaultFollowUpStrategy
                  })
                }}
              />

              {followUp.enabled && (
                <>
                  <div className={`${styles.followUpDelayRow} ${styles.followUpDelayRowSpaced}`}>
                    <span className={styles.followUpDelayLabel}>¿Cuándo lo manda?</span>
                    <span className={styles.followUpDelayText}>Después de</span>
                    <NumberInput
                      className={`${styles.input} ${styles.delayNumberInput}`}
                      min={1}
                      max={getFollowUpMaxValue(followUp.first.unit)}
                      step={1}
                      value={followUp.first.value}
                      onValueChange={(value) => updateFollowUpStep('first', { value })}
                    />
                    <CustomSelect
                      value={followUp.first.unit}
                      onChange={(event) => updateFollowUpStep('first', { unit: event.target.value as AgentFollowUpUnit })}
                      portal
                      aria-label="Unidad del primer seguimiento"
                    >
                      {followUpUnitOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                    <span className={styles.followUpDelayText}>desde el último mensaje enviado.</span>
                  </div>

                  <QuestionSelectRow
                    question="¿Quieres mandar un segundo recordatorio?"
                    helper="Sólo sale si todavía no responde. Ejemplo: un último mensaje corto más tarde."
                    error={followUp.second.enabled ? followUpError : ''}
                    value={followUp.second.enabled ? 'yes' : 'no'}
                    options={binaryChoiceOptions}
                    selectLabel="Segundo seguimiento"
                    onChange={(value) => updateFollowUpStep('second', { enabled: value === 'yes' })}
                  >
                    {followUp.second.enabled && (
                      <div className={styles.followUpDelayRow}>
                        <span className={styles.followUpDelayLabel}>Segundo recordatorio</span>
                        <span className={styles.followUpDelayText}>Después de</span>
                        <NumberInput
                          className={`${styles.input} ${styles.delayNumberInput}`}
                          min={1}
                          max={getFollowUpMaxValue(followUp.second.unit)}
                          step={1}
                          value={followUp.second.value}
                          onValueChange={(value) => updateFollowUpStep('second', { value })}
                        />
                        <CustomSelect
                          value={followUp.second.unit}
                          onChange={(event) => updateFollowUpStep('second', { unit: event.target.value as AgentFollowUpUnit })}
                          portal
                          aria-label="Unidad del segundo seguimiento"
                        >
                          {followUpUnitOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </CustomSelect>
                        <span className={styles.followUpDelayText}>desde el último mensaje enviado.</span>
                      </div>
                    )}
                  </QuestionSelectRow>

                  <div className={styles.fieldWide}>
                    <label className={styles.label}>Qué debe decir en el recordatorio</label>
                    <textarea
                      className={styles.textarea}
                      value={followUp.strategy}
                      placeholder="Ejemplo: retoma lo último que dijo, no vendas de golpe y abre con una pregunta corta."
                      onChange={(event) => updateFollowUp({ strategy: event.target.value })}
                      rows={4}
                    />
                    <p className={`${styles.helper} ${followUpError ? styles.helperError : ''}`}>
                      {followUpError || 'Ejemplo: que salude corto, use lo último que dijo la persona y haga una sola pregunta.'}
                    </p>
                  </div>
                </>
              )}
            </div>
          </div>

          {agent.runtimeMode !== 'tool_calling_v2' && (
          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>3. Objetivo y cierre</h3>
            <p className={styles.agentSectionHint}>
              Define la meta, quién la cumple y qué pasa después. Ejemplo: pedir anticipo antes de agendar.
            </p>
            <div className={styles.configQuestionList}>
              <QuestionSelectRow
                question="¿Cuál es la meta?"
                helper={selectedObjective.description}
                value={agent.objective}
                options={objectiveOptions.map((option) => ({ value: option.value, label: option.label }))}
                selectLabel="Objetivo del agente"
                onChange={(objective) => handleObjectiveChange(objective as ConversationalObjective)}
              />

              <QuestionSelectRow
                question={getLocalizedGoalExecutionQuestion(agent.objective)}
                helper={selectedGoalExecutionInfo.description}
                value={selectedGoalExecutionInfo.value}
                options={goalExecutionOptions.map((option) => ({ value: option.value, label: option.label }))}
                selectLabel="Quién cumple la meta"
                onChange={(action) => handleGoalExecutionChange(action as ConversationalSuccessAction)}
              >
                {goalExecutionSettings}
                {paymentRequirementSettings}
              </QuestionSelectRow>

              {showCompletionSettings && (
                <QuestionSelectRow
                  question="Cuando la IA cumpla el objetivo, ¿qué debe pasar?"
                  helper={completionMode === 'assign_user'
                    ? (selectedCompletionUser
                        ? `Se asigna a ${selectedCompletionUser.fullName || selectedCompletionUser.email || selectedCompletionUser.phone || selectedCompletionUser.username} y manda notificación.`
                        : 'Elige quién lo toma cuando el bot termine.')
                    : 'El bot deja de atender ese chat y manda una notificación para que el equipo lo vea.'}
                  value={completionMode}
                  options={completionModeOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                    disabled: option.value === 'assign_user' && (teamUsersLoading || teamUsers.length === 0)
                  }))}
                  selectLabel="Qué pasa al cumplir el objetivo"
                  onChange={(mode) => {
                    if (mode === 'assign_user' && (teamUsersLoading || teamUsers.length === 0)) return
                    if (mode === 'assign_user') {
                      const user = selectedCompletionUser || teamUsers[0] || null
                      updateCompletion({
                        mode,
                        userId: user?.id || completion.userId || '',
                        userName: user ? (user.fullName || user.email || user.phone || user.username || '') : completion.userName
                      })
                      return
                    }
                    updateCompletion({ mode: 'notify_only', userId: '', userName: '' })
                  }}
                >
                  {completionMode === 'assign_user' && teamUsers.length > 0 && (
                    <div className={styles.inlineFields}>
                      <div className={styles.field}>
                        <label className={styles.label}>Usuario asignado</label>
                        <CustomSelect
                          value={completion.userId}
                          onChange={(event) => {
                            const user = teamUsers.find((item) => item.id === event.target.value) || null
                            updateCompletion({
                              userId: user?.id || '',
                              userName: user ? (user.fullName || user.email || user.phone || user.username || '') : ''
                            })
                          }}
                          portal
                        >
                          {teamUserOptions.map((option) => (
                            <option key={option.value || 'empty-user'} value={option.value}>{option.label}</option>
                          ))}
                        </CustomSelect>
                      </div>
                    </div>
                  )}
                </QuestionSelectRow>
              )}
            </div>

            {agent.objective === 'custom' && (
              <div className={styles.fieldWide}>
                <label className={styles.label}>Objetivo escrito a mano</label>
                <textarea
                  className={styles.textarea}
                  value={agent.customObjective}
                  placeholder="Ejemplo: que pida una propuesta formal para su empresa."
                  onChange={(event) => onChange({ customObjective: event.target.value })}
                  rows={2}
                />
              </div>
            )}

            <details className={styles.advancedDetails} open={agent.successExtras.length > 0 || undefined}>
              <summary>
                <span>Cosas extra al terminar</span>
                <small>Ejemplo: poner una etiqueta o guardar un dato.</small>
              </summary>
              <div className={styles.advancedContent}>
                {agent.successExtras.map((extra, index) => (
                  <div key={index} className={styles.extraRow}>
                    <select
                      className={styles.ruleSelect}
                      value={extra.type}
                      onChange={(event) => updateExtra(index, { type: event.target.value as SuccessExtraType })}
                    >
                      {extraTypeOptions.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                    {extra.type === 'set_custom_field' ? (
                      <>
                        <select
                          className={styles.ruleSelect}
                          value={extra.field || ''}
                          onChange={(event) => updateExtra(index, { field: event.target.value })}
                        >
                          <option value="">
                            {customFieldOptions.length ? 'Elige el campo' : 'No hay campos personalizados activos'}
                          </option>
                          {extra.field && !customFieldOptions.some((field) => field.key === extra.field) && (
                            <option value={extra.field}>{extra.field} · guardado</option>
                          )}
                          {customFieldOptions.map((field) => (
                            <option key={field.key} value={field.key}>{field.label}</option>
                          ))}
                        </select>
                        <input
                          className={styles.ruleInput}
                          value={extra.value || ''}
                          placeholder="Valor"
                          onChange={(event) => updateExtra(index, { value: event.target.value })}
                        />
                      </>
                    ) : (
                      <div className={styles.conditionTagPicker}>
                        <TagPicker
                          value={extra.tag || ''}
                          onValueChange={(tagId) => updateExtra(index, { tag: tagId })}
                          allowCreate
                          portal
                          placeholder="Elige una etiqueta"
                          aria-label="Etiqueta de la acción"
                        />
                      </div>
                    )}
                    <button
                      type="button"
                      className={styles.ruleDelete}
                      onClick={() => onChange({ successExtras: agent.successExtras.filter((_, i) => i !== index) })}
                      aria-label="Quitar acción"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.ruleAddButton}
                  onClick={() => onChange({ successExtras: [...agent.successExtras, { type: 'add_tag', tag: '' }] })}
                >
                  <Plus size={14} />
                  Añadir acción
                </button>
                <p className={styles.helper}>
                  Ejemplo: cuando agenda, puede poner la etiqueta "cita lista".
                </p>
              </div>
            </details>
          </div>
          )}

          {agent.runtimeMode !== 'tool_calling_v2' && (
          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>4. Reglas de atención</h3>
            <p className={styles.agentSectionHint}>
              Define datos obligatorios y casos donde el agente debe dejar de improvisar y pasar el chat al equipo.
            </p>
            <div className={styles.configQuestionList}>
              <QuestionSelectRow
                question="¿Debe pedir algún dato?"
                helper="Si ya lo tiene, no lo vuelve a pedir. Ejemplo: nombre, teléfono o servicio que quiere."
                value={requiredDataConfigOpen ? 'yes' : 'no'}
                options={binaryChoiceOptions}
                selectLabel="Datos que debe pedir"
                onChange={(value) => {
                  const enabled = value === 'yes'
                  setGuidanceOpen((current) => ({ ...current, requiredData: enabled }))
                  if (!enabled) onChange({ requiredData: '' })
                }}
              >
                {requiredDataConfigOpen && (
                  <textarea
                    className={styles.textarea}
                    value={agent.requiredData}
                    placeholder={'Ejemplo:\n- Nombre completo\n- Servicio que le interesa'}
                    onChange={(event) => onChange({ requiredData: event.target.value })}
                    rows={3}
                  />
                )}
              </QuestionSelectRow>

              <QuestionSelectRow
                question="¿Cuándo debe pasar el chat al equipo?"
                helper="Úsalo para casos que una persona debe ver. Ejemplo: enojo, facturación o algo delicado."
                value={handoffRulesConfigOpen ? 'yes' : 'no'}
                options={binaryChoiceOptions}
                selectLabel="Cuándo pasar al equipo"
                onChange={(value) => {
                  const enabled = value === 'yes'
                  setGuidanceOpen((current) => ({ ...current, handoffRules: enabled }))
                  if (!enabled) onChange({ handoffRules: '' })
                }}
              >
                {handoffRulesConfigOpen && (
                  <textarea
                    className={styles.textarea}
                    value={agent.handoffRules}
                    placeholder={'Ejemplo:\n- Se enojó\n- Pregunta por facturación'}
                    onChange={(event) => onChange({ handoffRules: event.target.value })}
                    rows={3}
                  />
                )}
              </QuestionSelectRow>

              <div className={styles.configQuestion}>
                <div className={styles.configQuestionHeader}>
                  <div className={styles.configQuestionCopy}>
                    <span>Clientes existentes van con tu equipo</span>
                    <small>
                      Si la IA detecta que ya es cliente (tiene pagos o citas previas, o dice serlo aunque escriba de otro número), pasa el chat directo a un humano.
                    </small>
                  </div>
                  <div className={styles.configQuestionSwitch}>
                    <Switch
                      checked={Boolean(goalWorkflow.attention?.pastClientsToHuman)}
                      onChange={(next) => updateGoalWorkflow({ attention: { pastClientsToHuman: next } })}
                      aria-label="Clientes existentes van con tu equipo"
                    />
                  </div>
                </div>
              </div>

            </div>
          </div>
          )}

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>{agent.runtimeMode === 'tool_calling_v2' ? '4' : '5'}. Entrada y salida</h3>
            <p className={styles.agentSectionHint}>
              Define a qué contactos puede tomar, con qué reglas entra y cuándo debe soltar la conversación.
            </p>
            <div className={styles.field}>
              <label className={styles.label}>¿A quién puede atender?</label>
              <CustomSelect
                value={agent.contactScope}
                onChange={(event) => onChange({ contactScope: (event.target.value || 'all') as ConversationalContactScope })}
                portal
              >
                <option value="new_only">A todos los nuevos contactos desde ahora</option>
                <option value="all">A todos los nuevos mensajes desde ahora</option>
                <option value="existing_only">A todos los contactos existentes</option>
              </CustomSelect>
              <p className={styles.helper}>
                {agent.contactScope === 'new_only'
                  ? 'Solo tomará chats de contactos creados a partir de ahora; tu base actual no se toca.'
                  : agent.contactScope === 'existing_only'
                    ? 'Solo tomará chats de contactos que ya existían hasta ahora; los leads nuevos no entran (útil para reactivar tu base).'
                    : 'Tomará cualquier chat donde llegue un mensaje nuevo, sea contacto nuevo o de tu base.'}
              </p>
            </div>
            <ConditionBuilder
              groups={agent.filters.entry.groups}
              mode="entry"
              calendars={calendars}
              options={filterOptions}
              emptyText="Sin reglas: puede contestar cualquier chat nuevo."
              onChange={(groups) => onChange({ filters: { ...agent.filters, entry: { groups } } })}
            />

            <div className={styles.agentNestedSection}>
              <div className={styles.agentSubsectionHeader}>
                <h4>Cuándo se detiene</h4>
                <span>Opcional</span>
              </div>
              <p className={styles.agentSectionHint}>
                Puedes hacer que deje de contestar cuando pase algo. Ejemplo: cuando ya haya cita o cuando alguien del equipo tome el chat.
              </p>
              <ConditionBuilder
                groups={agent.filters.exit.groups}
                mode="exit"
                calendars={calendars}
                options={filterOptions}
                emptyText="Opcional: si no agregas reglas, se detiene cuando cumple la meta o un humano toma el chat."
                onChange={(groups) => onChange({ filters: { ...agent.filters, exit: { groups } } })}
              />
            </div>
          </div>

        </div>
      </Card>

      <aside className={styles.agentTestColumn}>
        <div className={styles.agentTestPanel}>
          <PhoneChatPreview
            className={styles.agentTestPhonePreview}
            title="Mi negocio"
            subtitle="Prueba interna"
            avatarLabel="Mi negocio"
            messages={testPreviewMessages}
            emptyText={testPracticeExpired ? TEST_MEDIA_EXPIRED_NOTICE : `Escribe como ${leadLowerLabel} y revisa si contesta como debe.`}
            typing={!testPracticeExpired && testing}
            headerActions={[
              {
                id: 'reset',
                label: 'Reiniciar chat de prueba',
                icon: <RotateCcw size={16} />,
                onClick: handleResetTestChat,
                disabled: testing || !hasTestConversation
              }
            ]}
            composer={(
              <>
                <input
                  ref={testPhotoInputRef}
                  type="file"
                  accept={TEST_PHOTO_ATTACHMENT_ACCEPT}
                  multiple
                  hidden
                  onChange={handleTestAttachmentInputChange}
                />
                <input
                  ref={testFileInputRef}
                  type="file"
                  accept={TEST_FILE_ATTACHMENT_ACCEPT}
                  multiple
                  hidden
                  onChange={handleTestAttachmentInputChange}
                />
                <input
                  ref={testVideoInputRef}
                  type="file"
                  accept={TEST_VIDEO_ATTACHMENT_ACCEPT}
                  multiple
                  hidden
                  onChange={handleTestAttachmentInputChange}
                />
                <PhoneChatPreviewAttachmentMenu
                  open={testAttachmentMenuOpen}
                  actions={[
                    {
                      id: 'photo',
                      label: 'Mandar foto',
                      icon: <ImageIcon size={29} />,
                      onClick: () => handlePickTestAttachment('photo')
                    },
                    {
                      id: 'file',
                      label: 'Mandar archivo',
                      icon: <FileText size={29} />,
                      onClick: () => handlePickTestAttachment('file')
                    },
                    {
                      id: 'video',
                      label: 'Mandar video',
                      icon: <Video size={29} />,
                      onClick: () => handlePickTestAttachment('video')
                    }
                  ]}
                />
                <PhoneChatPreviewEmojiPicker
                  open={testEmojiPickerOpen}
                  onSelect={handleSelectTestEmoji}
                />
                <PhoneChatPreviewDraftAttachments
                  attachments={testAttachments}
                  onRemove={handleRemoveTestAttachment}
                />
                <PhoneChatPreviewComposer
                  inputRef={testComposerInputRef}
                  value={testInput}
                  placeholder={testPracticeExpired ? 'Prueba expirada. Reinicia el chat.' : 'Ejemplo: Hola, quiero agendar'}
                  disabled={testPracticeExpired}
                  controlsDisabled={testing}
                  sendDisabled={testPracticeExpired || testing || (!testInput.trim() && testAttachments.length === 0)}
                  hasDraftContent={testAttachments.length > 0}
                  onChange={setTestInput}
                  onSend={handleSendTestMessage}
                  onAttach={handleOpenTestAttachmentPicker}
                  onEmoji={handleToggleTestEmojiPicker}
                  onVoice={handleStartTestVoiceRecording}
                  emojiOpen={testEmojiPickerOpen}
                  recording={testVoiceRecording}
                  voicePanel={testVoicePanelActive ? (
                    <PhoneChatPreviewVoiceComposer
                      recording={testVoiceRecording}
                      processing={testVoiceProcessing}
                      playing={testVoicePlaying}
                      durationMs={testVoiceDraft?.durationMs || testVoiceElapsedMs}
                      bars={testVoiceBars}
                      audioSrc={testVoiceDraft?.dataUrl}
                      audioRef={testVoiceAudioRef}
                      onCancel={handleCancelTestVoiceDraft}
                      onPrimary={handleTestVoicePrimary}
                      onSend={handleSendTestVoice}
                      onAudioEnded={() => setTestVoicePlaying(false)}
                      onAudioPause={() => setTestVoicePlaying(false)}
                      onAudioPlay={() => setTestVoicePlaying(true)}
                    />
                  ) : undefined}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      event.stopPropagation()
                      handleSendTestMessage()
                    }
                  }}
                />
              </>
            )}
          />
        </div>
      </aside>
    </div>
  )
}

interface ConversationalAgentSettingsProps {
  routeBase?: string
  generalConfigPath?: string
  className?: string
}

interface AgentActivationConflictModalState {
  message: string
  conflicts: ConversationalAgentEntryConflict[]
  pausedDraftInput?: ConversationalAgentDefInput
}

export const ConversationalAgentSettings: React.FC<ConversationalAgentSettingsProps> = ({
  routeBase = DEFAULT_CONVERSATIONAL_AGENT_ROUTE_BASE,
  className = ''
}) => {
  const navigate = useNavigate()
  const { agentId: routeAgentIdParam } = useParams<{ agentId?: string }>()
  const routeAgentId = routeAgentIdParam ? decodeURIComponent(routeAgentIdParam) : ''
  const { user } = useAuth()
  const { labels } = useLabels()
  const { showToast, showConfirm } = useNotification()
  const leadLowerLabel = formatCrmLabelLower(labels.lead, DEFAULT_CRM_LABELS.lead)
  const getDirectoryGoalExecutionInfo = useCallback((
    action: ConversationalSuccessAction,
    objective: ConversationalObjective,
    workflow?: AgentGoalWorkflowConfig
  ) => {
    const info = getSelectedGoalExecutionInfo(action, objective, workflow)
    return objective === 'filtrar'
      ? { ...info, label: `Que el equipo reciba al ${leadLowerLabel} filtrado` }
      : info
  }, [leadLowerLabel])
  const openAIAvailability = useAIAgentAvailability()
  const [config, setConfig] = useState<ConversationalAgentConfig | null>(null)
  const [agents, setAgents] = useState<ConversationalAgentDef[]>([])
  const [aiProviders, setAIProviders] = useState<ConversationalAIProviderStatus[]>([])
  const [metrics, setMetrics] = useState<ConversationalAgentMetrics | null>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [products, setProducts] = useState<ProductItem[]>([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [triggerLinks, setTriggerLinks] = useState<TriggerLink[]>([])
  const [triggerLinksLoading, setTriggerLinksLoading] = useState(false)
  const [filterOptions, setFilterOptions] = useState<AgentFilterOptions | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [scopePrompt, setScopePrompt] = useState(false)
  const [resettingAgentSkipsId, setResettingAgentSkipsId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => routeAgentId || null)
  const [providerModalId, setProviderModalId] = useState<ConversationalAIProviderId | null>(null)
  const [aiProvidersExpanded, setAIProvidersExpanded] = useState(false)
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerSaving, setProviderSaving] = useState(false)
  const [activationConflict, setActivationConflict] = useState<AgentActivationConflictModalState | null>(null)
  const saveTimersRef = useRef<Map<string, number>>(new Map())
  const agentsRef = useRef<ConversationalAgentDef[]>([])
  const businessProfileVersion = [
    openAIAvailability.businessProfile?.updatedAt || '',
    openAIAvailability.businessProfile?.extractionStatus || openAIAvailability.businessProfile?.status || '',
    openAIAvailability.businessProfile?.businessName || '',
    openAIAvailability.businessProfile?.industry || ''
  ].join('|')
  agentsRef.current = agents

  const refreshMetrics = useCallback(async () => {
    try {
      const nextMetrics = await conversationalAgentService.getMetrics()
      setMetrics(nextMetrics)
    } catch {
      // La configuración sigue funcionando; las métricas se reintentan al recargar.
    }
  }, [])

  const refreshAgentData = useCallback(async () => {
    const [nextConfig, nextAgents, nextProviders] = await Promise.all([
      conversationalAgentService.getConfig(),
      conversationalAgentService.listAgents(),
      conversationalAgentService.listAIProviders()
    ])
    setConfig(nextConfig)
    setAgents(nextAgents)
    setAIProviders(nextConfig.aiProviders || nextProviders)
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setProductsLoading(true)
      setTriggerLinksLoading(true)
      try {
        const [nextConfig, nextAgents, nextProviders, nextMetrics, calendarList, productsResponse, nextTriggerLinks, nextOptions] = await Promise.all([
          conversationalAgentService.getConfig(),
          conversationalAgentService.listAgents(),
          conversationalAgentService.listAIProviders(),
          conversationalAgentService.getMetrics().catch(() => null),
          calendarsService.getCalendars(),
          apiClient.get<{ products?: ProductItem[] }>('/products', {
            params: {
              limit: '100',
              includePrices: 'true'
            }
          }).catch(() => null),
          triggerLinksService.list().catch(() => []),
          conversationalAgentService.getFilterOptions().catch(() => undefined)
        ])
        if (cancelled) return
        setConfig(nextConfig)
        setAgents(nextAgents)
        setAIProviders(nextConfig.aiProviders || nextProviders)
        setMetrics(nextMetrics)
        setCalendars(calendarList.filter((cal) => cal.isActive !== false))
        setProducts(Array.isArray(productsResponse?.products)
          ? productsResponse.products.filter((product) => getProductId(product))
          : [])
        setTriggerLinks(nextTriggerLinks.filter((link) => link.active && !link.archived))
        setFilterOptions(nextOptions)
      } catch (error: any) {
        if (!cancelled) {
          showToast('error', 'Error', error?.message || 'No se pudo cargar Chatbot')
        }
      } finally {
        if (!cancelled) {
          setProductsLoading(false)
          setTriggerLinksLoading(false)
          setLoading(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [businessProfileVersion, showToast])

  useEffect(() => {
    const timers = saveTimersRef.current
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    if (loading) return

    if (!routeAgentId) {
      setSelectedAgentId(current => current ? null : current)
      return
    }

    if (agents.some((agent) => agent.id === routeAgentId)) {
      setSelectedAgentId(current => current === routeAgentId ? current : routeAgentId)
      return
    }

    setSelectedAgentId(null)
    navigate(buildConversationalAgentPath(null, routeBase), { replace: true })
  }, [agents, loading, navigate, routeAgentId, routeBase])

  const saveAgentNow = useCallback(async (
    agentId: string,
    options: { notify?: boolean } = {}
  ): Promise<ConversationalAgentDef | null> => {
    const timers = saveTimersRef.current
    const existing = timers.get(agentId)
    if (existing) {
      window.clearTimeout(existing)
      timers.delete(agentId)
    }

    const agent = agentsRef.current.find((item) => item.id === agentId)
    if (!agent) return null

    const validationError = getAgentValidationError(agent)
    if (validationError) {
      if (options.notify !== false) {
        showToast('warning', 'Revisa el agente', validationError)
      }
      throw new Error(validationError)
    }

    try {
      const next = await conversationalAgentService.updateAgent(agentId, agentToInput(agent))
      setAgents((current) => current.map((item) => (item.id === agentId ? next : item)))
      return next
    } catch (error: any) {
      if (isConversationalAgentEntryConflictError(error)) {
        setActivationConflict({
          message: error.message,
          conflicts: error.conflicts || []
        })
        await refreshAgentData().catch(() => undefined)
        throw error
      }
      // El servidor es la fuente de verdad. Si un autosave fue rechazado,
      // recuperamos la versión persistida para que la pantalla no siga
      // mostrando como aplicado algo que nunca se guardó.
      await refreshAgentData().catch(() => undefined)
      if (options.notify !== false) {
        showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración del agente')
      }
      throw error
    }
  }, [refreshAgentData, showToast])

  const scheduleAgentSave = useCallback((agentId: string) => {
    const timers = saveTimersRef.current
    const existing = timers.get(agentId)
    if (existing) window.clearTimeout(existing)
    timers.set(agentId, window.setTimeout(async () => {
      try {
        await saveAgentNow(agentId)
      } catch {
        // saveAgentNow ya notificó o abrió el modal de conflicto.
      }
    }, AUTOSAVE_DELAY_MS))
  }, [saveAgentNow])

  const businessPromptStatus = config?.businessPromptStatus || null
  const businessPromptReady = isBusinessPromptReady(businessPromptStatus)
  const promptBlockerText = getBusinessPromptBlockerText(businessPromptStatus)
  const conversationalAgentMaxAgents = normalizePositivePlanLimit(
    user?.licenseLimits?.conversational_agents?.max_agents ??
    user?.licenseLimits?.conversational_agents?.maxAgents
  )
  const conversationalAgentLimitReached = conversationalAgentMaxAgents !== null && agents.length >= conversationalAgentMaxAgents
  const conversationalAgentLimitText = conversationalAgentMaxAgents === null
    ? 'Agentes sin límite del plan'
    : `${formatMetricInteger(agents.length)}/${formatMetricInteger(conversationalAgentMaxAgents)} agentes del plan`
  const conversationalAgentLimitMessage = conversationalAgentMaxAgents === null
    ? ''
    : `Tu plan actual permite máximo ${conversationalAgentMaxAgents} chatbot${conversationalAgentMaxAgents === 1 ? '' : 's'}. Elimina uno existente o actualiza tu plan para crear otro.`

  const canStartAgentCreation = () => {
    if (conversationalAgentLimitReached) {
      showToast('warning', 'Límite del plan alcanzado', conversationalAgentLimitMessage)
      return false
    }
    return true
  }

  const handleAgentChange = (agentId: string, patch: ConversationalAgentDefInput) => {
    const currentAgent = agentsRef.current.find((agent) => agent.id === agentId)
    const effectiveRuntimeMode = patch.runtimeMode || currentAgent?.runtimeMode || 'legacy_v1'
    if (patch.enabled === true && effectiveRuntimeMode !== 'tool_calling_v2' && !businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }

    // Publicar, pausar o cambiar de motor nunca se refleja de forma optimista:
    // primero debe confirmarlo backend. Así el badge y el runtime no mienten si
    // falla una validación factual de calendario, producto, precio o enlace.
    if (currentAgent && (patch.enabled !== undefined || patch.runtimeMode !== undefined)) {
      const timers = saveTimersRef.current
      const existingTimer = timers.get(agentId)
      if (existingTimer) {
        window.clearTimeout(existingTimer)
        timers.delete(agentId)
      }
      const candidate = { ...currentAgent, ...patch } as ConversationalAgentDef
      const validationError = getAgentValidationError(candidate)
      if (validationError) {
        showToast('warning', 'Revisa el agente', validationError)
        return
      }

      void (async () => {
        try {
          const persisted = await conversationalAgentService.updateAgent(agentId, agentToInput(candidate))
          if (persisted.enabled && config && !config.enabled) {
            const runtimeEnabled = await handleRuntimeChange({ enabled: true }, {
              agentId,
              runtimeMode: persisted.runtimeMode
            })
            if (!runtimeEnabled) {
              await conversationalAgentService.updateAgent(agentId, agentToInput({ ...persisted, enabled: false }))
                .catch(() => undefined)
              await refreshAgentData().catch(() => undefined)
              return
            }
          }
          setAgents((current) => current.map((agent) => (agent.id === agentId ? persisted : agent)))
        } catch (error: any) {
          if (isConversationalAgentEntryConflictError(error)) {
            setActivationConflict({
              message: error.message,
              conflicts: error.conflicts || []
            })
          } else {
            showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración del agente')
          }
          await refreshAgentData().catch(() => undefined)
        }
      })()
      return
    }

    setAgents((current) => current.map((agent) => (agent.id === agentId ? { ...agent, ...patch } as ConversationalAgentDef : agent)))
    scheduleAgentSave(agentId)
  }

  const handleRuntimeChange = async (
    patch: { enabled?: boolean },
    publishingAgent?: { agentId: string; runtimeMode: ConversationalAgentDef['runtimeMode'] }
  ): Promise<boolean> => {
    const publishingV2 = publishingAgent?.runtimeMode === 'tool_calling_v2'
    if (patch.enabled === true && !publishingV2 && !businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return false
    }
    try {
      const runtimeRequest = publishingAgent
        ? { ...patch, agentId: publishingAgent.agentId }
        : patch
      const next = await conversationalAgentService.saveConfig(runtimeRequest)
      setConfig(next)
      return true
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración')
      return false
    }
  }

  const openProviderModal = (providerId: ConversationalAIProviderId) => {
    setProviderModalId(providerId)
    setProviderApiKey('')
  }

  const closeProviderModal = () => {
    if (providerSaving) return
    setProviderModalId(null)
    setProviderApiKey('')
  }

  const handleSaveProviderKey = async () => {
    if (!providerModalId) return
    const cleanKey = providerApiKey.trim()
    if (!cleanKey) {
      showToast('warning', 'Falta la API key', 'Pega la llave para conectar esta IA.')
      return
    }
    setProviderSaving(true)
    try {
      const providers = await conversationalAgentService.connectAIProvider(providerModalId, cleanKey)
      setAIProviders(providers)
      const provider = getConversationalAIProviderOption(providerModalId)
      if (providerModalId === 'openai') {
        const nextConfig = await conversationalAgentService.getConfig()
        setConfig(nextConfig)
        setAIProviders(nextConfig.aiProviders || providers)
        await refreshAgentData()
      }
      setProviderModalId(null)
      setProviderApiKey('')
      showToast(
        'success',
        `${provider.label} conectado`,
        providerModalId === 'openai'
          ? 'También quedó guardado en la configuración general de Ristak AI.'
          : 'Ya puedes elegirlo en tus chatbots.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo conectar', error?.message || 'Revisa la API key.')
    } finally {
      setProviderSaving(false)
    }
  }

  const handleDeleteProvider = (providerId: ConversationalAIProviderId) => {
    const provider = getConversationalAIProviderOption(providerId)
    showConfirm(
      `Eliminar ${provider.label}`,
      `Se borra la conexión con ${provider.label} y su API key. Los agentes que la usen volverán a OpenAI para no quedarse sin responder. Esta acción no se puede deshacer.`,
      async () => {
        try {
          const providers = await conversationalAgentService.deleteAIProvider(providerId)
          setAIProviders(providers)
          await refreshAgentData()
          void refreshMetrics()
          showToast('success', `${provider.label} eliminado`, 'La conexión quedó borrada.')
        } catch (error: any) {
          showToast('error', 'No se pudo eliminar', error?.message || 'Inténtalo otra vez.')
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  // Núcleo de creación reutilizable: lo usan el wizard guiado y el atajo "a mano".
  const runCreateAgent = async (overrides: ConversationalAgentDefInput = {}) => {
    if (conversationalAgentLimitReached) {
      showToast('warning', 'Límite del plan alcanzado', conversationalAgentLimitMessage)
      return null
    }
    setCreating(true)
    const defaultProvider = getKnownConversationalAIProvider(config?.aiProvider)
    const draftInput: ConversationalAgentDefInput = {
      name: `Agente ${agents.length + 1}`,
      aiProvider: defaultProvider,
      model: getKnownConversationalModel(defaultProvider, config?.model || getDefaultConversationalModel(defaultProvider)),
      ...overrides
    }
    try {
      const agent = await conversationalAgentService.createAgent(draftInput)
      if (config && !config.enabled && agent.enabled) {
        const runtimeEnableRequest = {
          enabled: true,
          agentId: agent.id
        }
        const nextConfig = await conversationalAgentService.saveConfig(runtimeEnableRequest)
        setConfig(nextConfig)
      }
      setAgents((current) => [...current, agent])
      setSelectedAgentId(agent.id)
      navigate(buildConversationalAgentPath(agent.id, routeBase))
      void refreshMetrics()
      return agent
    } catch (error: any) {
      if (isConversationalAgentEntryConflictError(error)) {
        setWizardOpen(false)
        setActivationConflict({
          message: error.message,
          conflicts: error.conflicts || [],
          pausedDraftInput: { ...draftInput, enabled: false }
        })
        return null
      }
      showToast('error', 'No se pudo crear', error?.message || 'Error al crear el agente')
      return null
    } finally {
      setCreating(false)
    }
  }

  const openCreateWizard = () => {
    if (!canStartAgentCreation()) return
    setWizardOpen(true)
  }

  // Atajo: crea un agente (casi en blanco) y salta directo al editor (sin wizard).
  const handleCreateAgent = async (overrides: ConversationalAgentDefInput = {}) => {
    if (!canStartAgentCreation()) return
    await runCreateAgent({ ...overrides, enabled: false })
  }

  // Modo avanzado: antes del formulario largo preguntamos SOLO el alcance de contactos.
  const confirmScopeAndCreate = (contactScope: ConversationalContactScope) => {
    setScopePrompt(false)
    void handleCreateAgent({ contactScope })
  }

  // El wizard ya arma el ConversationalAgentDefInput completo (incluye goalWorkflow,
  // anticipos/pagos y calendario). Aquí solo lo creamos.
  const handleWizardComplete = async (overrides: ConversationalAgentDefInput) => {
    const agent = await runCreateAgent(overrides)
    if (agent) setWizardOpen(false)
  }

  const handleCreatePausedConflictDraft = async () => {
    const draftInput = activationConflict?.pausedDraftInput
    if (!draftInput) return
    if (conversationalAgentLimitReached) {
      showToast('warning', 'Límite del plan alcanzado', conversationalAgentLimitMessage)
      return
    }
    setCreating(true)
    try {
      const agent = await conversationalAgentService.createAgent({ ...draftInput, enabled: false })
      setActivationConflict(null)
      setAgents((current) => [...current, agent])
      setSelectedAgentId(agent.id)
      navigate(buildConversationalAgentPath(agent.id, routeBase))
      void refreshMetrics()
      showToast('success', 'Agente creado en pausa', 'Configura sus condiciones de entrada antes de publicarlo.')
    } catch (error: any) {
      showToast('error', 'No se pudo crear', error?.message || 'Inténtalo otra vez.')
    } finally {
      setCreating(false)
    }
  }

  const handleDeleteAgent = (agent: ConversationalAgentDef) => {
    showConfirm(
      `Eliminar "${agent.name}"`,
      'Se borra este agente y su configuración. Las conversaciones que atendía quedarán libres para que otro agente (o un humano) las tome. Esta acción no se puede deshacer.',
      async () => {
        try {
          await conversationalAgentService.deleteAgent(agent.id)
          setAgents((current) => current.filter((item) => item.id !== agent.id))
          setSelectedAgentId((current) => (current === agent.id ? null : current))
          if (selectedAgentId === agent.id || routeAgentId === agent.id) {
            navigate(buildConversationalAgentPath(null, routeBase), { replace: true })
          }
          void refreshMetrics()
        } catch (error: any) {
          showToast('error', 'No se pudo eliminar', error?.message || 'Error al eliminar el agente')
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const handleResetAgentSkippedContacts = (agent: ConversationalAgentDef) => {
    const skippedCount = metrics?.byAgent.find((item) => item.agentId === agent.id)?.skippedConversations
    if (skippedCount === 0) {
      showToast('info', 'Sin omisiones', `${agent.name || 'Este agente'} no tiene contactos omitidos.`)
      return
    }

    const resetMessage = skippedCount === undefined
      ? 'Los contactos omitidos volverán a estar activos para que este agente pueda atenderlos otra vez.'
      : `${skippedCount === 1 ? 'El contacto omitido volverá' : `Los ${formatMetricInteger(skippedCount)} contactos omitidos volverán`} a estar activo${skippedCount === 1 ? '' : 's'} para que este agente pueda atenderlos otra vez.`

    showConfirm(
      `Reiniciar omisiones de "${agent.name || 'Agente sin nombre'}"`,
      resetMessage,
      async () => {
        setResettingAgentSkipsId(agent.id)
        try {
          const result = await conversationalAgentService.resetAgentSkippedContacts(agent.id)
          void refreshMetrics()
          showToast(
            result.resetCount > 0 ? 'success' : 'info',
            result.resetCount > 0 ? 'Omisiones reiniciadas' : 'Sin omisiones',
            result.resetCount === 1
              ? '1 contacto volvió a estar activo para este agente.'
              : `${formatMetricInteger(result.resetCount)} contactos volvieron a estar activos para este agente.`
          )
        } catch (error: any) {
          showToast('error', 'No se pudo reiniciar', error?.message || 'Inténtalo otra vez.')
        } finally {
          setResettingAgentSkipsId(null)
        }
      },
      'Reiniciar',
      'Cancelar'
    )
  }

  const selectedAgent = selectedAgentId ? agents.find((agent) => agent.id === selectedAgentId) || null : null
  const metricsByAgentId = new Map((metrics?.byAgent || []).map((item) => [item.agentId, item]))
  const dashboardMetrics = getConversationalDashboardMetrics(metrics, agents)
  const providerModalOption = providerModalId ? getConversationalAIProviderOption(providerModalId) : null
  const rootClassName = [styles.container, className].filter(Boolean).join(' ')
  const directoryClassName = [styles.container, styles.conversationalDirectoryPage, className].filter(Boolean).join(' ')
  const renderProviderModal = () => (
    <Modal
      isOpen={Boolean(providerModalOption)}
      onClose={closeProviderModal}
      title={providerModalOption ? `Conectar ${providerModalOption.label}` : 'Conectar IA'}
      size="md"
    >
      {providerModalOption && (
        <div className={styles.aiProviderModalBody}>
          <p className={styles.helper}>
            {providerModalOption.id === 'openai'
              ? 'Pega la API key de OpenAI. Se guarda cifrada en la configuración general de Ristak AI y queda disponible para Chatbot.'
              : `Pega la API key de ${providerModalOption.label}. Se guarda cifrada y sólo se usa para Chatbot.`}
          </p>
          <div className={styles.field}>
            <label className={styles.label}>API key</label>
            <input
              className={styles.input}
              type="password"
              value={providerApiKey}
              placeholder={`API key de ${providerModalOption.label}`}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setProviderApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void handleSaveProviderKey()
                }
              }}
              disabled={providerSaving}
            />
          </div>
          <div className={styles.aiProviderModalActions}>
            <Button variant="secondary" onClick={closeProviderModal} disabled={providerSaving}>
              Cancelar
            </Button>
            <Button onClick={handleSaveProviderKey} loading={providerSaving} disabled={providerSaving || !providerApiKey.trim()}>
              <KeyRound size={16} />
              Conectar
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )

  const renderActivationConflictModal = () => {
    const conflicts = activationConflict?.conflicts || []
    const canCreatePaused = Boolean(activationConflict?.pausedDraftInput)

    return (
      <Modal
        isOpen={Boolean(activationConflict)}
        onClose={() => setActivationConflict(null)}
        title="No se puede publicar este agente"
        size="md"
      >
        {activationConflict && (
          <div className={styles.agentConflictModalBody}>
            <div className={styles.agentConflictLead}>
              <span className={styles.agentConflictIcon}>
                <AlertTriangle size={18} />
              </span>
              <div>
                <Badge variant="warning">Conflicto de entrada</Badge>
                <p>{activationConflict.message}</p>
              </div>
            </div>

            {conflicts.length > 0 && (
              <div className={styles.agentConflictList}>
                {conflicts.map((conflict) => (
                  <div key={`${conflict.agentId}-${conflict.reason}`} className={styles.agentConflictItem}>
                    <strong>{conflict.agentName}</strong>
                    <span>{conflict.reason}</span>
                    <small>
                      Este agente: {conflict.candidateEntry}. Agente activo: {conflict.existingEntry}.
                    </small>
                  </div>
                ))}
              </div>
            )}

            <p className={styles.helper}>
              Usa una etiqueta, palabra clave, canal, número de entrada o una regla distinta para que sólo un agente pueda tomar ese chat.
            </p>

            <div className={styles.agentConflictActions}>
              <Button variant="secondary" onClick={() => setActivationConflict(null)}>
                Entendido
              </Button>
              {canCreatePaused && (
                <Button onClick={handleCreatePausedConflictDraft} loading={creating} disabled={creating}>
                  <PauseCircle size={16} />
                  Crear en pausa
                </Button>
              )}
            </div>
          </div>
        )}
      </Modal>
    )
  }

  if (selectedAgent) {
    return (
      <div className={rootClassName}>
        <AgentCard
          agent={selectedAgent}
          aiProviders={aiProviders}
          calendars={calendars}
          products={products}
          productsLoading={productsLoading}
          triggerLinks={triggerLinks}
          triggerLinksLoading={triggerLinksLoading}
          filterOptions={filterOptions}
          businessPromptStatus={businessPromptStatus}
          onConnectProvider={openProviderModal}
          onBack={() => {
            setSelectedAgentId(null)
            navigate(buildConversationalAgentPath(null, routeBase))
          }}
          onChange={(patch) => handleAgentChange(selectedAgent.id, patch)}
          onFlushSave={() => saveAgentNow(selectedAgent.id, { notify: false })}
          onDelete={() => handleDeleteAgent(selectedAgent)}
        />
        {renderProviderModal()}
        {renderActivationConflictModal()}
      </div>
    )
  }

  return (
    <div className={directoryClassName}>
      <PageHeader
        title="Chatbot"
        subtitle="Supervisa los chatbots que atienden conversaciones, cumplen metas y escalan chats cuando necesitan ayuda humana."
        actions={(
          <>
            <div className={styles.aiProviderDropdown}>
              <Button
                variant="secondary"
                size="sm"
                className={styles.aiProviderManagerToggle}
                onClick={() => setAIProvidersExpanded((current) => !current)}
                aria-expanded={aiProvidersExpanded}
                aria-controls="conversational-ai-provider-list"
                aria-label={aiProvidersExpanded ? 'Ocultar modelos de IA disponibles' : 'Mostrar modelos de IA disponibles'}
              >
                Modelos de IA disponibles
                <ChevronDown
                  size={15}
                  className={`${styles.aiProviderManagerToggleIcon} ${aiProvidersExpanded ? styles.aiProviderManagerToggleIconOpen : ''}`}
                />
              </Button>
              {aiProvidersExpanded && (
                <div id="conversational-ai-provider-list" className={`${styles.aiProviderManagerList} ${styles.aiProviderDropdownMenu}`}>
                  {conversationalAIProviderOptions.map((provider) => {
                    const status = getProviderStatus(aiProviders, provider.id)
                    const connected = Boolean(status?.connected)
                    const canDelete = Boolean(status?.canDelete && connected)
                    return (
                      <div key={provider.id} className={styles.aiProviderManagerRow}>
                        <div className={styles.aiProviderManagerCopy}>
                          <strong>{provider.label}</strong>
                          <span>{connected ? (status?.tokenPreview || 'Conectado') : provider.description}</span>
                        </div>
                        <Badge variant={connected ? 'success' : 'neutral'}>
                          {connected ? 'Conectado' : 'Toca para conectar'}
                        </Badge>
                        {canDelete ? (
                          <Button variant="ghost" onClick={() => handleDeleteProvider(provider.id)}>
                            <Trash2 size={15} />
                            Eliminar
                          </Button>
                        ) : (
                          <Button variant={connected ? 'secondary' : 'primary'} onClick={() => openProviderModal(provider.id)}>
                            <KeyRound size={15} />
                            {connected ? 'Administrar' : 'Conectar'}
                          </Button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            <Button
              onClick={openCreateWizard}
              loading={creating}
              disabled={loading || creating || conversationalAgentLimitReached}
              title={conversationalAgentLimitReached ? conversationalAgentLimitMessage : undefined}
            >
              <Plus size={16} />
              Nuevo agente
            </Button>
            <Badge variant={conversationalAgentLimitReached ? 'warning' : 'neutral'}>
              {conversationalAgentLimitText}
            </Badge>
          </>
        )}
      />

      <div data-conversational-agent-kpi-grid className="grid grid-cols-2 gap-[var(--app-grid-gap,1rem)] sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          title="Agentes publicados"
          value={`${formatMetricInteger(dashboardMetrics.activeAgents)}/${formatMetricInteger(dashboardMetrics.totalAgents)}`}
          loading={loading}
          icon={<Bot className="w-5 h-5" />}
        />
        <KpiCard
          title="Agentes asignados"
          value={formatMetricInteger(dashboardMetrics.agentsWithAssignedConversations)}
          loading={loading}
          icon={<UserCheck className="w-5 h-5" />}
        />
        <KpiCard
          title="Chats atendiendo"
          value={formatMetricInteger(dashboardMetrics.assignedConversations)}
          loading={loading}
          icon={<Users className="w-5 h-5" />}
        />
        <KpiCard
          title="Metas cumplidas"
          value={formatMetricInteger(dashboardMetrics.completedConversations)}
          loading={loading}
          icon={<CheckCircle2 className="w-5 h-5" />}
        />
        <KpiCard
          title="Tasa de éxito"
          value={formatMetricPercent(dashboardMetrics.successRate)}
          loading={loading}
          icon={<Target className="w-5 h-5" />}
        />
        <KpiCard
          title="Errores detectados"
          value={formatMetricInteger(dashboardMetrics.errorEvents)}
          loading={loading}
          icon={<AlertTriangle className="w-5 h-5" />}
        />
        <KpiCard
          title="Omitidos"
          value={formatMetricInteger(dashboardMetrics.skippedConversations)}
          loading={loading}
          icon={<CircleSlash className="w-5 h-5" />}
        />
        <KpiCard
          title="Pausados"
          value={formatMetricInteger(dashboardMetrics.pausedConversations)}
          loading={loading}
          icon={<PauseCircle className="w-5 h-5" />}
        />
      </div>

      {loading && (
        <Card>
          <p className={styles.helper} role="status" aria-live="polite" aria-label="Cargando agentes">
            <RotateCcw size={16} className="animate-spin" aria-hidden="true" />
          </p>
        </Card>
      )}

      {!loading && agents.length === 0 && (
        <Card padding="md" className={styles.emptyAgentDirectory}>
          <div className={styles.iconBox}>
            <Bot size={22} />
          </div>
          <h3>Aún no tienes agentes</h3>
          <p>Crea uno y configura qué chats debe tomar, cómo debe responder y cuándo debe pedir ayuda.</p>
          <Button
            onClick={openCreateWizard}
            loading={creating}
            disabled={creating || conversationalAgentLimitReached}
            title={conversationalAgentLimitReached ? conversationalAgentLimitMessage : undefined}
          >
            <Plus size={16} />
            Nuevo agente
          </Button>
        </Card>
      )}

      {!loading && agents.length > 0 && (
        <div className={styles.agentDirectoryGrid}>
          {agents.map((agent) => {
            const objectiveLabel = objectiveOptions.find((option) => option.value === agent.objective)?.label || 'Objetivo'
            const actionLabel = getDirectoryGoalExecutionInfo(agent.successAction, agent.objective, agent.goalWorkflow).label
            const provider = getConversationalAIProviderOption(agent.aiProvider)
            const modelLabel = getConversationalModelLabel(agent.aiProvider, agent.model)
            const entryRules = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
            const agentMetrics = metricsByAgentId.get(agent.id)
            const skippedCount = agentMetrics?.skippedConversations ?? 0
            const resettingSkips = resettingAgentSkipsId === agent.id
            const publishValidationError = getAgentValidationError({ ...agent, enabled: true })
            const legacyBusinessPromptBlocked = agent.runtimeMode !== 'tool_calling_v2' && !businessPromptReady
            const directoryPurpose = agent.runtimeMode === 'tool_calling_v2'
              ? `${(agent.capabilitiesConfig?.items || []).filter((item) => item.enabled).length} capacidades · flujo directo`
              : `${objectiveLabel} · ${actionLabel}`

            return (
              <div
                key={agent.id}
                className={`${styles.agentDirectoryCard} ${agent.enabled ? '' : styles.agentDirectoryCardMuted}`}
              >
                <button
                  type="button"
                  className={styles.agentDirectoryOpenButton}
                  onClick={() => {
                    setSelectedAgentId(agent.id)
                    navigate(buildConversationalAgentPath(agent.id, routeBase))
                  }}
                >
                  <div className={styles.agentDirectoryCardTop}>
                    <span className={`${styles.iconBox} ${agent.enabled ? '' : styles.iconBoxMuted}`}>
                      <Bot size={20} />
                    </span>
                    <Badge variant={agent.enabled ? 'success' : 'neutral'}>
                      {agent.enabled ? 'Publicado' : 'En pausa'}
                    </Badge>
                  </div>
                  <div className={styles.agentDirectoryCardCopy}>
                    <h3>{agent.name || 'Agente sin nombre'}</h3>
                    <p>{directoryPurpose}</p>
                  </div>
                  <div className={styles.agentDirectoryMeta}>
                    <span>{provider.label} · {modelLabel}</span>
                    <span>{entryRules > 0 ? `${entryRules} ${entryRules === 1 ? 'regla' : 'reglas'}` : 'Cualquier chat'}</span>
                    <span>{agentMetrics?.assignedConversations ?? 0} atendiendo</span>
                    <span>{agentMetrics?.completedConversations ?? 0} cumplidos</span>
                    {agent.hideAttendedNotifications && <span>Silencia hasta meta</span>}
                  </div>
                </button>
                <div className={styles.agentDirectoryActions}>
                  <Button
                    variant={agent.enabled ? 'secondary' : 'primary'}
                    onClick={() => handleAgentChange(agent.id, { enabled: !agent.enabled })}
                    disabled={!agent.enabled && (legacyBusinessPromptBlocked || Boolean(publishValidationError))}
                    title={!agent.enabled ? (publishValidationError || (legacyBusinessPromptBlocked ? promptBlockerText : undefined)) : undefined}
                  >
                    {agent.enabled ? <Pause size={15} /> : <Play size={15} />}
                    {agent.enabled ? 'Pausar' : 'Publicar'}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => handleResetAgentSkippedContacts(agent)}
                    loading={resettingSkips}
                    disabled={Boolean(agentMetrics && skippedCount === 0)}
                    title={agentMetrics && skippedCount === 0 ? 'Sin contactos omitidos' : 'Reiniciar omisiones de contactos'}
                  >
                    <RotateCcw size={15} />
                    Reiniciar omisiones
                  </Button>
                  <Button variant="ghost" onClick={() => handleDeleteAgent(agent)}>
                    <Trash2 size={15} />
                    Eliminar
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
      <AgentCreationWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={handleWizardComplete}
        onSkipToManual={() => { setWizardOpen(false); setScopePrompt(true) }}
        creating={creating}
        defaultName={`Agente ${agents.length + 1}`}
        aiProvider={getKnownConversationalAIProvider(config?.aiProvider)}
        model={getKnownConversationalModel(getKnownConversationalAIProvider(config?.aiProvider), config?.model || getDefaultConversationalModel(getKnownConversationalAIProvider(config?.aiProvider)))}
        aiProviders={aiProviders}
        onConnectProvider={openProviderModal}
      />
      {renderProviderModal()}
      {renderActivationConflictModal()}
      <Modal
        isOpen={scopePrompt}
        onClose={() => setScopePrompt(false)}
        type="custom"
        size="sm"
        title="Antes de armarlo a mano…"
      >
        <div className={styles.scopePromptModal}>
          <p className={styles.scopePromptText}>
            Una cosa rápida de seguridad: ¿a quién puede atender este asistente? Solo a los
            contactos <strong>nuevos</strong> desde ahora, a cualquier chat con <strong>mensajes
            nuevos</strong> (incluye tu base), o solo a los contactos que <strong>ya tienes</strong>.
          </p>
          <div className={styles.scopePromptActions}>
            <Button variant="secondary" onClick={() => confirmScopeAndCreate('new_only')} disabled={creating}>
              <ShieldCheck size={16} /> A todos los nuevos contactos desde ahora
            </Button>
            <Button variant="primary" onClick={() => confirmScopeAndCreate('all')} loading={creating} disabled={creating}>
              <Users size={16} /> A todos los nuevos mensajes desde ahora
            </Button>
            <Button variant="secondary" onClick={() => confirmScopeAndCreate('existing_only')} disabled={creating}>
              <UserCheck size={16} /> A todos los contactos existentes
            </Button>
          </div>
          <p className={styles.scopePromptHint}>Lo puedes cambiar después en la configuración del asistente.</p>
        </div>
      </Modal>
    </div>
  )
}
