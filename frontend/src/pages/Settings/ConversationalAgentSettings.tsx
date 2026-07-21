import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Bot, CalendarCheck, CheckCircle2, ChevronDown, CircleSlash, CreditCard, FileText, Image as ImageIcon, KeyRound, Link2, Pause, PauseCircle, Play, Plus, RotateCcw, ShieldAlert, Target, Trash2, UserCheck, Users, Video, Wand2 } from 'lucide-react'
import { Badge, Button, Card, CheckboxMultiSelect, ContactSearchInput, CustomSelect, ExpandableTextareaField, Modal, NumberInput, PageHeader, Switch } from '@/components/common'
import { KpiCard } from '@/components/common/KpiCard/KpiCard'
import type { ContactSearchInputContact } from '@/components/common/ContactSearchInput/ContactSearchInput'
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
import { hasPaymentLinksAccess } from '@/utils/accessControl'
import {
  conversationalAgentService,
  buildConversationalLegacyEditableText,
  isConversationalAgentEntryConflictError,
  DEFAULT_AGENT_DEPOSIT_METHODS,
  DEFAULT_CONVERSATIONAL_CAPABILITIES_CONFIG,
  DEFAULT_CONVERSATIONAL_CONTACT_SCOPE,
  DEFAULT_CONVERSATIONAL_PROMPT_CONFIG,
  type AgentFilterOptions,
  type AgentFollowUpConfig,
  type AgentFollowUpStepConfig,
  type AgentFollowUpUnit,
  type AgentReplyDeliveryConfig,
  type AgentReplyDeliveryMode,
  type AgentResponseDelayConfig,
  type AgentResponseDelayMode,
  type AgentResponseDelayUnit,
  type ConversationalAIProviderStatus,
  type ConversationalAgentConfig,
  type ConversationalAgentDef,
  type ConversationalAgentDefInput,
  type ConversationalAgentEntryConflict,
  type ConversationalCapabilitiesConfig,
  type ConversationalCapabilityId,
  type ConversationalCapabilityItem,
  type ConversationalCapabilityManifestItem,
  type ConversationalRequiredDataConditionFact,
  type ConversationalRequiredDataField,
  type ConversationalRequiredDataItem,
  type ConversationalAgentMetrics,
  type ConversationalContactScope,
  type ConversationalAgentTestAttachment,
  type ConversationalAgentTestEffectResult,
  type ConversationalAgentTestEffects,
  type ConversationalAgentTestMessage,
  type ConversationalAgentTestResult,
  type ConversationalAgentTestRunHistory,
} from '@/services/conversationalAgentService'
import { ACCOUNT_CURRENCY_CONFIG_KEY, getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import { userAccessService, type TeamUser } from '@/services/userAccessService'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import apiClient from '@/services/apiClient'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower, formatCrmLabelSentence } from '@/utils/crmLabels'
import { formatCurrency } from '@/utils/format'
import { ConditionBuilder } from './ConditionBuilder'
import styles from './AIAgentSettings.module.css'
import { describeConversationalPreviewAction } from './conversationalPreviewAction'
import { MSI_INSTALLMENT_CHOICES, msiEligibility } from '../../../../shared/sites/paymentGateContract.js'

const AUTOSAVE_DELAY_MS = 900
const DEFAULT_CONVERSATIONAL_AGENT_ROUTE_BASE = '/ai-agent/conversational'

const buildConversationalAgentPath = (agentId?: string | null, routeBase = DEFAULT_CONVERSATIONAL_AGENT_ROUTE_BASE) => (
  agentId ? `${routeBase}/${encodeURIComponent(agentId)}` : routeBase
)

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

const defaultNativeDeposit = {
  enabled: false,
  mode: 'fixed' as const,
  amount: null,
  minAmount: null,
  maxAmount: null,
  currency: '',
  methods: { ...DEFAULT_AGENT_DEPOSIT_METHODS },
  bankTransferDetails: ''
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

function getPriceAmount(price?: ProductPrice | null) {
  return Number(price?.amount ?? price?.price ?? 0) || 0
}

function normalizeCurrencyCode(value?: string | null) {
  return String(value || '').trim().toUpperCase().slice(0, 12)
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

function createTestTrackingId(prefix: 'session' | 'message' | 'transcript') {
  const randomPart = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `agent-test-${prefix}-${randomPart}`
}

const RETRYABLE_TEST_RUN_CODES = new Set([
  'test_run_closed',
  'test_run_expired',
  'test_run_not_found'
])
const RETRY_SAME_TEST_TURN_CODES = new Set([
  'test_turn_processing',
  'test_turn_effect_processing',
  'test_turn_claim_lost',
  'test_turn_heartbeat_failed'
])

export function shouldRotateClosedTestRun(error: unknown) {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '').trim()
    : ''
  return RETRYABLE_TEST_RUN_CODES.has(code)
}

export function shouldRetrySameTestTurn(error: unknown) {
  if (error instanceof TypeError) return true
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; statusCode?: unknown }
    : null
  const code = String(candidate?.code || '').trim()
  const statusCode = Number(candidate?.statusCode)
  return RETRY_SAME_TEST_TURN_CODES.has(code) ||
    statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500
}

function describeTestEffectResult(effect: ConversationalAgentTestEffectResult) {
  const explicitSummary = String(effect.summary || effect.message || '').trim()
  const notificationWarning = effect.notificationStatus === 'pending' && effect.notificationError
    ? ' La acción quedó registrada, pero la notificación sigue pendiente; el sistema la reintentará.'
    : ''
  if (explicitSummary) return `${explicitSummary}${notificationWarning}`
  const status = String(effect.status || '').trim().toLowerCase()
  const effectLabels: Record<string, string> = {
    schedule_appointment: 'cita de prueba',
    scheduleAppointment: 'cita de prueba',
    appointment: 'cita de prueba',
    collect_payment: 'cobro de prueba',
    collectPayment: 'cobro de prueba',
    payment: 'cobro de prueba',
    assignment: 'asignación de prueba',
    assign_user: 'asignación de prueba',
    assignUser: 'asignación de prueba',
    notify_owner: 'notificación de prueba',
    notifyOwner: 'notificación de prueba'
  }
  const label = effectLabels[String(effect.type || '').trim()] || 'acción de prueba'
  if (status === 'executed' || status === 'recorded' || status === 'prepared') return `Se registró: ${label}.`
  if (status === 'failed') return `No se pudo registrar: ${label}.`
  if (status === 'skipped') return `No se ejecutó: ${label}.`
  return `Prueba: ${label}.`
}

function getTestEffectHistoryState(effect: ConversationalAgentTestEffectResult) {
  const status = String(effect.status || '').trim().toLowerCase()
  const cleanupStatus = String(effect.cleanupStatus || '').trim().toLowerCase()
  const notificationStatus = String(effect.notificationStatus || '').trim().toLowerCase()
  if (status === 'failed' || status === 'skipped' || cleanupStatus === 'failed') {
    return { label: 'Fallido', variant: 'error' as const }
  }
  if (status === 'processing' || status === 'pending' || notificationStatus === 'pending') {
    return { label: 'Pendiente', variant: 'warning' as const }
  }
  return { label: 'Exitoso', variant: 'success' as const }
}

type TestAttachment = ConversationalAgentTestAttachment & PhoneChatPreviewAttachment & {
  id: string
  cacheKey?: string
  uploadedAt?: number
  expiresAt?: number
}
type TestMessage = {
  id?: string
  role: 'user' | 'assistant'
  content: string
  attachments?: TestAttachment[]
  internal?: boolean
  deliveryKey?: string
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
    ...(message.id ? { id: message.id } : {}),
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
  return {
    name: agent.name,
    enabled: agent.enabled,
    aiProvider: agent.aiProvider,
    model: agent.model,
    position: agent.position,
    promptConfig: agent.promptConfig,
    capabilitiesConfig: agent.capabilitiesConfig,
    hideAttended: agent.hideAttended,
    hideAttendedNotifications: agent.hideAttendedNotifications,
    contactScope: agent.contactScope,
    responseDelay: agent.responseDelay,
    replyDelivery: agent.replyDelivery,
    followUp: agent.followUp,
    filters: agent.filters
  }
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
    if (secondDelay > MAX_FOLLOW_UP_MINUTES) return 'Revisa el tiempo del segundo seguimiento.'
    if (firstDelay + secondDelay > MAX_FOLLOW_UP_MINUTES) return 'Los dos seguimientos juntos no pueden pasar de 23 horas.'
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

function isSafeConversationalUrl(value: string) {
  try {
    const parsed = new URL(String(value || '').trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function getCurrencyInputSymbol(currency: string) {
  const normalized = normalizeCurrencyCode(currency)
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: normalized,
      currencyDisplay: 'narrowSymbol'
    }).formatToParts(0).find((part) => part.type === 'currency')?.value || normalized
  } catch {
    return normalized
  }
}

function getCurrencyFractionDigits(currency: string) {
  try {
    const digits = new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: normalizeCurrencyCode(currency)
    }).resolvedOptions().maximumFractionDigits
    return typeof digits === 'number' && Number.isInteger(digits) && digits >= 0 && digits <= 6 ? digits : 2
  } catch {
    return 2
  }
}

function getCurrencyInputStep(currency: string) {
  return 10 ** -getCurrencyFractionDigits(currency)
}

function getConversationalPaymentMsiMonths(
  item: Extract<ConversationalCapabilityItem, { id: 'collect_payment' }>,
  accountCurrency = ''
) {
  const isDeposit = item.chargeType === 'deposit' || item.paymentMode === 'deposit' || item.deposit?.enabled
  if (item.collectionMethod !== 'payment_link' || isDeposit || !item.gateway || item.gateway === 'highlevel') return []
  const amount = item.chargeType === 'direct'
    ? Number(item.direct?.amount) || 0
    : Number(item.amount) || 0
  const currency = normalizeCurrencyCode(
    item.chargeType === 'direct' ? item.direct?.currency : (item.currency || accountCurrency)
  )
  const eligibility = msiEligibility({
    gateway: item.gateway,
    currency,
    amount,
    msi: { enabled: true, maxInstallments: 24 }
  })
  if (eligibility.standaloneMonths?.length) return eligibility.standaloneMonths
  return eligibility.insideElement || eligibility.insideBrick || eligibility.hostedRedirect
    ? [...MSI_INSTALLMENT_CHOICES]
    : []
}

function getNativeCapabilityItemError(
  item: ConversationalCapabilityItem,
  allItems: ConversationalCapabilityItem[],
  accountCurrency = ''
) {
  if (!item.enabled) return ''
  if (item.id === 'schedule_appointment' && !item.calendarId) return 'Selecciona el calendario de la capacidad para agendar.'
  if (item.id === 'collect_payment') {
    const isBankTransfer = item.collectionMethod === 'bank_transfer'
    if (!isBankTransfer && !item.gateway) return 'Selecciona la pasarela que generará el enlace.'
    if (isBankTransfer && !String(item.bankTransfer?.details || item.deposit?.bankTransferDetails || '').trim()) {
      return 'Escribe los datos para recibir la transferencia o depósito.'
    }
    const isDeposit = item.chargeType === 'deposit' || item.paymentMode === 'deposit' || item.deposit?.enabled
    if (isDeposit) {
      const deposit = item.deposit || defaultNativeDeposit
      const validFixed = deposit.mode !== 'range' && Number(deposit.amount) > 0
      const validRange = deposit.mode === 'range' && Number(deposit.minAmount) > 0 && Number(deposit.maxAmount) >= Number(deposit.minAmount)
      if (!validFixed && !validRange) return 'Configura el monto verificable del anticipo.'
      const configuredCurrency = normalizeCurrencyCode(deposit.currency || item.currency)
      const expectedCurrency = normalizeCurrencyCode(accountCurrency)
      if (expectedCurrency && !configuredCurrency) {
        return `Confirma de nuevo el monto para guardarlo en la moneda de la cuenta (${expectedCurrency}).`
      }
      if (expectedCurrency && configuredCurrency && configuredCurrency !== expectedCurrency) {
        return `El anticipo está en ${configuredCurrency}, pero la cuenta cobra en ${expectedCurrency}. Confirma de nuevo el monto para guardarlo en ${expectedCurrency}.`
      }
    } else if (item.chargeType === 'direct') {
      if (!(Number(item.direct?.amount) > 0)) return 'Escribe un monto mayor a cero para el cobro directo.'
      if (!String(item.direct?.concept || '').trim()) return 'Escribe el concepto del cobro directo.'
      const directCurrency = normalizeCurrencyCode(item.direct?.currency)
      const expectedCurrency = normalizeCurrencyCode(accountCurrency)
      if (expectedCurrency && directCurrency !== expectedCurrency) return `El cobro directo debe usar ${expectedCurrency}.`
    } else if (!item.productId || !item.priceId) {
      return 'Selecciona el producto y precio reales de la capacidad para cobrar.'
    }
    if (isBankTransfer) return ''
    if (isDeposit && item.installments?.enabled) return 'Los meses sin intereses no aplican a anticipos.'
    if (item.gateway === 'highlevel' && item.installments?.enabled) return 'HighLevel no permite fijar meses sin intereses en invoices.'
    if (item.gateway === 'highlevel' && Number(item.expirationMinutes) < 1440) return 'HighLevel requiere una fecha límite de al menos 24 horas.'
    if (item.installments?.enabled) {
      const availableMonths = getConversationalPaymentMsiMonths(item, accountCurrency)
      if (!availableMonths.includes(Number(item.installments.maxInstallments))) {
        return 'El monto, la moneda o la pasarela no permiten el máximo de meses configurado.'
      }
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
      if (!link || getNativeCapabilityItemError(link, allItems, accountCurrency)) {
        return 'Activa y configura Mandar enlace para completar este objetivo.'
      }
    }
  }
  return ''
}

