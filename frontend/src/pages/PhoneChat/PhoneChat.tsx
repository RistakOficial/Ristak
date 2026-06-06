import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  Bell,
  BellOff,
  Bot,
  CalendarDays,
  Camera,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleDollarSign,
  Clock,
  CreditCard,
  DollarSign,
  FileText,
  Globe2,
  Image as ImageIcon,
  Layers,
  Loader2,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  Mic,
  Moon,
  MonitorX,
  MoreHorizontal,
  MousePointerClick,
  Phone,
  Plus,
  ReceiptText,
  Search,
  Send,
  Sparkles,
  Smartphone,
  Sun,
  Tag,
  User,
  X
} from 'lucide-react'
import { MdArchive } from 'react-icons/md'
import { AppointmentModal, Icon, RecordPaymentModal } from '@/components/common'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhonePageTransition } from '@/components/phone/PhonePageTransition'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig, useBottomSheetDismiss, useHighLevelConnected, usePhoneTheme, type PhoneThemePreference } from '@/hooks'
import { aiAgentService, type AIAgentMessage, type AIAgentViewContext } from '@/services/aiAgentService'
import apiClient from '@/services/apiClient'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { highLevelService, type HighLevelChatChannel } from '@/services/highLevelService'
import {
  messageTemplatesService,
  type MessageTemplateCategory,
  type MessageTemplatePayload
} from '@/services/messageTemplatesService'
import { mobileAppService, type MobilePhotoAttachment } from '@/services/mobileAppService'
import { getPhoneDailyCacheKey, readPhoneDailyCache, writePhoneDailyCache } from '@/services/phoneDailyCache'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { whatsappApiService, type WhatsAppApiStatus, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import type { Contact } from '@/types'
import { getContactStageBadge } from '@/utils/contactStageBadge'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import styles from './PhoneChat.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_CHAT_SELECTOR = '[data-phone-chat-scrollable="true"], [data-phone-scrollable="true"]'
const CHAT_READ_STATE_KEY = 'ristak_phone_chat_read_state_v1'
const CHAT_ARCHIVED_STATE_KEY = 'ristak_phone_chat_archived_state_v1'
const CHAT_MUTED_STATE_KEY = 'ristak_phone_chat_muted_state_v1'
const AI_AGENT_CHAT_ID = 'ristak-ai-agent-mobile-chat'
const AI_AGENT_MESSAGES_KEY = 'ristak_phone_chat_ai_agent_messages_v1'
const CHAT_SWIPE_ACTION_WIDTH = 184
const CHAT_SWIPE_OPEN_THRESHOLD = 44
const CHAT_SWIPE_CLOSE_THRESHOLD = 132
const CHAT_SWIPE_ACTIVATE_THRESHOLD = 7
const CHAT_SWIPE_RENDER_STEP = 1
const MAX_VOICE_MESSAGE_BYTES = 16 * 1024 * 1024
const MIN_VOICE_RECORDING_MS = 600
const MAX_VOICE_RECORDING_MS = 3 * 60 * 1000
const VOICE_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm'
]

type AccessState = 'checking' | 'allowed' | 'blocked'
type ComposerStatus = 'idle' | 'sending'
type PaymentMode = 'single' | 'partial'
type ActionSheet = 'attachments' | 'templates' | 'payment' | 'appointment' | 'settings' | 'newChat' | 'chatMore' | null
type ChatFilter = 'all' | 'unread' | 'appointments' | 'customers' | 'leads'
type TemplateMode = 'choice' | 'send' | 'create'
type ChatSettingsSection = 'appearance' | 'templates' | 'numbers' | 'notifications' | 'agent' | 'chats' | null
type WhatsAppNumberMode = 'merged' | 'separated'
type ConversationSortMode = 'recent' | 'unread'
type PhotoPickDestination = 'chat' | 'cameraShare'

interface ChatSwipeGesture {
  contactId: string
  generation: number
  startX: number
  startY: number
  startOffset: number
  offset: number
  lastRenderedOffset: number
  active: boolean
}

const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const CANCELED_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'deleted', 'failed', 'invalid'])
const FAILED_MESSAGE_STATUSES = new Set(['error', 'failed', 'undelivered', 'rejected'])
const PENDING_MESSAGE_STATUSES = new Set(['pending', 'scheduled', 'queued'])
const TEMPLATE_DISABLED_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED', 'PENDING', 'IN_APPEAL'])
const EMPTY_TEMPLATE_LOCATION = {
  latitude: '',
  longitude: '',
  name: '',
  address: ''
}
const QUICK_TEMPLATE_CATEGORIES: Array<{ value: MessageTemplateCategory; label: string }> = [
  { value: 'utility', label: 'Utilidad' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'authentication', label: 'Autenticación' }
]
const QUICK_TEMPLATE_LANGUAGES = [
  { value: 'es_MX', label: 'Español México' },
  { value: 'es', label: 'Español' },
  { value: 'en_US', label: 'Inglés Estados Unidos' }
]
const PHONE_CHAT_THEME_OPTIONS: Array<{
  id: PhoneThemePreference
  label: string
  description: string
  Icon: React.ElementType
}> = [
  {
    id: 'system',
    label: 'Sistema',
    description: 'Usa el modo que tiene tu celular.',
    Icon: Smartphone
  },
  {
    id: 'light',
    label: 'Claro',
    description: 'Mantiene el chat con fondo claro.',
    Icon: Sun
  },
  {
    id: 'dark',
    label: 'Noche',
    description: 'Mantiene el chat oscuro todo el tiempo.',
    Icon: Moon
  },
  {
    id: 'auto',
    label: 'Horario',
    description: 'Claro de día y noche después de las 7 PM.',
    Icon: Clock
  }
]
const GHL_CHAT_CHANNEL_OPTIONS: Array<{
  id: HighLevelChatChannel
  label: string
  hint: string
}> = [
  { id: 'whatsapp_api', label: 'WhatsApp API', hint: 'Sale por WhatsApp oficial de HighLevel.' },
  { id: 'sms_qr', label: 'SMS/QR', hint: 'Usa el canal SMS conectado como respaldo QR.' },
  { id: 'messenger', label: 'Messenger', hint: 'Responde al chat de Facebook.' },
  { id: 'instagram', label: 'Instagram', hint: 'Responde al DM de Instagram.' }
]
const GHL_CHAT_CHANNEL_LABELS: Record<HighLevelChatChannel, string> = {
  whatsapp_api: 'WhatsApp API',
  sms_qr: 'SMS/QR',
  messenger: 'Messenger',
  instagram: 'Instagram'
}

interface ChatMessage {
  id: string
  text: string
  date: string
  direction: 'inbound' | 'outbound' | 'system'
  status?: string
  errorReason?: string
  businessPhone?: string
  businessPhoneNumberId?: string
  transport?: 'api' | 'qr' | string
  attachment?: {
    type: 'image' | 'audio'
    dataUrl?: string
    url?: string
    name?: string
    mimeType?: string
    durationMs?: number
  }
}

interface VoiceDraftAttachment {
  id: string
  name: string
  type: string
  dataUrl: string
  size: number
  durationMs: number
}

interface ChatContact extends Contact {
  lastMessageText?: string
  lastMessageType?: string
  lastMessageChannel?: string
  lastMessageDate?: string
  lastMessageDirection?: string
  lastBusinessPhone?: string
  lastBusinessPhoneNumberId?: string
  lastInboundBusinessPhone?: string
  lastInboundBusinessPhoneNumberId?: string
  messageCount?: number
  unreadCount?: number
  profilePhotoUrl?: string | null
  avatarUrl?: string | null
  photoUrl?: string | null
  pictureUrl?: string | null
  profile_picture_url?: string | null
}

interface ChatReadStateItem {
  lastMessageDate: string
  messageCount: number
}

type ChatReadState = Record<string, ChatReadStateItem>

interface ContactInfoPayment {
  id: string
  amount: number
  status?: string | null
  date: string
}

interface ContactInfoAppointment {
  id: string
  title: string
  status?: string | null
  startTime: string
}

function hasPortableAccess() {
  if (typeof window === 'undefined') return false

  const portableViewport = window.matchMedia(PORTABLE_WIDTH_QUERY).matches
  const phoneViewport = window.matchMedia(PHONE_WIDTH_QUERY).matches
  const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches
  const userAgent = navigator.userAgent || ''
  const mobileOrTabletUserAgent = MOBILE_OR_TABLET_USER_AGENT_PATTERN.test(userAgent)
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return phoneViewport || (portableViewport && (mobileOrTabletUserAgent || iPadDesktopMode || coarsePointer))
}

function getAccessState(): AccessState {
  if (typeof window === 'undefined') return 'checking'
  return hasPortableAccess() ? 'allowed' : 'blocked'
}

function readChatReadState(): ChatReadState {
  if (typeof window === 'undefined') return {}

  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_READ_STATE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeChatReadState(state: ChatReadState) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CHAT_READ_STATE_KEY, JSON.stringify(state))
}

function readStoredChatIds(key: string) {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  } catch {
    return []
  }
}

function writeStoredChatIds(key: string, ids: string[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(key, JSON.stringify(Array.from(new Set(ids))))
}

function createAIAgentMobileMessage(role: AIAgentMessage['role'], content: string): AIAgentMessage {
  return {
    id: `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role,
    content,
    createdAt: new Date().toISOString()
  }
}

function createAIAgentWelcomeMessage() {
  return createAIAgentMobileMessage(
    'assistant',
    'Hola, soy tu agente de inteligencia artificial. Puedes preguntarme por tus clientes, pagos, citas, campañas o pedir ayuda para responder mejor.'
  )
}

function readAIAgentMobileMessages(): AIAgentMessage[] {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(AI_AGENT_MESSAGES_KEY) || '[]')
    if (!Array.isArray(parsed)) return []

    return parsed
      .filter((message) => (
        message &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string'
      ))
      .map((message) => ({
        id: typeof message.id === 'string' ? message.id : `ai-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        role: message.role,
        content: message.content,
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date().toISOString()
      }))
      .slice(-60)
  } catch {
    return []
  }
}

function writeAIAgentMobileMessages(messages: AIAgentMessage[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(AI_AGENT_MESSAGES_KEY, JSON.stringify(messages.slice(-60)))
}

function getAIAgentMessagePreview(message?: AIAgentMessage | null) {
  const content = String(message?.content || '').replace(/\s+/g, ' ').trim()
  if (!content) return 'Pregúntame lo que necesites de Ristak.'
  return message?.role === 'user' ? `Tú: ${content}` : content
}

function getContactMessageCount(contact: ChatContact) {
  return Number(contact.messageCount || 0)
}

function applyLocalUnreadState(contact: ChatContact, readState: ChatReadState): ChatContact {
  const serverUnread = Math.max(0, Number(contact.unreadCount || 0))
  const lastDirection = String(contact.lastMessageDirection || '').toLowerCase()

  if (serverUnread > 0 || lastDirection !== 'inbound') {
    return { ...contact, unreadCount: serverUnread }
  }

  const stored = readState[contact.id]
  if (!stored) return { ...contact, unreadCount: 0 }

  const messageCount = getContactMessageCount(contact)
  const countDelta = messageCount - Number(stored.messageCount || 0)
  const lastMessageDate = contact.lastMessageDate || ''
  const hasNewerMessage = Boolean(lastMessageDate && stored.lastMessageDate && Date.parse(lastMessageDate) > Date.parse(stored.lastMessageDate))
  const unreadCount = countDelta > 0 ? countDelta : hasNewerMessage ? 1 : 0

  return { ...contact, unreadCount: Math.max(0, unreadCount) }
}

function ensureReadBaselines(contacts: ChatContact[], readState: ChatReadState) {
  let changed = false
  const nextState: ChatReadState = { ...readState }

  contacts.forEach((contact) => {
    if (nextState[contact.id]) return
    nextState[contact.id] = {
      lastMessageDate: contact.lastMessageDate || contact.createdAt || '',
      messageCount: getContactMessageCount(contact)
    }
    changed = true
  })

  if (changed) writeChatReadState(nextState)
  return nextState
}

function syncReadStateForVisibleReadChats(contacts: ChatContact[], readState: ChatReadState) {
  let changed = false
  const nextState: ChatReadState = { ...readState }

  contacts.forEach((contact) => {
    if (Number(contact.unreadCount || 0) > 0) return

    const nextValue = {
      lastMessageDate: contact.lastMessageDate || contact.createdAt || '',
      messageCount: getContactMessageCount(contact)
    }
    const currentValue = nextState[contact.id]
    if (
      currentValue?.lastMessageDate === nextValue.lastMessageDate &&
      Number(currentValue?.messageCount || 0) === nextValue.messageCount
    ) {
      return
    }

    nextState[contact.id] = nextValue
    changed = true
  })

  if (changed) writeChatReadState(nextState)
}

function markContactReadState(contact: ChatContact) {
  const currentState = readChatReadState()
  const nextState = {
    ...currentState,
    [contact.id]: {
      lastMessageDate: contact.lastMessageDate || contact.createdAt || new Date().toISOString(),
      messageCount: getContactMessageCount(contact)
    }
  }
  writeChatReadState(nextState)
}

function getContactName(contact?: Partial<Contact> | null) {
  return contact?.name || contact?.email || contact?.phone || 'Contacto sin nombre'
}

function getContactDetail(contact?: Partial<Contact> | null) {
  return contact?.phone || contact?.email || 'Sin teléfono guardado'
}

function contactMatchesQuery(contact: Partial<Contact>, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  const haystack = [
    contact.name,
    contact.phone,
    contact.email
  ].filter(Boolean).join(' ').toLowerCase()
  return haystack.includes(normalizedQuery)
}

function getContactInitials(contact?: Partial<Contact> | null) {
  const label = getContactName(contact)
  const parts = label.split(' ').filter(Boolean)
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase()
  return label.slice(0, 2).toUpperCase()
}

function getContactProfilePhoto(contact?: (Partial<Contact> & Record<string, unknown>) | null) {
  const candidates = [
    contact?.profilePhotoUrl,
    contact?.avatarUrl,
    contact?.photoUrl,
    contact?.pictureUrl,
    contact?.profile_picture_url
  ]

  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || ''
}

function formatMessageTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  return new Intl.DateTimeFormat('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date)
}

function formatMessageDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return formatMessageTime(value)

  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short'
  }).format(date).replace('.', '')
}

function capitalizeFirst(value: string) {
  if (!value) return value
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function getConversationDayKey(value?: string | null, timeZone?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const safeTimeZone = timeZone || undefined

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: safeTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const parts = formatter.formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value

  return year && month && day ? `${year}-${month}-${day}` : ''
}

function getConversationDayLabel(value?: string | null, timeZone?: string) {
  const dayKey = getConversationDayKey(value, timeZone)
  if (!dayKey) return ''

  const todayKey = getConversationDayKey(new Date().toISOString(), timeZone)
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayKey = getConversationDayKey(yesterday.toISOString(), timeZone)

  if (dayKey === todayKey) return 'Hoy'
  if (dayKey === yesterdayKey) return 'Ayer'

  const date = new Date(value || '')
  const safeTimeZone = timeZone || undefined
  const [year, month, day] = dayKey.split('-').map(Number)
  const [todayYear, todayMonth, todayDay] = todayKey.split('-').map(Number)
  const dayDistance = Math.round((Date.UTC(todayYear, todayMonth - 1, todayDay) - Date.UTC(year, month - 1, day)) / 86_400_000)

  if (dayDistance > 1 && dayDistance < 7) {
    return capitalizeFirst(new Intl.DateTimeFormat('es-MX', { weekday: 'long', timeZone: safeTimeZone }).format(date))
  }

  const formatOptions: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    timeZone: safeTimeZone
  }

  if (year !== todayYear) {
    formatOptions.year = 'numeric'
  }

  return new Intl.DateTimeFormat('es-MX', formatOptions).format(date).replace('.', '')
}

function getSupportedVoiceMimeType() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return ''
  return VOICE_MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ''
}

function getVoiceFileExtension(mimeType = '') {
  const normalized = mimeType.split(';')[0].toLowerCase()
  if (normalized === 'audio/ogg') return 'ogg'
  if (normalized === 'audio/mp4') return 'm4a'
  if (normalized === 'audio/webm') return 'webm'
  return 'webm'
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el audio.'))
    reader.readAsDataURL(blob)
  })
}

function formatVoiceDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || fallback)
  }
  return fallback
}

function normalizeTemplateNameInput(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function getTemplateStatus(template?: WhatsAppApiTemplate | null) {
  return String(template?.status || '').trim().toUpperCase()
}

function getTemplateStatusLabel(status = '') {
  const normalized = status.trim().toUpperCase()
  const labels: Record<string, string> = {
    APPROVED: 'Aprobada',
    PENDING: 'En revisión',
    REJECTED: 'Rechazada',
    PAUSED: 'Pausada',
    DISABLED: 'Bloqueada',
    ARCHIVED: 'Archivada',
    DELETED: 'Eliminada',
    IN_APPEAL: 'En apelación'
  }
  return labels[normalized] || formatPlainStatus(normalized || 'Sin estado')
}

function getTemplateBodyPreview(template: WhatsAppApiTemplate) {
  const components = Array.isArray(template.components) ? template.components : []
  const body = components.find((component) => String(component?.type || '').toLowerCase() === 'body')
  const header = components.find((component) => String(component?.type || '').toLowerCase() === 'header')
  const text = String(body?.text || body?.body || header?.text || '').trim()
  return text || `${template.name} · ${template.language}`
}

function getTemplateBlockedReason(template: WhatsAppApiTemplate, alertMessage = '') {
  const status = getTemplateStatus(template)
  if (status === 'APPROVED') return ''
  return (
    template.reason ||
    alertMessage ||
    `${getTemplateStatusLabel(status)}. Solo se pueden enviar plantillas aprobadas.`
  )
}

function createQuickTemplatePayload({
  name,
  bodyText,
  category,
  language
}: {
  name: string
  bodyText: string
  category: MessageTemplateCategory
  language: string
}): MessageTemplatePayload {
  return {
    folderId: null,
    name,
    description: 'Creada desde Ristak Chat',
    category,
    language,
    status: 'draft',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { ...EMPTY_TEMPLATE_LOCATION },
    bodyText,
    footerText: '',
    buttons: [],
    variableExamples: {},
    variableBindings: { headerText: {}, bodyText: {} },
    ycloudTemplateId: null,
    ycloudStatus: null
  }
}

function getJourneyMessageError(event: JourneyEvent) {
  return String(
    event.data?.error_message ||
    event.data?.errorMessage ||
    event.data?.error_reason ||
    event.data?.errorReason ||
    event.data?.failure_reason ||
    event.data?.reason ||
    event.data?.error_code ||
    ''
  ).trim()
}

function isMessageFailed(message: ChatMessage) {
  return FAILED_MESSAGE_STATUSES.has(String(message.status || '').trim().toLowerCase()) || Boolean(message.errorReason)
}

function isMessagePending(message: ChatMessage) {
  const status = String(message.status || '').trim().toLowerCase()
  return PENDING_MESSAGE_STATUSES.has(status) || status.startsWith('enviando')
}

type MessageReceiptStatus = 'sent' | 'delivered' | 'read'

function getMessageReceiptStatus(message: ChatMessage): MessageReceiptStatus {
  const status = String(message.status || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (['read', 'seen', 'played'].includes(status)) return 'read'
  if (['delivered', 'delivery_ack'].includes(status)) return 'delivered'
  return 'sent'
}

function getMessageReceiptLabel(status: MessageReceiptStatus) {
  if (status === 'read') return 'Leído'
  if (status === 'delivered') return 'Entregado'
  return 'Enviado'
}

function shouldTrackOutboundReceipt(message: ChatMessage) {
  if (message.direction !== 'outbound' || isMessageFailed(message)) return false
  const status = getMessageReceiptStatus(message)
  if (status === 'read') return false

  const sentAt = new Date(message.date).getTime()
  if (!Number.isFinite(sentAt)) return true
  return Date.now() - sentAt < 30 * 60 * 1000
}

function getJourneyMediaAttachment(event: JourneyEvent): ChatMessage['attachment'] | undefined {
  const messageType = String(event.data?.message_type || '').toLowerCase()
  const mediaUrl = String(event.data?.media_url || event.data?.mediaUrl || '').trim()
  const mediaId = String(event.data?.media_id || event.data?.mediaId || '').trim()
  const mimeType = String(event.data?.media_mime_type || event.data?.mediaMimeType || '').trim()
  const name = String(event.data?.media_filename || event.data?.mediaFilename || '').trim()
  const durationMs = Number(event.data?.media_duration_ms || event.data?.mediaDurationMs || 0) || undefined

  if (messageType.includes('audio') || messageType.includes('voice')) {
    return {
      type: 'audio',
      url: mediaUrl,
      name: name || mediaId || 'Mensaje de voz',
      mimeType,
      durationMs
    }
  }

  if (messageType.includes('image') && mediaUrl) {
    return {
      type: 'image',
      url: mediaUrl,
      name: name || mediaId || 'Foto enviada',
      mimeType
    }
  }

  return undefined
}

function getJourneyMessage(event: JourneyEvent, index: number): ChatMessage | null {
  const isMetaMessage = event.type === 'meta_message'
  if (event.type !== 'whatsapp_message' && !isMetaMessage) return null

  const text = String(
    event.data?.message_text ||
    event.data?.message ||
    event.data?.body ||
    ''
  ).trim()
  const messageType = String(event.data?.message_type || '')
  const attachment = getJourneyMediaAttachment(event)

  if (!text && !messageType && !attachment) return null

  const direction = String(event.data?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound'

  return {
    id: String(
      isMetaMessage
        ? event.data?.meta_social_message_id || event.data?.meta_message_id || `meta-message-${index}`
        : event.data?.whatsapp_api_message_id || event.data?.whatsapp_message_id || event.data?.attribution_record_id || `message-${index}`
    ),
    text: text || (attachment ? '' : getMessageTypeLabel(messageType, isMetaMessage ? 'Mensaje de Meta' : 'Mensaje de WhatsApp')),
    date: event.date,
    direction,
    status: String(event.data?.status || ''),
    errorReason: getJourneyMessageError(event),
    businessPhone: String(event.data?.business_phone || ''),
    businessPhoneNumberId: String(event.data?.business_phone_number_id || ''),
    transport: String(event.data?.transport || (isMetaMessage ? event.data?.social_platform || 'meta' : 'api')),
    attachment
  }
}

function getMessageTypeLabel(type = '', fallback = 'Mensaje de WhatsApp') {
  const normalized = type.toLowerCase()
  if (normalized.includes('image')) return 'Foto'
  if (normalized.includes('video')) return 'Video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Mensaje de voz'
  if (normalized.includes('document')) return 'Documento'
  if (normalized.includes('location')) return 'Ubicación'
  if (normalized.includes('postback')) return 'Respuesta rápida'
  if (normalized.includes('reaction')) return 'Reacción'
  return fallback
}

function getReadableValue(value?: string | number | null) {
  if (value === null || value === undefined) return ''
  const normalized = String(value).trim()
  if (!normalized || ['null', 'undefined', 'nan'].includes(normalized.toLowerCase())) return ''
  return formatUrlParameter(normalized) || normalized
}

function normalizeGhlChatChannelValue(value?: string | null): HighLevelChatChannel | '' {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const compact = normalized.replace(/_/g, '')
  if (!normalized) return ''
  if (['instagram', 'ig', 'ghl_instagram'].includes(normalized) || compact === 'ghlinstagram') return 'instagram'
  if (['messenger', 'facebook', 'fb', 'ghl_messenger'].includes(normalized) || compact === 'ghlmessenger') return 'messenger'
  if (['sms', 'sms_qr', 'qr', 'baileys', 'bailey', 'whatsapp_qr', 'ghl_sms'].includes(normalized) || compact === 'smsqr') return 'sms_qr'
  if (['whatsapp', 'whatsapp_api', 'api', 'ghl_whatsapp'].includes(normalized) || compact === 'whatsappapi') return 'whatsapp_api'
  return ''
}

function getHighLevelChatChannelLabel(channel?: string | null) {
  const normalized = normalizeGhlChatChannelValue(channel)
  return normalized ? GHL_CHAT_CHANNEL_LABELS[normalized] : ''
}

function getAvatarChannelClass(contact?: (Partial<Contact> & { lastMessageChannel?: string | null }) | null) {
  const channel = normalizeGhlChatChannelValue(contact?.lastMessageChannel)
  if (channel === 'instagram') return styles.avatarInstagram
  if (channel === 'messenger') return styles.avatarMessenger
  if (channel === 'whatsapp_api' || channel === 'sms_qr') return styles.avatarWhatsapp
  return ''
}

function getMessageTransportBadge(transport?: string | null) {
  const raw = String(transport || '').trim().toLowerCase()
  if (raw === 'qr') return 'QR'
  if (raw === 'api') return ''
  return getHighLevelChatChannelLabel(raw)
}

function inferHighLevelChatChannel(contact?: ChatContact | null, messages: ChatMessage[] = []): HighLevelChatChannel {
  const newestMessageChannel = [...messages]
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
    .map((message) => normalizeGhlChatChannelValue(message.transport || message.businessPhoneNumberId || ''))
    .find(Boolean)

  return (
    newestMessageChannel ||
    normalizeGhlChatChannelValue(contact?.lastMessageChannel) ||
    'whatsapp_api'
  ) as HighLevelChatChannel
}

function formatPlainStatus(value?: string | null) {
  const normalized = String(value || '').trim()
  if (!normalized) return ''

  const statusMap: Record<string, string> = {
    succeeded: 'Pagado',
    paid: 'Pagado',
    completed: 'Completado',
    complete: 'Completado',
    fulfilled: 'Pagado',
    success: 'Pagado',
    pending: 'Pendiente',
    processing: 'Procesando',
    failed: 'Fallido',
    canceled: 'Cancelado',
    cancelled: 'Cancelado',
    booked: 'Reservado',
    confirmed: 'Confirmado',
    scheduled: 'Agendado',
    showed: 'Asistió',
    attended: 'Asistió',
    no_show: 'No asistió',
    noshow: 'No asistió'
  }

  const key = normalized.toLowerCase()
  return statusMap[key] || normalized
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function isSuccessfulPayment(payment: ContactInfoPayment) {
  const status = String(payment.status || '').trim().toLowerCase()
  return payment.amount > 0 && (!status || SUCCESS_PAYMENT_STATUSES.has(status))
}

function isActiveAppointment(appointment: ContactInfoAppointment) {
  const status = String(appointment.status || '').trim().toLowerCase()
  return !status || !CANCELED_APPOINTMENT_STATUSES.has(status)
}

function getContactInfoPayments(contact?: Contact | null, journey: JourneyEvent[] = []): ContactInfoPayment[] {
  const contactPayments = (contact?.payments || [])
    .map((payment, index) => ({
      id: String(payment.id || `${contact?.id || 'contact'}-payment-${index}`),
      amount: Number(payment.amount || 0),
      status: payment.status,
      date: payment.date || contact?.createdAt || new Date().toISOString()
    }))

  if (contactPayments.length > 0) {
    return contactPayments.sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
  }

  return journey
    .filter((event) => event.type === 'payment')
    .map((event, index) => ({
      id: String(event.data?.id || `${contact?.id || 'contact'}-journey-payment-${index}`),
      amount: Number(event.data?.amount || 0),
      status: event.data?.status || null,
      date: event.date
    }))
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
}

function getContactInfoAppointments(contact?: Contact | null, journey: JourneyEvent[] = []): ContactInfoAppointment[] {
  const contactAppointments = (contact?.appointments || [])
    .map((appointment, index) => ({
      id: String(appointment.id || `${contact?.id || 'contact'}-appointment-${index}`),
      title: appointment.title || 'Cita',
      status: appointment.appointment_status || appointment.status || null,
      startTime: appointment.start_time || appointment.end_time || contact?.createdAt || new Date().toISOString()
    }))

  if (contactAppointments.length > 0) {
    return contactAppointments.sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime))
  }

  return journey
    .filter((event) => event.type === 'appointment')
    .map((event, index) => ({
      id: String(event.data?.id || `${contact?.id || 'contact'}-journey-appointment-${index}`),
      title: String(event.data?.title || 'Cita'),
      status: event.data?.status || null,
      startTime: String(event.data?.start_time || event.date)
    }))
    .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime))
}

