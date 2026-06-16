import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Banknote,
  Bot,
  CalendarDays,
  CheckCheck,
  CircleAlert,
  Clock,
  CreditCard,
  Facebook,
  FileText,
  Globe2,
  Image as ImageIcon,
  Instagram,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  Mic,
  MousePointerClick,
  Phone,
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
import { AppointmentModal, Button, CustomSelect, Modal, RecordPaymentModal, TagPicker } from '@/components/common'
import { AgentRobot } from '@/components/ai'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import apiClient from '@/services/apiClient'
import automationsService, { type AutomationSummary } from '@/services/automationsService'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
import { conversationalAgentService, type ConversationAgentState } from '@/services/conversationalAgentService'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { highLevelService, type HighLevelChatChannel } from '@/services/highLevelService'
import { whatsappApiService, type ScheduledChatMessage, type WhatsAppApiPhoneNumber, type WhatsAppApiStatus } from '@/services/whatsappApiService'
import type { Contact, ContactAppointment, ContactPayment } from '@/types'
import { getContactStageBadge } from '@/utils/contactStageBadge'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import styles from './DesktopChat.module.css'

type ChatFilter = 'all' | 'unread' | 'appointments' | 'customers'
type AdvancedChannelFilter = 'all' | 'whatsapp' | 'messenger' | 'instagram' | 'webchat' | 'sms' | 'email'
type AdvancedSocialFilter = 'all' | 'facebook' | 'instagram' | 'messenger' | 'whatsapp' | 'google' | 'unknown'
type AdvancedOriginFilter = 'all' | 'meta' | 'site' | 'organic' | 'trigger' | 'unknown'
type AdvancedStageFilter = 'all' | 'lead' | 'appointment' | 'customer'
type AdvancedActivityFilter = 'all' | 'payments' | 'appointments' | 'with_source' | 'no_phone'
type ComposerStatus = 'idle' | 'sending'
type ChatAttachmentType = 'image' | 'audio' | 'video' | 'document' | 'file'
type DraftAttachmentKind = 'image' | 'document'
type InfoPanelView = 'summary' | 'journey'

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

function getContactChannelMeta(contact?: DesktopChatContact | Contact | null) {
  if (!contact) {
    return { label: 'Origen', Icon: MessageCircle }
  }
  const channel = getContactChannelKind(contact as DesktopChatContact)
  const social = getContactSocialKind(contact as DesktopChatContact)
  const origin = getContactOriginKind(contact as DesktopChatContact)

  if (channel === 'whatsapp' || social === 'whatsapp') return { label: 'WhatsApp', Icon: MessageCircle }
  if (channel === 'instagram' || social === 'instagram') return { label: 'Instagram', Icon: Instagram }
  if (channel === 'messenger' || social === 'messenger' || social === 'facebook') return { label: social === 'facebook' ? 'Facebook' : 'Messenger', Icon: Facebook }
  if (channel === 'webchat' || origin === 'site') return { label: 'Web', Icon: Globe2 }
  if (channel === 'sms') return { label: 'SMS', Icon: Phone }
  if (channel === 'email') return { label: 'Email', Icon: Mail }
  if (origin === 'meta') return { label: 'Meta', Icon: Facebook }
  return { label: 'Origen', Icon: MessageCircle }
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
  if (normalized.includes('image')) return 'Foto'
  if (normalized.includes('video')) return 'Video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Mensaje de voz'
  if (normalized.includes('document')) return 'Documento'
  if (normalized.includes('location')) return 'Ubicación'
  if (normalized.includes('postback')) return 'Respuesta rápida'
  if (normalized.includes('reaction')) return 'Reacción'
  return fallback
}

