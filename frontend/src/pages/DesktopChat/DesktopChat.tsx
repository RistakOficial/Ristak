import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Archive,
  Banknote,
  Bot,
  CalendarDays,
  CheckCheck,
  ChevronLeft,
  CircleAlert,
  Clock,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Mic,
  MoreHorizontal,
  MousePointerClick,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  Search,
  ListFilter,
  Square,
  Tag,
  Trash2,
  User,
  Video,
  Workflow,
  X
} from 'lucide-react'
import { FaFacebookMessenger, FaInstagram, FaWhatsapp } from 'react-icons/fa'
import {
  AppointmentModal,
  Button,
  CustomSelect,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  Modal,
  RecordPaymentModal,
  TagPicker
} from '@/components/common'
import { ContactJourney } from '@/components/common/ContactJourney'
import { AgentRobot } from '@/components/ai'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import apiClient from '@/services/apiClient'
import automationsService, { type AutomationSummary } from '@/services/automationsService'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
import { conversationalAgentService, type ConversationAgentState, type ConversationStateAction, type ConversationalAgentDef } from '@/services/conversationalAgentService'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { subscribeToChatLiveEvents, type ChatLiveMessageEvent } from '@/services/chatLiveEventsService'
import { highLevelService, type HighLevelChatChannel } from '@/services/highLevelService'
import { whatsappApiService, type ScheduledChatMessage, type WhatsAppApiPhoneNumber, type WhatsAppApiStatus } from '@/services/whatsappApiService'
import type { Contact, ContactAppointment, ContactPayment } from '@/types'
import { getContactStageBadge } from '@/utils/contactStageBadge'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import styles from './DesktopChat.module.css'

type ChatFilter = 'all' | 'agent' | 'unread' | 'appointments' | 'customers'
type AdvancedChannelFilter = 'all' | 'whatsapp' | 'messenger' | 'instagram' | 'webchat' | 'sms' | 'email'
type AdvancedSocialFilter = 'all' | 'facebook' | 'instagram' | 'messenger' | 'whatsapp' | 'google' | 'unknown'
type AdvancedOriginFilter = 'all' | 'meta' | 'site' | 'organic' | 'trigger' | 'unknown'
type AdvancedStageFilter = 'all' | 'lead' | 'appointment' | 'customer'
type AdvancedActivityFilter = 'all' | 'payments' | 'appointments' | 'with_source' | 'no_phone'
type ComposerStatus = 'idle' | 'sending'
type ChatAttachmentType = 'image' | 'audio' | 'video' | 'document' | 'file'
type DraftAttachmentKind = 'image' | 'document'
type InfoPanelView = 'summary' | 'journey'
type ContactChannelBadgeKind = 'whatsapp' | 'messenger' | 'instagram' | 'email' | 'sms' | 'webchat' | 'meta'
type SchedulePeriod = 'AM' | 'PM'

interface ContactChannelBadge {
  kind: ContactChannelBadgeKind
  label: string
}

interface AdvancedChatFilters {
  channel: AdvancedChannelFilter
  social: AdvancedSocialFilter
  origin: AdvancedOriginFilter
  stage: AdvancedStageFilter
  activity: AdvancedActivityFilter
}

interface DesktopChatContact extends Contact {
  lastMessageText?: string
  lastMessageType?: string
  lastMessageChannel?: string
  lastMessageTransport?: string
  lastMessageDate?: string
  lastMessageDirection?: string
  lastBusinessPhone?: string
  lastBusinessPhoneNumberId?: string
  messageCount?: number
  unreadCount?: number
  profilePhotoUrl?: string | null
  avatarUrl?: string | null
  photoUrl?: string | null
  pictureUrl?: string | null
  profile_picture_url?: string | null
}

interface RemovedChatState {
  contactId: string
  lastMessageDate: string
  messageCount: number
  removedAt: string
}

interface DesktopChatMessage {
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
  transport?: string
  attachment?: {
    type: ChatAttachmentType
    url?: string
    dataUrl?: string
    name?: string
    mimeType?: string
    durationMs?: number
    isGif?: boolean
  }
}

interface DesktopDraftAttachment {
  id: string
  kind: DraftAttachmentKind
  name: string
  mimeType: string
  dataUrl: string
  size: number
}

interface ScheduleDraft {
  date: string
  hour: string
  minute: string
  period: SchedulePeriod
}

interface VoiceDraftAttachment {
  id: string
  name: string
  type: string
  dataUrl: string
  size: number
  durationMs: number
}

interface ContactInfoPayment {
  id: string
  amount: number
  status?: string | null
  date: string
  title?: string | null
}

interface ContactInfoAppointment {
  id: string
  title: string
  status?: string | null
  startTime: string
  endTime?: string | null
  notes?: string | null
  calendarId?: string | null
  locationId?: string | null
  address?: string | null
  assignedUserId?: string | null
}

const CHAT_FILTERS: Array<{ id: ChatFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'unread', label: 'No leídos' },
  { id: 'appointments', label: 'Con cita' },
  { id: 'customers', label: 'Clientes' }
]

const CHAT_REQUEST_TIMEOUT_MS = 20000
const CHAT_ARCHIVED_STATE_KEY = 'ristak_phone_chat_archived_state_v1'
const CHAT_REMOVED_STATE_KEY = 'ristak_desktop_chat_removed_state_v1'
const CHAT_CACHE_KEY = 'ristak_desktop_chat_list_cache_v1'
const CHAT_CACHE_MAX_AGE_MS = 30 * 60 * 1000
const CHAT_REFRESH_INTERVAL_MS = 20000
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
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

const DEFAULT_ADVANCED_FILTERS: AdvancedChatFilters = {
  channel: 'all',
  social: 'all',
  origin: 'all',
  stage: 'all',
  activity: 'all'
}

const CHANNEL_FILTER_OPTIONS = [
  { value: 'all', label: 'Todos los canales' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'instagram', label: 'Instagram Direct' },
  { value: 'webchat', label: 'Webchat / sitio' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' }
]

const ORIGIN_FILTER_OPTIONS = [
  { value: 'all', label: 'Todos los orígenes' },
  { value: 'meta', label: 'Meta / red social' },
  { value: 'site', label: 'Sitio o formulario' },
  { value: 'organic', label: 'Orgánico / directo' },
  { value: 'trigger', label: 'Enlace de disparo' },
  { value: 'unknown', label: 'Sin origen' }
]

const SOCIAL_FILTER_OPTIONS = [
  { value: 'all', label: 'Todas las redes' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'google', label: 'Google' },
  { value: 'unknown', label: 'Sin red detectada' }
]

const STAGE_FILTER_OPTIONS = [
  { value: 'all', label: 'Todas las etapas' },
  { value: 'lead', label: 'Interesados' },
  { value: 'appointment', label: 'Con cita' },
  { value: 'customer', label: 'Clientes' }
]

const ACTIVITY_FILTER_OPTIONS = [
  { value: 'all', label: 'Toda la actividad' },
  { value: 'payments', label: 'Con pagos' },
  { value: 'appointments', label: 'Con citas' },
  { value: 'with_source', label: 'Con origen detectado' },
  { value: 'no_phone', label: 'Sin teléfono' }
]

const VOICE_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm'
]
const MAX_VOICE_MESSAGE_BYTES = 16 * 1024 * 1024
const MIN_VOICE_RECORDING_MS = 700
const VOICE_WAVE_BAR_COUNT = 84
const VOICE_WAVE_PATTERN = [8, 18, 30, 42, 24, 13, 36, 48, 31, 16, 10, 22, 40, 52, 34, 20, 45, 28]
const MESSAGE_AUDIO_WAVE_PATTERN = [13, 24, 36, 19, 30, 46, 22, 15, 40, 52, 34, 20, 28, 44, 18, 26, 38, 23]
const MESSAGE_AUDIO_WAVE_BAR_COUNT = 30
const FAILED_MESSAGE_STATUSES = new Set(['failed', 'error', 'undelivered', 'rejected', 'cancelled'])
const PENDING_MESSAGE_STATUSES = new Set(['pending', 'queued', 'sending', 'enviando', 'enviando por qr', 'scheduled'])
const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const CANCELED_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'invalid', 'failed', 'missed', 'deleted', 'void', 'voided'])
const HIGHLEVEL_CHANNEL_LABELS: Record<HighLevelChatChannel, string> = {
  whatsapp_api: 'WhatsApp API',
  sms_qr: 'SMS',
  messenger: 'Messenger',
  instagram: 'Instagram'
}

const AGENT_SIGNAL_LABELS: Record<string, string> = {
  ready_for_human: 'Listo para humano',
  ready_to_schedule: 'Listo para agendar',
  ready_to_buy: 'Listo para cobrar',
  appointment_booked: 'Cita agendada',
  purchase_completed: 'Compra confirmada',
  discarded: 'Descartado'
}

const CONVERSATION_AGENT_STATUS_LABELS: Record<string, string> = {
  active: 'Agente atendiendo este chat',
  paused: 'Agente pausado en este chat',
  human: 'Conversación tomada por humano',
  skipped: 'Agente omitido en este chat',
  completed: 'Objetivo completado por el agente',
  discarded: 'Conversación descartada'
}

function getContactName(contact?: Partial<Contact> | null) {
  return contact?.name || contact?.email || contact?.phone || 'Contacto sin nombre'
}

function getContactDetail(contact?: Partial<Contact> | null) {
  return contact?.phone || contact?.email || 'Sin teléfono guardado'
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

function contactMatchesQuery(contact: Partial<Contact>, query: string) {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return true
  return [contact.name, contact.phone, contact.email].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery)
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

function getDraftAttachmentMessageType(attachment: DesktopDraftAttachment): ChatAttachmentType {
  return attachment.kind === 'image' ? 'image' : 'document'
}

function getAttachmentPreviewText(attachments: DesktopDraftAttachment[], fallbackText = '') {
  if (!attachments.length) return fallbackText
  const hasDocument = attachments.some((attachment) => attachment.kind === 'document')
  if (attachments.length > 1) return hasDocument ? 'Archivos' : 'Fotos'
  return hasDocument ? 'Documento' : 'Foto'
}

function formatAttachmentSize(size?: number) {
  const value = Number(size || 0)
  if (!Number.isFinite(value) || value <= 0) return 'Archivo'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function formatCurrencyNoDecimals(value: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(value)
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

function normalizeFilterProbe(values: unknown[]) {
  return values
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean)
    .join(' ')
}

function getRecordValue(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function getContactChannelKind(contact: DesktopChatContact): AdvancedChannelFilter | '' {
  const record = contact as unknown as Record<string, unknown>
  const directProbe = normalizeFilterProbe([
    contact.lastMessageChannel,
    getRecordValue(record, 'lastMessageTransport'),
    getRecordValue(record, 'lastMessageProvider'),
    getRecordValue(record, 'conversationChannel'),
    getRecordValue(record, 'lastChannel'),
    getRecordValue(record, 'channel')
  ])
  const fallbackProbe = directProbe || normalizeFilterProbe([contact.source, contact.attribution_session_source])

  if (fallbackProbe.includes('instagram')) return 'instagram'
  if (fallbackProbe.includes('messenger')) return 'messenger'
  if (fallbackProbe.includes('whatsapp') || fallbackProbe.includes('wa_') || fallbackProbe.includes('ctwa')) return 'whatsapp'
  if (fallbackProbe.includes('webchat') || fallbackProbe.includes('website_chat') || fallbackProbe.includes('site_chat')) return 'webchat'
  if (fallbackProbe.includes('sms')) return 'sms'
  if (fallbackProbe.includes('email') || fallbackProbe.includes('mail')) return 'email'
  return ''
}

function getContactChannelBadge(contact?: DesktopChatContact | Contact | null): ContactChannelBadge | null {
  if (!contact) return null

  const channel = getContactChannelKind(contact as DesktopChatContact)
  const social = getContactSocialKind(contact as DesktopChatContact)
  const origin = getContactOriginKind(contact as DesktopChatContact)

  if (channel === 'whatsapp') return { kind: 'whatsapp', label: 'WhatsApp' }
  if (channel === 'instagram') return { kind: 'instagram', label: 'Instagram' }
  if (channel === 'messenger') return { kind: 'messenger', label: 'Messenger' }
  if (channel === 'webchat' || origin === 'site') return { kind: 'webchat', label: 'Web' }
  if (channel === 'sms') return { kind: 'sms', label: 'SMS' }
  if (channel === 'email') return { kind: 'email', label: 'Email' }
  if (social === 'whatsapp') return { kind: 'whatsapp', label: 'WhatsApp' }
  if (social === 'instagram') return { kind: 'instagram', label: 'Instagram' }
  if (social === 'messenger' || social === 'facebook') return { kind: 'messenger', label: social === 'facebook' ? 'Facebook' : 'Messenger' }
  if (origin === 'meta') return { kind: 'meta', label: 'Meta' }
  return null
}

function getAvatarChannelBadgeClass(kind: ContactChannelBadgeKind) {
  if (kind === 'instagram') return styles.avatarChannelBadgeInstagram
  if (kind === 'messenger') return styles.avatarChannelBadgeMessenger
  if (kind === 'email') return styles.avatarChannelBadgeEmail
  if (kind === 'sms') return styles.avatarChannelBadgeSms
  if (kind === 'webchat') return styles.avatarChannelBadgeWebchat
  if (kind === 'meta') return styles.avatarChannelBadgeMeta
  return styles.avatarChannelBadgeWhatsapp
}

function mapAgentStatesByContactId(states: ConversationAgentState[] = []) {
  const next: Record<string, ConversationAgentState> = {}
  states.forEach((state) => {
    if (state?.contactId) next[state.contactId] = state
  })
  return next
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

function readStoredRemovedChatStates(): RemovedChatState[] {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_REMOVED_STATE_KEY) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((state: unknown): state is RemovedChatState => Boolean(
        state &&
        typeof state === 'object' &&
        typeof (state as RemovedChatState).contactId === 'string' &&
        (state as RemovedChatState).contactId.trim()
      ))
      .map((state) => ({
        contactId: state.contactId.trim(),
        lastMessageDate: typeof state.lastMessageDate === 'string' ? state.lastMessageDate : '',
        messageCount: Number.isFinite(Number(state.messageCount)) ? Number(state.messageCount) : 0,
        removedAt: typeof state.removedAt === 'string' ? state.removedAt : new Date().toISOString()
      }))
      .slice(0, 200)
  } catch {
    return []
  }
}

function writeStoredRemovedChatStates(states: RemovedChatState[]) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(CHAT_REMOVED_STATE_KEY, JSON.stringify(states.slice(0, 200)))
}

function getRemovedChatState(states: RemovedChatState[], contactId: string) {
  return states.find((state) => state.contactId === contactId) || null
}

function getChatRemovalSnapshot(contact: DesktopChatContact | Contact): Omit<RemovedChatState, 'contactId' | 'removedAt'> {
  const chatContact = contact as DesktopChatContact
  return {
    lastMessageDate: chatContact.lastMessageDate || '',
    messageCount: Number(chatContact.messageCount || 0)
  }
}

function hasChatActivityAfterRemoval(contact: DesktopChatContact, state: RemovedChatState) {
  const snapshot = getChatRemovalSnapshot(contact)
  if (snapshot.lastMessageDate && state.lastMessageDate && snapshot.lastMessageDate !== state.lastMessageDate) return true
  return snapshot.messageCount !== Number(state.messageCount || 0)
}

function isChatRemovedFromList(contact: DesktopChatContact, state?: RemovedChatState | null) {
  return Boolean(state && !hasChatActivityAfterRemoval(contact, state))
}

function pruneRevealedRemovedChatStates(states: RemovedChatState[], chats: DesktopChatContact[]) {
  const chatsById = new Map(chats.map((contact) => [contact.id, contact]))
  return states.filter((state) => {
    const contact = chatsById.get(state.contactId)
    if (!contact) return true
    return !hasChatActivityAfterRemoval(contact, state)
  })
}

function getDefaultActiveChatId(chats: DesktopChatContact[], archivedIds: Set<string>, agentPriorityIds: Set<string>, removedStates: RemovedChatState[]) {
  const isVisible = (contact: DesktopChatContact) => !isChatRemovedFromList(contact, getRemovedChatState(removedStates, contact.id))
  return chats.find((contact) => isVisible(contact) && !archivedIds.has(contact.id) && !agentPriorityIds.has(contact.id))?.id ||
    chats.find(isVisible)?.id ||
    ''
}

function readCachedChatList(): DesktopChatContact[] {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(CHAT_CACHE_KEY) || 'null')
    if (!parsed || typeof parsed !== 'object') return []
    if (Date.now() - Number(parsed.storedAt || 0) > CHAT_CACHE_MAX_AGE_MS) return []
    if (!Array.isArray(parsed.chats)) return []

    return parsed.chats
      .filter((contact: unknown): contact is DesktopChatContact => Boolean(
        contact &&
        typeof contact === 'object' &&
        typeof (contact as DesktopChatContact).id === 'string' &&
        (contact as DesktopChatContact).id.trim()
      ))
      .slice(0, 100)
  } catch {
    return []
  }
}

function writeCachedChatList(chats: DesktopChatContact[]) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify({
      storedAt: Date.now(),
      chats: chats.slice(0, 100)
    }))
  } catch {
    // Cache best-effort: si el navegador no deja guardar, la red sigue siendo la fuente.
  }
}

