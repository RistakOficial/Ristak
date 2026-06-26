import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Bot, CheckCircle2, ChevronDown, CircleSlash, FileText, Image as ImageIcon, KeyRound, Pause, PauseCircle, Play, Plus, RotateCcw, ShieldCheck, Target, Trash2, UserCheck, Users, Video, X } from 'lucide-react'
import { Badge, Button, Card, CustomSelect, KpiCard, Modal, NumberInput, PageHeader, TabList, TagPicker } from '@/components/common'
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
import { useNotification } from '@/contexts/NotificationContext'
import { useAIAgentAvailability, useAppConfig } from '@/hooks'
import {
  conversationalAgentService,
  isConversationalAgentEntryConflictError,
  type AgentFilterOptions,
  type AgentCompletionMode,
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
  type ClosingStrategyMode,
  type ConversationalAIProviderStatus,
  type ConversationalBusinessPromptStatus,
  type ConversationalAgentConfig,
  type ConversationalAgentDef,
  type ConversationalAgentDefInput,
  type ConversationalAgentEntryConflict,
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
import { formatCurrency } from '@/utils/format'
import { ConditionBuilder } from './ConditionBuilder'
import { AgentCreationWizard } from './AgentCreationWizard'
import styles from './AIAgentSettings.module.css'

const AUTOSAVE_DELAY_MS = 900
const DEFAULT_CONVERSATIONAL_AGENT_ROUTE_BASE = '/ai-agent/conversational'
const DEFAULT_AI_AGENT_GENERAL_PATH = '/ai-agent/general'

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

// Persuasión: qué tanto empuja el agente al cierre. Se monta sobre el guion de fábrica.
const persuasionLevelTabs: Array<{ value: ConversationalPersuasionLevel; label: string; description: string }> = [
  { value: 'low', label: 'Anfitrión', description: 'Atiende, resuelve y da precios claros. Cero presión: sólo agenda o cobra si la persona lo pide con todas sus letras.' },
  { value: 'medium', label: 'Estratega', description: 'Lee, descubre lo esencial y guía con tacto hacia el siguiente paso, sin presionar.' },
  { value: 'high', label: 'Cerrador', description: 'Tu guion de fábrica al 100: puro pull, estatus y cierre con criterio.' }
]
const persuasionLevelHelp: Record<ConversationalPersuasionLevel, string> = {
  low: 'Modo asesor práctico: informa increíble y deja respirar. Avanza sólo cuando la persona lo pide explícito.',
  medium: 'Punto medio: acompaña y guía con mano ligera, prioriza resolver antes que cerrar.',
  high: 'Máxima intensidad de cierre, tal cual el guion de fábrica que ya tienes configurado.'
}

// Lenguaje: el registro con el que habla. Fuerza la calibración del guion.
const languageLevelTabs: Array<{ value: ConversationalLanguageLevel; label: string; description: string }> = [
  { value: 'professional', label: 'Ejecutivo', description: 'Pulido, formal y cuidado, pero siempre humano. Para marcas premium y tratos serios.' },
  { value: 'intermediate', label: 'Cómplice', description: 'Natural y cercano, ni acartonado ni vulgar. El punto dulce (recomendado).' },
  { value: 'colloquial', label: 'Callejero', description: 'Suelto y bien regional, como mensaje entre cuates. Lo más libre.' }
]
const languageLevelHelp: Record<ConversationalLanguageLevel, string> = {
  professional: 'Sube la pulcritud: frases completas, sin abreviaciones ni modismos corrientes.',
  intermediate: 'Deja que el agente calibre el tono al interlocutor y al giro del negocio, como hoy.',
  colloquial: 'Baja el registro: recortes, modismos locales y ritmo informal de la región.'
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
  send_goal_url: { label: 'Mandar enlace confirmado', description: 'Manda un enlace y espera confirmación. Ejemplo: link de agenda o de compra.' },
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
    { value: 'ready_for_human', label: 'Pasar a humano', description: 'La IA detecta intención real, detiene el bot y avisa para que el equipo agende.' },
    { value: 'book_appointment', label: 'Que la IA agende', description: 'La IA confirma un horario real y agenda la cita en el calendario.' },
    { value: 'send_goal_url', label: 'Mandar enlace', description: 'La IA manda el enlace del calendario y la meta se completa cuando la cita queda confirmada.' }
  ],
  ventas: [
    { value: 'ready_for_human', label: 'Pasar a humano', description: 'La IA detecta intención de compra, detiene el bot y avisa para que el equipo cierre.' },
    { value: 'ready_to_buy', label: 'Que la IA cobre', description: 'La IA guía el pago y la venta se completa cuando el pago queda confirmado.' },
    { value: 'send_goal_url', label: 'Mandar enlace', description: 'La IA manda el enlace de compra y la meta se completa cuando el pago queda confirmado.' }
  ],
  datos: [
    { value: 'ready_for_human', label: 'Pasar a humano', description: 'La IA junta los datos y avisa para que el equipo continúe.' }
  ],
  filtrar: [
    { value: 'ready_for_human', label: 'Pasar a humano', description: 'La IA filtra la conversación y avisa cuando el prospecto ya vale atención.' }
  ],
  custom: [
    { value: 'ready_for_human', label: 'Pasar a humano', description: 'La IA detecta que el objetivo está listo y avisa al equipo.' },
    { value: 'send_trigger_link', label: 'Mandar enlace', description: 'La IA manda un enlace y detiene el bot cuando la persona lo abre.' }
  ]
}