function getNativeCapabilityError(agent: ConversationalAgentDef, accountCurrency = '') {
  const items = agent.capabilitiesConfig?.items || []
  for (const item of items) {
    const error = getNativeCapabilityItemError(item, items, accountCurrency)
    if (error) return error
  }
  return ''
}

function getAgentValidationError(agent: ConversationalAgentDef, accountCurrency = '') {
  return (agent.enabled ? getNativeCapabilityError(agent, accountCurrency) : '') ||
    getResponseDelayError(getAgentResponseDelay(agent)) ||
    getReplyDeliveryError(getAgentReplyDelivery(agent)) ||
    getFollowUpError(getAgentFollowUp(agent))
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

function getTeamUserDisplayName(user?: TeamUser | null) {
  if (!user) return ''
  return user.fullName || user.email || user.phone || user.username || `Usuario ${user.id}`
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
  productsError?: string
  canUsePaymentLinks: boolean
  filterOptions?: AgentFilterOptions
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
    description: 'Consulta espacios reales y termina el proceso en el calendario elegido.',
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
  accountCurrency: string,
  canUsePaymentLinks: boolean
): ConversationalCapabilityItem {
  const existing = getNativeCapability(agent.capabilitiesConfig, id)
  if (existing) {
    if (id === 'collect_payment' && !canUsePaymentLinks) {
      const payment = existing as Extract<ConversationalCapabilityItem, { id: 'collect_payment' }>
      return {
        ...payment,
        enabled: true,
        collectionMethod: 'bank_transfer',
        gateway: null,
        installments: { enabled: false, maxInstallments: 0 },
        receiptProof: { enabled: true, disposition: 'pending_review' },
        deposit: {
          ...payment.deposit,
          methods: { paymentLink: false, bankTransfer: true }
        }
      }
    }
    return { ...existing, enabled: true } as ConversationalCapabilityItem
  }

  if (id === 'schedule_appointment') {
    return {
      id,
      enabled: true,
      calendarId: calendars.length === 1 ? calendars[0].id : '',
      allowOverlaps: false,
      bookingOwner: 'ai',
      handoffUserId: '',
      handoffUserName: '',
      testMode: { enabled: false, cleanupAfterMinutes: 5, notify: true }
    }
  }
  if (id === 'collect_payment') {
    return {
      id,
      enabled: true,
      productId: '',
      priceId: '',
      paymentMode: 'full_payment',
      chargeType: 'product',
      collectionMethod: canUsePaymentLinks ? 'payment_link' : 'bank_transfer',
      amount: null,
      currency: accountCurrency,
      gateway: canUsePaymentLinks ? 'stripe' : null,
      direct: {
        amount: null,
        currency: accountCurrency,
        concept: '',
        description: ''
      },
      installments: { enabled: false, maxInstallments: 0 },
      expirationMinutes: 60,
      afterPayment: 'continue',
      receiptProof: { enabled: !canUsePaymentLinks, disposition: 'pending_review' },
      bankTransfer: { details: '' },
      deposit: {
        ...defaultNativeDeposit,
        currency: accountCurrency,
        methods: canUsePaymentLinks
          ? { ...DEFAULT_AGENT_DEPOSIT_METHODS }
          : { paymentLink: false, bankTransfer: true }
      },
      testMode: { enabled: false, cleanupAfterMinutes: 5, notify: true }
    }
  }
  if (id === 'send_link') {
    return {
      id,
      enabled: true,
      linkKind: 'verified_goal',
      triggerLinkId: '',
      url: '',
      trackingParam: 'ristak_goal_id'
    }
  }
  if (id === 'handoff_human') {
    return {
      id,
      enabled: true,
      rules: '',
      userId: '',
      userName: '',
      pastClientsToHuman: false
    }
  }
  return {
    id: 'custom_goal',
    enabled: true,
    description: '',
    completion: 'handoff'
  }
}

interface NativeConversationBuilderProps {
  agent: ConversationalAgentDef
  calendars: Calendar[]
  products: ProductItem[]
  productsLoading: boolean
  productsError?: string
  teamUsers: TeamUser[]
  teamUsersLoading: boolean
  accountCurrency: string
  canUsePaymentLinks: boolean
  onChange: (patch: ConversationalAgentDefInput) => void
  onFlushSave: () => Promise<ConversationalAgentDef | null>
}

const NativeConversationBuilder: React.FC<NativeConversationBuilderProps> = ({
  agent,
  calendars,
  products,
  productsLoading,
  productsError,
  teamUsers,
  teamUsersLoading,
  accountCurrency,
  canUsePaymentLinks,
  onChange,
  onFlushSave
}) => {
  const { showToast } = useNotification()
  const { labels } = useLabels()
  const customersLowerLabel = formatCrmLabelLower(labels.customers, DEFAULT_CRM_LABELS.customers)
  const capabilities = agent.capabilitiesConfig || DEFAULT_CONVERSATIONAL_CAPABILITIES_CONFIG
  const [paymentSettingsOpen, setPaymentSettingsOpen] = useState(false)
  const [savingPaymentSettings, setSavingPaymentSettings] = useState(false)
  const promptConfig = agent.promptConfig || DEFAULT_CONVERSATIONAL_PROMPT_CONFIG
  const strategyText = promptConfig.strategyText ?? promptConfig.editableText ?? ''
  const personalityText = promptConfig.personalityText ?? ''

  const updatePromptText = (field: 'strategyText' | 'personalityText', value: string) => {
    const nextStrategyText = field === 'strategyText' ? value : strategyText
    const nextPersonalityText = field === 'personalityText' ? value : personalityText
    onChange({
      promptConfig: {
        ...promptConfig,
        schemaVersion: 2,
        strategyText: nextStrategyText,
        personalityText: nextPersonalityText,
        editableText: buildConversationalLegacyEditableText(nextStrategyText, nextPersonalityText)
      }
    })
  }
  const flushPromptSave = () => {
    void onFlushSave().catch(() => undefined)
  }

  const updateCapability = (next: ConversationalCapabilityItem, { pause = true } = {}) => {
    const exists = capabilities.items.some((item) => item.id === next.id)
    const items = exists
      ? capabilities.items.map((item) => (item.id === next.id ? next : item))
      : [...capabilities.items, next]
    onChange({
      capabilitiesConfig: { ...capabilities, schemaVersion: 3, items },
      ...(pause && agent.enabled ? { enabled: false } : {})
    })
    if (pause && agent.enabled) {
      showToast('info', 'Agente en pausa', 'Configura y prueba la nueva capacidad antes de volver a publicarlo.')
    }
  }

  const updateCapabilitiesConfig = (patch: Partial<ConversationalCapabilitiesConfig>, { pause = true } = {}) => {
    onChange({
      capabilitiesConfig: { ...capabilities, ...patch, schemaVersion: 3 },
      ...(pause && agent.enabled ? { enabled: false } : {})
    })
    if (pause && agent.enabled) {
      showToast('info', 'Agente en pausa', 'Guarda y prueba esta configuración antes de volver a publicarlo.')
    }
  }

  const toggleCapability = (id: ConversationalCapabilityId, enabled: boolean) => {
    const current = getNativeCapability(capabilities, id)
    const next = enabled
      ? buildNativeCapabilityFromAgent(agent, id, calendars, accountCurrency, canUsePaymentLinks)
      : ({ ...(current || buildNativeCapabilityFromAgent(agent, id, calendars, accountCurrency, canUsePaymentLinks)), enabled: false } as ConversationalCapabilityItem)
    updateCapability(next, { pause: true })
  }

  const scheduleCapability = getNativeCapability(capabilities, 'schedule_appointment')
  const storedPaymentCapability = getNativeCapability(capabilities, 'collect_payment')
  const paymentCapability = storedPaymentCapability && !canUsePaymentLinks
    ? {
        ...buildNativeCapabilityFromAgent(agent, 'collect_payment', calendars, accountCurrency, false),
        enabled: storedPaymentCapability.enabled
      } as Extract<ConversationalCapabilityItem, { id: 'collect_payment' }>
    : storedPaymentCapability
  const linkCapability = getNativeCapability(capabilities, 'send_link')
  const handoffCapability = getNativeCapability(capabilities, 'handoff_human')
  const customCapability = getNativeCapability(capabilities, 'custom_goal')
  const depositCurrency = normalizeCurrencyCode(paymentCapability?.deposit?.currency || accountCurrency)
  const currencySymbol = getCurrencyInputSymbol(depositCurrency)
  const currencyStep = getCurrencyInputStep(accountCurrency)
  const currencyFractionDigits = getCurrencyFractionDigits(accountCurrency)
  const paymentMsiMonths = paymentCapability
    ? getConversationalPaymentMsiMonths(paymentCapability, accountCurrency)
    : []
  const moneyPrefixStyle = {
    '--money-prefix-space': `${Math.max(30, 20 + Array.from(currencySymbol).length * 8)}px`
  } as React.CSSProperties
  const selectedProduct = products.find((product) => getProductId(product) === paymentCapability?.productId) || null
  const productPrices = selectedProduct?.prices || []
  const selectedPrice = productPrices.find((price) => getPriceId(price) === paymentCapability?.priceId) || null
  const paymentConfigurationError = paymentCapability
    ? getNativeCapabilityItemError(paymentCapability, capabilities.items, accountCurrency)
    : ''
  const paymentGatewayLabels: Record<NonNullable<Extract<ConversationalCapabilityItem, { id: 'collect_payment' }>['gateway']>, string> = {
    stripe: 'Stripe',
    conekta: 'Conekta',
    mercadopago: 'Mercado Pago',
    clip: 'CLIP',
    rebill: 'Rebill',
    highlevel: 'Conexión anterior'
  }
  const paymentAmountSummary = paymentCapability?.chargeType === 'direct'
    ? (paymentCapability.direct.amount
        ? formatCurrency(paymentCapability.direct.amount, paymentCapability.direct.currency || accountCurrency)
        : 'Falta monto')
    : paymentCapability?.chargeType === 'deposit'
      ? (paymentCapability.deposit.mode === 'range'
          ? `${formatCurrency(Number(paymentCapability.deposit.minAmount) || 0, depositCurrency)} a ${formatCurrency(Number(paymentCapability.deposit.maxAmount) || 0, depositCurrency)}`
          : (paymentCapability.deposit.amount
              ? formatCurrency(paymentCapability.deposit.amount, depositCurrency)
              : 'Falta monto'))
      : (selectedPrice
          ? formatCurrency(getPriceAmount(selectedPrice), normalizeCurrencyCode(selectedPrice.currency || selectedProduct?.currency || accountCurrency))
          : 'Falta precio')
  const paymentConceptSummary = paymentCapability?.chargeType === 'direct'
    ? (paymentCapability.direct.concept || 'Cobro directo')
    : paymentCapability?.chargeType === 'deposit'
      ? 'Anticipo'
      : (selectedProduct?.name || 'Falta producto')
  const paymentSummaryItems = paymentCapability ? [
    paymentCapability.collectionMethod === 'bank_transfer' ? 'Transferencia/Depósito' : 'Link de pago',
    `${paymentConceptSummary} · ${paymentAmountSummary}`,
    ...(paymentCapability.collectionMethod === 'payment_link'
      ? [
          paymentGatewayLabels[paymentCapability.gateway || 'stripe'],
          paymentCapability.installments.enabled ? `Hasta ${paymentCapability.installments.maxInstallments} MSI` : 'Sin MSI',
          `Vence en ${Number(paymentCapability.expirationMinutes) >= 10080 ? '7 días' : Number(paymentCapability.expirationMinutes) >= 1440 ? '24 horas' : Number(paymentCapability.expirationMinutes) >= 360 ? '6 horas' : Number(paymentCapability.expirationMinutes) >= 60 ? '1 hora' : '30 minutos'}`
        ]
      : [
          'Comprobante por imagen',
          String(paymentCapability.bankTransfer?.details || paymentCapability.deposit?.bankTransferDetails || '').trim()
            ? 'Datos bancarios configurados'
            : 'Faltan datos bancarios'
        ]),
    paymentCapability.afterPayment === 'handoff' ? 'Después: pasar al equipo' : 'Después: continuar'
  ] : []
  const manifestById = new Map<ConversationalCapabilityId, ConversationalCapabilityManifestItem>(
    (agent.capabilityManifest || []).map((item) => [item.id, item])
  )

  const savePaymentSettings = async () => {
    if (paymentConfigurationError || savingPaymentSettings) return
    setSavingPaymentSettings(true)
    try {
      await onFlushSave()
      setPaymentSettingsOpen(false)
    } finally {
      setSavingPaymentSettings(false)
    }
  }

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
          <label className={styles.label}>¿Quién termina de agendar?</label>
          <CustomSelect
            value={scheduleCapability.bookingOwner || 'ai'}
            onChange={(event) => updateCapability({
              ...scheduleCapability,
              bookingOwner: event.target.value === 'human' ? 'human' : 'ai',
              handoffUserId: event.target.value === 'human' ? scheduleCapability.handoffUserId : '',
              handoffUserName: event.target.value === 'human' ? scheduleCapability.handoffUserName : ''
            })}
            portal
            aria-label="Quién termina de agendar"
          >
            <option value="ai">La IA agenda y confirma</option>
            <option value="human">Una persona confirma y agenda</option>
          </CustomSelect>
          {scheduleCapability.bookingOwner === 'human' ? (
            <>
              <label className={styles.label}>Persona asignada (opcional)</label>
              <CustomSelect
                value={scheduleCapability.handoffUserId}
                onChange={(event) => {
                  const user = teamUsers.find((item) => item.id === event.target.value) || null
                  updateCapability({
                    ...scheduleCapability,
                    bookingOwner: 'human',
                    handoffUserId: user?.id || '',
                    handoffUserName: getTeamUserDisplayName(user)
                  })
                }}
                disabled={teamUsersLoading}
                portal
              >
                <option value="">Avisar al equipo sin asignar</option>
                {teamUsers.map((user) => <option key={user.id} value={user.id}>{getTeamUserDisplayName(user)}</option>)}
              </CustomSelect>
              <p className={styles.helper}>La IA muestra horarios reales. Cuando la persona confirma una cita nueva o un cambio, vuelve a comprobarlo y entrega el chat con la fecha exacta; no crea ni modifica la cita.</p>
            </>
          ) : (
            <p className={styles.helper}>La IA vuelve a comprobar el horario elegido, crea la cita y sólo entonces la confirma.</p>
          )}
          <div className={styles.nativeTestModeRow} data-enabled={scheduleCapability.testMode.enabled ? 'true' : undefined}>
            <div>
              <strong>Modo test para citas</strong>
              <span>{scheduleCapability.bookingOwner === 'human'
                ? (scheduleCapability.handoffUserId
                    ? 'Asigna temporalmente la solicitud, manda la notificación de prueba y después restaura al responsable anterior.'
                    : 'Valida el horario y avisa al equipo, sin asignar a una persona ni crear o modificar la cita.')
                : 'Crea una cita marcada como prueba y la elimina automáticamente después de 5 minutos.'}</span>
            </div>
            <Switch
              checked={scheduleCapability.testMode.enabled}
              onChange={(enabled) => updateCapability({
                ...scheduleCapability,
                testMode: { ...scheduleCapability.testMode, enabled, cleanupAfterMinutes: 5 }
              }, { pause: false })}
              aria-label="Activar modo test para citas"
            />
          </div>
        </div>
      ) : null
    },
    {
      id: 'collect_payment',
      item: paymentCapability,
      settings: paymentCapability?.enabled ? (
        <>
          <div className={styles.nativeCapabilitySettings}>
            <div className={styles.nativePaymentSummary} data-invalid={paymentConfigurationError ? 'true' : undefined}>
              <div className={styles.nativePaymentSummaryHeading}>
                <strong>Configuración del cobro</strong>
                <Badge variant={paymentConfigurationError ? 'warning' : 'success'}>
                  {paymentConfigurationError ? 'Incompleta' : 'Lista'}
                </Badge>
              </div>
              <div className={styles.nativePaymentSummaryItems}>
                {paymentSummaryItems.map((item) => <span key={item}>{item}</span>)}
              </div>
              {paymentConfigurationError && <p className={styles.nativeCapabilityError}><AlertTriangle size={15} />{paymentConfigurationError}</p>}
            </div>
            <Button variant="secondary" onClick={() => setPaymentSettingsOpen(true)} leftIcon={<CreditCard size={16} />}>
              Configurar cobro
            </Button>
            <div className={styles.nativeTestModeRow} data-enabled={paymentCapability.testMode.enabled ? 'true' : undefined}>
              <div>
                <strong>Modo test para pagos</strong>
                <span>{paymentCapability.collectionMethod === 'bank_transfer'
                  ? 'Permite probar el análisis del comprobante sin usar una pasarela ni confirmar dinero.'
                  : paymentCapability.gateway === 'highlevel'
                    ? 'La conexión anterior no puede forzar sandbox. Cambia a Stripe u otra pasarela compatible.'
                    : 'Crea un link sandbox, escucha la confirmación de prueba y elimina el registro después de 5 minutos.'}</span>
              </div>
              <Switch
                checked={paymentCapability.testMode.enabled}
                disabled={
                  paymentCapability.collectionMethod === 'payment_link' &&
                  paymentCapability.gateway === 'highlevel' &&
                  !paymentCapability.testMode.enabled
                }
                onChange={(enabled) => updateCapability({
                  ...paymentCapability,
                  testMode: { ...paymentCapability.testMode, enabled, cleanupAfterMinutes: 5 }
                }, { pause: false })}
                aria-label="Activar modo test para pagos"
              />
            </div>
            {paymentCapability.collectionMethod === 'payment_link' && paymentCapability.gateway === 'highlevel' && (
              <p className={styles.helper}>La conexión anterior no permite forzar sandbox por conversación. Cambia a Stripe u otra pasarela compatible; si este switch ya venía activo, apágalo para poder publicar.</p>
            )}
          </div>
          <Modal
            isOpen={paymentSettingsOpen}
            onClose={() => {
              setPaymentSettingsOpen(false)
              flushPromptSave()
            }}
            title="Cómo va a cobrar la IA"
            subtitle={canUsePaymentLinks
              ? 'Elige si la IA manda un link seguro o revisa la imagen de una transferencia. Nunca pide datos de tarjeta en el chat.'
              : 'Configura cómo revisará la imagen de una transferencia o depósito. La imagen no confirma que los fondos hayan llegado.'}
            size="lg"
          >
          <div className={styles.nativeCapabilitySettings}>
          <label className={styles.label}>Cómo recibirá el pago</label>
          <CustomSelect
            value={paymentCapability.collectionMethod}
            onChange={(event) => {
              const collectionMethod = event.target.value === 'bank_transfer' ? 'bank_transfer' : 'payment_link'
              updateCapability({
                ...paymentCapability,
                collectionMethod,
                gateway: collectionMethod === 'payment_link' ? (paymentCapability.gateway || 'stripe') : null,
                installments: collectionMethod === 'payment_link' ? paymentCapability.installments : { enabled: false, maxInstallments: 0 },
                receiptProof: { enabled: collectionMethod === 'bank_transfer', disposition: 'pending_review' },
                deposit: {
                  ...paymentCapability.deposit,
                  methods: {
                    paymentLink: collectionMethod === 'payment_link',
                    bankTransfer: collectionMethod === 'bank_transfer'
                  },
                  bankTransferDetails: paymentCapability.bankTransfer?.details || paymentCapability.deposit.bankTransferDetails || ''
                }
              })
            }}
            portal
          >
            {canUsePaymentLinks && <option value="payment_link">Link de pago</option>}
            <option value="bank_transfer">Transferencia/Depósito</option>
          </CustomSelect>
          <p className={styles.helper}>{paymentCapability.collectionMethod === 'bank_transfer'
            ? 'La persona transfiere desde su propia app y manda una foto o captura. La IA la analiza y la deja pendiente de revisión; la imagen no confirma fondos.'
            : 'La IA crea un link en la pasarela elegida. El pago sólo se confirma cuando Ristak recibe la señal real de la pasarela.'}</p>
          <label className={styles.label}>Tipo de cobro</label>
          <CustomSelect
            value={paymentCapability.chargeType}
            onChange={(event) => {
              const chargeType = event.target.value === 'deposit' ? 'deposit' : (event.target.value === 'direct' ? 'direct' : 'product')
              updateCapability({
                ...paymentCapability,
                chargeType,
                paymentMode: chargeType === 'deposit' ? 'deposit' : 'full_payment',
                productId: chargeType === 'product' ? paymentCapability.productId : '',
                priceId: chargeType === 'product' ? paymentCapability.priceId : '',
                deposit: { ...paymentCapability.deposit, enabled: chargeType === 'deposit', currency: accountCurrency },
                installments: { enabled: false, maxInstallments: 0 }
              })
            }}
            portal
          >
            <option value="product">Pago único de un producto</option>
            <option value="direct">Pago único sin producto</option>
            <option value="deposit">Anticipo</option>
          </CustomSelect>
          {paymentCapability.chargeType === 'product' ? (
            <>
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
                    currency: accountCurrency,
                    installments: { enabled: false, maxInstallments: 0 }
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
                      currency: normalizeCurrencyCode(price?.currency || selectedProduct?.currency || accountCurrency),
                      installments: { enabled: false, maxInstallments: 0 }
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
              {productsError ? (
                <p className={styles.nativeCapabilityError} role="alert">
                  <AlertTriangle size={15} />
                  {productsError}
                </p>
              ) : (!productsLoading && products.length === 0 ? (
                <p className={styles.helper}>No hay productos con precios disponibles. Crea uno en Pagos o cambia el tipo de cobro a Anticipo.</p>
              ) : null)}
            </>
          ) : paymentCapability.chargeType === 'direct' ? (
            <>
              <label className={styles.label}>Concepto del cobro</label>
              <input
                className={styles.input}
                value={paymentCapability.direct.concept}
                placeholder="Ejemplo: Consulta inicial"
                onChange={(event) => updateCapability({
                  ...paymentCapability,
                  direct: { ...paymentCapability.direct, concept: event.target.value, currency: accountCurrency }
                })}
              />
              <label className={styles.label}>Monto ({accountCurrency})</label>
              <div className={styles.moneyInputWrap} style={moneyPrefixStyle}>
                <span className={styles.moneyPrefix} title={accountCurrency} aria-hidden="true">{getCurrencyInputSymbol(accountCurrency)}</span>
                <NumberInput
                  className={styles.moneyInput}
                  value={paymentCapability.direct.amount || ''}
                  min={0}
                  step={currencyStep}
                  maxFractionDigits={currencyFractionDigits}
                  aria-label={`Monto del cobro en ${accountCurrency}`}
                  onValueChange={(amount) => updateCapability({
                    ...paymentCapability,
                    direct: { ...paymentCapability.direct, amount, currency: accountCurrency },
                    installments: { enabled: false, maxInstallments: 0 }
                  })}
                />
              </div>
              <label className={styles.label}>Descripción (opcional)</label>
              <textarea
                className={styles.textarea}
                value={paymentCapability.direct.description}
                rows={2}
                placeholder="Qué incluye o por qué se cobra"
                onChange={(event) => updateCapability({
                  ...paymentCapability,
                  direct: { ...paymentCapability.direct, description: event.target.value }
                })}
              />
            </>
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
                      <label className={styles.label}>Mínimo ({depositCurrency})</label>
                      <div className={styles.moneyInputWrap} style={moneyPrefixStyle}>
                        <span className={styles.moneyPrefix} title={depositCurrency} aria-hidden="true">{currencySymbol}</span>
                        <NumberInput
                          className={styles.moneyInput}
                          value={paymentCapability.deposit.minAmount || ''}
                          min={0}
                          step={currencyStep}
                          maxFractionDigits={currencyFractionDigits}
                          aria-label={`Monto mínimo en ${accountCurrency}`}
                          onValueChange={(minAmount) => updateCapability({
                            ...paymentCapability,
                            deposit: { ...paymentCapability.deposit, enabled: true, mode: 'range', minAmount, currency: accountCurrency }
                          })}
                        />
                      </div>
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Máximo ({depositCurrency})</label>
                      <div className={styles.moneyInputWrap} style={moneyPrefixStyle}>
                        <span className={styles.moneyPrefix} title={depositCurrency} aria-hidden="true">{currencySymbol}</span>
                        <NumberInput
                          className={styles.moneyInput}
                          value={paymentCapability.deposit.maxAmount || ''}
                          min={0}
                          step={currencyStep}
                          maxFractionDigits={currencyFractionDigits}
                          aria-label={`Monto máximo en ${accountCurrency}`}
                          onValueChange={(maxAmount) => updateCapability({
                            ...paymentCapability,
                            deposit: { ...paymentCapability.deposit, enabled: true, mode: 'range', maxAmount, currency: accountCurrency }
                          })}
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className={styles.field}>
                    <label className={styles.label}>Monto del anticipo ({depositCurrency})</label>
                    <div className={styles.moneyInputWrap} style={moneyPrefixStyle}>
                      <span className={styles.moneyPrefix} title={depositCurrency} aria-hidden="true">{currencySymbol}</span>
                      <NumberInput
                        className={styles.moneyInput}
                        value={paymentCapability.deposit.amount || ''}
                        min={0}
                        step={currencyStep}
                        maxFractionDigits={currencyFractionDigits}
                        aria-label={`Monto del anticipo en ${accountCurrency}`}
                        onValueChange={(amount) => updateCapability({
                          ...paymentCapability,
                          deposit: { ...paymentCapability.deposit, enabled: true, mode: 'fixed', amount, currency: accountCurrency }
                        })}
                      />
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          {paymentCapability.collectionMethod === 'bank_transfer' ? (
            <>
              <label className={styles.label}>Datos para transferir o depositar</label>
              <textarea
                className={styles.textarea}
                value={paymentCapability.bankTransfer?.details || ''}
                rows={4}
                placeholder="Banco, titular, cuenta, CLABE y referencia que debe escribir la persona"
                onChange={(event) => updateCapability({
                  ...paymentCapability,
                  bankTransfer: { details: event.target.value },
                  receiptProof: { enabled: true, disposition: 'pending_review' },
                  deposit: {
                    ...paymentCapability.deposit,
                    methods: { paymentLink: false, bankTransfer: true },
                    bankTransferDetails: event.target.value
                  }
                })}
              />
              <p className={styles.helper}>La IA acepta una foto o captura del comprobante, valida que coincida con el cobro y lo registra pendiente de revisión. Nunca lo marca pagado sólo por la imagen.</p>
            </>
          ) : (
            <>
              <label className={styles.label}>Pasarela para crear el link</label>
              <CustomSelect
                value={paymentCapability.gateway === 'highlevel' ? 'legacy' : (paymentCapability.gateway || 'stripe')}
                onChange={(event) => {
                  const gateway = event.target.value === 'legacy'
                    ? 'highlevel'
                    : event.target.value as NonNullable<typeof paymentCapability.gateway>
                  updateCapability({
                    ...paymentCapability,
                    gateway,
                    installments: { enabled: false, maxInstallments: 0 }
                  })
                }}
                portal
              >
                <option value="stripe">Stripe</option>
                <option value="conekta">Conekta</option>
                <option value="mercadopago">Mercado Pago</option>
                <option value="clip">CLIP</option>
                <option value="rebill">Rebill</option>
                {paymentCapability.gateway === 'highlevel' && <option value="legacy">Conexión anterior (cambiar)</option>}
              </CustomSelect>
              {paymentCapability.chargeType !== 'deposit' && paymentCapability.gateway !== 'highlevel' && paymentMsiMonths.length > 0 && (
                <div className={styles.nativePaymentMethods}>
                  <label>
                    <Switch
                      checked={paymentCapability.installments.enabled}
                      onChange={(enabled) => updateCapability({
                        ...paymentCapability,
                        installments: { enabled, maxInstallments: enabled ? (paymentCapability.installments.maxInstallments || 3) : 0 }
                      })}
                      aria-label="Ofrecer meses sin intereses"
                    />
                    Ofrecer meses sin intereses
                  </label>
                  {paymentCapability.installments.enabled && (
                    <CustomSelect
                      value={String(paymentCapability.installments.maxInstallments || 3)}
                      onChange={(event) => updateCapability({
                        ...paymentCapability,
                        installments: { enabled: true, maxInstallments: Number(event.target.value) }
                      })}
                      portal
                      aria-label="Máximo de meses sin intereses"
                    >
                      {paymentMsiMonths.map((months) => <option key={months} value={months}>Hasta {months} meses</option>)}
                    </CustomSelect>
                  )}
                </div>
              )}
              {paymentCapability.chargeType !== 'deposit' && paymentCapability.gateway !== 'highlevel' && paymentMsiMonths.length === 0 && (
                <p className={styles.helper}>Esta combinación de pasarela, monto y moneda no permite meses sin intereses.</p>
              )}
            </>
          )}
          <div className={styles.nativeInlineFields}>
            {paymentCapability.collectionMethod === 'payment_link' && (
              <div className={styles.field}>
                <label className={styles.label}>El link vence en</label>
                <CustomSelect
                  value={String(paymentCapability.expirationMinutes)}
                  onChange={(event) => updateCapability({ ...paymentCapability, expirationMinutes: Number(event.target.value) })}
                  portal
                >
                  <option value="30">30 minutos</option>
                  <option value="60">1 hora</option>
                  <option value="360">6 horas</option>
                  <option value="1440">24 horas</option>
                  <option value="10080">7 días</option>
                </CustomSelect>
              </div>
            )}
            <div className={styles.field}>
              <label className={styles.label}>Después del pago confirmado</label>
              <CustomSelect
                value={paymentCapability.afterPayment}
                onChange={(event) => updateCapability({ ...paymentCapability, afterPayment: event.target.value === 'handoff' ? 'handoff' : 'continue' })}
                portal
              >
                <option value="continue">Continuar con el objetivo</option>
                <option value="handoff">Pasar al equipo</option>
              </CustomSelect>
            </div>
          </div>
          {paymentConfigurationError && <p className={styles.nativeCapabilityError}><AlertTriangle size={15} />{paymentConfigurationError}</p>}
            <div className={styles.agentTestOptionsActions}>
              <Button variant="primary" loading={savingPaymentSettings} disabled={Boolean(paymentConfigurationError)} onClick={() => void savePaymentSettings()}>
                Guardar configuración
              </Button>
            </div>
          </div>
          </Modal>
        </>
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
                aria-label={`Pasar ${customersLowerLabel} existentes al equipo`}
              />
              {formatCrmLabelSentence(labels.customers, DEFAULT_CRM_LABELS.customers)} existentes van con tu equipo
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
      const localError = getNativeCapabilityItemError(item, capabilities.items, accountCurrency)
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

  const safetyPolicy = capabilities.safetyPolicy || DEFAULT_CONVERSATIONAL_CAPABILITIES_CONFIG.safetyPolicy
  const dataRequirements = capabilities.dataRequirements || DEFAULT_CONVERSATIONAL_CAPABILITIES_CONFIG.dataRequirements
  const requiredDataOptions: Array<{ field: ConversationalRequiredDataField; label: string }> = [
    { field: 'first_name', label: 'Nombre' },
    { field: 'full_name', label: 'Nombre completo' },
    { field: 'phone', label: 'Teléfono principal' },
    { field: 'alternate_phone', label: 'Otro teléfono' },
    { field: 'email', label: 'Correo' },
    { field: 'company', label: 'Empresa' },
    { field: 'address', label: 'Dirección' },
    { field: 'custom', label: 'Dato personalizado' }
  ]
  const requiredDataConditionOptions: Array<{
    fact: ConversationalRequiredDataConditionFact
    scope: ConversationalRequiredDataItem['scope']
    label: string
  }> = [
    { fact: 'appointment.primary_attendee_is_different', scope: 'appointment', label: 'Cuando la cita sea para otra persona' },
    { fact: 'appointment.has_guests', scope: 'appointment', label: 'Cuando la cita incluya invitados' },
    { fact: 'payment.is_deposit', scope: 'payment', label: 'Cuando el cobro sea un anticipo' },
    { fact: 'payment.is_full_payment', scope: 'payment', label: 'Cuando el cobro sea pago completo' }
  ]
  const guestDataOptions = [
    { value: 'name' as const, label: 'Nombre' },
    { value: 'phone' as const, label: 'Teléfono' },
    { value: 'email' as const, label: 'Correo' },
    { value: 'relation' as const, label: 'Relación con quien escribe' }
  ]
  const updateRequiredDataItem = (field: ConversationalRequiredDataField, patch: Partial<ConversationalRequiredDataItem> | null) => {
    const existing = dataRequirements.fields.find((item) => item.field === field)
    const fields = patch === null
      ? dataRequirements.fields.filter((item) => item.field !== field)
      : [
          ...dataRequirements.fields.filter((item) => item.field !== field),
          {
            field,
            level: existing?.level || 'required',
            scope: existing?.scope || 'any_action',
            ...existing,
            ...patch
          } as ConversationalRequiredDataItem
        ]
    updateCapabilitiesConfig({
      dataRequirements: {
        ...dataRequirements,
        enabled: fields.length > 0 || dataRequirements.participants.enabled,
        fields
      }
    })
  }
  const updateRequiredDataSelection = (selectedFields: ConversationalRequiredDataField[]) => {
    const selected = new Set(selectedFields)
    const fields = requiredDataOptions
      .filter((option) => selected.has(option.field))
      .map((option) => dataRequirements.fields.find((item) => item.field === option.field) || {
        field: option.field,
        level: 'required' as const,
        scope: 'any_action' as const,
        ...(option.field === 'custom' ? { label: 'Dato personalizado' } : {})
      })
    updateCapabilitiesConfig({
      dataRequirements: {
        ...dataRequirements,
        enabled: fields.length > 0 || dataRequirements.participants.guestFields.length > 0,
        fields
      }
    })
  }
  const updateGuestDataSelection = (guestFields: Array<'name' | 'phone' | 'email' | 'relation'>) => {
    const participants = {
      ...dataRequirements.participants,
      enabled: guestFields.length > 0,
      guestFields
    }
    updateCapabilitiesConfig({
      dataRequirements: {
        ...dataRequirements,
        enabled: dataRequirements.fields.length > 0 || participants.enabled,
        participants
      }
    })
  }

  return (
    <>
      <div className={styles.nativeRuntimeHeader}>
        <div>
          <Badge variant="info">Flujo directo</Badge>
          <span>Una sola IA conversa y usa herramientas nativas.</span>
        </div>
      </div>

      <div className={styles.agentSection}>
        <h3 className={styles.sectionTitle}>1. Capacitación y personalidad</h3>
        <p className={styles.agentSectionHint}>Son dos cosas distintas: qué debe saber y hacer, y cómo debe hablar. Puedes dejar las plantillas, editarlas o borrarlas completas.</p>
        <div className={styles.nativePromptFields}>
          <ExpandableTextareaField
            id={`agent-${agent.id}-strategy`}
            label="Estrategia y capacitación"
            description="El cerebro: qué debe saber y conseguir, qué proceso sigue y cuándo debe agendar, cobrar, mandar un enlace o pasar a humano."
            value={strategyText}
            rows={12}
            placeholder="Describe el negocio, productos, proceso, respuestas, objetivos y forma de llevar la conversación."
            spellCheck
            onChange={(value) => updatePromptText('strategyText', value)}
            onBlur={flushPromptSave}
            onExpandedClose={flushPromptSave}
          />
          <ExpandableTextareaField
            id={`agent-${agent.id}-personality`}
            label="Personalidad del agente"
            description="Sólo cómo debe hablar: tono, vocabulario, formalidad, humor, emojis y estilo. Las reglas de proceso van en Estrategia."
            value={personalityText}
            rows={7}
            placeholder="Ejemplo: cálido, directo, mexicano, breve y sin frases acartonadas."
            spellCheck
            onChange={(value) => updatePromptText('personalityText', value)}
            onBlur={flushPromptSave}
            onExpandedClose={flushPromptSave}
          />
        </div>
        <p className={styles.helper}>Ambos textos se guardan completos. Aunque borres los dos, las capacidades activadas conservan sus validaciones internas.</p>
      </div>

      <div className={styles.agentSection}>
        <h3 className={styles.sectionTitle}>2. Capacidades</h3>
        <p className={styles.agentSectionHint}>Activa varias si las necesitas. Cada una pide sólo la configuración que hace falta para operar.</p>
        <div className={styles.nativeCapabilityList}>
          {capabilityRows.map(({ id, item, settings }) => {
            const meta = nativeCapabilityMeta[id]
            const Icon = meta.Icon
            const localError = item?.enabled ? getNativeCapabilityItemError(item, capabilities.items, accountCurrency) : ''
            return (
              <div
                key={id}
                className={styles.nativeCapabilityRow}
                data-enabled={item?.enabled ? 'true' : undefined}
                data-invalid={localError ? 'true' : undefined}
              >
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
                {localError && id !== 'collect_payment' && (
                  <p className={styles.nativeCapabilityError} role="alert">
                    <AlertTriangle size={15} />
                    Antes de publicar: {localError}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className={styles.agentSection}>
        <h3 className={styles.sectionTitle}>3. Control y datos</h3>
        <p className={styles.agentSectionHint}>Define qué pasa con conversaciones riesgosas y qué datos sí debe solicitar.</p>
        <div className={styles.nativeCapabilityList}>
          <div className={styles.nativeCapabilityRow} data-enabled={safetyPolicy.enabled ? 'true' : undefined}>
            <div className={styles.nativeCapabilityHeading}>
              <span className={styles.nativeCapabilityIcon}><ShieldAlert size={18} /></span>
              <div>
                <strong>Medidas preventivas</strong>
                <span>Detecta riesgo grave por contexto, detiene el chat y deja el caso marcado para revisión.</span>
              </div>
              <Switch
                checked={safetyPolicy.enabled}
                onChange={(enabled) => updateCapabilitiesConfig({ safetyPolicy: { ...safetyPolicy, enabled } })}
                aria-label="Activar medidas preventivas"
              />
            </div>
            {safetyPolicy.enabled && (
              <div className={styles.nativeCapabilitySettings}>
                <label className={styles.label}>Qué hacer cuando el riesgo es claro</label>
                <CustomSelect
                  value={safetyPolicy.action}
                  onChange={(event) => updateCapabilitiesConfig({
                    safetyPolicy: { ...safetyPolicy, action: event.target.value === 'handoff_and_review' ? 'handoff_and_review' : 'stop_and_review' }
                  })}
                  portal
                >
                  <option value="stop_and_review">Dejar de responder y marcar para revisión</option>
                  <option value="handoff_and_review">Pasar al equipo y marcar para revisión</option>
                </CustomSelect>
                <label className={styles.label}>Duración de la pausa</label>
                <CustomSelect
                  value={String(safetyPolicy.durationMinutes)}
                  onChange={(event) => updateCapabilitiesConfig({ safetyPolicy: { ...safetyPolicy, durationMinutes: Number(event.target.value) } })}
                  portal
                >
                  <option value="60">1 hora</option>
                  <option value="360">6 horas</option>
                  <option value="1440">24 horas</option>
                  <option value="10080">7 días</option>
                  <option value="43200">30 días</option>
                </CustomSelect>
                <div className={styles.nativePaymentMethods}>
                  <label>
                    <Switch
                      checked={safetyPolicy.notify}
                      onChange={(notify) => updateCapabilitiesConfig({ safetyPolicy: { ...safetyPolicy, notify } })}
                      aria-label="Notificar una medida preventiva"
                    />
                    Avisar al equipo
                  </label>
                </div>
                {safetyPolicy.notify && (
                  <>
                    <label className={styles.label}>Quién recibe el aviso</label>
                    <CustomSelect
                      value={safetyPolicy.notifyUserId}
                      onChange={(event) => {
                        const user = teamUsers.find((item) => String(item.id) === event.target.value) || null
                        updateCapabilitiesConfig({
                          safetyPolicy: {
                            ...safetyPolicy,
                            notifyUserId: user ? String(user.id) : '',
                            notifyUserName: getTeamUserDisplayName(user)
                          }
                        })
                      }}
                      disabled={teamUsersLoading}
                      portal
                    >
                      <option value="">Administradores del negocio</option>
                      {teamUsers.map((user) => (
                        <option key={user.id} value={String(user.id)}>{getTeamUserDisplayName(user)}</option>
                      ))}
                    </CustomSelect>
                  </>
                )}
                <p className={styles.helper}>No se borra el contacto. La medida es reversible y queda con categoría, motivo, fecha y evidencia para auditoría.</p>
              </div>
            )}
          </div>

          <div className={styles.nativeCapabilityRow} data-enabled={dataRequirements.enabled ? 'true' : undefined}>
            <div className={styles.nativeCapabilityHeading}>
              <span className={styles.nativeCapabilityIcon}><UserCheck size={18} /></span>
              <div>
                <strong>Datos requeridos</strong>
                <span>Elige exactamente qué información puede pedir antes de agendar o cobrar.</span>
              </div>
              <Badge variant={dataRequirements.enabled ? 'info' : 'neutral'}>
                {dataRequirements.fields.length + dataRequirements.participants.guestFields.length || 'Ninguno'}
              </Badge>
            </div>
            <div className={styles.nativeCapabilitySettings}>
              <label className={styles.label}>Datos de la persona que escribe</label>
              <CheckboxMultiSelect
                options={requiredDataOptions.map((option) => ({ value: option.field, label: option.label }))}
                value={dataRequirements.fields.map((item) => item.field)}
                onChange={updateRequiredDataSelection}
                placeholder="No pedir datos adicionales"
                aria-label="Elegir datos requeridos del contacto"
              />
              {requiredDataOptions.flatMap((option) => {
                const requirement = dataRequirements.fields.find((item) => item.field === option.field)
                if (!requirement) return []
                return [(
                  <div key={option.field} className={styles.nativeDataRequirementRow}>
                    <strong>{option.label}</strong>
                    <div className={styles.nativeInlineFields}>
                      <CustomSelect
                        value={requirement.level}
                        onChange={(event) => {
                          const level = event.target.value as ConversationalRequiredDataItem['level']
                          if (level !== 'conditional') {
                            updateRequiredDataItem(option.field, { level, condition: undefined })
                            return
                          }
                          const selected = requiredDataConditionOptions.find((item) => item.scope === requirement.scope) || requiredDataConditionOptions[0]
                          updateRequiredDataItem(option.field, {
                            level,
                            scope: selected.scope,
                            condition: { fact: selected.fact, operator: 'is_true', value: true }
                          })
                        }}
                        portal
                        aria-label={`Obligación de ${option.label}`}
                      >
                        <option value="required">Obligatorio</option>
                        <option value="optional">Opcional</option>
                        <option value="conditional">Condicional</option>
                      </CustomSelect>
                      {requirement.level !== 'conditional' ? (
                        <CustomSelect
                          value={requirement.scope}
                          onChange={(event) => updateRequiredDataItem(option.field, { scope: event.target.value as ConversationalRequiredDataItem['scope'] })}
                          portal
                          aria-label={`Cuándo pedir ${option.label}`}
                        >
                          <option value="any_action">Para cualquier acción final</option>
                          <option value="appointment">Para confirmar una cita nueva</option>
                          <option value="payment">Para cobrar</option>
                        </CustomSelect>
                      ) : (
                        <CustomSelect
                          value={requirement.condition?.fact || requiredDataConditionOptions[0].fact}
                          aria-label={`Condición para ${option.label}`}
                          onChange={(event) => {
                            const fact = event.target.value as ConversationalRequiredDataConditionFact
                            const selected = requiredDataConditionOptions.find((item) => item.fact === fact) || requiredDataConditionOptions[0]
                            updateRequiredDataItem(option.field, {
                              scope: selected.scope,
                              condition: { fact: selected.fact, operator: 'is_true', value: true }
                            })
                          }}
                          portal
                        >
                          {requiredDataConditionOptions.map((item) => (
                            <option key={item.fact} value={item.fact}>{item.label}</option>
                          ))}
                        </CustomSelect>
                      )}
                    </div>
                    {option.field === 'custom' && (
                      <input
                        className={styles.input}
                        value={requirement.label || ''}
                        placeholder="Ejemplo: Número de expediente"
                        aria-label="Nombre del dato personalizado"
                        onChange={(event) => updateRequiredDataItem('custom', { label: event.target.value })}
                      />
                    )}
                  </div>
                )]
              })}
              <label className={styles.label}>Qué hacer con datos confirmados</label>
              <CustomSelect
                value={dataRequirements.updateContact.enabled ? dataRequirements.updateContact.policy : 'none'}
                onChange={(event) => {
                  const value = event.target.value
                  updateCapabilitiesConfig({
                    dataRequirements: {
                      ...dataRequirements,
                      updateContact: {
                        enabled: value !== 'none',
                        policy: value === 'fill_missing' || value === 'confirm_changes' ? value : 'replace_placeholders'
                      }
                    }
                  })
                }}
                portal
                aria-label="Política para actualizar el contacto"
              >
                <option value="none">No actualizar la ficha</option>
                <option value="replace_placeholders">Llenar vacíos y reemplazar nombres provisionales</option>
                <option value="fill_missing">Sólo llenar datos vacíos</option>
                <option value="confirm_changes">Conservar distintos como alternativos para revisión</option>
              </CustomSelect>
              <p className={styles.helper}>Si el dato ya existe y está confirmado en la ficha, la IA lo reutiliza y no vuelve a pedirlo.</p>

              <label className={styles.label}>Datos del titular distinto e invitados</label>
              <CheckboxMultiSelect
                options={guestDataOptions}
                value={dataRequirements.participants.guestFields}
                onChange={updateGuestDataSelection}
                placeholder="No pedir datos de otras personas"
                aria-label="Elegir datos del titular distinto e invitados"
              />
              {dataRequirements.participants.guestFields.length > 0 && (
                <>
                  <div className={styles.nativeInlineFields}>
                    <div className={styles.field}>
                      <label className={styles.label}>¿La cita puede ser para otra persona?</label>
                      <CustomSelect
                        value={dataRequirements.participants.allowPrimaryAttendeeDifferentFromRequester ? 'yes' : 'no'}
                        onChange={(event) => updateCapabilitiesConfig({
                          dataRequirements: {
                            ...dataRequirements,
                            participants: {
                              ...dataRequirements.participants,
                              enabled: true,
                              allowPrimaryAttendeeDifferentFromRequester: event.target.value !== 'no'
                            }
                          }
                        })}
                        portal
                      >
                        <option value="yes">Sí, permitir titular distinto</option>
                        <option value="no">No, sólo quien escribe</option>
                      </CustomSelect>
                    </div>
                    <div className={styles.field}>
                      <label className={styles.label}>Máximo de invitados por cita</label>
                      <CustomSelect
                        value={String(dataRequirements.participants.maxGuests)}
                        onChange={(event) => updateCapabilitiesConfig({
                          dataRequirements: {
                            ...dataRequirements,
                            participants: {
                              ...dataRequirements.participants,
                              enabled: true,
                              maxGuests: Number(event.target.value)
                            }
                          }
                        })}
                        portal
                        aria-label="Máximo de invitados por cita"
                      >
                        {[1, 2, 3, 5, 10, 20].map((value) => (
                          <option key={value} value={value}>{value}</option>
                        ))}
                      </CustomSelect>
                    </div>
                  </div>
                </>
              )}
              <p className={styles.helper}>
                {dataRequirements.participants.guestFields.length === 0
                  ? 'La IA no pedirá teléfonos, correos ni apellidos de invitados por su cuenta.'
                  : 'La IA pide únicamente los datos marcados para cada titular distinto o invitado.'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function getProviderStatus(aiProviders: ConversationalAIProviderStatus[], providerId: ConversationalAIProviderId) {
  return aiProviders.find((provider) => provider.id === providerId) || null
}

const AgentCard: React.FC<AgentCardProps> = ({ agent, aiProviders, calendars, products, productsLoading, productsError, canUsePaymentLinks, filterOptions, onConnectProvider, onBack, onChange, onFlushSave, onDelete }) => {
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
  const [testOptionsOpen, setTestOptionsOpen] = useState(false)
  const [testContact, setTestContact] = useState<ContactSearchInputContact | null>(null)
  const [testing, setTesting] = useState(false)
  const [testVoiceRecording, setTestVoiceRecording] = useState(false)
  const [testVoiceProcessing, setTestVoiceProcessing] = useState(false)
  const [testVoiceDraft, setTestVoiceDraft] = useState<TestAttachment | null>(null)
  const [testVoiceElapsedMs, setTestVoiceElapsedMs] = useState(0)
  const [testVoicePlaying, setTestVoicePlaying] = useState(false)
  const [testVoiceBars, setTestVoiceBars] = useState(() => createTestVoiceBars())
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  const [teamUsersLoading, setTeamUsersLoading] = useState(false)
  const [testRunHistory, setTestRunHistory] = useState<ConversationalAgentTestRunHistory[]>([])
  const [testRunHistoryLoading, setTestRunHistoryLoading] = useState(false)
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
  const testingRef = useRef(false)
  const testRequestOwnerRef = useRef<string | null>(null)
  const testMessagesRef = useRef<TestMessage[]>([])
  const testSessionIdRef = useRef(createTestTrackingId('session'))
  const activeTestRunIdRef = useRef<string | null>(null)
  const handledTestPaymentEventsRef = useRef<Set<string>>(new Set())
  const announcedTestPaymentEventsRef = useRef<Set<string>>(new Set())
  const testPaymentResumeMessageIdsRef = useRef<Map<string, string>>(new Map())
  const testPaymentResumeTranscriptsRef = useRef<Map<string, TestMessage[]>>(new Map())
  const testPaymentResumeErrorsRef = useRef<Set<string>>(new Set())
  const testPaymentResumeInFlightRef = useRef(false)
  const testRunHistoryRequestRef = useRef(0)
  const testAgentRef = useRef(agent)
  testAgentRef.current = agent

  const refreshTestRunHistory = useCallback(async ({ loading = false }: { loading?: boolean } = {}) => {
    const requestId = testRunHistoryRequestRef.current + 1
    testRunHistoryRequestRef.current = requestId
    if (loading) setTestRunHistoryLoading(true)
    try {
      const runs = await conversationalAgentService.listAgentTestRuns(agent.id, 10)
      if (testRunHistoryRequestRef.current !== requestId) return
      setTestRunHistory(runs)
    } catch {
      // El historial no bloquea el tester. Conservamos la última lectura visible.
    } finally {
      if (loading && testRunHistoryRequestRef.current === requestId) setTestRunHistoryLoading(false)
    }
  }, [agent.id])

  const rotateTestSessionIdentity = useCallback(() => {
    const nextSessionId = createTestTrackingId('session')
    activeTestRunIdRef.current = null
    testSessionIdRef.current = nextSessionId
    handledTestPaymentEventsRef.current.clear()
    announcedTestPaymentEventsRef.current.clear()
    testPaymentResumeMessageIdsRef.current.clear()
    testPaymentResumeTranscriptsRef.current.clear()
    testPaymentResumeErrorsRef.current.clear()
    return nextSessionId
  }, [])

  const cleanupActiveTestRun = useCallback(() => {
    const testRunId = activeTestRunIdRef.current
    activeTestRunIdRef.current = null
    handledTestPaymentEventsRef.current.clear()
    announcedTestPaymentEventsRef.current.clear()
    testPaymentResumeMessageIdsRef.current.clear()
    testPaymentResumeTranscriptsRef.current.clear()
    testPaymentResumeErrorsRef.current.clear()
    if (!testRunId) return
    void conversationalAgentService.cleanupTestRun(testRunId)
      .then(() => refreshTestRunHistory())
      .catch(() => undefined)
  }, [refreshTestRunHistory])

  useEffect(() => {
    void refreshTestRunHistory({ loading: true })
    const timer = window.setInterval(() => void refreshTestRunHistory(), 5000)
    return () => window.clearInterval(timer)
  }, [refreshTestRunHistory])

  useEffect(() => () => {
    cleanupTestVoiceRecorder()
  }, [])

  useEffect(() => {
    testPracticeExpiredRef.current = testPracticeExpired
  }, [testPracticeExpired])

  useEffect(() => {
    testMessagesRef.current = testMessages
  }, [testMessages])

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
  const accountCurrency = normalizeCurrencyCode(accountCurrencyConfig || detectedLocaleDefaults.currency)
  const publishValidationError = getAgentValidationError({ ...agent, enabled: true }, accountCurrency)
  const entryCount = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
  const exitCount = agent.filters.exit.groups.reduce((total, group) => total + group.conditions.length, 0)
  const responseDelay = getAgentResponseDelay(agent)
  const responseDelaySummary = getResponseDelaySummary(responseDelay)
  const replyDelivery = getAgentReplyDelivery(agent)
  const humanMessagesEnabled = replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split'
  const followUp = getAgentFollowUp(agent)
  const followUpSummary = getFollowUpSummary(followUp)
  const responseDelayError = getResponseDelayError(responseDelay)
  const replyDeliveryError = getReplyDeliveryError(replyDelivery)
  const followUpError = getFollowUpError(followUp)
  const testVoicePanelActive = testVoiceRecording || testVoiceProcessing || Boolean(testVoiceDraft)
  const hasTestConversation = testPracticeExpired || testMessages.length > 0 || Boolean(testInput.trim()) || testAttachments.length > 0 || Boolean(testVoiceDraft) || testVoiceRecording
  const storedTestPaymentCapability = getNativeCapability(agent.capabilitiesConfig, 'collect_payment')
  const testPaymentCapability = storedTestPaymentCapability && !canUsePaymentLinks
    ? {
        ...buildNativeCapabilityFromAgent(agent, 'collect_payment', calendars, accountCurrency, false),
        enabled: storedTestPaymentCapability.enabled
      } as Extract<ConversationalCapabilityItem, { id: 'collect_payment' }>
    : storedTestPaymentCapability
  const testScheduleCapability = getNativeCapability(agent.capabilitiesConfig, 'schedule_appointment')
  const testAiScheduleCapabilityEnabled = Boolean(
    testScheduleCapability?.enabled && testScheduleCapability.bookingOwner !== 'human'
  )
  const testHumanScheduleCapabilityEnabled = Boolean(
    testScheduleCapability?.enabled && testScheduleCapability.bookingOwner === 'human'
  )
  const scheduleTestModeEnabled = Boolean(testScheduleCapability?.enabled && testScheduleCapability.testMode?.enabled)
  const paymentTestModeConfigured = Boolean(testPaymentCapability?.enabled && testPaymentCapability.testMode?.enabled)
  const paymentTestModeEnabled = Boolean(
    paymentTestModeConfigured && !(
      testPaymentCapability?.collectionMethod === 'payment_link' &&
      testPaymentCapability?.gateway === 'highlevel'
    )
  )
  const testPaymentWebhookEnabled = Boolean(
    paymentTestModeEnabled && testPaymentCapability?.collectionMethod === 'payment_link'
  )
  const testAssignmentCapabilityEnabled = Boolean(testHumanScheduleCapabilityEnabled && testScheduleCapability?.handoffUserId)
  const testEffectsEnabled = scheduleTestModeEnabled || paymentTestModeEnabled
  const effectiveTestEffects: ConversationalAgentTestEffects = {
    enabled: testEffectsEnabled,
    // Agenda humana también necesita una corrida real cuando el dueño eligió
    // "avisar al equipo sin asignar". El efecto de agenda valida el horario y
    // notifica; la asignación temporal sólo existe si hay una persona concreta.
    scheduleAppointment: scheduleTestModeEnabled && Boolean(testScheduleCapability?.enabled),
    // Tanto el link sandbox como la lectura real de un comprobante necesitan una
    // corrida durable de prueba. Sólo el link espera después un webhook.
    collectPayment: paymentTestModeEnabled,
    assignUser: scheduleTestModeEnabled && testAssignmentCapabilityEnabled,
    notifyOwner: Boolean(
      (scheduleTestModeEnabled && testScheduleCapability?.testMode?.notify !== false) ||
      (paymentTestModeEnabled && testPaymentCapability?.testMode?.notify !== false)
    )
  }
  const expectsTestRun = Boolean(
    effectiveTestEffects.scheduleAppointment ||
    effectiveTestEffects.collectPayment ||
    effectiveTestEffects.assignUser
  )
  const recentTestEffects = testRunHistory
    .flatMap((run) => [...run.effects].reverse().map((effect) => ({ runId: run.id, effect })))
    .slice(0, 20)

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
    const requestStillInFlight = Boolean(testRequestOwnerRef.current || testingRef.current)
    cleanupTestVoiceRecorder()
    testVoiceAudioRef.current?.pause()
    setTestMessages([])
    setTestInput('')
    setTestAttachments([])
    setTestAttachmentMenuOpen(false)
    setTestEmojiPickerOpen(false)
    // Expirar los adjuntos invalida el render, pero no cancela mágicamente el
    // HTTP que ya está vivo. Conservamos su ownership hasta el finally para que
    // Reiniciar/cambiar contacto no deje entrar una respuesta vieja al chat nuevo.
    setTesting(requestStillInFlight)
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

  async function renderTestAgentResult(
    result: ConversationalAgentTestResult,
    {
      includeResponseDelay = true,
      shouldContinue,
      messageKeyPrefix = ''
    }: { includeResponseDelay?: boolean; shouldContinue?: () => boolean; messageKeyPrefix?: string } = {}
  ) {
    const canContinue = () => !testPracticeExpiredRef.current && (shouldContinue ? shouldContinue() : true)
    const appendMessage = (message: TestMessage, suffix: string) => {
      const deliveryKey = messageKeyPrefix ? `${messageKeyPrefix}:${suffix}` : ''
      setTestMessages((current) => (
        deliveryKey && current.some((item) => item.deliveryKey === deliveryKey)
          ? current
          : [...current, {
              ...message,
              id: message.id || createTestTrackingId('transcript'),
              ...(deliveryKey ? { deliveryKey } : {})
            }]
      ))
    }
    const responseDelayMs = includeResponseDelay ? normalizeTestResponseDelay(result.responseDelayMs) : 0
    if (responseDelayMs > 0) await waitForTestReplyDelay(responseDelayMs)
    if (!canContinue()) return false

    for (const [index, action] of (result.actions || []).entries()) {
      if (!canContinue()) return false
      const actionMessage = describeConversationalPreviewAction(action)
      if (!actionMessage) continue
      appendMessage(
        { role: 'assistant', content: actionMessage, internal: true },
        `action-${index}`
      )
    }

    for (const [index, effect] of (result.testEffects || []).entries()) {
      if (!canContinue()) return false
      appendMessage(
        { role: 'assistant', content: describeTestEffectResult(effect), internal: true },
        `effect-${effect.id || index}`
      )
    }

    const visibleReplies = result.replyParts?.length ? result.replyParts : (result.reply ? [result.reply] : [])
    if (visibleReplies.length) {
      for (let index = 0; index < visibleReplies.length; index += 1) {
        const delayMs = normalizeTestReplyDelay(result.replyPartDelaysMs?.[index])
        if (index > 0 && delayMs > 0) await waitForTestReplyDelay(delayMs)
        if (!canContinue()) return false
        appendMessage({ role: 'assistant', content: visibleReplies[index] }, `reply-${index}`)
      }
      return true
    }
    if (!canContinue()) return false
    appendMessage(
      { role: 'assistant', content: '⚠︎ La prueba no devolvió una respuesta válida. Vuelve a intentarlo.', internal: true },
      'invalid-reply'
    )
    return true
  }

  async function submitTestMessage(input: { content?: string; attachments?: TestAttachment[]; clearComposer?: boolean }) {
    const content = String(input.content ?? '').trim()
    const attachments = input.attachments || []
    if (testPracticeExpired || testing || testingRef.current || (!content && attachments.length === 0)) return
    if (expectsTestRun && !testContact?.id) {
      setTestOptionsOpen(true)
      showToast('warning', 'Elige un contacto de prueba', 'Lo necesitamos para ligar las validaciones al hilo correcto sin adivinar identidades.')
      return
    }

    const now = Date.now()
    if (attachments.some((attachment) => testAttachmentExpired(attachment, now)) || testMessages.some((message) => testMessageHasExpiredAttachment(message, now))) {
      expireTestPracticeMedia()
      return
    }

    const userMessage: TestMessage = {
      id: createTestTrackingId('transcript'),
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
    // React actualiza `testing` en el siguiente render. El ref se cierra de
    // inmediato para que Enter + submit/click en el mismo frame no disparen dos
    // HTTP con el mismo mensaje; el backend conserva además el fence durable.
    const requestOwnerToken = `submit:${userMessage.id}`
    testRequestOwnerRef.current = requestOwnerToken
    testingRef.current = true
    setTesting(true)

    try {
      const agentForTest = await onFlushSave()
      const effectiveAgent = agentForTest || agent
      const payloadMessages = nextMessages.map(toTestPayloadMessage)
      const runTestRequest = (testSessionId: string, testMessageId: string) => conversationalAgentService.testAgent(
        payloadMessages,
        {
          config: agentToInput(effectiveAgent),
          agentId: effectiveAgent.id,
          testSessionId,
          testMessageId,
          ...(expectsTestRun && testContact?.id ? { contactId: testContact.id } : {}),
          effects: effectiveTestEffects
        }
      )
      let requestSessionId = testSessionIdRef.current
      let requestMessageId = createTestTrackingId('message')
      if (expectsTestRun) activeTestRunIdRef.current = requestSessionId
      let result: ConversationalAgentTestResult
      try {
        result = await runTestRequest(requestSessionId, requestMessageId)
      } catch (error) {
        if (expectsTestRun && shouldRetrySameTestTurn(error)) {
          // Si se perdió la respuesta HTTP o el dueño sigue cerrando efectos,
          // reconsultamos exactamente el mismo turno. El ledger devuelve el
          // response guardado y jamás vuelve a crear la cita.
          result = await runTestRequest(requestSessionId, requestMessageId)
        } else {
          if (!expectsTestRun || !shouldRotateClosedTestRun(error)) throw error
          // El cleanup automático cerró una corrida anterior. Repetimos una sola
          // vez el MISMO transcript y configuración, pero con identidades nuevas,
          // para no perder ni duplicar el mensaje visible del usuario.
          requestSessionId = rotateTestSessionIdentity()
          requestMessageId = createTestTrackingId('message')
          activeTestRunIdRef.current = requestSessionId
          result = await runTestRequest(requestSessionId, requestMessageId)
        }
      }
      if (result.testRunId) activeTestRunIdRef.current = result.testRunId
      else if (expectsTestRun) activeTestRunIdRef.current = null

      await renderTestAgentResult(result, {
        shouldContinue: () => (
          testRequestOwnerRef.current === requestOwnerToken &&
          testSessionIdRef.current === requestSessionId
        ),
        messageKeyPrefix: `submit-${requestMessageId}`
      })
      if (result.testRunId || result.testEffects?.length) void refreshTestRunHistory()
    } catch (error: any) {
      if (
        activeTestRunIdRef.current === testSessionIdRef.current &&
        !shouldRetrySameTestTurn(error)
      ) {
        cleanupActiveTestRun()
        testSessionIdRef.current = createTestTrackingId('session')
      }
      if (!testPracticeExpiredRef.current) {
        showToast('error', 'Prueba fallida', error?.message || 'No se pudo probar el agente')
      }
    } finally {
      if (testRequestOwnerRef.current === requestOwnerToken) {
        testRequestOwnerRef.current = null
        testingRef.current = false
        setTesting(false)
      }
    }
  }

  useEffect(() => {
    if (!testEffectsEnabled || !testPaymentWebhookEnabled || testPracticeExpired) return
    let cancelled = false

    const pollVerifiedPayment = async () => {
      const testRunId = activeTestRunIdRef.current
      if (!testRunId || testingRef.current || testPaymentResumeInFlightRef.current || !testContact?.id) return
      const paymentContactId = testContact.id
      let claimedPaymentEffectId = ''
      let requestOwnerToken = ''
      let ownsPaymentResume = false
      try {
        const effects = await conversationalAgentService.listTestRunEffects(testRunId)
        setTestRunHistory((current) => current.map((run) => (
          run.id === testRunId ? { ...run, effects } : run
        )))
        const paidEffects = effects.filter((effect) => (
          effect.type === 'payment' && effect.status === 'paid_test' && effect.id
        ))
        const pendingEffect = paidEffects.find((effect) => (
          typeof effect.id === 'string' && !handledTestPaymentEventsRef.current.has(effect.id)
        ))
        // Otro envío pudo adquirir el mutex mientras esperábamos la bitácora.
        // Volvemos a comprobar después del await antes de tocar transcript/IA.
        if (!pendingEffect || cancelled || testingRef.current || testRequestOwnerRef.current) return

        claimedPaymentEffectId = String(pendingEffect.id)
        requestOwnerToken = `payment-resume:${claimedPaymentEffectId}`
        testRequestOwnerRef.current = requestOwnerToken
        testingRef.current = true
        testPaymentResumeInFlightRef.current = true
        ownsPaymentResume = true
        setTesting(true)
        if (!announcedTestPaymentEventsRef.current.has(claimedPaymentEffectId)) {
          announcedTestPaymentEventsRef.current.add(claimedPaymentEffectId)
          setTestMessages((current) => [
            ...current,
            { role: 'assistant', content: 'Pago sandbox confirmado por webhook. La IA continúa desde ese hecho real.', internal: true }
          ])
        }

        const transcript = testPaymentResumeTranscriptsRef.current.get(claimedPaymentEffectId) ||
          testMessagesRef.current.filter((message) => !message.internal)
        if (!transcript.length) return
        testPaymentResumeTranscriptsRef.current.set(claimedPaymentEffectId, transcript)
        const resumeMessageId = testPaymentResumeMessageIdsRef.current.get(claimedPaymentEffectId) ||
          `agent-test-message-payment-resume-${claimedPaymentEffectId}`.slice(0, 160)
        testPaymentResumeMessageIdsRef.current.set(claimedPaymentEffectId, resumeMessageId)
        const effectiveAgent = testAgentRef.current
        const result = await conversationalAgentService.testAgent(
          transcript.map(toTestPayloadMessage),
          {
            config: agentToInput(effectiveAgent),
            agentId: effectiveAgent.id,
            testSessionId: testRunId,
            testMessageId: resumeMessageId,
            contactId: paymentContactId,
            effects: effectiveTestEffects
          }
        )
        if (cancelled) return
        if (result.testRunId) activeTestRunIdRef.current = result.testRunId
        const rendered = await renderTestAgentResult(result, {
          includeResponseDelay: false,
          shouldContinue: () => (
            !cancelled &&
            testRequestOwnerRef.current === requestOwnerToken &&
            activeTestRunIdRef.current === testRunId &&
            testContact?.id === paymentContactId
          ),
          messageKeyPrefix: `payment-resume-${claimedPaymentEffectId}`
        })
        if (!rendered || cancelled || testPracticeExpiredRef.current) return
        handledTestPaymentEventsRef.current.add(claimedPaymentEffectId)
        testPaymentResumeErrorsRef.current.delete(claimedPaymentEffectId)
        void refreshTestRunHistory()
      } catch (error: any) {
        if (
          claimedPaymentEffectId &&
          !cancelled &&
          !testPaymentResumeErrorsRef.current.has(claimedPaymentEffectId)
        ) {
          testPaymentResumeErrorsRef.current.add(claimedPaymentEffectId)
          showToast('error', 'Continuación pendiente', error?.message || 'El pago sí quedó detectado. Reconciliamos la misma continuación sin duplicarla.')
        }
      } finally {
        if (ownsPaymentResume) testPaymentResumeInFlightRef.current = false
        if (requestOwnerToken && testRequestOwnerRef.current === requestOwnerToken) {
          testRequestOwnerRef.current = null
          testingRef.current = false
          if (!cancelled) setTesting(false)
        }
      }
    }

    void pollVerifiedPayment()
    const timer = window.setInterval(() => void pollVerifiedPayment(), 2000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [
    agent.id,
    effectiveTestEffects.assignUser,
    effectiveTestEffects.collectPayment,
    effectiveTestEffects.enabled,
    effectiveTestEffects.notifyOwner,
    effectiveTestEffects.scheduleAppointment,
    testPaymentWebhookEnabled,
    showToast,
    refreshTestRunHistory,
    testContact?.id,
    testEffectsEnabled,
    testPracticeExpired
  ])

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
    if (testingRef.current || testRequestOwnerRef.current) return false
    cleanupActiveTestRun()
    testSessionIdRef.current = createTestTrackingId('session')
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
    return true
  }

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
            >
              {agent.enabled ? <Pause size={16} /> : <Play size={16} />}
              {agent.enabled ? 'Pausar' : 'Publicar'}
            </Button>
          </div>
        </div>

        {!agent.enabled && publishValidationError && (
          <div className={styles.agentPublishNotice} role="status" aria-live="polite">
            <AlertTriangle size={16} />
            <span><strong>Antes de publicar:</strong> {publishValidationError}</span>
          </div>
        )}

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
            {(agent.capabilitiesConfig?.items || []).filter((item) => item.enabled).length} capacidades activas · herramientas protegidas
            {entryCount > 0
              ? ` · entra con ${entryCount} ${entryCount === 1 ? 'regla' : 'reglas'}`
              : ' · entra con cualquier chat'}
            {exitCount > 0 ? ` · se suelta con ${exitCount}` : ''}
            {responseDelaySummary ? ` · espera ${responseDelaySummary}` : ''}
            {replyDelivery.splitMessagesEnabled || replyDelivery.mode === 'split' ? ' · responde en partes' : ''}
            {followUpSummary ? ` · ${followUpSummary}` : ''}
          </p>

          <NativeConversationBuilder
            agent={agent}
            calendars={calendars}
            products={products}
            productsLoading={productsLoading}
            productsError={productsError}
            teamUsers={teamUsers}
            teamUsersLoading={teamUsersLoading}
            accountCurrency={accountCurrency}
            canUsePaymentLinks={canUsePaymentLinks}
            onChange={onChange}
            onFlushSave={onFlushSave}
          />

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>3. Operación técnica del chat</h3>
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

          <div className={styles.agentSection}>
            <h3 className={styles.sectionTitle}>4. Entrada y salida</h3>
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
            subtitle={expectsTestRun ? 'Registro de prueba activo' : 'Simulación segura'}
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
            moreOptionsAction={{
              id: 'test-options',
              label: 'Más opciones de prueba',
              onClick: () => setTestOptionsOpen(true),
              disabled: testing
            }}
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
          <Modal
            isOpen={testOptionsOpen}
            onClose={() => setTestOptionsOpen(false)}
            title="Opciones de la prueba"
            subtitle={expectsTestRun
              ? 'Modo test activo: las tools configuradas se ejecutan de forma real y aislada.'
              : 'El teléfono sólo simula esta conversación y no modifica nada.'}
            size="md"
          >
            <div className={styles.agentTestOptions}>
              <div className={styles.agentTestModeSummary} data-effects-enabled={expectsTestRun ? 'true' : undefined}>
                <strong>{expectsTestRun ? 'Registro controlado' : 'Simulación segura'}</strong>
                <span>{expectsTestRun
                  ? 'Las acciones se marcan como prueba y se limpian automáticamente después de 5 minutos.'
                  : 'La IA conversa y muestra lo que haría, pero no crea citas, cobros ni notificaciones.'}</span>
              </div>

              {expectsTestRun && (
                <>
                  <ContactSearchInput
                    value={testContact}
                    onChange={(contact) => {
                      if (contact?.id !== testContact?.id && !handleResetTestChat()) return
                      setTestContact(contact)
                    }}
                    label="Contacto de prueba"
                    placeholder="Buscar contacto existente"
                    required
                    allowCreate={false}
                    error={!testContact ? 'Elige el contacto que recibirá las acciones de esta prueba.' : undefined}
                    disabled={testing || Boolean(testRequestOwnerRef.current)}
                    portal
                  />

                  <div className={styles.agentTestEffectList}>
                    {scheduleTestModeEnabled && testAiScheduleCapabilityEnabled && (
                      <div className={styles.agentTestOptionSwitch}>
                        <span>
                          <strong>Cita real de prueba</strong>
                          <small>La IA agenda en el calendario elegido, dispara notificaciones y la cita se elimina después de 5 minutos.</small>
                        </span>
                        <Badge variant="info">Activa</Badge>
                      </div>
                    )}

                    {scheduleTestModeEnabled && testHumanScheduleCapabilityEnabled && (
                      <div className={styles.agentTestOptionSwitch}>
                        <span>
                          <strong>Agenda confirmada por humano</strong>
                          <small>{testScheduleCapability?.handoffUserId
                            ? 'La IA valida el horario, asigna temporalmente la solicitud a la persona configurada y después restaura al responsable anterior.'
                            : 'La IA valida el horario y avisa al equipo sin asignar a una persona; no crea ni modifica la cita.'}</small>
                        </span>
                        <Badge variant={testScheduleCapability?.handoffUserId ? 'info' : 'neutral'}>
                          {testScheduleCapability?.handoffUserId ? 'Asignación activa' : 'Sin asignar'}
                        </Badge>
                      </div>
                    )}

                    {paymentTestModeEnabled && (
                      <div className={styles.agentTestOptionSwitch}>
                        <span>
                          <strong>{testPaymentCapability?.collectionMethod === 'bank_transfer' ? 'Comprobante de transferencia' : 'Pago sandbox'}</strong>
                          <small>{testPaymentCapability?.collectionMethod === 'bank_transfer'
                            ? 'Lee y comprueba de verdad la imagen; queda pendiente de revisión y nunca confirma dinero.'
                            : 'Genera un link de prueba, escucha el webhook y nunca usa credenciales en vivo como respaldo.'}</small>
                        </span>
                        <Badge variant="info">
                          {testPaymentCapability?.collectionMethod === 'bank_transfer' ? 'Lectura real' : 'Activo'}
                        </Badge>
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className={styles.agentTestEffectList} aria-label="Historial reciente de pruebas">
                <div className={styles.agentTestOptionSwitch}>
                  <span>
                    <strong>Historial reciente</strong>
                    <small>Se carga desde el registro real del servidor y conserva hasta las últimas 20 acciones de este agente.</small>
                  </span>
                  {testRunHistoryLoading ? <Badge variant="neutral">Cargando</Badge> : null}
                </div>
                {recentTestEffects.length ? recentTestEffects.map(({ runId, effect }) => {
                  const state = getTestEffectHistoryState(effect)
                  return (
                    <div key={`${runId}-${effect.id || effect.type}`} className={styles.agentTestOptionSwitch}>
                      <span>
                        <strong>{describeTestEffectResult(effect)}</strong>
                        <small>{effect.cleanupStatus === 'cleaned' || effect.status === 'cleaned'
                          ? 'La limpieza automática de 5 minutos ya terminó.'
                          : 'Registro persistido de la ejecución de prueba.'}</small>
                      </span>
                      <Badge variant={state.variant}>{state.label}</Badge>
                    </div>
                  )
                }) : (
                  <p className={styles.helper}>{testRunHistoryLoading ? 'Consultando pruebas anteriores…' : 'Todavía no hay acciones de prueba registradas para este agente.'}</p>
                )}
              </div>

              {!testEffectsEnabled && (
                <p className={styles.helper}>Activa el switch de prueba dentro de Agendar cita o Cobrar para probar únicamente esa capacidad.</p>
              )}
              {testEffectsEnabled && !expectsTestRun && (
                <p className={styles.helper}>
                  {testHumanScheduleCapabilityEnabled
                    ? 'La agenda la termina una persona. Sin responsable asignado, el tester muestra el handoff pero no crea citas ni hace una asignación real.'
                    : 'El switch de prueba está activo, pero esta configuración no tiene una acción real que ejecutar. La conversación sigue siendo una simulación.'}
                </p>
              )}

              <div className={styles.agentTestOptionsActions}>
                <Button variant="primary" onClick={() => setTestOptionsOpen(false)} disabled={expectsTestRun && !testContact}>
                  Listo
                </Button>
              </div>
            </div>
          </Modal>
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
  const { showToast, showConfirm } = useNotification()
  const openAIAvailability = useAIAgentAvailability()
  const [config, setConfig] = useState<ConversationalAgentConfig | null>(null)
  const [agents, setAgents] = useState<ConversationalAgentDef[]>([])
  const [aiProviders, setAIProviders] = useState<ConversationalAIProviderStatus[]>([])
  const [metrics, setMetrics] = useState<ConversationalAgentMetrics | null>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [products, setProducts] = useState<ProductItem[]>([])
  const [productsLoading, setProductsLoading] = useState(false)
  const [productsError, setProductsError] = useState('')
  const [filterOptions, setFilterOptions] = useState<AgentFilterOptions | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [resettingAgentSkipsId, setResettingAgentSkipsId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => routeAgentId || null)
  const [providerModalId, setProviderModalId] = useState<ConversationalAIProviderId | null>(null)
  const [aiProvidersExpanded, setAIProvidersExpanded] = useState(false)
  const [providerApiKey, setProviderApiKey] = useState('')
  const [providerSaving, setProviderSaving] = useState(false)
  const [activationConflict, setActivationConflict] = useState<AgentActivationConflictModalState | null>(null)
  const saveTimersRef = useRef<Map<string, number>>(new Map())
  const saveQueuesRef = useRef<Map<string, Promise<ConversationalAgentDef | null>>>(new Map())
  const saveRevisionsRef = useRef<Map<string, number>>(new Map())
  const agentMutationVersionsRef = useRef<Map<string, number>>(new Map())
  const dirtyAgentIdsRef = useRef<Set<string>>(new Set())
  const pendingEnabledOverridesRef = useRef<Map<string, boolean>>(new Map())
  const deletedAgentIdsRef = useRef<Set<string>>(new Set())
  const mountedRef = useRef(true)
  const saveAgentNowRef = useRef<(
    agentId: string,
    options?: { notify?: boolean; enabled?: boolean }
  ) => Promise<ConversationalAgentDef | null>>(async () => null)
  const agentsRef = useRef<ConversationalAgentDef[]>([])
  const businessProfileVersion = [
    openAIAvailability.businessProfile?.updatedAt || '',
    openAIAvailability.businessProfile?.extractionStatus || openAIAvailability.businessProfile?.status || '',
    openAIAvailability.businessProfile?.businessName || '',
    openAIAvailability.businessProfile?.industry || ''
  ].join('|')
  agentsRef.current = agents

  const applyServerAgentsPreservingDrafts = useCallback((
    serverAgents: ConversationalAgentDef[],
    versionsAtRequestStart = new Map<string, number>()
  ) => {
    const dirtyIds = dirtyAgentIdsRef.current
    const deletedIds = deletedAgentIdsRef.current
    const localById = new Map(agentsRef.current.map((agent) => [agent.id, agent]))
    const filteredServerAgents = serverAgents.filter((agent) => !deletedIds.has(agent.id))
    const serverIds = new Set(filteredServerAgents.map((agent) => agent.id))
    const merged = filteredServerAgents.flatMap((agent) => {
      const changedSinceRequest = dirtyIds.has(agent.id) ||
        (agentMutationVersionsRef.current.get(agent.id) || 0) !== (versionsAtRequestStart.get(agent.id) || 0)
      if (!changedSinceRequest) return [agent]
      const local = localById.get(agent.id)
      // Si cambió desde que arrancó el request y ya no existe localmente, fue
      // eliminado: una respuesta vieja jamás debe resucitarlo en la interfaz.
      return local ? [local] : []
    })
    for (const [localId, local] of localById) {
      const changedSinceRequest = (agentMutationVersionsRef.current.get(localId) || 0) !== (versionsAtRequestStart.get(localId) || 0)
      if ((dirtyIds.has(localId) || changedSinceRequest) && !serverIds.has(localId)) merged.push(local)
    }
    agentsRef.current = merged
    setAgents(merged)
  }, [])

  const refreshMetrics = useCallback(async () => {
    try {
      const nextMetrics = await conversationalAgentService.getMetrics()
      setMetrics(nextMetrics)
    } catch {
      // La configuración sigue funcionando; las métricas se reintentan al recargar.
    }
  }, [])

  const refreshAgentData = useCallback(async () => {
    const versionsAtRequestStart = new Map(agentMutationVersionsRef.current)
    const [nextConfig, nextAgents, nextProviders] = await Promise.all([
      conversationalAgentService.getConfig(),
      conversationalAgentService.listAgents(),
      conversationalAgentService.listAIProviders()
    ])
    setConfig(nextConfig)
    applyServerAgentsPreservingDrafts(nextAgents, versionsAtRequestStart)
    setAIProviders(nextConfig.aiProviders || nextProviders)
  }, [applyServerAgentsPreservingDrafts])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const versionsAtRequestStart = new Map(agentMutationVersionsRef.current)
      setLoading(true)
      setProductsLoading(true)
      try {
        const [nextConfig, nextAgents, nextProviders, nextMetrics, calendarList, productsResponse, nextOptions] = await Promise.all([
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
          })
            .then((data) => ({ data, error: '' }))
            .catch((error: any) => ({
              data: null,
              error: error?.message || 'No se pudo cargar el catálogo de productos. Recarga la página o usa Anticipo.'
            })),
          conversationalAgentService.getFilterOptions().catch(() => undefined)
        ])
        if (cancelled) return
        setConfig(nextConfig)
        applyServerAgentsPreservingDrafts(nextAgents, versionsAtRequestStart)
        setAIProviders(nextConfig.aiProviders || nextProviders)
        setMetrics(nextMetrics)
        setCalendars(calendarList.filter((cal) => cal.isActive !== false))
        setProducts(Array.isArray(productsResponse.data?.products)
          ? productsResponse.data.products.filter((product) => getProductId(product))
          : [])
        setProductsError(productsResponse.error)
        setFilterOptions(nextOptions)
      } catch (error: any) {
        if (!cancelled) {
          showToast('error', 'Error', error?.message || 'No se pudo cargar Chatbot')
        }
      } finally {
        if (!cancelled) {
          setProductsLoading(false)
          setLoading(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [applyServerAgentsPreservingDrafts, businessProfileVersion, showToast])

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

  const saveAgentNow = useCallback((
    agentId: string,
    options: { notify?: boolean; enabled?: boolean } = {}
  ): Promise<ConversationalAgentDef | null> => {
    const timers = saveTimersRef.current
    const existing = timers.get(agentId)
    if (existing) {
      window.clearTimeout(existing)
      timers.delete(agentId)
    }

    const queues = saveQueuesRef.current
    const queued = queues.get(agentId)
    if (
      !dirtyAgentIdsRef.current.has(agentId) &&
      options.enabled === undefined &&
      !pendingEnabledOverridesRef.current.has(agentId)
    ) {
      return queued || Promise.resolve(agentsRef.current.find((item) => item.id === agentId) || null)
    }

    const operation = (queued || Promise.resolve(null))
      .catch(() => null)
      .then(async () => {
        if (
          !dirtyAgentIdsRef.current.has(agentId) &&
          options.enabled === undefined &&
          !pendingEnabledOverridesRef.current.has(agentId)
        ) {
          return agentsRef.current.find((item) => item.id === agentId) || null
        }

        const currentAgent = agentsRef.current.find((item) => item.id === agentId)
        if (!currentAgent) {
          pendingEnabledOverridesRef.current.delete(agentId)
          return null
        }
        const effectiveEnabled = options.enabled ?? pendingEnabledOverridesRef.current.get(agentId)
        const agent = effectiveEnabled === undefined
          ? currentAgent
          : ({ ...currentAgent, enabled: effectiveEnabled } as ConversationalAgentDef)
        const requestRevision = saveRevisionsRef.current.get(agentId) || 0
        const validationError = getAgentValidationError(agent)
        if (validationError) {
          if (options.notify !== false) {
            showToast('warning', 'Revisa el agente', validationError)
          }
          // Publicar puede fallar porque el borrador todavía está incompleto,
          // pero ese borrador sí debe persistirse en pausa. Lo encolamos detrás
          // de este intento antes de devolver el error visible.
          if (effectiveEnabled !== undefined && dirtyAgentIdsRef.current.has(agentId)) {
            void saveAgentNowRef.current(agentId, { notify: false }).catch(() => undefined)
          }
          throw new Error(validationError)
        }

        try {
          const next = await conversationalAgentService.updateAgent(agentId, agentToInput(agent))
          agentMutationVersionsRef.current.set(
            agentId,
            (agentMutationVersionsRef.current.get(agentId) || 0) + 1
          )
          const revisionUnchanged = (saveRevisionsRef.current.get(agentId) || 0) === requestRevision
          if (revisionUnchanged) {
            dirtyAgentIdsRef.current.delete(agentId)
            if (pendingEnabledOverridesRef.current.get(agentId) === effectiveEnabled) {
              pendingEnabledOverridesRef.current.delete(agentId)
            }
            const pendingRetry = timers.get(agentId)
            if (pendingRetry) window.clearTimeout(pendingRetry)
            timers.delete(agentId)
          }

          const latestAgents = agentsRef.current
          const latestAgent = latestAgents.find((item) => item.id === agentId)
          const localNext = revisionUnchanged
            ? next
            : (effectiveEnabled === undefined
                ? latestAgent
                : ({ ...next, ...latestAgent, enabled: next.enabled } as ConversationalAgentDef))
          if (localNext) {
            const nextAgents = latestAgents.map((item) => (item.id === agentId ? localNext : item))
            agentsRef.current = nextAgents
            if (mountedRef.current) setAgents(nextAgents)
          }
          return next
        } catch (error: any) {
          const stillDirty = dirtyAgentIdsRef.current.has(agentId)
          if (isConversationalAgentEntryConflictError(error)) {
            if (mountedRef.current) {
              setActivationConflict({
                message: error.message,
                conflicts: error.conflicts || []
              })
            }
            if (!stillDirty && (saveRevisionsRef.current.get(agentId) || 0) === requestRevision) {
              await refreshAgentData().catch(() => undefined)
            }
          } else if (options.notify !== false) {
            showToast('error', 'No se pudo guardar', error?.message || 'Revisa la configuración del agente')
          }

          // Un fallo transitorio no convierte el borrador en "guardado". Si la
          // pantalla sigue abierta, lo reintentamos en orden y sin pisar texto.
          if (stillDirty && mountedRef.current && !timers.has(agentId)) {
            timers.set(agentId, window.setTimeout(() => {
              timers.delete(agentId)
              void saveAgentNowRef.current(agentId, { notify: false }).catch(() => undefined)
            }, AUTOSAVE_DELAY_MS * 2))
          }
          throw error
        }
      })

    queues.set(agentId, operation)
    void operation.finally(() => {
      if (queues.get(agentId) === operation) queues.delete(agentId)
    }).catch(() => undefined)
    return operation
  }, [refreshAgentData, showToast])

  saveAgentNowRef.current = saveAgentNow

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const timers = saveTimersRef.current
      const pendingAgentIds = new Set([...timers.keys(), ...dirtyAgentIdsRef.current])
      timers.forEach((timer) => window.clearTimeout(timer))
      timers.clear()
      // Navegar no se come los últimos 900 ms: el cierre entra a la misma cola
      // serial y manda el snapshot más reciente una sola vez.
      pendingAgentIds.forEach((agentId) => {
        void saveAgentNowRef.current(agentId, { notify: false }).catch(() => undefined)
      })
    }
  }, [])

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
    const patchKeysBesidesEnabled = Object.keys(patch).filter((key) => key !== 'enabled')
    const includesDraftChanges = patchKeysBesidesEnabled.length > 0

    // Publicar o pausar nunca se refleja de forma optimista: primero debe
    // confirmarlo backend. Así el badge no miente si
    // falla una validación factual de calendario, producto, precio o enlace.
    if (currentAgent && patch.enabled !== undefined && !includesDraftChanges) {
      void saveAgentNow(agentId, { enabled: patch.enabled }).catch(() => undefined)
      return
    }

    saveRevisionsRef.current.set(agentId, (saveRevisionsRef.current.get(agentId) || 0) + 1)
    agentMutationVersionsRef.current.set(agentId, (agentMutationVersionsRef.current.get(agentId) || 0) + 1)
    dirtyAgentIdsRef.current.add(agentId)
    const { enabled: requestedEnabled, ...draftPatch } = patch
    if (requestedEnabled !== undefined) {
      pendingEnabledOverridesRef.current.set(agentId, requestedEnabled)
    }
    const nextAgents = agentsRef.current.map((agent) => (
      agent.id === agentId ? { ...agent, ...draftPatch } as ConversationalAgentDef : agent
    ))
    agentsRef.current = nextAgents
    setAgents(nextAgents)

    if (requestedEnabled !== undefined) {
      // Al editar una capacidad de un agente vivo, el mismo guardado debe
      // persistir el cambio Y pausarlo. La UI conserva el estado confirmado por
      // backend mientras el override pendiente también se reutiliza en cada
      // reintento, así no miente ni publica por accidente la capacidad nueva.
      void saveAgentNow(agentId, { enabled: requestedEnabled }).catch(() => undefined)
      return
    }

    scheduleAgentSave(agentId)
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

  // Creación directa: el agente nace con la plantilla nativa y abre su editor.
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
      agentMutationVersionsRef.current.set(agent.id, 1)
      const nextAgents = [...agentsRef.current, agent]
      agentsRef.current = nextAgents
      setAgents(nextAgents)
      setSelectedAgentId(agent.id)
      navigate(buildConversationalAgentPath(agent.id, routeBase))
      void refreshMetrics()
      return agent
    } catch (error: any) {
      if (isConversationalAgentEntryConflictError(error)) {
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

  const handleCreateAgent = () => {
    if (!canStartAgentCreation()) return
    void runCreateAgent({
      enabled: false,
      contactScope: DEFAULT_CONVERSATIONAL_CONTACT_SCOPE,
      capabilitiesConfig: DEFAULT_CONVERSATIONAL_CAPABILITIES_CONFIG
    })
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
      agentMutationVersionsRef.current.set(agent.id, 1)
      const nextAgents = [...agentsRef.current, agent]
      agentsRef.current = nextAgents
      setAgents(nextAgents)
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
          deletedAgentIdsRef.current.add(agent.id)
          agentMutationVersionsRef.current.set(agent.id, (agentMutationVersionsRef.current.get(agent.id) || 0) + 1)
          const nextAgents = agentsRef.current.filter((item) => item.id !== agent.id)
          agentsRef.current = nextAgents
          setAgents(nextAgents)
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
          key={selectedAgent.id}
          agent={selectedAgent}
          aiProviders={aiProviders}
          calendars={calendars}
          products={products}
          productsLoading={productsLoading}
          productsError={productsError}
          canUsePaymentLinks={hasPaymentLinksAccess(user)}
          filterOptions={filterOptions}
          onConnectProvider={openProviderModal}
          onBack={() => {
            void (async () => {
              try {
                await saveAgentNow(selectedAgent.id)
              } catch {
                return
              }
              setSelectedAgentId(null)
              navigate(buildConversationalAgentPath(null, routeBase))
            })()
          }}
          onChange={(patch) => handleAgentChange(selectedAgent.id, patch)}
          onFlushSave={() => saveAgentNow(selectedAgent.id)}
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
              onClick={handleCreateAgent}
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
            onClick={handleCreateAgent}
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
            const provider = getConversationalAIProviderOption(agent.aiProvider)
            const modelLabel = getConversationalModelLabel(agent.aiProvider, agent.model)
            const entryRules = agent.filters.entry.groups.reduce((total, group) => total + group.conditions.length, 0)
            const agentMetrics = metricsByAgentId.get(agent.id)
            const skippedCount = agentMetrics?.skippedConversations ?? 0
            const resettingSkips = resettingAgentSkipsId === agent.id
            const directoryPurpose = `${(agent.capabilitiesConfig?.items || []).filter((item) => item.enabled).length} capacidades · flujo directo`

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
    </div>
  )
}