function getContactSocialKind(contact: DesktopChatContact): AdvancedSocialFilter | '' {
  const firstSession = contact.firstSession || null
  const probe = normalizeFilterProbe([
    contact.source,
    contact.attribution_session_source,
    contact.whatsappAttributionPlatform,
    contact.ad_name,
    contact.ad_id,
    contact.attribution_url,
    firstSession?.utm_source,
    firstSession?.utm_medium,
    firstSession?.utm_campaign,
    firstSession?.source_platform,
    firstSession?.site_source_name,
    firstSession?.placement
  ])

  if (!probe) return 'unknown'
  if (probe.includes('instagram') || probe.includes('ig_')) return 'instagram'
  if (probe.includes('messenger')) return 'messenger'
  if (probe.includes('facebook') || probe.includes('fb_')) return 'facebook'
  if (probe.includes('whatsapp') || probe.includes('ctwa')) return 'whatsapp'
  if (probe.includes('google') || probe.includes('gclid')) return 'google'
  return ''
}

function getContactOriginKind(contact: DesktopChatContact): AdvancedOriginFilter | '' {
  const firstSession = contact.firstSession || null
  const probe = normalizeFilterProbe([
    contact.source,
    contact.attribution_session_source,
    contact.whatsappAttributionPlatform,
    contact.ad_name,
    contact.ad_id,
    contact.attribution_url,
    firstSession?.utm_source,
    firstSession?.utm_medium,
    firstSession?.utm_campaign,
    firstSession?.source_platform,
    firstSession?.page_url,
    firstSession?.landing_page
  ])

  if (!probe) return 'unknown'
  if (probe.includes('trigger') || probe.includes('disparo') || probe.includes('public_id')) return 'trigger'
  if (probe.includes('facebook') || probe.includes('instagram') || probe.includes('meta') || probe.includes('ctwa') || probe.includes('ad_') || probe.includes('campaign')) return 'meta'
  if (probe.includes('web') || probe.includes('site') || probe.includes('landing') || probe.includes('form') || probe.includes('page')) return 'site'
  if (probe.includes('organic') || probe.includes('direct') || probe.includes('google') || probe.includes('referral')) return 'organic'
  return ''
}

function contactHasSource(contact: DesktopChatContact) {
  return Boolean(contact.source || contact.attribution_session_source || contact.whatsappAttributionPlatform || contact.ad_name || contact.firstSession)
}

function contactMatchesAdvancedFilters(contact: DesktopChatContact, filters: AdvancedChatFilters) {
  if (filters.channel !== 'all' && getContactChannelKind(contact) !== filters.channel) return false
  if (filters.social !== 'all' && getContactSocialKind(contact) !== filters.social) return false
  if (filters.origin !== 'all' && getContactOriginKind(contact) !== filters.origin) return false
  if (filters.stage !== 'all' && contact.status !== filters.stage) return false

  if (filters.activity === 'payments') {
    const hasPayments = Number(contact.ltv || 0) > 0 || Number(contact.purchases || 0) > 0 || Boolean(contact.payments?.some(isSuccessfulPayment))
    if (!hasPayments) return false
  }
  if (filters.activity === 'appointments' && !contact.hasAppointments && !contact.nextAppointmentDate) return false
  if (filters.activity === 'with_source' && !contactHasSource(contact)) return false
  if (filters.activity === 'no_phone' && contact.phone) return false

  return true
}

function countAdvancedFilters(filters: AdvancedChatFilters) {
  return Object.values(filters).filter((value) => value !== 'all').length
}

function formatMessageTime(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', hour12: true }).format(date)
}

function formatMessageDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  if (date.toDateString() === now.toDateString()) return formatMessageTime(value)

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
  if (date.toDateString() === new Date().toDateString()) return `Programado ${time}`

  return `Programado ${formatMessageDate(value)} ${time}`.trim()
}

function formatSchedulePreviewLabel(value?: string | null) {
  if (!value) return 'Elige fecha y hora'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Elige fecha y hora'

  const time = formatMessageTime(value)
  if (date.toDateString() === new Date().toDateString()) return `Se enviará a las ${time}`

  return `Se enviará el ${formatMessageDate(value)} a las ${time}`.trim()
}

function getConversationDayKey(value?: string | null, timeZone?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
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
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: dayKey.slice(0, 4) === todayKey.slice(0, 4) ? undefined : 'numeric',
    timeZone: timeZone || undefined
  }).format(date).replace('.', '')
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

function normalizeWhatsAppBusinessDirection(value?: unknown): 'inbound' | 'outbound' {
  const direction = String(value || '').toLowerCase()
  return [
    'outbound',
    'outgoing',
    'sent',
    'business',
    'api',
    'app',
    'business_echo',
    'smb_echo',
    'echo',
    'message_echo'
  ].includes(direction) ? 'outbound' : 'inbound'
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

function pickMessageText(data: Record<string, unknown>) {
  const textKeys = [
    'message_text',
    'messageText',
    'message',
    'body',
    'text',
    'message_body',
    'messageBody',
    'content',
    'caption'
  ]

  for (const key of textKeys) {
    const value = data[key]
    if (value === null || value === undefined) continue
    if (typeof value === 'object') continue
    const text = String(value).trim()
    if (text) return text
  }

  return ''
}

function getMessageTypeLabel(type = '', fallback = 'Mensaje') {
  const normalized = type.toLowerCase()
  if (normalized.includes('gif')) return 'GIF'
  if (normalized.includes('image')) return 'Foto'
  if (normalized.includes('video')) return 'Video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Mensaje de voz'
  if (normalized.includes('document')) return 'Documento'
  if (normalized.includes('location')) return 'Ubicación'
  if (normalized.includes('postback')) return 'Respuesta rápida'
  if (normalized.includes('reaction')) return 'Reacción'
  return fallback
}

function getMediaPathExtension(value = '') {
  const clean = String(value || '').trim().split('?')[0].split('#')[0].toLowerCase()
  const leaf = clean.split('/').pop() || clean
  const extension = leaf.split('.').pop() || ''
  return /^[a-z0-9]{2,8}$/.test(extension) ? extension : ''
}

function hasGifFileSignature(mimeType = '', name = '', mediaUrl = '') {
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase()
  return normalizedMime === 'image/gif' || getMediaPathExtension(name) === 'gif' || getMediaPathExtension(mediaUrl) === 'gif'
}

function isGifMedia(messageType = '', mimeType = '', name = '', mediaUrl = '') {
  return messageType.toLowerCase().includes('gif') || hasGifFileSignature(mimeType, name, mediaUrl)
}

function getMediaAttachmentType(messageType = '', mimeType = '', name = '', mediaUrl = ''): ChatAttachmentType | null {
  const normalizedType = messageType.toLowerCase()
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase()
  const normalizedName = name.toLowerCase()
  const gifFile = hasGifFileSignature(mimeType, name, mediaUrl)
  const gifMessageType = normalizedType.includes('gif')
  if (normalizedType.includes('audio') || normalizedType.includes('voice') || normalizedMime.startsWith('audio/')) return 'audio'
  if (gifFile || (gifMessageType && !normalizedMime.startsWith('video/'))) return 'image'
  if (normalizedType.includes('image') || normalizedType.includes('sticker') || normalizedMime.startsWith('image/')) return 'image'
  if (normalizedType.includes('video') || gifMessageType || normalizedMime.startsWith('video/')) return 'video'
  if (
    normalizedType.includes('document') ||
    normalizedMime === 'application/pdf' ||
    normalizedMime.includes('officedocument') ||
    normalizedMime.includes('msword') ||
    normalizedMime.includes('spreadsheet') ||
    normalizedMime.includes('presentation')
  ) return 'document'
  if (normalizedType.includes('file') || normalizedMime.startsWith('application/') || normalizedMime.startsWith('text/') || /\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z)$/i.test(normalizedName)) return 'file'
  return null
}

function pickMediaUrl(data: Record<string, unknown>) {
  const keys = [
    'media_url',
    'mediaUrl',
    'public_url',
    'publicUrl',
    'download_url',
    'downloadUrl',
    'file_url',
    'fileUrl',
    'audio_url',
    'audioUrl',
    'image_url',
    'imageUrl',
    'video_url',
    'videoUrl',
    'url',
    'link',
    'href'
  ]
  for (const key of keys) {
    const value = String(data[key] || '').trim()
    if (value) return value
  }
  return ''
}

function cleanAttachmentMessageText(text = '', attachment?: DesktopChatMessage['attachment']) {
  if (!attachment) return text
  const placeholderByType: Record<ChatAttachmentType, string[]> = {
    audio: ['audio', 'voice', 'voice message', 'mensaje de voz'],
    image: ['image', 'photo', 'foto', 'imagen', 'gif'],
    video: ['video'],
    document: ['document', 'documento'],
    file: ['file', 'archivo']
  }
  const normalized = text
    .replace(/\[[^\]]*received on[^\]]*\]/gi, '')
    .replace(/\[[^\]]*sent from[^\]]*\]/gi, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

  if ((placeholderByType[attachment.type] || []).includes(normalized)) return ''
  return text
}

function getAttachmentSource(attachment: DesktopChatMessage['attachment']) {
  return attachment?.url || attachment?.dataUrl || ''
}

function getAttachmentExtension(name = '', mimeType = '') {
  const normalizedMime = mimeType.toLowerCase()
  const nameExtension = name.split('?')[0].split('#')[0].split('.').pop()?.toLowerCase() || ''
  if (nameExtension && nameExtension.length <= 6 && /^[a-z0-9]+$/.test(nameExtension)) return nameExtension
  if (normalizedMime.includes('pdf')) return 'pdf'
  if (normalizedMime.includes('word') || normalizedMime.includes('msword')) return 'doc'
  if (normalizedMime.includes('spreadsheet') || normalizedMime.includes('excel')) return 'xls'
  if (normalizedMime.includes('presentation') || normalizedMime.includes('powerpoint')) return 'ppt'
  if (normalizedMime.includes('zip')) return 'zip'
  if (normalizedMime.startsWith('text/')) return 'txt'
  return 'file'
}

function getAttachmentFileMeta(attachment: NonNullable<DesktopChatMessage['attachment']>) {
  const extension = getAttachmentExtension(attachment.name || '', attachment.mimeType || '')
  const normalizedMime = String(attachment.mimeType || '').toLowerCase()
  const upperExtension = extension === 'file' ? 'FILE' : extension.toUpperCase()
  let label = 'Archivo'
  let tone: 'pdf' | 'word' | 'sheet' | 'slide' | 'zip' | 'text' | 'file' = 'file'

  if (extension === 'pdf' || normalizedMime.includes('pdf')) {
    label = 'PDF'
    tone = 'pdf'
  } else if (['doc', 'docx'].includes(extension) || normalizedMime.includes('word') || normalizedMime.includes('msword')) {
    label = 'Word'
    tone = 'word'
  } else if (['xls', 'xlsx', 'csv'].includes(extension) || normalizedMime.includes('spreadsheet') || normalizedMime.includes('excel')) {
    label = extension === 'csv' ? 'CSV' : 'Excel'
    tone = 'sheet'
  } else if (['ppt', 'pptx'].includes(extension) || normalizedMime.includes('presentation') || normalizedMime.includes('powerpoint')) {
    label = 'Presentación'
    tone = 'slide'
  } else if (['zip', 'rar', '7z'].includes(extension) || normalizedMime.includes('zip') || normalizedMime.includes('compressed')) {
    label = 'Comprimido'
    tone = 'zip'
  } else if (['txt', 'md'].includes(extension) || normalizedMime.startsWith('text/')) {
    label = 'Texto'
    tone = 'text'
  }

  return {
    extension: upperExtension,
    label,
    tone,
    name: attachment.name || getMessageTypeLabel(attachment.type, 'Archivo')
  }
}

function getJourneyMediaAttachment(event: JourneyEvent): DesktopChatMessage['attachment'] | undefined {
  const data = event.data || {}
  const messageType = String(data.message_type || data.messageType || data.type || '').toLowerCase()
  const mediaUrl = pickMediaUrl(data)
  const mediaId = String(data.media_id || data.mediaId || '').trim()
  const mimeType = String(data.media_mime_type || data.mediaMimeType || data.mimeType || data.mime_type || '').trim()
  const name = String(data.media_filename || data.mediaFilename || data.filename || data.fileName || '').trim()
  const durationMs = Number(data.media_duration_ms || data.mediaDurationMs || data.durationMs || data.duration_ms || 0) || undefined
  const type = getMediaAttachmentType(messageType, mimeType, name, mediaUrl)
  const isGif = isGifMedia(messageType, mimeType, name, mediaUrl)
  if (!type) return undefined
  return {
    type,
    url: mediaUrl,
    name: type === 'audio' ? 'Mensaje de voz' : (name || mediaId || (isGif ? 'GIF enviado' : getMessageTypeLabel(type, 'Archivo'))),
    mimeType,
    durationMs,
    isGif
  }
}

function getJourneyMessage(event: JourneyEvent, index: number): DesktopChatMessage | null {
  if (event.type !== 'whatsapp_message' && event.type !== 'meta_message') return null
  const data = event.data || {}
  const attachment = getJourneyMediaAttachment(event)
  const text = cleanAttachmentMessageText(pickMessageText(data), attachment)
  const messageType = String(data.message_type || data.messageType || data.type || '').trim()
  if (!text && !attachment && !messageType) return null
  const direction = normalizeWhatsAppBusinessDirection(data.direction || data.message_direction || data.from_type)
  const date = pickMessageTimestamp(data, ['date', 'timestamp', 'created_at', 'createdAt', 'message_timestamp', 'messageTimestamp']) || event.date
  const fallbackText = attachment
    ? (['audio', 'image', 'video'].includes(attachment.type) ? '' : getMessageTypeLabel(attachment.type, 'Archivo'))
    : getMessageTypeLabel(messageType)
  return {
    id: String(
      data.whatsapp_api_message_id ||
      data.whatsapp_message_id ||
      data.meta_social_message_id ||
      data.meta_message_id ||
      data.message_id ||
      data.messageId ||
      data.attribution_record_id ||
      data.id ||
      `${event.type}-${event.date}-${index}`
    ),
    text: text || fallbackText,
    date,
    direction,
    status: String(data.status || data.message_status || '').trim(),
    errorReason: String(data.error_message || data.errorMessage || data.error_reason || data.errorReason || '').trim(),
    sentAt: pickMessageTimestamp(data, ['sent_at', 'sentAt']),
    deliveredAt: pickMessageTimestamp(data, ['delivered_at', 'deliveredAt']),
    readAt: pickMessageTimestamp(data, ['read_at', 'readAt']),
    businessPhone: String(data.business_phone || data.businessPhone || data.from || '').trim(),
    businessPhoneNumberId: String(data.business_phone_number_id || data.businessPhoneNumberId || '').trim(),
    transport: String(data.transport || data.channel || data.provider || '').trim(),
    attachment
  }
}

function getScheduledChatMessageBubble(message: ScheduledChatMessage): DesktopChatMessage | null {
  if (!message?.id || !message.text) return null
  return {
    id: `scheduled-${message.id}`,
    text: message.text,
    date: message.createdAt || message.updatedAt || new Date().toISOString(),
    direction: 'outbound',
    status: message.status || 'scheduled',
    errorReason: message.errorMessage || '',
    scheduledAt: message.scheduledAt,
    scheduledMessageId: message.id,
    businessPhone: message.fromPhone || '',
    businessPhoneNumberId: message.businessPhoneNumberId || '',
    transport: message.transport || message.provider
  }
}

function isMessageScheduled(message: DesktopChatMessage) {
  return String(message.status || '').trim().toLowerCase() === 'scheduled' || Boolean(message.scheduledAt && message.scheduledMessageId)
}

function getScheduledMessageActionId(message: DesktopChatMessage) {
  return message.scheduledMessageId || (message.id.startsWith('scheduled-') ? message.id.slice('scheduled-'.length) : '')
}

function getChatPreview(contact: DesktopChatContact) {
  const text = String(contact.lastMessageText || '').trim()
  if (text) return contact.lastMessageDirection === 'outbound' ? `Tú: ${text}` : text
  if (contact.lastMessageType) return getMessageTypeLabel(contact.lastMessageType)
  return contact.phone || contact.email || 'Sin mensajes todavía'
}

function getContactInfoPayments(contact?: Contact | null, journey: JourneyEvent[] = []): ContactInfoPayment[] {
  const contactPayments = (contact?.payments || []).map((payment: ContactPayment, index: number) => ({
    id: String(payment.id || `${contact?.id || 'contact'}-payment-${index}`),
    amount: Number(payment.amount || 0),
    status: payment.status,
    date: payment.date || contact?.createdAt || new Date().toISOString(),
    title: null
  }))
  if (contactPayments.length > 0) return contactPayments.sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
  return journey
    .filter((event) => event.type === 'payment')
    .map((event, index) => ({
      id: String(event.data?.id || `${contact?.id || 'contact'}-journey-payment-${index}`),
      amount: Number(event.data?.amount || 0),
      status: event.data?.status || null,
      date: event.date,
      title: event.data?.title || event.data?.type || null
    }))
    .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))
}

