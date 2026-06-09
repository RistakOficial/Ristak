import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowRight,
  Banknote,
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
  Copy,
  CreditCard,
  DollarSign,
  FileText,
  Forward,
  Globe2,
  Image as ImageIcon,
  Layers,
  Languages,
  Link2,
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
  Pause,
  Pencil,
  Phone,
  Pin,
  Play,
  Plus,
  ReceiptText,
  Reply,
  Search,
  Send,
  Sparkles,
  Smartphone,
  Star,
  Sun,
  Tag,
  Trash2,
  User,
  Video,
  X
} from 'lucide-react'
import { FaMicrophone } from 'react-icons/fa'
import { MdArchive } from 'react-icons/md'
import { AppointmentModal, Icon, RecordPaymentModal } from '@/components/common'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhonePageTransition } from '@/components/phone/PhonePageTransition'
import { PhoneSelect } from '@/components/phone/PhoneSelect'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig, useBottomSheetDismiss, useHighLevelConnected, usePhoneElasticScroll, usePhoneTheme, type PhoneThemePreference } from '@/hooks'
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
import { mobileAppService, type MobileChatAttachment, type MobileDocumentAttachment, type MobilePhotoAttachment } from '@/services/mobileAppService'
import { getPhoneDailyCacheKey, readPhoneDailyCache, writePhoneDailyCache } from '@/services/phoneDailyCache'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { whatsappApiService, type ScheduledChatMessage, type WhatsAppApiStatus, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import type { Contact, ContactCustomField, ContactCustomFieldDefinition } from '@/types'
import { getContactStageBadge } from '@/utils/contactStageBadge'
import {
  formatContactCustomFieldDisplayValue,
  getContactCustomFieldDisplayLabel,
  getContactCustomFieldIdentity,
  getContactCustomFieldKeys
} from '@/utils/contactCustomFields'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { getPortableDeviceMode, writeTabletViewPreference, type PortableDeviceMode } from '@/utils/phoneAccess'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import styles from './PhoneChat.module.css'

const COARSE_POINTER_QUERY = '(pointer: coarse)'
const SCROLLABLE_CHAT_SELECTOR = '[data-phone-chat-scrollable="true"], [data-phone-scrollable="true"]'
const CHAT_READ_STATE_KEY = 'ristak_phone_chat_read_state_v1'
const CHAT_ARCHIVED_STATE_KEY = 'ristak_phone_chat_archived_state_v1'
const CHAT_MUTED_STATE_KEY = 'ristak_phone_chat_muted_state_v1'
const CHAT_STARRED_MESSAGES_KEY = 'ristak_phone_chat_starred_messages_v1'
const PAYMENT_BANK_CLABES_CONFIG_KEY = 'payment_bank_clabes'
const CONTACT_INFO_CUSTOM_FIELDS_CONFIG_KEY = 'mobile_chat_contact_info_custom_field_ids'
const AI_AGENT_CHAT_ID = 'ristak-ai-agent-mobile-chat'
const AI_AGENT_MESSAGES_KEY = 'ristak_phone_chat_ai_agent_messages_v1'
const CHAT_SWIPE_ACTION_WIDTH = 184
const CHAT_SWIPE_TRANSITION_MS = 260
const CHAT_SWIPE_OPEN_THRESHOLD = 44
const CHAT_SWIPE_CLOSE_THRESHOLD = 132
const CHAT_SWIPE_ACTIVATE_THRESHOLD = 7
const CHAT_SWIPE_RENDER_STEP = 1
const MESSAGE_INFO_SWIPE_ACTION_WIDTH = 46
const MESSAGE_INFO_SWIPE_OPEN_THRESHOLD = 38
const MESSAGE_INFO_SWIPE_ACTIVATE_THRESHOLD = 9
const MESSAGE_INFO_SWIPE_RENDER_STEP = 2
const MESSAGE_ACTION_LONG_PRESS_MS = 460
const MESSAGE_ACTION_MOVE_TOLERANCE = 9
const MESSAGE_ACTION_LONG_PRESS_VIBRATION_MS = 14
const MAX_VOICE_MESSAGE_BYTES = 16 * 1024 * 1024
const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024
const DOCUMENT_ATTACHMENT_ACCEPT = [
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.txt',
  '.csv',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv'
].join(',')
const DOCUMENT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv'
}
const MIN_VOICE_RECORDING_MS = 600
const MAX_VOICE_RECORDING_MS = 3 * 60 * 1000
const VOICE_HOLD_TO_PREVIEW_MS = 430
const VOICE_WAVE_BAR_COUNT = 54
const VOICE_WAVE_MIN_HEIGHT = 4
const VOICE_WAVE_MAX_HEIGHT = 34
const VOICE_WAVE_SAMPLE_INTERVAL_MS = 64
const VOICE_WAVE_SILENCE_THRESHOLD = 4
const VOICE_WAVE_SIGNAL_RANGE = 30
const VOICE_WAVE_ATTACK = 0.38
const VOICE_WAVE_RELEASE = 0.58
const MESSAGE_AUDIO_WAVE_BAR_COUNT = 32
const MESSAGE_AUDIO_RATE_OPTIONS = [1, 1.5, 2] as const
const VOICE_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm'
]
const VOICE_WAVE_BASE_PATTERN = [8, 16, 24, 31, 18, 13, 23, 30, 21, 9, 6, 15, 27, 33, 20, 12, 25, 30]

type AccessState = 'checking' | 'allowed' | 'blocked'
type PhoneChatDeviceMode = PortableDeviceMode | 'checking'
type ComposerStatus = 'idle' | 'sending'
type MessageAudioRate = typeof MESSAGE_AUDIO_RATE_OPTIONS[number]
type PaymentMode = 'single' | 'partial'
type ActionSheet = 'attachments' | 'templates' | 'clabe' | 'payment' | 'appointment' | 'settings' | 'newChat' | 'chatMore' | 'schedule' | null
type ChatFilter = 'all' | 'unread' | 'appointments' | 'customers' | 'leads'
type TemplateMode = 'choice' | 'send' | 'create'
type ChatSettingsSection = 'appearance' | 'templates' | 'numbers' | 'notifications' | 'agent' | 'chats' | 'display' | null
type WhatsAppNumberMode = 'merged' | 'separated'
type ConversationSortMode = 'recent' | 'unread'
type PhotoPickDestination = 'chat' | 'cameraShare'
type ContactInfoDetailPanel = 'payments' | 'appointments' | null
type ContactInfoArchiveTab = 'media' | 'links' | 'documents'
type ChatAttachmentType = 'image' | 'audio' | 'video' | 'document' | 'file'
type MessageActionMenuMode = 'main' | 'more'
type MessageActionMenuPlacement = 'above' | 'below'
type MessageActionMenuAlign = 'start' | 'end'
type SendMessageOptions = {
  textOverride?: string
  preserveComposer?: boolean
}

type SchedulePeriod = 'AM' | 'PM'

interface ScheduleDraft {
  date: string
  hour: string
  minute: string
  period: SchedulePeriod
}

interface BankClabeAccount {
  id: string
  alias: string
  clabe: string
  bank?: string
  accountHolder?: string
}

interface BankClabeFormState {
  alias: string
  clabe: string
  bank: string
  accountHolder: string
}

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

interface MessageInfoSwipeGesture {
  messageId: string
  startX: number
  startY: number
  offset: number
  lastRenderedOffset: number
  active: boolean
}

interface MessageActionMenuState {
  messageId: string
  mode: MessageActionMenuMode
  rect: {
    top: number
    left: number
    width: number
    bubbleWidth: number
    height: number
  }
  placement: MessageActionMenuPlacement
  align: MessageActionMenuAlign
}