function getMediaAttachmentType(messageType = '', mimeType = '', name = ''): ChatAttachmentType | null {
  const normalizedType = messageType.toLowerCase()
  const normalizedMime = mimeType.toLowerCase()
  const normalizedName = name.toLowerCase()
  if (normalizedType.includes('audio') || normalizedType.includes('voice') || normalizedMime.startsWith('audio/')) return 'audio'
  if (normalizedType.includes('image') || normalizedType.includes('sticker') || normalizedMime.startsWith('image/')) return 'image'
  if (normalizedType.includes('video') || normalizedType.includes('gif') || normalizedMime.startsWith('video/')) return 'video'
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
    image: ['image', 'photo', 'foto', 'imagen'],
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

function getJourneyMediaAttachment(event: JourneyEvent): DesktopChatMessage['attachment'] | undefined {
  const data = event.data || {}
  const messageType = String(data.message_type || data.messageType || data.type || '').toLowerCase()
  const mediaUrl = pickMediaUrl(data)
  const mediaId = String(data.media_id || data.mediaId || '').trim()
  const mimeType = String(data.media_mime_type || data.mediaMimeType || data.mimeType || data.mime_type || '').trim()
  const name = String(data.media_filename || data.mediaFilename || data.filename || data.fileName || '').trim()
  const durationMs = Number(data.media_duration_ms || data.mediaDurationMs || data.durationMs || data.duration_ms || 0) || undefined
  const type = getMediaAttachmentType(messageType, mimeType, name)
  if (!type) return undefined
  return {
    type,
    url: mediaUrl,
    name: type === 'audio' ? 'Mensaje de voz' : (name || mediaId || getMessageTypeLabel(type, 'Archivo')),
    mimeType,
    durationMs
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

function getJourneyEventTitle(event: JourneyEvent) {
  if (event.type === 'whatsapp_message' || event.type === 'meta_message') return 'Mensaje'
  if (event.type === 'page_visit') return 'Visita web'
  if (event.type === 'contact_created') return 'Contacto creado'
  if (event.type === 'appointment') return 'Cita'
  if (event.type === 'payment') return 'Compra'
  return 'Movimiento'
}

function getJourneyEventDescription(event: JourneyEvent) {
  const data = event.data || {}
  if (event.type === 'whatsapp_message' || event.type === 'meta_message') {
    return pickMessageText(data) || getMessageTypeLabel(String(data.message_type || data.type || ''), 'Mensaje recibido')
  }
  if (event.type === 'page_visit') {
    return formatUrlParameter(String(data.landing_page || data.page_url || data.url || data.utm_source || 'Sitio web')) || 'Sitio web'
  }
  if (event.type === 'appointment') return String(data.title || data.status || 'Cita agendada')
  if (event.type === 'payment') return data.amount ? formatCurrencyNoDecimals(Number(data.amount || 0)) : 'Pago registrado'
  if (event.type === 'contact_created') return formatUrlParameter(String(data.source || data.conversion_source || 'Nuevo contacto')) || 'Nuevo contacto'
  return 'Actividad del contacto'
}

function getJourneyEventIcon(event: JourneyEvent) {
  if (event.type === 'whatsapp_message' || event.type === 'meta_message') return MessageCircle
  if (event.type === 'appointment') return CalendarDays
  if (event.type === 'payment') return CreditCard
  if (event.type === 'contact_created') return User
  return MousePointerClick
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
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtRef = useRef(0)
  const voiceTimerRef = useRef<number | null>(null)

  const [chats, setChats] = useState<DesktopChatContact[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  const [chatsError, setChatsError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedChatFilters>(DEFAULT_ADVANCED_FILTERS)
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
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
  const [draftAttachments, setDraftAttachments] = useState<DesktopDraftAttachment[]>([])
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftAttachment | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [conversationAgentEnabled, setConversationAgentEnabled] = useState(false)
  const [conversationAgentState, setConversationAgentState] = useState<ConversationAgentState | null>(null)
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
  const hasActiveChatFilters = Boolean(chatQuery.trim()) || chatFilter !== 'all' || activeAdvancedFilterCount > 0
  const filteredChats = useMemo(() => {
    return chats
      .filter((contact) => contactMatchesQuery(contact, chatQuery))
      .filter((contact) => contactMatchesAdvancedFilters(contact, advancedFilters))
      .filter((contact) => {
        if (chatFilter === 'unread') return Number(contact.unreadCount || 0) > 0
        if (chatFilter === 'appointments') return Boolean(contact.hasAppointments || contact.nextAppointmentDate)
        if (chatFilter === 'customers') return contact.status === 'customer'
        return true
      })
  }, [advancedFilters, chatFilter, chatQuery, chats])
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
  const journeyEventsDescending = useMemo(
    () => [...contactJourney].sort((left, right) => Date.parse(right.date) - Date.parse(left.date)),
    [contactJourney]
  )
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
      setChatsLoading(true)
      setChatsError('')
    }

    chatsRequestRef.current?.abort()
    const controller = new AbortController()
    chatsRequestRef.current = controller
    const timeoutId = window.setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS)

    try {
      const data = await apiClient.get<DesktopChatContact[]>('/contacts/chats', {
        params: {
          limit: '80',
          ...(chatQuery.trim() ? { q: chatQuery.trim() } : {})
        },
        signal: controller.signal
      })
      const nextChats = Array.isArray(data) ? data : []
      setChats(nextChats)
      setActiveContactId((current) => {
        if (current && nextChats.some((contact) => contact.id === current)) return current
        return nextChats[0]?.id || ''
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
  }, [chatQuery])

  const loadConversation = useCallback(async (contactId: string) => {
    if (!contactId) return
    setMessagesLoading(true)
    setContactInfoLoading(true)
    setConversationAgentState(null)
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
      setMessages([...journeyMessages, ...scheduledBubbles].sort((left, right) => Date.parse(left.date) - Date.parse(right.date)))
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, unreadCount: 0 } : contact))
    } catch {
      setMessages([])
      setContactJourney([])
      setContactInfoData(null)
      setConversationAgentState(null)
      setMessagesError('No se pudo cargar la conversación.')
    } finally {
      setMessagesLoading(false)
      setContactInfoLoading(false)
    }
  }, [])

  const loadSupportData = useCallback(async () => {
    setCalendarsLoading(true)
    try {
      const [status, highLevelConfig, calendarList, conversationalConfig] = await Promise.all([
        whatsappApiService.getStatus().catch(() => null),
        highLevelService.getConfig().catch(() => ({ configured: false })),
        calendarsService.getCalendars(locationId, accessToken).catch(() => []),
        conversationalAgentService.getConfig().catch(() => null)
      ])
      setWhatsappStatus(status)
      setHighLevelConnected(Boolean(highLevelConfig?.configured))
      setConversationAgentEnabled(Boolean(conversationalConfig?.enabled))
      setCalendars(calendarList)
      setSelectedCalendarId((current) => current || calendarList[0]?.id || '')
    } finally {
      setCalendarsLoading(false)
    }
  }, [accessToken, locationId])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  useEffect(() => () => {
    chatsRequestRef.current?.abort()
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

  const handleToggleConversationAgent = useCallback(async () => {
    if (!activeContact?.id || conversationAgentBusy) return
    if (!conversationAgentEnabled) {
      showToast('warning', 'Agente conversacional apagado', 'Actívalo en la sección del agente conversacional para usarlo aquí.')
      return
    }

    setConversationAgentBusy(true)
    try {
      const nextAction = conversationAgentState?.status === 'active' ? 'pause' : 'activate'
      const nextState = await conversationalAgentService.updateState(activeContact.id, nextAction)
      setConversationAgentState(nextState)
      showToast(
        'success',
        nextState.status === 'active' ? 'Agente activo' : 'Agente pausado',
        nextState.status === 'active' ? 'El agente conversacional queda trabajando en este chat.' : 'El agente queda en gris para este contacto.'
      )
    } catch (error: any) {
      showToast('error', 'No se pudo cambiar el agente', error?.message || 'Intenta otra vez.')
    } finally {
      setConversationAgentBusy(false)
    }
  }, [activeContact?.id, conversationAgentBusy, conversationAgentEnabled, conversationAgentState?.status, showToast])

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

  const renderAvatar = (contact: DesktopChatContact | Contact | null, size: 'sm' | 'md' = 'md') => {
    const photo = getContactProfilePhoto(contact)
    const initials = getContactInitials(contact)
    return (
      <span className={`${styles.avatar} ${size === 'sm' ? styles.avatarSm : ''}`}>
        {photo ? <img src={photo} alt={`Foto de ${getContactName(contact)}`} /> : initials}
      </span>
    )
  }

  const renderChannelBadge = (contact: DesktopChatContact | Contact | null, size: 'sm' | 'md' = 'sm') => {
    const meta = getContactChannelMeta(contact)
    const Icon = meta.Icon
    return (
      <span className={`${styles.channelBadge} ${size === 'md' ? styles.channelBadgeMd : ''}`} title={`Canal: ${meta.label}`}>
        <Icon size={size === 'md' ? 14 : 12} />
        <span>{meta.label}</span>
      </span>
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

  const renderAttachment = (message: DesktopChatMessage) => {
    if (!message.attachment) return null
    const { attachment } = message
    const attachmentSrc = getAttachmentSource(attachment)

    if (attachment.type === 'audio') {
      return (
        <div className={styles.audioAttachment}>
          <Mic size={15} />
          <span className={styles.audioAttachmentBody}>
            <strong>{attachment.name || 'Mensaje de voz'}</strong>
            {attachmentSrc ? <audio controls src={attachmentSrc} preload="metadata" /> : <small>Audio no disponible</small>}
          </span>
          {attachment.durationMs ? <small>{formatVoiceDuration(attachment.durationMs)}</small> : null}
        </div>
      )
    }

    if (attachment.type === 'image') {
      if (!attachmentSrc) {
        return (
          <span className={`${styles.attachment} ${styles.attachmentUnavailable}`}>
            <ImageIcon size={15} />
            <span>{attachment.name || 'Foto no disponible'}</span>
          </span>
        )
      }

      return (
        <a className={styles.mediaAttachment} href={attachmentSrc} target="_blank" rel="noreferrer" aria-label={attachment.name || 'Abrir foto'}>
          <img src={attachmentSrc} alt={attachment.name || 'Foto enviada'} loading="lazy" />
        </a>
      )
    }

    if (attachment.type === 'video') {
      if (!attachmentSrc) {
        return (
          <span className={`${styles.attachment} ${styles.attachmentUnavailable}`}>
            <Video size={15} />
            <span>{attachment.name || 'Video no disponible'}</span>
          </span>
        )
      }

      return (
        <div className={styles.mediaAttachment}>
          <video src={attachmentSrc} controls playsInline preload="metadata" />
        </div>
      )
    }

    return (
      <a className={styles.attachment} href={attachmentSrc || undefined} target="_blank" rel="noreferrer">
        <FileText size={15} />
        <span>{attachment.name || getMessageTypeLabel(attachment.type, 'Archivo')}</span>
      </a>
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

  const renderJourneyPanel = () => (
    <div className={styles.journeyList}>
      {journeyEventsDescending.length === 0 ? (
        <p className={styles.mutedLine}>Todavía no hay viaje registrado para este contacto.</p>
      ) : journeyEventsDescending.map((event, index) => {
        const Icon = getJourneyEventIcon(event)
        return (
          <div key={`${event.type}-${event.date}-${index}`} className={styles.journeyItem}>
            <span className={styles.journeyIcon}>
              <Icon size={15} />
            </span>
            <span>
              <strong>{getJourneyEventTitle(event)}</strong>
              <small>{getJourneyEventDescription(event)}</small>
              <em>{formatLocalDateTime(event.date)}</em>
            </span>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className={styles.page} data-ristak-page>
      <section className={styles.chatShell} data-desktop-chat-page>
        <aside className={styles.inboxPanel} aria-label="Lista de chats">
          <div className={styles.inboxHeader}>
            <div>
              <h2>Conversaciones</h2>
              <p>{filteredChats.length} de {chats.length} visibles</p>
            </div>
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
                onClick={() => setChatFilter(filter.id)}
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
            ) : filteredChats.length === 0 ? (
              <div className={styles.emptyChatList}>
                <MessageCircle size={22} />
                <strong>{hasActiveChatFilters ? 'No encontré chats' : 'Todavía no hay conversaciones'}</strong>
                <span>{hasActiveChatFilters ? 'Prueba con menos filtros o busca otro contacto.' : 'Cuando lleguen mensajes, aparecerán aquí con su canal, estado y último movimiento.'}</span>
                {hasActiveChatFilters ? <button type="button" onClick={resetChatFilters}>Limpiar filtros</button> : null}
              </div>
            ) : filteredChats.map((contact) => {
              const active = contact.id === activeContactId
              const unread = Number(contact.unreadCount || 0)
              return (
                <button
                  key={contact.id}
                  type="button"
                  className={`${styles.chatRow} ${active ? styles.chatRowActive : ''}`}
                  onClick={() => setActiveContactId(contact.id)}
                >
                  {renderAvatar(contact, 'sm')}
                  <span className={styles.chatRowBody}>
                    <span className={styles.chatRowTop}>
                      <strong>{getContactName(contact)}</strong>
                      <small>{contact.lastMessageDate ? formatMessageTime(contact.lastMessageDate) : ''}</small>
                    </span>
                    <span className={styles.chatPreviewLine}>
                      {renderChannelBadge(contact)}
                      <span className={styles.chatPreview}>{getChatPreview(contact)}</span>
                    </span>
                  </span>
                  {unread > 0 ? <span className={styles.unread}>{unread}</span> : null}
                </button>
              )
            })}
          </div>
        </aside>

        <main className={styles.conversationPanel} aria-label="Conversación">
          {activeContact ? (
            <>
              <header className={styles.conversationHeader}>
                <div className={styles.contactTitle}>
                  {renderAvatar(activeContact)}
                  <div>
                    <span className={styles.contactHeadingRow}>
                      <h2>{getContactName(activeContact)}</h2>
                      {renderChannelBadge(activeContact, 'md')}
                      <button
                        type="button"
                        className={styles.agentToggle}
                        data-active={conversationAgentActive ? 'true' : undefined}
                        data-enabled={conversationAgentEnabled ? 'true' : undefined}
                        onClick={handleToggleConversationAgent}
                        disabled={conversationAgentBusy}
                        aria-label={conversationAgentActive ? 'Pausar agente conversacional' : 'Activar agente conversacional'}
                        title={conversationAgentActive ? 'Agente conversacional activo' : 'Agente conversacional pausado'}
                      >
                        {conversationAgentBusy ? <Loader2 size={17} className={styles.spin} /> : <AgentRobot size={30} active={conversationAgentActive} />}
                      </button>
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
                        className={`${styles.messageBubble} ${message.direction === 'outbound' ? styles.messageOutbound : message.direction === 'system' ? styles.messageSystem : styles.messageInbound}`}
                      >
                        {renderAttachment(message)}
                        {message.text ? <p>{message.text}</p> : null}
                        {message.errorReason ? <small className={styles.errorText}>{message.errorReason}</small> : null}
                        {message.scheduledAt ? <small className={styles.scheduledText}>Programado para {formatLocalDateTime(message.scheduledAt)}</small> : null}
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
                <div className={styles.composerActionWrap}>
                  <button
                    type="button"
                    className={styles.composerPlusButton}
                    onClick={() => setComposerMenuOpen((current) => !current)}
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
                <textarea
                  data-ristak-unstyled
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  placeholder={voiceRecording ? 'Grabando audio...' : voiceDraft ? 'Audio listo para enviar' : 'Escribe una respuesta...'}
                  rows={1}
                  onFocus={() => setComposerMenuOpen(false)}
                  disabled={voiceRecording || voiceProcessing || Boolean(voiceDraft)}
                />
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

              <div className={styles.infoModeTabs} role="tablist" aria-label="Panel del contacto">
                <button
                  type="button"
                  className={infoPanelView === 'summary' ? styles.infoModeTabActive : ''}
                  onClick={() => setInfoPanelView('summary')}
                >
                  Resumen
                </button>
                <button
                  type="button"
                  className={infoPanelView === 'journey' ? styles.infoModeTabActive : ''}
                  onClick={() => setInfoPanelView('journey')}
                >
                  Viaje del héroe
                </button>
              </div>

              {infoPanelView === 'summary' ? (
                <>
                  <div className={styles.infoSection}>
                    <h3>Resumen</h3>
                    <div className={styles.metricsGrid}>
                      <span><strong>{formatCurrencyNoDecimals(contactPayments.filter(isSuccessfulPayment).reduce((sum, payment) => sum + payment.amount, 0))}</strong><small>Comprado</small></span>
                      <span><strong>{contactAppointments.filter(isActiveAppointment).length}</strong><small>Citas activas</small></span>
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
                <div className={styles.infoSection}>
                  <h3>Viaje del héroe</h3>
                  {renderJourneyPanel()}
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
                <span><strong>$0</strong><small>comprado</small></span>
                <span><strong>0</strong><small>citas</small></span>
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