function getContactInfoAppointments(contact?: Contact | null, journey: JourneyEvent[] = []): ContactInfoAppointment[] {
  const contactAppointments = (contact?.appointments || []).map((appointment: ContactAppointment, index: number) => ({
    id: String(appointment.id || `${contact?.id || 'contact'}-appointment-${index}`),
    title: appointment.title || 'Cita',
    status: appointment.appointment_status || appointment.status || null,
    startTime: appointment.start_time || appointment.end_time || contact?.createdAt || new Date().toISOString(),
    endTime: appointment.end_time || null,
    notes: appointment.notes || null,
    calendarId: (appointment as Record<string, any>).calendarId || (appointment as Record<string, any>).calendar_id || null,
    locationId: (appointment as Record<string, any>).locationId || (appointment as Record<string, any>).location_id || null,
    address: (appointment as Record<string, any>).address || (appointment as Record<string, any>).location || null,
    assignedUserId: (appointment as Record<string, any>).assignedUserId || (appointment as Record<string, any>).assigned_user_id || null
  }))
  if (contactAppointments.length > 0) return contactAppointments.sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime))
  return journey
    .filter((event) => event.type === 'appointment')
    .map((event, index) => ({
      id: String(event.data?.id || `${contact?.id || 'contact'}-journey-appointment-${index}`),
      title: String(event.data?.title || 'Cita'),
      status: event.data?.status || null,
      startTime: String(event.data?.start_time || event.date),
      endTime: event.data?.end_time ? String(event.data.end_time) : null,
      notes: event.data?.notes ? String(event.data.notes) : null,
      calendarId: event.data?.calendar_id || event.data?.calendarId || null,
      locationId: event.data?.location_id || event.data?.locationId || null,
      address: event.data?.address || event.data?.location || null,
      assignedUserId: event.data?.assigned_user_id || event.data?.assignedUserId || null
    }))
    .sort((left, right) => Date.parse(left.startTime) - Date.parse(right.startTime))
}

function isSuccessfulPayment(payment: ContactInfoPayment) {
  const status = String(payment.status || '').trim().toLowerCase()
  return payment.amount > 0 && (!status || SUCCESS_PAYMENT_STATUSES.has(status))
}

function isActiveAppointment(appointment: ContactInfoAppointment) {
  const status = String(appointment.status || '').trim().toLowerCase()
  return !status || !CANCELED_APPOINTMENT_STATUSES.has(status)
}

function normalizeCalendarAppointmentStatus(status?: string | null): CalendarEvent['appointmentStatus'] {
  const normalized = String(status || '').trim().toLowerCase()
  if (normalized === 'pending') return 'pending'
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled'
  if (normalized === 'showed' || normalized === 'attended') return 'showed'
  if (normalized === 'noshow' || normalized === 'no_show') return 'noshow'
  if (normalized === 'rescheduled') return 'rescheduled'
  return 'confirmed'
}

function toCalendarEvent(
  appointment: ContactInfoAppointment,
  contact: Contact | DesktopChatContact | null,
  fallbackCalendar: Calendar | null,
  fallbackLocationId: string | null | undefined,
  fallbackTimeZone: string
): CalendarEvent {
  const parsedStart = new Date(appointment.startTime)
  const startTime = Number.isNaN(parsedStart.getTime()) ? new Date().toISOString() : parsedStart.toISOString()
  const parsedEnd = appointment.endTime ? new Date(appointment.endTime) : new Date(Date.parse(startTime) + 60 * 60 * 1000)
  const endTime = Number.isNaN(parsedEnd.getTime()) ? new Date(Date.parse(startTime) + 60 * 60 * 1000).toISOString() : parsedEnd.toISOString()

  return {
    id: appointment.id,
    title: appointment.title || getContactName(contact),
    calendarId: appointment.calendarId || fallbackCalendar?.id || '',
    locationId: appointment.locationId || fallbackLocationId || '',
    contactId: contact?.id,
    appointmentStatus: normalizeCalendarAppointmentStatus(appointment.status),
    assignedUserId: appointment.assignedUserId || undefined,
    address: appointment.address || undefined,
    notes: appointment.notes || undefined,
    startTime,
    endTime,
    dateAdded: startTime,
    timeZone: fallbackCalendar?.timeZone || fallbackTimeZone
  }
}

function getTrackingData(contact?: Contact | null, journey: JourneyEvent[] = []) {
  const firstSession = contact?.firstSession || null
  const firstPageVisit = journey.find((event) => event.type === 'page_visit')
  const pageData = firstPageVisit?.data || {}
  const attributionSource = contact?.whatsappAttributionPlatform || contact?.attribution_session_source || contact?.source || null
  return {
    started_at: firstSession?.started_at || firstPageVisit?.date || contact?.createdAt || null,
    page_url: firstSession?.page_url || firstSession?.landing_page || pageData.page_url || pageData.landing_page || contact?.attribution_url || null,
    utm_source: firstSession?.utm_source || pageData.utm_source || attributionSource,
    utm_campaign: firstSession?.utm_campaign || pageData.utm_campaign || null,
    ad_name: firstSession?.ad_name || pageData.ad_name || contact?.ad_name || null,
    source_platform: firstSession?.source_platform || pageData.source_platform || attributionSource
  }
}

function normalizeHighLevelChannel(value?: string | null): HighLevelChatChannel {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized.includes('instagram')) return 'instagram'
  if (normalized.includes('messenger') || normalized.includes('facebook')) return 'messenger'
  if (normalized.includes('sms') || normalized.includes('qr')) return 'sms_qr'
  return 'whatsapp_api'
}

function getSelectedBusinessPhone(status?: WhatsAppApiStatus | null): WhatsAppApiPhoneNumber | null {
  const phones = status?.phoneNumbers || []
  return status?.selectedPhone || phones.find((phone) => phone.is_default_sender) || phones[0] || null
}

function getBusinessPhoneValue(phone?: WhatsAppApiPhoneNumber | null) {
  return phone?.display_phone_number || phone?.phone_number || ''
}

function getDefaultAppointmentRange(timeZone: string) {
  const start = new Date(Date.now() + 60 * 60 * 1000)
  start.setMinutes(0, 0, 0)
  const end = new Date(start.getTime() + 60 * 60 * 1000)
  return { start: start.toISOString(), end: end.toISOString(), timeZone }
}

function toChatContact(contact: Contact): DesktopChatContact {
  return { ...contact, messageCount: 0, unreadCount: 0 }
}