interface MessageActionPressGesture {
  messageId: string
  pointerId: number
  startX: number
  startY: number
  timerId: number
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
  { id: 'sms_qr', label: 'SMS', hint: 'Usa el SMS conectado en GoHighLevel.' },
  { id: 'messenger', label: 'Messenger', hint: 'Responde al chat de Facebook.' },
  { id: 'instagram', label: 'Instagram', hint: 'Responde al DM de Instagram.' }
]
const GHL_CHAT_CHANNEL_LABELS: Record<HighLevelChatChannel, string> = {
  whatsapp_api: 'WhatsApp API',
  sms_qr: 'SMS',
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
  scheduledAt?: string
  scheduledMessageId?: string
  sentAt?: string
  deliveredAt?: string
  readAt?: string
  businessPhone?: string
  businessPhoneNumberId?: string
  transport?: 'api' | 'qr' | string
  attachment?: {
    type: ChatAttachmentType
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

interface MessageAudioPlaybackState {
  currentTime: number
  duration: number
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

interface ContactInfoArchiveItem {
  id: string
  tab: ContactInfoArchiveTab
  type: Exclude<ChatAttachmentType, 'audio'> | 'link'
  url: string
  title: string
  caption: string
  date: string
  direction: 'inbound' | 'outbound'
  mimeType?: string
}

interface ContactInfoCustomFieldView {
  id: string
  keys: string[]
  label: string
  value: string
  editValue: string
  dataType?: string | null
  options?: unknown[]
  field?: ContactCustomField | null
  definition?: ContactCustomFieldDefinition | null
}

function getPhoneChatDeviceMode(): PhoneChatDeviceMode {
  if (typeof window === 'undefined') return 'checking'
  return getPortableDeviceMode()
}

function getAccessState(deviceMode = getPhoneChatDeviceMode()): AccessState {
  if (deviceMode === 'checking') return 'checking'
  return deviceMode === 'desktop' ? 'blocked' : 'allowed'
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

function getContactProfilePhoto(contact?: Partial<Contact> | null) {
  const candidates = [
    contact?.profilePhotoUrl,
    contact?.avatarUrl,
    contact?.photoUrl,
    contact?.pictureUrl,
    contact?.profile_picture_url
  ]

  return candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() || ''
}

function getBusinessProfilePhotoFromJson(value?: string | null) {
  if (!value) return ''
  try {
    const parsed = JSON.parse(value)
    const candidates = [
      parsed?.profilePictureUrl,
      parsed?.profile_picture_url,
      parsed?.pictureUrl,
      parsed?.picture_url,
      parsed?.avatarUrl,
      parsed?.avatar_url
    ]

    return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)?.trim() || ''
  } catch {
    return ''
  }
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

function padTwoDigits(value: number) {
  return String(value).padStart(2, '0')
}

function formatDateInputValue(date: Date) {
  return `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`
}

function formatScheduleDateDisplay(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return 'Elige fecha'

  const date = new Date(year, month - 1, day)
  if (Number.isNaN(date.getTime())) return 'Elige fecha'

  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date).replace('.', '')
}

function createDefaultScheduleDraft(): ScheduleDraft {
  const date = new Date(Date.now() + 15 * 60 * 1000)
  const minutes = date.getMinutes()
  date.setMinutes(minutes + ((5 - (minutes % 5)) % 5), 0, 0)

  const hour24 = date.getHours()
  const hour12 = hour24 % 12 || 12
  return {
    date: formatDateInputValue(date),
    hour: String(hour12),
    minute: padTwoDigits(date.getMinutes()),
    period: hour24 >= 12 ? 'PM' : 'AM'
  }
}

function createScheduleDraftFromDate(value?: string | null): ScheduleDraft {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return createDefaultScheduleDraft()

  const hour24 = date.getHours()
  const hour12 = hour24 % 12 || 12
  return {
    date: formatDateInputValue(date),
    hour: String(hour12),
    minute: padTwoDigits(date.getMinutes()),
    period: hour24 >= 12 ? 'PM' : 'AM'
  }
}

function getScheduleDateFromDraft(draft: ScheduleDraft) {
  const [year, month, day] = draft.date.split('-').map(Number)
  const hour = Number(draft.hour)
  const minute = Number(draft.minute)

  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null

  const hour24 = draft.period === 'PM'
    ? (hour === 12 ? 12 : hour + 12)
    : (hour === 12 ? 0 : hour)
  const date = new Date(year, month - 1, day, hour24, minute, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatScheduledMessageLabel(value?: string | null) {
  if (!value) return 'Programado'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Programado'

  const time = formatMessageTime(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  if (sameDay) return `Programado ${time}`

  return `Programado ${formatMessageDate(value)} ${time}`.trim()
}

function formatScheduledCountdown(value?: string | null, nowMs = Date.now()) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const remainingMs = date.getTime() - nowMs
  if (remainingMs <= 0) return 'ahora'

  const remainingMinutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  if (remainingMinutes < 60) return `${remainingMinutes}m`

  const remainingHours = Math.max(1, Math.ceil(remainingMinutes / 60))
  if (remainingHours < 24) return `${remainingHours}h`

  return `${Math.max(1, Math.ceil(remainingHours / 24))}d`
}

function formatSchedulePreviewLabel(value?: string | null) {
  if (!value) return 'Elige fecha y hora'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Elige fecha y hora'

  const time = formatMessageTime(value)
  const sameDay = date.toDateString() === new Date().toDateString()
  if (sameDay) return `Se enviará a las ${time}`

  return `Se enviará el ${formatMessageDate(value)} a las ${time}`.trim()
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

function createInitialVoiceBars() {
  return Array.from({ length: VOICE_WAVE_BAR_COUNT }, () => VOICE_WAVE_MIN_HEIGHT)
}

function getVoiceBarHeight(samples: Uint8Array) {
  const average = samples.reduce((sum, value) => sum + Math.abs(value - 128), 0) / samples.length
  const gatedLevel = average <= VOICE_WAVE_SILENCE_THRESHOLD
    ? 0
    : Math.min(1, (average - VOICE_WAVE_SILENCE_THRESHOLD) / VOICE_WAVE_SIGNAL_RANGE)
  const responsiveLevel = Math.sqrt(gatedLevel)

  return Math.round(VOICE_WAVE_MIN_HEIGHT + responsiveLevel * (VOICE_WAVE_MAX_HEIGHT - VOICE_WAVE_MIN_HEIGHT))
}

function smoothVoiceBarHeight(nextHeight: number, previousHeight: number) {
  const factor = nextHeight > previousHeight ? VOICE_WAVE_ATTACK : VOICE_WAVE_RELEASE
  return Math.round(previousHeight + (nextHeight - previousHeight) * factor)
}

function getAudioContextConstructor() {
  if (typeof window === 'undefined') return null
  const audioWindow = window as Window & {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }

  return audioWindow.AudioContext || audioWindow.webkitAudioContext || null
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
    description: 'Creada desde Ristak',
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

function pickMessageTimestamp(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = data[key]
    if (value === null || value === undefined || value === '') continue

    if (typeof value === 'number' && Number.isFinite(value)) {
      const timestamp = value > 1_000_000_000_000 ? value : value * 1000
      const date = new Date(timestamp)
      if (!Number.isNaN(date.getTime())) return date.toISOString()
      continue
    }

    const date = new Date(String(value))
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }

  return ''
}

function isMessageFailed(message: ChatMessage) {
  return FAILED_MESSAGE_STATUSES.has(String(message.status || '').trim().toLowerCase()) || Boolean(message.errorReason)
}

function isMessagePending(message: ChatMessage) {
  const status = String(message.status || '').trim().toLowerCase()
  return PENDING_MESSAGE_STATUSES.has(status) || status.startsWith('enviando')
}

function isMessageScheduled(message: ChatMessage) {
  return String(message.status || '').trim().toLowerCase() === 'scheduled' || Boolean(message.scheduledAt && message.scheduledMessageId)
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
  if (isMessageScheduled(message)) return false
  const status = getMessageReceiptStatus(message)
  if (status === 'read') return false

  const sentAt = new Date(message.date).getTime()
  if (!Number.isFinite(sentAt)) return true
  return Date.now() - sentAt < 30 * 60 * 1000
}

function compactCompareValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function getChatContactSignature(contact: ChatContact) {
  return [
    contact.id,
    contact.name,
    contact.email,
    contact.phone,
    contact.status,
    contact.ltv,
    contact.purchases,
    contact.lastPurchase,
    contact.createdAt,
    contact.lastMessageText,
    contact.lastMessageType,
    contact.lastMessageChannel,
    contact.lastMessageDate,
    contact.lastMessageDirection,
    contact.lastBusinessPhone,
    contact.lastBusinessPhoneNumberId,
    contact.lastInboundBusinessPhone,
    contact.lastInboundBusinessPhoneNumberId,
    contact.messageCount,
    contact.unreadCount,
    contact.profilePhotoUrl,
    contact.avatarUrl,
    contact.photoUrl,
    contact.pictureUrl,
    contact.profile_picture_url,
    contact.hasAppointments,
    contact.nextAppointmentDate
  ].map(compactCompareValue).join('\u001f')
}

function areChatListsEquivalent(left: ChatContact[], right: ChatContact[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((contact, index) => getChatContactSignature(contact) === getChatContactSignature(right[index]))
}

function getMessageSignature(message: ChatMessage) {
  const attachment = message.attachment
  return [
    message.id,
    message.text,
    message.date,
    message.direction,
    message.status,
    message.errorReason,
    message.scheduledAt,
    message.scheduledMessageId,
    message.sentAt,
    message.deliveredAt,
    message.readAt,
    message.businessPhone,
    message.businessPhoneNumberId,
    message.transport,
    attachment?.type,
    attachment?.dataUrl,
    attachment?.url,
    attachment?.name,
    attachment?.mimeType,
    attachment?.durationMs
  ].map(compactCompareValue).join('\u001f')
}

function areMessagesEquivalent(left: ChatMessage[], right: ChatMessage[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((message, index) => getMessageSignature(message) === getMessageSignature(right[index]))
}

function getJourneySignature(journey: JourneyEvent[]) {
  try {
    return JSON.stringify(journey)
  } catch {
    return String(journey.length)
  }
}

function getMediaAttachmentType(messageType = '', mimeType = '', name = ''): ChatAttachmentType | null {
  const normalizedType = messageType.toLowerCase()
  const normalizedMime = mimeType.toLowerCase()
  const normalizedName = name.toLowerCase()

  if (normalizedType.includes('audio') || normalizedType.includes('voice') || normalizedMime.startsWith('audio/')) {
    return 'audio'
  }

  if (normalizedType.includes('image') || normalizedType.includes('sticker') || normalizedMime.startsWith('image/')) {
    return 'image'
  }

  if (normalizedType.includes('video') || normalizedType.includes('gif') || normalizedMime.startsWith('video/')) {
    return 'video'
  }

  if (
    normalizedType.includes('document') ||
    normalizedMime === 'application/pdf' ||
    normalizedMime.includes('officedocument') ||
    normalizedMime.includes('msword') ||
    normalizedMime.includes('spreadsheet') ||
    normalizedMime.includes('presentation')
  ) {
    return 'document'
  }

  if (
    normalizedType.includes('file') ||
    normalizedMime.startsWith('application/') ||
    normalizedMime.startsWith('text/') ||
    /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z)$/i.test(normalizedName)
  ) {
    return 'file'
  }

  return null
}

function getAttachmentFallbackName(type: ChatAttachmentType, name = '', mediaId = '') {
  if (name) return name
  if (mediaId) return mediaId
  if (type === 'image') return 'Foto enviada'
  if (type === 'video') return 'Video enviado'
  if (type === 'document') return 'Documento enviado'
  if (type === 'file') return 'Archivo enviado'
  return 'Mensaje de voz'
}

function getJourneyMediaAttachment(event: JourneyEvent): ChatMessage['attachment'] | undefined {
  const messageType = String(event.data?.message_type || '').toLowerCase()
  const mediaUrl = String(event.data?.media_url || event.data?.mediaUrl || '').trim()
  const mediaId = String(event.data?.media_id || event.data?.mediaId || '').trim()
  const mimeType = String(event.data?.media_mime_type || event.data?.mediaMimeType || '').trim()
  const name = String(event.data?.media_filename || event.data?.mediaFilename || '').trim()
  const durationMs = Number(event.data?.media_duration_ms || event.data?.mediaDurationMs || 0) || undefined
  const attachmentType = getMediaAttachmentType(messageType, mimeType, name)

  if (attachmentType === 'audio') {
    return {
      type: 'audio',
      url: mediaUrl,
      name: getAttachmentFallbackName('audio', name, mediaId),
      mimeType,
      durationMs
    }
  }

  if (attachmentType) {
    return {
      type: attachmentType,
      url: mediaUrl,
      name: getAttachmentFallbackName(attachmentType, name, mediaId),
      mimeType
    }
  }

  return undefined
}

function normalizeArchiveUrl(value = '') {
  const trimmed = String(value || '').trim().replace(/[)\],.;!?]+$/g, '')
  if (!trimmed) return ''
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function extractLinksFromText(text = '') {
  const matches = text.match(/\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi) || []
  return Array.from(new Set(matches.map(normalizeArchiveUrl).filter(Boolean)))
}

function getArchiveLinkTitle(url = '') {
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function getContactInfoArchiveItems(journey: JourneyEvent[] = []): ContactInfoArchiveItem[] {
  const items: ContactInfoArchiveItem[] = []

  journey.forEach((event, eventIndex) => {
    if (event.type !== 'whatsapp_message' && event.type !== 'meta_message') return

    const text = String(event.data?.message_text || event.data?.message || event.data?.body || '').trim()
    const direction = String(event.data?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound'
    const messageId = String(
      event.data?.whatsapp_api_message_id ||
      event.data?.whatsapp_message_id ||
      event.data?.meta_social_message_id ||
      event.data?.meta_message_id ||
      `message-${eventIndex}`
    )
    const messageType = String(event.data?.message_type || '')
    const mediaUrl = String(event.data?.media_url || event.data?.mediaUrl || '').trim()
    const mediaId = String(event.data?.media_id || event.data?.mediaId || '').trim()
    const mimeType = String(event.data?.media_mime_type || event.data?.mediaMimeType || '').trim()
    const name = String(event.data?.media_filename || event.data?.mediaFilename || '').trim()
    const attachmentType = getMediaAttachmentType(messageType, mimeType, name)

    if (attachmentType && attachmentType !== 'audio' && (mediaUrl || mediaId)) {
      const tab: ContactInfoArchiveTab = attachmentType === 'image' || attachmentType === 'video'
        ? 'media'
        : 'documents'
      const fallbackName = getAttachmentFallbackName(attachmentType, name, mediaId)

      items.push({
        id: `${messageId}-${tab}-${items.length}`,
        tab,
        type: attachmentType,
        url: mediaUrl,
        title: fallbackName,
        caption: text,
        date: event.date,
        direction,
        mimeType
      })
    }

    extractLinksFromText(text).forEach((url, linkIndex) => {
      items.push({
        id: `${messageId}-link-${linkIndex}`,
        tab: 'links',
        type: 'link',
        url,
        title: getArchiveLinkTitle(url),
        caption: url,
        date: event.date,
        direction
      })
    })
  })

  return items.sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
}

function getJourneyMessage(event: JourneyEvent, index: number): ChatMessage | null {
  const isMetaMessage = event.type === 'meta_message'
  if (event.type !== 'whatsapp_message' && !isMetaMessage) return null
  const eventData = (event.data || {}) as Record<string, unknown>

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
    sentAt: pickMessageTimestamp(eventData, [
      'sent_at',
      'sentAt',
      'message_sent_at',
      'messageSentAt',
      'created_at',
      'createdAt',
      'timestamp'
    ]) || event.date,
    deliveredAt: pickMessageTimestamp(eventData, [
      'delivered_at',
      'deliveredAt',
      'delivery_at',
      'deliveryAt',
      'message_delivered_at',
      'messageDeliveredAt',
      'delivered_timestamp',
      'deliveredTimestamp'
    ]),
    readAt: pickMessageTimestamp(eventData, [
      'read_at',
      'readAt',
      'seen_at',
      'seenAt',
      'message_read_at',
      'messageReadAt',
      'read_timestamp',
      'readTimestamp',
      'played_at',
      'playedAt'
    ]),
    businessPhone: String(event.data?.business_phone || ''),
    businessPhoneNumberId: String(event.data?.business_phone_number_id || ''),
    transport: String(event.data?.transport || (isMetaMessage ? event.data?.social_platform || 'meta' : 'api')),
    attachment
  }
}

function getScheduledChatMessageBubble(message: ScheduledChatMessage): ChatMessage | null {
  if (!message?.id || !message.text) return null

  return {
    id: `scheduled-${message.id}`,
    scheduledMessageId: message.id,
    text: message.text,
    date: message.createdAt || message.updatedAt || new Date().toISOString(),
    direction: 'outbound',
    status: message.status || 'scheduled',
    errorReason: message.errorMessage || '',
    scheduledAt: message.scheduledAt,
    businessPhone: message.fromPhone || '',
    businessPhoneNumberId: message.businessPhoneNumberId || '',
    transport: message.transport || (message.provider === 'highlevel' ? message.channel || 'ghl_whatsapp' : 'api')
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

function getMessageAttachmentActionLabel(message: ChatMessage) {
  if (!message.attachment) return ''
  return message.attachment.name || getMessageTypeLabel(message.attachment.type, 'Archivo')
}

function getMessageActionText(message: ChatMessage) {
  const text = message.text.trim()
  if (text) return text
  return getMessageAttachmentActionLabel(message) || 'Mensaje'
}

function triggerMessageActionHapticFeedback() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(MESSAGE_ACTION_LONG_PRESS_VIBRATION_MS)
  } catch {
    // intentionally ignore
  }
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
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

function uniqueCustomFieldKeys(...groups: string[][]) {
  const seen = new Set<string>()
  const result: string[] = []

  groups.flat().forEach((key) => {
    const normalized = String(key || '').trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    result.push(normalized)
  })

  return result
}

function getCustomFieldOptionItems(options: unknown[] = []) {
  return options
    .map((option) => {
      if (option && typeof option === 'object') {
        const item = option as Record<string, unknown>
        const value = String(item.value || item.label || item.name || '').trim()
        const label = String(item.label || item.name || item.value || '').trim()
        return value || label ? { value: value || label, label: label || value } : null
      }

      const value = String(option || '').trim()
      return value ? { value, label: value } : null
    })
    .filter((option): option is { value: string; label: string } => Boolean(option))
}

function findContactCustomFieldByKeys(fields: ContactCustomField[] = [], keys: string[]) {
  return fields.find((field) => getContactCustomFieldKeys(field).some((key) => keys.includes(key))) || null
}

function formatContactCustomFieldEditValue(value: ContactCustomField['value'] | undefined) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return formatContactCustomFieldDisplayValue(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function buildContactInfoCustomFieldViews(
  enabledFieldIds: string[] = [],
  definitions: ContactCustomFieldDefinition[] = [],
  fields: ContactCustomField[] = []
): ContactInfoCustomFieldView[] {
  const enabledIds = enabledFieldIds.map((id) => String(id || '').trim()).filter(Boolean)
  if (!enabledIds.length) return []

  return enabledIds
    .map((enabledId, index): ContactInfoCustomFieldView | null => {
      const definition = definitions.find((item) => getContactCustomFieldKeys(item).includes(enabledId)) || null
      const definitionKeys = getContactCustomFieldKeys(definition)
      const lookupKeys = uniqueCustomFieldKeys([enabledId], definitionKeys)
      const field = findContactCustomFieldByKeys(fields, lookupKeys) || null
      const fieldKeys = getContactCustomFieldKeys(field)
      const keys = uniqueCustomFieldKeys([enabledId], definitionKeys, fieldKeys)

      if (!definition && !field) return null

      const labelSource = definition || field
      const value = field ? formatContactCustomFieldDisplayValue(field.value) : ''
      const editValue = field ? formatContactCustomFieldEditValue(field.value) : ''

      return {
        id: getContactCustomFieldIdentity(labelSource) || enabledId || `custom-field-${index}`,
        keys,
        label: getContactCustomFieldDisplayLabel(labelSource, index),
        value,
        editValue,
        dataType: definition?.dataType || field?.dataType || 'text',
        options: definition?.options?.length ? definition.options : field?.options || [],
        field,
        definition
      }
    })
    .filter((field): field is ContactInfoCustomFieldView => Boolean(field))
}

function getContactInfoCustomFieldInputType(dataType?: string | null) {
  const normalized = String(dataType || '').toLowerCase()
  if (['number', 'currency'].includes(normalized)) return 'number'
  if (normalized === 'email') return 'email'
  if (normalized === 'phone') return 'tel'
  if (normalized === 'url') return 'url'
  return 'text'
}

function normalizeContactInfoCustomFieldValueForSave(value: string, dataType?: string | null) {
  const normalizedType = String(dataType || '').toLowerCase()
  const draft = value.trim()

  if (['boolean', 'checkbox'].includes(normalizedType)) return draft === 'true'
  if (['number', 'currency'].includes(normalizedType)) {
    if (!draft) return ''
    const numericValue = Number(draft)
    return Number.isFinite(numericValue) ? numericValue : draft
  }

  return draft
}

function buildContactCustomFieldsForSave(contact: Contact, customField: ContactInfoCustomFieldView, draftValue: string) {
  const currentFields = Array.isArray(contact.customFields) ? contact.customFields : []
  const nextValue = normalizeContactInfoCustomFieldValueForSave(draftValue, customField.dataType)
  let updatedExistingField = false

  const nextFields = currentFields.map((field) => {
    const matches = getContactCustomFieldKeys(field).some((key) => customField.keys.includes(key))
    if (!matches) return field

    updatedExistingField = true
    return {
      ...field,
      label: field.label || customField.label,
      name: field.name || customField.label,
      dataType: field.dataType || customField.dataType || 'text',
      options: field.options?.length ? field.options : customField.options || [],
      value: nextValue
    }
  })

  if (updatedExistingField) return nextFields

  const definition = customField.definition
  return [
    ...nextFields,
    {
      id: definition?.definitionId || definition?.key || customField.id,
      definitionId: definition?.definitionId || '',
      key: definition?.key || definition?.fieldKey || customField.id,
      fieldKey: definition?.fieldKey || definition?.key || customField.id,
      label: customField.label,
      name: definition?.name || customField.label,
      dataType: customField.dataType || 'text',
      options: customField.options || [],
      value: nextValue,
      syncTarget: definition?.syncTarget || 'local'
    }
  ]
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

function getJourneyEventTime(event: JourneyEvent) {
  const time = Date.parse(event.date || '')
  return Number.isFinite(time) ? time : null
}

function getFirstSuccessfulJourneyPaymentTime(events: JourneyEvent[]) {
  const paymentTimes = events
    .filter((event) => event.type === 'payment')
    .filter((event) => {
      const status = String(event.data?.status || '').trim().toLowerCase()
      const amount = Number(event.data?.amount || 0)
      return amount > 0 && (!status || SUCCESS_PAYMENT_STATUSES.has(status))
    })
    .map(getJourneyEventTime)
    .filter((time): time is number => time !== null)
    .sort((left, right) => left - right)

  return paymentTimes[0] ?? null
}

function shouldShowWhatsAppInContactInfoJourney(event: JourneyEvent, firstPaymentTime: number | null) {
  if (firstPaymentTime === null) return true

  const eventTime = getJourneyEventTime(event)
  if (eventTime === null || eventTime < firstPaymentTime) return true

  return isAdAttributedJourneyEvent(event)
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

function getContactInfoWhatsAppGroupKey(event: JourneyEvent, timezone: string) {
  const dayKey = getContactInfoJourneyDayKey(event.date, timezone)
  return `${dayKey}:${isAdAttributedJourneyEvent(event) ? 'ad' : 'direct'}`
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
  const firstPaymentTime = getFirstSuccessfulJourneyPaymentTime(events)

  events.forEach((event) => {
    if (!event?.date) return
    if (isWhatsAppJourneyEvent(event)) {
      if (!shouldShowWhatsAppInContactInfoJourney(event, firstPaymentTime)) return
      whatsappEvents.push(event)
    } else {
      otherEvents.push(event)
    }
  })

  const whatsappByGroup = new Map<string, JourneyEvent[]>()
  whatsappEvents.forEach((event) => {
    const groupKey = getContactInfoWhatsAppGroupKey(event, timezone)
    const groupEvents = whatsappByGroup.get(groupKey)
    if (groupEvents) {
      groupEvents.push(event)
    } else {
      whatsappByGroup.set(groupKey, [event])
    }
  })

  const mergedWhatsAppEvents: JourneyEvent[] = []
  whatsappByGroup.forEach((dayEvents) => {
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

function getBusinessPhoneProfilePhoto(phone?: WhatsAppApiStatus['phoneNumbers'][number] | null) {
  return phone?.profile_picture_url || getBusinessProfilePhotoFromJson(phone?.business_profile_json) || ''
}

function getBusinessPhoneInitials(phone?: WhatsAppApiStatus['phoneNumbers'][number] | null) {
  const label = phone?.label || phone?.verified_name || phone?.display_phone_number || phone?.phone_number || 'Ristak'
  const words = label.replace(/[+()\-]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length >= 2 && words[0].length > 1) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  return label.replace(/\D/g, '').slice(-2) || label.slice(0, 2).toUpperCase()
}

function isBusinessPhoneQrReady(phone?: WhatsAppApiStatus['phoneNumbers'][number] | null) {
  return Boolean(phone?.qr_send_enabled && String(phone.qr_status || '').toLowerCase() === 'connected')
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

function getNewestMessageByDate(messagesToSearch: ChatMessage[]) {
  return [...messagesToSearch]
    .sort((left, right) => {
      const rightDate = Date.parse(right.date)
      const leftDate = Date.parse(left.date)
      return (Number.isFinite(rightDate) ? rightDate : 0) - (Number.isFinite(leftDate) ? leftDate : 0)
    })[0] || null
}

function messageCanOpenWhatsAppReplyWindow(message: ChatMessage) {
  if (message.direction !== 'inbound') return false

  const normalizedChannel = normalizeGhlChatChannelValue(message.transport || '')
  if (normalizedChannel === 'whatsapp_api') return true
  if (normalizedChannel === 'sms_qr' || normalizedChannel === 'messenger' || normalizedChannel === 'instagram') return false

  const transport = String(message.transport || '').trim().toLowerCase()
  return !transport || ['api', 'qr', 'whatsapp', 'whatsapp_qr', 'baileys', 'bailey'].includes(transport)
}

function getFileExtension(name = '') {
  const cleanName = String(name || '').trim().toLowerCase()
  const extension = cleanName.split('.').pop() || ''
  return extension === cleanName ? '' : extension
}

function getDocumentMimeType(file: File) {
  const fileType = String(file.type || '').trim().toLowerCase()
  const extension = getFileExtension(file.name)
  return DOCUMENT_MIME_BY_EXTENSION[extension] || fileType || 'application/octet-stream'
}

function isSupportedDocumentFile(file: File) {
  const extension = getFileExtension(file.name)
  const mimeType = getDocumentMimeType(file)
  return Boolean(DOCUMENT_MIME_BY_EXTENSION[extension] || Object.values(DOCUMENT_MIME_BY_EXTENSION).includes(mimeType))
}

function normalizeDataUrlMimeType(dataUrl: string, mimeType: string) {
  if (!mimeType || !dataUrl.startsWith('data:')) return dataUrl
  return dataUrl.replace(/^data:[^;,]*(;[^,]*)?,/i, (_match, params = '') => `data:${mimeType}${params || ';base64'},`)
}

function getDraftAttachmentKind(attachment: MobileChatAttachment): ChatAttachmentType {
  return attachment.attachmentType === 'image' ? 'image' : 'document'
}

function getAttachmentPreviewText(attachments: MobileChatAttachment[], fallbackText = '') {
  if (!attachments.length) return fallbackText
  const hasDocument = attachments.some((attachment) => getDraftAttachmentKind(attachment) !== 'image')
  if (attachments.length > 1) return hasDocument ? 'Archivos' : 'Fotos'
  return hasDocument ? 'Documento' : 'Foto'
}

function formatAttachmentSize(size?: number) {
  const value = Number(size || 0)
  if (!Number.isFinite(value) || value <= 0) return 'Documento'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
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

function createEmptyClabeForm(): BankClabeFormState {
  return {
    alias: '',
    clabe: '',
    bank: '',
    accountHolder: ''
  }
}

function normalizeClabe(value = '') {
  return value.replace(/\D/g, '').slice(0, 18)
}

function formatClabe(value = '') {
  const digits = normalizeClabe(value)
  const chunks = [
    digits.slice(0, 3),
    digits.slice(3, 6),
    digits.slice(6, 17),
    digits.slice(17, 18)
  ].filter(Boolean)

  return chunks.join(' ')
}

function sanitizeBankClabes(value: BankClabeAccount[] | unknown): BankClabeAccount[] {
  if (!Array.isArray(value)) return []

  const normalized: Array<BankClabeAccount | null> = value
    .map((item): BankClabeAccount | null => {
      if (!item || typeof item !== 'object') return null
      const account = item as Partial<BankClabeAccount>
      const clabe = normalizeClabe(account.clabe || '')
      if (clabe.length !== 18) return null

      return {
        id: String(account.id || `clabe-${clabe}`),
        alias: String(account.alias || '').trim() || 'CLABE',
        clabe,
        bank: String(account.bank || '').trim(),
        accountHolder: String(account.accountHolder || '').trim()
      }
    })

  return normalized.filter((item): item is BankClabeAccount => Boolean(item))
}

function buildClabeMessage(account: BankClabeAccount) {
  return [
    'Te comparto los datos para transferencia:',
    account.accountHolder ? `Titular: ${account.accountHolder}` : '',
    account.bank ? `Banco: ${account.bank}` : '',
    `CLABE: ${formatClabe(account.clabe)}`
  ].filter(Boolean).join('\n')
}

export const PhoneChat: React.FC = () => {
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
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
  const [bankClabes, setBankClabes, savingBankClabes] = useAppConfig<BankClabeAccount[]>(PAYMENT_BANK_CLABES_CONFIG_KEY, [])
  const [enabledContactInfoCustomFieldIds] = useAppConfig<string[]>(CONTACT_INFO_CUSTOM_FIELDS_CONFIG_KEY, [])
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

  const [deviceMode, setDeviceMode] = useState<PhoneChatDeviceMode>(getPhoneChatDeviceMode)
  const [accessState, setAccessState] = useState<AccessState>(() => getAccessState(deviceMode))
  const [chats, setChats] = useState<ChatContact[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  const [chatsRefreshing, setChatsRefreshing] = useState(false)
  const [chatsError, setChatsError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [archivedViewOpen, setArchivedViewOpen] = useState(false)
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>(() => readStoredChatIds(CHAT_ARCHIVED_STATE_KEY))
  const [mutedChatIds, setMutedChatIds] = useState<string[]>(() => readStoredChatIds(CHAT_MUTED_STATE_KEY))
  const [starredMessageIds, setStarredMessageIds] = useState<string[]>(() => readStoredChatIds(CHAT_STARRED_MESSAGES_KEY))
  const [openSwipeChatId, setOpenSwipeChatId] = useState<string | null>(null)
  const [draggingSwipe, setDraggingSwipe] = useState<{ contactId: string; offset: number } | null>(null)
  const [closingSwipeChatId, setClosingSwipeChatId] = useState<string | null>(null)
  const [chatSwipeSuppressed, setChatSwipeSuppressed] = useState(false)
  const [chatActionContactId, setChatActionContactId] = useState<string | null>(null)
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [activeContactId, setActiveContactId] = useState<string | null>(null)
  const [contactHighLevelChannelOverrides, setContactHighLevelChannelOverrides] = useState<Record<string, HighLevelChatChannel>>({})
  const [conversationOpen, setConversationOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [scheduledCountdownNow, setScheduledCountdownNow] = useState(() => Date.now())
  const [contactJourney, setContactJourney] = useState<JourneyEvent[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesRefreshing, setMessagesRefreshing] = useState(false)
  const [messageInfoOpen, setMessageInfoOpen] = useState(false)
  const [messageInfoMessageId, setMessageInfoMessageId] = useState<string | null>(null)
  const [draggingMessageInfoSwipe, setDraggingMessageInfoSwipe] = useState<{ messageId: string; offset: number } | null>(null)
  const [messageActionMenu, setMessageActionMenu] = useState<MessageActionMenuState | null>(null)
  const [replyingToMessageId, setReplyingToMessageId] = useState<string | null>(null)
  const [messageText, setMessageText] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<MobileChatAttachment[]>([])
  const [cameraSharePhoto, setCameraSharePhoto] = useState<MobilePhotoAttachment | null>(null)
  const [cameraShareQuery, setCameraShareQuery] = useState('')
  const [cameraShareCaption, setCameraShareCaption] = useState('')
  const [cameraShareSelectedContacts, setCameraShareSelectedContacts] = useState<Contact[]>([])
  const [cameraShareSending, setCameraShareSending] = useState(false)
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftAttachment | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [voiceWaveBars, setVoiceWaveBars] = useState<number[]>(createInitialVoiceBars)
  const [voicePreviewPlaying, setVoicePreviewPlaying] = useState(false)
  const [playingAudioMessageId, setPlayingAudioMessageId] = useState<string | null>(null)
  const [audioLoadingMessageId, setAudioLoadingMessageId] = useState<string | null>(null)
  const [messageAudioRates, setMessageAudioRates] = useState<Record<string, MessageAudioRate>>({})
  const [messageAudioPlayback, setMessageAudioPlayback] = useState<Record<string, MessageAudioPlaybackState>>({})
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => createDefaultScheduleDraft())
  const [scheduleEditingMessageId, setScheduleEditingMessageId] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [schedulingMessage, setSchedulingMessage] = useState(false)
  const [cancelingScheduledMessageId, setCancelingScheduledMessageId] = useState<string | null>(null)
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
  const [contactInfoDetailPanel, setContactInfoDetailPanel] = useState<ContactInfoDetailPanel>(null)
  const [contactInfoArchiveOpen, setContactInfoArchiveOpen] = useState(false)
  const [contactInfoArchiveTab, setContactInfoArchiveTab] = useState<ContactInfoArchiveTab>('media')
  const [contactCustomFieldDefinitions, setContactCustomFieldDefinitions] = useState<ContactCustomFieldDefinition[]>([])
  const [contactCustomFieldDefinitionsLoaded, setContactCustomFieldDefinitionsLoaded] = useState(false)
  const [contactCustomFieldDefinitionsLoading, setContactCustomFieldDefinitionsLoading] = useState(false)
  const [editingCustomFieldId, setEditingCustomFieldId] = useState<string | null>(null)
  const [customFieldDrafts, setCustomFieldDrafts] = useState<Record<string, string>>({})
  const [savingCustomFieldId, setSavingCustomFieldId] = useState<string | null>(null)
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
  const [clabeFormOpen, setClabeFormOpen] = useState(false)
  const [clabeDraft, setClabeDraft] = useState<BankClabeFormState>(createEmptyClabeForm)
  const [sendingClabeId, setSendingClabeId] = useState<string | null>(null)
  const [aiMessages, setAiMessages] = useState<AIAgentMessage[]>(() => {
    const storedMessages = readAIAgentMobileMessages()
    return storedMessages.length > 0 ? storedMessages : [createAIAgentWelcomeMessage()]
  })
  const [aiMessageText, setAiMessageText] = useState('')
  const [aiSending, setAiSending] = useState(false)
  const [aiSuggestionLoading, setAiSuggestionLoading] = useState(false)
  const [conversationScrollSettling, setConversationScrollSettling] = useState(false)
  const messagesPaneRef = useRef<HTMLDivElement | null>(null)
  const messagesContentRef = useRef<HTMLDivElement | null>(null)
  const messageTextRef = useRef('')
  const messagesPaneNearBottomRef = useRef(true)
  const activeContactIdRef = useRef<string | null>(null)
  const conversationOpenRef = useRef(false)
  const conversationLoadGenerationRef = useRef(0)
  const conversationInitialBottomLockRef = useRef({
    contactId: null as string | null,
    expiresAt: 0
  })
  const bottomScrollFrameRef = useRef<number | null>(null)
  const bottomScrollTimeoutRefs = useRef<number[]>([])
  const conversationScrollSettlingTimeoutRef = useRef<number | null>(null)
  const previousMessagesScrollRef = useRef({
    activeContactId: null as string | null,
    conversationOpen: false,
    messagesLoading: false,
    count: 0
  })
  const messageActionPressRef = useRef<MessageActionPressGesture | null>(null)
  const composerInputRef = useRef<HTMLDivElement | null>(null)
  const cameraShareCaptionRef = useRef<HTMLDivElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const photosInputRef = useRef<HTMLInputElement | null>(null)
  const documentInputRef = useRef<HTMLInputElement | null>(null)
  const photoPickDestinationRef = useRef<PhotoPickDestination>('chat')
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtRef = useRef(0)
  const voiceTimerRef = useRef<number | null>(null)
  const voiceCancelRef = useRef(false)
  const voiceAudioRef = useRef<HTMLAudioElement | null>(null)
  const voiceAudioContextRef = useRef<AudioContext | null>(null)
  const voiceAudioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const voiceAnalyserRef = useRef<AnalyserNode | null>(null)
  const voiceAnimationFrameRef = useRef<number | null>(null)
  const voiceLastWaveUpdateRef = useRef(0)

  usePhoneElasticScroll({ enabled: accessState === 'allowed' })
  const voiceSmoothedWaveHeightRef = useRef(VOICE_WAVE_MIN_HEIGHT)
  const voiceHoldTimerRef = useRef<number | null>(null)
  const voicePressStartedAtRef = useRef<number | null>(null)
  const voicePressShouldStopOnReleaseRef = useRef(false)
  const voiceSuppressNextClickRef = useRef(false)
  const voiceStartPendingRef = useRef(false)
  const voiceStopAfterStartRef = useRef(false)

  useLayoutEffect(() => {
    activeContactIdRef.current = activeContactId
    conversationOpenRef.current = conversationOpen
  }, [activeContactId, conversationOpen])
  const setComposerMessageText = useCallback((nextText: string) => {
    messageTextRef.current = nextText
    setMessageText(nextText)
  }, [])
  const voiceSendAfterStopRef = useRef(false)
  const messageAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const messageAudioAnimationFrameRef = useRef<number | null>(null)
  const messageAudioAnimationMessageIdRef = useRef<string | null>(null)
  const chatSwipeGestureRef = useRef<ChatSwipeGesture | null>(null)
  const messageInfoSwipeGestureRef = useRef<MessageInfoSwipeGesture | null>(null)
  const handledRouteAppointmentRef = useRef<string | null>(null)
  const closeSheetNow = useCallback(() => setSheet(null), [])
  const handleSwitchToWebView = useCallback(() => {
    writeTabletViewPreference('web')
    setActiveSettingsSection(null)
    setSheet(null)
    navigate('/dashboard', { replace: true })
  }, [navigate])
  const actionSheetDismiss = useBottomSheetDismiss({
    isOpen: Boolean(sheet),
    onClose: closeSheetNow
  })
  const actionSheetMoving = actionSheetDismiss.dragging || actionSheetDismiss.closing || actionSheetDismiss.dragOffset > 0
  const actionSheetDragging = actionSheetDismiss.dragging || actionSheetDismiss.dragOffset > 0
  const chatSwipeGenerationRef = useRef(0)
  const chatSwipeCloseTimerRef = useRef<number | null>(null)
  const ignoreNextChatClickRef = useRef(false)
  const clearChatSwipeCloseTimer = useCallback(() => {
    if (chatSwipeCloseTimerRef.current === null) return
    window.clearTimeout(chatSwipeCloseTimerRef.current)
    chatSwipeCloseTimerRef.current = null
  }, [])
  const clearClosingSwipeActions = useCallback((contactId?: string | null) => {
    clearChatSwipeCloseTimer()
    setClosingSwipeChatId((current) => {
      if (!contactId || current === contactId) return null
      return current
    })
  }, [clearChatSwipeCloseTimer])
  const keepSwipeActionsBehindClosingRow = useCallback((contactId: string) => {
    clearChatSwipeCloseTimer()
    setClosingSwipeChatId(contactId)
    chatSwipeCloseTimerRef.current = window.setTimeout(() => {
      chatSwipeCloseTimerRef.current = null
      setClosingSwipeChatId((current) => current === contactId ? null : current)
    }, CHAT_SWIPE_TRANSITION_MS + 80)
  }, [clearChatSwipeCloseTimer])
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

  const startConversationBottomLock = useCallback((contactId: string | null) => {
    conversationInitialBottomLockRef.current = {
      contactId,
      expiresAt: contactId ? Date.now() + 1600 : 0
    }
    messagesPaneNearBottomRef.current = true
  }, [])

  const isConversationBottomLockActive = useCallback((contactId: string | null) => {
    const lock = conversationInitialBottomLockRef.current
    return Boolean(contactId && lock.contactId === contactId && Date.now() < lock.expiresAt)
  }, [])

  const handleMessagesPaneScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const bottomGap = event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight
    messagesPaneNearBottomRef.current = isConversationBottomLockActive(activeContactIdRef.current) || bottomGap < 96
    if (event.currentTarget.scrollLeft !== 0) {
      event.currentTarget.scrollLeft = 0
    }
  }, [isConversationBottomLockActive])
  const markConversationScrollSettling = useCallback((duration = 620) => {
    if (conversationScrollSettlingTimeoutRef.current !== null) {
      window.clearTimeout(conversationScrollSettlingTimeoutRef.current)
    }

    setConversationScrollSettling(true)
    conversationScrollSettlingTimeoutRef.current = window.setTimeout(() => {
      conversationScrollSettlingTimeoutRef.current = null
      setConversationScrollSettling(false)
    }, duration)
  }, [])
  const scrollMessagesPaneToBottom = useCallback(() => {
    const pane = messagesPaneRef.current
    if (pane) {
      const nextScrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight)
      pane.style.scrollBehavior = 'auto'
      if (Math.abs(pane.scrollTop - nextScrollTop) > 1) {
        pane.scrollTop = nextScrollTop
      }
      if (pane.scrollLeft !== 0) {
        pane.scrollLeft = 0
      }
    }
    messagesPaneNearBottomRef.current = true
  }, [])
  const clearQueuedBottomScrolls = useCallback(() => {
    if (bottomScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(bottomScrollFrameRef.current)
      bottomScrollFrameRef.current = null
    }
    bottomScrollTimeoutRefs.current.forEach((timeout) => window.clearTimeout(timeout))
    bottomScrollTimeoutRefs.current = []
  }, [])
  const queueMessagesPaneBottomScroll = useCallback((delay = 0) => {
    if (delay <= 0) {
      if (bottomScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(bottomScrollFrameRef.current)
      }
      bottomScrollFrameRef.current = window.requestAnimationFrame(() => {
        bottomScrollFrameRef.current = null
        scrollMessagesPaneToBottom()
      })
      return
    }

    const timeout = window.setTimeout(() => {
      bottomScrollTimeoutRefs.current = bottomScrollTimeoutRefs.current.filter((item) => item !== timeout)
      scrollMessagesPaneToBottom()
    }, delay)
    bottomScrollTimeoutRefs.current.push(timeout)
  }, [scrollMessagesPaneToBottom])
  const runConversationOpenBottomScrollSequence = useCallback(() => {
    clearQueuedBottomScrolls()
    markConversationScrollSettling()
    scrollMessagesPaneToBottom()
    queueMessagesPaneBottomScroll(0)
    const settlingDelays = [70, 160, 300, 520]
    settlingDelays.forEach((delay) => {
      queueMessagesPaneBottomScroll(delay)
    })
  }, [clearQueuedBottomScrolls, markConversationScrollSettling, queueMessagesPaneBottomScroll, scrollMessagesPaneToBottom])
  const handleConversationTransitionEnd = useCallback((event: React.TransitionEvent<HTMLElement>) => {
    if (event.currentTarget !== event.target || event.propertyName !== 'transform') return
    if (!conversationOpenRef.current) return

    scrollMessagesPaneToBottom()
  }, [scrollMessagesPaneToBottom])

  const activeContact = useMemo(
    () => aiAgentConversationOpen ? null : chats.find((contact) => contact.id === activeContactId) || null,
    [activeContactId, aiAgentConversationOpen, chats]
  )
  const conversationVisible = conversationOpen && (aiAgentConversationOpen || Boolean(activeContact))
  const messageInfoMessage = useMemo(
    () => messageInfoMessageId ? messages.find((message) => message.id === messageInfoMessageId) || null : null,
    [messageInfoMessageId, messages]
  )
  const messageActionMenuMessage = useMemo(
    () => messageActionMenu ? messages.find((message) => message.id === messageActionMenu.messageId) || null : null,
    [messageActionMenu, messages]
  )
  const replyingToMessage = useMemo(
    () => replyingToMessageId ? messages.find((message) => message.id === replyingToMessageId) || null : null,
    [replyingToMessageId, messages]
  )
  const conversationMessageGroups = useMemo(() => {
    const groups: Array<{
      key: string
      label: string
      messages: ChatMessage[]
    }> = []

    messages.forEach((message) => {
      const dayKey = getConversationDayKey(message.date, timezone) || 'sin-fecha'
      const currentGroup = groups[groups.length - 1]

      if (!currentGroup || currentGroup.key !== dayKey) {
        groups.push({
          key: dayKey,
          label: dayKey === 'sin-fecha' ? '' : getConversationDayLabel(message.date, timezone),
          messages: [message]
        })
        return
      }

      currentGroup.messages.push(message)
    })

    return groups
  }, [messages, timezone])
  const latestMessageKey = useMemo(() => {
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage) return ''
    return [lastMessage.id, lastMessage.date, lastMessage.direction].join('\u001f')
  }, [messages])
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
  const contactInfoArchiveItems = useMemo(
    () => getContactInfoArchiveItems(contactJourney),
    [contactJourney]
  )
  const contactInfoArchiveCounts = useMemo(() => ({
    media: contactInfoArchiveItems.filter((item) => item.tab === 'media').length,
    links: contactInfoArchiveItems.filter((item) => item.tab === 'links').length,
    documents: contactInfoArchiveItems.filter((item) => item.tab === 'documents').length
  }), [contactInfoArchiveItems])
  const contactInfoVisibleArchiveItems = useMemo(
    () => contactInfoArchiveItems.filter((item) => item.tab === contactInfoArchiveTab),
    [contactInfoArchiveItems, contactInfoArchiveTab]
  )
  const contactInfoCustomFields = useMemo(
    () => buildContactInfoCustomFieldViews(
      enabledContactInfoCustomFieldIds,
      contactCustomFieldDefinitions,
      contactInfoData?.customFields || []
    ),
    [contactCustomFieldDefinitions, contactInfoData?.customFields, enabledContactInfoCustomFieldIds]
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
  const getBusinessPhoneForMessage = (message: ChatMessage) => {
    if (message.businessPhoneNumberId) {
      const fromId = businessPhones.find((phone) => phone.id === message.businessPhoneNumberId)
      if (fromId) return fromId
    }

    if (message.businessPhone) {
      const fromPhone = businessPhones.find((phone) => phoneLooksSame(getBusinessPhoneValue(phone), message.businessPhone))
      if (fromPhone) return fromPhone
    }

    return selectedBusinessPhone ||
      whatsappStatus?.selectedPhone ||
      businessPhones.find((phone) => phone.is_default_sender) ||
      businessPhones[0] ||
      null
  }
  const cameraShareBusinessPhone = useMemo(() => (
    effectiveSelectedChatPhone ||
    businessPhones.find((phone) => phone.is_default_sender) ||
    whatsappStatus?.selectedPhone ||
    businessPhones[0] ||
    null
  ), [businessPhones, effectiveSelectedChatPhone, whatsappStatus?.selectedPhone])
  const cameraShareBusinessPhoneValue = getBusinessPhoneValue(cameraShareBusinessPhone)
  const cameraShareQrReady = isBusinessPhoneQrReady(cameraShareBusinessPhone)
  const cameraShareApiEnabled = cameraShareBusinessPhone?.api_send_enabled !== false
  const cameraShareTransport: 'api' | 'qr' = cameraShareQrReady && (!whatsappConnected || !cameraShareApiEnabled)
    ? 'qr'
    : 'api'
  const lastInboundForSelectedPhone = useMemo(() => {
    return [...messages]
      .filter((message) => {
        if (message.direction !== 'inbound') return false
        if (!selectedBusinessPhoneValue) return true
        return phoneLooksSame(message.businessPhone, selectedBusinessPhoneValue)
      })
      .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0] || null
  }, [messages, selectedBusinessPhoneValue])
  const lastInboundWhatsAppReplyWindowMessage = useMemo(() => (
    getNewestMessageByDate(messages.filter(messageCanOpenWhatsAppReplyWindow))
  ), [messages])
  const apiReplyWindowOpen = isInsideReplyWindow(lastInboundForSelectedPhone?.date)
  const highLevelWhatsAppReplyWindowOpen = isInsideReplyWindow(lastInboundWhatsAppReplyWindowMessage?.date)
  const selectedQrReady = isBusinessPhoneQrReady(selectedBusinessPhone)
  const outsideReplyWindow = Boolean(activeContact?.phone && !apiReplyWindowOpen)
  const inferredHighLevelChatChannel = useMemo(() => inferHighLevelChatChannel(activeContact, messages), [activeContact, messages])
  const activeContactHighLevelChannelOverride = activeContact?.id ? contactHighLevelChannelOverrides[activeContact.id] : undefined
  const inferredSocialHighLevelChannel = highLevelConnected && (inferredHighLevelChatChannel === 'instagram' || inferredHighLevelChatChannel === 'messenger')
    ? inferredHighLevelChatChannel
    : ''
  const activeHighLevelChatChannel = activeContactHighLevelChannelOverride || inferredSocialHighLevelChannel || selectedHighLevelChatChannel
  const sendingThroughHighLevel = Boolean(highLevelConnected && activeContact)
  const highLevelWhatsAppFallsBackToSms = Boolean(sendingThroughHighLevel && activeHighLevelChatChannel === 'whatsapp_api' && activeContact?.phone && !highLevelWhatsAppReplyWindowOpen)
  const effectiveHighLevelChatChannel: HighLevelChatChannel = highLevelWhatsAppFallsBackToSms ? 'sms_qr' : activeHighLevelChatChannel
  const activeHighLevelChannelNeedsPhone = effectiveHighLevelChatChannel === 'whatsapp_api' || effectiveHighLevelChatChannel === 'sms_qr'
  const selectedChannelCanSend = sendingThroughHighLevel
    ? Boolean(activeContact?.id && (!activeHighLevelChannelNeedsPhone || activeContact.phone))
    : Boolean(activeContact?.phone)
  const composerBlockedByReplyWindow = Boolean(outsideReplyWindow && !selectedQrReady && !sendingThroughHighLevel)
  const hasComposerText = Boolean(messageText.trim())
  const hasComposerContent = Boolean(hasComposerText || draftAttachments.length > 0 || voiceDraft)
  const voicePanelActive = Boolean(voiceRecording || voiceProcessing || voiceDraft)
  const canSendMessage = Boolean(selectedChannelCanSend && hasComposerContent && !voiceRecording && !voiceProcessing && !composerBlockedByReplyWindow)
  const canOpenScheduleSheet = Boolean(selectedChannelCanSend && hasComposerText && !draftAttachments.length && !voicePanelActive && !composerBlockedByReplyWindow && composerStatus !== 'sending')
  const composerInputDisabled = Boolean(!selectedChannelCanSend || voiceRecording || voiceProcessing || voiceDraft)
  const composerPlaceholder = voiceRecording
    ? 'Grabando...'
    : voiceProcessing
      ? 'Preparando audio...'
    : voiceDraft
      ? 'Audio listo'
      : selectedChannelCanSend
        ? ''
        : activeContact && sendingThroughHighLevel && activeHighLevelChannelNeedsPhone
          ? 'Sin teléfono'
          : activeContact
            ? 'Canal no disponible'
            : 'Sin contacto'
  const savedBankClabes = useMemo(() => sanitizeBankClabes(bankClabes), [bankClabes])
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
  const starredMessageIdSet = useMemo(() => new Set(starredMessageIds), [starredMessageIds])
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
    const currentActiveContactId = activeContactIdRef.current
    const currentConversationOpen = conversationOpenRef.current

    if (currentActiveContactId && currentConversationOpen) {
      const activeLoadedContact = nextChats.find((contact) => contact.id === currentActiveContactId)
      if (activeLoadedContact) {
        markContactReadState(activeLoadedContact)
        nextChats = nextChats.map((contact) => (
          contact.id === currentActiveContactId ? { ...contact, unreadCount: 0 } : contact
        ))
      }
    }
    syncReadStateForVisibleReadChats(nextChats, readState)

    setChats((currentChats) => (
      areChatListsEquivalent(currentChats, nextChats) ? currentChats : nextChats
    ))
    setActiveContactId((current) => {
      if (requestedContact) return requestedContact.id
      if (current === AI_AGENT_CHAT_ID && aiAgentChatEnabled) return current
      if (current && nextChats.some((contact) => contact.id === current)) return current
      return null
    })

    if (requestedContact) {
      startConversationBottomLock(requestedContact.id)
      runConversationOpenBottomScrollSequence()
      setConversationOpen(true)
    }

    return nextChats
  }, [aiAgentChatEnabled, runConversationOpenBottomScrollSequence, startConversationBottomLock])

  const loadChats = useCallback(async (options: { showCacheRefresh?: boolean; useCache?: boolean; silent?: boolean } = {}) => {
    const silentRefresh = options.silent === true
    const showCacheRefresh = options.showCacheRefresh === true && !silentRefresh
    const useCache = options.useCache !== false && !silentRefresh
    if (!silentRefresh) setChatsError('')
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
    const cachedChats = cacheEnabled && useCache ? readPhoneDailyCache<ChatContact[]>(cacheKey) : null
    const showedCachedChats = Boolean(cachedChats)

    if (cachedChats) {
      const cachedList = Array.isArray(cachedChats.data) ? cachedChats.data : []
      const cachedRequestedContact = requestedContactParam
        ? cachedList.find((contact) => contact.id === requestedContactParam) || null
        : null
      applyLoadedChats(cachedList, cachedRequestedContact)
      setChatsLoading(false)
      setChatsRefreshing(showCacheRefresh)
    } else if (!silentRefresh) {
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
      if (!showedCachedChats && !silentRefresh) {
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

  const loadContactCustomFieldDefinitions = useCallback(async () => {
    if (contactCustomFieldDefinitionsLoading) return

    const cacheKey = getPhoneDailyCacheKey('phone-chat', 'contact-custom-fields', locationId || 'default')
    const cachedDefinitions = readPhoneDailyCache<ContactCustomFieldDefinition[]>(cacheKey)

    if (cachedDefinitions) {
      setContactCustomFieldDefinitions(Array.isArray(cachedDefinitions.data) ? cachedDefinitions.data.filter((definition) => !definition.archived) : [])
      setContactCustomFieldDefinitionsLoaded(true)
      setContactCustomFieldDefinitionsLoading(false)
    } else {
      setContactCustomFieldDefinitionsLoading(true)
    }

    try {
      const definitions = await contactsService.getCustomFieldDefinitions()
      const activeDefinitions = Array.isArray(definitions) ? definitions.filter((definition) => !definition.archived) : []
      setContactCustomFieldDefinitions(activeDefinitions)
      setContactCustomFieldDefinitionsLoaded(true)
      writePhoneDailyCache(cacheKey, activeDefinitions, { maxEntryChars: 180_000 })
    } catch {
      if (!cachedDefinitions) {
        setContactCustomFieldDefinitions([])
        setContactCustomFieldDefinitionsLoaded(false)
      }
    } finally {
      setContactCustomFieldDefinitionsLoading(false)
    }
  }, [contactCustomFieldDefinitionsLoading, locationId])

  const loadConversation = useCallback(async (contactId: string, options: { showCacheRefresh?: boolean; useCache?: boolean; silent?: boolean } = {}) => {
    const loadGeneration = conversationLoadGenerationRef.current + 1
    conversationLoadGenerationRef.current = loadGeneration
    const isCurrentConversationLoad = () => (
      conversationLoadGenerationRef.current === loadGeneration &&
      activeContactIdRef.current === contactId
    )
    const silentRefresh = options.silent === true
    const showCacheRefresh = options.showCacheRefresh === true && !silentRefresh
    const useCache = options.useCache !== false && !silentRefresh
    const cacheKey = getPhoneDailyCacheKey('phone-chat', 'conversation', locationId || 'default', contactId)
    const cachedConversation = useCache ? readPhoneDailyCache<{ journey: JourneyEvent[]; messages: ChatMessage[] }>(cacheKey) : null
    const showedCachedConversation = Boolean(cachedConversation)

    if (cachedConversation) {
      const cachedJourney = Array.isArray(cachedConversation.data.journey) ? cachedConversation.data.journey : []
      const cachedMessages = Array.isArray(cachedConversation.data.messages) ? cachedConversation.data.messages : []
      setContactJourney((currentJourney) => (
        getJourneySignature(currentJourney) === getJourneySignature(cachedJourney) ? currentJourney : cachedJourney
      ))
      setMessages((currentMessages) => (
        areMessagesEquivalent(currentMessages, cachedMessages) ? currentMessages : cachedMessages
      ))
      setMessagesLoading(false)
      setMessagesRefreshing(showCacheRefresh)
    } else if (!silentRefresh) {
      setMessages([])
      setContactJourney([])
      setMessagesLoading(true)
      setMessagesRefreshing(false)
    }

    try {
      const [journey, scheduledMessages] = await Promise.all([
        contactsService.getContactJourney(contactId),
        whatsappApiService.getScheduledMessages(contactId).catch(() => [])
      ])
      if (!isCurrentConversationLoad()) return
      setContactJourney((currentJourney) => (
        getJourneySignature(currentJourney) === getJourneySignature(journey) ? currentJourney : journey
      ))
      const journeyMessages = journey
        .map(getJourneyMessage)
        .filter((message): message is ChatMessage => Boolean(message))
      const scheduledMessageBubbles = scheduledMessages
        .map(getScheduledChatMessageBubble)
        .filter((message): message is ChatMessage => Boolean(message))
      const nextMessages = [...journeyMessages, ...scheduledMessageBubbles]
        .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())

      setMessages((currentMessages) => (
        areMessagesEquivalent(currentMessages, nextMessages) ? currentMessages : nextMessages
      ))
      writePhoneDailyCache(cacheKey, { journey, messages: nextMessages }, { maxEntryChars: 360_000 })
    } catch {
      if (isCurrentConversationLoad() && !showedCachedConversation && !silentRefresh) {
        setMessages([])
        setContactJourney([])
      }
    } finally {
      if (isCurrentConversationLoad()) {
        setMessagesLoading(false)
        setMessagesRefreshing(false)
      }
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
      ? 'Agente de IA | Ristak'
      : activeContact ? `${getContactName(activeContact)} | Ristak` : 'Ristak'
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
    clearClosingSwipeActions()
  }, [archivedViewOpen, chatFilter, chatQuery, selectedChatPhoneId, clearClosingSwipeActions])

  useEffect(() => {
    if (!contactInfoOpen) {
      setContactInfoArchiveOpen(false)
      setEditingCustomFieldId(null)
      setCustomFieldDrafts({})
      setSavingCustomFieldId(null)
    }
  }, [contactInfoOpen])

  useEffect(() => {
    setContactInfoArchiveOpen(false)
  }, [activeContactId])

  useLayoutEffect(() => {
    resetPhoneFrameHorizontalScroll()
    const frameId = window.requestAnimationFrame(resetPhoneFrameHorizontalScroll)
    return () => window.cancelAnimationFrame(frameId)
  }, [cameraSharePhoto, contactInfoArchiveOpen, contactInfoOpen, conversationVisible, resetPhoneFrameHorizontalScroll])

  useLayoutEffect(() => {
    chatSwipeGenerationRef.current += 1
    setChatSwipeSuppressed(true)
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
    clearClosingSwipeActions()
    chatSwipeGestureRef.current = null

    if (conversationVisible) return

    const releaseSwipe = window.setTimeout(() => {
      chatSwipeGenerationRef.current += 1
      setOpenSwipeChatId(null)
      setDraggingSwipe(null)
      clearClosingSwipeActions()
      chatSwipeGestureRef.current = null
      setChatSwipeSuppressed(false)
    }, 320)

    return () => window.clearTimeout(releaseSwipe)
  }, [clearClosingSwipeActions, conversationVisible])

  useLayoutEffect(() => {
    if (!activeContactId) return
    chatSwipeGenerationRef.current += 1
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
    clearClosingSwipeActions()
    chatSwipeGestureRef.current = null
  }, [activeContactId, clearClosingSwipeActions])

  useEffect(() => () => {
    clearChatSwipeCloseTimer()
  }, [clearChatSwipeCloseTimer])

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
    const updateAccess = () => {
      const nextDeviceMode = getPhoneChatDeviceMode()
      setDeviceMode(nextDeviceMode)
      setAccessState(getAccessState(nextDeviceMode))
    }
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
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
          scrollMessagesPaneToBottom()
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
  }, [accessState, scrollMessagesPaneToBottom])

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
        loadChats({ silent: true, useCache: false })
      }
    }
    const refreshInterval = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !chatQuery.trim()) {
        loadChats({ silent: true, useCache: false })
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
    if (!contactInfoOpen || enabledContactInfoCustomFieldIds.length === 0 || contactCustomFieldDefinitionsLoaded) return
    loadContactCustomFieldDefinitions()
  }, [
    contactCustomFieldDefinitionsLoaded,
    contactInfoOpen,
    enabledContactInfoCustomFieldIds.length,
    loadContactCustomFieldDefinitions
  ])

  useEffect(() => () => {
    clearQueuedBottomScrolls()
    if (conversationScrollSettlingTimeoutRef.current !== null) {
      window.clearTimeout(conversationScrollSettlingTimeoutRef.current)
      conversationScrollSettlingTimeoutRef.current = null
    }
  }, [clearQueuedBottomScrolls])

  useEffect(() => {
    if (!conversationOpen) {
      clearQueuedBottomScrolls()
      if (conversationScrollSettlingTimeoutRef.current !== null) {
        window.clearTimeout(conversationScrollSettlingTimeoutRef.current)
        conversationScrollSettlingTimeoutRef.current = null
      }
      setConversationScrollSettling(false)
    }
  }, [clearQueuedBottomScrolls, conversationOpen])

  useLayoutEffect(() => {
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
  const shouldUpdateScheduledCountdown = useMemo(
    () => messages.some((message) => isMessageScheduled(message) && !isMessageFailed(message)),
    [messages]
  )
  const scheduledRefreshIntervalMs = useMemo(() => {
    const scheduledTimes = messages
      .filter((message) => isMessageScheduled(message) && !isMessageFailed(message))
      .map((message) => new Date(message.scheduledAt || message.date).getTime())
      .filter(Number.isFinite)

    if (scheduledTimes.length === 0) return 0

    const nextScheduledTime = Math.min(...scheduledTimes)
    const delay = nextScheduledTime - Date.now() + 35_000
    return Math.max(15_000, Math.min(delay, 5 * 60_000))
  }, [messages])

  useEffect(() => {
    if (!shouldUpdateScheduledCountdown) return

    setScheduledCountdownNow(Date.now())
    const interval = window.setInterval(() => {
      setScheduledCountdownNow(Date.now())
    }, 30_000)

    return () => window.clearInterval(interval)
  }, [shouldUpdateScheduledCountdown])

  useEffect(() => {
    if (!activeContact?.id || accessState !== 'allowed' || !conversationVisible || !shouldRefreshReceipts) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadConversation(activeContact.id, { silent: true, useCache: false })
      }
    }, 12000)

    return () => window.clearInterval(interval)
  }, [accessState, activeContact?.id, conversationVisible, loadConversation, shouldRefreshReceipts])

  useEffect(() => {
    if (!activeContact?.id || accessState !== 'allowed' || !conversationVisible || !scheduledRefreshIntervalMs) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadConversation(activeContact.id, { silent: true, useCache: false })
      }
    }, scheduledRefreshIntervalMs)

    return () => window.clearInterval(interval)
  }, [accessState, activeContact?.id, conversationVisible, loadConversation, scheduledRefreshIntervalMs])

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
    setContactInfoDetailPanel(null)
    setEditingCustomFieldId(null)
    setCustomFieldDrafts({})
    setSavingCustomFieldId(null)
  }, [activeContactId])

  useEffect(() => () => {
    const gesture = messageActionPressRef.current
    if (gesture) {
      window.clearTimeout(gesture.timerId)
      messageActionPressRef.current = null
    }
  }, [])

  useEffect(() => {
    const gesture = messageActionPressRef.current
    if (gesture) {
      window.clearTimeout(gesture.timerId)
      messageActionPressRef.current = null
    }
    setMessageActionMenu(null)
  }, [activeContactId, contactInfoOpen, conversationVisible, messageInfoOpen, sheet])

  useEffect(() => {
    if (messageActionMenu && !messageActionMenuMessage) {
      setMessageActionMenu(null)
    }
  }, [messageActionMenu, messageActionMenuMessage])

  useEffect(() => {
    if (!messageActionMenu) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMessageActionMenu(null)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [messageActionMenu])

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
    if (sheet !== 'clabe') {
      setClabeFormOpen(false)
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
    const pane = messagesPaneRef.current
    const content = messagesContentRef.current
    if (!pane || !content || typeof ResizeObserver === 'undefined') return undefined

    const resizeObserver = new ResizeObserver(() => {
      const shouldStickToBottom = conversationOpenRef.current && (
        messagesPaneNearBottomRef.current ||
        isConversationBottomLockActive(activeContactIdRef.current)
      )

      if (shouldStickToBottom) {
        queueMessagesPaneBottomScroll()
      }
    })

    resizeObserver.observe(content)

    return () => {
      resizeObserver.disconnect()
    }
  }, [conversationVisible, isConversationBottomLockActive, latestMessageKey, queueMessagesPaneBottomScroll])

  useLayoutEffect(() => {
    const previous = previousMessagesScrollRef.current
    const lastMessage = messages[messages.length - 1]
    const openedConversation = conversationOpen && (
      !previous.conversationOpen ||
      previous.activeContactId !== activeContactId
    )
    const finishedInitialLoad = previous.messagesLoading && !messagesLoading
    const messageWasAdded = messages.length > previous.count
    const userWasAlreadyAtBottom = messagesPaneNearBottomRef.current
    const initialBottomLockActive = conversationOpen && isConversationBottomLockActive(activeContactId)
    const shouldScrollToEnd = conversationOpen && (
      openedConversation ||
      finishedInitialLoad ||
      initialBottomLockActive ||
      (messageWasAdded && (userWasAlreadyAtBottom || lastMessage?.direction === 'outbound'))
    )

    previousMessagesScrollRef.current = {
      activeContactId,
      conversationOpen,
      messagesLoading,
      count: messages.length
    }

    if (!shouldScrollToEnd) return

    if (openedConversation || finishedInitialLoad || initialBottomLockActive) {
      runConversationOpenBottomScrollSequence()
      return
    }

    scrollMessagesPaneToBottom()
    queueMessagesPaneBottomScroll()
  }, [
    activeContactId,
    conversationOpen,
    isConversationBottomLockActive,
    latestMessageKey,
    messages.length,
    messagesLoading,
    queueMessagesPaneBottomScroll,
    runConversationOpenBottomScrollSequence,
    scrollMessagesPaneToBottom
  ])

  useEffect(() => {
    const messageIds = new Set(messages.map((message) => message.id))

    if (playingAudioMessageId && !messageIds.has(playingAudioMessageId)) {
      messageAudioRefs.current[playingAudioMessageId]?.pause()
      stopMessageAudioProgressLoop(playingAudioMessageId)
      setPlayingAudioMessageId(null)
    }

    if (audioLoadingMessageId && !messageIds.has(audioLoadingMessageId)) {
      setAudioLoadingMessageId(null)
    }

    setMessageAudioRates((current) => {
      let changed = false
      const next: Record<string, MessageAudioRate> = {}

      Object.entries(current).forEach(([messageId, rate]) => {
        if (messageIds.has(messageId)) {
          next[messageId] = rate
          return
        }

        changed = true
      })

      return changed ? next : current
    })
  }, [audioLoadingMessageId, messages, playingAudioMessageId])

  useEffect(() => {
    return () => {
      clearVoiceTimer()
      clearVoiceHoldTimer()
      stopVoiceMeter()
      stopMessageAudioProgressLoop()
      voiceAudioRef.current?.pause()
      Object.values(messageAudioRefs.current).forEach((audio) => audio?.pause())
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

  const clearVoiceHoldTimer = () => {
    if (!voiceHoldTimerRef.current) return
    window.clearTimeout(voiceHoldTimerRef.current)
    voiceHoldTimerRef.current = null
  }

  const stopVoiceMeter = () => {
    if (voiceAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(voiceAnimationFrameRef.current)
      voiceAnimationFrameRef.current = null
    }

    voiceAudioSourceRef.current?.disconnect()
    voiceAudioSourceRef.current = null
    voiceAnalyserRef.current = null
    voiceSmoothedWaveHeightRef.current = VOICE_WAVE_MIN_HEIGHT

    if (voiceAudioContextRef.current) {
      voiceAudioContextRef.current.close().catch(() => undefined)
      voiceAudioContextRef.current = null
    }
  }

  const startVoiceMeter = (stream: MediaStream) => {
    const AudioContextConstructor = getAudioContextConstructor()
    if (!AudioContextConstructor) return

    try {
      const audioContext = new AudioContextConstructor()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)

      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.72
      const samples = new Uint8Array(analyser.fftSize)
      source.connect(analyser)

      voiceAudioContextRef.current = audioContext
      voiceAudioSourceRef.current = source
      voiceAnalyserRef.current = analyser
      voiceLastWaveUpdateRef.current = performance.now()
      voiceSmoothedWaveHeightRef.current = VOICE_WAVE_MIN_HEIGHT

      audioContext.resume().catch(() => undefined)

      const drawWave = (timestamp: number) => {
        if (!voiceAnalyserRef.current) return

        if (timestamp - voiceLastWaveUpdateRef.current >= VOICE_WAVE_SAMPLE_INTERVAL_MS) {
          voiceAnalyserRef.current.getByteTimeDomainData(samples)
          const rawHeight = getVoiceBarHeight(samples)
          const nextHeight = smoothVoiceBarHeight(rawHeight, voiceSmoothedWaveHeightRef.current)
          voiceSmoothedWaveHeightRef.current = nextHeight
          setVoiceWaveBars((current) => [...current.slice(1), nextHeight])
          voiceLastWaveUpdateRef.current = timestamp
        }

        voiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)
      }

      voiceAnimationFrameRef.current = window.requestAnimationFrame(drawWave)
    } catch {
      stopVoiceMeter()
    }
  }

  const stopVoiceStream = () => {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    voiceStreamRef.current = null
  }

  const stopVoicePreview = (reset = false) => {
    const audio = voiceAudioRef.current
    if (audio) {
      audio.pause()
      if (reset) audio.currentTime = 0
    }
    setVoicePreviewPlaying(false)
  }

  const handleStopVoiceRecording = () => {
    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
    }
  }

  const handleCancelVoiceDraft = () => {
    voiceCancelRef.current = true
    voiceSendAfterStopRef.current = false
    voiceStartPendingRef.current = false
    voiceStopAfterStartRef.current = false
    clearVoiceHoldTimer()
    stopVoicePreview(true)
    setVoiceDraft(null)
    setVoiceProcessing(false)
    setVoiceElapsedMs(0)
    setVoiceWaveBars(createInitialVoiceBars())

    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
      return
    }

    clearVoiceTimer()
    stopVoiceMeter()
    stopVoiceStream()
    setVoiceRecording(false)
    voiceCancelRef.current = false
  }

  const handleStartVoiceRecording = async () => {
    if (voiceRecording || voiceProcessing || voiceDraft) return

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

    voiceStartPendingRef.current = true

    try {
      const mimeType = getSupportedVoiceMimeType()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      voiceCancelRef.current = false
      voiceChunksRef.current = []
      voiceStreamRef.current = stream
      voiceRecorderRef.current = recorder
      voiceStartedAtRef.current = Date.now()
      stopVoicePreview(true)
      setVoiceDraft(null)
      setVoiceProcessing(false)
      setVoiceElapsedMs(0)
      setVoiceWaveBars(createInitialVoiceBars())
      startVoiceMeter(stream)

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
        stopVoiceMeter()
        stopVoiceStream()
        setVoiceRecording(false)
        voiceRecorderRef.current = null
        voiceChunksRef.current = []
        voiceCancelRef.current = false

        if (canceled) {
          voiceSendAfterStopRef.current = false
          setVoiceProcessing(false)
          return
        }

        setVoiceProcessing(true)

        try {
          const blob = new Blob(chunks, { type: recordedType })
          if (durationMs < MIN_VOICE_RECORDING_MS || blob.size === 0) {
            showToast('info', 'Audio muy corto', 'Graba un poquito más para poder enviarlo.')
            voiceSendAfterStopRef.current = false
            setVoiceProcessing(false)
            setVoiceElapsedMs(0)
            setVoiceWaveBars(createInitialVoiceBars())
            return
          }

          if (blob.size > MAX_VOICE_MESSAGE_BYTES) {
            showToast('error', 'Audio muy pesado', 'Graba un audio más corto para enviarlo por WhatsApp.')
            voiceSendAfterStopRef.current = false
            setVoiceProcessing(false)
            setVoiceElapsedMs(0)
            setVoiceWaveBars(createInitialVoiceBars())
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
          setVoiceProcessing(false)
        } catch (error: any) {
          showToast('error', 'No se pudo preparar el audio', error?.message || 'Intenta grabarlo otra vez.')
          voiceSendAfterStopRef.current = false
          setVoiceProcessing(false)
          setVoiceElapsedMs(0)
          setVoiceWaveBars(createInitialVoiceBars())
        }
      }

      recorder.start(250)
      voiceStartPendingRef.current = false
      setVoiceRecording(true)
      voiceTimerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - voiceStartedAtRef.current
        setVoiceElapsedMs(elapsed)
        if (elapsed >= MAX_VOICE_RECORDING_MS && voiceRecorderRef.current?.state === 'recording') {
          voiceRecorderRef.current.stop()
        }
      }, 250)

      if (voiceStopAfterStartRef.current) {
        voiceStopAfterStartRef.current = false
        window.setTimeout(() => {
          if (voiceRecorderRef.current?.state === 'recording') {
            voiceRecorderRef.current.stop()
          }
        }, 0)
      }
    } catch (error: any) {
      clearVoiceTimer()
      stopVoiceMeter()
      stopVoiceStream()
      setVoiceRecording(false)
      setVoiceProcessing(false)
      voiceRecorderRef.current = null
      voiceStartPendingRef.current = false
      voiceStopAfterStartRef.current = false
      voiceSendAfterStopRef.current = false
      showToast('error', 'No se abrió el micrófono', error?.message || 'Revisa permisos del celular e intenta otra vez.')
    }
  }

  const handleSelectContact = (contact: Contact) => {
    const chatContact = (chats.find((item) => item.id === contact.id) || contact) as ChatContact
    const nextContact = ensureChatContact(contact)
    closeSwipeActions()
    handleCancelVoiceDraft()
    clearMessageActionPress()
    markContactReadState(chatContact)
    startConversationBottomLock(nextContact.id)
    runConversationOpenBottomScrollSequence()
    setActiveContactId(nextContact.id)
    setChats((current) => current.map((item) => (
      item.id === nextContact.id ? { ...item, unreadCount: 0 } : item
    )))
    setConversationOpen(true)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
    setMessageInfoOpen(false)
    setMessageInfoMessageId(null)
    setMessageActionMenu(null)
    setReplyingToMessageId(null)
    setScheduleEditingMessageId(null)
    messageInfoSwipeGestureRef.current = null
    setDraggingMessageInfoSwipe(null)
    setContactQuery('')
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleOpenAIAgentChat = () => {
    closeSwipeActions()
    handleCancelVoiceDraft()
    clearMessageActionPress()
    startConversationBottomLock(AI_AGENT_CHAT_ID)
    runConversationOpenBottomScrollSequence()
    setActiveContactId(AI_AGENT_CHAT_ID)
    setConversationOpen(true)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
    setMessageInfoOpen(false)
    setMessageInfoMessageId(null)
    setMessageActionMenu(null)
    setReplyingToMessageId(null)
    setScheduleEditingMessageId(null)
    messageInfoSwipeGestureRef.current = null
    setDraggingMessageInfoSwipe(null)
    setContactQuery('')
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleBackToChats = () => {
    setChatSwipeSuppressed(true)
    clearQueuedBottomScrolls()
    closeSwipeActions()
    handleCancelVoiceDraft()
    clearMessageActionPress()
    setConversationOpen(false)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
    setMessageInfoOpen(false)
    setMessageInfoMessageId(null)
    setMessageActionMenu(null)
    setReplyingToMessageId(null)
    setScheduleEditingMessageId(null)
    messageInfoSwipeGestureRef.current = null
    setDraggingMessageInfoSwipe(null)
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleOpenContactInfo = async () => {
    if (!activeContact) return

    actionSheetDismiss.requestClose()
    setMessageInfoOpen(false)
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

  const handleStartCustomFieldEdit = (customField: ContactInfoCustomFieldView) => {
    setEditingCustomFieldId(customField.id)
    setCustomFieldDrafts((current) => ({
      ...current,
      [customField.id]: customField.editValue
    }))
  }

  const handleCancelCustomFieldEdit = (fieldId: string) => {
    setEditingCustomFieldId((current) => (current === fieldId ? null : current))
    setCustomFieldDrafts((current) => {
      const next = { ...current }
      delete next[fieldId]
      return next
    })
  }

  const handleSaveCustomField = async (customField: ContactInfoCustomFieldView) => {
    if (!contactInfoData) return

    const draftValue = customFieldDrafts[customField.id] ?? customField.editValue
    const customFields = buildContactCustomFieldsForSave(contactInfoData, customField, draftValue)
    setSavingCustomFieldId(customField.id)

    try {
      const updatedContact = await contactsService.updateContact(contactInfoData.id, { customFields })
      const savedCustomFields = Array.isArray(updatedContact.customFields) ? updatedContact.customFields : customFields
      const nextContact = {
        ...contactInfoData,
        customFields: savedCustomFields
      }
      const cacheKey = getPhoneDailyCacheKey('phone-chat', 'contact-info', locationId || 'default', contactInfoData.id)

      setContactInfoContact(nextContact)
      setChats((current) => current.map((contact) => (
        contact.id === contactInfoData.id ? { ...contact, customFields: savedCustomFields } : contact
      )))
      writePhoneDailyCache(cacheKey, nextContact, { maxEntryChars: 220_000 })
      setEditingCustomFieldId(null)
      setCustomFieldDrafts((current) => {
        const next = { ...current }
        delete next[customField.id]
        return next
      })
      showToast('success', 'Dato guardado', `${customField.label} quedó actualizado.`)
    } catch (error: any) {
      showToast('error', 'No se guardó el dato', error?.message || 'Intenta otra vez.')
    } finally {
      setSavingCustomFieldId(null)
    }
  }

  const closeSwipeActions = () => {
    chatSwipeGenerationRef.current += 1
    setOpenSwipeChatId(null)
    setDraggingSwipe(null)
    clearClosingSwipeActions()
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
    if (contact?.id) {
      startConversationBottomLock(contact.id)
      runConversationOpenBottomScrollSequence()
      setActiveContactId(contact.id)
    }
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
    if (nextOffset > 0 && closingSwipeChatId === gesture.contactId) {
      clearClosingSwipeActions(gesture.contactId)
    }
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
      const shouldOpenSwipe = gesture.offset >= openThreshold
      if (shouldOpenSwipe) {
        clearClosingSwipeActions(gesture.contactId)
        setOpenSwipeChatId(gesture.contactId)
      } else {
        if (gesture.startOffset > 0 || gesture.offset > 0) {
          keepSwipeActionsBehindClosingRow(gesture.contactId)
        }
        setOpenSwipeChatId(null)
      }
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

  const clearMessageActionPress = useCallback(() => {
    const gesture = messageActionPressRef.current
    if (!gesture) return

    window.clearTimeout(gesture.timerId)
    messageActionPressRef.current = null
  }, [])

  const closeMessageActionMenu = useCallback(() => {
    clearMessageActionPress()
    setMessageActionMenu(null)
  }, [clearMessageActionPress])

  const openMessageActionMenu = useCallback((message: ChatMessage, element: HTMLElement) => {
    if (message.direction === 'system' || !conversationVisible) return

    clearMessageActionPress()
    messageInfoSwipeGestureRef.current = null
    setDraggingMessageInfoSwipe(null)
    setMessageInfoOpen(false)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)

    const rect = element.getBoundingClientRect()
    const viewportWidth = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 390)
    const viewportHeight = Math.max(480, window.innerHeight || document.documentElement.clientHeight || 740)
    const bubbleWidth = Math.min(Math.max(96, Math.round(rect.width)), viewportWidth - 24)
    const scheduled = message.direction === 'outbound' && isMessageScheduled(message)
    const menuWidth = Math.min(Math.max(bubbleWidth, scheduled ? 252 : 246), viewportWidth - 24)
    const align: MessageActionMenuAlign = message.direction === 'outbound' ? 'end' : 'start'
    const preferredLeft = align === 'end' ? rect.right - menuWidth : rect.left
    const left = Math.max(12, Math.min(Math.round(preferredLeft), viewportWidth - menuWidth - 12))
    const estimatedMenuHeight = scheduled ? 126 : 300
    const maxSafeTop = viewportHeight - estimatedMenuHeight - 12
    const top = Math.max(12, Math.min(Math.round(rect.top), Math.max(12, Math.round(maxSafeTop))))

    setMessageActionMenu({
      messageId: message.id,
      mode: 'main',
      rect: {
        top,
        left,
        width: menuWidth,
        bubbleWidth,
        height: Math.round(rect.height)
      },
      placement: 'below',
      align
    })
  }, [actionSheetDismiss, clearMessageActionPress, conversationVisible])

  const handleMessageActionPointerDown = (message: ChatMessage, event: React.PointerEvent<HTMLDivElement>) => {
    if (message.direction === 'system' || messageActionMenu) return
    if (event.pointerType === 'mouse' && event.button !== 0) return

    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, video, audio, [contenteditable="true"]')) return

    clearMessageActionPress()
    const element = event.currentTarget
    const timerId = window.setTimeout(() => {
      if (event.pointerType !== 'mouse') {
        triggerMessageActionHapticFeedback()
      }
      openMessageActionMenu(message, element)
    }, MESSAGE_ACTION_LONG_PRESS_MS)

    messageActionPressRef.current = {
      messageId: message.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      timerId
    }
  }

  const handleMessageActionPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const gesture = messageActionPressRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    const moved = Math.max(
      Math.abs(event.clientX - gesture.startX),
      Math.abs(event.clientY - gesture.startY)
    )
    if (moved > MESSAGE_ACTION_MOVE_TOLERANCE) {
      clearMessageActionPress()
    }
  }

  const handleMessageActionPointerEnd = () => {
    clearMessageActionPress()
  }

  const handleMessageActionContextMenu = (message: ChatMessage, event: React.MouseEvent<HTMLDivElement>) => {
    if (message.direction === 'system') return
    event.preventDefault()
    openMessageActionMenu(message, event.currentTarget)
  }

  const getScheduledMessageActionId = (message: ChatMessage) => (
    message.scheduledMessageId ||
    (message.id.startsWith('scheduled-') ? message.id.slice('scheduled-'.length) : '')
  )

  const handleReplyMessage = (message: ChatMessage) => {
    setReplyingToMessageId(message.id)
    closeMessageActionMenu()
    requestAnimationFrame(() => composerInputRef.current?.focus())
    showToast('info', 'Respuesta lista', 'Escribe tu mensaje y mándalo cuando esté listo.')
  }

  const handleForwardMessage = () => {
    closeMessageActionMenu()
    showToast('info', 'Reenviar aún no está activo', 'Ya dejamos la opción lista para conectarla después.')
  }

  const handleCopyMessage = async (message: ChatMessage) => {
    const text = getMessageActionText(message)
    if (!text) {
      showToast('warning', 'Nada para copiar', 'Este mensaje no tiene texto disponible.')
      return
    }

    try {
      await copyTextToClipboard(text)
      closeMessageActionMenu()
      showToast('success', 'Copiado', 'El texto del mensaje quedó en el portapapeles.')
    } catch {
      showToast('error', 'No se pudo copiar', 'Intenta seleccionarlo manualmente.')
    }
  }

  const handleToggleStarMessage = (message: ChatMessage) => {
    setStarredMessageIds((current) => {
      const exists = current.includes(message.id)
      const next = exists ? current.filter((id) => id !== message.id) : [message.id, ...current]
      writeStoredChatIds(CHAT_STARRED_MESSAGES_KEY, next)
      showToast('success', exists ? 'Destacado quitado' : 'Mensaje destacado', exists ? 'Se quitó la marca de este mensaje.' : 'El mensaje quedó marcado para encontrarlo rápido.')
      return next
    })
    closeMessageActionMenu()
  }

  const handleUnavailableMessageAction = (label: string) => {
    closeMessageActionMenu()
    showToast('info', `${label} todavía no está activo`, 'La opción ya aparece, pero no ejecuta cambios todavía.')
  }

  const handleEditScheduledMessage = (message: ChatMessage) => {
    const scheduledMessageId = getScheduledMessageActionId(message)
    if (!scheduledMessageId) {
      showToast('error', 'No se pudo editar', 'No encontramos la programación de este mensaje.')
      return
    }

    setScheduleEditingMessageId(scheduledMessageId)
    setComposerMessageText(message.text)
    if (composerInputRef.current) {
      composerInputRef.current.textContent = message.text
    }
    setDraftAttachments([])
    stopVoicePreview(true)
    voiceSendAfterStopRef.current = false
    setVoiceDraft(null)
    setScheduleDraft(createScheduleDraftFromDate(message.scheduledAt || message.date))
    setScheduleError('')
    closeMessageActionMenu()
    setSheet('schedule')
  }

  const handleCancelScheduledMessage = async (message: ChatMessage) => {
    if (!activeContact || cancelingScheduledMessageId) return

    const scheduledMessageId = getScheduledMessageActionId(message)
    if (!scheduledMessageId) {
      showToast('error', 'No se pudo eliminar', 'No encontramos la programación de este mensaje.')
      return
    }

    setCancelingScheduledMessageId(scheduledMessageId)
    closeMessageActionMenu()

    try {
      await whatsappApiService.cancelScheduledMessage(scheduledMessageId, activeContact.id)
      setMessages((current) => current.filter((item) => item.id !== message.id && item.scheduledMessageId !== scheduledMessageId))
      await loadConversation(activeContact.id, { silent: true, useCache: false })
      await loadChats({ silent: true, useCache: false })
      showToast('success', 'Programación eliminada', 'Ese mensaje ya no se enviará.')
    } catch (error: any) {
      showToast('error', 'No se eliminó', getErrorMessage(error, 'Intenta eliminar la programación otra vez.'))
    } finally {
      setCancelingScheduledMessageId(null)
    }
  }

  const closeMessageInfo = useCallback(() => {
    messageInfoSwipeGestureRef.current = null
    setDraggingMessageInfoSwipe(null)
    setMessageInfoOpen(false)
  }, [])

  const openMessageInfo = useCallback((message: ChatMessage) => {
    if (message.direction === 'system') return
    messageInfoSwipeGestureRef.current = null
    setDraggingMessageInfoSwipe(null)
    setMessageInfoMessageId(message.id)
    setMessageInfoOpen(true)
    actionSheetDismiss.requestClose()
    setContactInfoOpen(false)
  }, [actionSheetDismiss])

  const handleMessageInfoTouchStart = (message: ChatMessage, event: React.TouchEvent<HTMLDivElement>) => {
    if (message.direction === 'system' || event.touches.length !== 1 || messageInfoOpen) return

    const target = event.target as HTMLElement | null
    if (target?.closest('button, a, input, textarea, select, [contenteditable="true"]')) return

    const touch = event.touches[0]
    if (!touch) return

    messageInfoSwipeGestureRef.current = {
      messageId: message.id,
      startX: touch.clientX,
      startY: touch.clientY,
      offset: 0,
      lastRenderedOffset: 0,
      active: false
    }
  }

  const handleMessageInfoTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const gesture = messageInfoSwipeGestureRef.current
    const touch = event.touches[0]
    if (!gesture || !touch) return
    if (!conversationVisible || messageInfoOpen) {
      messageInfoSwipeGestureRef.current = null
      setDraggingMessageInfoSwipe(null)
      return
    }

    const deltaX = touch.clientX - gesture.startX
    const deltaY = touch.clientY - gesture.startY
    const horizontalDistance = Math.abs(deltaX)

    if (!gesture.active) {
      if (deltaX >= 0 || horizontalDistance < MESSAGE_INFO_SWIPE_ACTIVATE_THRESHOLD || horizontalDistance <= Math.abs(deltaY)) return
      gesture.active = true
    }

    event.preventDefault()
    const nextOffset = Math.round(Math.min(
      MESSAGE_INFO_SWIPE_ACTION_WIDTH,
      Math.max(0, -deltaX)
    ))

    gesture.offset = nextOffset
    if (Math.abs(nextOffset - gesture.lastRenderedOffset) < MESSAGE_INFO_SWIPE_RENDER_STEP) return
    gesture.lastRenderedOffset = nextOffset
    setDraggingMessageInfoSwipe({ messageId: gesture.messageId, offset: nextOffset })
  }

  const handleMessageInfoTouchEnd = () => {
    const gesture = messageInfoSwipeGestureRef.current
    if (!gesture) return

    if (gesture.active && gesture.offset >= MESSAGE_INFO_SWIPE_OPEN_THRESHOLD) {
      const message = messages.find((item) => item.id === gesture.messageId)
      if (message) openMessageInfo(message)
    }

    setDraggingMessageInfoSwipe(null)
    messageInfoSwipeGestureRef.current = null
  }

  const handleUnavailableAttachment = (label: string) => {
    showToast('info', label, 'Esta opción ya está en el menú. La conexión real se activa cuando los archivos del celular estén conectados.')
  }

  const addDraftAttachment = (attachment: MobileChatAttachment) => {
    setDraftAttachments((current) => [attachment, ...current].slice(0, 4))
    showToast('success', attachment.attachmentType === 'image' ? 'Foto lista' : 'Documento listo', 'Revisa la vista previa y toca enviar.')
  }

  const openCameraShare = (attachment: MobilePhotoAttachment) => {
    actionSheetDismiss.requestClose(() => {
      setCameraSharePhoto(attachment)
      setCameraShareQuery('')
      setCameraShareCaption('')
      setCameraShareSelectedContacts([])
      setCameraShareSending(false)
      if (cameraShareCaptionRef.current) {
        cameraShareCaptionRef.current.textContent = ''
      }
    })
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
        attachmentType: 'image',
        size: file.size,
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

  const readDocumentFile = (file: File) => {
    if (!isSupportedDocumentFile(file)) {
      showToast('error', 'Archivo no válido', 'Elige un PDF, Word, Excel, PowerPoint, TXT o CSV.')
      return
    }

    if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
      showToast('error', 'Archivo muy pesado', 'Elige un documento de menos de 20 MB para mandarlo por WhatsApp.')
      return
    }

    const mimeType = getDocumentMimeType(file)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? normalizeDataUrlMimeType(reader.result, mimeType) : ''
      if (!dataUrl) {
        showToast('error', 'No se pudo leer', 'Intenta elegir el documento otra vez.')
        return
      }

      const attachment: MobileDocumentAttachment = {
        id: `document-${Date.now()}`,
        name: file.name || `documento-${Date.now()}`,
        type: mimeType,
        dataUrl,
        attachmentType: 'document',
        source: 'documents',
        size: file.size
      }
      addDraftAttachment(attachment)
    }
    reader.onerror = () => showToast('error', 'No se pudo leer', 'Intenta elegir el documento otra vez.')
    reader.readAsDataURL(file)
  }

  const handleWebDocumentSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    readDocumentFile(file)
  }

  const handlePickDocument = () => {
    actionSheetDismiss.requestClose()
    documentInputRef.current?.click()
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

    if (!whatsappConnected && !cameraShareQrReady) {
      showToast('error', 'WhatsApp no está conectado', 'Conecta WhatsApp API o QR para mandar fotos desde la cámara.')
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
        transport: cameraShareTransport,
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
      await loadChats({ silent: true, useCache: false })
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

  const handleOpenClabeSheet = () => {
    setClabeFormOpen(false)
    setSheet('clabe')
  }

  const handleSaveClabe = async () => {
    const clabe = normalizeClabe(clabeDraft.clabe)

    if (clabe.length !== 18) {
      showToast('warning', 'CLABE incompleta', 'La CLABE interbancaria debe tener 18 números.')
      return
    }

    if (savedBankClabes.some((account) => account.clabe === clabe)) {
      showToast('warning', 'CLABE ya guardada', 'Esa CLABE ya aparece en tu lista.')
      return
    }

    const nextAccount: BankClabeAccount = {
      id: `clabe-${Date.now()}`,
      alias: clabeDraft.alias.trim() || `CLABE ${clabe.slice(-4)}`,
      clabe,
      bank: clabeDraft.bank.trim(),
      accountHolder: clabeDraft.accountHolder.trim()
    }

    try {
      await setBankClabes([nextAccount, ...savedBankClabes])
      setClabeDraft(createEmptyClabeForm())
      setClabeFormOpen(false)
      showToast('success', 'CLABE guardada', 'Ya puedes enviarla desde este chat.')
    } catch {
      showToast('error', 'No se guardó', 'Intenta guardar la CLABE otra vez.')
    }
  }

  const handleSendClabe = async (account: BankClabeAccount) => {
    if (!activeContact) {
      showToast('error', 'Sin contacto', 'Abre un chat antes de enviar una CLABE.')
      return
    }

    setSendingClabeId(account.id)
    actionSheetDismiss.requestClose()
    try {
      await handleSendMessage('api', {
        textOverride: buildClabeMessage(account),
        preserveComposer: true
      })
    } finally {
      setSendingClabeId(null)
    }
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
      await loadConversation(activeContact.id, { silent: true, useCache: false })
      await loadChats({ silent: true, useCache: false })
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
      setComposerMessageText('')
      return
    }
    setComposerMessageText(normalizedText)
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

  const handleOpenScheduleSheet = () => {
    if (!activeContact) return

    if (!messageTextRef.current.trim()) {
      showToast('warning', 'Escribe el mensaje', 'Primero escribe el texto que quieres programar.')
      return
    }

    if (draftAttachments.length > 0 || voiceDraft) {
      showToast('warning', 'Solo texto por ahora', 'Programa mensajes escritos; las fotos, documentos y audios se mandan al momento.')
      return
    }

    setScheduleDraft(createDefaultScheduleDraft())
    setScheduleError('')
    setScheduleEditingMessageId(null)
    setSheet('schedule')
  }

  const handleScheduleDraftChange = (patch: Partial<ScheduleDraft>) => {
    setScheduleDraft((current) => ({ ...current, ...patch }))
    setScheduleError('')
  }

  const handleScheduleMessage = async () => {
    if (!activeContact || schedulingMessage) return

    const text = messageTextRef.current.trim()
    if (!text) {
      setScheduleError('Escribe el mensaje que quieres programar.')
      return
    }

    if (draftAttachments.length > 0 || voiceDraft) {
      setScheduleError('Por ahora sólo se pueden programar mensajes escritos.')
      return
    }

    const scheduledDate = getScheduleDateFromDraft(scheduleDraft)
    if (!scheduledDate) {
      setScheduleError('Revisa la fecha y la hora.')
      return
    }

    if (scheduledDate.getTime() < Date.now() + 10 * 1000) {
      setScheduleError('Elige una hora que todavía no haya pasado.')
      return
    }

    let provider: 'highlevel' | 'whatsapp_api' = 'whatsapp_api'
    let channel: HighLevelChatChannel | undefined
    let transport: 'api' | 'qr' = 'api'

    if (sendingThroughHighLevel) {
      provider = 'highlevel'
      channel = activeHighLevelChatChannel
      if (activeHighLevelChannelNeedsPhone && !activeContact.phone) {
        setScheduleError('Este contacto necesita teléfono para programar por este canal.')
        return
      }
    } else {
      if (!activeContact.phone) {
        setScheduleError('Guarda el teléfono del contacto antes de programar.')
        return
      }

      if (!selectedBusinessPhoneValue) {
        setScheduleError('Elige el WhatsApp del negocio que mandará el mensaje.')
        return
      }

      transport = selectedQrReady && (!apiReplyWindowOpen || !whatsappConnected) ? 'qr' : 'api'

      if (transport === 'api' && !whatsappConnected) {
        setScheduleError('Conecta WhatsApp API antes de programar este mensaje.')
        return
      }

      if (!apiReplyWindowOpen && !selectedQrReady) {
        setScheduleError('Para este chat necesitas mandar una plantilla antes de programar un mensaje libre.')
        return
      }

      if (transport === 'qr' && !selectedQrReady) {
        setScheduleError('Conecta el QR de este número antes de programar.')
        return
      }

      const lastInboundTime = new Date(lastInboundForSelectedPhone?.date || '').getTime()
      if (transport === 'api' && !selectedQrReady && Number.isFinite(lastInboundTime) && scheduledDate.getTime() > lastInboundTime + 24 * 60 * 60 * 1000) {
        setScheduleError('Para esa hora WhatsApp ya no dejará responder así. Usa una plantilla o QR.')
        return
      }
    }

    setSchedulingMessage(true)
    setScheduleError('')
    const editingScheduledMessageId = scheduleEditingMessageId

    try {
      const scheduledMessage = await whatsappApiService.scheduleMessage({
        id: editingScheduledMessageId || undefined,
        contactId: activeContact.id,
        provider,
        channel,
        transport: provider === 'whatsapp_api' ? transport : undefined,
        text,
        toPhone: activeContact.phone || undefined,
        fromPhone: selectedBusinessPhoneValue || undefined,
        businessPhoneNumberId: selectedBusinessPhone?.id || undefined,
        scheduledAt: scheduledDate.toISOString(),
        externalId: editingScheduledMessageId || undefined
      })
      const scheduledBubble = getScheduledChatMessageBubble(scheduledMessage)

      setComposerMessageText('')
      setReplyingToMessageId(null)
      if (composerInputRef.current) {
        composerInputRef.current.textContent = ''
      }

      if (scheduledBubble) {
        setMessages((current) => {
          const next = current.filter((message) => message.id !== scheduledBubble.id)
          next.push(scheduledBubble)
          return next.sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())
        })
        setChats((current) => current.map((contact) => (
          contact.id === activeContact.id
            ? {
                ...contact,
                lastMessageText: `Programado: ${text}`,
                lastMessageDate: scheduledBubble.date,
                lastMessageDirection: 'outbound',
                lastMessageChannel: provider === 'highlevel' ? channel : contact.lastMessageChannel,
                messageCount: Number(contact.messageCount || 0) + (editingScheduledMessageId ? 0 : 1)
              }
            : contact
        )))
      }

      setSheet(null)
      setScheduleEditingMessageId(null)
      showToast(
        'success',
        editingScheduledMessageId ? 'Programación actualizada' : 'Mensaje programado',
        formatScheduledMessageLabel(scheduledDate.toISOString())
      )
    } catch (error: any) {
      const errorMessage = getErrorMessage(error, 'No se pudo programar el mensaje.')
      setScheduleError(errorMessage)
      showToast('error', 'No se programó', errorMessage)
    } finally {
      setSchedulingMessage(false)
    }
  }

  const handleSendMessage = async (transport: 'api' | 'qr' = 'api', options: SendMessageOptions = {}) => {
    const textOverride = options.textOverride?.trim()
    const hasTextOverride = Boolean(textOverride)
    const preserveComposer = Boolean(hasTextOverride && options.preserveComposer)
    const text = hasTextOverride ? textOverride || '' : messageTextRef.current.trim()
    const attachmentsToSend = hasTextOverride ? [] : draftAttachments
    const voiceToSend = hasTextOverride ? null : voiceDraft
    if (!activeContact || (!text && attachmentsToSend.length === 0 && !voiceToSend)) return

    if (sendingThroughHighLevel) {
      const requestedChannel = activeHighLevelChatChannel
      const optimisticChannel = effectiveHighLevelChatChannel
      const channelLabel = GHL_CHAT_CHANNEL_LABELS[optimisticChannel]
      const autoSmsFallback = requestedChannel === 'whatsapp_api' && optimisticChannel === 'sms_qr'

      if (!text && !voiceToSend) {
        showToast('warning', 'Escribe o graba algo', 'Manda texto o una nota de voz desde este chat.')
        return
      }

      if (attachmentsToSend.length > 0) {
        showToast('warning', 'Solo texto o voz por ahora', 'HighLevel desde este chat todavía no manda archivos.')
        return
      }

      if ((optimisticChannel === 'whatsapp_api' || optimisticChannel === 'sms_qr') && !activeContact.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribir por este canal.')
        return
      }

      const optimisticId = `local-ghl-${Date.now()}`
      const sentAt = new Date().toISOString()
      const transportLabel = optimisticChannel === 'whatsapp_api'
        ? 'ghl_whatsapp'
        : optimisticChannel === 'sms_qr'
          ? 'ghl_sms'
          : optimisticChannel === 'messenger'
            ? 'ghl_messenger'
            : 'ghl_instagram'

      setComposerStatus('sending')
      if (!preserveComposer) {
        setComposerMessageText('')
        setReplyingToMessageId(null)
        if (composerInputRef.current) {
          composerInputRef.current.textContent = ''
        }
        setDraftAttachments([])
        stopVoicePreview(true)
        voiceSendAfterStopRef.current = false
        setVoiceDraft(null)
      }

      const optimisticMessage: ChatMessage = {
        id: optimisticId,
        text,
        date: sentAt,
        direction: 'outbound',
        status: 'enviando',
        businessPhone: selectedBusinessPhoneValue || '',
        businessPhoneNumberId: selectedBusinessPhone?.id || '',
        transport: transportLabel,
        ...(voiceToSend
          ? {
              attachment: {
                type: 'audio' as const,
                dataUrl: voiceToSend.dataUrl,
                name: voiceToSend.name,
                mimeType: voiceToSend.type,
                durationMs: voiceToSend.durationMs
              }
            }
          : {})
      }

      setMessages((current) => [...current, optimisticMessage])
      setChats((current) => current.map((contact) => (
        contact.id === activeContact.id
          ? {
              ...contact,
              lastMessageText: voiceToSend ? 'Mensaje de voz' : text,
              lastMessageDate: sentAt,
              lastMessageDirection: 'outbound',
              lastMessageChannel: optimisticChannel,
              messageCount: Number(contact.messageCount || 0) + 1
            }
          : contact
      )))

      try {
        const result = await highLevelService.sendConversationMessage({
          contactId: activeContact.id,
          channel: requestedChannel,
          message: text,
          audioDataUrl: voiceToSend?.dataUrl,
          durationMs: voiceToSend?.durationMs,
          fromNumber: selectedBusinessPhoneValue || undefined,
          toNumber: activeContact.phone || undefined,
          externalId: optimisticId
        })
        const resultData = result.data || result
        const resultStatus = String(resultData.status || '').trim() || 'pending'
        const resultDelivered = ['sent', 'delivered', 'read'].includes(resultStatus.toLowerCase())
        const resultFallbackApplied = typeof resultData.fallbackApplied === 'boolean'
          ? resultData.fallbackApplied
          : Boolean(autoSmsFallback || (resultData.requestedChannel === 'whatsapp_api' && resultData.channel === 'sms_qr'))
        const responseAudioUrl = resultData.audio?.link || resultData.audio?.url || resultData.localMedia?.publicUrl || ''
        const responseAudioMimeType = resultData.audio?.mimeType || resultData.localMedia?.mimeType || ''
        const responseAudioDurationMs = Number(resultData.audio?.durationMs || 0) || voiceToSend?.durationMs
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? {
                ...message,
                id: resultData.localMessageId || message.id,
                status: resultStatus,
                transport: resultData.transport || message.transport,
                attachment: message.attachment?.type === 'audio'
                  ? {
                      ...message.attachment,
                      ...(responseAudioUrl ? { url: responseAudioUrl } : {}),
                      ...(responseAudioMimeType ? { mimeType: responseAudioMimeType } : {}),
                      ...(responseAudioDurationMs ? { durationMs: responseAudioDurationMs } : {})
                    }
                  : message.attachment
              }
            : message
        )))
        showToast(
          'success',
          resultFallbackApplied ? 'Se mandó por SMS' : resultDelivered ? 'Mensaje enviado' : 'Mensaje en cola',
          resultFallbackApplied
            ? 'WhatsApp ya estaba fuera de 24 horas, así que Ristak usó el SMS de GoHighLevel.'
            : `${resultDelivered ? 'Se envió' : 'HighLevel lo recibió'} por ${resultData.channelLabel || channelLabel}.`
        )
        await loadConversation(activeContact.id, { silent: true, useCache: false })
        await loadChats({ silent: true, useCache: false })
      } catch (error: any) {
        const errorMessage = getErrorMessage(error, 'Intenta enviar el mensaje otra vez.')
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? { ...message, status: 'error', errorReason: errorMessage }
            : message
        )))
        if (!preserveComposer) {
          setVoiceDraft(voiceToSend)
        }
        if (!preserveComposer && text && !messageTextRef.current.trim() && composerInputRef.current) {
          setComposerMessageText(text)
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

    const optimisticId = `local-${Date.now()}`
    const sentAt = new Date().toISOString()
    setComposerStatus('sending')
    if (!preserveComposer) {
      setComposerMessageText('')
      setReplyingToMessageId(null)
      if (composerInputRef.current) {
        composerInputRef.current.textContent = ''
      }
      setDraftAttachments([])
      stopVoicePreview(true)
      voiceSendAfterStopRef.current = false
      setVoiceDraft(null)
    }
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
          id: `${optimisticId}-attachment-${index}`,
          text: index === 0 ? text : '',
          date: sentAt,
          direction: 'outbound',
          status: 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport: resolvedTransport,
          attachment: {
            type: getDraftAttachmentKind(attachment),
            dataUrl: attachment.dataUrl,
            name: attachment.name,
            mimeType: attachment.type
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
            lastMessageText: voiceToSend ? 'Mensaje de voz' : attachmentsToSend.length > 0 ? (text || getAttachmentPreviewText(attachmentsToSend)) : text,
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
          voice: true,
          externalId: `${optimisticId}-audio`,
          transport: resolvedTransport,
          phoneNumberId: selectedBusinessPhone?.id || undefined
        })
        const responseAudioUrl = result.audio?.link || result.audio?.url || result.localMedia?.publicUrl || ''
        const responseAudioMimeType = result.audio?.mimeType || result.audio?.mimetype || result.localMedia?.mimeType || ''
        const responseAudioDurationMs = Number(result.audio?.durationMs || 0) || voiceToSend.durationMs
        setMessages((current) => current.map((message) => (
          message.id === `${optimisticId}-audio`
            ? {
                ...message,
                status: result.status || 'sent',
                transport: result.transport || message.transport,
                attachment: message.attachment?.type === 'audio'
                  ? {
                      ...message.attachment,
                      ...(responseAudioUrl ? { url: responseAudioUrl } : {}),
                      ...(responseAudioMimeType ? { mimeType: responseAudioMimeType } : {}),
                      durationMs: responseAudioDurationMs
                    }
                  : message.attachment
              }
            : message
        )))
      } else if (attachmentsToSend.length > 0) {
        const results = await Promise.all(attachmentsToSend.map((attachment, index) => (
          getDraftAttachmentKind(attachment) === 'image'
            ? whatsappApiService.sendImage({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                imageDataUrl: attachment.dataUrl,
                caption: index === 0 ? text : '',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: resolvedTransport,
                phoneNumberId: selectedBusinessPhone?.id || undefined
              })
            : whatsappApiService.sendDocument({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                documentDataUrl: attachment.dataUrl,
                filename: attachment.name,
                mimeType: attachment.type,
                caption: index === 0 ? text : '',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: resolvedTransport,
                phoneNumberId: selectedBusinessPhone?.id || undefined
              })
        )))
        setMessages((current) => current.map((message) => (
          message.id.startsWith(`${optimisticId}-attachment-`)
            ? (() => {
                const result = results[Number(message.id.replace(`${optimisticId}-attachment-`, ''))]
                const resultMedia = result?.document || result?.image || null
                const mediaUrl = resultMedia?.link || resultMedia?.url || result?.localMedia?.publicUrl || ''
                const mediaMimeType = resultMedia?.mimeType || resultMedia?.mimetype || result?.localMedia?.mimeType || ''
                const mediaFilename = result?.document?.filename || result?.document?.fileName || result?.localMedia?.filename || ''
                return {
                  ...message,
                  status: result?.status || 'sent',
                  transport: result?.transport || message.transport,
                  attachment: message.attachment
                    ? {
                        ...message.attachment,
                        ...(mediaUrl ? { url: mediaUrl } : {}),
                        ...(mediaMimeType ? { mimeType: mediaMimeType } : {}),
                        ...(mediaFilename ? { name: mediaFilename } : {})
                      }
                    : message.attachment
                }
              })()
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
      await loadConversation(activeContact.id, { silent: true, useCache: false })
      await loadChats({ silent: true, useCache: false })
    } catch (error: any) {
      const errorMessage = getErrorMessage(error, 'Intenta enviar el mensaje otra vez.')
      setMessages((current) => current.map((message) => (
        message.id === optimisticId || message.id === `${optimisticId}-audio` || message.id.startsWith(`${optimisticId}-attachment-`)
          ? { ...message, status: 'error', errorReason: errorMessage }
          : message
      )))
      if (!preserveComposer) {
        setDraftAttachments(attachmentsToSend)
        setVoiceDraft(voiceToSend)
      }
      if (!preserveComposer && text && !messageTextRef.current.trim() && composerInputRef.current) {
        setComposerMessageText(text)
        composerInputRef.current.textContent = text
      }
      showToast('error', 'No se envió el mensaje', errorMessage)
    } finally {
      setComposerStatus('idle')
    }
  }

  useEffect(() => {
    if (!voiceDraft || !voiceSendAfterStopRef.current || voiceRecording || voiceProcessing) return

    voiceSendAfterStopRef.current = false
    handleSendMessage()
  }, [voiceDraft, voiceProcessing, voiceRecording])

  const handleToggleVoicePreview = () => {
    if (!voiceDraft || voiceProcessing) return

    const audio = voiceAudioRef.current
    if (!audio) return

    if (voicePreviewPlaying) {
      audio.pause()
      setVoicePreviewPlaying(false)
      return
    }

    audio.play()
      .then(() => setVoicePreviewPlaying(true))
      .catch(() => {
        showToast('error', 'No se pudo escuchar', 'Toca el audio otra vez. Si sigue igual, revisa que el celular permita reproducir sonido.')
        setVoicePreviewPlaying(false)
      })
  }

  const handleVoicePanelPrimaryAction = () => {
    if (voiceProcessing) return

    if (voiceRecording) {
      handleStopVoiceRecording()
      return
    }

    handleToggleVoicePreview()
  }

  const handleSendVoiceFromPanel = () => {
    if (voiceProcessing) return

    if (voiceRecording) {
      voiceSendAfterStopRef.current = true
      handleStopVoiceRecording()
      return
    }

    if (voiceDraft) {
      handleSendMessage()
    }
  }

  const handleVoiceButtonPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (canSendMessage || voiceRecording || voiceProcessing || voiceDraft) return

    voiceSuppressNextClickRef.current = true
    voicePressStartedAtRef.current = Date.now()
    voicePressShouldStopOnReleaseRef.current = false
    voiceStopAfterStartRef.current = false
    clearVoiceHoldTimer()

    voiceHoldTimerRef.current = window.setTimeout(() => {
      voicePressShouldStopOnReleaseRef.current = true
    }, VOICE_HOLD_TO_PREVIEW_MS)

    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    handleStartVoiceRecording()
  }

  const finishVoiceButtonPress = (event: React.PointerEvent<HTMLButtonElement>) => {
    const pressStartedAt = voicePressStartedAtRef.current
    if (pressStartedAt === null) return

    const heldLongEnough = voicePressShouldStopOnReleaseRef.current || Date.now() - pressStartedAt >= VOICE_HOLD_TO_PREVIEW_MS

    voicePressStartedAtRef.current = null
    voicePressShouldStopOnReleaseRef.current = false
    voiceSuppressNextClickRef.current = true
    clearVoiceHoldTimer()

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (!heldLongEnough) return

    if (voiceRecorderRef.current?.state === 'recording') {
      handleStopVoiceRecording()
      return
    }

    if (voiceStartPendingRef.current) {
      voiceStopAfterStartRef.current = true
    }
  }

  const handleVoiceButtonPointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    finishVoiceButtonPress(event)
  }

  const handleVoiceOrSendButtonClick = () => {
    if (voiceSuppressNextClickRef.current) {
      voiceSuppressNextClickRef.current = false
      return
    }

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
    title: document.title || 'Ristak',
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
    setComposerMessageText(text)
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

  const handleChatSwipeContentTransitionEnd = (contactId: string, event: React.TransitionEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || event.propertyName !== 'transform') return
    if (openSwipeChatId === contactId || draggingSwipe?.contactId === contactId) return
    clearClosingSwipeActions(contactId)
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
    const showSwipeActions = !swipeLocked && (
      isDraggingSwipe ||
      openSwipeChatId === contact.id ||
      closingSwipeChatId === contact.id ||
      swipeOffset > 0
    )
    const swipeActionsInteractive = !swipeLocked && openSwipeChatId === contact.id && !isDraggingSwipe && closingSwipeChatId !== contact.id

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
          <div className={styles.chatSwipeActions} aria-hidden={!swipeActionsInteractive}>
            <button
              type="button"
              className={`${styles.chatSwipeAction} ${styles.chatSwipeMore}`}
              disabled={!swipeActionsInteractive}
              tabIndex={swipeActionsInteractive ? 0 : -1}
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
              disabled={!swipeActionsInteractive}
              tabIndex={swipeActionsInteractive ? 0 : -1}
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
          onTransitionEnd={(event) => handleChatSwipeContentTransitionEnd(contact.id, event)}
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

  const updateMessageAudioPlayback = (messageId: string, audio = messageAudioRefs.current[messageId]) => {
    if (!audio) return

    setMessageAudioPlayback((current) => {
      const previous = current[messageId] || { currentTime: 0, duration: 0 }
      const duration = Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : previous.duration
      const next = {
        currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
        duration
      }

      if (
        Math.abs(previous.currentTime - next.currentTime) < 0.012 &&
        Math.abs(previous.duration - next.duration) < 0.012
      ) {
        return current
      }

      return {
        ...current,
        [messageId]: next
      }
    })
  }

  const stopMessageAudioProgressLoop = (messageId?: string) => {
    if (messageId && messageAudioAnimationMessageIdRef.current !== messageId) return

    if (messageAudioAnimationFrameRef.current === null) return
    window.cancelAnimationFrame(messageAudioAnimationFrameRef.current)
    messageAudioAnimationFrameRef.current = null
    messageAudioAnimationMessageIdRef.current = null
  }

  const startMessageAudioProgressLoop = (messageId: string, audio: HTMLAudioElement) => {
    stopMessageAudioProgressLoop()
    messageAudioAnimationMessageIdRef.current = messageId

    const drawPlayback = () => {
      updateMessageAudioPlayback(messageId, audio)

      if (audio.paused || audio.ended) {
        messageAudioAnimationFrameRef.current = null
        messageAudioAnimationMessageIdRef.current = null
        return
      }

      messageAudioAnimationFrameRef.current = window.requestAnimationFrame(drawPlayback)
    }

    updateMessageAudioPlayback(messageId, audio)
    messageAudioAnimationFrameRef.current = window.requestAnimationFrame(drawPlayback)
  }

  const getMessageAudioDurationMs = (message: ChatMessage) => {
    const storedDuration = Number(message.attachment?.durationMs || 0)
    if (storedDuration > 0) return storedDuration

    const playbackDuration = messageAudioPlayback[message.id]?.duration || 0
    return playbackDuration > 0 ? playbackDuration * 1000 : 0
  }

  const getMessageAudioProgress = (message: ChatMessage) => {
    const playback = messageAudioPlayback[message.id]
    const duration = playback?.duration || (Number(message.attachment?.durationMs || 0) / 1000)
    if (!duration) return 0

    return Math.min(100, Math.max(0, ((playback?.currentTime || 0) / duration) * 100))
  }

  const getMessageAudioRate = (messageId: string): MessageAudioRate => {
    return messageAudioRates[messageId] || MESSAGE_AUDIO_RATE_OPTIONS[0]
  }

  const getNextMessageAudioRate = (rate: MessageAudioRate): MessageAudioRate => {
    const currentIndex = MESSAGE_AUDIO_RATE_OPTIONS.indexOf(rate)
    const nextIndex = currentIndex < 0 ? 1 : (currentIndex + 1) % MESSAGE_AUDIO_RATE_OPTIONS.length

    return MESSAGE_AUDIO_RATE_OPTIONS[nextIndex]
  }

  const formatMessageAudioRate = (rate: MessageAudioRate) => {
    return `${Number.isInteger(rate) ? rate.toFixed(0) : rate}x`
  }

  const handleCycleMessageAudioRate = (message: ChatMessage, event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()

    if (message.direction === 'outbound') return

    const nextRate = getNextMessageAudioRate(getMessageAudioRate(message.id))
    setMessageAudioRates((current) => ({
      ...current,
      [message.id]: nextRate
    }))

    const audio = messageAudioRefs.current[message.id]
    if (audio) audio.playbackRate = nextRate
  }

  const handleToggleMessageAudio = (message: ChatMessage) => {
    const audio = messageAudioRefs.current[message.id] ||
      (typeof document === 'undefined'
        ? null
        : Array.from(document.querySelectorAll<HTMLAudioElement>('[data-message-audio-id]')).find((node) => node.dataset.messageAudioId === message.id) || null)
    if (!audio) return

    if (playingAudioMessageId === message.id && !audio.paused) {
      audio.pause()
      setAudioLoadingMessageId((current) => current === message.id ? null : current)
      stopMessageAudioProgressLoop(message.id)
      updateMessageAudioPlayback(message.id, audio)
      return
    }

    if (voicePreviewPlaying) {
      voiceAudioRef.current?.pause()
      setVoicePreviewPlaying(false)
    }

    if (playingAudioMessageId && playingAudioMessageId !== message.id) {
      messageAudioRefs.current[playingAudioMessageId]?.pause()
    }

    if (audio.ended) audio.currentTime = 0

    audio.playbackRate = getMessageAudioRate(message.id)
    setAudioLoadingMessageId(message.id)

    audio.play()
      .then(() => {
        setPlayingAudioMessageId(message.id)
        setAudioLoadingMessageId(null)
        startMessageAudioProgressLoop(message.id, audio)
        updateMessageAudioPlayback(message.id, audio)
      })
      .catch(() => {
        showToast('error', 'No se pudo escuchar', 'Toca el audio otra vez. Si sigue igual, revisa que el celular permita reproducir sonido.')
        setPlayingAudioMessageId(null)
        setAudioLoadingMessageId((current) => current === message.id ? null : current)
      })
  }

  const renderMessageMeta = (message: ChatMessage, className = styles.messageMeta, options?: { showTransport?: boolean }) => {
    const failed = message.direction === 'outbound' && isMessageFailed(message)
    const scheduled = message.direction === 'outbound' && !failed && isMessageScheduled(message)
    const pending = message.direction === 'outbound' && !failed && !scheduled && isMessagePending(message)
    const receiptStatus = getMessageReceiptStatus(message)
    const receiptLabel = getMessageReceiptLabel(receiptStatus)
    const transportBadge = options?.showTransport === false ? '' : getMessageTransportBadge(message.transport)

    return (
      <span className={className}>
        {transportBadge && <em className={styles.messageTransport}>{transportBadge}</em>}
        {scheduled
          ? `Programado para ${formatMessageTime(message.scheduledAt || message.date)}`
          : formatMessageTime(message.date)}
        {message.direction === 'outbound' && (failed ? (
          <button
            type="button"
            className={styles.messageErrorButton}
            onClick={() => handleShowMessageError(message)}
            aria-label="Ver razón del error"
          >
            <CircleAlert size={15} />
          </button>
        ) : scheduled ? null : pending ? (
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
    )
  }

  const renderMessageAudioAvatar = (imageUrl: string, fallback: string, label: string) => (
    <span className={styles.messageAudioAvatar} aria-label={label}>
      <span className={styles.messageAudioAvatarFallback}>{fallback}</span>
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />
      )}
      <span className={styles.messageAudioMicBadge} aria-hidden="true">
        <FaMicrophone size={19} />
      </span>
    </span>
  )

  const renderMessageAudioWaveform = (message: ChatMessage) => {
    const progress = getMessageAudioProgress(message)

    return (
      <div
        className={styles.messageAudioWaveform}
        style={{ '--audio-progress': `${progress}%` } as React.CSSProperties}
        aria-hidden="true"
      >
        <span className={styles.messageAudioProgressDot} />
        {Array.from({ length: MESSAGE_AUDIO_WAVE_BAR_COUNT }, (_, index) => {
          const baseHeight = VOICE_WAVE_BASE_PATTERN[(index + (message.direction === 'outbound' ? 2 : 0)) % VOICE_WAVE_BASE_PATTERN.length]
          const height = Math.min(18, Math.max(3, Math.round(baseHeight * 0.52)))

          return (
            <span
              key={index}
              className={styles.messageAudioWaveBar}
              style={{
                '--bar-height': `${height}px`
              } as React.CSSProperties}
            />
          )
        })}
      </div>
    )
  }

  const renderAudioMessage = (message: ChatMessage) => {
    const audioSrc = message.attachment?.dataUrl || message.attachment?.url
    if (!audioSrc) return null

    const isOutbound = message.direction === 'outbound'
    const businessPhone = isOutbound ? getBusinessPhoneForMessage(message) : null
    const avatarUrl = isOutbound
      ? getBusinessPhoneProfilePhoto(businessPhone)
      : getContactProfilePhoto(activeContact as ChatContact)
    const avatarFallback = isOutbound
      ? getBusinessPhoneInitials(businessPhone)
      : getContactInitials(activeContact as ChatContact)
    const avatarLabel = isOutbound
      ? `Foto de ${getBusinessPhoneLabel(businessPhone)}`
      : `Foto de ${getContactName(activeContact)}`
    const isPlaying = playingAudioMessageId === message.id
    const isLoading = audioLoadingMessageId === message.id
    const playbackRate = getMessageAudioRate(message.id)
    const showSpeedControl = !isOutbound && (isPlaying || isLoading)

    return (
      <div className={`${styles.messageAudio} ${isOutbound ? styles.messageAudioOutbound : styles.messageAudioInbound}`}>
        <audio
          ref={(node) => {
            messageAudioRefs.current[message.id] = node
          }}
          className={styles.messageAudioNative}
          data-message-audio-id={message.id}
          preload="metadata"
          src={audioSrc}
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = playbackRate
            updateMessageAudioPlayback(message.id, event.currentTarget)
          }}
          onTimeUpdate={(event) => updateMessageAudioPlayback(message.id, event.currentTarget)}
          onWaiting={() => setAudioLoadingMessageId(message.id)}
          onPlay={(event) => {
            setPlayingAudioMessageId(message.id)
            startMessageAudioProgressLoop(message.id, event.currentTarget)
          }}
          onPlaying={(event) => {
            event.currentTarget.playbackRate = playbackRate
            setAudioLoadingMessageId((current) => current === message.id ? null : current)
            setPlayingAudioMessageId(message.id)
            startMessageAudioProgressLoop(message.id, event.currentTarget)
            updateMessageAudioPlayback(message.id, event.currentTarget)
          }}
          onPause={(event) => {
            stopMessageAudioProgressLoop(message.id)
            updateMessageAudioPlayback(message.id, event.currentTarget)
            setPlayingAudioMessageId((current) => current === message.id ? null : current)
            setAudioLoadingMessageId((current) => current === message.id ? null : current)
          }}
          onEnded={(event) => {
            event.currentTarget.currentTime = 0
            stopMessageAudioProgressLoop(message.id)
            updateMessageAudioPlayback(message.id, event.currentTarget)
            setPlayingAudioMessageId((current) => current === message.id ? null : current)
            setAudioLoadingMessageId((current) => current === message.id ? null : current)
          }}
          onError={() => {
            stopMessageAudioProgressLoop(message.id)
            setPlayingAudioMessageId((current) => current === message.id ? null : current)
            setAudioLoadingMessageId((current) => current === message.id ? null : current)
          }}
        />
        {showSpeedControl ? (
          <button
            type="button"
            className={styles.messageAudioSpeedButton}
            onClick={(event) => handleCycleMessageAudioRate(message, event)}
            aria-label={`Cambiar velocidad, ahora ${formatMessageAudioRate(playbackRate)}`}
          >
            {formatMessageAudioRate(playbackRate)}
          </button>
        ) : renderMessageAudioAvatar(avatarUrl, avatarFallback, avatarLabel)}
        <button
          type="button"
          className={styles.messageAudioPlayButton}
          onClick={() => handleToggleMessageAudio(message)}
          aria-label={isLoading ? 'Cargando audio' : isPlaying ? 'Pausar audio' : 'Reproducir audio'}
        >
          {isLoading ? <Loader2 size={19} className={styles.spinIcon} /> : isPlaying ? <Pause size={18} /> : <Play size={20} />}
        </button>
        {renderMessageAudioWaveform(message)}
        <span className={styles.messageAudioDetails}>
          <span className={styles.messageAudioDuration}>{formatVoiceDuration(getMessageAudioDurationMs(message))}</span>
          {renderMessageMeta(message, styles.messageAudioMeta, { showTransport: false })}
        </span>
      </div>
    )
  }

  const renderAudioUnavailableMessage = (message: ChatMessage) => (
    <div className={styles.messageAudioUnavailable}>
      <span className={styles.messageAudioUnavailableIcon} aria-hidden="true">
        <Mic size={17} />
      </span>
      <span className={styles.messageAudioUnavailableText}>
        {message.direction === 'outbound' ? 'Nota de voz enviada' : 'Nota de voz'}
      </span>
    </div>
  )

  const renderMessageFile = (message: ChatMessage) => {
    const attachment = message.attachment
    if (!attachment || !['document', 'file'].includes(attachment.type)) return null

    const fileLabel = attachment.name || getMessageTypeLabel(attachment.type)
    const detail = attachment.mimeType ? getReadableValue(attachment.mimeType) : 'Archivo'
    const fileUrl = attachment.url || attachment.dataUrl
    const content = (
      <>
        <span className={styles.messageFileIcon}>
          <FileText size={20} />
        </span>
        <span className={styles.messageFileText}>
          <strong>{fileLabel}</strong>
          <small>{detail}</small>
        </span>
      </>
    )

    if (fileUrl) {
      return (
        <a className={styles.messageFile} href={fileUrl} target="_blank" rel="noreferrer">
          {content}
        </a>
      )
    }

    return <span className={`${styles.messageFile} ${styles.messageFileUnavailable}`}>{content}</span>
  }

  const renderContactInfoArchiveItem = (item: ContactInfoArchiveItem) => {
    const directionLabel = item.direction === 'outbound' ? 'Enviado por ti' : 'Enviado por el contacto'
    const dateLabel = formatLocalDateShort(item.date)

    if (item.tab === 'media') {
      const media = item.type === 'video'
        ? <video src={item.url || undefined} preload="metadata" muted playsInline />
        : <img src={item.url || undefined} alt={item.title} loading="lazy" />
      const mediaContent = (
        <>
          {item.url ? media : <ImageIcon size={24} />}
          {item.type === 'video' && (
            <span className={styles.contactInfoMediaType}>
              <Play size={12} />
            </span>
          )}
        </>
      )

      return item.url ? (
        <a
          key={item.id}
          className={styles.contactInfoMediaTile}
          href={item.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Abrir ${item.title}`}
        >
          {mediaContent}
        </a>
      ) : (
        <span key={item.id} className={`${styles.contactInfoMediaTile} ${styles.contactInfoMediaTileUnavailable}`}>
          {mediaContent}
        </span>
      )
    }

    const IconComponent = item.tab === 'links' ? Link2 : FileText
    const rowContent = (
      <>
        <span className={styles.contactInfoArchiveIcon}>
          <IconComponent size={18} />
        </span>
        <span className={styles.contactInfoArchiveText}>
          <strong>{item.title}</strong>
          <small>{[directionLabel, dateLabel].filter(Boolean).join(' · ')}</small>
          {item.caption && <em>{item.caption}</em>}
        </span>
        <ChevronRight size={17} className={styles.contactInfoArchiveChevron} />
      </>
    )

    if (item.url) {
      return (
        <a key={item.id} className={styles.contactInfoArchiveRow} href={item.url} target="_blank" rel="noreferrer">
          {rowContent}
        </a>
      )
    }

    return (
      <span key={item.id} className={`${styles.contactInfoArchiveRow} ${styles.contactInfoArchiveRowUnavailable}`}>
        {rowContent}
      </span>
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

  const renderMessageInfoScreen = () => {
    const message = messageInfoMessage
    if (!message) return null

    const isOutbound = message.direction === 'outbound'
    const receiptStatus = getMessageReceiptStatus(message)
    const sentAt = formatLocalDateTime(message.sentAt || message.date)
    const deliveredAt = message.deliveredAt ? formatLocalDateTime(message.deliveredAt) : ''
    const readAt = message.readAt ? formatLocalDateTime(message.readAt) : ''
    const previewText = message.text || (message.attachment ? getMessageTypeLabel(message.attachment.type, 'Mensaje adjunto') : 'Mensaje')
    const previewAttachmentLabel = message.attachment ? getMessageTypeLabel(message.attachment.type, 'Archivo') : ''
    const rows = [
      {
        id: 'sent',
        label: isOutbound ? 'Enviado' : 'Recibido',
        value: sentAt || 'Sin hora guardada',
        Icon: Clock
      }
    ]

    if (isOutbound) {
      rows.push({
        id: 'delivered',
        label: 'Entregado',
        value: deliveredAt || (receiptStatus === 'delivered' || receiptStatus === 'read'
          ? 'Confirmado, sin hora exacta'
          : isMessageFailed(message) ? 'No entregado' : 'Sin confirmación'),
        Icon: Check
      })
      rows.push({
        id: 'read',
        label: 'Leído',
        value: readAt || (receiptStatus === 'read' ? 'Leído, sin hora exacta' : 'Aún no leído'),
        Icon: CheckCheck
      })
    } else {
      rows.push({
        id: 'read',
        label: 'Leído por ti',
        value: readAt || 'Sin registro guardado',
        Icon: CheckCheck
      })
    }

    const errorReason = isMessageFailed(message) ? (message.errorReason || 'No se guardó la razón exacta del error.') : ''

    return (
      <section
        className={`${styles.contactInfoScreen} ${styles.messageInfoScreen} ${messageInfoOpen ? styles.contactInfoScreenOpen : ''}`}
        aria-label="Info del mensaje"
        aria-hidden={!messageInfoOpen}
      >
        <header className={styles.contactInfoTopbar}>
          <button type="button" className={styles.backButton} onClick={closeMessageInfo} aria-label="Volver al chat">
            <ChevronLeft size={32} />
          </button>
          <strong>Info del mensaje</strong>
          <span className={styles.contactInfoTopbarSpacer} aria-hidden="true" />
        </header>

        <div className={styles.messageInfoContent} data-phone-chat-scrollable="true">
          <section className={styles.messageInfoPreview} aria-label="Mensaje seleccionado">
            <div className={`${styles.messageInfoPreviewRow} ${isOutbound ? styles.messageInfoPreviewRowOutbound : styles.messageInfoPreviewRowInbound}`}>
              <div className={`${styles.messageBubble} ${styles.messageInfoPreviewBubble}`}>
                {previewAttachmentLabel && (
                  <span className={styles.messageInfoAttachmentTag}>
                    <FileText size={14} />
                    {previewAttachmentLabel}
                  </span>
                )}
                <p>{previewText}</p>
                {renderMessageMeta(message)}
              </div>
            </div>
          </section>

          <section className={styles.messageInfoRows} aria-label="Registro del mensaje">
            {rows.map(({ id, label, value, Icon: RowIcon }) => (
              <div key={id} className={styles.messageInfoRow}>
                <span className={styles.messageInfoRowIcon} aria-hidden="true">
                  <RowIcon size={18} />
                </span>
                <span className={styles.messageInfoRowText}>
                  <strong>{label}</strong>
                  <small>{value}</small>
                </span>
              </div>
            ))}
            {errorReason && (
              <div className={`${styles.messageInfoRow} ${styles.messageInfoRowDanger}`}>
                <span className={styles.messageInfoRowIcon} aria-hidden="true">
                  <CircleAlert size={18} />
                </span>
                <span className={styles.messageInfoRowText}>
                  <strong>Error</strong>
                  <small>{errorReason}</small>
                </span>
              </div>
            )}
          </section>
        </div>
      </section>
    )
  }

  const renderReplyPreviewBar = () => {
    if (!replyingToMessage) return null

    const replyText = getMessageActionText(replyingToMessage) || 'Mensaje'

    return (
      <div className={styles.replyPreviewBar} aria-label="Mensaje que vas a responder">
        <span className={styles.replyPreviewIcon} aria-hidden="true">
          <Reply size={16} />
        </span>
        <span className={styles.replyPreviewText}>
          <strong>Respondiendo</strong>
          <small>{replyText}</small>
        </span>
        <button type="button" onClick={() => setReplyingToMessageId(null)} aria-label="Quitar respuesta">
          <X size={16} />
        </button>
      </div>
    )
  }

  const renderMessageActionPreviewContent = (message: ChatMessage) => {
    const isAudioAttachment = message.attachment?.type === 'audio'
    const isVideoMessage = message.attachment?.type === 'video' && Boolean(message.attachment.dataUrl || message.attachment.url)
    const isFileMessage = Boolean(message.attachment && ['document', 'file'].includes(message.attachment.type))
    const hasRichAttachment = isAudioAttachment || isVideoMessage || isFileMessage || message.attachment?.type === 'image'
    const starred = starredMessageIdSet.has(message.id)

    return (
      <>
        {message.attachment?.type === 'image' && (message.attachment.dataUrl || message.attachment.url) && (
          <img className={styles.messageImage} src={message.attachment.dataUrl || message.attachment.url} alt={message.attachment.name || 'Foto enviada'} />
        )}
        {isVideoMessage && (
          <span className={styles.messageActionAttachmentPreview}>
            <Video size={17} />
            Video
          </span>
        )}
        {isFileMessage && (
          <span className={styles.messageActionAttachmentPreview}>
            <FileText size={17} />
            {getMessageAttachmentActionLabel(message)}
          </span>
        )}
        {isAudioAttachment && (
          <span className={styles.messageActionAttachmentPreview}>
            <FaMicrophone size={14} />
            Mensaje de voz
          </span>
        )}
        {!hasRichAttachment && message.text && <p>{message.text}</p>}
        {hasRichAttachment && message.text && <p>{message.text}</p>}
        <span className={styles.messageActionPreviewMeta}>
          {starred && (
            <span className={styles.messageStarBadge} aria-label="Mensaje destacado">
              <Star size={12} fill="currentColor" />
            </span>
          )}
          {renderMessageMeta(message, styles.messageMeta, { showTransport: false })}
        </span>
      </>
    )
  }

  const renderMessageActionMenu = () => {
    if (!messageActionMenu || !messageActionMenuMessage) return null

    const message = messageActionMenuMessage
    const scheduled = message.direction === 'outbound' && isMessageScheduled(message)
    const starred = starredMessageIdSet.has(message.id)
    const scheduledMessageId = scheduled ? getScheduledMessageActionId(message) : ''
    const deletingScheduled = Boolean(scheduledMessageId && cancelingScheduledMessageId === scheduledMessageId)
    const overlayStyle = {
      '--message-action-top': `${messageActionMenu.rect.top}px`,
      '--message-action-left': `${messageActionMenu.rect.left}px`,
      '--message-action-width': `${messageActionMenu.rect.width}px`,
      '--message-action-bubble-width': `${messageActionMenu.rect.bubbleWidth}px`
    } as React.CSSProperties
    const previewClassName = [
      styles.messageActionPreviewBubble,
      styles.messageBubble,
      message.direction === 'outbound' ? styles.messageActionPreviewOutbound : '',
      scheduled ? styles.messageBubbleScheduled : '',
      message.attachment?.type === 'audio' ? styles.messageAudioBubble : '',
      message.attachment && ['document', 'file'].includes(message.attachment.type) ? styles.messageFileBubble : ''
    ].filter(Boolean).join(' ')

    return (
      <div className={styles.messageActionOverlay} style={overlayStyle} role="presentation">
        <button
          type="button"
          className={styles.messageActionBackdrop}
          onClick={closeMessageActionMenu}
          aria-label="Cerrar acciones del mensaje"
        />
        <div
          className={`${styles.messageActionContent} ${messageActionMenu.placement === 'above' ? styles.messageActionContentAbove : ''} ${messageActionMenu.align === 'end' ? styles.messageActionContentAlignEnd : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={scheduled ? 'Acciones de mensaje programado' : 'Acciones del mensaje'}
        >
          <div className={previewClassName}>
            {renderMessageActionPreviewContent(message)}
          </div>

          <div className={styles.messageActionMenu}>
            {scheduled ? (
              <>
                <button type="button" onClick={() => handleEditScheduledMessage(message)}>
                  <Pencil size={18} />
                  Editar programación
                </button>
                <button
                  type="button"
                  className={styles.messageActionDanger}
                  onClick={() => handleCancelScheduledMessage(message)}
                  disabled={deletingScheduled}
                >
                  {deletingScheduled ? <Loader2 size={18} className={styles.spinIcon} /> : <Trash2 size={18} />}
                  Eliminar mensaje programado
                </button>
              </>
            ) : messageActionMenu.mode === 'more' ? (
              <>
                <button type="button" onClick={() => handleUnavailableMessageAction('Fijar')}>
                  <Pin size={18} />
                  Fijar
                </button>
                <button type="button" onClick={() => handleUnavailableMessageAction('Traducir')}>
                  <Languages size={18} />
                  Traducir
                </button>
                <button type="button" className={styles.messageActionDanger} onClick={() => handleUnavailableMessageAction('Eliminar')}>
                  <Trash2 size={18} />
                  Eliminar
                </button>
                <span className={styles.messageActionDivider} aria-hidden="true" />
                <button type="button" onClick={() => setMessageActionMenu((current) => current ? { ...current, mode: 'main' } : current)}>
                  <MoreHorizontal size={18} />
                  Más
                </button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => handleReplyMessage(message)}>
                  <Reply size={18} />
                  Responder
                </button>
                <button type="button" onClick={handleForwardMessage}>
                  <Forward size={18} />
                  Reenviar
                </button>
                <button type="button" onClick={() => handleCopyMessage(message)}>
                  <Copy size={18} />
                  Copiar
                </button>
                <button type="button" onClick={() => handleToggleStarMessage(message)}>
                  <Star size={18} fill={starred ? 'currentColor' : 'none'} />
                  {starred ? 'Quitar destacado' : 'Destacar'}
                </button>
                <button type="button" onClick={() => setMessageActionMenu((current) => current ? { ...current, mode: 'more' } : current)}>
                  <MoreHorizontal size={18} />
                  Más
                </button>
                <button type="button" className={styles.messageActionDanger} onClick={() => handleUnavailableMessageAction('Eliminar')}>
                  <Trash2 size={18} />
                  Eliminar
                </button>
              </>
            )}
          </div>
        </div>
      </div>
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
                <span className={styles.messageMeta}>{formatMessageTime(message.createdAt)}</span>
              </div>
            </div>
          ))}
          {aiSending && (
            <div className={`${styles.messageRow} ${styles.messageRow_inbound}`}>
              <div className={`${styles.messageBubble} ${styles.aiMessageBubble}`}>
                <p>Pensando...</p>
                <span className={styles.messageMeta}><Loader2 size={13} className={styles.spinIcon} /></span>
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
        {conversationMessageGroups.map((group) => (
          <section key={`day-${group.key}`} className={styles.messageDayGroup} data-message-day-key={group.key}>
            {group.label && (
              <div className={styles.messageDaySeparator}>
                <span>{group.label}</span>
              </div>
            )}
            {group.messages.map((message) => {
              const isAudioAttachment = message.attachment?.type === 'audio'
              const isAudioMessage = isAudioAttachment && Boolean(message.attachment?.dataUrl || message.attachment?.url)
              const isVideoMessage = message.attachment?.type === 'video' && Boolean(message.attachment.dataUrl || message.attachment.url)
              const isFileMessage = Boolean(message.attachment && ['document', 'file'].includes(message.attachment.type))
              const hasRichAttachment = isAudioAttachment || isVideoMessage || isFileMessage
              const messageSwipeOffset = draggingMessageInfoSwipe?.messageId === message.id ? draggingMessageInfoSwipe.offset : 0
              const canOpenMessageInfo = message.direction !== 'system'
              const scheduled = message.direction === 'outbound' && isMessageScheduled(message)
              const scheduledCountdown = scheduled ? formatScheduledCountdown(message.scheduledAt, scheduledCountdownNow) : ''

              return (
                <div
                  key={message.id}
                  className={`${styles.messageRow} ${styles[`messageRow_${message.direction}`]}`}
                >
                  <div className={`${styles.messageSwipeWrap} ${scheduled ? styles.messageSwipeWrapScheduled : ''} ${messageSwipeOffset > 0 ? styles.messageSwipeWrapActive : ''}`}>
                    {scheduled && (
                      <span
                        className={styles.messageScheduleTimer}
                        aria-label={scheduledCountdown ? `Mensaje programado, falta ${scheduledCountdown}` : 'Mensaje programado'}
                      >
                        <Clock size={18} />
                        {scheduledCountdown && <small>{scheduledCountdown}</small>}
                      </span>
                    )}
                    <span className={styles.messageInfoSwipeCue} aria-hidden="true">
                      <ReceiptText size={17} />
                    </span>
                    <div
                      className={`${styles.messageBubble} ${styles.messageBubbleActionTarget} ${scheduled ? styles.messageBubbleScheduled : ''} ${isAudioMessage ? styles.messageAudioBubble : ''} ${isFileMessage ? styles.messageFileBubble : ''} ${messageSwipeOffset > 0 ? styles.messageBubbleSwipeDragging : ''}`}
                      data-chat-message-id={message.id}
                      style={messageSwipeOffset > 0 ? { transform: `translate3d(-${messageSwipeOffset}px, 0, 0)` } : undefined}
                      onPointerDown={canOpenMessageInfo ? (event) => handleMessageActionPointerDown(message, event) : undefined}
                      onPointerMove={canOpenMessageInfo ? handleMessageActionPointerMove : undefined}
                      onPointerUp={canOpenMessageInfo ? handleMessageActionPointerEnd : undefined}
                      onPointerCancel={canOpenMessageInfo ? handleMessageActionPointerEnd : undefined}
                      onContextMenu={canOpenMessageInfo ? (event) => handleMessageActionContextMenu(message, event) : undefined}
                      onTouchStart={canOpenMessageInfo ? (event) => handleMessageInfoTouchStart(message, event) : undefined}
                      onTouchMove={canOpenMessageInfo ? handleMessageInfoTouchMove : undefined}
                      onTouchEnd={canOpenMessageInfo ? handleMessageInfoTouchEnd : undefined}
                      onTouchCancel={canOpenMessageInfo ? handleMessageInfoTouchEnd : undefined}
                    >
                    {message.attachment?.type === 'image' && (message.attachment.dataUrl || message.attachment.url) && (
                      <img className={styles.messageImage} src={message.attachment.dataUrl || message.attachment.url} alt={message.attachment.name || 'Foto enviada'} />
                    )}
                    {isVideoMessage && (
                      <video
                        className={styles.messageVideo}
                        src={message.attachment?.dataUrl || message.attachment?.url}
                        controls
                        playsInline
                        preload="metadata"
                      />
                    )}
                    {isFileMessage && renderMessageFile(message)}
                    {isAudioMessage && renderAudioMessage(message)}
                    {isAudioAttachment && !isAudioMessage && renderAudioUnavailableMessage(message)}
                    {!hasRichAttachment && message.text && <p>{message.text}</p>}
                    {hasRichAttachment && !isAudioMessage && message.text && <p>{message.text}</p>}
                    {starredMessageIdSet.has(message.id) && (
                      <span className={styles.messageStarBadge} aria-label="Mensaje destacado">
                        <Star size={12} fill="currentColor" />
                      </span>
                    )}
                    {!isAudioMessage && renderMessageMeta(message)}
                    </div>
                  </div>
                </div>
              )
            })}
          </section>
        ))}
      </>
    )
  }

  const renderDraftAttachments = () => {
    if (draftAttachments.length === 0) return null

    return (
      <div className={styles.draftAttachments} data-phone-chat-scrollable="true">
        {draftAttachments.map((attachment) => (
          <figure key={attachment.id} className={`${styles.draftAttachment} ${attachment.attachmentType !== 'image' ? styles.draftAttachmentFile : ''}`}>
            {attachment.attachmentType === 'image' ? (
              <img src={attachment.dataUrl} alt={attachment.name || 'Foto lista'} />
            ) : (
              <span className={styles.draftAttachmentFileContent}>
                <FileText size={21} />
                <strong>{attachment.name || 'Documento'}</strong>
                <small>{formatAttachmentSize(attachment.size)}</small>
              </span>
            )}
            <button type="button" onClick={() => removeDraftAttachment(attachment.id)} aria-label={attachment.attachmentType === 'image' ? 'Quitar foto' : 'Quitar documento'}>
              <X size={15} />
            </button>
          </figure>
        ))}
      </div>
    )
  }

  const renderVoiceWaveform = () => (
    <div
      className={`${styles.voiceComposerWaveform} ${voiceRecording ? styles.voiceComposerWaveformRecording : ''} ${voicePreviewPlaying ? styles.voiceComposerWaveformPlaying : ''}`}
      aria-hidden="true"
    >
      {voiceWaveBars.map((height, index) => (
        <span
          key={`voice-composer-bar-${index}`}
          className={styles.voiceComposerWaveBar}
          style={{
            '--voice-bar-height': `${height}px`
          } as React.CSSProperties}
        />
      ))}
    </div>
  )

  const renderVoiceComposerPanel = () => {
    if (!voicePanelActive) return null

    const primaryLabel = voiceRecording
      ? 'Pausar grabación'
      : voicePreviewPlaying
        ? 'Pausar audio'
        : 'Escuchar audio'
    const PrimaryIcon = voiceProcessing
      ? Loader2
      : voiceRecording || voicePreviewPlaying
        ? Pause
        : Play

    return (
      <div
        className={`${styles.voiceComposerPanel} ${voiceRecording ? styles.voiceComposerPanelRecording : ''} ${voiceProcessing ? styles.voiceComposerPanelProcessing : ''}`}
        aria-label="Grabación de audio"
      >
        <div className={styles.voiceComposerTrack}>
          <span className={styles.voiceComposerTime}>
            {formatVoiceDuration(voiceDraft?.durationMs || voiceElapsedMs)}
          </span>
          {renderVoiceWaveform()}
          {voiceDraft && (
            <audio
              ref={voiceAudioRef}
              className={styles.voicePreviewAudio}
              preload="metadata"
              src={voiceDraft.dataUrl}
              onEnded={() => setVoicePreviewPlaying(false)}
              onPause={() => setVoicePreviewPlaying(false)}
              onPlay={() => setVoicePreviewPlaying(true)}
            />
          )}
        </div>
        <div className={styles.voiceComposerActions}>
          <button
            type="button"
            className={`${styles.voiceComposerButton} ${styles.voiceDeleteButton}`}
            onClick={handleCancelVoiceDraft}
            disabled={voiceProcessing}
            aria-label={voiceRecording ? 'Eliminar grabación' : 'Eliminar audio'}
          >
            <Trash2 size={24} />
          </button>
          <button
            type="button"
            className={`${styles.voiceComposerButton} ${styles.voicePauseButton}`}
            onClick={handleVoicePanelPrimaryAction}
            disabled={voiceProcessing}
            aria-label={primaryLabel}
          >
            <PrimaryIcon size={voiceProcessing ? 19 : voiceRecording || voicePreviewPlaying ? 22 : 20} className={voiceProcessing ? styles.spinIcon : undefined} />
          </button>
          <button
            type="button"
            className={`${styles.voiceComposerButton} ${styles.voiceSendAudioButton}`}
            onClick={handleSendVoiceFromPanel}
            disabled={voiceProcessing}
            aria-label="Enviar audio"
          >
            {voiceProcessing ? <Loader2 size={18} className={styles.spinIcon} /> : <ArrowRight size={18} />}
          </button>
        </div>
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
      const effectiveOption = GHL_CHAT_CHANNEL_OPTIONS.find((option) => option.id === effectiveHighLevelChatChannel)

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
            {highLevelWhatsAppFallsBackToSms
              ? 'Fuera de 24 h: se mandará por SMS de GoHighLevel.'
              : effectiveOption?.hint || activeOption?.hint || 'Sale por la cuenta conectada.'}
          </span>
        </div>
      )
    }

    if (!outsideReplyWindow || !selectedQrReady) return null

    return (
      <div className={`${styles.senderBar} ${styles.replyWindowSenderBar}`}>
        <span className={styles.replyWindowNotice}>
          <Clock size={12} />
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
        {aiSending ? <Loader2 size={18} className={styles.spinIcon} /> : <Send size={18} />}
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

  const renderCustomFieldInput = (customField: ContactInfoCustomFieldView) => {
    const draftValue = customFieldDrafts[customField.id] ?? customField.editValue
    const options = getCustomFieldOptionItems(customField.options || [])
    const dataType = String(customField.dataType || '').toLowerCase()
    const commonProps = {
      value: draftValue,
      disabled: savingCustomFieldId === customField.id,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        setCustomFieldDrafts((current) => ({
          ...current,
          [customField.id]: event.target.value
        }))
      }
    }

    if (options.length > 0) {
      return (
        <select {...commonProps} aria-label={customField.label}>
          <option value="">Sin dato</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      )
    }

    if (['boolean', 'checkbox'].includes(dataType)) {
      return (
        <select {...commonProps} aria-label={customField.label}>
          <option value="">Sin dato</option>
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>
      )
    }

    if (dataType === 'textarea') {
      return <textarea {...commonProps} rows={3} aria-label={customField.label} />
    }

    return (
      <input
        {...commonProps}
        type={getContactInfoCustomFieldInputType(customField.dataType)}
        inputMode={['number', 'currency'].includes(dataType) ? 'decimal' : undefined}
        aria-label={customField.label}
      />
    )
  }

  const renderContactInfoCustomFieldRow = (customField: ContactInfoCustomFieldView) => {
    const isEditing = editingCustomFieldId === customField.id
    const isSaving = savingCustomFieldId === customField.id

    if (isEditing) {
      return (
        <form
          key={customField.id}
          className={`${styles.contactInfoEditableRow} ${styles.contactInfoCustomFieldEditing}`}
          onSubmit={(event) => {
            event.preventDefault()
            void handleSaveCustomField(customField)
          }}
        >
          <span className={styles.contactInfoRowIcon}><FileText size={17} /></span>
          <div className={styles.contactInfoCustomFieldEditor}>
            <small>{customField.label}</small>
            <span className={styles.contactInfoCustomFieldControl}>
              {renderCustomFieldInput(customField)}
              <button type="submit" className={styles.contactInfoCustomFieldSaveButton} disabled={isSaving} aria-label={`Guardar ${customField.label}`}>
                {isSaving ? <Loader2 size={16} className={styles.spinIcon} /> : <Check size={16} />}
              </button>
            </span>
          </div>
          <span className={styles.contactInfoCustomFieldActions}>
            <button type="button" disabled={isSaving} onClick={() => handleCancelCustomFieldEdit(customField.id)} aria-label={`Cancelar ${customField.label}`}>
              <X size={16} />
            </button>
          </span>
        </form>
      )
    }

    return (
      <div key={customField.id} className={styles.contactInfoEditableRow}>
        <span className={styles.contactInfoRowIcon}><FileText size={17} /></span>
        <button type="button" className={styles.contactInfoEditableText} onClick={() => handleStartCustomFieldEdit(customField)}>
          <small>{customField.label}</small>
          <strong>{customField.value || 'Sin dato'}</strong>
        </button>
        <button type="button" className={styles.contactInfoEditButton} onClick={() => handleStartCustomFieldEdit(customField)} aria-label={`Editar ${customField.label}`}>
          <Pencil size={15} />
        </button>
      </div>
    )
  }

  const renderContactInfoScreen = () => {
    if (!contactInfoData) return null

    const revenueTotal = contactInfoSuccessfulPayments.reduce((sum, payment) => sum + payment.amount, 0)
    const paymentsCount = contactInfoPayments.length || Number(contactInfoData.purchases || 0) || contactInfoSuccessfulPayments.length
    const nextAppointment = contactInfoActiveAppointments.find((appointment) => Date.parse(appointment.startTime) >= Date.now()) || contactInfoActiveAppointments[0]
    const firstSuccessfulPayment = [...contactInfoSuccessfulPayments]
      .sort((left, right) => Date.parse(left.date) - Date.parse(right.date))[0]
    const firstAppointment = contactInfoAppointments[0]
    const leadEvent = contactJourney.find((event) => event.type === 'contact_created')
    const leadDate = leadEvent?.date || contactInfoData.createdAt
    const leadSource = getReadableValue(leadEvent?.data?.source) || contactInfoSource
    const contactInfoChannel = getHighLevelChatChannelLabel((contactInfoData as ChatContact).lastMessageChannel)
    const integrationName = contactInfoChannel || leadSource || contactInfoSource || 'Sin integración guardada'
    const rawIntegrationProvider = contactInfoChannel
      ? 'HighLevel'
      : getReadableValue(contactInfoData.whatsappAttributionPlatform || contactInfoTracking.source_platform || contactInfoTracking.site_source_name)
    const integrationProvider = rawIntegrationProvider && rawIntegrationProvider !== integrationName ? rawIntegrationProvider : ''
    const integrationOrigin = contactInfoSource && contactInfoSource !== integrationName ? contactInfoSource : ''
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
    const archiveTabs: Array<{ id: ContactInfoArchiveTab; label: string; count: number }> = [
      { id: 'media', label: 'Fotos y videos', count: contactInfoArchiveCounts.media },
      { id: 'documents', label: 'Documentos', count: contactInfoArchiveCounts.documents },
      { id: 'links', label: 'Enlaces', count: contactInfoArchiveCounts.links }
    ]
    const archiveEmptyText = contactInfoArchiveTab === 'media'
      ? 'Aún no hay fotos ni videos guardados en este chat.'
      : contactInfoArchiveTab === 'links'
        ? 'Aún no hay enlaces compartidos en este chat.'
        : 'Aún no hay documentos compartidos en este chat.'
    const archiveSummaryParts = [
      contactInfoArchiveCounts.media > 0 ? `${contactInfoArchiveCounts.media} fotos/videos` : '',
      contactInfoArchiveCounts.documents > 0 ? `${contactInfoArchiveCounts.documents} documentos` : '',
      contactInfoArchiveCounts.links > 0 ? `${contactInfoArchiveCounts.links} enlaces` : ''
    ].filter(Boolean)
    const archiveSummary = archiveSummaryParts.join(' · ') || 'Aún no hay archivos guardados'

    if (contactInfoArchiveOpen) {
      return (
        <section
          className={`${styles.contactInfoScreen} ${contactInfoOpen ? styles.contactInfoScreenOpen : ''}`}
          aria-label="Archivos del chat"
          aria-hidden={!contactInfoOpen}
        >
          <header className={styles.contactInfoTopbar}>
            <button type="button" className={styles.backButton} onClick={() => setContactInfoArchiveOpen(false)} aria-label="Volver a info del contacto">
              <ChevronLeft size={32} />
            </button>
            <strong>Archivos del chat</strong>
            <span className={styles.contactInfoTopbarSpacer} aria-hidden="true" />
          </header>

          <div className={`${styles.contactInfoContent} ${styles.contactInfoArchiveDetailContent}`} data-phone-chat-scrollable="true">
            <section className={styles.contactInfoArchiveDetailSection}>
              <div className={styles.contactInfoArchiveTabs} role="tablist" aria-label="Archivos enviados en el chat">
                {archiveTabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    role="tab"
                    aria-selected={contactInfoArchiveTab === tab.id}
                    className={contactInfoArchiveTab === tab.id ? styles.contactInfoArchiveTabActive : ''}
                    onClick={() => setContactInfoArchiveTab(tab.id)}
                  >
                    <span>{tab.label}</span>
                    <small>{tab.count}</small>
                  </button>
                ))}
              </div>
              {contactInfoVisibleArchiveItems.length > 0 ? (
                contactInfoArchiveTab === 'media' ? (
                  <div className={styles.contactInfoMediaGrid}>
                    {contactInfoVisibleArchiveItems.map(renderContactInfoArchiveItem)}
                  </div>
                ) : (
                  <div className={styles.contactInfoArchiveList}>
                    {contactInfoVisibleArchiveItems.map(renderContactInfoArchiveItem)}
                  </div>
                )
              ) : (
                <p className={styles.contactInfoDetailEmpty}>{archiveEmptyText}</p>
              )}
            </section>
          </div>
        </section>
      )
    }

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

          <section className={styles.contactInfoSection}>
            <div className={styles.contactInfoMetrics} role="group" aria-label="Resumen del contacto">
              <button
                type="button"
                className={`${styles.contactInfoMetricCard} ${contactInfoDetailPanel === 'payments' ? styles.contactInfoMetricCardActive : ''}`}
                onClick={() => setContactInfoDetailPanel((current) => current === 'payments' ? null : 'payments')}
                aria-expanded={contactInfoDetailPanel === 'payments'}
              >
                <span className={styles.contactInfoMetricTitle}>Total</span>
                <strong>{formatCurrency(Number(contactInfoData.ltv || 0) || revenueTotal)}</strong>
                <em>{paymentsCount} pago{paymentsCount === 1 ? '' : 's'}</em>
                <span className={styles.contactInfoMetricAction}>
                  {contactInfoDetailPanel === 'payments' ? 'Ocultar' : 'Ver'}
                  <ChevronRight size={15} />
                </span>
              </button>

              <button
                type="button"
                className={`${styles.contactInfoMetricCard} ${contactInfoDetailPanel === 'appointments' ? styles.contactInfoMetricCardActive : ''}`}
                onClick={() => setContactInfoDetailPanel((current) => current === 'appointments' ? null : 'appointments')}
                aria-expanded={contactInfoDetailPanel === 'appointments'}
              >
                <span className={styles.contactInfoMetricTitle}>Citas</span>
                <strong>{contactInfoAppointments.length}</strong>
                <em>{contactInfoActiveAppointments.length} activa{contactInfoActiveAppointments.length === 1 ? '' : 's'}</em>
                <span className={styles.contactInfoMetricAction}>
                  {contactInfoDetailPanel === 'appointments' ? 'Ocultar' : 'Ver'}
                  <ChevronRight size={15} />
                </span>
              </button>
            </div>

            {contactInfoDetailPanel === 'payments' && (
              <div className={styles.contactInfoDetailPanel}>
                <h3>Pagos realizados</h3>
                {contactInfoPayments.length > 0 ? (
                  <div className={styles.contactInfoRows}>
                    {contactInfoPayments.map((payment) => renderContactInfoRow(
                      `payment-detail-${payment.id}`,
                      <CreditCard size={17} />,
                      formatLocalDateShort(payment.date),
                      formatCurrency(payment.amount),
                      formatPlainStatus(payment.status)
                    ))}
                  </div>
                ) : (
                  <p className={styles.contactInfoDetailEmpty}>
                    {paymentsCount > 0
                      ? `Hay ${paymentsCount} pago${paymentsCount === 1 ? '' : 's'} registrado${paymentsCount === 1 ? '' : 's'}, pero todavía no se cargó el detalle.`
                      : 'Aún no hay pagos guardados para este contacto.'}
                  </p>
                )}
              </div>
            )}

            {contactInfoDetailPanel === 'appointments' && (
              <div className={styles.contactInfoDetailPanel}>
                <h3>Historial de citas</h3>
                {contactInfoAppointments.length > 0 ? (
                  <div className={styles.contactInfoRows}>
                    {contactInfoAppointments.map((appointment) => renderContactInfoRow(
                      `appointment-detail-${appointment.id}`,
                      <CalendarDays size={17} />,
                      appointment.title,
                      formatLocalDateTime(appointment.startTime),
                      formatPlainStatus(appointment.status)
                    ))}
                  </div>
                ) : (
                  <p className={styles.contactInfoDetailEmpty}>Aún no hay citas guardadas para este contacto.</p>
                )}
              </div>
            )}
          </section>

          <section className={`${styles.contactInfoSection} ${styles.contactInfoArchiveSection}`}>
            <button
              type="button"
              className={styles.contactInfoArchiveSummaryButton}
              onClick={() => {
                setContactInfoArchiveTab('media')
                setContactInfoArchiveOpen(true)
              }}
            >
              <span className={styles.contactInfoArchiveSummaryIcon}>
                <ImageIcon size={18} />
              </span>
              <span className={styles.contactInfoArchiveSummaryText}>
                <strong>Archivos del chat</strong>
                <small>{archiveSummary}</small>
              </span>
              <span className={styles.contactInfoArchiveSummaryAction}>
                Ver más
                <ChevronRight size={16} />
              </span>
            </button>
          </section>

          <section className={styles.contactInfoSection}>
            <h3>Datos principales</h3>
            <div className={styles.contactInfoRows}>
              {renderContactInfoRow('phone', <Phone size={17} />, 'Número', contactInfoData.phone)}
              {renderContactInfoRow('email', <Mail size={17} />, 'Correo', contactInfoData.email)}
              {renderContactInfoRow('created', <User size={17} />, 'Contacto creado', formatLocalDateTime(leadDate))}
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

          {contactInfoCustomFields.length > 0 && (
            <section className={styles.contactInfoSection}>
              <h3>Campos personalizados</h3>
              <div className={styles.contactInfoRows}>
                {contactInfoCustomFields.map(renderContactInfoCustomFieldRow)}
              </div>
            </section>
          )}

          <section className={styles.contactInfoSection}>
            <h3>Integración</h3>
            <div className={styles.contactInfoRows}>
              {renderContactInfoRow('integration-channel', <Globe2 size={17} />, 'Canal', integrationName, integrationProvider)}
              {renderContactInfoRow('integration-origin', <MousePointerClick size={17} />, 'Origen', integrationOrigin)}
            </div>
          </section>

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

    if (activeSettingsSection === 'display') {
      return renderSettingsDetail('Vista de tableta', (
        <section className={styles.settingsSection}>
          <div className={styles.settingsSectionTitle}>
            <Globe2 size={18} />
            <span>
              <strong>Vista web</strong>
              <small>Regresa al panel completo de Ristak en esta tablet.</small>
            </span>
          </div>
          <button type="button" className={styles.settingsRefreshButton} onClick={handleSwitchToWebView}>
            <Globe2 size={16} />
            Cambiar a vista web
          </button>
          <p className={styles.settingsHint}>
            Esta opción sólo aparece en tablet. En celular se mantiene la vista móvil.
          </p>
        </section>
      ))
    }

    const settingsItems: Array<{
      id: Exclude<ChatSettingsSection, null>
      title: string
      description: string
      meta?: string
      Icon: React.ElementType
    }> = [
      ...(deviceMode === 'tablet'
        ? [{
            id: 'display' as const,
            title: 'Vista de tableta',
            description: 'Regresar al panel completo.',
            meta: 'Tableta',
            Icon: Globe2
          }]
        : []),
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

  const renderClabeSheet = () => (
    <div className={styles.clabeStack} data-bottom-sheet-scrollable="true">
      <div className={styles.clabeActionsBar}>
        <span>{savedBankClabes.length} guardada{savedBankClabes.length === 1 ? '' : 's'}</span>
        <button type="button" onClick={() => setClabeFormOpen((current) => !current)}>
          <Plus size={16} />
          Agregar
        </button>
      </div>

      {clabeFormOpen && (
        <div className={styles.clabeForm}>
          <label>
            <span>Nombre</span>
            <input
              value={clabeDraft.alias}
              onChange={(event) => setClabeDraft((current) => ({ ...current, alias: event.target.value }))}
              placeholder="Cuenta principal"
              disabled={savingBankClabes}
            />
          </label>
          <label>
            <span>CLABE</span>
            <input
              value={formatClabe(clabeDraft.clabe)}
              onChange={(event) => setClabeDraft((current) => ({ ...current, clabe: normalizeClabe(event.target.value) }))}
              inputMode="numeric"
              placeholder="000 000 00000000000 0"
              disabled={savingBankClabes}
            />
          </label>
          <div className={styles.clabeFormSplit}>
            <label>
              <span>Banco</span>
              <input
                value={clabeDraft.bank}
                onChange={(event) => setClabeDraft((current) => ({ ...current, bank: event.target.value }))}
                placeholder="BBVA"
                disabled={savingBankClabes}
              />
            </label>
            <label>
              <span>Titular</span>
              <input
                value={clabeDraft.accountHolder}
                onChange={(event) => setClabeDraft((current) => ({ ...current, accountHolder: event.target.value }))}
                placeholder="Ristak"
                disabled={savingBankClabes}
              />
            </label>
          </div>
          <button type="button" className={styles.clabeSaveButton} onClick={handleSaveClabe} disabled={savingBankClabes}>
            {savingBankClabes ? <Loader2 size={16} className={styles.spinIcon} /> : <Check size={16} />}
            Guardar CLABE
          </button>
        </div>
      )}

      {savedBankClabes.length > 0 ? (
        <div className={styles.clabeList}>
          {savedBankClabes.map((account) => (
            <button
              key={account.id}
              type="button"
              className={styles.clabeRow}
              onClick={() => handleSendClabe(account)}
              disabled={Boolean(sendingClabeId)}
            >
              <span className={styles.clabeRowIcon}>
                {sendingClabeId === account.id ? <Loader2 size={18} className={styles.spinIcon} /> : <Banknote size={19} />}
              </span>
              <span className={styles.clabeRowMain}>
                <strong>{account.alias}</strong>
                <small>{formatClabe(account.clabe)}</small>
                {(account.bank || account.accountHolder) && (
                  <em>{[account.bank, account.accountHolder].filter(Boolean).join(' · ')}</em>
                )}
              </span>
              <Send size={17} />
            </button>
          ))}
        </div>
      ) : (
        <div className={styles.clabeEmpty}>
          <Banknote size={27} />
          <strong>No hay CLABEs guardadas</strong>
          <span>Agrega una CLABE para enviarla rápido cuando un cliente quiera pagar por transferencia.</span>
          {!clabeFormOpen && (
            <button type="button" onClick={() => setClabeFormOpen(true)}>
              <Plus size={16} />
              Agregar CLABE
            </button>
          )}
        </div>
      )}
    </div>
  )

  const renderScheduleSheet = () => {
    const previewDate = getScheduleDateFromDraft(scheduleDraft)
    const canSubmitSchedule = Boolean(previewDate && messageText.trim() && !schedulingMessage)

    return (
      <div className={styles.scheduleSheetContent}>
        <div className={styles.scheduleFields}>
          <label className={styles.scheduleField}>
            <span>Fecha</span>
            <span className={styles.scheduleDateControl}>
              <span className={styles.scheduleDateText} aria-hidden="true">
                {formatScheduleDateDisplay(scheduleDraft.date)}
              </span>
              <input
                className={styles.scheduleDateNativeInput}
                type="date"
                value={scheduleDraft.date}
                min={formatDateInputValue(new Date())}
                aria-label="Fecha"
                onChange={(event) => handleScheduleDraftChange({ date: event.target.value })}
              />
            </span>
          </label>
          <div className={styles.scheduleTimeRow}>
            <label className={styles.scheduleField}>
              <span>Hora</span>
              <input
                type="number"
                min="1"
                max="12"
                inputMode="numeric"
                value={scheduleDraft.hour}
                onChange={(event) => handleScheduleDraftChange({ hour: event.target.value.slice(0, 2) })}
              />
            </label>
            <label className={styles.scheduleField}>
              <span>Min</span>
              <input
                type="number"
                min="0"
                max="59"
                inputMode="numeric"
                value={scheduleDraft.minute}
                onChange={(event) => handleScheduleDraftChange({ minute: event.target.value.slice(0, 2) })}
                onBlur={() => {
                  const minute = Math.min(59, Math.max(0, Number(scheduleDraft.minute) || 0))
                  handleScheduleDraftChange({ minute: padTwoDigits(minute) })
                }}
              />
            </label>
            <div className={styles.schedulePeriodToggle} role="group" aria-label="AM o PM">
              {(['AM', 'PM'] as SchedulePeriod[]).map((period) => (
                <button
                  key={period}
                  type="button"
                  className={scheduleDraft.period === period ? styles.schedulePeriodActive : ''}
                  onClick={() => handleScheduleDraftChange({ period })}
                >
                  {period}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={styles.schedulePreview} aria-live="polite">
          <span>{formatSchedulePreviewLabel(previewDate?.toISOString())}</span>
        </div>

        {scheduleError && (
          <p className={styles.scheduleError}>
            {scheduleError}
          </p>
        )}

        <button
          type="button"
          className={styles.scheduleSubmitButton}
          onClick={handleScheduleMessage}
          disabled={!canSubmitSchedule}
        >
          {schedulingMessage ? <Loader2 size={17} className={styles.spinIcon} /> : <Clock size={17} />}
          {scheduleEditingMessageId ? 'Guardar cambios' : 'Enviar programación'}
        </button>
      </div>
    )
  }

  const renderAttachmentsSheet = () => {
    const attachmentActions = [
      { label: 'Plantillas', Icon: FileText, className: styles.actionTemplate, onClick: handleOpenTemplatesSheet },
      { label: 'Fotos', Icon: ImageIcon, className: styles.actionBlue, onClick: () => handlePickPhoto('photos') },
      { label: 'Cámara', Icon: Camera, className: styles.actionDark, onClick: () => handlePickPhoto('camera') },
      { label: 'Documentos', Icon: FileText, className: styles.actionSky, onClick: handlePickDocument },
      { label: 'Ubicación', Icon: MapPin, className: styles.actionGreen, onClick: () => handleUnavailableAttachment('Ubicación') },
      { label: 'CLABE', Icon: Banknote, className: styles.actionClabe, onClick: handleOpenClabeSheet }
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

  const renderChatHeaderActions = (className = styles.topRightActions) => (
    <div className={className}>
      <button type="button" className={styles.roundButton} onClick={() => handlePickPhoto('camera', 'cameraShare')} aria-label="Abrir cámara">
        <Camera size={24} />
      </button>
      <button type="button" className={styles.newChatButton} onClick={() => setSheet('newChat')} aria-label="Nuevo chat">
        <Plus size={32} />
      </button>
    </div>
  )

  const renderTabletNewChatAction = () => (
    <button type="button" className={styles.tabletNewChatButton} onClick={() => setSheet('newChat')} aria-label="Nuevo chat">
      <Plus size={24} />
    </button>
  )

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
            <p className={styles.eyebrow}>Ristak</p>
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
      className={`${styles.phoneChatPage} ${conversationVisible ? styles.conversationOpen : ''} ${sheet || appointmentOpen ? styles.sheetOpen : ''}`}
      data-phone-chat-tone={resolvedPhoneChatTheme}
      data-phone-chat-mode={safeChatThemePreference}
      data-phone-chat-device={deviceMode}
      data-phone-chat-scroll-settling={conversationScrollSettling ? 'true' : undefined}
      aria-label="Chat móvil de Ristak"
    >
      <div className={styles.portraitLock} role="status" aria-live="polite">
        <Smartphone size={34} />
        <strong>Usa el celular en vertical</strong>
        <span>Ristak está bloqueado en modo vertical para que la pantalla no se desacomode.</span>
      </div>

      <PhonePageTransition
        active="chat"
        className={styles.phoneFrame}
        data-phone-chat-frame="true"
        onScroll={handlePhoneFrameScroll}
      >
        <section className={styles.chatListScreen} aria-label="Lista de chats">
          <header className={`${styles.chatListHeader} ${chatSearchExpanded ? styles.chatListHeaderSearchExpanded : ''}`}>
            {deviceMode !== 'tablet' && (
              <div className={styles.topActionRow} aria-hidden={chatSearchExpanded}>
                <span className={styles.topActionSpacer} aria-hidden="true" />
                {renderChatHeaderActions()}
              </div>
            )}
            <div className={styles.chatTitleRow} aria-hidden={chatSearchExpanded}>
              <div className={styles.chatTitleMain}>
                <h1>Chats</h1>
                {deviceMode === 'tablet' && renderTabletNewChatAction()}
              </div>
              <div className={styles.chatTitleRight}>
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
            <div className={styles.chatListElasticContent} data-phone-elastic-target="true">
              {renderChats()}
            </div>
          </div>
          {deviceMode === 'tablet' && !chatSearchExpanded && (
            <div className={styles.tabletChatDock}>
              <PhoneEcosystemNav active="chat" badges={{ chat: unreadTotal }} placement="top" />
            </div>
          )}

        </section>

        <section
          className={styles.conversationScreen}
          aria-label="Conversación"
          onTransitionEnd={handleConversationTransitionEnd}
        >
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
            data-phone-chat-scroll-settling={conversationScrollSettling ? 'true' : undefined}
            onScroll={handleMessagesPaneScroll}
          >
            <div ref={messagesContentRef} className={styles.messagesContent} data-phone-elastic-target="true">
              {renderMessages()}
            </div>
          </div>

          {(aiAgentConversationOpen || activeContact) && (
            <div className={styles.composerShell} data-phone-chat-composer="true">
              {aiAgentConversationOpen ? (
                renderAIAgentComposer()
              ) : (
                <>
                  {renderSenderBar()}
                  {!composerBlockedByReplyWindow && renderAISuggestionBar()}
                  {!composerBlockedByReplyWindow && renderReplyPreviewBar()}
                  {!composerBlockedByReplyWindow && renderDraftAttachments()}
                  {composerBlockedByReplyWindow ? (
                    <div className={styles.replyWindowBlockedComposer}>
                      <span className={styles.replyWindowBlockedIcon}>
                        <Clock size={12} />
                      </span>
                      <span className={styles.replyWindowBlockedText}>
                        <strong>Fuera de 24 horas</strong>
                        <small>Manda una plantilla para volver a escribirle.</small>
                      </span>
                      <button type="button" onClick={handleOpenTemplatesSheet} aria-label="Enviar plantilla">
                        <FileText size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className={`${styles.composer} ${hasComposerContent ? styles.composerHasContent : ''} ${voicePanelActive ? styles.composerVoiceMode : ''}`}>
                      {voicePanelActive ? (
                        renderVoiceComposerPanel()
                      ) : (
                        <>
                          <button type="button" className={styles.composerPlus} onClick={() => setSheet('attachments')} aria-label="Abrir adjuntos">
                            <Plus size={24} />
                          </button>
                          <div className={`${styles.messageInputWrap} ${canOpenScheduleSheet ? styles.messageInputWrapWithSchedule : ''}`}>
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
                            {canOpenScheduleSheet && (
                              <button
                                type="button"
                                className={styles.composerScheduleButton}
                                onClick={handleOpenScheduleSheet}
                                aria-label="Programar mensaje"
                                title="Programar mensaje"
                              >
                                <Clock size={12} />
                              </button>
                            )}
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
                              <Camera size={20} />
                            </button>
                            <button
                              type="button"
                              className={`${styles.composerIconButton} ${canSendMessage ? styles.composerSendButton : ''} ${voiceRecording ? styles.composerMicRecording : ''}`}
                              onPointerDown={handleVoiceButtonPointerDown}
                              onPointerUp={finishVoiceButtonPress}
                              onPointerCancel={handleVoiceButtonPointerCancel}
                              onClick={handleVoiceOrSendButtonClick}
                              aria-label={voiceRecording ? 'Detener grabación' : canSendMessage ? 'Enviar mensaje' : 'Grabar mensaje de voz'}
                            >
                              {canSendMessage ? <ArrowRight size={18} /> : <Mic size={20} />}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </section>

        {renderMessageInfoScreen()}
        {renderContactInfoScreen()}
        {renderCameraShareScreen()}
      </PhonePageTransition>

      {renderMessageActionMenu()}

      {deviceMode !== 'tablet' && !conversationOpen && !cameraSharePhoto && <PhoneEcosystemNav active="chat" badges={{ chat: unreadTotal }} />}

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
      <input
        ref={documentInputRef}
        type="file"
        accept={DOCUMENT_ATTACHMENT_ACCEPT}
        className={styles.hiddenFileInput}
        onChange={handleWebDocumentSelected}
      />

      {sheet && (
        <div
          className={`${styles.sheetBackdrop} ${actionSheetDragging ? styles.sheetBackdropInteractive : ''} ${sheet === 'settings' ? styles.settingsSheetBackdrop : ''} ${sheet === 'payment' || sheet === 'settings' || sheet === 'chatMore' || sheet === 'clabe' || sheet === 'schedule' ? styles.darkSheetBackdrop : ''} ${sheet === 'chatMore' ? styles.chatMoreSheetBackdrop : ''} ${actionSheetDismiss.closing ? styles.sheetBackdropClosing : ''}`}
          style={actionSheetDismiss.backdropStyle}
          onClick={actionSheetDismiss.requestClose}
        >
          <section
            className={`${styles.sheetPanel} ${actionSheetMoving ? styles.sheetPanelInteractive : ''} ${sheet === 'payment' ? styles.paymentSheet : ''} ${sheet === 'attachments' ? styles.attachmentsSheet : ''} ${sheet === 'templates' ? styles.templatesSheet : ''} ${sheet === 'clabe' ? styles.clabeSheet : ''} ${sheet === 'settings' ? styles.settingsSheet : ''} ${sheet === 'newChat' ? styles.newChatSheet : ''} ${sheet === 'chatMore' ? styles.chatMoreSheet : ''} ${sheet === 'schedule' ? styles.scheduleSheet : ''} ${actionSheetDismiss.closing ? styles.sheetPanelClosing : ''}`}
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
                    <p>{activeContact ? getContactName(activeContact) : aiAgentConversationOpen ? 'Agente de IA' : 'Ristak'}</p>
                  )}
                  <h2>
                    {sheet === 'payment' && 'Registrar pago'}
                    {sheet === 'templates' && 'Plantillas'}
                    {sheet === 'clabe' && 'CLABE'}
                    {sheet === 'settings' && 'Ajustes del chat'}
                    {sheet === 'newChat' && 'Nuevo chat'}
                    {sheet === 'chatMore' && 'Más acciones'}
                    {sheet === 'schedule' && (scheduleEditingMessageId ? 'Editar programación' : 'Programar mensaje')}
                  </h2>
                </div>
              </div>
            )}

            {sheet === 'newChat' && renderNewChatSheet()}
            {sheet === 'attachments' && renderAttachmentsSheet()}
            {sheet === 'templates' && renderTemplatesSheet()}
            {sheet === 'clabe' && renderClabeSheet()}
            {sheet === 'settings' && renderChatSettingsSheet()}
            {sheet === 'chatMore' && renderChatMoreSheet()}
            {sheet === 'schedule' && renderScheduleSheet()}

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