const DEFAULT_GOAL_TRACKING_PARAM = 'ristak_goal_id'

const attendedChatActionOptions = [
  {
    value: 'mute_only',
    label: 'Silenciar hasta terminar',
    description: 'El contacto sigue en el chat de la IA, pero no manda avisos hasta que la meta termine.'
  },
  {
    value: 'keep_visible',
    label: 'Avisar aunque responda',
    description: 'El contacto sigue en el chat de la IA y manda avisos aunque el agente esté respondiendo.'
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
    currency: ''
  },
  completion: {
    mode: 'notify_only',
    userId: '',
    userName: ''
  }
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
        label: 'Que el equipo reciba al prospecto filtrado',
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
  if (objective === 'citas') return '¿Quién quieres que agende la cita?'
  if (objective === 'ventas') return '¿Quién quieres que cierre el pago?'
  if (objective === 'datos') return '¿Quién quieres que reciba los datos?'
  if (objective === 'filtrar') return '¿Quién quieres que atienda al prospecto filtrado?'
  return '¿Quién quieres que complete el objetivo?'
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
  const { id: _id, createdAt: _c, updatedAt: _u, systemClosingStrategy: _s, ...rest } = agent
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
      ...deposit
    },
    completion: {
      ...defaultGoalWorkflow.completion,
      ...((workflow.completion || {}) as Partial<AgentGoalWorkflowConfig['completion']>)
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

function getAgentValidationError(agent: ConversationalAgentDef) {
  return getAgentIdentityError(agent) ||
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
      ...((patch.deposit || {}) as Partial<AgentGoalWorkflowConfig['deposit']>)
    },
    completion: {
      ...base.completion,
      ...((patch.completion || {}) as Partial<AgentGoalWorkflowConfig['completion']>)
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

interface QuestionSelectRowProps<T extends string> {
  question: string
  helper?: string
  error?: string
  value: T
  options: Array<QuestionSelectOption<T>>
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
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
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
  systemStrategy: string
  businessPromptStatus?: ConversationalBusinessPromptStatus | null
  onConnectProvider: (providerId: ConversationalAIProviderId) => void
  onBack: () => void
  onChange: (patch: ConversationalAgentDefInput) => void
  onDelete: () => void
}

function getProviderStatus(aiProviders: ConversationalAIProviderStatus[], providerId: ConversationalAIProviderId) {
  return aiProviders.find((provider) => provider.id === providerId) || null
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, aiProviders, calendars, products, productsLoading, triggerLinks, triggerLinksLoading, filterOptions, systemStrategy, businessPromptStatus, onConnectProvider, onBack, onChange, onDelete }) => {
  const { showToast } = useNotification()
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
    handoffRules: false,
    extraInstructions: false
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
      handoffRules: false,
      extraInstructions: false
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
  const selectedProviderId = getKnownConversationalAIProvider(agent.aiProvider)
  const selectedProvider = getConversationalAIProviderOption(selectedProviderId)
  const selectedProviderStatus = getProviderStatus(aiProviders, selectedProviderId)
  const selectedProviderConnected = Boolean(selectedProviderStatus?.connected)
  const selectedAgentModelValue = getKnownConversationalModel(selectedProviderId, agent.model)
  const selectedAgentModel = selectedProvider.modelGroups
    .flatMap((group) => group.options)
    .find((option) => option.value === selectedAgentModelValue)
  const selectedAgentModelOptions = selectedProvider.modelGroups.flatMap((group) => (
    group.options.map((option) => ({
      value: option.value,
      label: `${group.label} · ${option.label}`
    }))
  ))
  const selectedAttendedChatActionValue = getAttendedChatActionValue(agent)
  const selectedAttendedChatAction = attendedChatActionOptions.find((option) => option.value === selectedAttendedChatActionValue) || attendedChatActionOptions[0]
  const strategyIsCustom = agent.closingStrategyMode === 'custom'
  const strategyText = strategyIsCustom ? agent.closingStrategyCustom : agent.systemClosingStrategy || systemStrategy
  const businessPromptReady = isBusinessPromptReady(businessPromptStatus)
  const promptStatusText = getBusinessPromptStatusText(businessPromptStatus)
  const promptBlockerText = getBusinessPromptBlockerText(businessPromptStatus)
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
  const extraInstructionsConfigOpen = guidanceOpen.extraInstructions || Boolean(String(agent.extraInstructions || '').trim())
  const goalWorkflow = getAgentGoalWorkflow(agent)
  const deposit = goalWorkflow.deposit
  const completion = goalWorkflow.completion
  const goalExecutionOptions = getGoalExecutionOptions(agent.objective)
  const selectedGoalExecutionInfo = getSelectedGoalExecutionInfo(agent.successAction, agent.objective, goalWorkflow)
  const selectedGoalExecutionAction = selectedGoalExecutionInfo.value
  const paymentRequirementConfigAvailable = objectiveCanConfigurePaymentRequirement(agent.objective)
  const showAiAppointmentSettings = agent.objective === 'citas' && selectedGoalExecutionAction === 'book_appointment'
  const showAiSalesSettings = agent.objective === 'ventas' && selectedGoalExecutionAction === 'ready_to_buy'
  const showPaymentRequirementSettings = paymentRequirementConfigAvailable && (showAiAppointmentSettings || showAiSalesSettings)
  const showGoalUrlSettings = selectedGoalExecutionAction === 'send_goal_url' && (agent.objective === 'citas' || agent.objective === 'ventas')
  const showTriggerLinkSettings = selectedGoalExecutionAction === 'send_trigger_link'
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
    const options = getGoalExecutionOptions(objective)
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
      const calendarId = owner === 'ai' || owner === 'url'
        ? goalWorkflow.appointments.calendarId || agent.defaultCalendarId || calendars[0]?.id || null
        : goalWorkflow.appointments.calendarId
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
      const result: ConversationalAgentTestResult = await conversationalAgentService.testAgent(
        nextMessages.map(toTestPayloadMessage),
        { config: agentToInput(agent) }
      )

      const responseDelayMs = normalizeTestResponseDelay(result.responseDelayMs)
      if (responseDelayMs > 0) {
        await waitForTestReplyDelay(responseDelayMs)
      }
      if (testPracticeExpiredRef.current) return

      for (const action of result.actions || []) {
        if (testPracticeExpiredRef.current) return
        setTestMessages((current) => [...current, { role: 'assistant', content: `⚙︎ Acción interna: ${action.type}`, internal: true }])
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

  const appointmentSchedulingSettings = showAiAppointmentSettings ? (
    <>
      <div className={styles.field}>
        <label className={styles.label}>Calendario</label>
        <CustomSelect
          value={agent.defaultCalendarId || ''}
          onChange={(event) => {
            const calendarId = event.target.value || null
            onChange({
              defaultCalendarId: calendarId,
              goalWorkflow: mergeGoalWorkflow(goalWorkflow, {
                appointments: { ...goalWorkflow.appointments, owner: 'ai', calendarId }
              })
            })
          }}
          portal
        >
          <option value="">Que elija entre calendarios activos</option>
          {calendars.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
          ))}
        </CustomSelect>
        <p className={styles.helper}>Sólo agenda con horarios reales.</p>
      </div>

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
        </>
      )}
    </div>
  ) : null

  const goalUrlSettings = showGoalUrlSettings ? (
    <>
      {agent.objective === 'citas' && (
        <div className={styles.field}>
          <label className={styles.label}>Calendario del enlace</label>
          <CustomSelect
            value={selectedGoalCalendarId}
            onChange={(event) => {
              const calendarId = event.target.value || null
              onChange({
                defaultCalendarId: calendarId,
                goalWorkflow: mergeGoalWorkflow(goalWorkflow, {
                  appointments: { ...goalWorkflow.appointments, owner: 'url', calendarId }
                })
              })
            }}
            portal
          >
            <option value="">Elegir calendario activo</option>
            {calendars.map((calendar) => (
              <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
            ))}
          </CustomSelect>
          <p className={styles.helper}>El enlace queda ligado a este calendario.</p>
        </div>
      )}

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
            ? 'Ejemplo: manda este link para que la persona compre el producto.'
            : 'Ejemplo: manda este link para que la persona elija día y hora.'}
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
          Ejemplo: ayuda a saber quién tocó el link.
        </p>
      </div>

      <div className={styles.fieldWide}>
        <label className={styles.label}>Cómo sabe que ya pasó</label>
        <p className={styles.helper}>
          {agent.objective === 'ventas'
            ? 'Ejemplo: marca la meta como lista cuando se confirma la compra.'
            : 'Ejemplo: marca la meta como lista cuando se confirma la cita.'}
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
              disabled={!agent.enabled && !businessPromptReady}
              title={!agent.enabled && !businessPromptReady ? promptBlockerText : undefined}
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
            {selectedObjective.label} · {selectedGoalExecutionInfo.label}
            {entryCount > 0
              ? ` · entra con ${entryCount} ${entryCount === 1 ? 'regla' : 'reglas'}`
              : ' · entra con cualquier chat'}
            {exitCount > 0 ? ` · se suelta con ${exitCount}` : ''}
            {responseDelaySummary ? ` · espera ${responseDelaySummary}` : ''}
            {replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split' ? ' · responde en partes' : ''}
            {followUpSummary ? ` · ${followUpSummary}` : ''}
          </p>
          {!businessPromptReady && (
            <div className={styles.promptReadinessNotice}>
              <strong>{promptStatusText}</strong>
              <span>{promptBlockerText}</span>
            </div>
          )}

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>1. Cómo va a contestar</h3>
            <p className={styles.agentSectionHint}>
              Elige quién escribe, cuándo contesta y si los mensajes se ven como chat real. Ejemplo: rápido, pausado o en globitos.
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
                question={`¿Qué versión de ${selectedProvider.label} va a usar?`}
                helper={`Es la versión que va a escribir. Ejemplo: ${selectedAgentModel?.label || selectedAgentModelValue} se usa sólo en este agente.`}
                value={selectedAgentModelValue}
                options={selectedAgentModelOptions}
                selectLabel={`Modelo de ${selectedProvider.label}`}
                onChange={(model) => onChange({ model })}
              />

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

            </div>
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>Chat mientras la IA habla</h3>
            <p className={styles.agentSectionHint}>
              Decide si el equipo recibe avisos mientras este agente atiende. El contacto siempre se queda en la vista del agente.
            </p>
            <div className={styles.configQuestionList}>
              <QuestionSelectRow
                question="¿Qué pasa con el chat mientras la IA habla?"
                helper={selectedAttendedChatAction.description}
                value={selectedAttendedChatActionValue}
                options={attendedChatActionOptions.map((option) => ({ value: option.value, label: option.label }))}
                selectLabel="Qué hace el chat con conversaciones atendidas"
                onChange={(value) => onChange(getAttendedChatActionPatch(value as AttendedChatActionValue))}
              />
            </div>
          </div>

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>2. Qué debe lograr</h3>
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
                question={getGoalExecutionQuestion(agent.objective)}
                helper={selectedGoalExecutionInfo.description}
                value={selectedGoalExecutionInfo.value}
                options={goalExecutionOptions.map((option) => ({ value: option.value, label: option.label }))}
                selectLabel="Quién cumple la meta"
                onChange={(action) => handleGoalExecutionChange(action as ConversationalSuccessAction)}
              >
                {goalExecutionSettings}
                {paymentRequirementSettings}
              </QuestionSelectRow>

              <QuestionSelectRow
                question="Al momento de cumplir el objetivo, ¿qué quieres que suceda?"
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

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>3. Si la persona no contesta</h3>
            <p className={styles.agentSectionHint}>
              Manda un mensaje después si la persona se queda callada. Ejemplo: "oye, te quedó alguna duda?"
            </p>
            <div className={styles.configQuestionList}>
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

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>4. Cuándo empieza y cuándo se detiene</h3>
            <p className={styles.agentSectionHint}>
              Elige en qué chats puede entrar. Ejemplo: sólo cuando venga de una página, una etiqueta o cualquier chat nuevo.
            </p>
            <div className={styles.field}>
              <label className={styles.label}>¿A quién puede atender?</label>
              <CustomSelect
                value={agent.contactScope}
                onChange={(event) => onChange({ contactScope: (event.target.value || 'all') as ConversationalContactScope })}
                portal
              >
                <option value="all">Cualquier chat (incluye contactos que ya tenías)</option>
                <option value="new_only">Solo contactos nuevos desde ahora</option>
              </CustomSelect>
              <p className={styles.helper}>
                {agent.contactScope === 'new_only'
                  ? 'Medida de seguridad: ignora a tus contactos de antes; solo atiende a quien llegue desde ahora.'
                  : 'Puede tomar tanto a tus contactos actuales como a los nuevos.'}
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

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>5. Cosas que debe cuidar</h3>
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

              <QuestionSelectRow
                question="¿Quieres darle algún tip extra?"
                helper="Aquí pones cosas que debe recordar. Ejemplo: mencionar una promo sólo si preguntan precio."
                value={extraInstructionsConfigOpen ? 'yes' : 'no'}
                options={binaryChoiceOptions}
                selectLabel="Tips del negocio"
                onChange={(value) => {
                  const enabled = value === 'yes'
                  setGuidanceOpen((current) => ({ ...current, extraInstructions: enabled }))
                  if (!enabled) onChange({ extraInstructions: '' })
                }}
              >
                {extraInstructionsConfigOpen && (
                  <textarea
                    className={styles.textarea}
                    value={agent.extraInstructions}
                    placeholder="Ejemplo: menciona la promo de junio sólo si preguntan por precio."
                    onChange={(event) => onChange({ extraInstructions: event.target.value })}
                    rows={3}
                  />
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
            </div>
          </div>

          <details className={styles.advancedDetails} open={strategyIsCustom || undefined}>
            <summary>
              <span>Instrucciones avanzadas</span>
              <small>{strategyIsCustom ? 'Editada a mano' : promptStatusText}</small>
            </summary>
            <div className={styles.advancedContent}>
              <div className={styles.strategyHeaderRow}>
                <label className={styles.label}>Cómo debe vender o cerrar</label>
                <span className={`${styles.strategyBadge} ${strategyIsCustom ? styles.strategyBadgeCustom : businessPromptReady ? styles.strategyBadgeReady : styles.strategyBadgeLocked}`}>
                  {strategyIsCustom ? 'Editada' : businessPromptReady ? 'Adaptada' : 'Pendiente'}
                </span>
                {strategyIsCustom && (
                  <button
                    type="button"
                    className={styles.resetStrategyButton}
                    onClick={() => onChange({ closingStrategyMode: 'system', closingStrategyCustom: '' })}
                  >
                    <RotateCcw size={13} />
                    Usar la normal
                  </button>
                )}
              </div>
              {!strategyIsCustom && (
                <div className={`${styles.strategyPromptState} ${businessPromptReady ? styles.strategyPromptStateReady : styles.strategyPromptStateLocked}`}>
                  <strong>{promptStatusText}</strong>
                  <span>
                    {businessPromptReady
                      ? 'Ya usa los datos actuales de tu negocio.'
                      : promptBlockerText}
                  </span>
                </div>
              )}
              <textarea
                className={`${styles.textarea} ${styles.actionTextarea}`}
                value={strategyText}
                onChange={(event) => onChange({ closingStrategyMode: 'custom' as ClosingStrategyMode, closingStrategyCustom: event.target.value })}
                rows={7}
              />
              <p className={styles.helper}>
                {strategyIsCustom
                  ? 'Este agente usa tu texto editado.'
                  : businessPromptReady
                    ? 'Ya usa los datos de tu negocio. Ejemplo: habla según lo que vendes y a quién atiendes.'
                    : 'Primero describe tu negocio para preparar estas instrucciones.'}
              </p>
            </div>
          </details>

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
            emptyText={testPracticeExpired ? TEST_MEDIA_EXPIRED_NOTICE : 'Escribe como prospecto y revisa si contesta como debe.'}
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
  generalConfigPath = DEFAULT_AI_AGENT_GENERAL_PATH,
  className = ''
}) => {
  const navigate = useNavigate()
  const { agentId: routeAgentIdParam } = useParams<{ agentId?: string }>()
  const routeAgentId = routeAgentIdParam ? decodeURIComponent(routeAgentIdParam) : ''
  const { showToast, showConfirm } = useNotification()
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
      if (openAIAvailability.loading) return
      if (!openAIAvailability.configured) {
        setConfig(null)
        setAgents([])
        setAIProviders([])
        setMetrics(null)
        setCalendars([])
        setProducts([])
        setProductsLoading(false)
        setTriggerLinks([])
        setTriggerLinksLoading(false)
        setFilterOptions(undefined)
        setSelectedAgentId(null)
        setLoading(false)
        return
      }

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
          showToast('error', 'Error', error?.message || 'No se pudo cargar el agente conversacional')
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
  }, [businessProfileVersion, openAIAvailability.configured, openAIAvailability.loading, showToast])

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

  const scheduleAgentSave = useCallback((agentId: string) => {
    const timers = saveTimersRef.current
    const existing = timers.get(agentId)
    if (existing) window.clearTimeout(existing)
    timers.set(agentId, window.setTimeout(async () => {
      timers.delete(agentId)
      const agent = agentsRef.current.find((item) => item.id === agentId)
      if (!agent) return
      const validationError = getAgentValidationError(agent)
      if (validationError) {
        showToast('warning', 'Revisa el agente', validationError)
        return
      }
      try {
        await conversationalAgentService.updateAgent(agentId, agentToInput(agent))
      } catch (error: any) {
        if (isConversationalAgentEntryConflictError(error)) {
          setActivationConflict({
            message: error.message,
            conflicts: error.conflicts || []
          })
          await refreshAgentData().catch(() => undefined)
          return
        }
        showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración del agente')
      }
    }, AUTOSAVE_DELAY_MS))
  }, [refreshAgentData, showToast])

  const businessPromptStatus = config?.businessPromptStatus || null
  const businessPromptReady = isBusinessPromptReady(businessPromptStatus)
  const promptBlockerText = getBusinessPromptBlockerText(businessPromptStatus)

  const handleAgentChange = (agentId: string, patch: ConversationalAgentDefInput) => {
    if (patch.enabled === true && !businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    setAgents((current) => current.map((agent) => (agent.id === agentId ? { ...agent, ...patch } as ConversationalAgentDef : agent)))
    scheduleAgentSave(agentId)
    if (patch.enabled === true && config && !config.enabled) {
      void handleGlobalChange({ enabled: true })
    }
  }

  const handleGlobalChange = async (patch: { enabled?: boolean }) => {
    if (patch.enabled === true && !businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    try {
      const next = await conversationalAgentService.saveConfig(patch)
      setConfig(next)
    } catch (error: any) {
      showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración')
    }
  }

  const openProviderModal = (providerId: ConversationalAIProviderId) => {
    if (providerId === 'openai') {
      navigate(generalConfigPath)
      return
    }
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
      setProviderModalId(null)
      setProviderApiKey('')
      showToast('success', `${provider.label} conectado`, 'Ya puedes elegirlo en tus agentes conversacionales.')
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
      if (config && !config.enabled) {
        const nextConfig = await conversationalAgentService.saveConfig({ enabled: true })
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
    if (!businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    setWizardOpen(true)
  }

  // Atajo: crea un agente (casi en blanco) y salta directo al editor (sin wizard).
  const handleCreateAgent = async (overrides: ConversationalAgentDefInput = {}) => {
    if (!businessPromptReady) {
      showToast('warning', 'Prompt interno pendiente', promptBlockerText)
      return
    }
    await runCreateAgent(overrides)
  }

  // Modo avanzado: antes del formulario largo preguntamos SOLO el alcance de contactos.
  const confirmScopeAndCreate = (contactScope: 'all' | 'new_only') => {
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

  const systemStrategy = config?.systemClosingStrategy || ''
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
            Pega la API key de {providerModalOption.label}. Se guarda cifrada y sólo se usa para el agente conversacional.
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

  if (openAIAvailability.loading) {
    return (
      <div className={rootClassName}>
        <Card>
          <p className={styles.helper}>Revisando OpenAI...</p>
        </Card>
      </div>
    )
  }

  if (!openAIAvailability.configured) {
    return (
      <div className={rootClassName}>
        <Card padding="md" className={styles.conversationSettingsCard}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <div className={styles.iconBox}>
                <KeyRound size={22} />
              </div>
              <div>
                <h2 className={styles.title}>Conecta OpenAI primero</h2>
                <p className={styles.description}>
                  El agente conversacional, sus pruebas y sus respuestas quedan bloqueados hasta que guardes un token válido.
                </p>
              </div>
            </div>
            <div className={styles.headerActions}>
              <Button onClick={() => navigate(generalConfigPath)}>
                <KeyRound size={16} />
                Configurar token
              </Button>
            </div>
          </div>
        </Card>
      </div>
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
          systemStrategy={systemStrategy}
          businessPromptStatus={businessPromptStatus}
          onConnectProvider={openProviderModal}
          onBack={() => {
            setSelectedAgentId(null)
            navigate(buildConversationalAgentPath(null, routeBase))
          }}
          onChange={(patch) => handleAgentChange(selectedAgent.id, patch)}
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
        title="Agente conversacional"
        subtitle="Supervisa los agentes que atienden conversaciones, cumplen metas y escalan chats cuando necesitan ayuda humana."
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
              disabled={loading || creating || !businessPromptReady}
              title={!businessPromptReady ? promptBlockerText : undefined}
            >
              <Plus size={16} />
              Nuevo agente
            </Button>
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
          <Button onClick={openCreateWizard} loading={creating} disabled={creating}>
            <Plus size={16} />
            Nuevo agente
          </Button>
        </Card>
      )}

      {!loading && agents.length > 0 && (
        <div className={styles.agentDirectoryGrid}>
          {agents.map((agent) => {
            const objectiveLabel = objectiveOptions.find((option) => option.value === agent.objective)?.label || 'Objetivo'
            const actionLabel = getSelectedGoalExecutionInfo(agent.successAction, agent.objective, agent.goalWorkflow).label
            const provider = getConversationalAIProviderOption(agent.aiProvider)
            const modelLabel = getConversationalModelLabel(agent.aiProvider, agent.model)
            const entryRules = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
            const agentMetrics = metricsByAgentId.get(agent.id)
            const skippedCount = agentMetrics?.skippedConversations ?? 0
            const resettingSkips = resettingAgentSkipsId === agent.id

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
                    <p>{objectiveLabel} · {actionLabel}</p>
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
                    disabled={!agent.enabled && !businessPromptReady}
                    title={!agent.enabled && !businessPromptReady ? promptBlockerText : undefined}
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
      {renderProviderModal()}
      {renderActivationConflictModal()}
      <AgentCreationWizard
        isOpen={wizardOpen}
        onClose={() => setWizardOpen(false)}
        onComplete={handleWizardComplete}
        onSkipToManual={() => { setWizardOpen(false); setScopePrompt(true) }}
        creating={creating}
        defaultName={`Agente ${agents.length + 1}`}
        aiProvider={getKnownConversationalAIProvider(config?.aiProvider)}
        model={getKnownConversationalModel(getKnownConversationalAIProvider(config?.aiProvider), config?.model || getDefaultConversationalModel(getKnownConversationalAIProvider(config?.aiProvider)))}
      />
      <Modal
        isOpen={scopePrompt}
        onClose={() => setScopePrompt(false)}
        type="custom"
        size="sm"
        title="Antes de armarlo a mano…"
      >
        <div className={styles.scopePromptModal}>
          <p className={styles.scopePromptText}>
            Una cosa rápida de seguridad: ¿este asistente también puede escribirles a los
            contactos que <strong>ya tienes</strong>, o solo a los nuevos de ahora en adelante?
          </p>
          <div className={styles.scopePromptActions}>
            <Button variant="secondary" onClick={() => confirmScopeAndCreate('new_only')} disabled={creating}>
              <ShieldCheck size={16} /> Solo los nuevos
            </Button>
            <Button variant="primary" onClick={() => confirmScopeAndCreate('all')} loading={creating} disabled={creating}>
              <Users size={16} /> Todos, incluidos los de antes
            </Button>
          </div>
          <p className={styles.scopePromptHint}>Lo puedes cambiar después en la configuración del asistente.</p>
        </div>
      </Modal>
    </div>
  )
}