export const DesktopChat: React.FC = () => {
  const { accessToken, locationId } = useAuth()
  const { labels } = useLabels()
  const { showToast } = useNotification()
  const { timezone, formatLocalDateTime } = useTimezone()
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const chatsRequestRef = useRef<AbortController | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const documentInputRef = useRef<HTMLInputElement | null>(null)
  const composerMenuRef = useRef<HTMLDivElement | null>(null)
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtRef = useRef(0)
  const voiceTimerRef = useRef<number | null>(null)
  const messageAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const chatsRef = useRef<DesktopChatContact[]>([])
  const activeContactIdRef = useRef('')
  const chatLiveRefreshTimeoutRef = useRef<number | null>(null)
  const chatLiveRefreshInFlightRef = useRef(false)
  const chatLiveRefreshQueuedRef = useRef(false)
  const archivedChatIdSetRef = useRef<Set<string>>(new Set())
  const removedChatStatesRef = useRef<RemovedChatState[]>([])
  const agentPriorityChatIdSetRef = useRef<Set<string>>(new Set())

  const [chats, setChats] = useState<DesktopChatContact[]>(() => readCachedChatList())
  const [chatsLoading, setChatsLoading] = useState(() => readCachedChatList().length === 0)
  const [chatsError, setChatsError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedChatFilters>(DEFAULT_ADVANCED_FILTERS)
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [archivedViewOpen, setArchivedViewOpen] = useState(false)
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>(() => readStoredChatIds(CHAT_ARCHIVED_STATE_KEY))
  const [removedChatStates, setRemovedChatStates] = useState<RemovedChatState[]>(() => readStoredRemovedChatStates())
  const [activeContactId, setActiveContactId] = useState<string>('')

  const [messages, setMessages] = useState<DesktopChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState('')
  const [contactJourney, setContactJourney] = useState<JourneyEvent[]>([])
  const [contactInfoData, setContactInfoData] = useState<Contact | null>(null)
  const [contactInfoLoading, setContactInfoLoading] = useState(false)
  const [infoPanelView, setInfoPanelView] = useState<InfoPanelView>('summary')

  const [composerText, setComposerText] = useState('')
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => createDefaultScheduleDraft())
  const [scheduleEditingMessageId, setScheduleEditingMessageId] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [schedulingMessage, setSchedulingMessage] = useState(false)
  const [cancelingScheduledMessageId, setCancelingScheduledMessageId] = useState<string | null>(null)
  const [draftAttachments, setDraftAttachments] = useState<DesktopDraftAttachment[]>([])
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftAttachment | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [playingAudioId, setPlayingAudioId] = useState('')
  const [messageAudioProgress, setMessageAudioProgress] = useState<Record<string, { currentTime: number; duration: number }>>({})
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [conversationAgentEnabled, setConversationAgentEnabled] = useState(false)
  const [conversationAgentState, setConversationAgentState] = useState<ConversationAgentState | null>(null)
  const [agentStates, setAgentStates] = useState<Record<string, ConversationAgentState>>({})
  const [agentDefs, setAgentDefs] = useState<ConversationalAgentDef[]>([])
  const [agentComposerMenuOpen, setAgentComposerMenuOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [conversationAgentBusy, setConversationAgentBusy] = useState(false)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [calendarsLoading, setCalendarsLoading] = useState(false)
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [editingAppointmentEvent, setEditingAppointmentEvent] = useState<CalendarEvent | null>(null)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [savingTags, setSavingTags] = useState(false)
  const [automationModalOpen, setAutomationModalOpen] = useState(false)
  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [automationsLoading, setAutomationsLoading] = useState(false)
  const [selectedAutomationId, setSelectedAutomationId] = useState('')
  const [automationSubmitting, setAutomationSubmitting] = useState(false)

  const activeContact = useMemo(
    () => chats.find((contact) => contact.id === activeContactId) || null,
    [activeContactId, chats]
  )
  const selectedBusinessPhone = useMemo(() => getSelectedBusinessPhone(whatsappStatus), [whatsappStatus])
  const selectedBusinessPhoneValue = getBusinessPhoneValue(selectedBusinessPhone)
  const whatsappConnected = Boolean(whatsappStatus?.connected && selectedBusinessPhoneValue)
  const selectedCalendar = useMemo(
    () => calendars.find((calendar) => calendar.id === selectedCalendarId) || calendars[0] || null,
    [calendars, selectedCalendarId]
  )
  const defaultAppointmentRange = useMemo(
    () => getDefaultAppointmentRange(selectedCalendar?.timeZone || timezone),
    [selectedCalendar?.timeZone, timezone]
  )
  const contactPayments = useMemo(
    () => getContactInfoPayments(contactInfoData || activeContact, contactJourney),
    [activeContact, contactInfoData, contactJourney]
  )
  const contactAppointments = useMemo(
    () => getContactInfoAppointments(contactInfoData || activeContact, contactJourney),
    [activeContact, contactInfoData, contactJourney]
  )
  const trackingData = useMemo(
    () => getTrackingData(contactInfoData || activeContact, contactJourney),
    [activeContact, contactInfoData, contactJourney]
  )
  const stageBadge = useMemo(
    () => getContactStageBadge(contactInfoData || activeContact || undefined, labels),
    [activeContact, contactInfoData, labels]
  )
  const stageLabel = stageBadge?.text || labels.lead
  const activeAdvancedFilterCount = useMemo(() => countAdvancedFilters(advancedFilters), [advancedFilters])
  const archivedChatIdSet = useMemo(() => new Set(archivedChatIds), [archivedChatIds])
  const removedChatStateMap = useMemo(() => new Map(removedChatStates.map((state) => [state.contactId, state])), [removedChatStates])
  const visibleChatsForList = useMemo(
    () => chats.filter((contact) => !isChatRemovedFromList(contact, removedChatStateMap.get(contact.id))),
    [chats, removedChatStateMap]
  )
  const archivedChatCount = useMemo(
    () => visibleChatsForList.filter((contact) => archivedChatIdSet.has(contact.id)).length,
    [archivedChatIdSet, visibleChatsForList]
  )
  const agentPriorityStates = useMemo(
    () => conversationAgentEnabled
      ? Object.values(agentStates).filter((state) => Boolean(state.signal) && state.signal !== 'discarded')
      : [],
    [agentStates, conversationAgentEnabled]
  )
  const agentPriorityChatIdSet = useMemo(
    () => new Set(agentPriorityStates.map((state) => state.contactId)),
    [agentPriorityStates]
  )
  const agentActiveChatIdSet = useMemo(
    () => conversationAgentEnabled
      ? new Set(
          Object.values(agentStates)
            .filter((state) => state.status === 'active' && state.signal !== 'discarded')
            .map((state) => state.contactId)
        )
      : new Set<string>(),
    [agentStates, conversationAgentEnabled]
  )
  const agentAssignedChatCount = useMemo(
    () => visibleChatsForList.filter((contact) => !archivedChatIdSet.has(contact.id) && agentActiveChatIdSet.has(contact.id)).length,
    [agentActiveChatIdSet, archivedChatIdSet, visibleChatsForList]
  )
  const listBaseChats = useMemo(
    () => visibleChatsForList.filter((contact) => {
      if (chatFilter === 'agent') return !archivedChatIdSet.has(contact.id) && agentActiveChatIdSet.has(contact.id)
      if (archivedViewOpen) return archivedChatIdSet.has(contact.id)
      if (archivedChatIdSet.has(contact.id)) return false
      if (agentPriorityChatIdSet.has(contact.id)) return false
      return true
    }),
    [agentActiveChatIdSet, agentPriorityChatIdSet, archivedChatIdSet, archivedViewOpen, chatFilter, visibleChatsForList]
  )
  const agentAssignedViewOpen = chatFilter === 'agent'
  const hasTextOrAdvancedChatFilters = Boolean(chatQuery.trim()) || activeAdvancedFilterCount > 0
  const hasActiveChatFilters = hasTextOrAdvancedChatFilters || chatFilter !== 'all'
  const filteredChats = useMemo(() => {
    return listBaseChats
      .filter((contact) => contactMatchesQuery(contact, chatQuery))
      .filter((contact) => contactMatchesAdvancedFilters(contact, advancedFilters))
      .filter((contact) => {
        if (chatFilter === 'agent') return true
        if (chatFilter === 'unread') return Number(contact.unreadCount || 0) > 0
        if (chatFilter === 'appointments') return Boolean(contact.hasAppointments || contact.nextAppointmentDate)
        if (chatFilter === 'customers') return contact.status === 'customer'
        return true
      })
  }, [advancedFilters, chatFilter, chatQuery, listBaseChats])
  const agentPriorityChatRows = useMemo(() => {
    if (archivedViewOpen || chatFilter !== 'all' || chatQuery.trim() || activeAdvancedFilterCount > 0) return []
    return visibleChatsForList
      .filter((contact) => agentPriorityChatIdSet.has(contact.id) && !archivedChatIdSet.has(contact.id))
      .sort((left, right) => {
        const leftState = agentStates[left.id]
        const rightState = agentStates[right.id]
        return Date.parse(rightState?.signalAt || right.lastMessageDate || right.createdAt) -
          Date.parse(leftState?.signalAt || left.lastMessageDate || left.createdAt)
      })
  }, [activeAdvancedFilterCount, agentPriorityChatIdSet, agentStates, archivedChatIdSet, archivedViewOpen, chatFilter, chatQuery, visibleChatsForList])
  useEffect(() => {
    chatsRef.current = chats
  }, [chats])
  useEffect(() => {
    activeContactIdRef.current = activeContactId
  }, [activeContactId])
  useEffect(() => {
    archivedChatIdSetRef.current = archivedChatIdSet
  }, [archivedChatIdSet])
  useEffect(() => {
    removedChatStatesRef.current = removedChatStates
  }, [removedChatStates])
  useEffect(() => {
    agentPriorityChatIdSetRef.current = agentPriorityChatIdSet
  }, [agentPriorityChatIdSet])
  useEffect(() => {
    if (activeContactId || chats.length === 0) return
    const archivedSet = archivedChatIdSetRef.current
    const agentSet = agentPriorityChatIdSetRef.current
    setActiveContactId(getDefaultActiveChatId(chats, archivedSet, agentSet, removedChatStates))
  }, [activeContactId, chats, removedChatStates])
  useEffect(() => {
    if (!activeContact) return
    if (!isChatRemovedFromList(activeContact, removedChatStateMap.get(activeContact.id))) return
    setActiveContactId(getDefaultActiveChatId(
      chats.filter((contact) => contact.id !== activeContact.id),
      archivedChatIdSet,
      agentPriorityChatIdSet,
      removedChatStates
    ))
  }, [activeContact, agentPriorityChatIdSet, archivedChatIdSet, chats, removedChatStateMap, removedChatStates])
  useEffect(() => {
    if (!composerMenuOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && composerMenuRef.current?.contains(target)) return
      setComposerMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setComposerMenuOpen(false)
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [composerMenuOpen])
  const visibleChatCount = filteredChats.length + agentPriorityChatRows.length
  const inboxTitle = archivedViewOpen ? 'Archivados' : agentAssignedViewOpen ? 'Chats del bot' : 'Conversaciones'
  const inboxSubtitle = archivedViewOpen
    ? `${filteredChats.length} de ${archivedChatCount} archivados`
    : agentAssignedViewOpen
    ? `${filteredChats.length} de ${agentAssignedChatCount} asignados al bot`
    : `${visibleChatCount} de ${Math.max(0, visibleChatsForList.length - archivedChatCount)} visibles`
  const emptyChatTitle = archivedViewOpen
    ? 'No hay chats archivados'
    : agentAssignedViewOpen
    ? hasTextOrAdvancedChatFilters ? 'No encontré chats del bot' : 'Sin chats del bot'
    : hasActiveChatFilters ? 'No encontré chats' : chats.length === 0 ? 'Todavía no hay conversaciones' : 'No hay chats en esta vista'
  const emptyChatDescription = archivedViewOpen
    ? 'Cuando archives una conversación, aparecerá en esta sección.'
    : agentAssignedViewOpen
    ? hasTextOrAdvancedChatFilters
      ? 'Prueba con menos filtros o busca otro contacto atendido por el bot.'
      : conversationAgentEnabled
      ? 'Cuando el bot esté atendiendo una conversación activa, aparecerá aquí.'
      : 'Cuando enciendas el agente conversacional y tome chats, aparecerán aquí.'
    : hasActiveChatFilters
    ? 'Prueba con menos filtros o busca otro contacto.'
    : chats.length === 0
    ? 'Cuando lleguen mensajes, aparecerán aquí con su canal, estado y último movimiento.'
    : 'Cuando llegue un mensaje nuevo, aparecerá aquí.'
  const resetChatFiltersLabel = agentAssignedViewOpen && !hasTextOrAdvancedChatFilters ? 'Volver a conversaciones' : 'Limpiar filtros'
  const messageGroups = useMemo(() => {
    const groups: Array<{ key: string; label: string; messages: DesktopChatMessage[] }> = []
    messages.forEach((message) => {
      const key = getConversationDayKey(message.date, timezone) || 'unknown'
      const current = groups[groups.length - 1]
      if (!current || current.key !== key) {
        groups.push({ key, label: getConversationDayLabel(message.date, timezone), messages: [message] })
        return
      }
      current.messages.push(message)
    })
    return groups
  }, [messages, timezone])
  const activeConversationChannel = normalizeHighLevelChannel(activeContact?.lastMessageChannel || messages[messages.length - 1]?.transport || '')
  const hasComposerContent = Boolean(composerText.trim()) || draftAttachments.length > 0 || Boolean(voiceDraft)
  const canSend = Boolean(activeContact && hasComposerContent && composerStatus === 'idle' && !voiceRecording && !voiceProcessing)
  const conversationAgentActive = conversationAgentEnabled && conversationAgentState?.status === 'active'
  const activeAgentDef = useMemo(
    () => agentDefs.find((agent) => agent.id === conversationAgentState?.agentId) || null,
    [agentDefs, conversationAgentState?.agentId]
  )
  const availableAgentDefs = useMemo(
    () => agentDefs.filter((agent) => agent.enabled),
    [agentDefs]
  )
  const conversationAgentStatusLabel = conversationAgentState
    ? CONVERSATION_AGENT_STATUS_LABELS[conversationAgentState.status] || 'Agente conversacional'
    : 'Sin agente asignado'
  const advancedFilterGroups = useMemo(() => ([
    {
      id: 'channel',
      label: 'Canal',
      value: advancedFilters.channel,
      options: CHANNEL_FILTER_OPTIONS,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, channel: value as AdvancedChannelFilter }))
    },
    {
      id: 'origin',
      label: 'Origen',
      value: advancedFilters.origin,
      options: ORIGIN_FILTER_OPTIONS,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, origin: value as AdvancedOriginFilter }))
    },
    {
      id: 'social',
      label: 'Red social',
      value: advancedFilters.social,
      options: SOCIAL_FILTER_OPTIONS,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, social: value as AdvancedSocialFilter }))
    },
    {
      id: 'stage',
      label: 'Etapa',
      value: advancedFilters.stage,
      options: STAGE_FILTER_OPTIONS,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, stage: value as AdvancedStageFilter }))
    },
    {
      id: 'activity',
      label: 'Actividad',
      value: advancedFilters.activity,
      options: ACTIVITY_FILTER_OPTIONS,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, activity: value as AdvancedActivityFilter }))
    }
  ]), [advancedFilters])

  const loadChats = useCallback(async (options: { silent?: boolean } = {}) => {
    const silent = options.silent === true
    if (!silent) {
      setChatsError('')
      if (chatsRef.current.length === 0) {
        setChatsLoading(true)
      }
    }

    chatsRequestRef.current?.abort()
    const controller = new AbortController()
    chatsRequestRef.current = controller
    const timeoutId = window.setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS)

    try {
      const data = await apiClient.get<DesktopChatContact[]>('/contacts/chats', {
        params: {
          limit: '80'
        },
        signal: controller.signal
      })
      const nextChats = Array.isArray(data) ? data : []
      writeCachedChatList(nextChats)
      setRemovedChatStates((current) => pruneRevealedRemovedChatStates(current, nextChats))
      setChats(nextChats)
      setActiveContactId((current) => {
        const removedStates = removedChatStatesRef.current
        if (current && nextChats.some((contact) => contact.id === current && !isChatRemovedFromList(contact, getRemovedChatState(removedStates, contact.id)))) return current
        const archivedSet = archivedChatIdSetRef.current
        const agentSet = agentPriorityChatIdSetRef.current
        return getDefaultActiveChatId(nextChats, archivedSet, agentSet, removedStates)
      })
    } catch (error: any) {
      if (controller.signal.aborted && chatsRequestRef.current !== controller) return
      if (!silent) {
        const timedOut = controller.signal.aborted || error?.name === 'AbortError'
        setChatsError(timedOut ? 'Los chats tardaron demasiado en cargar. Intenta otra vez.' : 'No se pudieron cargar los chats.')
        setChats([])
      }
    } finally {
      window.clearTimeout(timeoutId)
      if (chatsRequestRef.current === controller) {
        chatsRequestRef.current = null
        setChatsLoading(false)
      }
    }
  }, [])

  const loadConversation = useCallback(async (contactId: string, options: { silent?: boolean } = {}) => {
    if (!contactId) return
    const silent = options.silent === true
    if (!silent) {
      setMessagesLoading(true)
      setContactInfoLoading(true)
      setConversationAgentState(null)
    }
    setMessagesError('')
    try {
      const [journey, scheduledMessages, details, agentState] = await Promise.all([
        contactsService.getContactJourney(contactId, { includeBusinessMessages: true }),
        whatsappApiService.getScheduledMessages(contactId).catch(() => []),
        contactsService.getContactDetails(contactId).catch(() => null),
        conversationalAgentService.getState(contactId).catch(() => null)
      ])
      const journeyMessages = journey.map(getJourneyMessage).filter((message): message is DesktopChatMessage => Boolean(message))
      const scheduledBubbles = scheduledMessages.map(getScheduledChatMessageBubble).filter((message): message is DesktopChatMessage => Boolean(message))
      setContactJourney(journey)
      setContactInfoData(details)
      setConversationAgentState(agentState)
      setAgentStates((current) => (agentState ? { ...current, [contactId]: agentState } : current))
      setMessages([...journeyMessages, ...scheduledBubbles].sort((left, right) => Date.parse(left.date) - Date.parse(right.date)))
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, unreadCount: 0 } : contact))
    } catch {
      if (!silent) {
        setMessages([])
        setContactJourney([])
        setContactInfoData(null)
        setConversationAgentState(null)
        setMessagesError('No se pudo cargar la conversación.')
      }
    } finally {
      if (!silent) {
        setMessagesLoading(false)
        setContactInfoLoading(false)
      }
    }
  }, [])

  const loadSupportData = useCallback(async () => {
    setCalendarsLoading(true)
    try {
      const [status, highLevelConfig, calendarList, conversationalConfig, agentList] = await Promise.all([
        whatsappApiService.getStatus().catch(() => null),
        highLevelService.getConfig().catch(() => ({ configured: false })),
        calendarsService.getCalendars(locationId, accessToken).catch(() => []),
        conversationalAgentService.getConfig().catch(() => null),
        conversationalAgentService.listAgents().catch(() => [] as ConversationalAgentDef[])
      ])
      const stateList = await conversationalAgentService.listStates().catch(() => [] as ConversationAgentState[])
      setWhatsappStatus(status)
      setHighLevelConnected(Boolean(highLevelConfig?.configured))
      setConversationAgentEnabled(Boolean(conversationalConfig?.enabled))
      setAgentStates(mapAgentStatesByContactId(stateList))
      setAgentDefs(agentList)
      setCalendars(calendarList)
      setSelectedCalendarId((current) => current || calendarList[0]?.id || '')
    } finally {
      setCalendarsLoading(false)
    }
  }, [accessToken, locationId])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void loadChats({ silent: true })
      void conversationalAgentService.listStates()
        .then((states) => setAgentStates(mapAgentStatesByContactId(states)))
        .catch(() => null)
    }, CHAT_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [loadChats])

  const refreshFromLiveChatEvent = useCallback((event?: ChatLiveMessageEvent) => {
    if (chatLiveRefreshTimeoutRef.current !== null) {
      window.clearTimeout(chatLiveRefreshTimeoutRef.current)
    }

    chatLiveRefreshTimeoutRef.current = window.setTimeout(() => {
      chatLiveRefreshTimeoutRef.current = null
      if (chatLiveRefreshInFlightRef.current) {
        chatLiveRefreshQueuedRef.current = true
        return
      }

      chatLiveRefreshInFlightRef.current = true
      const eventContactId = event?.contactId || ''
      const openContactId = activeContactIdRef.current
      const shouldRefreshOpenConversation = Boolean(
        openContactId &&
        (!eventContactId || eventContactId === openContactId)
      )

      Promise.all([
        loadChats({ silent: true }),
        shouldRefreshOpenConversation
          ? loadConversation(openContactId, { silent: true })
          : Promise.resolve()
      ])
        .finally(() => {
          chatLiveRefreshInFlightRef.current = false
          if (chatLiveRefreshQueuedRef.current) {
            chatLiveRefreshQueuedRef.current = false
            refreshFromLiveChatEvent()
          }
        })
    }, 250)
  }, [loadChats, loadConversation])

  useEffect(() => {
    return subscribeToChatLiveEvents({
      onMessage: refreshFromLiveChatEvent
    })
  }, [refreshFromLiveChatEvent])

  useEffect(() => {
    writeStoredChatIds(CHAT_ARCHIVED_STATE_KEY, archivedChatIds)
  }, [archivedChatIds])

  useEffect(() => {
    writeStoredRemovedChatStates(removedChatStates)
  }, [removedChatStates])

  useEffect(() => {
    setAgentComposerMenuOpen(false)
    setAgentPickerOpen(false)
  }, [activeContactId])

  useEffect(() => () => {
    chatsRequestRef.current?.abort()
    if (chatLiveRefreshTimeoutRef.current !== null) {
      window.clearTimeout(chatLiveRefreshTimeoutRef.current)
      chatLiveRefreshTimeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    loadSupportData()
  }, [loadSupportData])

  useEffect(() => {
    if (!activeContactId) {
      setMessages([])
      setContactJourney([])
      setContactInfoData(null)
      setConversationAgentState(null)
      return
    }
    setInfoPanelView('summary')
    loadConversation(activeContactId)
  }, [activeContactId, loadConversation])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, messagesLoading])

  const clearVoiceTimer = useCallback(() => {
    if (voiceTimerRef.current) {
      window.clearInterval(voiceTimerRef.current)
      voiceTimerRef.current = null
    }
  }, [])

  const stopVoiceStream = useCallback(() => {
    voiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    voiceStreamRef.current = null
  }, [])

  useEffect(() => () => {
    clearVoiceTimer()
    stopVoiceStream()
    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
    }
  }, [clearVoiceTimer, stopVoiceStream])

  const startVoiceRecording = useCallback(async () => {
    if (voiceRecording || voiceProcessing || voiceDraft) return

    if (!activeContact?.phone) {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar audio por WhatsApp.')
      return
    }

    if (!whatsappConnected) {
      showToast('warning', 'Conecta WhatsApp para audio', 'Los mensajes de voz salen por WhatsApp API.')
      return
    }

    if (composerText.trim() || draftAttachments.length > 0) {
      showToast('info', 'Manda primero lo pendiente', 'Envía o borra el texto/foto antes de grabar audio.')
      return
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      showToast('error', 'No se pudo grabar aquí', 'Este navegador necesita permiso de micrófono para mandar audio.')
      return
    }

    try {
      const mimeType = getSupportedVoiceMimeType()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)

      voiceChunksRef.current = []
      voiceStreamRef.current = stream
      voiceRecorderRef.current = recorder
      voiceStartedAtRef.current = Date.now()
      setVoiceElapsedMs(0)
      setVoiceRecording(true)
      setVoiceProcessing(false)

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          voiceChunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        showToast('error', 'No se pudo grabar', 'Revisa el permiso del micrófono e intenta otra vez.')
        clearVoiceTimer()
        stopVoiceStream()
        setVoiceRecording(false)
        setVoiceProcessing(false)
      }

      recorder.onstop = async () => {
        const chunks = [...voiceChunksRef.current]
        const durationMs = Date.now() - voiceStartedAtRef.current
        const recordedType = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm'

        clearVoiceTimer()
        stopVoiceStream()
        setVoiceRecording(false)
        voiceRecorderRef.current = null
        voiceChunksRef.current = []

        setVoiceProcessing(true)
        try {
          const blob = new Blob(chunks, { type: recordedType })
          if (durationMs < MIN_VOICE_RECORDING_MS || blob.size === 0) {
            showToast('info', 'Audio muy corto', 'Graba un poquito más para poder enviarlo.')
            setVoiceElapsedMs(0)
            setVoiceProcessing(false)
            return
          }
          if (blob.size > MAX_VOICE_MESSAGE_BYTES) {
            showToast('error', 'Audio muy pesado', 'Graba un audio más corto para enviarlo por WhatsApp.')
            setVoiceElapsedMs(0)
            setVoiceProcessing(false)
            return
          }

          const dataUrl = await readBlobAsDataUrl(blob)
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
          setVoiceElapsedMs(0)
          setVoiceProcessing(false)
        }
      }

      recorder.start()
      clearVoiceTimer()
      voiceTimerRef.current = window.setInterval(() => {
        setVoiceElapsedMs(Date.now() - voiceStartedAtRef.current)
      }, 250)
    } catch (error: any) {
      clearVoiceTimer()
      stopVoiceStream()
      setVoiceRecording(false)
      setVoiceProcessing(false)
      showToast('error', 'No se abrió el micrófono', error?.message || 'Revisa permisos del navegador.')
    }
  }, [activeContact?.phone, clearVoiceTimer, composerText, draftAttachments.length, showToast, stopVoiceStream, voiceDraft, voiceProcessing, voiceRecording, whatsappConnected])

  const stopVoiceRecording = useCallback(() => {
    const recorder = voiceRecorderRef.current
    if (recorder && recorder.state === 'recording') {
      recorder.stop()
      return
    }
    clearVoiceTimer()
    stopVoiceStream()
    setVoiceRecording(false)
  }, [clearVoiceTimer, stopVoiceStream])

  const cancelVoiceDraft = useCallback(() => {
    stopVoiceRecording()
    setVoiceDraft(null)
    setVoiceElapsedMs(0)
    setVoiceProcessing(false)
  }, [stopVoiceRecording])

  const handleVoiceButtonClick = useCallback(() => {
    if (voiceProcessing || composerStatus === 'sending') return
    if (voiceRecording) {
      stopVoiceRecording()
      return
    }
    if (voiceDraft) {
      cancelVoiceDraft()
      return
    }
    void startVoiceRecording()
  }, [cancelVoiceDraft, composerStatus, startVoiceRecording, stopVoiceRecording, voiceDraft, voiceProcessing, voiceRecording])

  const ensureContactInList = useCallback((contact: Contact) => {
    const nextContact = toChatContact(contact)
    setChats((current) => current.some((item) => item.id === nextContact.id) ? current : [nextContact, ...current])
    setActiveContactId(nextContact.id)
  }, [])

  const handleSearchContacts = useCallback(async () => {
    const trimmed = chatQuery.trim()
    if (trimmed.length < 2) return
    const results = await contactsService.searchContacts(trimmed)
    if (results[0]) ensureContactInList(results[0])
  }, [chatQuery, ensureContactInList])

  const addDraftAttachment = useCallback((attachment: DesktopDraftAttachment) => {
    setDraftAttachments((current) => [attachment, ...current].slice(0, 4))
    showToast('success', attachment.kind === 'image' ? 'Foto lista' : 'Documento listo', 'Revisa la vista previa y manda el mensaje.')
  }, [showToast])

  const readImageFile = useCallback((file: File, source: 'photos') => {
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Archivo no válido', 'Elige una foto JPG, PNG o WebP.')
      return
    }

    if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
      showToast('error', 'La foto pesa demasiado', 'Elige una foto de menos de 8 MB.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        showToast('error', 'No se pudo leer', 'Intenta elegir la foto otra vez.')
        return
      }

      addDraftAttachment({
        id: `${source}-${Date.now()}`,
        kind: 'image',
        name: file.name || `foto-${Date.now()}`,
        mimeType: file.type || 'image/jpeg',
        dataUrl,
        size: file.size
      })
    }
    reader.onerror = () => showToast('error', 'No se pudo leer', 'Intenta elegir la foto otra vez.')
    reader.readAsDataURL(file)
  }, [addDraftAttachment, showToast])

  const readDocumentFile = useCallback((file: File) => {
    if (!isSupportedDocumentFile(file)) {
      showToast('error', 'Archivo no válido', 'Elige un PDF, Word, Excel, PowerPoint, TXT o CSV.')
      return
    }

    if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
      showToast('error', 'Archivo muy pesado', 'Elige un documento de menos de 20 MB.')
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

      addDraftAttachment({
        id: `document-${Date.now()}`,
        kind: 'document',
        name: file.name || `documento-${Date.now()}`,
        mimeType,
        dataUrl,
        size: file.size
      })
    }
    reader.onerror = () => showToast('error', 'No se pudo leer', 'Intenta elegir el documento otra vez.')
    reader.readAsDataURL(file)
  }, [addDraftAttachment, showToast])

  const handleImageSelected = useCallback((source: 'photos', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    readImageFile(file, source)
    setComposerMenuOpen(false)
  }, [readImageFile])

  const handleDocumentSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    readDocumentFile(file)
    setComposerMenuOpen(false)
  }, [readDocumentFile])

  const removeDraftAttachment = useCallback((attachmentId: string) => {
    setDraftAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }, [])

  const handleComposerMenuAction = useCallback((action: 'templates' | 'photos' | 'documents' | 'location' | 'clabe') => {
    if (action === 'photos') {
      photoInputRef.current?.click()
      return
    }
    if (action === 'documents') {
      documentInputRef.current?.click()
      return
    }
    if (action === 'templates') {
      setComposerText('Hola, te comparto la información en un momento.')
      setComposerMenuOpen(false)
      return
    }
    showToast('info', action === 'location' ? 'Ubicación' : 'CLABE', 'Esta opción ya está en el menú. La conexión completa queda lista para el siguiente paso.')
    setComposerMenuOpen(false)
  }, [showToast])

  const handleUpdateContactTags = useCallback(async (tagIds: string[]) => {
    if (!activeContact?.id) return
    const previousTags = (contactInfoData || activeContact).tags || []
    setSavingTags(true)
    setContactInfoData((current) => current?.id === activeContact.id ? { ...current, tags: tagIds } : current)
    setChats((current) => current.map((contact) => contact.id === activeContact.id ? { ...contact, tags: tagIds } : contact))
    try {
      const updated = await contactsService.updateContact(activeContact.id, { tags: tagIds } as Partial<Contact>)
      const nextTags = Array.isArray(updated.tags) ? updated.tags : tagIds
      setContactInfoData((current) => current?.id === activeContact.id ? { ...current, ...updated, tags: nextTags } : current)
      setChats((current) => current.map((contact) => contact.id === activeContact.id ? { ...contact, tags: nextTags } : contact))
    } catch (error: any) {
      setContactInfoData((current) => current?.id === activeContact.id ? { ...current, tags: previousTags } : current)
      setChats((current) => current.map((contact) => contact.id === activeContact.id ? { ...contact, tags: previousTags } : contact))
      showToast('error', 'No se guardaron las etiquetas', error?.message || 'Intenta otra vez.')
    } finally {
      setSavingTags(false)
    }
  }, [activeContact, contactInfoData, showToast])

  const openNewAppointment = useCallback(() => {
    setEditingAppointmentEvent(null)
    setAppointmentOpen(true)
  }, [])

  const openAppointmentForEdit = useCallback((appointment: ContactInfoAppointment) => {
    if (!activeContact || !isActiveAppointment(appointment)) return
    setEditingAppointmentEvent(toCalendarEvent(
      appointment,
      contactInfoData || activeContact,
      selectedCalendar,
      locationId,
      selectedCalendar?.timeZone || timezone
    ))
    setAppointmentOpen(true)
  }, [activeContact, contactInfoData, locationId, selectedCalendar, timezone])

  const handleSaveAppointment = async (eventIdOrPayload: string | Partial<CalendarEvent>, updates?: Partial<CalendarEvent>) => {
    if (typeof eventIdOrPayload === 'string') {
      if (!updates) return
      await calendarsService.updateAppointment(eventIdOrPayload, updates, accessToken || undefined)
      setAppointmentOpen(false)
      setEditingAppointmentEvent(null)
      showToast('success', 'Cita actualizada', 'Los cambios quedaron guardados.')
      if (activeContactId) await loadConversation(activeContactId)
      return
    }

    await calendarsService.createAppointment(eventIdOrPayload, accessToken || undefined)
    setAppointmentOpen(false)
    setEditingAppointmentEvent(null)
    showToast('success', 'Cita agendada', 'La cita quedó guardada para este contacto.')
    if (activeContactId) await loadConversation(activeContactId)
  }

  const handleDeleteAppointment = async (eventId: string) => {
    await calendarsService.deleteEvent(eventId, accessToken || undefined)
    setAppointmentOpen(false)
    setEditingAppointmentEvent(null)
    showToast('success', 'Cita eliminada', 'La cita se eliminó correctamente.')
    if (activeContactId) await loadConversation(activeContactId)
  }

  const updateActiveConversationAgentState = useCallback((nextState: ConversationAgentState) => {
    setConversationAgentState(nextState)
    setAgentStates((current) => ({ ...current, [nextState.contactId]: nextState }))
  }, [])

  const closeComposerAgentMenu = useCallback(() => {
    setAgentComposerMenuOpen(false)
    setAgentPickerOpen(false)
  }, [])

  const handleOpenComposerAgentMenu = useCallback(() => {
    if (!activeContact?.id || conversationAgentBusy) return
    setComposerMenuOpen(false)
    setAgentComposerMenuOpen((current) => {
      const nextOpen = !current
      setAgentPickerOpen(nextOpen && (!conversationAgentActive || !conversationAgentState?.agentId))
      return nextOpen
    })
  }, [activeContact?.id, conversationAgentActive, conversationAgentBusy, conversationAgentState?.agentId])

  const closeScheduleModal = useCallback(() => {
    if (schedulingMessage) return
    setScheduleOpen(false)
    setScheduleEditingMessageId(null)
    setScheduleError('')
  }, [schedulingMessage])

  const handleOpenScheduleModal = useCallback(() => {
    if (!activeContact) return
    setComposerMenuOpen(false)
    closeComposerAgentMenu()

    if (!composerText.trim()) {
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
    setScheduleOpen(true)
  }, [activeContact, closeComposerAgentMenu, composerText, draftAttachments.length, showToast, voiceDraft])

  const handleScheduleDraftChange = useCallback((patch: Partial<ScheduleDraft>) => {
    setScheduleDraft((current) => ({ ...current, ...patch }))
    setScheduleError('')
  }, [])

  const handleScheduleMessage = useCallback(async () => {
    if (!activeContact || schedulingMessage) return

    const text = composerText.trim()
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
    let transport: 'api' | undefined = 'api'

    if (whatsappConnected && activeContact.phone) {
      provider = 'whatsapp_api'
    } else if (highLevelConnected) {
      provider = 'highlevel'
      channel = activeConversationChannel
      transport = undefined
      if (!activeContact.phone && channel !== 'instagram' && channel !== 'messenger') {
        setScheduleError('Este contacto necesita teléfono para programar por este canal.')
        return
      }
    } else {
      setScheduleError('Conecta WhatsApp API o HighLevel para programar mensajes.')
      return
    }

    if (provider === 'whatsapp_api' && !activeContact.phone) {
      setScheduleError('Guarda el teléfono del contacto antes de programar.')
      return
    }

    if (provider === 'whatsapp_api' && !selectedBusinessPhoneValue) {
      setScheduleError('Elige el WhatsApp del negocio que mandará el mensaje.')
      return
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
        transport,
        text,
        toPhone: activeContact.phone || undefined,
        fromPhone: selectedBusinessPhoneValue || undefined,
        businessPhoneNumberId: selectedBusinessPhone?.id || undefined,
        scheduledAt: scheduledDate.toISOString(),
        externalId: editingScheduledMessageId || undefined
      })
      const scheduledBubble = getScheduledChatMessageBubble(scheduledMessage)

      setComposerText('')
      setDraftAttachments([])
      setVoiceDraft(null)
      setVoiceElapsedMs(0)

      if (scheduledBubble) {
        setMessages((current) => {
          const next = current.filter((message) => (
            message.id !== scheduledBubble.id &&
            message.scheduledMessageId !== editingScheduledMessageId
          ))
          next.push(scheduledBubble)
          return next.sort((left, right) => Date.parse(left.date) - Date.parse(right.date))
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

      setScheduleOpen(false)
      setScheduleEditingMessageId(null)
      showToast(
        'success',
        editingScheduledMessageId ? 'Programación actualizada' : 'Mensaje programado',
        formatScheduledMessageLabel(scheduledDate.toISOString())
      )
    } catch (error: any) {
      const errorMessage = error?.message || 'No se pudo programar el mensaje.'
      setScheduleError(errorMessage)
      showToast('error', 'No se programó', errorMessage)
    } finally {
      setSchedulingMessage(false)
    }
  }, [
    activeContact,
    activeConversationChannel,
    composerText,
    draftAttachments.length,
    highLevelConnected,
    scheduleDraft,
    scheduleEditingMessageId,
    schedulingMessage,
    selectedBusinessPhone?.id,
    selectedBusinessPhoneValue,
    showToast,
    voiceDraft,
    whatsappConnected
  ])

  const handleEditScheduledMessage = useCallback((message: DesktopChatMessage) => {
    const scheduledMessageId = getScheduledMessageActionId(message)
    if (!scheduledMessageId) {
      showToast('error', 'No se pudo editar', 'No encontramos la programación de este mensaje.')
      return
    }

    setScheduleEditingMessageId(scheduledMessageId)
    setComposerText(message.text)
    setDraftAttachments([])
    cancelVoiceDraft()
    setScheduleDraft(createScheduleDraftFromDate(message.scheduledAt || message.date))
    setScheduleError('')
    setScheduleOpen(true)
    setComposerMenuOpen(false)
    closeComposerAgentMenu()
  }, [cancelVoiceDraft, closeComposerAgentMenu, showToast])

  const handleCancelScheduledMessage = useCallback(async (message: DesktopChatMessage) => {
    if (!activeContact || cancelingScheduledMessageId) return

    const scheduledMessageId = getScheduledMessageActionId(message)
    if (!scheduledMessageId) {
      showToast('error', 'No se pudo eliminar', 'No encontramos la programación de este mensaje.')
      return
    }

    setCancelingScheduledMessageId(scheduledMessageId)
    try {
      await whatsappApiService.cancelScheduledMessage(scheduledMessageId, activeContact.id)
      setMessages((current) => current.filter((item) => item.id !== message.id && item.scheduledMessageId !== scheduledMessageId))
      await Promise.all([
        loadConversation(activeContact.id),
        loadChats({ silent: true })
      ])
      showToast('success', 'Programación eliminada', 'Ese mensaje ya no se enviará.')
    } catch (error: any) {
      showToast('error', 'No se eliminó', error?.message || 'Intenta eliminar la programación otra vez.')
    } finally {
      setCancelingScheduledMessageId(null)
    }
  }, [activeContact, cancelingScheduledMessageId, loadChats, loadConversation, showToast])

  const handleRunConversationAgentAction = useCallback(async (
    action: ConversationStateAction,
    successMessage: string,
    options: { agentId?: string } = {}
  ) => {
    if (!activeContact?.id || conversationAgentBusy) return
    if (!conversationAgentEnabled) {
      showToast('warning', 'Agente conversacional apagado', 'Actívalo en Agente AI para usarlo en los chats.')
      return
    }

    setConversationAgentBusy(true)
    try {
      const nextState = await conversationalAgentService.updateState(activeContact.id, action, options)
      updateActiveConversationAgentState(nextState)
      showToast('success', 'Agente conversacional', successMessage)
      closeComposerAgentMenu()
    } catch (error: any) {
      showToast('error', 'No se pudo cambiar el agente', error?.message || 'Intenta otra vez.')
    } finally {
      setConversationAgentBusy(false)
    }
  }, [activeContact?.id, closeComposerAgentMenu, conversationAgentBusy, conversationAgentEnabled, showToast, updateActiveConversationAgentState])

  const handleAssignConversationAgent = useCallback((agentId: string) => {
    const agent = availableAgentDefs.find((item) => item.id === agentId)
    if (!agent) {
      showToast('warning', 'Agente no disponible', 'Elige un agente publicado para atender este chat.')
      return
    }

    void handleRunConversationAgentAction(
      'activate',
      `${agent.name || 'El agente'} atenderá este chat.`,
      { agentId }
    )
  }, [availableAgentDefs, handleRunConversationAgentAction, showToast])

  const acknowledgeAgentPriorityOnOpen = useCallback((contactId: string) => {
    const state = agentStates[contactId]
    if (!state?.signal || state.signal === 'discarded') return

    const acknowledgedAt = new Date().toISOString()
    setAgentStates((current) => {
      const currentState = current[contactId]
      if (!currentState?.signal || currentState.signal === 'discarded') return current
      return {
        ...current,
        [contactId]: {
          ...currentState,
          signal: null,
          signalReason: null,
          signalSummary: null,
          signalAt: null,
          updatedBy: 'user',
          updatedAt: acknowledgedAt
        }
      }
    })

    void conversationalAgentService.updateState(contactId, 'clear_signal')
      .then((nextState) => {
        setAgentStates((current) => ({ ...current, [contactId]: nextState }))
        if (contactId === activeContactId) setConversationAgentState(nextState)
      })
      .catch((error: any) => {
        setAgentStates((current) => ({ ...current, [contactId]: state }))
        showToast('error', 'Agente conversacional', error?.message || 'No se pudo quitar la prioridad del chat')
      })
  }, [activeContactId, agentStates, showToast])

  const handleSelectChat = useCallback((contact: DesktopChatContact) => {
    setActiveContactId(contact.id)
    acknowledgeAgentPriorityOnOpen(contact.id)
  }, [acknowledgeAgentPriorityOnOpen])

  const handleToggleAgentAssignedView = useCallback(() => {
    setArchivedViewOpen(false)
    setChatFilter((current) => (current === 'agent' ? 'all' : 'agent'))
  }, [])

  const handleArchiveChat = useCallback((contact: DesktopChatContact | Contact) => {
    const alreadyArchived = archivedChatIdSet.has(contact.id)

    setArchivedChatIds((current) => {
      if (alreadyArchived) return current.filter((id) => id !== contact.id)
      return [contact.id, ...current.filter((id) => id !== contact.id)]
    })

    if (!alreadyArchived && activeContactId === contact.id) {
      setActiveContactId('')
    }

    showToast(
      'success',
      alreadyArchived ? 'Chat de vuelta' : 'Chat archivado',
      alreadyArchived
        ? `${getContactName(contact)} volvió a la bandeja.`
        : `${getContactName(contact)} se movió a Archivados.`
    )
  }, [activeContactId, archivedChatIdSet, showToast])

  const handleMarkChatAsRead = useCallback((contact: DesktopChatContact) => {
    const unread = Number(contact.unreadCount || 0)
    setChats((current) => {
      const next = current.map((item) => item.id === contact.id ? { ...item, unreadCount: 0 } : item)
      writeCachedChatList(next)
      return next
    })

    showToast(
      unread > 0 ? 'success' : 'info',
      unread > 0 ? 'Chat marcado como leído' : 'Chat sin pendientes',
      unread > 0 ? `${getContactName(contact)} ya no aparece como pendiente.` : `${getContactName(contact)} ya estaba leído.`
    )
  }, [showToast])

  const handleRemoveChatFromList = useCallback((contact: DesktopChatContact) => {
    const snapshot = getChatRemovalSnapshot(contact)
    const nextRemovedStates = [
      {
        contactId: contact.id,
        lastMessageDate: snapshot.lastMessageDate,
        messageCount: snapshot.messageCount,
        removedAt: new Date().toISOString()
      },
      ...removedChatStatesRef.current.filter((state) => state.contactId !== contact.id)
    ].slice(0, 200)
    const nextArchivedSet = new Set(archivedChatIdSetRef.current)
    nextArchivedSet.delete(contact.id)

    setRemovedChatStates(nextRemovedStates)
    setArchivedChatIds((current) => current.filter((id) => id !== contact.id))
    setActiveContactId((current) => (
      current === contact.id
        ? getDefaultActiveChatId(chatsRef.current.filter((item) => item.id !== contact.id), nextArchivedSet, agentPriorityChatIdSetRef.current, nextRemovedStates)
        : current
    ))

    showToast(
      'success',
      'Chat eliminado de la vista',
      `El historial de ${getContactName(contact)} sigue intacto y volverá si llega un mensaje nuevo.`
    )
  }, [showToast])

  const openAutomationModal = useCallback(() => {
    setAutomationModalOpen(true)
  }, [])

  useEffect(() => {
    if (!automationModalOpen) return
    let cancelled = false
    setAutomationsLoading(true)
    automationsService.getOverview()
      .then((overview) => {
        if (cancelled) return
        const published = overview.automations.filter((automation) => automation.status === 'published')
        setAutomations(published)
        setSelectedAutomationId((current) => current || published[0]?.id || '')
      })
      .catch(() => {
        if (!cancelled) {
          setAutomations([])
          setSelectedAutomationId('')
        }
      })
      .finally(() => {
        if (!cancelled) setAutomationsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [automationModalOpen])

  const handleEnrollAutomation = async () => {
    if (!activeContact?.id || !selectedAutomationId) return
    setAutomationSubmitting(true)
    try {
      await automationsService.enrollContact(selectedAutomationId, {
        contactId: activeContact.id,
        mode: 'now'
      })
      setAutomationModalOpen(false)
      showToast('success', 'Automatización iniciada', 'El contacto ya entró a la automatización.')
    } catch (error: any) {
      showToast('error', 'No se pudo iniciar', error?.message || 'Intenta otra vez.')
    } finally {
      setAutomationSubmitting(false)
    }
  }

  const resetAdvancedFilters = useCallback(() => {
    setAdvancedFilters(DEFAULT_ADVANCED_FILTERS)
  }, [])

  const resetChatFilters = useCallback(() => {
    setChatQuery('')
    setChatFilter('all')
    setAdvancedFilters(DEFAULT_ADVANCED_FILTERS)
    setArchivedViewOpen(false)
  }, [])

  const handleSendMessage = async (textOverride?: string) => {
    const text = (textOverride || composerText).trim()
    const attachmentsToSend = textOverride ? [] : draftAttachments
    const voiceToSend = textOverride ? null : voiceDraft
    if (!activeContact || (!text && attachmentsToSend.length === 0 && !voiceToSend)) return

    if (voiceToSend) {
      if (!activeContact.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar audio por WhatsApp.')
        return
      }
      if (!whatsappConnected) {
        showToast('warning', 'Conecta WhatsApp para audio', 'Los mensajes de voz salen por WhatsApp API.')
        return
      }
    } else if (attachmentsToSend.length > 0) {
      if (!activeContact.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar archivos por WhatsApp.')
        return
      }
      if (!whatsappConnected) {
        showToast('warning', 'Conecta WhatsApp para adjuntos', 'Las fotos y documentos se mandan desde WhatsApp API.')
        return
      }
    } else if (!activeContact.phone && activeConversationChannel !== 'instagram' && activeConversationChannel !== 'messenger') {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribirle por WhatsApp o SMS.')
      return
    }

    const optimisticId = `desktop-chat-${Date.now()}`
    const sentAt = new Date().toISOString()
    const optimisticMessages: DesktopChatMessage[] = voiceToSend
      ? [{
          id: `${optimisticId}-audio`,
          text: '',
          date: sentAt,
          direction: 'outbound',
          status: 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport: 'api',
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
          transport: 'api',
          attachment: {
            type: getDraftAttachmentMessageType(attachment),
            dataUrl: attachment.dataUrl,
            name: attachment.name,
            mimeType: attachment.mimeType
          }
        }))
      : [{
          id: optimisticId,
          text,
          date: sentAt,
          direction: 'outbound',
          status: 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport: whatsappConnected ? 'api' : activeConversationChannel
        }]

    setComposerStatus('sending')
    if (!textOverride) setComposerText('')
    setDraftAttachments([])
    setVoiceDraft(null)
    setVoiceElapsedMs(0)
    setComposerMenuOpen(false)
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
          transport: 'api',
          phoneNumberId: selectedBusinessPhone?.id || undefined
        })
        const responseAudioUrl = result.audio?.link || result.audio?.url || result.localMedia?.publicUrl || ''
        const responseAudioMimeType = result.audio?.mimeType || result.audio?.mimetype || result.localMedia?.mimeType || ''
        const responseAudioDurationMs = Number(result.audio?.durationMs || 0) || voiceToSend.durationMs
        setMessages((current) => current.map((message) => message.id === `${optimisticId}-audio`
          ? {
              ...message,
              status: result.status || 'sent',
              transport: result.transport || message.transport,
              attachment: message.attachment
                ? {
                    ...message.attachment,
                    ...(responseAudioUrl ? { url: responseAudioUrl } : {}),
                    ...(responseAudioMimeType ? { mimeType: responseAudioMimeType } : {}),
                    durationMs: responseAudioDurationMs
                  }
                : message.attachment
            }
          : message
        ))
      } else if (attachmentsToSend.length > 0) {
        const results = await Promise.all(attachmentsToSend.map((attachment, index) => (
          attachment.kind === 'image'
            ? whatsappApiService.sendImage({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                contactId: activeContact.id,
                imageDataUrl: attachment.dataUrl,
                caption: index === 0 ? text : '',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: 'api',
                phoneNumberId: selectedBusinessPhone?.id || undefined
              })
            : whatsappApiService.sendDocument({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                contactId: activeContact.id,
                documentDataUrl: attachment.dataUrl,
                filename: attachment.name,
                mimeType: attachment.mimeType,
                caption: index === 0 ? text : '',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: 'api',
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
      } else if (whatsappConnected && activeContact.phone) {
        const result = await whatsappApiService.sendText({
          to: activeContact.phone,
          from: selectedBusinessPhoneValue,
          contactId: activeContact.id,
          text,
          externalId: optimisticId,
          transport: 'api',
          phoneNumberId: selectedBusinessPhone?.id || undefined
        })
        setMessages((current) => current.map((message) => message.id === optimisticId ? { ...message, status: result.status || 'sent', transport: result.transport || message.transport } : message))
      } else if (highLevelConnected) {
        const result = await highLevelService.sendConversationMessage({
          contactId: activeContact.id,
          channel: activeConversationChannel,
          message: text,
          fromNumber: selectedBusinessPhoneValue || undefined,
          toNumber: activeContact.phone || undefined,
          externalId: optimisticId
        })
        const data = result.data || result
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? { ...message, id: data.localMessageId || message.id, status: data.status || 'pending', transport: data.transport || activeConversationChannel }
            : message
        )))
      } else {
        throw new Error('Conecta WhatsApp API o HighLevel para enviar mensajes desde esta pantalla.')
      }
      await Promise.all([
        loadConversation(activeContact.id),
        loadChats({ silent: true })
      ])
    } catch (error: any) {
      const message = error?.message || 'Intenta enviar el mensaje otra vez.'
      setMessages((current) => current.map((item) => (
        item.id === optimisticId || item.id === `${optimisticId}-audio` || item.id.startsWith(`${optimisticId}-attachment-`)
          ? { ...item, status: 'error', errorReason: message }
          : item
      )))
      if (!textOverride) setComposerText(text)
      if (!textOverride) setDraftAttachments(attachmentsToSend)
      if (!textOverride) setVoiceDraft(voiceToSend)
      if (!textOverride) setVoiceElapsedMs(voiceToSend?.durationMs || 0)
      showToast('error', 'No se envió el mensaje', message)
    } finally {
      setComposerStatus('idle')
    }
  }

  const renderComposerAgentMenu = () => {
    if (!agentComposerMenuOpen || !activeContact) return null

    const showPicker = agentPickerOpen || !conversationAgentActive || !conversationAgentState?.agentId
    const disabledByGlobalConfig = !conversationAgentEnabled

    if (showPicker) {
      return (
        <div className={styles.agentComposerMenu} role="menu" aria-label="Seleccionar agente conversacional">
          <div className={styles.agentComposerMenuHeader}>
            <strong>Asignar agente</strong>
            <span>{disabledByGlobalConfig ? 'El agente está apagado en configuración.' : 'Elige quién atenderá este chat.'}</span>
          </div>
          {availableAgentDefs.length > 0 ? (
            <div className={styles.agentPickerList}>
              {availableAgentDefs.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAssignConversationAgent(agent.id)}
                  disabled={conversationAgentBusy || disabledByGlobalConfig}
                >
                  <span className={styles.agentPickerIcon}>
                    <Bot size={15} />
                  </span>
                  <span>
                    <strong>{agent.name || 'Agente sin nombre'}</strong>
                    <small>{agent.objective === 'ventas' ? 'Ventas' : agent.objective === 'datos' ? 'Datos' : agent.objective === 'filtrar' ? 'Filtrar' : 'Citas y seguimiento'}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.agentComposerHint}>No hay agentes publicados. Créalo en Agente AI → Agente conversacional.</p>
          )}
          {disabledByGlobalConfig ? (
            <p className={styles.agentComposerHint}>Activa la configuración general del agente antes de asignarlo a un chat.</p>
          ) : null}
        </div>
      )
    }

    return (
      <div className={styles.agentComposerMenu} role="menu" aria-label="Acciones del agente conversacional">
        <div className={styles.agentComposerMenuHeader}>
          <strong>{activeAgentDef?.name || 'Agente conversacional'}</strong>
          <span>{conversationAgentStatusLabel}</span>
        </div>
        <button
          type="button"
          role="menuitem"
          className={styles.agentMenuAction}
          disabled={conversationAgentBusy}
          onClick={() => handleRunConversationAgentAction('take_over', `Tomaste la conversación de ${getContactName(activeContact)}.`)}
        >
          <User size={15} />
          <span>
            <strong>Tomar conversación</strong>
            <small>El agente deja de responder aquí.</small>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.agentMenuAction}
          disabled={conversationAgentBusy}
          onClick={() => handleRunConversationAgentAction('pause', 'El chatbot quedó pausado en este chat.')}
        >
          <Pause size={15} />
          <span>
            <strong>Pausar chatbot</strong>
            <small>Pausa el agente sólo en esta conversación.</small>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.agentMenuAction}
          disabled={conversationAgentBusy}
          onClick={() => handleRunConversationAgentAction('skip', 'El chatbot quedó omitido en este chat.')}
        >
          <X size={15} />
          <span>
            <strong>Omitir chatbot</strong>
            <small>El agente no vuelve a tomar este chat.</small>
          </span>
        </button>
        <button
          type="button"
          role="menuitem"
          className={styles.agentMenuAction}
          disabled={conversationAgentBusy}
          onClick={() => setAgentPickerOpen(true)}
        >
          <Play size={15} />
          <span>
            <strong>Cambiar agente</strong>
            <small>Activa este chat con otro agente.</small>
          </span>
        </button>
      </div>
    )
  }

  const renderChannelBadgeIcon = (kind: ContactChannelBadgeKind, size: 'sm' | 'md') => {
    const iconSize = size === 'sm' ? 13 : 14
    if (kind === 'whatsapp') return <FaWhatsapp className={styles.avatarChannelBadgeBrandIcon} aria-hidden="true" />
    if (kind === 'messenger') return <FaFacebookMessenger className={styles.avatarChannelBadgeBrandIcon} aria-hidden="true" />
    if (kind === 'instagram') return <FaInstagram className={styles.avatarChannelBadgeBrandIcon} aria-hidden="true" />
    if (kind === 'email') return <Mail size={iconSize} />
    if (kind === 'sms') return <Phone size={iconSize} />
    if (kind === 'webchat') return <Icon name="globe" size={iconSize} />
    return <Icon name="meta" size={iconSize} />
  }

  const renderAvatar = (
    contact: DesktopChatContact | Contact | null,
    size: 'sm' | 'md' = 'md',
    options: { showChannelBadge?: boolean; showAgentBadge?: boolean } = {}
  ) => {
    const photo = getContactProfilePhoto(contact)
    const initials = getContactInitials(contact)
    const channelBadge = options.showChannelBadge ? getContactChannelBadge(contact) : null
    return (
      <span className={`${styles.avatar} ${size === 'sm' ? styles.avatarSm : ''}`}>
        {photo ? <img src={photo} alt={`Foto de ${getContactName(contact)}`} /> : initials}
        {channelBadge ? (
          <span
            className={`${styles.avatarChannelBadge} ${getAvatarChannelBadgeClass(channelBadge.kind)}`}
            data-chat-avatar-channel
            data-chat-avatar-channel-kind={channelBadge.kind}
            title={`Canal: ${channelBadge.label}`}
            aria-label={`Canal: ${channelBadge.label}`}
          >
            {renderChannelBadgeIcon(channelBadge.kind, size)}
          </span>
        ) : null}
        {options.showAgentBadge ? (
          <span className={styles.avatarAgentBadge} title="Prioridad del agente" aria-label="Prioridad del agente">
            <Bot size={10} />
          </span>
        ) : null}
      </span>
    )
  }

  const renderChatActionsMenu = (contact: DesktopChatContact) => {
    const isArchived = archivedChatIdSet.has(contact.id)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={styles.chatRowMenuButton}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label={`Abrir opciones de ${getContactName(contact)}`}
            title="Más opciones"
          >
            <MoreHorizontal size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={8} className={styles.chatActionsMenu}>
          <DropdownMenuItem className={styles.chatActionMenuItem} onSelect={() => handleMarkChatAsRead(contact)}>
            <CheckCheck size={15} />
            <span>Marcar como leído</span>
          </DropdownMenuItem>
          <DropdownMenuItem className={styles.chatActionMenuItem} onSelect={() => handleArchiveChat(contact)}>
            <Archive size={15} />
            <span>{isArchived ? 'Restaurar chat' : 'Archivar chat'}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className={`${styles.chatActionMenuItem} ${styles.chatActionMenuItemDanger}`}
            onSelect={() => handleRemoveChatFromList(contact)}
          >
            <Trash2 size={15} />
            <span>Eliminar chat</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const renderVoiceWave = () => {
    if (!voiceRecording && !voiceProcessing) return null
    return (
      <div className={styles.voiceWave} aria-label={voiceRecording ? 'Grabando audio' : 'Procesando audio'}>
        {Array.from({ length: VOICE_WAVE_BAR_COUNT }).map((_, index) => {
          const pattern = VOICE_WAVE_PATTERN[index % VOICE_WAVE_PATTERN.length]
          const drift = ((index * 7) % 19)
          return (
            <span
              key={index}
              style={{
                '--voice-wave-height': `${Math.max(6, Math.min(54, pattern + drift))}px`,
                '--voice-wave-delay': `${(index % 14) * 42}ms`
              } as React.CSSProperties}
            />
          )
        })}
      </div>
    )
  }

  const renderVoiceDraft = () => {
    if (!voiceDraft) return null
    return (
      <div className={styles.voiceDraft}>
        <Mic size={15} />
        <span>Audio listo · {formatVoiceDuration(voiceDraft.durationMs)}</span>
        <button type="button" onClick={cancelVoiceDraft} aria-label="Eliminar audio">
          <Trash2 size={14} />
        </button>
      </div>
    )
  }

  const setMessageAudioRef = (messageId: string, node: HTMLAudioElement | null) => {
    if (node) {
      messageAudioRefs.current[messageId] = node
      return
    }
    delete messageAudioRefs.current[messageId]
  }

  const updateMessageAudioProgress = useCallback((messageId: string) => {
    const audio = messageAudioRefs.current[messageId]
    if (!audio) return
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0
    setMessageAudioProgress((current) => ({
      ...current,
      [messageId]: { currentTime, duration }
    }))
  }, [])

  const handleToggleMessageAudio = useCallback(async (messageId: string) => {
    const audio = messageAudioRefs.current[messageId]
    if (!audio) return

    Object.entries(messageAudioRefs.current).forEach(([id, element]) => {
      if (id !== messageId && element && !element.paused) element.pause()
    })

    if (!audio.paused) {
      audio.pause()
      setPlayingAudioId((current) => (current === messageId ? '' : current))
      return
    }

    try {
      await audio.play()
      setPlayingAudioId(messageId)
    } catch {
      showToast('error', 'No se pudo reproducir el audio', 'Intenta abrirlo otra vez.')
    }
  }, [showToast])

  const renderScheduledMessageActions = (message: DesktopChatMessage) => {
    if (!isMessageScheduled(message)) return null

    const scheduledMessageId = getScheduledMessageActionId(message)
    const deleting = Boolean(scheduledMessageId && cancelingScheduledMessageId === scheduledMessageId)

    return (
      <div className={styles.scheduledActions} aria-label="Acciones del mensaje programado">
        <button type="button" onClick={() => handleEditScheduledMessage(message)} disabled={deleting}>
          <Pencil size={13} />
          <span>Editar</span>
        </button>
        <button type="button" className={styles.scheduledDangerAction} onClick={() => handleCancelScheduledMessage(message)} disabled={deleting}>
          {deleting ? <Loader2 size={13} className={styles.spin} /> : <Trash2 size={13} />}
          <span>{deleting ? 'Eliminando' : 'Eliminar'}</span>
        </button>
      </div>
    )
  }

  const renderAttachment = (message: DesktopChatMessage) => {
    if (!message.attachment) return null
    const { attachment } = message
    const attachmentSrc = getAttachmentSource(attachment)

    if (attachment.type === 'audio') {
      const progress = messageAudioProgress[message.id]
      const durationSeconds = progress?.duration || (attachment.durationMs ? attachment.durationMs / 1000 : 0)
      const currentSeconds = progress?.currentTime || 0
      const progressPercent = durationSeconds > 0 ? Math.max(0, Math.min(100, (currentSeconds / durationSeconds) * 100)) : 0
      const isPlaying = playingAudioId === message.id
      const audioTitle = attachment.name && attachment.name !== 'Mensaje de voz' ? attachment.name : 'Mensaje de voz'

      return (
        <div
          className={`${styles.audioAttachment} ${message.direction === 'outbound' ? styles.audioAttachmentOutbound : styles.audioAttachmentInbound} ${!attachmentSrc ? styles.audioAttachmentUnavailable : ''}`}
          style={{ '--audio-progress': `${progressPercent}%` } as React.CSSProperties}
        >
          {attachmentSrc ? (
            <audio
              ref={(node) => setMessageAudioRef(message.id, node)}
              className={styles.audioNative}
              src={attachmentSrc}
              preload="metadata"
              onLoadedMetadata={() => updateMessageAudioProgress(message.id)}
              onTimeUpdate={() => updateMessageAudioProgress(message.id)}
              onPlay={() => setPlayingAudioId(message.id)}
              onPause={() => setPlayingAudioId((current) => (current === message.id ? '' : current))}
              onEnded={() => {
                updateMessageAudioProgress(message.id)
                setPlayingAudioId('')
              }}
            />
          ) : null}
          <button
            type="button"
            className={styles.audioPlayButton}
            onClick={() => { void handleToggleMessageAudio(message.id) }}
            disabled={!attachmentSrc}
            aria-label={isPlaying ? 'Pausar mensaje de voz' : 'Reproducir mensaje de voz'}
          >
            {isPlaying ? <Pause size={18} /> : <Play size={18} />}
          </button>
          <span className={styles.audioWaveform} aria-hidden="true">
            {Array.from({ length: MESSAGE_AUDIO_WAVE_BAR_COUNT }).map((_, index) => {
              const pattern = MESSAGE_AUDIO_WAVE_PATTERN[index % MESSAGE_AUDIO_WAVE_PATTERN.length]
              return (
                <span
                  key={index}
                  className={styles.audioWaveBar}
                  style={{ '--bar-height': `${pattern}px` } as React.CSSProperties}
                />
              )
            })}
            <span className={styles.audioProgressDot} />
          </span>
          <span className={styles.audioAvatar} aria-hidden="true">
            <Mic size={17} />
          </span>
          <span className={styles.audioAttachmentBody}>
            <strong>{audioTitle}</strong>
            <small>{attachmentSrc ? (durationSeconds > 0 ? formatVoiceDuration(durationSeconds * 1000) : 'Audio') : 'Audio no disponible'}</small>
          </span>
        </div>
      )
    }

    if (attachment.type === 'image') {
      if (!attachmentSrc) {
        return (
          <span className={`${styles.attachment} ${styles.attachmentUnavailable}`}>
            <ImageIcon size={15} />
            <span>{attachment.name || (attachment.isGif ? 'GIF no disponible' : 'Foto no disponible')}</span>
          </span>
        )
      }

      return (
        <a className={styles.mediaAttachment} href={attachmentSrc} target="_blank" rel="noreferrer" aria-label={attachment.name || (attachment.isGif ? 'Abrir GIF' : 'Abrir foto')}>
          <img src={attachmentSrc} alt={attachment.name || (attachment.isGif ? 'GIF enviado' : 'Foto enviada')} loading="lazy" />
        </a>
      )
    }

    if (attachment.type === 'video') {
      const isGifVideo = Boolean(attachment.isGif)
      if (!attachmentSrc) {
        return (
          <span className={`${styles.attachment} ${styles.attachmentUnavailable}`}>
            {isGifVideo ? <ImageIcon size={15} /> : <Video size={15} />}
            <span>{attachment.name || (isGifVideo ? 'GIF no disponible' : 'Video no disponible')}</span>
          </span>
        )
      }

      return (
        <div className={styles.mediaAttachment}>
          <video
            src={attachmentSrc}
            controls={!isGifVideo}
            autoPlay={isGifVideo}
            muted={isGifVideo}
            loop={isGifVideo}
            playsInline
            preload={isGifVideo ? 'auto' : 'metadata'}
            aria-label={isGifVideo ? (attachment.name || 'GIF enviado') : undefined}
          />
        </div>
      )
    }

    const fileMeta = getAttachmentFileMeta(attachment)
    const fileContent = (
      <>
        <span className={styles.fileAttachmentPreview} data-file-tone={fileMeta.tone}>
          <FileText size={20} />
          <em>{fileMeta.extension}</em>
        </span>
        <span className={styles.fileAttachmentBody}>
          <strong>{fileMeta.name}</strong>
          <small>{fileMeta.label}{attachmentSrc ? ' · Abrir archivo' : ' no disponible'}</small>
        </span>
      </>
    )

    return attachmentSrc ? (
      <a className={styles.fileAttachment} href={attachmentSrc} target="_blank" rel="noreferrer" aria-label={`Abrir ${fileMeta.name}`}>
        {fileContent}
      </a>
    ) : (
      <span className={`${styles.fileAttachment} ${styles.attachmentUnavailable}`}>
        {fileContent}
      </span>
    )
  }

  const renderMessageMeta = (message: DesktopChatMessage) => {
    const status = String(message.status || '').trim().toLowerCase()
    const failed = FAILED_MESSAGE_STATUSES.has(status) || Boolean(message.errorReason)
    const pending = PENDING_MESSAGE_STATUSES.has(status)
    return (
      <span className={styles.messageMeta}>
        {formatMessageTime(message.date)}
        {message.direction === 'outbound' && !failed && !pending ? <CheckCheck size={13} /> : null}
        {pending ? <Clock size={13} /> : null}
        {failed ? <CircleAlert size={13} /> : null}
      </span>
    )
  }

  const schedulePreviewDate = getScheduleDateFromDraft(scheduleDraft)
  const canSubmitSchedule = Boolean(schedulePreviewDate && composerText.trim() && !schedulingMessage)

  return (
    <div
      className={`${styles.page} ${agentAssignedViewOpen ? styles.pageAgentInbox : ''}`}
      data-ristak-page
      data-desktop-chat-agent-view={agentAssignedViewOpen ? 'true' : undefined}
    >
      <section className={styles.chatShell} data-desktop-chat-page>
        <aside
          className={`${styles.inboxPanel} ${agentAssignedViewOpen ? styles.inboxPanelAgent : ''}`}
          aria-label={agentAssignedViewOpen ? 'Lista de chats del bot' : 'Lista de chats'}
        >
          <div className={styles.inboxHeader}>
            <div>
              <span className={styles.inboxTitleLine}>
                {agentAssignedViewOpen ? (
                  <span className={styles.inboxTitleAgentIcon} aria-hidden="true">
                    <Bot size={14} />
                  </span>
                ) : null}
                <h2>{inboxTitle}</h2>
              </span>
              <p>{inboxSubtitle}</p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={`${styles.agentInboxButton} ${agentAssignedViewOpen ? styles.agentInboxButtonActive : ''}`}
              onClick={handleToggleAgentAssignedView}
              aria-label={agentAssignedViewOpen ? 'Cerrar vista de conversaciones asignadas al bot' : 'Ver conversaciones asignadas al bot'}
              aria-pressed={agentAssignedViewOpen}
              title={agentAssignedViewOpen ? 'Cerrar chats del bot' : 'Conversaciones asignadas al bot'}
            >
              <AgentRobot size={42} active={conversationAgentEnabled} label="Agente conversacional" />
            </Button>
          </div>

          <label className={styles.searchBox}>
            <Search size={16} />
            <input
              data-ristak-unstyled
              value={chatQuery}
              onChange={(event) => setChatQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSearchContacts()
              }}
              placeholder="Buscar chat, contacto, teléfono o correo"
            />
            {chatQuery ? (
              <button type="button" onClick={() => setChatQuery('')} aria-label="Limpiar búsqueda">
                <X size={14} />
              </button>
            ) : null}
          </label>

          <div className={styles.filterRow} role="tablist" aria-label="Filtros de chat">
            <button
              type="button"
              className={`${styles.filterToolButton} ${advancedFiltersOpen || activeAdvancedFilterCount > 0 ? styles.filterActive : ''}`}
              onClick={() => setAdvancedFiltersOpen((current) => !current)}
              aria-expanded={advancedFiltersOpen}
              aria-label="Modificar filtros"
            >
              <ListFilter size={14} />
              <span>Filtros</span>
              {activeAdvancedFilterCount > 0 ? <strong>{activeAdvancedFilterCount}</strong> : null}
            </button>
            {CHAT_FILTERS.map((filter) => (
              <button
                key={filter.id}
                type="button"
                className={filter.id === chatFilter ? styles.filterActive : ''}
                onClick={() => {
                  setArchivedViewOpen(false)
                  setChatFilter(filter.id)
                }}
              >
                {filter.label}
              </button>
            ))}
          </div>

          {advancedFiltersOpen ? (
            <div className={styles.filterPanel}>
              <div className={styles.filterPanelHeader}>
                <strong>Filtrar conversaciones</strong>
                <button type="button" onClick={resetAdvancedFilters} disabled={activeAdvancedFilterCount === 0}>
                  Limpiar
                </button>
              </div>
              <div className={styles.filterGrid}>
                {advancedFilterGroups.map((group) => (
                  <div key={group.id} className={styles.filterGroup}>
                    <span>{group.label}</span>
                    <div className={styles.filterChipWrap}>
                      {group.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={option.value === group.value ? styles.filterActive : ''}
                          onClick={() => group.onSelect(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className={styles.chatList} data-chat-list>
            {chatsLoading ? (
              <div className={styles.stateBlock} role="status" aria-live="polite" aria-label="Cargando chats">
                <Loader2 size={18} className={styles.spin} aria-hidden="true" />
              </div>
            ) : chatsError ? (
              <div className={styles.stateBlock}>
                <CircleAlert size={18} />
                <span>{chatsError}</span>
                <Button variant="secondary" size="sm" onClick={() => { void loadChats() }}>Reintentar</Button>
              </div>
            ) : filteredChats.length === 0 && agentPriorityChatRows.length === 0 && !archivedViewOpen && archivedChatCount === 0 ? (
              <div className={styles.emptyChatList}>
                <MessageCircle size={22} />
                <strong>{emptyChatTitle}</strong>
                <span>{emptyChatDescription}</span>
                {hasActiveChatFilters ? <button type="button" onClick={resetChatFilters}>{resetChatFiltersLabel}</button> : null}
              </div>
            ) : (
              <>
                {!archivedViewOpen && agentPriorityChatRows.map((contact) => {
                  const active = contact.id === activeContactId
                  const unread = Number(contact.unreadCount || 0)
                  const agentState = agentStates[contact.id]
                  return (
                    <div
                      key={`agent-${contact.id}`}
                      role="button"
                      tabIndex={0}
                      data-chat-row="agent-priority"
                      className={`${styles.chatRow} ${styles.chatRowAgentAction} ${unread > 0 ? styles.chatRowUnread : ''} ${active ? styles.chatRowActive : ''}`}
                      onClick={() => handleSelectChat(contact)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          handleSelectChat(contact)
                        }
                      }}
                    >
                      {renderAvatar(contact, 'sm', { showChannelBadge: true, showAgentBadge: true })}
                      <span className={styles.chatRowBody}>
                        <span className={styles.chatRowTop}>
                          <strong>{getContactName(contact)}</strong>
                          <small>{contact.lastMessageDate ? formatMessageTime(contact.lastMessageDate) : ''}</small>
                        </span>
                        <span className={styles.chatPreviewLine}>
                          <span className={styles.agentPriorityText}>
                            {[AGENT_SIGNAL_LABELS[agentState?.signal || ''] || 'Prioridad del agente', agentState?.signalReason || agentState?.signalSummary].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </span>
                      <span className={styles.chatRowAside}>
                        {unread > 0 ? <span className={styles.unreadDot} data-chat-unread-dot aria-label="Mensaje nuevo" /> : null}
                        {unread > 1 ? <span className={styles.unread}>{unread > 99 ? '99+' : unread}</span> : null}
                        {renderChatActionsMenu(contact)}
                      </span>
                    </div>
                  )
                })}
                {archivedViewOpen ? (
                  <button
                    type="button"
                    data-chat-archive-row
                    className={`${styles.archiveRow} ${styles.archiveRowActive}`}
                    onClick={() => setArchivedViewOpen(false)}
                  >
                    <span className={styles.archiveRowIcon}>
                      <ChevronLeft size={18} />
                    </span>
                    <strong>Volver a conversaciones</strong>
                    <span>{archivedChatCount}</span>
                  </button>
                ) : agentAssignedViewOpen ? null : (
                  (visibleChatsForList.length > 0 || archivedChatCount > 0) ? (
                    <button
                      type="button"
                      data-chat-archive-row
                      className={styles.archiveRow}
                      onClick={() => setArchivedViewOpen(true)}
                      aria-label={`Ver ${archivedChatCount} chats archivados`}
                    >
                      <span className={styles.archiveRowIcon}>
                        <Archive size={17} />
                      </span>
                      <strong>Archivados</strong>
                      <span>{archivedChatCount}</span>
                    </button>
                  ) : null
                )}
                {filteredChats.map((contact) => {
                  const active = contact.id === activeContactId
                  const unread = Number(contact.unreadCount || 0)
                  const isAgentActionChat = Boolean(agentStates[contact.id]?.signal && agentStates[contact.id]?.signal !== 'discarded')
                  const showAgentBadge = agentAssignedViewOpen || isAgentActionChat
                  return (
                    <div
                      key={contact.id}
                      role="button"
                      tabIndex={0}
                      data-chat-row={agentAssignedViewOpen ? 'agent-assigned' : unread > 0 ? 'unread' : 'chat'}
                      className={`${styles.chatRow} ${agentAssignedViewOpen ? styles.chatRowAgentAssigned : ''} ${unread > 0 ? styles.chatRowUnread : ''} ${active ? styles.chatRowActive : ''}`}
                      onClick={() => handleSelectChat(contact)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          handleSelectChat(contact)
                        }
                      }}
                    >
                      {renderAvatar(contact, 'sm', { showChannelBadge: true, showAgentBadge })}
                      <span className={styles.chatRowBody}>
                        <span className={styles.chatRowTop}>
                          <strong>{getContactName(contact)}</strong>
                          <small>{contact.lastMessageDate ? formatMessageTime(contact.lastMessageDate) : ''}</small>
                        </span>
                        <span className={styles.chatPreviewLine}>
                          <span className={styles.chatPreview}>{getChatPreview(contact)}</span>
                        </span>
                      </span>
                      <span className={styles.chatRowAside}>
                        {unread > 0 ? <span className={styles.unreadDot} data-chat-unread-dot aria-label="Mensaje nuevo" /> : null}
                        {unread > 1 ? <span className={styles.unread}>{unread > 99 ? '99+' : unread}</span> : null}
                        {renderChatActionsMenu(contact)}
                      </span>
                    </div>
                  )
                })}
                {filteredChats.length === 0 && agentPriorityChatRows.length === 0 ? (
                  <div className={styles.emptyChatList}>
                    <MessageCircle size={22} />
                    <strong>{emptyChatTitle}</strong>
                    <span>{emptyChatDescription}</span>
                    {hasActiveChatFilters ? <button type="button" onClick={resetChatFilters}>{resetChatFiltersLabel}</button> : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>

        <main className={styles.conversationPanel} aria-label="Conversación">
          {activeContact ? (
            <>
              <header className={styles.conversationHeader}>
                <div className={styles.contactTitle}>
                  {renderAvatar(activeContact, 'md', { showChannelBadge: true })}
                  <div>
                    <span className={styles.contactHeadingRow}>
                      <h2>{getContactName(activeContact)}</h2>
                    </span>
                    <p>{getContactDetail(activeContact)}</p>
                  </div>
                </div>
                <div className={styles.quickActions}>
                  <Button variant="secondary" size="sm" leftIcon={<CalendarDays size={15} />} onClick={openNewAppointment}>
                    Agendar
                  </Button>
                  <Button variant="secondary" size="sm" leftIcon={<CreditCard size={15} />} onClick={() => setPaymentOpen(true)}>
                    Cobrar
                  </Button>
                </div>
              </header>

              <div className={styles.messagePane}>
                {messagesLoading ? (
                  <div className={styles.stateBlock} role="status" aria-live="polite" aria-label="Cargando conversación">
                    <Loader2 size={18} className={styles.spin} aria-hidden="true" />
                  </div>
                ) : messagesError ? (
                  <div className={styles.stateBlock}>
                    <CircleAlert size={18} />
                    <span>{messagesError}</span>
                    <Button variant="secondary" size="sm" onClick={() => { void loadConversation(activeContact.id) }}>Reintentar</Button>
                  </div>
                ) : messages.length === 0 ? (
                  <div className={styles.emptyConversation}>
                    <MessageCircle size={22} />
                    <strong>Sin mensajes todavía</strong>
                    <span>Escribe abajo para empezar la conversación.</span>
                  </div>
                ) : messageGroups.map((group) => (
                  <div key={group.key} className={styles.messageGroup}>
                    <div className={styles.dayDivider}>{group.label}</div>
                    {group.messages.map((message) => (
                      <article
                        key={message.id}
                        className={`${styles.messageBubble} ${message.direction === 'outbound' ? styles.messageOutbound : message.direction === 'system' ? styles.messageSystem : styles.messageInbound} ${isMessageScheduled(message) ? styles.messageScheduled : ''}`}
                      >
                        {renderAttachment(message)}
                        {message.text ? <p>{message.text}</p> : null}
                        {message.errorReason ? <small className={styles.errorText}>{message.errorReason}</small> : null}
                        {message.scheduledAt ? <small className={styles.scheduledText}>Programado para {formatLocalDateTime(message.scheduledAt)}</small> : null}
                        {renderScheduledMessageActions(message)}
                        {renderMessageMeta(message)}
                      </article>
                    ))}
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSendMessage()
                }}
              >
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  className={styles.hiddenFileInput}
                  onChange={(event) => handleImageSelected('photos', event)}
                  tabIndex={-1}
                />
                <input
                  ref={documentInputRef}
                  type="file"
                  accept={DOCUMENT_ATTACHMENT_ACCEPT}
                  className={styles.hiddenFileInput}
                  onChange={handleDocumentSelected}
                  tabIndex={-1}
                />
                {draftAttachments.length > 0 ? (
                  <div className={styles.draftAttachmentList}>
                    {draftAttachments.map((attachment) => (
                      <div key={attachment.id} className={styles.draftAttachment}>
                        <span className={styles.draftAttachmentIcon}>
                          {attachment.kind === 'image' ? <ImageIcon size={16} /> : <FileText size={16} />}
                        </span>
                        <span className={styles.draftAttachmentText}>
                          <strong>{attachment.name}</strong>
                          <small>{formatAttachmentSize(attachment.size)}</small>
                        </span>
                        <button type="button" onClick={() => removeDraftAttachment(attachment.id)} aria-label={`Quitar ${attachment.name}`}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {renderVoiceWave()}
                {renderVoiceDraft()}
                <div className={styles.agentComposerWrap}>
                  <button
                    type="button"
                    className={styles.agentComposerButton}
                    data-active={conversationAgentActive ? 'true' : undefined}
                    data-enabled={conversationAgentEnabled ? 'true' : undefined}
                    onClick={handleOpenComposerAgentMenu}
                    disabled={!activeContact || conversationAgentBusy}
                    aria-label={conversationAgentActive ? 'Abrir acciones del agente conversacional' : 'Asignar agente conversacional'}
                    aria-expanded={agentComposerMenuOpen}
                    title={conversationAgentActive ? 'Agente conversacional activo' : 'Asignar agente conversacional'}
                  >
                    {conversationAgentBusy ? <Loader2 size={17} className={styles.spin} /> : <AgentRobot size={30} active={conversationAgentActive} />}
                  </button>
                  {renderComposerAgentMenu()}
                </div>
                <div ref={composerMenuRef} className={styles.composerActionWrap}>
                  <button
                    type="button"
                    className={styles.composerPlusButton}
                    onClick={() => {
                      closeComposerAgentMenu()
                      setComposerMenuOpen((current) => !current)
                    }}
                    aria-label="Abrir opciones de adjuntos"
                    aria-expanded={composerMenuOpen}
                  >
                    <Plus size={20} />
                  </button>
                  {composerMenuOpen ? (
                    <div className={styles.composerMenu} role="menu" aria-label="Opciones de mensaje">
                      <button type="button" role="menuitem" onClick={() => handleComposerMenuAction('templates')}>
                        <FileText size={16} />
                        <span>Plantillas</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => handleComposerMenuAction('photos')}>
                        <ImageIcon size={16} />
                        <span>Fotos</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => handleComposerMenuAction('documents')}>
                        <FileText size={16} />
                        <span>Documentos</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => handleComposerMenuAction('location')}>
                        <MapPin size={16} />
                        <span>Ubicación</span>
                      </button>
                      <button type="button" role="menuitem" onClick={() => handleComposerMenuAction('clabe')}>
                        <Banknote size={16} />
                        <span>CLABE</span>
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className={styles.composerTextField}>
                  <textarea
                    data-ristak-unstyled
                    value={composerText}
                    onChange={(event) => setComposerText(event.target.value)}
                    placeholder={voiceRecording ? 'Grabando audio...' : voiceDraft ? 'Audio listo para enviar' : 'Escribe una respuesta...'}
                    rows={1}
                    onFocus={() => {
                      setComposerMenuOpen(false)
                      closeComposerAgentMenu()
                    }}
                    disabled={voiceRecording || voiceProcessing || Boolean(voiceDraft)}
                  />
                  <button
                    type="button"
                    className={styles.scheduleComposerButton}
                    onClick={handleOpenScheduleModal}
                    disabled={!activeContact || composerStatus === 'sending' || voiceRecording || voiceProcessing || Boolean(voiceDraft)}
                    aria-label="Programar mensaje"
                    title="Programar mensaje"
                  >
                    <Clock size={16} />
                  </button>
                </div>
                <button
                  type="button"
                  className={styles.micButton}
                  onClick={handleVoiceButtonClick}
                  disabled={composerStatus === 'sending' || voiceProcessing || Boolean(voiceDraft)}
                  aria-label={voiceRecording ? 'Terminar grabación' : voiceDraft ? 'Audio listo' : 'Grabar audio'}
                  data-recording={voiceRecording ? 'true' : undefined}
                >
                  {voiceProcessing ? <Loader2 size={18} className={styles.spin} /> : voiceRecording ? <Square size={16} /> : <Mic size={18} />}
                </button>
                <button type="submit" className={styles.sendButton} disabled={!canSend} aria-label="Enviar mensaje">
                  {composerStatus === 'sending' ? <Loader2 size={18} className={styles.spin} /> : <ArrowUp size={18} />}
                </button>
              </form>
            </>
          ) : (
            <div className={styles.noSelection}>
              <AgentRobot size={112} active />
              <strong>Selecciona un chat para trabajar</strong>
              <span>Abre una conversación y aquí tendrás mensajes, respuesta rápida, agenda y cobro en el mismo lugar.</span>
              <div className={styles.emptyActionPreview}>
                <div><MessageCircle size={16} /><span>Historial completo de mensajes</span></div>
                <div><CalendarDays size={16} /><span>Acceso rápido para agendar</span></div>
                <div><Mic size={16} /><span>Notas de voz desde escritorio</span></div>
              </div>
            </div>
          )}
        </main>

        <aside className={styles.infoPanel} aria-label="Información del contacto">
          {activeContact ? (
            <>
              <div className={styles.infoHeader}>
                  {renderAvatar(contactInfoData || activeContact)}
                <div>
                  <h2>{getContactName(contactInfoData || activeContact)}</h2>
                  <p>{stageLabel}</p>
                </div>
              </div>

              {contactInfoLoading ? <div className={styles.stateBlock}><Loader2 size={16} className={styles.spin} /> Actualizando datos...</div> : null}

              <div className={styles.infoSection}>
                <h3>Contacto</h3>
                <dl className={styles.detailList}>
                  <div><dt><Phone size={14} /> Teléfono</dt><dd>{activeContact.phone || 'Sin teléfono'}</dd></div>
                  <div><dt><Mail size={14} /> Correo</dt><dd>{activeContact.email || 'Sin correo'}</dd></div>
                  <div><dt><Tag size={14} /> Estado</dt><dd>{stageLabel}</dd></div>
                </dl>
                <div className={styles.contactTools}>
                  <label>
                    <span>Etiquetas</span>
                    <TagPicker
                      multiple
                      selectedIds={(contactInfoData || activeContact).tags || []}
                      onChange={handleUpdateContactTags}
                      allowCreate
                      disabled={savingTags}
                      portal
                      placeholder="Agregar etiqueta"
                      triggerVariant="chip"
                      closeOnSelect
                      aria-label="Etiquetas del contacto"
                    />
                    {savingTags ? <small>Guardando etiquetas...</small> : null}
                  </label>
                  <button type="button" className={styles.automationButton} onClick={openAutomationModal}>
                    <Workflow size={15} />
                    <span>Mandar a automatización</span>
                  </button>
                </div>
              </div>

              {infoPanelView === 'summary' ? (
                <>
                  <div className={styles.infoSection}>
                    <div className={styles.summaryHeaderRow}>
                      <h3>Resumen</h3>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={styles.summaryJourneyButton}
                        onClick={() => setInfoPanelView('journey')}
                      >
                        Viaje del cliente
                      </Button>
                    </div>
                    <div className={styles.metricsGrid}>
                      <span><strong>{formatCurrencyNoDecimals(contactPayments.filter(isSuccessfulPayment).reduce((sum, payment) => sum + payment.amount, 0))}</strong><small>Total Pagado</small></span>
                      <span><strong>{contactAppointments.length}</strong><small>Citas totales</small></span>
                      <span><strong>{Number(activeContact.messageCount || messages.length)}</strong><small>Mensajes</small></span>
                    </div>
                  </div>

                  <div className={styles.infoSection}>
                    <div className={styles.sectionTitleRow}>
                      <h3>Próximas citas</h3>
                      <button type="button" onClick={openNewAppointment}>Nueva</button>
                    </div>
                    <div className={styles.compactList}>
                      {contactAppointments.slice(0, 3).map((appointment) => {
                        const appointmentActive = isActiveAppointment(appointment)
                        const content = (
                          <>
                            <CalendarDays size={15} />
                            <span>
                              <strong>{appointment.title}</strong>
                              <small>{formatLocalDateTime(appointment.startTime)} · {formatPlainStatus(appointment.status)}</small>
                            </span>
                          </>
                        )
                        return appointmentActive ? (
                          <button key={appointment.id} type="button" onClick={() => openAppointmentForEdit(appointment)}>
                            {content}
                          </button>
                        ) : (
                          <div key={appointment.id}>
                            {content}
                          </div>
                        )
                      })}
                      {contactAppointments.length === 0 ? <p className={styles.mutedLine}>Sin citas registradas.</p> : null}
                    </div>
                  </div>

                  <div className={styles.infoSection}>
                    <div className={styles.sectionTitleRow}>
                      <h3>Pagos</h3>
                      <button type="button" onClick={() => setPaymentOpen(true)}>Registrar</button>
                    </div>
                    <div className={styles.compactList}>
                      {contactPayments.slice(0, 3).map((payment) => (
                        <div key={payment.id}>
                          <CreditCard size={15} />
                          <span>
                            <strong>{formatCurrency(payment.amount)}</strong>
                            <small>{formatLocalDateTime(payment.date)} · {formatPlainStatus(payment.status)}</small>
                          </span>
                        </div>
                      ))}
                      {contactPayments.length === 0 ? <p className={styles.mutedLine}>Sin pagos registrados.</p> : null}
                    </div>
                  </div>

                  <div className={styles.infoSection}>
                    <h3>Origen</h3>
                    <dl className={styles.detailList}>
                      <div><dt><MousePointerClick size={14} /> Fuente</dt><dd>{formatUrlParameter(String(trackingData.source_platform || trackingData.utm_source || '')) || 'Sin dato'}</dd></div>
                      <div><dt><Bot size={14} /> Campaña</dt><dd>{formatUrlParameter(String(trackingData.utm_campaign || trackingData.ad_name || '')) || 'Sin campaña'}</dd></div>
                      <div><dt><Clock size={14} /> Primer contacto</dt><dd>{trackingData.started_at ? formatLocalDateTime(trackingData.started_at) : 'Sin dato'}</dd></div>
                    </dl>
                  </div>
                </>
              ) : (
                <div className={`${styles.infoSection} ${styles.contactJourneySection}`} data-desktop-chat-contact-journey>
                  <div className={styles.journeyPanelHeader}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={`${styles.summaryJourneyButton} ${styles.journeySummaryButton}`}
                      onClick={() => setInfoPanelView('summary')}
                    >
                      <ChevronLeft size={15} aria-hidden="true" />
                      Resumen
                    </Button>
                  </div>
                  <ContactJourney contactId={activeContact.id} />
                </div>
              )}
            </>
          ) : (
            <div className={styles.emptyInfoState}>
              <div className={styles.emptyInfoIntro}>
                <User size={22} />
                <div>
                  <strong>Datos del contacto</strong>
                  <span>Este panel se llena al abrir una conversación.</span>
                </div>
              </div>
              <div className={styles.emptyInfoPreview}>
                <div><span>Teléfono</span><strong>Listo para contactar</strong></div>
                <div><span>Etapa</span><strong>Interesado, cita o cliente</strong></div>
                <div><span>Resumen</span><strong>Compras, citas y mensajes</strong></div>
                <div><span>Origen</span><strong>Canal, campaña y primer contacto</strong></div>
              </div>
              <div className={styles.emptyInfoMetrics}>
                <span><strong>$0</strong><small>Total Pagado</small></span>
                <span><strong>0</strong><small>Citas totales</small></span>
                <span><strong>0</strong><small>mensajes</small></span>
              </div>
            </div>
          )}
        </aside>
      </section>

      <RecordPaymentModal
        isOpen={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        initialContact={activeContact}
        lockInitialContact={Boolean(activeContact?.id)}
        onSuccess={() => {
          setPaymentOpen(false)
          showToast('success', 'Pago registrado', 'El pago quedó guardado para este contacto.')
          if (activeContactId) void loadConversation(activeContactId)
        }}
      />

      <AppointmentModal
        isOpen={appointmentOpen}
        onClose={() => {
          setAppointmentOpen(false)
          setEditingAppointmentEvent(null)
        }}
        event={editingAppointmentEvent}
        mode={editingAppointmentEvent ? 'view' : 'create'}
        calendar={selectedCalendar}
        defaultStart={defaultAppointmentRange.start}
        defaultEnd={defaultAppointmentRange.end}
        defaultTimeZone={defaultAppointmentRange.timeZone}
        defaultTitle={activeContact ? getContactName(activeContact) : ''}
        initialContact={activeContact}
        lockInitialContact={Boolean(activeContact?.id)}
        enableGuests
        defaultScheduleMode="custom"
        accessToken={accessToken || undefined}
        locationId={locationId || undefined}
        calendars={calendars}
        calendarsLoading={calendarsLoading}
        selectedCalendarId={selectedCalendar?.id || ''}
        onCalendarChange={setSelectedCalendarId}
        onSave={handleSaveAppointment}
        onDelete={editingAppointmentEvent ? handleDeleteAppointment : undefined}
      />

      <Modal
        isOpen={scheduleOpen}
        onClose={closeScheduleModal}
        title={scheduleEditingMessageId ? 'Editar programación' : 'Programar mensaje'}
        size="sm"
      >
        <form
          className={styles.scheduleModalBody}
          onSubmit={(event) => {
            event.preventDefault()
            void handleScheduleMessage()
          }}
        >
          <p className={styles.scheduleModalDescription}>
            {scheduleEditingMessageId ? 'Ajusta cuándo saldrá este mensaje.' : 'El mensaje se guardará y saldrá automáticamente a la hora elegida.'}
          </p>
          <label className={`${styles.scheduleField} ${styles.scheduleMessageField}`}>
            <span>Mensaje</span>
            <textarea
              value={composerText}
              onChange={(event) => {
                setComposerText(event.target.value)
                setScheduleError('')
              }}
              placeholder="Escribe el mensaje que quieres programar"
              rows={3}
              disabled={schedulingMessage}
            />
          </label>
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

          <div className={styles.schedulePreview} aria-live="polite">
            <Clock size={15} />
            <span>{formatSchedulePreviewLabel(schedulePreviewDate?.toISOString())}</span>
          </div>

          {scheduleError ? <p className={styles.scheduleError}>{scheduleError}</p> : null}

          <div className={styles.scheduleModalActions}>
            <Button type="button" variant="secondary" onClick={closeScheduleModal} disabled={schedulingMessage}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!canSubmitSchedule}>
              {schedulingMessage ? 'Guardando...' : scheduleEditingMessageId ? 'Guardar cambios' : 'Programar'}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={automationModalOpen}
        onClose={() => setAutomationModalOpen(false)}
        title="Mandar a automatización"
        size="md"
      >
        <form
          className={styles.automationModalBody}
          onSubmit={(event) => {
            event.preventDefault()
            void handleEnrollAutomation()
          }}
        >
          <p>
            {activeContact ? getContactName(activeContact) : 'Este contacto'} entrará a la automatización seleccionada.
          </p>
          <label>
            <span>Automatización</span>
            <CustomSelect
              value={selectedAutomationId}
              options={automations.map((automation) => ({ value: automation.id, label: automation.name }))}
              portal
              disabled={automationsLoading || automationSubmitting || automations.length === 0}
              placeholder={automationsLoading ? 'Cargando automatizaciones...' : 'Selecciona una automatización'}
              onValueChange={setSelectedAutomationId}
              aria-label="Automatización"
            />
          </label>
          {automations.length === 0 && !automationsLoading ? <p className={styles.mutedLine}>No hay automatizaciones publicadas.</p> : null}
          <div className={styles.automationModalActions}>
            <Button type="button" variant="secondary" onClick={() => setAutomationModalOpen(false)} disabled={automationSubmitting}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!selectedAutomationId || automationSubmitting}>
              {automationSubmitting ? 'Mandando...' : 'Mandar ahora'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