function getTrackingData(contact?: Contact | null, journey: JourneyEvent[] = []) {
  const firstSession = contact?.firstSession || null
  const firstPageVisit = journey.find((event) => event.type === 'page_visit')
  const pageData = firstPageVisit?.data || {}
  const attributionSource = contact?.whatsappAttributionPlatform || contact?.attribution_session_source || contact?.source || null

  return {
    started_at: firstSession?.started_at || firstPageVisit?.date || contact?.createdAt || null,
    page_url: firstSession?.page_url || firstSession?.landing_page || pageData.page_url || pageData.landing_page || contact?.attribution_url || null,
    referrer_url: firstSession?.referrer_url || pageData.referrer_url || contact?.attribution_url || null,
    utm_source: firstSession?.utm_source || pageData.utm_source || attributionSource,
    utm_medium: firstSession?.utm_medium || pageData.utm_medium || contact?.attribution_medium || null,
    utm_campaign: firstSession?.utm_campaign || pageData.utm_campaign || null,
    utm_content: firstSession?.utm_content || pageData.utm_content || null,
    source_platform: firstSession?.source_platform || pageData.source_platform || attributionSource,
    site_source_name: firstSession?.site_source_name || pageData.site_source_name || attributionSource,
    campaign_name: firstSession?.campaign_name || pageData.campaign_name || null,
    ad_name: firstSession?.ad_name || pageData.ad_name || null,
    ad_id: firstSession?.ad_id || pageData.ad_id || contact?.ad_id || null,
    device_type: firstSession?.device_type || pageData.device_type || null,
    browser: firstSession?.browser || pageData.browser || null,
    os: firstSession?.os || null,
    placement: firstSession?.placement || null,
    geo_city: firstSession?.geo_city || pageData.geo_city || null,
    geo_region: firstSession?.geo_region || pageData.geo_region || null,
    geo_country: firstSession?.geo_country || pageData.geo_country || null
  }
}

function getPageName(pageUrl?: string | null) {
  if (!pageUrl) return ''
  try {
    const url = new URL(pageUrl)
    const pathName = url.pathname.split('/').filter(Boolean).pop()
    return pathName || url.hostname
  } catch {
    const cleanUrl = pageUrl.split('?')[0]
    return cleanUrl.split('/').filter(Boolean).pop() || cleanUrl
  }
}

function getCustomFieldLabel(field: NonNullable<Contact['customFields']>[number], index: number) {
  return field.label || field.name || field.key || field.fieldKey || field.id || `Dato ${index + 1}`
}

function formatCustomFieldValue(value: NonNullable<Contact['customFields']>[number]['value']) {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map((item) => getReadableValue(String(item))).filter(Boolean).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function getJourneyEventLabel(event: JourneyEvent, leadLabel: string) {
  if (event.type === 'page_visit') return 'Visitó una página'
  if (event.type === 'contact_created') return `Se hizo ${leadLabel.toLowerCase()}`
  if (event.type === 'appointment') return 'Agendó una cita'
  if (event.type === 'payment') return 'Registró un pago'
  if (event.type === 'whatsapp_message') return 'WhatsApp'
  if (event.type === 'meta_message') return getReadableValue(event.data?.source) || 'Meta'
  return 'Actividad'
}

function isWhatsAppJourneyEvent(event?: JourneyEvent | null) {
  if (!event) return false
  const data = event.data || {}
  const source = String(data.source || data.referral_source_app || data.referral_entry_point || '').toLowerCase()

  return event.type === 'whatsapp_message' || source.includes('whatsapp')
}

function getJourneyPlatformLabel(event?: JourneyEvent | null) {
  if (!event) return ''
  const data = event.data || {}
  if (event.type === 'meta_message') return getReadableValue(data.source) || 'Meta'
  const platform = getReadableValue(data.ad_platform)
  if (platform) return platform

  const normalizedSource = normalizeTrafficSource({
    referrer_url: data.referrer_url || data.referral_source_url || data.source_url,
    referral_source_url: data.referral_source_url,
    site_source_name: data.site_source_name || data.referral_source_app,
    utm_source: data.utm_source || data.referral_source_type,
    source_platform: data.source_platform,
    referral_source_app: data.referral_source_app,
    referral_entry_point: data.referral_entry_point,
    source: data.source
  })

  return normalizedSource && !['Directo', 'Desconocido', 'Otro'].includes(normalizedSource)
    ? normalizedSource
    : ''
}

function getJourneyPlatformIconName(platform?: string | null) {
  const normalized = String(platform || '').toLowerCase()
  if (normalized.includes('instagram')) return 'instagram'
  if (normalized.includes('messenger')) return 'facebook'
  if (normalized.includes('facebook')) return 'facebook'
  if (normalized.includes('tiktok')) return 'tiktok'
  if (normalized.includes('google')) return 'google'
  if (normalized.includes('youtube')) return 'youtube'
  if (normalized.includes('linkedin')) return 'linkedin'
  if (normalized.includes('twitter') || normalized === 'x') return 'twitter'
  if (normalized.includes('bing')) return 'bing'
  if (normalized.includes('meta')) return 'meta-ads'
  return ''
}

function getJourneyPlatformClass(platform?: string | null) {
  const iconName = getJourneyPlatformIconName(platform)
  const classMap: Record<string, string | undefined> = {
    facebook: styles.contactInfoTimelineIconFacebook,
    instagram: styles.contactInfoTimelineIconInstagram,
    tiktok: styles.contactInfoTimelineIconTikTok,
    google: styles.contactInfoTimelineIconGoogle,
    youtube: styles.contactInfoTimelineIconYouTube,
    linkedin: styles.contactInfoTimelineIconLinkedIn,
    twitter: styles.contactInfoTimelineIconTwitter,
    bing: styles.contactInfoTimelineIconBing,
    'meta-ads': styles.contactInfoTimelineIconMeta
  }

  return classMap[iconName] || ''
}

function hasMeaningfulJourneyValue(value: unknown) {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    return Boolean(trimmed) && !['null', 'undefined', 'nan'].includes(trimmed)
  }
  return true
}

function isAdAttributedJourneyEvent(event: JourneyEvent) {
  const data = event.data || {}
  return Boolean(
    data.is_ad_attributed ||
    data.attribution_ad_id ||
    data.referral_source_id ||
    data.referral_ctwa_clid
  )
}

function getWhatsAppJourneyEventScore(event: JourneyEvent) {
  const data = event.data || {}
  const completenessFields = [
    'campaign_name',
    'adset_name',
    'attribution_ad_name',
    'attribution_ad_id',
    'ad_platform',
    'referral_source_url',
    'referral_source_type',
    'referral_source_id',
    'referral_ctwa_clid',
    'referral_headline',
    'referral_body',
    'message_text'
  ]

  const completeness = completenessFields.reduce(
    (score, field) => score + (hasMeaningfulJourneyValue(data[field]) ? 1 : 0),
    0
  )

  return (isAdAttributedJourneyEvent(event) ? 1000 : 0) + (event.type === 'whatsapp_message' ? 10 : 0) + completeness
}

const contactInfoJourneyDayFormatters = new Map<string, Intl.DateTimeFormat>()

function getContactInfoJourneyDayKey(date: string, timezone: string) {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return String(date || '')

  let formatter = contactInfoJourneyDayFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    })
    contactInfoJourneyDayFormatters.set(timezone, formatter)
  }

  return formatter.format(parsed)
}

function enrichJourneyDataWithMeta(
  data: Record<string, any>,
  metaAttribution?: Contact['metaAttribution'] | null
) {
  if (!metaAttribution) return data

  const eventAdId = String(data.attribution_ad_id || data.referral_source_id || data.ad_id || '').trim()
  const metaAdId = String(metaAttribution.adId || '').trim()
  const sameAd = eventAdId && metaAdId ? eventAdId === metaAdId : true
  const shouldEnrich = sameAd && (data.is_ad_attributed || eventAdId || data.referral_ctwa_clid)
  if (!shouldEnrich) return data

  return {
    ...data,
    campaign_name: data.campaign_name || metaAttribution.campaignName || null,
    adset_name: data.adset_name || metaAttribution.adsetName || null,
    attribution_ad_id: metaAttribution.adId || data.attribution_ad_id || data.referral_source_id || null,
    attribution_ad_name: metaAttribution.adName || data.attribution_ad_name || null,
    ad_platform: data.ad_platform || 'Meta Ads',
    is_ad_attributed: true
  }
}

function buildContactInfoJourney(
  events: JourneyEvent[],
  timezone: string,
  metaAttribution?: Contact['metaAttribution'] | null
) {
  const whatsappEvents: JourneyEvent[] = []
  const otherEvents: JourneyEvent[] = []

  events.forEach((event) => {
    if (!event?.date) return
    if (isWhatsAppJourneyEvent(event)) {
      whatsappEvents.push(event)
    } else {
      otherEvents.push(event)
    }
  })

  const whatsappByDay = new Map<string, JourneyEvent[]>()
  whatsappEvents.forEach((event) => {
    const dayKey = getContactInfoJourneyDayKey(event.date, timezone)
    const dayEvents = whatsappByDay.get(dayKey)
    if (dayEvents) {
      dayEvents.push(event)
    } else {
      whatsappByDay.set(dayKey, [event])
    }
  })

  const mergedWhatsAppEvents: JourneyEvent[] = []
  whatsappByDay.forEach((dayEvents) => {
    const sorted = [...dayEvents].sort((left, right) => getWhatsAppJourneyEventScore(right) - getWhatsAppJourneyEventScore(left))
    const primary = sorted[0]
    const mergedData: Record<string, any> = {}

    sorted.forEach((event) => {
      const data = event.data || {}
      Object.entries(data).forEach(([key, value]) => {
        if (!hasMeaningfulJourneyValue(mergedData[key]) && hasMeaningfulJourneyValue(value)) {
          mergedData[key] = value
        }
      })
    })

    const enrichedData = enrichJourneyDataWithMeta({
      ...mergedData,
      is_ad_attributed: dayEvents.some(isAdAttributedJourneyEvent)
    }, metaAttribution)

    mergedWhatsAppEvents.push({
      ...primary,
      type: 'whatsapp_message',
      data: enrichedData
    })
  })

  return [...otherEvents, ...mergedWhatsAppEvents].sort(
    (left, right) => Date.parse(left.date) - Date.parse(right.date)
  )
}

function getJourneyEventNetworkBadge(event: JourneyEvent) {
  if (!isWhatsAppJourneyEvent(event) || !isAdAttributedJourneyEvent(event)) return null
  const platform = getJourneyPlatformLabel(event) || 'Meta Ads'
  const iconName = getJourneyPlatformIconName(platform) || 'meta-ads'

  return (
    <span className={`${styles.contactInfoTimelineNetworkBadge} ${getJourneyPlatformClass(platform)}`} title={platform}>
      <Icon name={iconName} size={10} />
    </span>
  )
}

function getJourneyEventIcon(event: JourneyEvent) {
  if (isWhatsAppJourneyEvent(event)) return <Icon name="whatsapp" size={15} />
  if (event.type === 'meta_message') {
    const platformIcon = getJourneyPlatformIconName(getJourneyPlatformLabel(event))
    return platformIcon ? <Icon name={platformIcon} size={15} /> : <Icon name="meta-ads" size={15} />
  }

  if (event.type === 'page_visit') {
    const platformIcon = getJourneyPlatformIconName(getJourneyPlatformLabel(event))
    return platformIcon ? <Icon name={platformIcon} size={15} /> : <MousePointerClick size={15} />
  }
  if (event.type === 'contact_created') return <User size={15} />
  if (event.type === 'appointment') return <CalendarDays size={15} />
  if (event.type === 'payment') return <DollarSign size={15} />

  return <MousePointerClick size={15} />
}

function getJourneyEventIconClass(event: JourneyEvent) {
  if (isWhatsAppJourneyEvent(event)) return styles.contactInfoTimelineIconWhatsapp
  if (event.type === 'meta_message') return getJourneyPlatformClass(getJourneyPlatformLabel(event)) || styles.contactInfoTimelineIconMeta

  if (event.type === 'page_visit') return getJourneyPlatformClass(getJourneyPlatformLabel(event)) || styles.contactInfoTimelineIconVisit
  if (event.type === 'contact_created') return styles.contactInfoTimelineIconContact
  if (event.type === 'appointment') return styles.contactInfoTimelineIconAppointment
  if (event.type === 'payment') return styles.contactInfoTimelineIconPayment

  return styles.contactInfoTimelineIconDefault
}

function getJourneyEventDescription(event: JourneyEvent) {
  const data = event.data || {}

  if (event.type === 'page_visit') {
    const source = getJourneyPlatformLabel(event)
    const pageName = getPageName(data.page_url || data.landing_page)
    const campaign = getReadableValue(data.campaign_name || data.utm_campaign)

    return [source, pageName, campaign ? `Campaña ${campaign}` : ''].filter(Boolean).join(' · ') || 'Visita registrada'
  }

  if (event.type === 'contact_created') {
    const source = getReadableValue(data.source) || 'Contacto guardado en Ristak'
    const campaign = getReadableValue(data.campaign_name)
    const adName = getReadableValue(data.attribution_ad_name || data.meta_ad_name)

    return [source, campaign || adName].filter(Boolean).join(' · ')
  }

  if (event.type === 'appointment') {
    return getReadableValue(data.title) || formatPlainStatus(data.status) || 'Cita'
  }

  if (event.type === 'payment') {
    return data.amount ? formatCurrency(Number(data.amount)) : formatPlainStatus(data.status) || 'Pago'
  }

  if (event.type === 'whatsapp_message') {
    const platform = getJourneyPlatformLabel(event) || (data.is_ad_attributed ? 'Meta Ads' : 'WhatsApp')
    const campaign = getReadableValue(data.campaign_name)
    const adName = getReadableValue(data.attribution_ad_name || data.ad_name)
    const messageText = getReadableValue(data.message_text || data.message || data.body)

    if (data.is_ad_attributed) {
      return [
        `Anuncio ${platform}`,
        campaign ? `Campaña ${campaign}` : '',
        !campaign && adName ? adName : ''
      ].filter(Boolean).join(' · ')
    }

    return messageText || getMessageTypeLabel(String(data.message_type || '')) || 'Conversación por WhatsApp'
  }

  if (event.type === 'meta_message') {
    const source = getReadableValue(data.source) || 'Meta'
    const sender = getReadableValue(data.profile_name || data.username)
    const messageText = getReadableValue(data.message_text || data.message || data.body)

    return [source, sender, messageText || getMessageTypeLabel(String(data.message_type || ''), 'Mensaje recibido')]
      .filter(Boolean)
      .join(' · ')
  }

  return ''
}

function getResolvedMetaAttribution(contact?: Contact | null, journey: JourneyEvent[] = []): Contact['metaAttribution'] | null {
  const direct = contact?.metaAttribution
  if (direct && (direct.campaignName || direct.adsetName || direct.adName || direct.adId)) {
    return direct
  }

  const contactCreatedEvent = journey.find((event) => {
    if (event.type !== 'contact_created') return false
    const data = event.data || {}
    return Boolean((data.campaign_name || data.adset_name) && (data.attribution_ad_id || data.attribution_ad_name))
  })

  if (!contactCreatedEvent) return null

  const data = contactCreatedEvent.data || {}

  return {
    source: 'meta_ads',
    matchType: 'journey',
    campaignName: data.campaign_name || null,
    adsetName: data.adset_name || null,
    adId: data.attribution_ad_id || null,
    adName: data.attribution_ad_name || data.meta_ad_name || null
  }
}

function getChatPreview(contact: ChatContact) {
  const text = String(contact.lastMessageText || '').trim()
  const channel = normalizeGhlChatChannelValue(contact.lastMessageChannel)
  const fallback = channel === 'instagram'
    ? 'Mensaje de Instagram'
    : channel === 'messenger'
      ? 'Mensaje de Messenger'
      : 'Mensaje de WhatsApp'
  const typeLabel = text ? text : getMessageTypeLabel(contact.lastMessageType || '', fallback)
  return contact.lastMessageDirection === 'outbound' ? `Tú: ${typeLabel}` : typeLabel
}

function getNotificationPermissionLabel() {
  if (mobileAppService.isNative()) return 'Toca Activar para permitir alertas en este celular.'
  if (typeof window === 'undefined' || !('Notification' in window)) return 'Este celular no permite alertas de la app.'
  if (Notification.permission === 'granted') return 'Este celular ya puede recibir alertas.'
  if (Notification.permission === 'denied') return 'Este celular bloqueó las alertas. Actívalas desde la configuración del navegador.'
  return 'Toca Activar para permitir alertas en este celular.'
}

function normalizePhoneValue(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

function phoneLooksSame(left?: string | null, right?: string | null) {
  const leftDigits = normalizePhoneValue(left)
  const rightDigits = normalizePhoneValue(right)
  if (!leftDigits || !rightDigits) return false
  return leftDigits === rightDigits || leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits)
}

function getBusinessPhoneValue(phone?: WhatsAppApiStatus['phoneNumbers'][number] | null) {
  return phone?.phone_number || phone?.display_phone_number || ''
}

function getBusinessPhoneLabel(phone?: WhatsAppApiStatus['phoneNumbers'][number] | null) {
  return phone?.label || phone?.display_phone_number || phone?.phone_number || 'WhatsApp'
}

function isInsideReplyWindow(date?: string | null) {
  if (!date) return false
  const timestamp = Date.parse(date)
  if (!Number.isFinite(timestamp)) return false
  return Date.now() - timestamp < 24 * 60 * 60 * 1000
}

function toPaymentContact(contact: Contact | null) {
  if (!contact) return null
  return {
    id: contact.id,
    name: getContactName(contact),
    email: contact.email || '',
    phone: contact.phone || ''
  }
}

function toChatContact(contact: Contact): ChatContact {
  return {
    ...contact,
    lastMessageText: '',
    lastMessageDate: contact.createdAt,
    lastMessageDirection: '',
    messageCount: 0,
    unreadCount: 0
  }
}

function createDefaultAppointmentRange(timeZone: string) {
  const start = new Date()
  start.setMinutes(start.getMinutes() < 30 ? 30 : 60, 0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timeZone
  }
}

export const PhoneChat: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedContactParam = searchParams.get('contact')
  const requestedActionParam = searchParams.get('action')
  const { locationId, accessToken } = useAuth()
  const { labels } = useLabels()
  const { showToast } = useNotification()
  const { timezone, formatLocalDateShort, formatLocalDateTime } = useTimezone()
  const [defaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [calendarPushEnabled, setCalendarPushEnabled] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [chatPushEnabled, setChatPushEnabled] = useAppConfig<boolean>('chat_push_notifications_enabled', true)
  const [paymentPushEnabled, setPaymentPushEnabled] = useAppConfig<boolean>('payment_push_notifications_enabled', true)
  const [pushCalendarIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])
  const [whatsappNumberMode, setWhatsappNumberMode] = useAppConfig<WhatsAppNumberMode>('mobile_chat_whatsapp_number_mode', 'merged')
  const [selectedChatPhoneId, setSelectedChatPhoneId] = useAppConfig<string>('mobile_chat_selected_whatsapp_phone_id', 'all')
  const [selectedHighLevelChatChannel, setSelectedHighLevelChatChannel] = useAppConfig<HighLevelChatChannel>('mobile_chat_highlevel_channel', 'whatsapp_api')
  const [aiAgentChatEnabled, setAiAgentChatEnabled] = useAppConfig<boolean>('mobile_chat_ai_agent_enabled', true)
  const [showArchivedChats, setShowArchivedChats] = useAppConfig<boolean>('mobile_chat_show_archived', true)
  const [conversationSortMode, setConversationSortMode] = useAppConfig<ConversationSortMode>('mobile_chat_sort_mode', 'recent')
  const [showLastMessagePreview, setShowLastMessagePreview] = useAppConfig<boolean>('mobile_chat_show_last_preview', true)
  const [showUnreadIndicators, setShowUnreadIndicators] = useAppConfig<boolean>('mobile_chat_show_unread_indicators', true)
  const [aiReplySuggestionsEnabled, setAiReplySuggestionsEnabled] = useAppConfig<boolean>('mobile_chat_ai_reply_suggestions_enabled', false)
  const { connected: highLevelConnected } = useHighLevelConnected()
  const {
    safePreference: safeChatThemePreference,
    setPreference: setChatThemePreference,
    resolvedTheme: resolvedPhoneChatTheme,
    resolvedThemeLabel: resolvedPhoneChatThemeLabel,
    themeMeta: chatThemeMeta,
    systemThemeAvailable,
    deviceLabel: phoneThemeDeviceLabel
  } = usePhoneTheme({ active: false })

  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  const [chats, setChats] = useState<ChatContact[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  const [chatsRefreshing, setChatsRefreshing] = useState(false)
  const [chatsError, setChatsError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [archivedViewOpen, setArchivedViewOpen] = useState(false)
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>(() => readStoredChatIds(CHAT_ARCHIVED_STATE_KEY))
  const [mutedChatIds, setMutedChatIds] = useState<string[]>(() => readStoredChatIds(CHAT_MUTED_STATE_KEY))
  const [openSwipeChatId, setOpenSwipeChatId] = useState<string | null>(null)
  const [draggingSwipe, setDraggingSwipe] = useState<{ contactId: string; offset: number } | null>(null)
  const [chatSwipeSuppressed, setChatSwipeSuppressed] = useState(false)
  const [chatActionContactId, setChatActionContactId] = useState<string | null>(null)
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [activeContactId, setActiveContactId] = useState<string | null>(null)
  const [contactHighLevelChannelOverrides, setContactHighLevelChannelOverrides] = useState<Record<string, HighLevelChatChannel>>({})
  const [conversationOpen, setConversationOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [contactJourney, setContactJourney] = useState<JourneyEvent[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesRefreshing, setMessagesRefreshing] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<MobilePhotoAttachment[]>([])
  const [cameraSharePhoto, setCameraSharePhoto] = useState<MobilePhotoAttachment | null>(null)
  const [cameraShareQuery, setCameraShareQuery] = useState('')
  const [cameraShareCaption, setCameraShareCaption] = useState('')
  const [cameraShareSelectedContacts, setCameraShareSelectedContacts] = useState<Contact[]>([])
  const [cameraShareSending, setCameraShareSending] = useState(false)
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftAttachment | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [calendarsLoading, setCalendarsLoading] = useState(false)
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [sheet, setSheet] = useState<ActionSheet>(null)
  const [activeSettingsSection, setActiveSettingsSection] = useState<ChatSettingsSection>(null)
  const [contactInfoOpen, setContactInfoOpen] = useState(false)
  const [contactInfoContact, setContactInfoContact] = useState<Contact | null>(null)
  const [contactInfoLoading, setContactInfoLoading] = useState(false)
  const [contactInfoError, setContactInfoError] = useState('')
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single')
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [requestingPush, setRequestingPush] = useState(false)
  const [templateMode, setTemplateMode] = useState<TemplateMode>('choice')
  const [templates, setTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesRefreshing, setTemplatesRefreshing] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [templateSendingId, setTemplateSendingId] = useState<string | null>(null)
  const [creatingTemplate, setCreatingTemplate] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateBody, setNewTemplateBody] = useState('')
  const [newTemplateCategory, setNewTemplateCategory] = useState<MessageTemplateCategory>('utility')
  const [newTemplateLanguage, setNewTemplateLanguage] = useState('es_MX')
  const [aiMessages, setAiMessages] = useState<AIAgentMessage[]>(() => {
    const storedMessages = readAIAgentMobileMessages()
    return storedMessages.length > 0 ? storedMessages : [createAIAgentWelcomeMessage()]
  })
  const [aiMessageText, setAiMessageText] = useState('')
  const [aiSending, setAiSending] = useState(false)
  const [aiSuggestionLoading, setAiSuggestionLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesPaneRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLDivElement | null>(null)
  const cameraShareCaptionRef = useRef<HTMLDivElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const photosInputRef = useRef<HTMLInputElement | null>(null)
  const photoPickDestinationRef = useRef<PhotoPickDestination>('chat')
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtRef = useRef(0)
  const voiceTimerRef = useRef<number | null>(null)
  const voiceCancelRef = useRef(false)
  const chatSwipeGestureRef = useRef<ChatSwipeGesture | null>(null)
  const handledRouteAppointmentRef = useRef<string | null>(null)
  const closeSheetNow = useCallback(() => setSheet(null), [])
  const actionSheetDismiss = useBottomSheetDismiss({
    isOpen: Boolean(sheet),
    onClose: closeSheetNow
  })
  const chatSwipeGenerationRef = useRef(0)
  const ignoreNextChatClickRef = useRef(false)
  const resetPhoneFrameHorizontalScroll = useCallback(() => {
    const frame = document.querySelector<HTMLElement>('[data-phone-chat-frame="true"]')
    if (!frame || frame.scrollLeft === 0) return
    frame.scrollLeft = 0
  }, [])
  const handlePhoneFrameScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollLeft !== 0) {
      event.currentTarget.scrollLeft = 0
    }
  }, [])

  const aiAgentConversationOpen = activeContactId === AI_AGENT_CHAT_ID

  const handleMessagesPaneScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollLeft !== 0) {
      event.currentTarget.scrollLeft = 0
    }
  }, [])

  const activeContact = useMemo(
    () => aiAgentConversationOpen ? null : chats.find((contact) => contact.id === activeContactId) || null,
    [activeContactId, aiAgentConversationOpen, chats]
  )
  const conversationVisible = conversationOpen && (aiAgentConversationOpen || Boolean(activeContact))
  const conversationMessageItems = useMemo(() => {
    const items: Array<
      | { type: 'day'; key: string; label: string }
      | { type: 'message'; key: string; message: ChatMessage }
    > = []
    let previousDayKey = ''

    messages.forEach((message) => {
      const dayKey = getConversationDayKey(message.date, timezone)
      if (dayKey && dayKey !== previousDayKey) {
        items.push({
          type: 'day',
          key: dayKey,
          label: getConversationDayLabel(message.date, timezone)
        })
        previousDayKey = dayKey
      }
      items.push({
        type: 'message',
        key: message.id,
        message
      })
    })

    return items
  }, [messages, timezone])
  const contactInfoData = contactInfoContact || activeContact
  const chatActionContact = useMemo(
    () => chats.find((contact) => contact.id === chatActionContactId) || activeContact || null,
    [activeContact, chatActionContactId, chats]
  )
  const contactInfoPayments = useMemo(
    () => getContactInfoPayments(contactInfoData, contactJourney),
    [contactInfoData, contactJourney]
  )
  const contactInfoAppointments = useMemo(
    () => getContactInfoAppointments(contactInfoData, contactJourney),
    [contactInfoData, contactJourney]
  )
  const contactInfoTracking = useMemo(
    () => getTrackingData(contactInfoData, contactJourney),
    [contactInfoData, contactJourney]
  )
  const contactInfoResolvedMetaAttribution = useMemo(
    () => getResolvedMetaAttribution(contactInfoData, contactJourney),
    [contactInfoData, contactJourney]
  )
  const contactInfoSource = useMemo(() => {
    const normalizedSource = normalizeTrafficSource(contactInfoTracking)
    return normalizedSource && normalizedSource !== 'Desconocido'
      ? normalizedSource
      : getReadableValue(contactInfoData?.source)
  }, [contactInfoData?.source, contactInfoTracking])
  const contactInfoStageBadge = useMemo(
    () => getContactStageBadge(contactInfoData, labels),
    [contactInfoData, labels]
  )
  const contactInfoSuccessfulPayments = useMemo(
    () => contactInfoPayments.filter(isSuccessfulPayment),
    [contactInfoPayments]
  )
  const contactInfoActiveAppointments = useMemo(
    () => contactInfoAppointments.filter(isActiveAppointment),
    [contactInfoAppointments]
  )
  const contactInfoJourneyEvents = useMemo(
    () => buildContactInfoJourney(contactJourney, timezone, contactInfoResolvedMetaAttribution),
    [contactInfoResolvedMetaAttribution, contactJourney, timezone]
  )

  const selectedCalendar = useMemo(
    () => calendars.find((calendar) => calendar.id === selectedCalendarId) || calendars[0] || null,
    [calendars, selectedCalendarId]
  )

  const initialContact = useMemo(() => toPaymentContact(activeContact), [activeContact])
  const activePhonePaymentMode: PaymentMode = highLevelConnected ? paymentMode : 'single'
  const defaultAppointmentRange = useMemo(() => createDefaultAppointmentRange(timezone), [timezone])
  const whatsappConnected = Boolean(whatsappStatus?.connected && whatsappStatus?.configured)
  const businessPhones = whatsappStatus?.phoneNumbers || []
  const chatPhoneFilterEnabled = whatsappNumberMode === 'separated' && businessPhones.length > 1
  const selectedChatPhone = useMemo(() => (
    businessPhones.find((phone) => phone.id === selectedChatPhoneId) || null
  ), [businessPhones, selectedChatPhoneId])
  const selectedChatPhoneFilterActive = Boolean(chatPhoneFilterEnabled && selectedChatPhoneId !== 'all' && selectedChatPhone)
  const effectiveSelectedChatPhoneId = selectedChatPhoneFilterActive ? selectedChatPhoneId : 'all'
  const effectiveSelectedChatPhone = selectedChatPhoneFilterActive ? selectedChatPhone : null
  const selectedBusinessPhone = useMemo(() => {
    const preferredBusinessPhoneId = activeContact?.preferredWhatsAppPhoneNumberId ||
      activeContact?.preferred_whatsapp_phone_number_id ||
      ''
    const fromContactPreference = preferredBusinessPhoneId
      ? businessPhones.find((phone) => phone.id === preferredBusinessPhoneId)
      : null

    const newestInboundMessageWithBusinessPhone = [...messages]
      .filter((message) => message.direction === 'inbound' && (message.businessPhoneNumberId || message.businessPhone))
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0] || null
    const newestMessageWithBusinessPhone = [...messages]
      .filter((message) => message.businessPhoneNumberId || message.businessPhone)
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0] || null

    const fromInboundMessageId = newestInboundMessageWithBusinessPhone?.businessPhoneNumberId
      ? businessPhones.find((phone) => phone.id === newestInboundMessageWithBusinessPhone.businessPhoneNumberId)
      : null
    const fromInboundMessagePhone = newestInboundMessageWithBusinessPhone?.businessPhone
      ? businessPhones.find((phone) => phoneLooksSame(getBusinessPhoneValue(phone), newestInboundMessageWithBusinessPhone.businessPhone))
      : null
    const fromMessageId = newestMessageWithBusinessPhone?.businessPhoneNumberId
      ? businessPhones.find((phone) => phone.id === newestMessageWithBusinessPhone.businessPhoneNumberId)
      : null
    const fromMessagePhone = newestMessageWithBusinessPhone?.businessPhone
      ? businessPhones.find((phone) => phoneLooksSame(getBusinessPhoneValue(phone), newestMessageWithBusinessPhone.businessPhone))
      : null
    const fromChatInboundId = activeContact?.lastInboundBusinessPhoneNumberId
      ? businessPhones.find((phone) => phone.id === activeContact.lastInboundBusinessPhoneNumberId)
      : null
    const fromChatInboundPhone = activeContact?.lastInboundBusinessPhone
      ? businessPhones.find((phone) => phoneLooksSame(getBusinessPhoneValue(phone), activeContact.lastInboundBusinessPhone))
      : null
    const fromChatId = activeContact?.lastBusinessPhoneNumberId
      ? businessPhones.find((phone) => phone.id === activeContact.lastBusinessPhoneNumberId)
      : null
    const fromChatPhone = activeContact?.lastBusinessPhone
      ? businessPhones.find((phone) => phoneLooksSame(getBusinessPhoneValue(phone), activeContact.lastBusinessPhone))
      : null

    return fromContactPreference ||
      fromInboundMessageId ||
      fromInboundMessagePhone ||
      fromChatInboundId ||
      fromChatInboundPhone ||
      fromMessageId ||
      fromMessagePhone ||
      fromChatId ||
      fromChatPhone ||
      businessPhones.find((phone) => phone.is_default_sender) ||
      whatsappStatus?.selectedPhone ||
      businessPhones[0] ||
      null
  }, [
    activeContact?.lastInboundBusinessPhone,
    activeContact?.lastInboundBusinessPhoneNumberId,
    activeContact?.lastBusinessPhone,
    activeContact?.lastBusinessPhoneNumberId,
    activeContact?.preferredWhatsAppPhoneNumberId,
    activeContact?.preferred_whatsapp_phone_number_id,
    businessPhones,
    messages,
    whatsappStatus?.selectedPhone
  ])
  const selectedBusinessPhoneValue = getBusinessPhoneValue(selectedBusinessPhone)
  const cameraShareBusinessPhone = useMemo(() => (
    effectiveSelectedChatPhone ||
    businessPhones.find((phone) => phone.is_default_sender) ||
    whatsappStatus?.selectedPhone ||
    businessPhones[0] ||
    null
  ), [businessPhones, effectiveSelectedChatPhone, whatsappStatus?.selectedPhone])
  const cameraShareBusinessPhoneValue = getBusinessPhoneValue(cameraShareBusinessPhone)
  const lastInboundForSelectedPhone = useMemo(() => {
    return [...messages]
      .filter((message) => {
        if (message.direction !== 'inbound') return false
        if (!selectedBusinessPhoneValue) return true
        return phoneLooksSame(message.businessPhone, selectedBusinessPhoneValue)
      })
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0] || null
  }, [messages, selectedBusinessPhoneValue])
  const apiReplyWindowOpen = isInsideReplyWindow(lastInboundForSelectedPhone?.date)
  const selectedQrReady = Boolean(selectedBusinessPhone?.qr_send_enabled && String(selectedBusinessPhone?.qr_status || '').toLowerCase() === 'connected')
  const outsideReplyWindow = Boolean(activeContact?.phone && !apiReplyWindowOpen)
  const inferredHighLevelChatChannel = useMemo(() => inferHighLevelChatChannel(activeContact, messages), [activeContact, messages])
  const activeContactHighLevelChannelOverride = activeContact?.id ? contactHighLevelChannelOverrides[activeContact.id] : undefined
  const inferredSocialHighLevelChannel = highLevelConnected && (inferredHighLevelChatChannel === 'instagram' || inferredHighLevelChatChannel === 'messenger')
    ? inferredHighLevelChatChannel
    : ''
  const activeHighLevelChatChannel = activeContactHighLevelChannelOverride || inferredSocialHighLevelChannel || selectedHighLevelChatChannel
  const activeHighLevelChannelNeedsPhone = activeHighLevelChatChannel === 'whatsapp_api' || activeHighLevelChatChannel === 'sms_qr'
  const sendingThroughHighLevel = Boolean(highLevelConnected && activeContact)
  const selectedChannelCanSend = sendingThroughHighLevel
    ? Boolean(activeContact?.id && (!activeHighLevelChannelNeedsPhone || activeContact.phone))
    : Boolean(activeContact?.phone)
  const composerBlockedByReplyWindow = Boolean(outsideReplyWindow && !selectedQrReady && !sendingThroughHighLevel)
  const hasComposerContent = Boolean(messageText.trim() || draftAttachments.length > 0 || voiceDraft)
  const canSendMessage = Boolean(selectedChannelCanSend && hasComposerContent && composerStatus !== 'sending' && !voiceRecording && !composerBlockedByReplyWindow)
  const composerInputDisabled = Boolean(!selectedChannelCanSend || composerStatus === 'sending' || voiceRecording || voiceDraft)
  const composerPlaceholder = voiceRecording
    ? 'Grabando...'
    : voiceDraft
      ? 'Audio listo'
      : selectedChannelCanSend
        ? ''
        : activeContact && sendingThroughHighLevel && activeHighLevelChannelNeedsPhone
          ? 'Sin teléfono'
          : activeContact
            ? 'Canal no disponible'
            : 'Sin contacto'
  const activeTemplateAlerts = useMemo(() => (
    (whatsappStatus?.alerts?.items || []).filter((alert) => String(alert.entity_type || '').toLowerCase() === 'template')
  ), [whatsappStatus?.alerts?.items])
  const templateAlertByEntity = useMemo(() => {
    const alertMap = new Map<string, string>()
    activeTemplateAlerts.forEach((alert) => {
      if (alert.entity_id) alertMap.set(alert.entity_id, alert.message || alert.title)
    })
    return alertMap
  }, [activeTemplateAlerts])
  const hasChats = chats.length > 0
  const archivedChatIdSet = useMemo(() => new Set(archivedChatIds), [archivedChatIds])
  const mutedChatIdSet = useMemo(() => new Set(mutedChatIds), [mutedChatIds])
  const archivedChatCount = archivedChatIds.length
  const listBaseChats = useMemo(
    () => chats.filter((contact) => archivedViewOpen ? archivedChatIdSet.has(contact.id) : !archivedChatIdSet.has(contact.id)),
    [archivedChatIdSet, archivedViewOpen, chats]
  )
  const customerLabel = labels.customer?.trim() || 'Cliente'
  const leadLabel = labels.lead?.trim() || 'Interesado'
  const customersLabel = labels.customers?.trim() || 'Clientes'
  const leadsLabel = labels.leads?.trim() || 'Interesados'
  const isCustomerContact = useCallback((contact: ChatContact) => contact.status === 'customer' || Number(contact.purchases || 0) > 0, [])
  const isAppointmentContact = useCallback((contact: ChatContact) => contact.status === 'appointment' || Boolean(contact.hasAppointments), [])
  const isLeadContact = useCallback((contact: ChatContact) => {
    if (isCustomerContact(contact) || isAppointmentContact(contact)) return false
    return contact.status === 'lead'
  }, [isAppointmentContact, isCustomerContact])
  const filteredChats = useMemo(() => {
    const phoneFilteredChats = selectedChatPhoneFilterActive && effectiveSelectedChatPhone
      ? listBaseChats.filter((contact) => {
          if (contact.lastBusinessPhoneNumberId && contact.lastBusinessPhoneNumberId === effectiveSelectedChatPhoneId) return true
          return phoneLooksSame(contact.lastBusinessPhone, getBusinessPhoneValue(effectiveSelectedChatPhone))
        })
      : listBaseChats

    const chipFilteredChats = phoneFilteredChats.filter((contact) => {
      if (chatFilter === 'unread') return Number(contact.unreadCount || 0) > 0
      if (chatFilter === 'appointments') return isAppointmentContact(contact)
      if (chatFilter === 'customers') return isCustomerContact(contact)
      if (chatFilter === 'leads') return isLeadContact(contact)
      return true
    })

    if (conversationSortMode !== 'unread') return chipFilteredChats

    return [...chipFilteredChats].sort((left, right) => {
      const unreadDelta = Number(right.unreadCount || 0) - Number(left.unreadCount || 0)
      if (unreadDelta !== 0) return unreadDelta
      return Date.parse(right.lastMessageDate || right.createdAt) - Date.parse(left.lastMessageDate || left.createdAt)
    })
  }, [
    chatFilter,
    conversationSortMode,
    effectiveSelectedChatPhone,
    effectiveSelectedChatPhoneId,
    isAppointmentContact,
    isCustomerContact,
    isLeadContact,
    listBaseChats,
    selectedChatPhoneFilterActive
  ])
  const unreadTotal = useMemo(
    () => chats.reduce((total, contact) => (
      archivedChatIdSet.has(contact.id) ? total : total + Math.max(0, Number(contact.unreadCount || 0))
    ), 0),
    [archivedChatIdSet, chats]
  )
  const chatSearchExpanded = chatQuery.trim().length > 0
  const cameraShareSelectedIds = useMemo(
    () => new Set(cameraShareSelectedContacts.map((contact) => contact.id)),
    [cameraShareSelectedContacts]
  )
  const cameraShareContactOptions = useMemo(() => {
    if (!cameraSharePhoto) return []

    const normalizedQuery = cameraShareQuery.trim()
    const seen = new Set<string>()
    const recentChats = [...chats]
      .filter((contact) => contact.phone && contactMatchesQuery(contact, normalizedQuery))
      .sort((left, right) => Date.parse(right.lastMessageDate || right.createdAt) - Date.parse(left.lastMessageDate || left.createdAt))
    const searchedContacts = contactResults
      .filter((contact) => contact.phone && contactMatchesQuery(contact, normalizedQuery))

    return [...recentChats, ...searchedContacts].filter((contact) => {
      if (seen.has(contact.id)) return false
      seen.add(contact.id)
      return true
    })
  }, [cameraSharePhoto, cameraShareQuery, chats, contactResults])
  const ensureChatContact = useCallback((contact: Contact) => {
    const nextContact = toChatContact(contact)
    setChats((current) => {
      if (current.some((item) => item.id === nextContact.id)) return current
      return [nextContact, ...current]
    })
    return nextContact
  }, [])

  const applyLoadedChats = useCallback((loadedChats: ChatContact[], requestedContact?: ChatContact | null) => {
    const readState = ensureReadBaselines(loadedChats, readChatReadState())
    let nextChats = loadedChats.map((contact) => applyLocalUnreadState(contact, readState))

    if (activeContactId && conversationOpen) {
      const activeLoadedContact = nextChats.find((contact) => contact.id === activeContactId)
      if (activeLoadedContact) {
        markContactReadState(activeLoadedContact)
        nextChats = nextChats.map((contact) => (
          contact.id === activeContactId ? { ...contact, unreadCount: 0 } : contact
        ))
      }
    }
    syncReadStateForVisibleReadChats(nextChats, readState)

    setChats(nextChats)
    setActiveContactId((current) => {
      if (requestedContact) return requestedContact.id
      if (current === AI_AGENT_CHAT_ID && aiAgentChatEnabled) return current
      if (current && nextChats.some((contact) => contact.id === current)) return current
      return null
    })

    if (requestedContact) {
      setConversationOpen(true)
    }

    return nextChats
  }, [activeContactId, aiAgentChatEnabled, conversationOpen])

  const loadChats = useCallback(async (options: { showCacheRefresh?: boolean } = {}) => {
    const showCacheRefresh = options.showCacheRefresh === true
    setChatsError('')
    const trimmed = chatQuery.trim()
    const phoneFilterParams: Record<string, string> = selectedChatPhoneFilterActive && effectiveSelectedChatPhone
      ? {
          businessPhoneNumberId: effectiveSelectedChatPhoneId,
          businessPhone: getBusinessPhoneValue(effectiveSelectedChatPhone)
        }
      : {}
    const cacheEnabled = !trimmed
    const cacheKey = getPhoneDailyCacheKey(
      'phone-chat',
      'chats',
      locationId || 'default',
      effectiveSelectedChatPhoneId,
      phoneFilterParams.businessPhone || 'all'
    )
    const cachedChats = cacheEnabled ? readPhoneDailyCache<ChatContact[]>(cacheKey) : null
    const showedCachedChats = Boolean(cachedChats)

    if (cachedChats) {
      const cachedList = Array.isArray(cachedChats.data) ? cachedChats.data : []
      const cachedRequestedContact = requestedContactParam
        ? cachedList.find((contact) => contact.id === requestedContactParam) || null
        : null
      applyLoadedChats(cachedList, cachedRequestedContact)
      setChatsLoading(false)
      setChatsRefreshing(showCacheRefresh)
    } else {
      setChatsLoading(true)
      setChatsRefreshing(false)
    }

    try {
      const params: Record<string, string> = {
        limit: '60',
        ...(trimmed ? { q: trimmed } : {}),
        ...phoneFilterParams
      }

      const data = await apiClient.get<ChatContact[]>('/contacts/chats', { params })

      let nextChats = Array.isArray(data) ? data : []
      let requestedContact = requestedContactParam
        ? nextChats.find((contact) => contact.id === requestedContactParam)
        : null

      if (requestedContactParam && !requestedContact) {
        const contact = await contactsService.getContactDetails(requestedContactParam).catch(() => null)
        if (contact) {
          requestedContact = toChatContact(contact)
          nextChats = [requestedContact, ...nextChats.filter((item) => item.id !== contact.id)]
        }
      }

      const displayedChats = applyLoadedChats(nextChats, requestedContact)
      if (cacheEnabled) {
        writePhoneDailyCache(cacheKey, displayedChats.slice(0, 80), { maxEntryChars: 360_000 })
      }
    } catch {
      if (!showedCachedChats) {
        setChatsError('No se pudieron cargar los chats.')
        setChats([])
      }
    } finally {
      setChatsLoading(false)
      setChatsRefreshing(false)
    }
  }, [
    applyLoadedChats,
    chatQuery,
    effectiveSelectedChatPhone,
    effectiveSelectedChatPhoneId,
    locationId,
    requestedContactParam,
    selectedChatPhoneFilterActive
  ])

  const loadContactResults = useCallback(async (query: string) => {
    setContactsLoading(true)

    try {
      const trimmed = query.trim()
      const data = trimmed.length >= 2
        ? await contactsService.searchContacts(trimmed)
        : await apiClient.get<Contact[]>('/contacts', {
            params: {
              page: '1',
              limit: '40',
              sortBy: 'created_at',
              sortOrder: 'DESC'
            }
          })

      setContactResults(Array.isArray(data) ? data : [])
    } catch {
      setContactResults([])
    } finally {
      setContactsLoading(false)
    }
  }, [])

  const loadConversation = useCallback(async (contactId: string, options: { showCacheRefresh?: boolean } = {}) => {
    const showCacheRefresh = options.showCacheRefresh === true
    const cacheKey = getPhoneDailyCacheKey('phone-chat', 'conversation', locationId || 'default', contactId)
    const cachedConversation = readPhoneDailyCache<{ journey: JourneyEvent[]; messages: ChatMessage[] }>(cacheKey)
    const showedCachedConversation = Boolean(cachedConversation)

    if (cachedConversation) {
      setContactJourney(Array.isArray(cachedConversation.data.journey) ? cachedConversation.data.journey : [])
      setMessages(Array.isArray(cachedConversation.data.messages) ? cachedConversation.data.messages : [])
      setMessagesLoading(false)
      setMessagesRefreshing(showCacheRefresh)
    } else {
      setMessagesLoading(true)
      setMessagesRefreshing(false)
    }

    try {
      const journey = await contactsService.getContactJourney(contactId)
      setContactJourney(journey)
      const nextMessages = journey
        .map(getJourneyMessage)
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())

      setMessages(nextMessages)
      writePhoneDailyCache(cacheKey, { journey, messages: nextMessages }, { maxEntryChars: 360_000 })
    } catch {
      if (!showedCachedConversation) {
        setMessages([])
        setContactJourney([])
      }
    } finally {
      setMessagesLoading(false)
      setMessagesRefreshing(false)
    }
  }, [locationId])

  const loadSupportData = useCallback(async () => {
    const statusCacheKey = getPhoneDailyCacheKey('phone-chat', 'whatsapp-status', locationId || 'default')
    const calendarsCacheKey = getPhoneDailyCacheKey('phone-chat', 'calendars', locationId || 'default')
    const cachedStatus = readPhoneDailyCache<WhatsAppApiStatus>(statusCacheKey)
    const cachedCalendars = readPhoneDailyCache<Calendar[]>(calendarsCacheKey)
    const applyCalendars = (items: Calendar[]) => {
      const availableItems = items.filter((calendar) => calendar.isActive !== false)
      setCalendars(availableItems)
      const preferred = availableItems.find((calendar) => calendar.id === defaultCalendarId)
      setSelectedCalendarId((current) => (
        availableItems.some((calendar) => calendar.id === current)
          ? current
          : preferred?.id || availableItems[0]?.id || ''
      ))
      return availableItems
    }

    if (cachedStatus) setWhatsappStatus(cachedStatus.data)
    const cachedAvailableCalendars = cachedCalendars
      ? applyCalendars(Array.isArray(cachedCalendars.data) ? cachedCalendars.data : [])
      : []
    setCalendarsLoading(cachedAvailableCalendars.length === 0)

    const [status, calendarItems] = await Promise.all([
      whatsappApiService.getStatus().catch(() => null),
      calendarsService.getCalendars(locationId, accessToken).catch(() => [])
    ])

    if (status) {
      setWhatsappStatus(status)
      writePhoneDailyCache(statusCacheKey, status, { maxEntryChars: 180_000 })
    }
    if (Array.isArray(calendarItems)) {
      applyCalendars(calendarItems)
      writePhoneDailyCache(calendarsCacheKey, calendarItems, { maxEntryChars: 180_000 })
    } else if (!cachedCalendars) {
      setCalendars([])
    }
    setCalendarsLoading(false)
  }, [accessToken, defaultCalendarId, locationId])

  const loadTemplates = useCallback(async () => {
    setTemplatesError('')
    const cacheKey = getPhoneDailyCacheKey('phone-chat', 'templates', locationId || 'default')
    const cachedTemplates = readPhoneDailyCache<{ status: WhatsAppApiStatus | null; templates: WhatsAppApiTemplate[] }>(cacheKey)
    const showedCachedTemplates = Boolean(cachedTemplates)

    if (cachedTemplates) {
      if (cachedTemplates.data.status) setWhatsappStatus(cachedTemplates.data.status)
      setTemplates(Array.isArray(cachedTemplates.data.templates) ? cachedTemplates.data.templates : [])
      setTemplatesLoading(false)
      setTemplatesRefreshing(true)
    } else {
      setTemplatesLoading(true)
      setTemplatesRefreshing(false)
    }

    try {
      const refreshedStatus = await whatsappApiService.refresh().catch(() => null)
      const [status, response] = await Promise.all([
        refreshedStatus ? Promise.resolve(refreshedStatus) : whatsappApiService.getStatus().catch(() => null),
        whatsappApiService.getTemplates()
      ])

      if (status) setWhatsappStatus(status)
      const nextTemplates = Array.isArray(response.items) ? response.items : []
      setTemplates(nextTemplates)
      writePhoneDailyCache(cacheKey, { status, templates: nextTemplates }, { maxEntryChars: 280_000 })
    } catch (error) {
      if (!showedCachedTemplates) {
        setTemplates([])
        setTemplatesError(getErrorMessage(error, 'No se pudieron cargar las plantillas.'))
      }
    } finally {
      setTemplatesLoading(false)
      setTemplatesRefreshing(false)
    }
  }, [locationId])

  const saveConfigPreference = useCallback(<T,>(setter: (value: T) => Promise<void>, value: T) => {
    setter(value).catch(() => showToast('error', 'No se guardó la configuración', 'Intenta otra vez.'))
  }, [showToast])

  useEffect(() => {
    document.title = aiAgentConversationOpen
      ? 'Agente de IA | Ristak Chat'
      : activeContact ? `${getContactName(activeContact)} | Ristak Chat` : 'Ristak Chat'
  }, [activeContact, aiAgentConversationOpen])

  useEffect(() => {
    writeAIAgentMobileMessages(aiMessages)
  }, [aiMessages])

  useEffect(() => {
    writeStoredChatIds(CHAT_ARCHIVED_STATE_KEY, archivedChatIds)
  }, [archivedChatIds])

  useEffect(() => {
    writeStoredChatIds(CHAT_MUTED_STATE_KEY, mutedChatIds)
  }, [mutedChatIds])

  useEffect(() => {
    chatSwipeGenerationRef.current += 1
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
  }, [archivedViewOpen, chatFilter, chatQuery, selectedChatPhoneId])

  useLayoutEffect(() => {
    resetPhoneFrameHorizontalScroll()
    const frameId = window.requestAnimationFrame(resetPhoneFrameHorizontalScroll)
    return () => window.cancelAnimationFrame(frameId)
  }, [cameraSharePhoto, contactInfoOpen, conversationVisible, resetPhoneFrameHorizontalScroll])

  useLayoutEffect(() => {
    chatSwipeGenerationRef.current += 1
    setChatSwipeSuppressed(true)
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
    chatSwipeGestureRef.current = null

    if (conversationVisible) return

    const releaseSwipe = window.setTimeout(() => {
      chatSwipeGenerationRef.current += 1
      setOpenSwipeChatId(null)
      setDraggingSwipe(null)
      chatSwipeGestureRef.current = null
      setChatSwipeSuppressed(false)
    }, 320)

    return () => window.clearTimeout(releaseSwipe)
  }, [conversationVisible])

  useLayoutEffect(() => {
    if (!activeContactId) return
    chatSwipeGenerationRef.current += 1
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
    chatSwipeGestureRef.current = null
  }, [activeContactId])

  useEffect(() => {
    if (showArchivedChats) return
    setArchivedViewOpen(false)
  }, [showArchivedChats])

  useEffect(() => {
    if (!chatPhoneFilterEnabled || selectedChatPhoneId === 'all') return
    if (businessPhones.some((phone) => phone.id === selectedChatPhoneId)) return
    setSelectedChatPhoneId('all').catch(() => undefined)
  }, [businessPhones, chatPhoneFilterEnabled, selectedChatPhoneId, setSelectedChatPhoneId])

  useEffect(() => {
    if (aiAgentChatEnabled || !aiAgentConversationOpen) return
    setConversationOpen(false)
    setActiveContactId(null)
  }, [aiAgentChatEnabled, aiAgentConversationOpen])

  useEffect(() => {
    if (aiAgentChatEnabled || !aiReplySuggestionsEnabled) return
    setAiReplySuggestionsEnabled(false).catch(() => undefined)
  }, [aiAgentChatEnabled, aiReplySuggestionsEnabled, setAiReplySuggestionsEnabled])

  useEffect(() => {
    if (highLevelConnected || paymentMode !== 'partial') return
    setPaymentMode('single')
  }, [highLevelConnected, paymentMode])

  useEffect(() => {
    const updateAccess = () => setAccessState(getAccessState())
    const portableMedia = window.matchMedia(PORTABLE_WIDTH_QUERY)
    const phoneMedia = window.matchMedia(PHONE_WIDTH_QUERY)
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    portableMedia.addEventListener('change', updateAccess)
    phoneMedia.addEventListener('change', updateAccess)
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
      portableMedia.removeEventListener('change', updateAccess)
      phoneMedia.removeEventListener('change', updateAccess)
      pointerMedia.removeEventListener('change', updateAccess)
      window.removeEventListener('resize', updateAccess)
      window.removeEventListener('orientationchange', updateAccess)
      window.visualViewport?.removeEventListener('resize', updateAccess)
    }
  }, [])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const html = document.documentElement
    const body = document.body
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const previousViewportContent = viewportMeta?.getAttribute('content') || ''
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlHeight = html.style.height
    const previousHtmlOverscroll = html.style.overscrollBehavior
    const previousHtmlTextSizeAdjust = html.style.getPropertyValue('-webkit-text-size-adjust')
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    const previousBodyTextSizeAdjust = body.style.getPropertyValue('-webkit-text-size-adjust')
    let startX = 0
    let startY = 0

    if (viewportMeta) {
      viewportMeta.setAttribute(
        'content',
        'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content'
      )
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    html.style.setProperty('-webkit-text-size-adjust', '100%')
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'
    body.style.setProperty('-webkit-text-size-adjust', '100%')

    const keepViewportStable = (input?: boolean | Event) => {
      const force = input === true
      if (!force && html.getAttribute('data-phone-chat-keyboard') !== 'true') return

      window.setTimeout(() => {
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
        html.scrollTop = 0
        body.scrollTop = 0
        if (html.getAttribute('data-phone-chat-keyboard') === 'true') {
          messagesEndRef.current?.scrollIntoView({ block: 'end' })
        }
      }, 60)
    }

    const resetViewportAfterKeyboard = () => {
      window.setTimeout(() => {
        html.removeAttribute('data-phone-chat-keyboard')
        window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
        html.scrollTop = 0
        body.scrollTop = 0
      }, 90)
    }

    const getScrollableElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_CHAT_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const handleTouchStart = (event: TouchEvent) => {
      startX = event.touches[0]?.clientX || 0
      startY = event.touches[0]?.clientY || 0
    }

    const handleTouchMove = (event: TouchEvent) => {
      const scrollable = getScrollableElement(event.target)
      if (!scrollable) {
        event.preventDefault()
        return
      }

      const currentX = event.touches[0]?.clientX || startX
      const currentY = event.touches[0]?.clientY || startY
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const canScrollX = scrollable.scrollWidth > scrollable.clientWidth + 1
      const canScrollY = scrollable.scrollHeight > scrollable.clientHeight + 1

      if (canScrollX && Math.abs(deltaX) > Math.abs(deltaY)) {
        const atLeft = scrollable.scrollLeft <= 0
        const atRight = scrollable.scrollLeft + scrollable.clientWidth >= scrollable.scrollWidth - 1

        if ((atLeft && deltaX > 0) || (atRight && deltaX < 0)) {
          event.preventDefault()
        }
        return
      }

      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1

      if (!canScrollY || (atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        event.preventDefault()
      }
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest('[data-phone-chat-composer="true"]')) return

      html.setAttribute('data-phone-chat-keyboard', 'true')
      keepViewportStable(true)
    }

    const handleFocusOut = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return
      if (!event.target.closest('[data-phone-chat-composer="true"]')) return

      resetViewportAfterKeyboard()
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('focusin', handleFocusIn)
    window.addEventListener('focusout', handleFocusOut)
    window.visualViewport?.addEventListener('resize', keepViewportStable)
    window.visualViewport?.addEventListener('scroll', keepViewportStable)

    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('focusin', handleFocusIn)
      window.removeEventListener('focusout', handleFocusOut)
      window.visualViewport?.removeEventListener('resize', keepViewportStable)
      window.visualViewport?.removeEventListener('scroll', keepViewportStable)
      html.removeAttribute('data-phone-chat-keyboard')
      if (viewportMeta) {
        viewportMeta.setAttribute('content', previousViewportContent)
      }
      html.style.overflow = previousHtmlOverflow
      html.style.height = previousHtmlHeight
      html.style.overscrollBehavior = previousHtmlOverscroll
      html.style.setProperty('-webkit-text-size-adjust', previousHtmlTextSizeAdjust)
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
      body.style.setProperty('-webkit-text-size-adjust', previousBodyTextSizeAdjust)
    }
  }, [accessState])

  useEffect(() => {
    if (accessState !== 'allowed') return
    const timer = window.setTimeout(() => {
      loadChats()
    }, chatQuery.trim() ? 140 : 0)

    return () => window.clearTimeout(timer)
  }, [accessState, chatQuery, loadChats])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const refreshVisibleChats = () => {
      if (document.visibilityState === 'visible') {
        loadChats()
      }
    }
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !chatQuery.trim()) {
        loadChats()
      }
    }, 20000)

    window.addEventListener('focus', refreshVisibleChats)
    document.addEventListener('visibilitychange', refreshVisibleChats)

    return () => {
      window.clearInterval(refreshInterval)
      window.removeEventListener('focus', refreshVisibleChats)
      document.removeEventListener('visibilitychange', refreshVisibleChats)
    }
  }, [accessState, chatQuery, loadChats])

  useEffect(() => {
    if (accessState !== 'allowed') return
    loadSupportData()
  }, [accessState, loadSupportData])

  useEffect(() => {
    if (!activeContact?.id || accessState !== 'allowed') {
      setMessages([])
      setContactJourney([])
      return
    }
    loadConversation(activeContact.id)
  }, [accessState, activeContact?.id, loadConversation])

  const shouldRefreshReceipts = useMemo(
    () => messages.some(shouldTrackOutboundReceipt),
    [messages]
  )

  useEffect(() => {
    if (!activeContact?.id || accessState !== 'allowed' || !conversationVisible || !shouldRefreshReceipts) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadConversation(activeContact.id, { showCacheRefresh: true })
      }
    }, 12000)

    return () => window.clearInterval(interval)
  }, [accessState, activeContact?.id, conversationVisible, loadConversation, shouldRefreshReceipts])

  useEffect(() => {
    if (!conversationOpen || conversationVisible || chatsLoading) return

    setActiveContactId(null)
    setConversationOpen(false)
    setContactInfoOpen(false)
    setContactInfoContact(null)
    setContactInfoError('')
    setContactInfoLoading(false)
    setMessages([])
    setContactJourney([])
    setDraftAttachments([])
    setVoiceDraft(null)
  }, [chatsLoading, conversationOpen, conversationVisible])

  useEffect(() => {
    setContactInfoOpen(false)
    setContactInfoContact(null)
    setContactInfoError('')
    setContactInfoLoading(false)
  }, [activeContactId])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const shouldSearchContacts = sheet === 'newChat' || Boolean(cameraSharePhoto) || (!hasChats && chatQuery.trim().length >= 2)
    if (!shouldSearchContacts) {
      setContactResults([])
      return
    }

    const timer = window.setTimeout(() => {
      loadContactResults(sheet === 'newChat' ? contactQuery : cameraSharePhoto ? cameraShareQuery : chatQuery)
    }, 160)

    return () => window.clearTimeout(timer)
  }, [accessState, cameraSharePhoto, cameraShareQuery, chatQuery, contactQuery, hasChats, loadContactResults, sheet])

  useEffect(() => {
    if (sheet !== 'settings') {
      setActiveSettingsSection(null)
    }
    if (sheet !== 'chatMore') {
      setChatActionContactId(null)
    }
  }, [sheet])

  useEffect(() => {
    if (accessState !== 'allowed') return

    if (sheet === 'templates') {
      setTemplateMode('choice')
      loadTemplates()
      return
    }

    if (sheet === 'settings' && activeSettingsSection === 'templates') {
      setTemplateMode((current) => (current === 'choice' ? 'send' : current))
      loadTemplates()
    }
  }, [accessState, activeSettingsSection, loadTemplates, sheet])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, messagesLoading, conversationOpen])

  useEffect(() => {
    return () => {
      if (voiceTimerRef.current) {
        window.clearInterval(voiceTimerRef.current)
        voiceTimerRef.current = null
      }
      voiceRecorderRef.current = null
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
      voiceStreamRef.current = null
    }
  }, [])

  const clearVoiceTimer = () => {
    if (!voiceTimerRef.current) return
    window.clearInterval(voiceTimerRef.current)
    voiceTimerRef.current = null
  }

  const stopVoiceStream = () => {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    voiceStreamRef.current = null
  }

  const handleStopVoiceRecording = () => {
    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
    }
  }

  const handleCancelVoiceDraft = () => {
    voiceCancelRef.current = true
    setVoiceDraft(null)
    setVoiceElapsedMs(0)

    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
      return
    }

    clearVoiceTimer()
    stopVoiceStream()
    setVoiceRecording(false)
    voiceCancelRef.current = false
  }

  const handleStartVoiceRecording = async () => {
    if (!activeContact?.phone) {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar audio por WhatsApp.')
      return
    }

    if (messageText.trim() || draftAttachments.length > 0) {
      showToast('info', 'Manda primero lo que ya tienes', 'Para evitar confusiones, envía o borra el texto/foto antes de grabar audio.')
      return
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('error', 'Este celular no puede grabar aquí', 'Abre Ristak desde la app o desde un navegador con permiso de micrófono.')
      return
    }

    try {
      const mimeType = getSupportedVoiceMimeType()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      voiceCancelRef.current = false
      voiceChunksRef.current = []
      voiceStreamRef.current = stream
      voiceRecorderRef.current = recorder
      voiceStartedAtRef.current = Date.now()
      setVoiceDraft(null)
      setVoiceElapsedMs(0)

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceChunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        showToast('error', 'No se pudo grabar', 'Revisa el permiso del micrófono e intenta otra vez.')
        handleCancelVoiceDraft()
      }

      recorder.onstop = async () => {
        const canceled = voiceCancelRef.current
        const chunks = [...voiceChunksRef.current]
        const durationMs = Date.now() - voiceStartedAtRef.current
        const recordedType = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm'

        clearVoiceTimer()
        stopVoiceStream()
        setVoiceRecording(false)
        voiceRecorderRef.current = null
        voiceChunksRef.current = []
        voiceCancelRef.current = false

        if (canceled) return

        try {
          const blob = new Blob(chunks, { type: recordedType })
          if (durationMs < MIN_VOICE_RECORDING_MS || blob.size === 0) {
            showToast('info', 'Audio muy corto', 'Graba un poquito más para poder enviarlo.')
            setVoiceElapsedMs(0)
            return
          }

          if (blob.size > MAX_VOICE_MESSAGE_BYTES) {
            showToast('error', 'Audio muy pesado', 'Graba un audio más corto para enviarlo por WhatsApp.')
            setVoiceElapsedMs(0)
            return
          }

          const dataUrl = await readBlobAsDataUrl(blob)
          if (!dataUrl) {
            throw new Error('No se pudo leer el audio.')
          }

          const timestamp = Date.now()
          setVoiceDraft({
            id: `voice-${timestamp}`,
            name: `nota-voz-${timestamp}.${getVoiceFileExtension(blob.type || recordedType)}`,
            type: blob.type || recordedType,
            dataUrl,
            size: blob.size,
            durationMs
          })
          setVoiceElapsedMs(durationMs)
        } catch (error: any) {
          showToast('error', 'No se pudo preparar el audio', error?.message || 'Intenta grabarlo otra vez.')
          setVoiceElapsedMs(0)
        }
      }

      recorder.start(250)
      setVoiceRecording(true)
      voiceTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - voiceStartedAtRef.current
        setVoiceElapsedMs(elapsed)
        if (elapsed >= MAX_VOICE_RECORDING_MS && voiceRecorderRef.current?.state === 'recording') {
          voiceRecorderRef.current.stop()
        }
      }, 250)
    } catch (error: any) {
      clearVoiceTimer()
      stopVoiceStream()
      setVoiceRecording(false)
      voiceRecorderRef.current = null
      showToast('error', 'No se abrió el micrófono', error?.message || 'Revisa permisos del celular e intenta otra vez.')
    }
  }

  const handleSelectContact = (contact: Contact) => {
    const chatContact = (chats.find((item) => item.id === contact.id) || contact) as ChatContact
    const nextContact = ensureChatContact(contact)
    closeSwipeActions()
    handleCancelVoiceDraft()
    markContactReadState(chatContact)
    setActiveContactId(nextContact.id)
    setChats((current) => current.map((item) => (
      item.id === nextContact.id ? { ...item, unreadCount: 0 } : item
    )))
    setConversationOpen(true)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
    setContactQuery('')
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleOpenAIAgentChat = () => {
    closeSwipeActions()
    handleCancelVoiceDraft()
    setActiveContactId(AI_AGENT_CHAT_ID)
    setConversationOpen(true)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
    setContactQuery('')
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleBackToChats = () => {
    setChatSwipeSuppressed(true)
    closeSwipeActions()
    handleCancelVoiceDraft()
    setConversationOpen(false)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleOpenContactInfo = async () => {
    if (!activeContact) return

    actionSheetDismiss.requestClose()
    setContactInfoOpen(true)
    setContactInfoError('')

    if (contactInfoContact?.id === activeContact.id) return

    const cacheKey = getPhoneDailyCacheKey('phone-chat', 'contact-info', locationId || 'default', activeContact.id)
    const cachedContactInfo = readPhoneDailyCache<Contact>(cacheKey)

    setContactInfoContact(cachedContactInfo?.data || activeContact)
    setContactInfoLoading(true)

    try {
      const details = await contactsService.getContactDetails(activeContact.id)
      setContactInfoContact(details)
      setChats((current) => current.map((contact) => (
        contact.id === details.id ? { ...contact, ...details } : contact
      )))
      writePhoneDailyCache(cacheKey, details, { maxEntryChars: 220_000 })
    } catch {
      setContactInfoError('No se pudo cargar todo el detalle. Te muestro lo que ya está guardado en este chat.')
    } finally {
      setContactInfoLoading(false)
    }
  }

  const handleContactInfoAction = (nextSheet: Exclude<ActionSheet, 'newChat' | 'settings' | 'chatMore' | null>) => {
    if (nextSheet === 'payment') setPaymentMode('single')
    setContactInfoOpen(false)
    setSheet(nextSheet)
  }

  const closeSwipeActions = () => {
    chatSwipeGenerationRef.current += 1
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
    chatSwipeGestureRef.current = null
  }

  const handleArchiveChat = (contact: Contact) => {
    const alreadyArchived = archivedChatIdSet.has(contact.id)

    setArchivedChatIds((current) => {
      if (alreadyArchived) return current.filter((id) => id !== contact.id)
      return [contact.id, ...current.filter((id) => id !== contact.id)]
    })

    closeSwipeActions()
    if (activeContactId === contact.id && !alreadyArchived) {
      setConversationOpen(false)
      setContactInfoOpen(false)
      actionSheetDismiss.requestClose()
    }

    showToast(
      'success',
      alreadyArchived ? 'Chat de vuelta' : 'Chat archivado',
      alreadyArchived
        ? `${getContactName(contact)} volvió a tu lista de chats.`
        : `${getContactName(contact)} se movió a Archivados.`
    )
  }

  const handleToggleMuteChat = (contact: Contact) => {
    const alreadyMuted = mutedChatIdSet.has(contact.id)

    setMutedChatIds((current) => {
      if (alreadyMuted) return current.filter((id) => id !== contact.id)
      return [contact.id, ...current.filter((id) => id !== contact.id)]
    })

    actionSheetDismiss.requestClose()
    setChatActionContactId(null)
    closeSwipeActions()
    showToast(
      'success',
      alreadyMuted ? 'Silencio quitado' : 'Chat silenciado',
      alreadyMuted
        ? `${getContactName(contact)} volverá a aparecer sin marca de silencio.`
        : `${getContactName(contact)} quedó marcado como silenciado en tu lista.`
    )
  }

  const handleOpenChatMore = (contact: Contact) => {
    setActiveContactId(contact.id)
    setChatActionContactId(contact.id)
    setSheet('chatMore')
    setContactInfoOpen(false)
    closeSwipeActions()
  }

  const handleOpenAppointmentForm = (contact?: Contact | null) => {
    if (contact?.id) setActiveContactId(contact.id)
    setChatActionContactId(null)
    setContactInfoOpen(false)
    actionSheetDismiss.requestClose()
    setAppointmentOpen(true)
    closeSwipeActions()
  }

  useEffect(() => {
    if (accessState !== 'allowed') return

    if (requestedActionParam !== 'appointment' || !requestedContactParam) {
      if (requestedActionParam !== 'appointment') {
        handledRouteAppointmentRef.current = null
      }
      return
    }

    if (chatsLoading) return

    const targetContact = chats.find((contact) => contact.id === requestedContactParam) || null
    if (!targetContact) return

    const routeKey = `${requestedContactParam}:appointment`
    if (handledRouteAppointmentRef.current === routeKey) return
    handledRouteAppointmentRef.current = routeKey

    handleOpenAppointmentForm(targetContact)
    setConversationOpen(true)

    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('action')
    nextParams.delete('contact')
    setSearchParams(nextParams, { replace: true })
  }, [
    accessState,
    chats,
    chatsLoading,
    requestedActionParam,
    requestedContactParam,
    searchParams,
    setSearchParams
  ])

  const handleChatMoreAction = (contact: Contact, nextSheet: Exclude<ActionSheet, 'attachments' | 'templates' | 'settings' | 'newChat' | 'chatMore' | null>) => {
    setActiveContactId(contact.id)
    setChatActionContactId(null)
    setContactInfoOpen(false)
    if (nextSheet === 'payment') setPaymentMode('single')
    setSheet(nextSheet)
    closeSwipeActions()
  }

  const handleChatTouchStart = (contactId: string, event: React.TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    if (!touch) return

    const currentOffset = draggingSwipe?.contactId === contactId
      ? draggingSwipe.offset
      : openSwipeChatId === contactId ? CHAT_SWIPE_ACTION_WIDTH : 0

    if (openSwipeChatId && openSwipeChatId !== contactId) {
      closeSwipeActions()
    }

    chatSwipeGestureRef.current = {
      contactId,
      generation: chatSwipeGenerationRef.current,
      startX: touch.clientX,
      startY: touch.clientY,
      startOffset: currentOffset,
      offset: currentOffset,
      lastRenderedOffset: currentOffset,
      active: false
    }
  }

  const handleChatTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = chatSwipeGestureRef.current
    const touch = event.touches[0]
    if (!gesture || !touch) return
    if (gesture.generation !== chatSwipeGenerationRef.current || conversationOpen || chatSwipeSuppressed) {
      chatSwipeGestureRef.current = null
      setDraggingSwipe(null)
      return
    }

    const deltaX = touch.clientX - gesture.startX
    const deltaY = touch.clientY - gesture.startY
    const horizontalDistance = Math.abs(deltaX)

    if (!gesture.active) {
      if (horizontalDistance < CHAT_SWIPE_ACTIVATE_THRESHOLD || horizontalDistance <= Math.abs(deltaY)) return
      gesture.active = true
    }

    event.preventDefault()
    const nextOffset = Math.round(Math.min(
      CHAT_SWIPE_ACTION_WIDTH,
      Math.max(0, gesture.startOffset - deltaX)
    ))

    gesture.offset = nextOffset
    if (Math.abs(nextOffset - gesture.lastRenderedOffset) < CHAT_SWIPE_RENDER_STEP) return
    gesture.lastRenderedOffset = nextOffset
    setDraggingSwipe({ contactId: gesture.contactId, offset: nextOffset })
  }

  const handleChatTouchEnd = () => {
    const gesture = chatSwipeGestureRef.current
    if (!gesture) return
    if (gesture.generation !== chatSwipeGenerationRef.current || conversationOpen || chatSwipeSuppressed) {
      setDraggingSwipe(null)
      chatSwipeGestureRef.current = null
      return
    }

    if (gesture.active) {
      const openThreshold = gesture.startOffset > 0 ? CHAT_SWIPE_CLOSE_THRESHOLD : CHAT_SWIPE_OPEN_THRESHOLD
      setOpenSwipeChatId(gesture.offset >= openThreshold ? gesture.contactId : null)
      setDraggingSwipe(null)
      ignoreNextChatClickRef.current = true
      window.setTimeout(() => {
        ignoreNextChatClickRef.current = false
      }, 240)
    }

    chatSwipeGestureRef.current = null
  }

  const handleChatItemPress = (contact: Contact) => {
    if (ignoreNextChatClickRef.current) return

    if (openSwipeChatId === contact.id) {
      closeSwipeActions()
    }

    handleSelectContact(contact)
  }

  const handleChatRowKeyDown = (event: React.KeyboardEvent<HTMLElement>, action: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    action()
  }

  const handleUnavailableAttachment = (label: string) => {
    showToast('info', label, 'Esta opción ya está en el menú. La conexión real se activa cuando los archivos del celular estén conectados.')
  }

  const addDraftAttachment = (attachment: MobilePhotoAttachment) => {
    setDraftAttachments((current) => [attachment, ...current].slice(0, 4))
    showToast('success', 'Foto lista', 'Revisa la vista previa y toca enviar.')
  }

  const openCameraShare = (attachment: MobilePhotoAttachment) => {
    setSheet(null)
    setCameraSharePhoto(attachment)
    setCameraShareQuery('')
    setCameraShareCaption('')
    setCameraShareSelectedContacts([])
    setCameraShareSending(false)
    if (cameraShareCaptionRef.current) {
      cameraShareCaptionRef.current.textContent = ''
    }
  }

  const closeCameraShare = () => {
    setCameraSharePhoto(null)
    setCameraShareQuery('')
    setCameraShareCaption('')
    setCameraShareSelectedContacts([])
    setCameraShareSending(false)
    if (cameraShareCaptionRef.current) {
      cameraShareCaptionRef.current.textContent = ''
    }
  }

  const handlePickedPhoto = (attachment: MobilePhotoAttachment, destination: PhotoPickDestination) => {
    if (destination === 'cameraShare') {
      openCameraShare(attachment)
      return
    }
    addDraftAttachment(attachment)
  }

  const readImageFile = (file: File, source: 'camera' | 'photos', destination: PhotoPickDestination) => {
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Archivo no válido', 'Elige una foto JPG, PNG o WebP.')
      return
    }

    if (file.size > 8 * 1024 * 1024) {
      showToast('error', 'La foto pesa demasiado', 'Elige una foto más ligera para poder enviarla por WhatsApp.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        showToast('error', 'No se pudo leer', 'Intenta elegir la foto otra vez.')
        return
      }

      handlePickedPhoto({
        id: `photo-${Date.now()}`,
        name: file.name || `photo-${Date.now()}`,
        type: file.type || 'image/jpeg',
        dataUrl,
        source
      }, destination)
    }
    reader.onerror = () => showToast('error', 'No se pudo leer', 'Intenta elegir la foto otra vez.')
    reader.readAsDataURL(file)
  }

  const handleWebPhotoSelected = (source: 'camera' | 'photos', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    readImageFile(file, source, photoPickDestinationRef.current)
  }

  const handlePickPhoto = async (source: 'camera' | 'photos', destination: PhotoPickDestination = 'chat') => {
    photoPickDestinationRef.current = destination
    actionSheetDismiss.requestClose()

    if (mobileAppService.isNative()) {
      try {
        const photo = await mobileAppService.pickPhoto(source)
        if (photo) handlePickedPhoto(photo, destination)
      } catch (error: any) {
        showToast('error', source === 'camera' ? 'No se abrió la cámara' : 'No se abrieron las fotos', error?.message || 'Revisa los permisos del celular e intenta otra vez.')
      }
      return
    }

    const input = source === 'camera' ? cameraInputRef.current : photosInputRef.current
    input?.click()
  }

  const syncCameraShareCaption = (element: HTMLDivElement) => {
    const nextText = element.innerText.replace(/\u00a0/g, ' ')
    const normalizedText = nextText.replace(/\n{3,}/g, '\n\n')
    if (!normalizedText.trim()) {
      element.textContent = ''
      setCameraShareCaption('')
      return
    }
    setCameraShareCaption(normalizedText)
  }

  const handleCameraShareCaptionPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    document.execCommand('insertText', false, text)
    syncCameraShareCaption(event.currentTarget)
  }

  const toggleCameraShareContact = (contact: Contact) => {
    if (!contact.phone) {
      showToast('warning', 'Sin teléfono', 'Guarda el número del contacto para poder enviarle la foto.')
      return
    }

    setCameraShareSelectedContacts((current) => (
      current.some((item) => item.id === contact.id)
        ? current.filter((item) => item.id !== contact.id)
        : [...current, contact]
    ))
  }

  const updateCameraShareChats = (targets: Contact[], caption: string, sentAt: string) => {
    const targetById = new Map(targets.map((contact) => [contact.id, contact]))
    setChats((current) => {
      const existingIds = new Set(current.map((contact) => contact.id))
      const updated = current.map((contact) => (
        targetById.has(contact.id)
          ? {
              ...contact,
              lastMessageText: caption || 'Foto',
              lastMessageType: 'image',
              lastMessageDate: sentAt,
              lastMessageDirection: 'outbound',
              messageCount: Number(contact.messageCount || 0) + 1
            }
          : contact
      ))
      const inserted = targets
        .filter((contact) => !existingIds.has(contact.id))
        .map((contact) => ({
          ...toChatContact(contact),
          lastMessageText: caption || 'Foto',
          lastMessageType: 'image',
          lastMessageDate: sentAt,
          lastMessageDirection: 'outbound',
          messageCount: 1
        }))

      return [...inserted, ...updated].sort((left, right) => (
        Date.parse(right.lastMessageDate || right.createdAt) - Date.parse(left.lastMessageDate || left.createdAt)
      ))
    })
  }

  const handleSendCameraSharePhoto = async () => {
    const photo = cameraSharePhoto
    const targets = cameraShareSelectedContacts.filter((contact) => Boolean(contact.phone))
    const caption = cameraShareCaption.trim()
    if (!photo || cameraShareSending) return

    if (targets.length === 0) {
      showToast('warning', 'Elige un contacto', 'Selecciona una o varias personas para mandar la foto.')
      return
    }

    if (!cameraShareBusinessPhoneValue) {
      showToast('error', 'Falta el WhatsApp del negocio', 'Configura el número conectado para enviar fotos.')
      return
    }

    if (!whatsappConnected) {
      showToast('error', 'WhatsApp no está conectado', 'Conecta WhatsApp API para mandar fotos desde la cámara.')
      return
    }

    const sentAt = new Date().toISOString()
    setCameraShareSending(true)

    const results = await Promise.allSettled(targets.map((contact, index) => (
      whatsappApiService.sendImage({
        to: contact.phone || '',
        from: cameraShareBusinessPhoneValue,
        imageDataUrl: photo.dataUrl,
        caption,
        externalId: `camera-share-${Date.now()}-${index}`,
        phoneNumberId: cameraShareBusinessPhone?.id || undefined
      })
    )))

    const failedContacts = targets.filter((_, index) => results[index].status === 'rejected')
    const successfulContacts = targets.filter((_, index) => results[index].status === 'fulfilled')
    const firstFailure = results.find((result) => result.status === 'rejected')
    if (successfulContacts.length > 0) {
      updateCameraShareChats(successfulContacts, caption, sentAt)
    }

    try {
      await loadChats({ showCacheRefresh: true })
    } catch {
      // La foto ya se intentó enviar; la lista se refrescará sola en la siguiente carga.
    }

    if (failedContacts.length > 0) {
      const reason = firstFailure && firstFailure.status === 'rejected'
        ? getErrorMessage(firstFailure.reason, 'Intenta enviar la foto otra vez.')
        : 'Intenta enviar la foto otra vez.'
      setCameraShareSelectedContacts(failedContacts)
      setCameraShareSending(false)
      showToast(
        'error',
        failedContacts.length === targets.length ? 'No se envió la foto' : 'Algunos contactos fallaron',
        failedContacts.length === targets.length
          ? reason
          : `Se mandó a ${targets.length - failedContacts.length}, faltan ${failedContacts.length}. ${reason}`
      )
      return
    }

    closeCameraShare()
    showToast(
      'success',
      targets.length === 1 ? 'Foto enviada' : 'Fotos enviadas',
      targets.length === 1
        ? `Se mandó a ${getContactName(targets[0])}.`
        : `Se mandó a ${targets.length} contactos.`
    )
  }

  const getTemplateAlertMessage = (template: WhatsAppApiTemplate) => (
    templateAlertByEntity.get(template.id) ||
    templateAlertByEntity.get(`${template.waba_id || ''}|${template.name}|${template.language}`) ||
    ''
  )

  const handleOpenTemplatesSheet = () => {
    setTemplateMode('choice')
    setSheet('templates')
  }

  const handleShowMessageError = (message: ChatMessage) => {
    const reason = message.errorReason || 'WhatsApp no entregó la razón exacta. Intenta reenviar o revisa el estado de la conexión.'
    showToast('error', 'No se pudo enviar', reason)
  }

  const handleSendTemplate = async (template: WhatsAppApiTemplate) => {
    if (!activeContact?.phone) {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de enviar una plantilla.')
      return
    }

    if (!whatsappConnected) {
      showToast('error', 'WhatsApp no está conectado', 'Conecta WhatsApp API en configuración para enviar plantillas.')
      return
    }

    if (!selectedBusinessPhoneValue) {
      showToast('error', 'Falta el WhatsApp del negocio', 'Configura el número conectado para responder este chat.')
      return
    }

    const status = getTemplateStatus(template)
    const blockedReason = getTemplateBlockedReason(template, getTemplateAlertMessage(template))
    if (status !== 'APPROVED') {
      showToast('warning', getTemplateStatusLabel(status), blockedReason)
      return
    }

    const optimisticId = `template-${Date.now()}`
    const sentAt = new Date().toISOString()
    const preview = getTemplateBodyPreview(template)
    setTemplateSendingId(template.id)
    actionSheetDismiss.requestClose()
    setMessages((current) => [
      ...current,
      {
        id: optimisticId,
        text: preview,
        date: sentAt,
        direction: 'outbound',
        status: 'enviando',
        businessPhone: selectedBusinessPhoneValue,
        businessPhoneNumberId: selectedBusinessPhone?.id || '',
        transport: 'api'
      }
    ])
    setChats((current) => current.map((contact) => (
      contact.id === activeContact.id
        ? {
            ...contact,
            lastMessageText: preview || `Plantilla: ${template.name}`,
            lastMessageDate: sentAt,
            lastMessageDirection: 'outbound',
            messageCount: Number(contact.messageCount || 0) + 1
          }
        : contact
    )))

    try {
      const result = await whatsappApiService.sendTemplate({
        to: activeContact.phone,
        from: selectedBusinessPhoneValue,
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        externalId: optimisticId,
        phoneNumberId: selectedBusinessPhone?.id || undefined
      })
      setMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? { ...message, status: 'sent', errorReason: '', transport: result.transport || message.transport }
          : message
      )))
      showToast(
        'success',
        result.transport === 'qr' ? 'Plantilla enviada por QR' : 'Plantilla enviada',
        result.transport === 'qr'
          ? `${template.name} se mandó como texto por el respaldo QR.`
          : `${template.name} se mandó por WhatsApp.`
      )
      await loadConversation(activeContact.id)
      await loadChats()
      await loadTemplates()
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Intenta enviar la plantilla otra vez.')
      setMessages((current) => current.map((message) => (
        message.id === optimisticId ? { ...message, status: 'error', errorReason: errorMessage } : message
      )))
      showToast('error', 'No se envió la plantilla', errorMessage)
    } finally {
      setTemplateSendingId(null)
    }
  }

  const handleCreateQuickTemplate = async () => {
    const name = normalizeTemplateNameInput(newTemplateName)
    const bodyText = newTemplateBody.trim()

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe un nombre corto para identificar la plantilla.')
      return
    }

    if (!bodyText) {
      showToast('warning', 'Falta el mensaje', 'Escribe el texto que quieres mandar al cliente.')
      return
    }

    setCreatingTemplate(true)
    try {
      const saved = await messageTemplatesService.createTemplate(createQuickTemplatePayload({
        name,
        bodyText,
        category: newTemplateCategory,
        language: newTemplateLanguage
      }))
      await messageTemplatesService.submitTemplate(saved.id)
      setNewTemplateName('')
      setNewTemplateBody('')
      setNewTemplateCategory('utility')
      setNewTemplateLanguage('es_MX')
      setTemplateMode('send')
      showToast('success', 'Plantilla enviada a revisión', 'Cuando Meta la apruebe, aparecerá lista para enviar aquí mismo.')
      await loadTemplates()
    } catch (error) {
      showToast('error', 'No se pudo crear', getErrorMessage(error, 'Revisa la plantilla e intenta otra vez.'))
      await loadTemplates()
    } finally {
      setCreatingTemplate(false)
    }
  }

  const syncComposerText = (element: HTMLDivElement) => {
    const nextText = element.innerText.replace(/\u00a0/g, ' ')
    const normalizedText = nextText.replace(/\n{3,}/g, '\n\n')
    if (!normalizedText.trim()) {
      element.textContent = ''
      setMessageText('')
      return
    }
    setMessageText(normalizedText)
  }

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text/plain')
    if (!text) return
    document.execCommand('insertText', false, text)
    syncComposerText(event.currentTarget)
  }

  const removeDraftAttachment = (attachmentId: string) => {
    setDraftAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }

  const handleSendMessage = async (transport: 'api' | 'qr' = 'api') => {
    const text = messageText.trim()
    const attachmentsToSend = draftAttachments
    const voiceToSend = voiceDraft
    if (!activeContact || (!text && attachmentsToSend.length === 0 && !voiceToSend)) return

    if (sendingThroughHighLevel) {
      const channel = activeHighLevelChatChannel
      const channelLabel = GHL_CHAT_CHANNEL_LABELS[channel]

      if (!text) {
        showToast('warning', 'Escribe el mensaje', 'HighLevel necesita texto para mandar desde este chat.')
        return
      }

      if (attachmentsToSend.length > 0 || voiceToSend) {
        showToast('warning', 'Solo texto por ahora', 'HighLevel desde este chat todavía no manda fotos ni audios.')
        return
      }

      if ((channel === 'whatsapp_api' || channel === 'sms_qr') && !activeContact.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribir por este canal.')
        return
      }

      const optimisticId = `local-ghl-${Date.now()}`
      const sentAt = new Date().toISOString()
      const transportLabel = channel === 'whatsapp_api'
        ? 'ghl_whatsapp'
        : channel === 'sms_qr'
          ? 'ghl_sms'
          : channel === 'messenger'
            ? 'ghl_messenger'
            : 'ghl_instagram'

      setComposerStatus('sending')
      setMessageText('')
      if (composerInputRef.current) {
        composerInputRef.current.textContent = ''
      }

      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        text,
        date: sentAt,
        direction: 'outbound',
        status: 'enviando',
        businessPhone: selectedBusinessPhoneValue || '',
        businessPhoneNumberId: selectedBusinessPhone?.id || '',
        transport: transportLabel
      }

      setMessages((current) => [...current, optimisticMessage])
      setChats((current) => current.map((contact) => (
        contact.id === activeContact.id
          ? {
              ...contact,
              lastMessageText: text,
              lastMessageDate: sentAt,
              lastMessageDirection: 'outbound',
              lastMessageChannel: channel,
              messageCount: Number(contact.messageCount || 0) + 1
            }
          : contact
      )))

      try {
        const result = await highLevelService.sendConversationMessage({
          contactId: activeContact.id,
          channel,
          message: text,
          fromNumber: selectedBusinessPhoneValue || undefined,
          toNumber: activeContact.phone || undefined,
          externalId: optimisticId
        })
        const resultData = result.data || result
        const resultStatus = String(resultData.status || '').trim() || 'pending'
        const resultDelivered = ['sent', 'delivered', 'read'].includes(resultStatus.toLowerCase())
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? {
                ...message,
                id: resultData.localMessageId || message.id,
                status: resultStatus,
                transport: resultData.transport || message.transport
              }
            : message
        )))
        showToast(
          'success',
          resultDelivered ? 'Mensaje enviado' : 'Mensaje en cola',
          `${resultDelivered ? 'Se envió' : 'HighLevel lo recibió'} por ${resultData.channelLabel || channelLabel}.`
        )
        await loadConversation(activeContact.id)
        await loadChats()
      } catch (error: any) {
        const errorMessage = getErrorMessage(error, 'Intenta enviar el mensaje otra vez.')
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? { ...message, status: 'error', errorReason: errorMessage }
            : message
        )))
        setMessageText(text)
        if (composerInputRef.current) {
          composerInputRef.current.textContent = text
        }
        showToast('error', 'No se envió el mensaje', errorMessage)
      } finally {
        setComposerStatus('idle')
      }
      return
    }

    if (!activeContact.phone) {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribir por WhatsApp.')
      return
    }

    if (!selectedBusinessPhoneValue) {
      showToast('error', 'Falta el WhatsApp del negocio', 'Configura el número conectado para responder este chat.')
      return
    }

    const resolvedTransport: 'api' | 'qr' = selectedQrReady && (transport === 'qr' || !apiReplyWindowOpen || !whatsappConnected)
      ? 'qr'
      : 'api'

    if (resolvedTransport === 'api' && !whatsappConnected) {
      showToast('error', 'WhatsApp no está conectado', 'Conecta WhatsApp API en configuración para enviar mensajes desde Ristak.')
      return
    }

    if (!apiReplyWindowOpen && !selectedQrReady) {
      showToast('warning', 'Fuera de 24 horas', 'Manda una plantilla aprobada para volver a escribirle.')
      return
    }

    if (resolvedTransport === 'qr' && !selectedQrReady) {
      showToast('error', 'QR no está conectado', 'Conecta este número por QR en Configuración > WhatsApp.')
      return
    }

    if (resolvedTransport === 'qr' && (attachmentsToSend.length > 0 || voiceToSend)) {
      showToast('warning', 'QR solo manda texto', 'Quita el archivo o manda una plantilla aprobada.')
      return
    }

    const optimisticId = `local-${Date.now()}`
    const sentAt = new Date().toISOString()
    setComposerStatus('sending')
    setMessageText('')
    if (composerInputRef.current) {
      composerInputRef.current.textContent = ''
    }
    setDraftAttachments([])
    setVoiceDraft(null)
    const optimisticMessages: ChatMessage[] = voiceToSend
      ? [{
          id: `${optimisticId}-audio`,
          text: '',
          date: sentAt,
          direction: 'outbound',
          status: 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport: resolvedTransport,
          attachment: {
            type: 'audio',
            dataUrl: voiceToSend.dataUrl,
            name: voiceToSend.name,
            mimeType: voiceToSend.type,
            durationMs: voiceToSend.durationMs
          }
        }]
      : attachmentsToSend.length > 0
      ? attachmentsToSend.map((attachment, index) => ({
          id: `${optimisticId}-image-${index}`,
          text: index === 0 ? text : '',
          date: sentAt,
          direction: 'outbound',
          status: 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport: resolvedTransport,
          attachment: {
            type: 'image',
            dataUrl: attachment.dataUrl,
            name: attachment.name
          }
        }))
      : [{
          id: optimisticId,
          text,
          date: sentAt,
          direction: 'outbound',
          status: resolvedTransport === 'qr' ? 'enviando por QR' : 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport: resolvedTransport
        }]

    setMessages((current) => [...current, ...optimisticMessages])
    setChats((current) => current.map((contact) => (
      contact.id === activeContact.id
        ? {
            ...contact,
            lastMessageText: voiceToSend ? 'Mensaje de voz' : attachmentsToSend.length > 0 ? (text || 'Foto') : text,
            lastMessageDate: sentAt,
            lastMessageDirection: 'outbound',
            messageCount: Number(contact.messageCount || 0) + Math.max(1, voiceToSend ? 1 : attachmentsToSend.length)
          }
        : contact
    )))

    try {
      if (voiceToSend) {
        const result = await whatsappApiService.sendAudio({
          to: activeContact.phone || '',
          from: selectedBusinessPhoneValue,
          audioDataUrl: voiceToSend.dataUrl,
          durationMs: voiceToSend.durationMs,
          externalId: `${optimisticId}-audio`,
          phoneNumberId: selectedBusinessPhone?.id || undefined
        })
        setMessages((current) => current.map((message) => (
          message.id === `${optimisticId}-audio`
            ? { ...message, status: result.status || 'sent', transport: result.transport || message.transport }
            : message
        )))
      } else if (attachmentsToSend.length > 0) {
        const results = await Promise.all(attachmentsToSend.map((attachment, index) => (
          whatsappApiService.sendImage({
            to: activeContact.phone || '',
            from: selectedBusinessPhoneValue,
            imageDataUrl: attachment.dataUrl,
            caption: index === 0 ? text : '',
            externalId: `${optimisticId}-image-${index}`,
            phoneNumberId: selectedBusinessPhone?.id || undefined
          })
        )))
        setMessages((current) => current.map((message) => (
          message.id.startsWith(`${optimisticId}-image-`)
            ? {
                ...message,
                status: results[Number(message.id.replace(`${optimisticId}-image-`, ''))]?.status || 'sent',
                transport: results[Number(message.id.replace(`${optimisticId}-image-`, ''))]?.transport || message.transport
              }
            : message
        )))
      } else {
        const result = await whatsappApiService.sendText({
          to: activeContact.phone,
          from: selectedBusinessPhoneValue,
          text,
          externalId: optimisticId,
          transport: resolvedTransport,
          phoneNumberId: selectedBusinessPhone?.id || undefined
        })
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? { ...message, status: result.status || 'sent', transport: result.transport || message.transport }
            : message
        )))
      }
      await loadConversation(activeContact.id)
      await loadChats()
    } catch (error: any) {
      const errorMessage = getErrorMessage(error, 'Intenta enviar el mensaje otra vez.')
      setMessages((current) => current.map((message) => (
        message.id === optimisticId || message.id === `${optimisticId}-audio` || message.id.startsWith(`${optimisticId}-image-`)
          ? { ...message, status: 'error', errorReason: errorMessage }
          : message
      )))
      setDraftAttachments(attachmentsToSend)
      setVoiceDraft(voiceToSend)
      showToast('error', 'No se envió el mensaje', errorMessage)
    } finally {
      setComposerStatus('idle')
    }
  }

  const handleVoiceOrSendButtonClick = () => {
    if (voiceRecording) {
      handleStopVoiceRecording()
      return
    }

    if (canSendMessage) {
      handleSendMessage()
      return
    }

    handleStartVoiceRecording()
  }

  const handleCreateAppointment = async (payload: {
    title: string
    appointmentStatus: CalendarEvent['appointmentStatus']
    startTime: string
    endTime: string
    notes: string
    address: string
    timeZone: string
    contactId?: string
  }) => {
    if (!selectedCalendar) {
      showToast('warning', 'Elige un calendario', 'Selecciona dónde quieres guardar la cita.')
      return
    }

    try {
      await calendarsService.createAppointment({
        calendarId: selectedCalendar.id,
        ...(locationId ? { locationId } : {}),
        ...payload
      }, accessToken || undefined)

      setAppointmentOpen(false)
      actionSheetDismiss.requestClose()
      showToast('success', 'Cita agendada', 'La cita quedó guardada.')
      setMessages((current) => [
        ...current,
        {
          id: `appointment-${Date.now()}`,
          text: 'Cita agendada desde este chat.',
          date: new Date().toISOString(),
          direction: 'system'
        }
      ])
    } catch (error) {
      showToast('error', 'No se pudo agendar', 'Intenta otra vez en unos minutos.')
      throw error
    }
  }

  const handleRequestPush = async () => {
    setRequestingPush(true)
    try {
      const result = await pushNotificationsService.subscribeToAppNotifications({
        calendarIds: pushCalendarIds
      })

      if (result.status === 'subscribed') {
        showToast('success', 'Alertas activadas', 'Este celular ya puede recibir alertas de Ristak.')
      } else {
        showToast('warning', 'No se activaron las alertas', result.reason)
      }
    } catch (error: any) {
      showToast('error', 'No se activaron las alertas', error?.message || 'Intenta otra vez.')
    } finally {
      setRequestingPush(false)
    }
  }

  const getAIAgentViewContext = (visibleText?: string): AIAgentViewContext => ({
    path: '/phone/chat',
    title: document.title || 'Ristak Chat',
    routeLabel: 'Chat móvil',
    visibleText: visibleText || 'El usuario está usando la pantalla móvil de chats de Ristak.'
  })

  const handleSendAIAgentMessage = async () => {
    const text = aiMessageText.trim()
    if (!text || aiSending) return

    const userMessage = createAIAgentMobileMessage('user', text)
    const nextMessages = [...aiMessages, userMessage]
    setAiMessages(nextMessages)
    setAiMessageText('')
    setAiSending(true)

    try {
      const result = await aiAgentService.sendMessage(nextMessages, getAIAgentViewContext())
      setAiMessages((current) => [
        ...current,
        createAIAgentMobileMessage('assistant', result.reply || 'Listo, sigo contigo.')
      ])
    } catch (error) {
      setAiMessages((current) => [
        ...current,
        createAIAgentMobileMessage('assistant', getErrorMessage(error, 'No pude responder ahorita. Revisa la configuración del agente de IA.'))
      ])
    } finally {
      setAiSending(false)
    }
  }

  const applyComposerSuggestion = (text: string) => {
    setMessageText(text)
    window.requestAnimationFrame(() => {
      if (composerInputRef.current) {
        composerInputRef.current.textContent = text
      }
    })
  }

  const handleSuggestReply = async () => {
    if (!activeContact || aiSuggestionLoading) return

    const recentConversation = messages.slice(-10).map((message) => {
      const sender = message.direction === 'outbound' ? 'Negocio' : message.direction === 'inbound' ? 'Cliente' : 'Sistema'
      const text = message.text || getMessageTypeLabel(message.attachment?.type || '')
      return `${sender}: ${text}`
    }).join('\n')

    setAiSuggestionLoading(true)
    try {
      const prompt = [
        `Sugiere una respuesta breve, clara y natural para contestarle por WhatsApp a ${getContactName(activeContact)}.`,
        'No agregues explicación, solo escribe el mensaje listo para enviar.',
        '',
        recentConversation || 'Todavía no hay mensajes visibles en esta conversación.'
      ].join('\n')
      const result = await aiAgentService.sendMessage([
        createAIAgentMobileMessage('user', prompt)
      ], getAIAgentViewContext(recentConversation))
      const suggestion = String(result.reply || '').trim()
      if (!suggestion) throw new Error('El agente no devolvió una sugerencia.')
      applyComposerSuggestion(suggestion)
      showToast('success', 'Sugerencia lista', 'Revisa el texto antes de enviarlo.')
    } catch (error) {
      showToast('error', 'No se pudo sugerir', getErrorMessage(error, 'Revisa la configuración del agente de IA.'))
    } finally {
      setAiSuggestionLoading(false)
    }
  }

  const renderAvatar = (contact: Contact) => {
    const photoUrl = getContactProfilePhoto(contact as Partial<Contact> & Record<string, unknown>)
    const avatarChannelClass = getAvatarChannelClass(contact as ChatContact)

    return (
      <span className={`${styles.avatar} ${avatarChannelClass}`}>
        {photoUrl ? (
          <img src={photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : getContactInitials(contact)}
      </span>
    )
  }

  const renderAIAgentAvatar = () => (
    <span className={`${styles.avatar} ${styles.aiAgentAvatar}`}>
      <Bot size={23} />
    </span>
  )

  const renderAIAgentChatButton = () => {
    const lastAiMessage = aiMessages[aiMessages.length - 1]
    const dateLabel = formatMessageDate(lastAiMessage?.createdAt)
    const subtitle = showLastMessagePreview
      ? getAIAgentMessagePreview(lastAiMessage)
      : 'Agente de Ristak'

    return (
      <div
        key={AI_AGENT_CHAT_ID}
        role="button"
        tabIndex={0}
        className={`${styles.chatItem} ${styles.aiAgentChatItem}`}
        onClick={handleOpenAIAgentChat}
        onKeyDown={(event) => handleChatRowKeyDown(event, handleOpenAIAgentChat)}
      >
        {renderAIAgentAvatar()}
        <span className={styles.chatMain}>
          <strong>Agente de inteligencia artificial</strong>
          <small>{subtitle}</small>
        </span>
        <span className={styles.chatMeta}>
          {dateLabel && <small>{dateLabel}</small>}
          <i className={styles.aiAgentPin}>Fijo</i>
        </span>
      </div>
    )
  }

  const renderContactButton = (contact: Contact, source: 'chat' | 'contact') => {
    const chatContact = contact as ChatContact
    const subtitle = source === 'chat' && showLastMessagePreview ? getChatPreview(chatContact) : getContactDetail(contact)
    const dateLabel = source === 'chat' ? formatMessageDate(chatContact.lastMessageDate || contact.createdAt) : ''
    const unreadCount = Number(chatContact.unreadCount || 0)
    const hasUnread = showUnreadIndicators && source === 'chat' && unreadCount > 0
    const isArchived = archivedChatIdSet.has(contact.id)
    const isMuted = mutedChatIdSet.has(contact.id)

    const content = (
      <>
        {renderAvatar(contact)}
        <span className={styles.chatMain}>
          <strong>{getContactName(contact)}</strong>
          <small>{subtitle}</small>
        </span>
        <span className={`${styles.chatMeta} ${hasUnread ? styles.chatMetaUnread : ''}`}>
          {dateLabel && <small className={hasUnread ? styles.chatUnreadTime : undefined}>{dateLabel}</small>}
          {isMuted && (
            <span className={styles.chatMutedIcon} aria-label="Chat silenciado">
              <BellOff size={13} />
            </span>
          )}
          {hasUnread && <i className={styles.chatUnreadBadge} aria-label={`${unreadCount} mensajes no leídos`}>{unreadCount > 9 ? '9+' : unreadCount}</i>}
        </span>
      </>
    )

    if (source !== 'chat') {
      return (
        <div
          key={contact.id}
          role="button"
          tabIndex={0}
          className={`${styles.chatItem} ${activeContact?.id === contact.id ? styles.chatItemActive : ''}`}
          onClick={() => handleSelectContact(contact)}
          onKeyDown={(event) => handleChatRowKeyDown(event, () => handleSelectContact(contact))}
        >
          {content}
        </div>
      )
    }

    const swipeLocked = conversationVisible || chatSwipeSuppressed
    const isDraggingSwipe = !swipeLocked && draggingSwipe?.contactId === contact.id
    const swipeOffset = swipeLocked
      ? 0
      : isDraggingSwipe
        ? draggingSwipe.offset
        : openSwipeChatId === contact.id ? CHAT_SWIPE_ACTION_WIDTH : 0
    const showSwipeActions = swipeOffset > 0

    return (
      <div
        key={contact.id}
        className={`${styles.chatSwipeRow} ${swipeOffset > 0 ? styles.chatSwipeRowOpen : ''} ${isDraggingSwipe ? styles.chatSwipeRowDragging : ''}`}
        onTouchStart={swipeLocked ? undefined : (event) => handleChatTouchStart(contact.id, event)}
        onTouchMove={swipeLocked ? undefined : handleChatTouchMove}
        onTouchEnd={swipeLocked ? undefined : handleChatTouchEnd}
        onTouchCancel={swipeLocked ? undefined : handleChatTouchEnd}
      >
        {showSwipeActions && (
          <div className={styles.chatSwipeActions} aria-hidden={!showSwipeActions}>
            <button
              type="button"
              className={`${styles.chatSwipeAction} ${styles.chatSwipeMore}`}
              onClick={(event) => {
                event.stopPropagation()
                handleOpenChatMore(contact)
              }}
            >
              <MoreHorizontal size={30} />
              <span>Más</span>
            </button>
            <button
              type="button"
              className={`${styles.chatSwipeAction} ${styles.chatSwipeArchive}`}
              onClick={(event) => {
                event.stopPropagation()
                handleArchiveChat(contact)
              }}
            >
              <MdArchive size={32} />
              <span>{isArchived ? 'Restaurar' : 'Archivar'}</span>
            </button>
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          className={`${styles.chatItem} ${styles.chatSwipeContent} ${hasUnread ? styles.chatItemUnread : ''}`}
          style={{ transform: `translate3d(-${swipeOffset}px, 0, 0)` }}
          onClick={() => handleChatItemPress(contact)}
          onKeyDown={(event) => handleChatRowKeyDown(event, () => handleChatItemPress(contact))}
        >
          {content}
        </div>
      </div>
    )
  }

  const renderCameraShareContactButton = (contact: Contact) => {
    const selected = cameraShareSelectedIds.has(contact.id)
    const chatContact = contact as ChatContact
    const lastDate = chatContact.lastMessageDate || contact.createdAt
    const subtitle = chatContact.lastMessageDate
      ? `Reciente · ${formatMessageDate(lastDate)}`
      : getContactDetail(contact)

    return (
      <button
        key={contact.id}
        type="button"
        className={`${styles.cameraShareContact} ${selected ? styles.cameraShareContactSelected : ''}`}
        onClick={() => toggleCameraShareContact(contact)}
        aria-pressed={selected}
      >
        <span className={styles.cameraShareAvatarWrap}>
          {renderAvatar(contact)}
          <span className={styles.cameraShareCheck}>
            {selected ? <Check size={15} /> : null}
          </span>
        </span>
        <span className={styles.cameraShareContactText}>
          <strong>{getContactName(contact)}</strong>
          <small>{subtitle}</small>
        </span>
      </button>
    )
  }

  const renderCameraShareScreen = () => {
    if (!cameraSharePhoto) return null

    const canSendCameraShare = cameraShareSelectedContacts.length > 0 && !cameraShareSending

    return (
      <section className={styles.cameraShareScreen} aria-label="Enviar foto">
        <header className={styles.cameraShareHeader}>
          <button type="button" className={styles.backButton} onClick={closeCameraShare} aria-label="Volver a chats">
            <ChevronLeft size={32} />
          </button>
          <div>
            <strong>Enviar foto</strong>
            <span>
              {cameraShareSelectedContacts.length > 0
                ? `${cameraShareSelectedContacts.length} seleccionado${cameraShareSelectedContacts.length === 1 ? '' : 's'}`
                : 'Elige uno o varios contactos'}
            </span>
          </div>
          <figure className={styles.cameraShareThumb}>
            <img src={cameraSharePhoto.dataUrl} alt="" />
          </figure>
        </header>

        <div className={styles.cameraShareSearch}>
          <Search size={20} />
          <input
            value={cameraShareQuery}
            onChange={(event) => setCameraShareQuery(event.target.value)}
            placeholder="Buscar nombre, número o correo"
            aria-label="Buscar contacto para enviar foto"
          />
          {cameraShareQuery && (
            <button type="button" onClick={() => setCameraShareQuery('')} aria-label="Limpiar búsqueda">
              <X size={17} />
            </button>
          )}
        </div>

        <div className={styles.cameraShareList} data-phone-chat-scrollable="true">
          {contactsLoading && cameraShareContactOptions.length === 0 ? (
            <div className={styles.centerState}>
              <Loader2 size={20} className={styles.spinIcon} />
              <span>Cargando contactos...</span>
            </div>
          ) : cameraShareContactOptions.length > 0 ? (
            cameraShareContactOptions.map(renderCameraShareContactButton)
          ) : (
            <div className={styles.emptyChats}>
              <span className={styles.emptyChatsIcon}>
                <User size={28} />
              </span>
              <strong>No hay contactos</strong>
              <small>Busca por nombre, número o correo para elegir a quién mandarle la foto.</small>
            </div>
          )}
        </div>

        <footer className={styles.cameraShareFooter}>
          {cameraShareSelectedContacts.length > 0 && (
            <div className={styles.cameraShareSelectedStrip} data-phone-chat-scrollable="true">
              {cameraShareSelectedContacts.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => toggleCameraShareContact(contact)}
                  aria-label={`Quitar ${getContactName(contact)}`}
                >
                  {renderAvatar(contact)}
                  <span>{getContactName(contact)}</span>
                </button>
              ))}
            </div>
          )}
          <div className={`${styles.composer} ${cameraShareCaption.trim() || cameraShareSelectedContacts.length > 0 ? styles.composerHasContent : ''} ${styles.cameraShareComposer}`}>
            <div className={styles.messageInputWrap}>
              <div
                ref={cameraShareCaptionRef}
                className={styles.composerInput}
                role="textbox"
                aria-multiline="true"
                aria-label="Mensaje para acompañar la foto"
                data-placeholder="Escribe un mensaje"
                contentEditable={!cameraShareSending}
                suppressContentEditableWarning
                spellCheck
                autoCorrect="on"
                autoCapitalize="sentences"
                onInput={(event) => syncCameraShareCaption(event.currentTarget)}
                onPaste={handleCameraShareCaptionPaste}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    handleSendCameraSharePhoto()
                  }
                }}
              />
            </div>
            <button
              type="button"
              className={`${styles.composerIconButton} ${styles.composerSendButton}`}
              onClick={handleSendCameraSharePhoto}
              disabled={!canSendCameraShare}
              aria-label="Enviar foto"
            >
              {cameraShareSending ? <Loader2 size={23} className={styles.spinIcon} /> : <ArrowRight size={23} />}
            </button>
          </div>
        </footer>
      </section>
    )
  }

  const renderChats = () => {
    const normalizedChatQuery = chatQuery.trim().toLowerCase()
    const showAIAgentListItem = aiAgentChatEnabled &&
      !archivedViewOpen &&
      chatFilter === 'all' &&
      (!normalizedChatQuery || 'agente inteligencia artificial ia ristak'.includes(normalizedChatQuery))

    if (chatsLoading) {
      return (
        <div className={styles.centerState}>
          <Loader2 size={20} className={styles.spinIcon} />
          <span>Cargando chats...</span>
        </div>
      )
    }

    if (chatsError) {
      return (
        <div className={styles.centerState}>
          <span>{chatsError}</span>
          <button type="button" onClick={() => loadChats({ showCacheRefresh: true })}>Intentar otra vez</button>
        </div>
      )
    }

    if (!archivedViewOpen && chats.length === 0 && chatQuery.trim().length >= 2) {
      if (contactsLoading) {
        return (
          <div className={styles.centerState}>
            <Loader2 size={20} className={styles.spinIcon} />
            <span>Buscando contactos...</span>
          </div>
        )
      }

      if (contactResults.length > 0) {
        return (
          <div className={styles.contactResultGroup}>
            <p>Contactos encontrados</p>
            {contactResults.map((contact) => renderContactButton(contact, 'contact'))}
          </div>
        )
      }
    }

    if (chats.length === 0 && !showAIAgentListItem && archivedChatCount === 0) {
      return (
        <div className={styles.emptyChats}>
          <span className={styles.emptyChatsIcon}>
            <Icon name="whatsapp" size={34} />
          </span>
          {chatsRefreshing && (
            <span className={styles.cacheRefreshPill} role="status">
              <Loader2 size={14} className={styles.spinIcon} />
              Actualizando chats
            </span>
          )}
          <strong>Aún no hay chats</strong>
          <small>Toca el botón verde para buscar un contacto e iniciar una conversación.</small>
          <button type="button" onClick={() => setSheet('newChat')}>
            <Plus size={17} />
            Nuevo chat
          </button>
        </div>
      )
    }

    return (
      <>
        {chatsRefreshing && (
          <div className={styles.cacheRefreshPill} role="status">
            <Loader2 size={14} className={styles.spinIcon} />
            Mostrando lo guardado, actualizando chats
          </div>
        )}
        {showAIAgentListItem && renderAIAgentChatButton()}
        {archivedViewOpen && (
          <button
            type="button"
            className={`${styles.archiveRow} ${styles.archiveRowActive}`}
            onClick={() => setArchivedViewOpen(false)}
          >
            <span className={styles.archiveRowIcon}>
              <ChevronLeft size={22} />
            </span>
            <strong>Archivados</strong>
            <span>{archivedChatCount}</span>
          </button>
        )}
        {showArchivedChats && !archivedViewOpen && (chats.length > 0 || archivedChatCount > 0) && (
          <button
            type="button"
            className={styles.archiveRow}
            onClick={() => setArchivedViewOpen(true)}
            aria-label={`Ver ${archivedChatCount} chats archivados`}
          >
            <span className={styles.archiveRowIcon}>
              <MdArchive size={22} />
            </span>
            <strong>Archivados</strong>
            <span>{archivedChatCount}</span>
          </button>
        )}
        {filteredChats.length > 0 ? (
          filteredChats.map((contact) => renderContactButton(contact, 'chat'))
        ) : (
          <div className={styles.emptyChats}>
            <span className={styles.emptyChatsIcon}>
              <MessageCircle size={30} />
            </span>
            <strong>{archivedViewOpen ? 'No hay chats archivados' : chats.length === 0 ? 'Aún no hay chats' : 'No hay chats en este filtro'}</strong>
            <small>
              {archivedViewOpen
                ? 'Cuando archives una conversación, aparecerá en esta sección.'
                : chats.length === 0 ? 'Cuando llegue un mensaje de WhatsApp, Messenger o Instagram aparecerá aquí.' : 'Cambia el filtro o busca un contacto para iniciar una conversación.'}
            </small>
          </div>
        )}
      </>
    )
  }

  const renderMessages = () => {
    if (aiAgentConversationOpen) {
      return (
        <>
          {aiMessages.map((message) => (
            <div
              key={message.id}
              className={`${styles.messageRow} ${message.role === 'user' ? styles.messageRow_outbound : styles.messageRow_inbound}`}
            >
              <div className={`${styles.messageBubble} ${styles.aiMessageBubble}`}>
                <p>{message.content}</p>
                <span>{formatMessageTime(message.createdAt)}</span>
              </div>
            </div>
          ))}
          {aiSending && (
            <div className={`${styles.messageRow} ${styles.messageRow_inbound}`}>
              <div className={`${styles.messageBubble} ${styles.aiMessageBubble}`}>
                <p>Pensando...</p>
                <span><Loader2 size={13} className={styles.spinIcon} /></span>
              </div>
            </div>
          )}
        </>
      )
    }

    if (!activeContact) {
      return (
        <div className={styles.emptyConversation}>
          <MessageCircle size={34} />
          <strong>Elige un chat</strong>
          <span>Abre una conversación para escribir, cobrar o agendar.</span>
        </div>
      )
    }

    if (messagesLoading) {
      return (
        <div className={styles.emptyConversation}>
          <Loader2 size={22} className={styles.spinIcon} />
          <span>Cargando conversación...</span>
        </div>
      )
    }

    if (messages.length === 0) {
      return (
        <div className={styles.emptyConversation}>
          <Icon name="whatsapp" size={38} />
          <strong>Aún no hay mensajes</strong>
          <span>Escribe el primer mensaje o abre + para cobrar o agendar.</span>
        </div>
      )
    }

    return (
      <>
        {messagesRefreshing && (
          <div className={styles.cacheRefreshPill} role="status">
            <Loader2 size={14} className={styles.spinIcon} />
            Mostrando lo guardado, actualizando conversación
          </div>
        )}
        {conversationMessageItems.map((item) => {
          if (item.type === 'day') {
            return (
              <div
                key={`day-${item.key}`}
                className={styles.messageDaySeparator}
                data-message-day-key={item.key}
              >
                <span>{item.label}</span>
              </div>
            )
          }

          const message = item.message
          const failed = message.direction === 'outbound' && isMessageFailed(message)
          const pending = message.direction === 'outbound' && !failed && isMessagePending(message)
          const receiptStatus = getMessageReceiptStatus(message)
          const receiptLabel = getMessageReceiptLabel(receiptStatus)
          const transportBadge = getMessageTransportBadge(message.transport)

          return (
            <div
              key={item.key}
              className={`${styles.messageRow} ${styles[`messageRow_${message.direction}`]}`}
            >
              <div className={styles.messageBubble}>
                {message.attachment?.type === 'image' && (message.attachment.dataUrl || message.attachment.url) && (
                  <img className={styles.messageImage} src={message.attachment.dataUrl || message.attachment.url} alt={message.attachment.name || 'Foto enviada'} />
                )}
                {message.attachment?.type === 'audio' && (message.attachment.dataUrl || message.attachment.url) && (
                  <div className={styles.messageAudio}>
                    <Mic size={18} />
                    <audio controls preload="metadata" src={message.attachment.dataUrl || message.attachment.url} />
                  </div>
                )}
                {message.text && <p>{message.text}</p>}
                <span className={styles.messageMeta}>
                  {transportBadge && <em className={styles.messageTransport}>{transportBadge}</em>}
                  {formatMessageTime(message.date)}
                  {message.direction === 'outbound' && (failed ? (
                    <button
                      type="button"
                      className={styles.messageErrorButton}
                      onClick={() => handleShowMessageError(message)}
                      aria-label="Ver razón del error"
                    >
                      <CircleAlert size={15} />
                    </button>
                  ) : pending ? (
                    <Loader2 size={14} className={`${styles.spinIcon} ${styles.messageSendingIcon}`} />
                  ) : receiptStatus === 'delivered' || receiptStatus === 'read' ? (
                    <span
                      className={`${styles.messageReceipt} ${receiptStatus === 'read' ? styles.messageReceiptRead : ''}`}
                      title={receiptLabel}
                      aria-label={receiptLabel}
                    >
                      <CheckCheck size={15} />
                    </span>
                  ) : (
                    <span className={styles.messageReceipt} title={receiptLabel} aria-label={receiptLabel}>
                      <Check size={15} />
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )
        })}
      </>
    )
  }

  const renderDraftAttachments = () => {
    if (draftAttachments.length === 0) return null

    return (
      <div className={styles.draftAttachments} data-phone-chat-scrollable="true">
        {draftAttachments.map((attachment) => (
          <figure key={attachment.id} className={styles.draftAttachment}>
            <img src={attachment.dataUrl} alt={attachment.name || 'Foto lista'} />
            <button type="button" onClick={() => removeDraftAttachment(attachment.id)} aria-label="Quitar foto">
              <X size={15} />
            </button>
          </figure>
        ))}
      </div>
    )
  }

  const renderVoiceDraft = () => {
    if (!voiceRecording && !voiceDraft) return null

    return (
      <div className={`${styles.voiceDraft} ${voiceRecording ? styles.voiceDraftRecording : ''}`}>
        <span className={styles.voiceDraftIcon}>
          <Mic size={18} />
        </span>
        <div className={styles.voiceDraftBody}>
          <strong>{voiceRecording ? 'Grabando audio' : 'Audio listo'}</strong>
          {voiceDraft ? (
            <audio controls preload="metadata" src={voiceDraft.dataUrl} />
          ) : (
            <span>{formatVoiceDuration(voiceElapsedMs)}</span>
          )}
        </div>
        <span className={styles.voiceDraftTime}>
          {formatVoiceDuration(voiceDraft?.durationMs || voiceElapsedMs)}
        </span>
        <button type="button" onClick={handleCancelVoiceDraft} aria-label={voiceRecording ? 'Cancelar grabación' : 'Borrar audio'}>
          <X size={17} />
        </button>
      </div>
    )
  }

  const renderAISuggestionBar = () => {
    if (!activeContact || !aiReplySuggestionsEnabled || aiAgentConversationOpen) return null

    return (
      <div className={styles.aiSuggestionBar}>
        <span>
          <Sparkles size={15} />
          El agente puede ayudarte a contestar
        </span>
        <button type="button" onClick={handleSuggestReply} disabled={aiSuggestionLoading}>
          {aiSuggestionLoading ? <Loader2 size={14} className={styles.spinIcon} /> : <Bot size={14} />}
          Sugerir
        </button>
      </div>
    )
  }

  const renderSenderBar = () => {
    if (!activeContact) return null

    if (sendingThroughHighLevel) {
      const activeOption = GHL_CHAT_CHANNEL_OPTIONS.find((option) => option.id === activeHighLevelChatChannel)

      return (
        <div className={styles.senderBar}>
          <label className={styles.senderChannelSelect}>
            <span>Enviar por</span>
            <select
              value={activeHighLevelChatChannel}
              onChange={(event) => {
                const nextChannel = normalizeGhlChatChannelValue(event.target.value)
                if (!nextChannel || !activeContact?.id) return
                setContactHighLevelChannelOverrides((current) => ({
                  ...current,
                  [activeContact.id]: nextChannel
                }))
                saveConfigPreference(setSelectedHighLevelChatChannel, nextChannel)
              }}
              aria-label="Canal de envío"
            >
              {GHL_CHAT_CHANNEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
          <span className={styles.senderChannelHint}>
            {activeOption?.hint || 'Sale por la cuenta conectada.'}
          </span>
        </div>
      )
    }

    if (!outsideReplyWindow || !selectedQrReady) return null

    return (
      <div className={`${styles.senderBar} ${styles.replyWindowSenderBar}`}>
        <span className={styles.replyWindowNotice}>
          <Clock size={14} />
          Fuera de 24 h · se enviará por QR
        </span>
      </div>
    )
  }

  const renderAIAgentComposer = () => (
    <div className={styles.aiComposer}>
      <textarea
        value={aiMessageText}
        onChange={(event) => setAiMessageText(event.target.value)}
        placeholder="Escribe al agente"
        aria-label="Mensaje para el agente de inteligencia artificial"
        rows={1}
        disabled={aiSending}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            handleSendAIAgentMessage()
          }
        }}
      />
      <button
        type="button"
        onClick={handleSendAIAgentMessage}
        disabled={aiSending || !aiMessageText.trim()}
        aria-label="Enviar mensaje al agente"
      >
        {aiSending ? <Loader2 size={20} className={styles.spinIcon} /> : <Send size={22} />}
      </button>
    </div>
  )

  const renderContactInfoRow = (
    key: string,
    icon: React.ReactNode,
    label: string,
    value?: React.ReactNode,
    detail?: React.ReactNode
  ) => {
    if (value === null || value === undefined) return null
    if (typeof value === 'string' && !value.trim()) return null

    return (
      <div key={key} className={styles.contactInfoRow}>
        <span className={styles.contactInfoRowIcon}>{icon}</span>
        <span className={styles.contactInfoRowText}>
          <small>{label}</small>
          <strong>{value}</strong>
          {detail && <em>{detail}</em>}
        </span>
      </div>
    )
  }

  const renderContactInfoScreen = () => {
    if (!contactInfoData) return null

    const revenueTotal = contactInfoSuccessfulPayments.reduce((sum, payment) => sum + payment.amount, 0)
    const purchasesCount = Number(contactInfoData.purchases || 0) || contactInfoSuccessfulPayments.length
    const nextAppointment = contactInfoActiveAppointments.find((appointment) => Date.parse(appointment.startTime) >= Date.now()) || contactInfoActiveAppointments[0]
    const firstSuccessfulPayment = [...contactInfoSuccessfulPayments]
      .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))[0]
    const firstAppointment = contactInfoAppointments[0]
    const leadEvent = contactJourney.find((event) => event.type === 'contact_created')
    const leadDate = leadEvent?.date || contactInfoData.createdAt
    const leadSource = getReadableValue(leadEvent?.data?.source) || contactInfoSource
    const resolvedMetaAttribution = contactInfoResolvedMetaAttribution
    const campaignName = getReadableValue(resolvedMetaAttribution?.campaignName || contactInfoTracking.campaign_name || contactInfoTracking.utm_campaign)
    const campaignDetail = resolvedMetaAttribution
      ? ['Datos reales de Meta', getReadableValue(resolvedMetaAttribution.campaignId)].filter(Boolean).join(' · ')
      : ''
    const adsetName = getReadableValue(resolvedMetaAttribution?.adsetName)
    const adsetDetail = getReadableValue(resolvedMetaAttribution?.adsetId)
    const adName = getReadableValue(resolvedMetaAttribution?.adName || contactInfoTracking.ad_name || contactInfoTracking.utm_content)
    const adDetail = [
      resolvedMetaAttribution ? 'Anuncio real de Meta' : '',
      getReadableValue(resolvedMetaAttribution?.adId || contactInfoTracking.ad_id)
    ].filter(Boolean).join(' · ')
    const pageName = getReadableValue(getPageName(contactInfoTracking.page_url))
    const deviceName = [getReadableValue(contactInfoTracking.device_type), getReadableValue(contactInfoTracking.browser)].filter(Boolean).join(' · ')
    const locationName = [contactInfoTracking.geo_city, contactInfoTracking.geo_region, contactInfoTracking.geo_country]
      .map((value) => getReadableValue(value))
      .filter(Boolean)
      .join(', ')
    const visibleCustomFields = (contactInfoData.customFields || [])
      .map((field, index) => ({
        id: field.id || field.key || field.fieldKey || field.label || field.name || `field-${index}`,
        label: getCustomFieldLabel(field, index),
        value: formatCustomFieldValue(field.value)
      }))
      .filter((field) => field.value.trim().length > 0)

    return (
      <section
        className={`${styles.contactInfoScreen} ${contactInfoOpen ? styles.contactInfoScreenOpen : ''}`}
        aria-label="Información del contacto"
        aria-hidden={!contactInfoOpen}
      >
        <header className={styles.contactInfoTopbar}>
          <button type="button" className={styles.backButton} onClick={() => setContactInfoOpen(false)} aria-label="Volver al chat">
            <ChevronLeft size={32} />
          </button>
          <strong>Info del contacto</strong>
          <span className={styles.contactInfoTopbarSpacer} aria-hidden="true" />
        </header>

        <div className={styles.contactInfoContent} data-phone-chat-scrollable="true">
          <section className={styles.contactInfoHero}>
            <span className={styles.contactInfoAvatar}>
              {renderAvatar(contactInfoData)}
            </span>
            <h2>{getContactName(contactInfoData)}</h2>
            <p>{getContactDetail(contactInfoData)}</p>
            {contactInfoStageBadge && (
              <span className={styles.contactInfoBadge}>{contactInfoStageBadge.text}</span>
            )}
            {contactInfoLoading && (
              <span className={styles.contactInfoLoading}>
                <Loader2 size={14} className={styles.spinIcon} />
                Actualizando datos
              </span>
            )}
            {contactInfoError && <span className={styles.contactInfoError}>{contactInfoError}</span>}
          </section>

          <div className={styles.contactInfoActions}>
            <button type="button" onClick={() => setContactInfoOpen(false)}>
              <MessageCircle size={21} />
              <span>Chat</span>
            </button>
            <button type="button" onClick={() => handleContactInfoAction('appointment')}>
              <CalendarDays size={21} />
              <span>Agendar</span>
            </button>
            <button type="button" onClick={() => handleContactInfoAction('payment')}>
              <CreditCard size={21} />
              <span>Cobrar</span>
            </button>
          </div>

          <section className={styles.contactInfoSection}>
            <div className={styles.contactInfoMetrics}>
              <span className={styles.contactInfoMetric}>
                <small>Ingresos</small>
                <strong>{formatCurrency(Number(contactInfoData.ltv || 0) || revenueTotal)}</strong>
              </span>
              <span className={styles.contactInfoMetric}>
                <small>Compras</small>
                <strong>{purchasesCount}</strong>
              </span>
              <span className={styles.contactInfoMetric}>
                <small>Citas</small>
                <strong>{contactInfoAppointments.length}</strong>
              </span>
            </div>
          </section>

          <section className={styles.contactInfoSection}>
            <h3>Datos principales</h3>
            <div className={styles.contactInfoRows}>
              {renderContactInfoRow('phone', <Phone size={17} />, 'Número', contactInfoData.phone)}
              {renderContactInfoRow('email', <Mail size={17} />, 'Correo', contactInfoData.email)}
              {renderContactInfoRow('created', <User size={17} />, `Se hizo ${leadLabel.toLowerCase()}`, formatLocalDateTime(leadDate), leadSource)}
              {renderContactInfoRow('stage', <Tag size={17} />, 'Estado', contactInfoStageBadge?.text || (contactInfoData.status === 'customer' ? customerLabel : leadLabel))}
            </div>
          </section>

          <section className={styles.contactInfoSection}>
            <h3>Origen y conversión</h3>
            <div className={styles.contactInfoRows}>
              {renderContactInfoRow('source', <Globe2 size={17} />, 'Llegó desde', contactInfoSource || 'Sin origen guardado')}
              {renderContactInfoRow('first-visit', <MousePointerClick size={17} />, 'Primera visita', contactInfoTracking.started_at ? formatLocalDateTime(contactInfoTracking.started_at) : '')}
              {renderContactInfoRow('page', <FileText size={17} />, 'Página', pageName)}
              {renderContactInfoRow('campaign', <Megaphone size={17} />, 'Campaña', campaignName, campaignDetail)}
              {renderContactInfoRow('adset', <Layers size={17} />, 'Conjunto', adsetName, adsetDetail)}
              {renderContactInfoRow('ad', <ReceiptText size={17} />, 'Anuncio', adName, adDetail)}
              {renderContactInfoRow('device', <Smartphone size={17} />, 'Dispositivo', deviceName)}
              {renderContactInfoRow('location', <MapPin size={17} />, 'Ubicación', locationName)}
              {firstSuccessfulPayment
                ? renderContactInfoRow(
                    'conversion-payment',
                    <DollarSign size={17} />,
                    'Convirtió',
                    `${formatCurrency(firstSuccessfulPayment.amount)} · ${formatLocalDateTime(firstSuccessfulPayment.date)}`,
                    contactInfoSource
                  )
                : firstAppointment
                  ? renderContactInfoRow(
                      'conversion-appointment',
                      <CalendarDays size={17} />,
                      'Convirtió',
                      `${firstAppointment.title} · ${formatLocalDateTime(firstAppointment.startTime)}`,
                      contactInfoSource
                    )
                  : renderContactInfoRow('conversion-empty', <DollarSign size={17} />, 'Convirtió', 'Aún sin conversión registrada')}
            </div>
          </section>

          {(nextAppointment || contactInfoPayments.length > 0) && (
            <section className={styles.contactInfoSection}>
              <h3>Seguimiento</h3>
              <div className={styles.contactInfoRows}>
                {nextAppointment && renderContactInfoRow(
                  'next-appointment',
                  <Clock size={17} />,
                  'Próxima cita',
                  formatLocalDateTime(nextAppointment.startTime),
                  `${nextAppointment.title}${nextAppointment.status ? ` · ${formatPlainStatus(nextAppointment.status)}` : ''}`
                )}
                {contactInfoPayments.slice(0, 3).map((payment) => renderContactInfoRow(
                  `payment-${payment.id}`,
                  <CreditCard size={17} />,
                  'Pago',
                  `${formatCurrency(payment.amount)} · ${formatLocalDateShort(payment.date)}`,
                  formatPlainStatus(payment.status)
                ))}
              </div>
            </section>
          )}

          {visibleCustomFields.length > 0 && (
            <section className={styles.contactInfoSection}>
              <h3>Datos extra</h3>
              <div className={styles.contactInfoRows}>
                {visibleCustomFields.map((field) => renderContactInfoRow(
                  `custom-${field.id}`,
                  <FileText size={17} />,
                  field.label,
                  field.value
                ))}
              </div>
            </section>
          )}

          {contactInfoJourneyEvents.length > 0 && (
            <section className={styles.contactInfoSection}>
              <h3>Viaje del cliente</h3>
              <div className={styles.contactInfoTimeline}>
                {contactInfoJourneyEvents.map((event, index) => (
                  <div key={`${event.type}-${event.date}-${index}`} className={styles.contactInfoTimelineItem}>
                    <span className={`${styles.contactInfoTimelineIcon} ${getJourneyEventIconClass(event)}`}>
                      {getJourneyEventIcon(event)}
                      {getJourneyEventNetworkBadge(event)}
                    </span>
                    <div>
                      <strong>{getJourneyEventLabel(event, leadLabel)}</strong>
                      <small>{getJourneyEventDescription(event)}</small>
                      <em>{formatLocalDateTime(event.date)}</em>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </section>
    )
  }

  const renderNewChatSheet = () => (
    <div className={styles.newChatStack}>
      <div className={styles.sheetSearchBox}>
        <Search size={18} />
        <input
          value={contactQuery}
          onChange={(event) => setContactQuery(event.target.value)}
          placeholder="Buscar por nombre, número o correo"
          aria-label="Buscar contacto para chatear"
        />
        {contactQuery && (
          <button type="button" onClick={() => setContactQuery('')} aria-label="Limpiar búsqueda de contactos">
            <X size={16} />
          </button>
        )}
      </div>

      <div className={styles.sheetList} data-phone-chat-scrollable="true">
        {contactsLoading ? (
          <div className={styles.centerState}>
            <Loader2 size={20} className={styles.spinIcon} />
            <span>Buscando contactos...</span>
          </div>
        ) : contactResults.length > 0 ? (
          contactResults.map((contact) => renderContactButton(contact, 'contact'))
        ) : (
          <div className={styles.emptySheetState}>
            <User size={24} />
            <strong>No hay contactos</strong>
            <span>Escribe al menos dos letras o revisa que el contacto tenga teléfono.</span>
          </div>
        )}
      </div>
    </div>
  )

  const renderChatSettingsSheet = () => {
    const renderSettingsDetail = (title: string, children: React.ReactNode) => (
      <div className={styles.settingsDetailStack} data-phone-chat-scrollable="true">
        <div className={styles.settingsDetailHeader}>
          <button type="button" onClick={() => setActiveSettingsSection(null)}>
            <ChevronLeft size={18} />
            Ajustes
          </button>
          <strong>{title}</strong>
        </div>
        {children}
      </div>
    )

    const renderTemplateStatusList = () => {
      if (templatesLoading && templates.length === 0) {
        return (
          <div className={styles.centerState}>
            <Loader2 size={20} className={styles.spinIcon} />
            <span>Cargando plantillas...</span>
          </div>
        )
      }

      if (templatesError) {
        return (
          <div className={styles.emptySheetState}>
            <CircleAlert size={24} />
            <strong>No se cargaron</strong>
            <span>{templatesError}</span>
            <button type="button" onClick={loadTemplates}>Intentar otra vez</button>
          </div>
        )
      }

      if (templates.length === 0) {
        return (
          <div className={styles.emptySheetState}>
            <FileText size={24} />
            <strong>No hay plantillas</strong>
            <span>Crea una plantilla y cuando Meta la apruebe podrás usarla desde cualquier chat.</span>
          </div>
        )
      }

      return (
        <div className={styles.templateList}>
          {templatesRefreshing && (
            <div className={styles.cacheRefreshPill} role="status">
              <Loader2 size={14} className={styles.spinIcon} />
              Actualizando plantillas
            </div>
          )}
          {templates.map((template) => {
            const status = getTemplateStatus(template)
            const alertMessage = getTemplateAlertMessage(template)
            const reason = getTemplateBlockedReason(template, alertMessage)
            const statusClass = status === 'APPROVED'
              ? styles.templateStatusApproved
              : TEMPLATE_DISABLED_STATUSES.has(status)
                ? styles.templateStatusBlocked
                : styles.templateStatusPending

            return (
              <div key={`${template.id}-${template.language}`} className={styles.templateRow}>
                <span className={styles.templateRowIcon}>
                  <FileText size={18} />
                </span>
                <span className={styles.templateRowMain}>
                  <strong>{template.name}</strong>
                  <small>{getTemplateBodyPreview(template)}</small>
                  {status !== 'APPROVED' && <em>{reason}</em>}
                </span>
                <span className={`${styles.templateStatus} ${statusClass}`}>
                  {getTemplateStatusLabel(status)}
                </span>
              </div>
            )
          })}
        </div>
      )
    }

    const renderSettingsTemplateAlerts = () => {
      if (activeTemplateAlerts.length === 0) return null

      return (
        <div className={styles.templateAlertList}>
          {activeTemplateAlerts.slice(0, 3).map((alert) => (
            <div key={alert.id} className={styles.templateAlert}>
              <CircleAlert size={17} />
              <span>
                <strong>{alert.title}</strong>
                <small>{alert.message || 'Revisa esta plantilla antes de usarla.'}</small>
              </span>
            </div>
          ))}
        </div>
      )
    }

    if (activeSettingsSection === 'appearance') {
      return renderSettingsDetail('Apariencia', (
        <>
          <section className={styles.settingsSection}>
            <div className={styles.settingsSectionTitle}>
              <Sun size={18} />
              <span>
                <strong>Color del chat</strong>
                <small>Elige cómo quieres ver esta app en este celular.</small>
              </span>
            </div>
            <div className={styles.themeChoiceList} role="radiogroup" aria-label="Apariencia del chat">
              {PHONE_CHAT_THEME_OPTIONS.map(({ id, label, description, Icon: ThemeIcon }) => {
                const selected = safeChatThemePreference === id
                const optionDescription = id === 'system'
                  ? systemThemeAvailable
                    ? `Sigue el modo de ${phoneThemeDeviceLabel}.`
                    : 'Si no se puede leer el modo del equipo, usa el horario.'
                  : description

                return (
                  <button
                    key={id}
                    type="button"
                    className={`${styles.themeChoiceButton} ${selected ? styles.themeChoiceActive : ''}`}
                    role="radio"
                    aria-checked={selected}
                    onClick={() => saveConfigPreference(setChatThemePreference, id)}
                  >
                    <span className={styles.themeChoiceIcon}>
                      <ThemeIcon size={18} />
                    </span>
                    <span className={styles.themeChoiceText}>
                      <strong>{label}</strong>
                      <small>{optionDescription}</small>
                    </span>
                    <span className={styles.themeChoiceCheck} aria-hidden="true">
                      {selected && <Check size={16} />}
                    </span>
                  </button>
                )
              })}
            </div>
            <p className={styles.settingsHint}>
              Ahorita el chat se ve en modo {resolvedPhoneChatThemeLabel.toLowerCase()}.
            </p>
          </section>
        </>
      ))
    }

    if (activeSettingsSection === 'templates') {
      return renderSettingsDetail('Plantillas', (
        <>
          {templateMode === 'create' ? (
            <section className={styles.settingsSection}>
              <div className={styles.templateSubHeader}>
                <button type="button" onClick={() => setTemplateMode('send')}>
                  <ChevronLeft size={19} />
                  Plantillas
                </button>
                <strong>Nueva plantilla</strong>
              </div>
              <div className={styles.quickTemplateForm}>
                <label>
                  <span>Nombre</span>
                  <input
                    value={newTemplateName}
                    onChange={(event) => setNewTemplateName(event.target.value)}
                    placeholder="ej. recordatorio_cita"
                  />
                </label>
                <div className={styles.quickTemplateSplit}>
                  <label>
                    <span>Categoría</span>
                    <PhoneSelect
                      value={newTemplateCategory}
                      onChange={(value) => setNewTemplateCategory(value as MessageTemplateCategory)}
                      options={QUICK_TEMPLATE_CATEGORIES}
                      title="Categoría"
                      placeholder="Categoría"
                      buttonClassName={styles.quickTemplateSelect}
                    />
                  </label>
                  <label>
                    <span>Idioma</span>
                    <PhoneSelect
                      value={newTemplateLanguage}
                      onChange={setNewTemplateLanguage}
                      options={QUICK_TEMPLATE_LANGUAGES}
                      title="Idioma"
                      placeholder="Idioma"
                      buttonClassName={styles.quickTemplateSelect}
                    />
                  </label>
                </div>
                <label>
                  <span>Mensaje</span>
                  <textarea
                    value={newTemplateBody}
                    onChange={(event) => setNewTemplateBody(event.target.value)}
                    placeholder="Hola, te escribo de Ristak para confirmar..."
                    rows={5}
                  />
                </label>
                <button
                  type="button"
                  className={styles.primarySheetButton}
                  onClick={handleCreateQuickTemplate}
                  disabled={creatingTemplate}
                >
                  {creatingTemplate ? <Loader2 size={18} className={styles.spinIcon} /> : <Plus size={18} />}
                  Crear y enviar a revisión
                </button>
              </div>
            </section>
          ) : (
            <>
              <section className={styles.settingsActionCard}>
                <span>
                  <FileText size={18} />
                </span>
                <div>
                  <strong>Plantillas de WhatsApp</strong>
                  <small>Consulta estados, rechazos y crea mensajes para revisión de Meta.</small>
                </div>
                <button type="button" onClick={() => setTemplateMode('create')}>
                  Crear
                </button>
              </section>
              <button type="button" className={styles.settingsRefreshButton} onClick={loadTemplates} disabled={templatesLoading || templatesRefreshing}>
                {templatesLoading || templatesRefreshing ? <Loader2 size={16} className={styles.spinIcon} /> : <FileText size={16} />}
                Actualizar plantillas
              </button>
              {renderSettingsTemplateAlerts()}
              {renderTemplateStatusList()}
            </>
          )}
        </>
      ))
    }

    if (activeSettingsSection === 'numbers') {
      return renderSettingsDetail('Números de WhatsApp', (
        <section className={styles.settingsSection}>
          <div className={styles.settingsSectionTitle}>
            <Smartphone size={18} />
            <span>
              <strong>Vista de conversaciones</strong>
              <small>Elige cómo quieres ver los chats cuando tengas más de un número conectado.</small>
            </span>
          </div>
          <div className={styles.settingsSegmented} role="group" aria-label="Modo de números de WhatsApp">
            <button
              type="button"
              className={whatsappNumberMode === 'merged' ? styles.settingsSegmentActive : ''}
              onClick={() => saveConfigPreference(setWhatsappNumberMode, 'merged')}
            >
              Todos juntos
            </button>
            <button
              type="button"
              className={whatsappNumberMode === 'separated' ? styles.settingsSegmentActive : ''}
              onClick={() => saveConfigPreference(setWhatsappNumberMode, 'separated')}
            >
              Separados
            </button>
          </div>
          {businessPhones.length <= 1 && (
            <p className={styles.settingsHint}>Cuando conectes otro número, aparecerá el selector junto al título Chats.</p>
          )}
        </section>
      ))
    }

    if (activeSettingsSection === 'notifications') {
      return renderSettingsDetail('Notificaciones', (
        <>
          <section className={styles.permissionCard}>
            <span>
              <Smartphone size={18} />
            </span>
            <div>
              <strong>Este celular</strong>
              <small>{getNotificationPermissionLabel()}</small>
            </div>
            <button type="button" onClick={handleRequestPush} disabled={requestingPush}>
              {requestingPush ? <Loader2 size={16} className={styles.spinIcon} /> : <Bell size={16} />}
              Activar
            </button>
          </section>
          <label className={styles.toggleRow}>
            <span>
              <strong>Mensajes del chat</strong>
              <small>Avísame cuando llegue un WhatsApp nuevo.</small>
            </span>
            <input
              type="checkbox"
              checked={chatPushEnabled}
              onChange={(event) => saveConfigPreference(setChatPushEnabled, event.target.checked)}
            />
          </label>
          <label className={styles.toggleRow}>
            <span>
              <strong>Citas</strong>
              <small>Avísame cuando alguien agende una cita.</small>
            </span>
            <input
              type="checkbox"
              checked={calendarPushEnabled}
              onChange={(event) => saveConfigPreference(setCalendarPushEnabled, event.target.checked)}
            />
          </label>
          <label className={styles.toggleRow}>
            <span>
              <strong>Pagos</strong>
              <small>Avísame cuando se registre un pago.</small>
            </span>
            <input
              type="checkbox"
              checked={paymentPushEnabled}
              onChange={(event) => saveConfigPreference(setPaymentPushEnabled, event.target.checked)}
            />
          </label>
        </>
      ))
    }

    if (activeSettingsSection === 'agent') {
      return renderSettingsDetail('Agente IA', (
        <>
          <label className={styles.toggleRow}>
            <span>
              <strong>Mostrar como primer chat</strong>
              <small>El agente aparece fijo arriba de tus conversaciones.</small>
            </span>
            <input
              type="checkbox"
              checked={aiAgentChatEnabled}
              onChange={(event) => saveConfigPreference(setAiAgentChatEnabled, event.target.checked)}
            />
          </label>
          <label className={`${styles.toggleRow} ${!aiAgentChatEnabled ? styles.toggleRowDisabled : ''}`}>
            <span>
              <strong>Sugerir respuestas</strong>
              <small>El agente puede preparar un texto para responder en chats reales.</small>
            </span>
            <input
              type="checkbox"
              checked={aiReplySuggestionsEnabled}
              disabled={!aiAgentChatEnabled}
              onChange={(event) => saveConfigPreference(setAiReplySuggestionsEnabled, event.target.checked)}
            />
          </label>
        </>
      ))
    }

    if (activeSettingsSection === 'chats') {
      return renderSettingsDetail('Lista de chats', (
        <>
          <section className={styles.settingsSection}>
            <div className={styles.settingsField}>
              <strong>Ordenar conversaciones</strong>
              <div className={styles.settingsSegmented} role="group" aria-label="Orden de conversaciones">
                <button
                  type="button"
                  className={conversationSortMode === 'recent' ? styles.settingsSegmentActive : ''}
                  onClick={() => saveConfigPreference(setConversationSortMode, 'recent')}
                >
                  Más recientes
                </button>
                <button
                  type="button"
                  className={conversationSortMode === 'unread' ? styles.settingsSegmentActive : ''}
                  onClick={() => saveConfigPreference(setConversationSortMode, 'unread')}
                >
                  No leídas
                </button>
              </div>
            </div>
          </section>
          <label className={styles.toggleRow}>
            <span>
              <strong>Mostrar archivados</strong>
              <small>Deja visible el acceso a chats archivados.</small>
            </span>
            <input
              type="checkbox"
              checked={showArchivedChats}
              onChange={(event) => saveConfigPreference(setShowArchivedChats, event.target.checked)}
            />
          </label>
          <label className={styles.toggleRow}>
            <span>
              <strong>Vista previa</strong>
              <small>Muestra un resumen debajo del nombre del contacto.</small>
            </span>
            <input
              type="checkbox"
              checked={showLastMessagePreview}
              onChange={(event) => saveConfigPreference(setShowLastMessagePreview, event.target.checked)}
            />
          </label>
          <label className={styles.toggleRow}>
            <span>
              <strong>Indicadores de no leídos</strong>
              <small>Muestra el contador verde cuando hay mensajes nuevos.</small>
            </span>
            <input
              type="checkbox"
              checked={showUnreadIndicators}
              onChange={(event) => saveConfigPreference(setShowUnreadIndicators, event.target.checked)}
            />
          </label>
        </>
      ))
    }

    const settingsItems: Array<{
      id: Exclude<ChatSettingsSection, null>
      title: string
      description: string
      meta?: string
      Icon: React.ElementType
    }> = [
      { id: 'numbers', title: 'Números de WhatsApp', description: 'Cómo se muestran tus líneas.', meta: whatsappNumberMode === 'merged' ? 'Juntos' : 'Separados', Icon: Smartphone },
      { id: 'templates', title: 'Plantillas', description: 'Crear y revisar estados de Meta.', meta: `${templates.length} guardadas`, Icon: FileText },
      { id: 'agent', title: 'Agente IA', description: 'Chat fijo y sugerencias.', meta: aiAgentChatEnabled ? 'Activo' : 'Apagado', Icon: Bot },
      { id: 'chats', title: 'Lista de chats', description: 'Orden, archivados y vista previa.', meta: conversationSortMode === 'recent' ? 'Recientes' : 'No leídas', Icon: MessageCircle },
      { id: 'appearance', title: 'Apariencia', description: 'Claro, noche, sistema u horario.', meta: chatThemeMeta, Icon: Sun },
      { id: 'notifications', title: 'Notificaciones', description: 'Mensajes, citas y pagos.', meta: getNotificationPermissionLabel(), Icon: Bell }
    ]

    return (
      <div className={styles.chatSettingsStack} data-phone-chat-scrollable="true">
        <div className={styles.settingsListGroup}>
          {settingsItems.map(({ id, title, description, meta, Icon: SettingsIcon }) => (
            <button
              key={id}
              type="button"
              className={styles.settingsListItem}
              onClick={() => {
                setActiveSettingsSection(id)
                if (id === 'templates') {
                  setTemplateMode('send')
                  loadTemplates()
                }
              }}
            >
              <span className={styles.settingsListIcon}>
                <SettingsIcon size={18} />
              </span>
              <span className={styles.settingsListText}>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
              <span className={styles.settingsListMeta}>
                {meta && <small>{meta}</small>}
                <ChevronRight size={18} />
              </span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  const renderTemplatesSheet = () => {
    const renderTemplateAlerts = () => {
      if (activeTemplateAlerts.length === 0) return null

      return (
        <div className={styles.templateAlertList}>
          {activeTemplateAlerts.slice(0, 3).map((alert) => (
            <div key={alert.id} className={styles.templateAlert}>
              <CircleAlert size={17} />
              <span>
                <strong>{alert.title}</strong>
                <small>{alert.message || 'Revisa esta plantilla antes de usarla.'}</small>
              </span>
            </div>
          ))}
        </div>
      )
    }

    if (templateMode === 'choice') {
      return (
        <div className={styles.templatesStack} data-phone-chat-scrollable="true">
          <div className={styles.templateChoiceGrid}>
            <button type="button" onClick={() => setTemplateMode('send')}>
              <span>
                <Send size={20} />
              </span>
              <strong>Enviar creada</strong>
              <small>Usa una plantilla aprobada por Meta.</small>
            </button>
            <button type="button" onClick={() => setTemplateMode('create')}>
              <span>
                <Plus size={22} />
              </span>
              <strong>Crear nueva</strong>
              <small>Escríbela y mándala a revisión.</small>
            </button>
          </div>
          {renderTemplateAlerts()}
        </div>
      )
    }

    if (templateMode === 'create') {
      return (
        <div className={styles.templatesStack} data-phone-chat-scrollable="true">
          <div className={styles.templateSubHeader}>
            <button type="button" onClick={() => setTemplateMode('choice')}>
              <ChevronLeft size={19} />
              Atrás
            </button>
            <strong>Nueva plantilla</strong>
          </div>

          <div className={styles.quickTemplateForm}>
            <label>
              <span>Nombre</span>
              <input
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
                placeholder="ej. recordatorio_cita"
              />
            </label>
            <div className={styles.quickTemplateSplit}>
              <label>
                <span>Categoría</span>
                <PhoneSelect
                  value={newTemplateCategory}
                  onChange={(value) => setNewTemplateCategory(value as MessageTemplateCategory)}
                  options={QUICK_TEMPLATE_CATEGORIES}
                  title="Categoría"
                  placeholder="Categoría"
                  buttonClassName={styles.quickTemplateSelect}
                />
              </label>
              <label>
                <span>Idioma</span>
                <PhoneSelect
                  value={newTemplateLanguage}
                  onChange={setNewTemplateLanguage}
                  options={QUICK_TEMPLATE_LANGUAGES}
                  title="Idioma"
                  placeholder="Idioma"
                  buttonClassName={styles.quickTemplateSelect}
                />
              </label>
            </div>
            <label>
              <span>Mensaje</span>
              <textarea
                value={newTemplateBody}
                onChange={(event) => setNewTemplateBody(event.target.value)}
                placeholder="Hola, te escribo de Ristak para confirmar..."
                rows={5}
              />
            </label>
            <button
              type="button"
              className={styles.primarySheetButton}
              onClick={handleCreateQuickTemplate}
              disabled={creatingTemplate}
            >
              {creatingTemplate ? <Loader2 size={18} className={styles.spinIcon} /> : <Plus size={18} />}
              Crear y enviar a revisión
            </button>
          </div>
        </div>
      )
    }

    return (
      <div className={styles.templatesStack} data-phone-chat-scrollable="true">
        <div className={styles.templateSubHeader}>
          <button type="button" onClick={() => setTemplateMode('choice')}>
            <ChevronLeft size={19} />
            Atrás
          </button>
          <strong>Plantillas creadas</strong>
          <button type="button" onClick={loadTemplates} disabled={templatesLoading || templatesRefreshing}>
            {templatesLoading || templatesRefreshing ? <Loader2 size={16} className={styles.spinIcon} /> : 'Actualizar'}
          </button>
        </div>

        {renderTemplateAlerts()}

        {templatesLoading && templates.length === 0 ? (
          <div className={styles.centerState}>
            <Loader2 size={20} className={styles.spinIcon} />
            <span>Cargando plantillas...</span>
          </div>
        ) : templatesError ? (
          <div className={styles.emptySheetState}>
            <CircleAlert size={24} />
            <strong>No se cargaron</strong>
            <span>{templatesError}</span>
            <button type="button" onClick={loadTemplates}>Intentar otra vez</button>
          </div>
        ) : templates.length === 0 ? (
          <div className={styles.emptySheetState}>
            <FileText size={24} />
            <strong>No hay plantillas</strong>
            <span>Crea una nueva y cuando Meta la apruebe podrás mandarla desde este chat.</span>
          </div>
        ) : (
          <div className={styles.templateList}>
            {templatesRefreshing && (
              <div className={styles.cacheRefreshPill} role="status">
                <Loader2 size={14} className={styles.spinIcon} />
                Actualizando plantillas
              </div>
            )}
            {templates.map((template) => {
              const status = getTemplateStatus(template)
              const approved = status === 'APPROVED'
              const alertMessage = getTemplateAlertMessage(template)
              const reason = getTemplateBlockedReason(template, alertMessage)
              const statusClass = approved
                ? styles.templateStatusApproved
                : TEMPLATE_DISABLED_STATUSES.has(status)
                  ? styles.templateStatusBlocked
                  : styles.templateStatusPending

              return (
                <button
                  key={`${template.id}-${template.language}`}
                  type="button"
                  className={styles.templateRow}
                  onClick={() => handleSendTemplate(template)}
                  disabled={!approved || Boolean(templateSendingId)}
                >
                  <span className={styles.templateRowIcon}>
                    <FileText size={18} />
                  </span>
                  <span className={styles.templateRowMain}>
                    <strong>{template.name}</strong>
                    <small>{getTemplateBodyPreview(template)}</small>
                    {!approved && <em>{reason}</em>}
                  </span>
                  <span className={`${styles.templateStatus} ${statusClass}`}>
                    {templateSendingId === template.id ? <Loader2 size={13} className={styles.spinIcon} /> : getTemplateStatusLabel(status)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const renderAttachmentsSheet = () => {
    const attachmentActions = [
      { label: 'Plantillas', Icon: FileText, className: styles.actionTemplate, onClick: handleOpenTemplatesSheet },
      { label: 'Fotos', Icon: ImageIcon, className: styles.actionBlue, onClick: () => handlePickPhoto('photos') },
      { label: 'Cámara', Icon: Camera, className: styles.actionDark, onClick: () => handlePickPhoto('camera') },
      { label: 'Ubicación', Icon: MapPin, className: styles.actionGreen, onClick: () => handleUnavailableAttachment('Ubicación') },
      { label: 'Documento', Icon: FileText, className: styles.actionSky, onClick: () => handleUnavailableAttachment('Documento') }
    ]

    return (
      <div className={styles.attachmentGrid}>
        {attachmentActions.map(({ label, Icon: ActionIcon, className, onClick }) => (
          <button key={label} type="button" onClick={onClick}>
            <span className={className}>
              <ActionIcon size={31} />
            </span>
            <strong>{label}</strong>
          </button>
        ))}
      </div>
    )
  }

  const renderChatMoreSheet = () => {
    if (!chatActionContact) {
      return (
        <div className={styles.emptySheetState}>
          <CircleAlert size={24} />
          <strong>Elige un chat</strong>
          <span>Vuelve a la lista y desliza una conversación para ver sus acciones.</span>
        </div>
      )
    }

    const isMuted = mutedChatIdSet.has(chatActionContact.id)
    const actions = [
      {
        label: 'Agendar cita',
        description: 'Crear una cita para este contacto.',
        Icon: CalendarDays,
        className: styles.chatMoreAppointment,
        onClick: () => handleOpenAppointmentForm(chatActionContact)
      },
      {
        label: 'Registrar pagos',
        description: highLevelConnected ? 'Guardar un pago o plan de pagos.' : 'Guardar un pago único.',
        Icon: CircleDollarSign,
        className: styles.chatMorePayment,
        onClick: () => handleChatMoreAction(chatActionContact, 'payment')
      },
      {
        label: isMuted ? 'Quitar silencio' : 'Silenciar',
        description: isMuted ? 'Quitar la marca de silencio de este chat.' : 'Marcar este chat como silenciado.',
        Icon: isMuted ? Bell : BellOff,
        className: styles.chatMoreMute,
        onClick: () => handleToggleMuteChat(chatActionContact)
      }
    ]

    return (
      <div className={styles.chatMoreList}>
        {actions.map(({ label, description, Icon: ActionIcon, className, onClick }) => (
          <button key={label} type="button" onClick={onClick}>
            <span className={className}>
              <ActionIcon size={22} />
            </span>
            <span>
              <strong>{label}</strong>
              <small>{description}</small>
            </span>
          </button>
        ))}
      </div>
    )
  }

  if (accessState === 'checking') {
    return (
      <main className={styles.loadingPage}>
        <span className={styles.loadingDot} />
      </main>
    )
  }

  if (accessState === 'blocked') {
    return (
      <main className={styles.blockedPage}>
        <section className={styles.blockedPanel} aria-labelledby="phone-chat-blocked-title">
          <div className={styles.blockedIcon} aria-hidden="true">
            <MonitorX size={28} />
          </div>
          <div className={styles.blockedCopy}>
            <p className={styles.eyebrow}>Ristak Chat</p>
            <h1 id="phone-chat-blocked-title">Sólo móvil o tablet</h1>
            <p>Esta app de chat está hecha para usarse desde el celular, como una app guardada en tu pantalla de inicio.</p>
          </div>
          <Link className={styles.dashboardLink} to="/dashboard">
            Volver al panel
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main
      className={`${styles.phoneChatPage} ${conversationVisible ? styles.conversationOpen : ''}`}
      data-phone-chat-tone={resolvedPhoneChatTheme}
      data-phone-chat-mode={safeChatThemePreference}
      aria-label="Chat móvil de Ristak"
    >
      <PhonePageTransition
        active="chat"
        className={styles.phoneFrame}
        data-phone-chat-frame="true"
        onScroll={handlePhoneFrameScroll}
      >
        <section className={styles.chatListScreen} aria-label="Lista de chats">
          <header className={`${styles.chatListHeader} ${chatSearchExpanded ? styles.chatListHeaderSearchExpanded : ''}`}>
            <div className={styles.topActionRow} aria-hidden={chatSearchExpanded}>
              <span className={styles.topActionSpacer} aria-hidden="true" />
              <div className={styles.topRightActions}>
                <button type="button" className={styles.roundButton} onClick={() => handlePickPhoto('camera', 'cameraShare')} aria-label="Abrir cámara">
                  <Camera size={24} />
                </button>
                <button type="button" className={styles.newChatButton} onClick={() => setSheet('newChat')} aria-label="Nuevo chat">
                  <Plus size={32} />
                </button>
              </div>
            </div>
            <div className={styles.chatTitleRow} aria-hidden={chatSearchExpanded}>
              <h1>Chats</h1>
              {chatPhoneFilterEnabled && (
                <label className={styles.chatPhoneSelector}>
                  <span>Número</span>
                  <PhoneSelect
                    value={effectiveSelectedChatPhoneId}
                    onChange={(value) => saveConfigPreference(setSelectedChatPhoneId, value)}
                    ariaLabel="Elegir número de WhatsApp para ver chats"
                    options={[
                      { value: 'all', label: 'Ver todos' },
                      ...businessPhones.map((phone, index) => ({
                        value: phone.id,
                        label: `Ver chats de ${getBusinessPhoneLabel(phone) || `número ${index + 1}`}`
                      }))
                    ]}
                    title="Número"
                    placeholder="Número"
                    buttonClassName={styles.chatPhoneSelect}
                  />
                </label>
              )}
            </div>
            <div className={styles.searchBox}>
              <Search size={22} />
              <input
                value={chatQuery}
                onChange={(event) => setChatQuery(event.target.value)}
                placeholder="Buscar chats o contactos"
                aria-label="Buscar chats o contactos"
              />
              {chatQuery && (
                <button type="button" onClick={() => setChatQuery('')} aria-label="Limpiar búsqueda">
                  <X size={17} />
                </button>
              )}
            </div>
            <div className={styles.filterChips} data-phone-chat-scrollable="true" aria-hidden={chatSearchExpanded}>
              {([
                ['all', 'Todos'],
                ['unread', unreadTotal > 0 ? `No leídos ${unreadTotal > 99 ? '99+' : unreadTotal}` : 'No leídos'],
                ['appointments', 'Agendados'],
                ['customers', customersLabel],
                ['leads', leadsLabel]
              ] as Array<[ChatFilter, string]>).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={chatFilter === key ? styles.filterChipActive : ''}
                  aria-pressed={chatFilter === key}
                  onClick={() => setChatFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          </header>

          <div className={styles.chatList} data-phone-chat-scrollable="true">
            {renderChats()}
          </div>

        </section>

        <section className={styles.conversationScreen} aria-label="Conversación">
          <header className={styles.conversationHeader}>
            <button type="button" className={styles.backButton} onClick={handleBackToChats} aria-label="Volver a chats">
              <ChevronLeft size={32} />
            </button>

            {aiAgentConversationOpen ? (
              <div className={styles.conversationContactButton}>
                {renderAIAgentAvatar()}
                <span className={styles.conversationIdentity}>
                  <strong>Agente de inteligencia artificial</strong>
                  <span>Te ayuda dentro de Ristak</span>
                </span>
              </div>
            ) : activeContact ? (
              <>
                <button
                  type="button"
                  className={styles.conversationContactButton}
                  onClick={handleOpenContactInfo}
                  aria-label="Ver información del contacto"
                >
                  {renderAvatar(activeContact)}
                  <span className={styles.conversationIdentity}>
                    <strong>{getContactName(activeContact)}</strong>
                    <span>{getContactDetail(activeContact)}</span>
                  </span>
                </button>
              </>
            ) : (
              <div className={styles.conversationIdentity}>
                <strong>Sin contacto</strong>
                <span>Elige una conversación</span>
              </div>
            )}

            {aiAgentConversationOpen ? (
              <span className={styles.conversationHeaderSpacer} aria-hidden="true" />
            ) : (
              <div className={styles.callActions}>
                <button type="button" onClick={() => handleOpenAppointmentForm(activeContact)} aria-label="Agendar cita">
                  <CalendarDays size={25} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPaymentMode('single')
                    setSheet('payment')
                  }}
                  aria-label="Cobrar"
                >
                  <CircleDollarSign size={25} />
                </button>
              </div>
            )}
          </header>

          <div
            ref={messagesPaneRef}
            className={styles.messagesPane}
            data-phone-chat-scrollable="true"
            onScroll={handleMessagesPaneScroll}
          >
            {renderMessages()}
            <div ref={messagesEndRef} />
          </div>

          <div className={styles.composerShell} data-phone-chat-composer="true">
            {aiAgentConversationOpen ? (
              renderAIAgentComposer()
            ) : (
              <>
                {renderSenderBar()}
                {!composerBlockedByReplyWindow && renderAISuggestionBar()}
                {!composerBlockedByReplyWindow && renderDraftAttachments()}
                {!composerBlockedByReplyWindow && renderVoiceDraft()}
                {composerBlockedByReplyWindow ? (
                  <div className={styles.replyWindowBlockedComposer}>
                    <span className={styles.replyWindowBlockedIcon}>
                      <Clock size={18} />
                    </span>
                    <span className={styles.replyWindowBlockedText}>
                      <strong>Fuera de 24 horas</strong>
                      <small>Manda una plantilla para volver a escribirle.</small>
                    </span>
                    <button type="button" onClick={handleOpenTemplatesSheet} aria-label="Enviar plantilla">
                      <FileText size={20} />
                    </button>
                  </div>
                ) : (
                  <div className={`${styles.composer} ${hasComposerContent ? styles.composerHasContent : ''}`}>
                    <button type="button" className={styles.composerPlus} onClick={() => setSheet('attachments')} aria-label="Abrir adjuntos">
                      <Plus size={34} />
                    </button>
                    <div className={styles.messageInputWrap}>
                      <div
                        ref={composerInputRef}
                        className={styles.composerInput}
                        role="textbox"
                        aria-multiline="true"
                        aria-label="Mensaje"
                        aria-disabled={composerInputDisabled}
                        data-placeholder={composerPlaceholder}
                        contentEditable={!composerInputDisabled}
                        suppressContentEditableWarning
                        spellCheck
                        autoCorrect="on"
                        autoCapitalize="sentences"
                        onInput={(event) => syncComposerText(event.currentTarget)}
                        onPaste={handleComposerPaste}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.shiftKey) {
                            event.preventDefault()
                            handleSendMessage()
                          }
                        }}
                      />
                    </div>
                    <div className={styles.composerTrailingActions}>
                      <button
                        type="button"
                        className={`${styles.composerIconButton} ${styles.composerCameraButton}`}
                        onClick={() => handlePickPhoto('camera')}
                        disabled={hasComposerContent}
                        tabIndex={hasComposerContent ? -1 : undefined}
                        aria-hidden={hasComposerContent}
                        aria-label="Cámara"
                      >
                        <Camera size={29} />
                      </button>
                      <button
                        type="button"
                        className={`${styles.composerIconButton} ${canSendMessage ? styles.composerSendButton : ''} ${voiceRecording ? styles.composerMicRecording : ''}`}
                        onClick={handleVoiceOrSendButtonClick}
                        disabled={composerStatus === 'sending'}
                        aria-label={voiceRecording ? 'Detener grabación' : canSendMessage ? 'Enviar mensaje' : 'Grabar mensaje de voz'}
                      >
                        {canSendMessage ? <ArrowRight size={23} /> : <Mic size={30} />}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {renderContactInfoScreen()}
        {renderCameraShareScreen()}
      </PhonePageTransition>

      {!conversationOpen && !cameraSharePhoto && <PhoneEcosystemNav active="chat" badges={{ chat: unreadTotal }} />}

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className={styles.hiddenFileInput}
        onChange={(event) => handleWebPhotoSelected('camera', event)}
      />
      <input
        ref={photosInputRef}
        type="file"
        accept="image/*"
        className={styles.hiddenFileInput}
        onChange={(event) => handleWebPhotoSelected('photos', event)}
      />

      {sheet && (
        <div
          className={`${styles.sheetBackdrop} ${sheet === 'settings' ? styles.settingsSheetBackdrop : ''} ${sheet === 'payment' || sheet === 'settings' || sheet === 'chatMore' ? styles.darkSheetBackdrop : ''} ${sheet === 'chatMore' ? styles.chatMoreSheetBackdrop : ''} ${actionSheetDismiss.closing ? styles.sheetBackdropClosing : ''}`}
          style={actionSheetDismiss.backdropStyle}
          onClick={actionSheetDismiss.requestClose}
        >
          <section
            className={`${styles.sheetPanel} ${sheet === 'payment' ? styles.paymentSheet : ''} ${sheet === 'attachments' ? styles.attachmentsSheet : ''} ${sheet === 'templates' ? styles.templatesSheet : ''} ${sheet === 'settings' ? styles.settingsSheet : ''} ${sheet === 'newChat' ? styles.newChatSheet : ''} ${sheet === 'chatMore' ? styles.chatMoreSheet : ''} ${actionSheetDismiss.closing ? styles.sheetPanelClosing : ''}`}
            style={actionSheetDismiss.sheetStyle}
            onClick={(event) => event.stopPropagation()}
            aria-label="Acciones del chat"
            {...actionSheetDismiss.sheetDragProps}
          >
            <div className={styles.sheetHandle} aria-hidden="true" />
            {sheet !== 'attachments' && (
              <div className={styles.sheetHeader}>
                <div>
                  {sheet !== 'payment' && (
                    <p>{activeContact ? getContactName(activeContact) : aiAgentConversationOpen ? 'Agente de IA' : 'Ristak Chat'}</p>
                  )}
                  <h2>
                    {sheet === 'payment' && 'Registrar pago'}
                    {sheet === 'templates' && 'Plantillas'}
                    {sheet === 'settings' && 'Ajustes del chat'}
                    {sheet === 'newChat' && 'Nuevo chat'}
                    {sheet === 'chatMore' && 'Más acciones'}
                  </h2>
                </div>
              </div>
            )}

            {sheet === 'newChat' && renderNewChatSheet()}
            {sheet === 'attachments' && renderAttachmentsSheet()}
            {sheet === 'templates' && renderTemplatesSheet()}
            {sheet === 'settings' && renderChatSettingsSheet()}
            {sheet === 'chatMore' && renderChatMoreSheet()}

            {sheet === 'payment' && (
              <>
                {highLevelConnected && (
                  <div className={styles.segmentedControl}>
                    <button
                      type="button"
                      className={activePhonePaymentMode === 'single' ? styles.segmentActive : ''}
                      onClick={() => setPaymentMode('single')}
                    >
                      Pago único
                    </button>
                    <button
                      type="button"
                      className={activePhonePaymentMode === 'partial' ? styles.segmentActive : ''}
                      onClick={() => setPaymentMode('partial')}
                    >
                      Plan de pagos
                    </button>
                  </div>
                )}
                <div className={styles.embeddedPayment}>
                  <RecordPaymentModal
                    key={`${activePhonePaymentMode}-${initialContact?.id || 'empty'}`}
                    variant="embedded"
                    isOpen
                    initialPaymentMode={activePhonePaymentMode}
                    initialContact={initialContact}
                    lockInitialContact={Boolean(initialContact?.id)}
                    onClose={actionSheetDismiss.requestClose}
                    onSuccess={() => {
                      actionSheetDismiss.requestClose()
                      setMessages((current) => [
                        ...current,
                        {
                          id: `payment-${Date.now()}`,
                          text: 'Pago registrado desde este chat.',
                          date: new Date().toISOString(),
                          direction: 'system'
                        }
                      ])
                    }}
                  />
                </div>
              </>
            )}

          </section>
        </div>
      )}

      <AppointmentModal
        isOpen={appointmentOpen}
        onClose={() => setAppointmentOpen(false)}
        mode="create"
        calendar={selectedCalendar}
        defaultStart={defaultAppointmentRange.start}
        defaultEnd={defaultAppointmentRange.end}
        defaultTimeZone={defaultAppointmentRange.timeZone}
        defaultTitle={initialContact?.name || ''}
        initialContact={initialContact}
        lockInitialContact={Boolean(initialContact?.id)}
        enableGuests
        defaultScheduleMode="default"
        accessToken={accessToken || undefined}
        locationId={locationId || undefined}
        presentation="mobileSheet"
        calendars={calendars}
        calendarsLoading={calendarsLoading}
        selectedCalendarId={selectedCalendar?.id || ''}
        onCalendarChange={setSelectedCalendarId}
        onSave={handleCreateAppointment}
      />
    </main>
  )
}
