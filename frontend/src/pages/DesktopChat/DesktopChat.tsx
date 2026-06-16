import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  CalendarDays,
  CheckCheck,
  CircleAlert,
  Clock,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mail,
  MessageCircle,
  MousePointerClick,
  Phone,
  Search,
  Send,
  ListFilter,
  Sparkles,
  Tag,
  User,
  Video,
  X
} from 'lucide-react'
import { AppointmentModal, Badge, Button, CustomSelect, PageContainer, PageHeader, RecordPaymentModal } from '@/components/common'
import { RistakRobot } from '@/components/ai'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAIAgentAvailability } from '@/hooks'
import apiClient from '@/services/apiClient'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
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
    name?: string
    mimeType?: string
    durationMs?: number
  }
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
}

const CHAT_FILTERS: Array<{ id: ChatFilter; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'unread', label: 'No leídos' },
  { id: 'appointments', label: 'Con cita' },
  { id: 'customers', label: 'Clientes' }
]

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

const QUICK_REPLIES = [
  'Claro, te ayudo con eso.',
  '¿Qué día y hora te funciona para agendar?',
  'Te comparto la información en un momento.',
  'Perfecto, quedo al pendiente.'
]

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
  return ['outbound', 'business_echo', 'smb_echo', 'echo', 'message_echo'].includes(direction) ? 'outbound' : 'inbound'
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

function getJourneyMediaAttachment(event: JourneyEvent): DesktopChatMessage['attachment'] | undefined {
  const messageType = String(event.data?.message_type || '').toLowerCase()
  const mediaUrl = String(event.data?.media_url || event.data?.mediaUrl || '').trim()
  const mediaId = String(event.data?.media_id || event.data?.mediaId || '').trim()
  const mimeType = String(event.data?.media_mime_type || event.data?.mediaMimeType || '').trim()
  const name = String(event.data?.media_filename || event.data?.mediaFilename || '').trim()
  const durationMs = Number(event.data?.media_duration_ms || event.data?.mediaDurationMs || 0) || undefined
  const type = getMediaAttachmentType(messageType, mimeType, name)
  if (!type) return undefined
  return {
    type,
    url: mediaUrl,
    name: name || mediaId || getMessageTypeLabel(type, 'Archivo'),
    mimeType,
    durationMs
  }
}

function getJourneyMessage(event: JourneyEvent, index: number): DesktopChatMessage | null {
  if (event.type !== 'whatsapp_message' && event.type !== 'meta_message') return null
  const data = event.data || {}
  const text = String(
    data.message ||
    data.body ||
    data.text ||
    data.message_body ||
    data.content ||
    ''
  ).trim()
  const attachment = getJourneyMediaAttachment(event)
  const messageType = String(data.message_type || data.type || '').trim()
  if (!text && !attachment && !messageType) return null
  const direction = normalizeWhatsAppBusinessDirection(data.direction || data.message_direction || data.from_type)
  const date = pickMessageTimestamp(data, ['date', 'timestamp', 'created_at', 'createdAt', 'message_timestamp']) || event.date
  return {
    id: String(data.message_id || data.messageId || data.id || `${event.type}-${event.date}-${index}`),
    text: text || (attachment ? getMessageTypeLabel(attachment.type, 'Archivo') : getMessageTypeLabel(messageType)),
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
    notes: appointment.notes || null
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
      notes: event.data?.notes ? String(event.data.notes) : null
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
  const aiAvailability = useAIAgentAvailability()
  const messagesEndRef = useRef<HTMLDivElement | null>(null)

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

  const [composerText, setComposerText] = useState('')
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [calendarsLoading, setCalendarsLoading] = useState(false)
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [paymentOpen, setPaymentOpen] = useState(false)

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
  const canSend = Boolean(activeContact && composerText.trim() && composerStatus === 'idle')

  const loadChats = useCallback(async (options: { silent?: boolean } = {}) => {
    const silent = options.silent === true
    if (!silent) {
      setChatsLoading(true)
      setChatsError('')
    }

    try {
      const data = await apiClient.get<DesktopChatContact[]>('/contacts/chats', {
        params: {
          limit: '80',
          ...(chatQuery.trim() ? { q: chatQuery.trim() } : {})
        }
      })
      const nextChats = Array.isArray(data) ? data : []
      setChats(nextChats)
      setActiveContactId((current) => {
        if (current && nextChats.some((contact) => contact.id === current)) return current
        return nextChats[0]?.id || ''
      })
    } catch {
      if (!silent) {
        setChatsError('No se pudieron cargar los chats.')
        setChats([])
      }
    } finally {
      setChatsLoading(false)
    }
  }, [chatQuery])

  const loadConversation = useCallback(async (contactId: string) => {
    if (!contactId) return
    setMessagesLoading(true)
    setContactInfoLoading(true)
    setMessagesError('')
    try {
      const [journey, scheduledMessages, details] = await Promise.all([
        contactsService.getContactJourney(contactId),
        whatsappApiService.getScheduledMessages(contactId).catch(() => []),
        contactsService.getContactDetails(contactId).catch(() => null)
      ])
      const journeyMessages = journey.map(getJourneyMessage).filter((message): message is DesktopChatMessage => Boolean(message))
      const scheduledBubbles = scheduledMessages.map(getScheduledChatMessageBubble).filter((message): message is DesktopChatMessage => Boolean(message))
      setContactJourney(journey)
      setContactInfoData(details)
      setMessages([...journeyMessages, ...scheduledBubbles].sort((left, right) => Date.parse(left.date) - Date.parse(right.date)))
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, unreadCount: 0 } : contact))
    } catch {
      setMessages([])
      setContactJourney([])
      setContactInfoData(null)
      setMessagesError('No se pudo cargar la conversación.')
    } finally {
      setMessagesLoading(false)
      setContactInfoLoading(false)
    }
  }, [])

  const loadSupportData = useCallback(async () => {
    setCalendarsLoading(true)
    try {
      const [status, highLevelConfig, calendarList] = await Promise.all([
        whatsappApiService.getStatus().catch(() => null),
        highLevelService.getConfig().catch(() => ({ configured: false })),
        calendarsService.getCalendars(locationId, accessToken).catch(() => [])
      ])
      setWhatsappStatus(status)
      setHighLevelConnected(Boolean(highLevelConfig?.configured))
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
    loadSupportData()
  }, [loadSupportData])

  useEffect(() => {
    if (!activeContactId) {
      setMessages([])
      setContactJourney([])
      setContactInfoData(null)
      return
    }
    loadConversation(activeContactId)
  }, [activeContactId, loadConversation])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages, messagesLoading])

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
    if (!activeContact || !text) return

    if (!activeContact.phone && activeConversationChannel !== 'instagram' && activeConversationChannel !== 'messenger') {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribirle por WhatsApp o SMS.')
      return
    }

    const optimisticId = `desktop-chat-${Date.now()}`
    const sentAt = new Date().toISOString()
    const optimisticMessage: DesktopChatMessage = {
      id: optimisticId,
      text,
      date: sentAt,
      direction: 'outbound',
      status: 'enviando',
      businessPhone: selectedBusinessPhoneValue,
      businessPhoneNumberId: selectedBusinessPhone?.id || '',
      transport: whatsappConnected ? 'api' : activeConversationChannel
    }

    setComposerStatus('sending')
    if (!textOverride) setComposerText('')
    setMessages((current) => [...current, optimisticMessage])
    setChats((current) => current.map((contact) => (
      contact.id === activeContact.id
        ? {
            ...contact,
            lastMessageText: text,
            lastMessageDate: sentAt,
            lastMessageDirection: 'outbound',
            messageCount: Number(contact.messageCount || 0) + 1
          }
        : contact
    )))

    try {
      if (whatsappConnected && activeContact.phone) {
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
      setMessages((current) => current.map((item) => item.id === optimisticId ? { ...item, status: 'error', errorReason: message } : item))
      if (!textOverride) setComposerText(text)
      showToast('error', 'No se envió el mensaje', message)
    } finally {
      setComposerStatus('idle')
    }
  }

  const handleCreateAppointment = async (eventPayload: Partial<CalendarEvent>) => {
    await calendarsService.createAppointment(eventPayload, accessToken || undefined)
    setAppointmentOpen(false)
    showToast('success', 'Cita agendada', 'La cita quedó guardada para este contacto.')
    if (activeContactId) await loadConversation(activeContactId)
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

  const renderAttachment = (message: DesktopChatMessage) => {
    if (!message.attachment) return null
    const { attachment } = message
    const Icon = attachment.type === 'image' ? ImageIcon : attachment.type === 'video' ? Video : FileText
    return (
      <a className={styles.attachment} href={attachment.url || undefined} target="_blank" rel="noreferrer">
        <Icon size={15} />
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

  return (
    <PageContainer size="wide" className={styles.page}>
      <PageHeader
        eyebrow="Bandeja"
        title="Chat"
        subtitle="Responde conversaciones, agenda citas y revisa la información del contacto sin salir de la pantalla."
      />

      <div className={styles.chatToolbar}>
        <label className={styles.searchBox}>
          <Search size={16} />
          <input
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
        <div className={styles.toolbarStatus}>
          <span>{filteredChats.length} de {chats.length} conversaciones</span>
          {whatsappConnected ? <Badge variant="success">WhatsApp activo</Badge> : highLevelConnected ? <Badge variant="info">HighLevel</Badge> : <Badge variant="warning">Sin envío</Badge>}
        </div>
      </div>

      <section className={styles.chatShell} data-desktop-chat-page>
        <aside className={styles.inboxPanel} aria-label="Lista de chats">
          <div className={styles.inboxHeader}>
            <div>
              <h2>Conversaciones</h2>
              <p>{hasActiveChatFilters ? 'Vista filtrada' : 'Todas las conversaciones'}</p>
            </div>
            {activeAdvancedFilterCount > 0 ? <Badge variant="info">{activeAdvancedFilterCount} filtros</Badge> : <Badge variant="default">Bandeja</Badge>}
          </div>

          <div className={styles.filterRow} role="tablist" aria-label="Filtros de chat">
            {CHAT_FILTERS.map((filter) => (
              <React.Fragment key={filter.id}>
                <button
                  type="button"
                  className={filter.id === chatFilter ? styles.filterActive : ''}
                  onClick={() => setChatFilter(filter.id)}
                >
                  {filter.label}
                </button>
                {filter.id === 'all' ? (
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
                ) : null}
              </React.Fragment>
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
                <label>
                  <span>Canal</span>
                  <CustomSelect
                    value={advancedFilters.channel}
                    options={CHANNEL_FILTER_OPTIONS}
                    portal
                    onValueChange={(value) => setAdvancedFilters((current) => ({ ...current, channel: value as AdvancedChannelFilter }))}
                    aria-label="Filtrar por canal"
                  />
                </label>
                <label>
                  <span>Origen</span>
                  <CustomSelect
                    value={advancedFilters.origin}
                    options={ORIGIN_FILTER_OPTIONS}
                    portal
                    onValueChange={(value) => setAdvancedFilters((current) => ({ ...current, origin: value as AdvancedOriginFilter }))}
                    aria-label="Filtrar por origen"
                  />
                </label>
                <label>
                  <span>Red social</span>
                  <CustomSelect
                    value={advancedFilters.social}
                    options={SOCIAL_FILTER_OPTIONS}
                    portal
                    onValueChange={(value) => setAdvancedFilters((current) => ({ ...current, social: value as AdvancedSocialFilter }))}
                    aria-label="Filtrar por red social"
                  />
                </label>
                <label>
                  <span>Etapa</span>
                  <CustomSelect
                    value={advancedFilters.stage}
                    options={STAGE_FILTER_OPTIONS}
                    portal
                    onValueChange={(value) => setAdvancedFilters((current) => ({ ...current, stage: value as AdvancedStageFilter }))}
                    aria-label="Filtrar por etapa"
                  />
                </label>
                <label>
                  <span>Actividad</span>
                  <CustomSelect
                    value={advancedFilters.activity}
                    options={ACTIVITY_FILTER_OPTIONS}
                    portal
                    onValueChange={(value) => setAdvancedFilters((current) => ({ ...current, activity: value as AdvancedActivityFilter }))}
                    aria-label="Filtrar por actividad"
                  />
                </label>
              </div>
            </div>
          ) : null}

          <div className={styles.chatList} data-chat-list>
            {chatsLoading ? (
              <div className={styles.stateBlock}><Loader2 size={18} className={styles.spin} /> Cargando chats...</div>
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
                    <span className={styles.chatPreview}>{getChatPreview(contact)}</span>
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
                    <h2>{getContactName(activeContact)}</h2>
                    <p>{getContactDetail(activeContact)}</p>
                  </div>
                </div>
                <div className={styles.quickActions}>
                  <Button variant="secondary" size="sm" leftIcon={<CalendarDays size={15} />} onClick={() => setAppointmentOpen(true)}>
                    Agendar
                  </Button>
                  <Button variant="secondary" size="sm" leftIcon={<CreditCard size={15} />} onClick={() => setPaymentOpen(true)}>
                    Cobrar
                  </Button>
                </div>
              </header>

              <div className={styles.aiStrip}>
                <RistakRobot size={54} thinking={composerStatus === 'sending'} />
                <div>
                  <strong>Agente AI</strong>
                  <span>{aiAvailability.configured ? 'Listo para ayudarte con contexto del cliente.' : 'Conecta OpenAI para sugerencias inteligentes.'}</span>
                </div>
                <button type="button" onClick={() => setComposerText(`Sugiere una respuesta breve para ${getContactName(activeContact)}.`)}>
                  <Sparkles size={15} />
                  Preparar respuesta
                </button>
              </div>

              <div className={styles.messagePane}>
                {messagesLoading ? (
                  <div className={styles.stateBlock}><Loader2 size={18} className={styles.spin} /> Cargando conversación...</div>
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

              <div className={styles.quickReplyRow}>
                {QUICK_REPLIES.map((reply) => (
                  <button key={reply} type="button" onClick={() => setComposerText(reply)}>
                    {reply}
                  </button>
                ))}
              </div>

              <form
                className={styles.composer}
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSendMessage()
                }}
              >
                <textarea
                  value={composerText}
                  onChange={(event) => setComposerText(event.target.value)}
                  placeholder="Escribe una respuesta..."
                  rows={2}
                />
                <Button type="submit" disabled={!canSend} loading={composerStatus === 'sending'} leftIcon={<Send size={16} />}>
                  Enviar
                </Button>
              </form>
            </>
          ) : (
            <div className={styles.noSelection}>
              <RistakRobot size={86} thinking />
              <strong>Selecciona un chat para trabajar</strong>
              <span>Abre una conversación y aquí tendrás mensajes, respuesta rápida, agenda y cobro en el mismo lugar.</span>
              <div className={styles.emptyActionPreview}>
                <div><MessageCircle size={16} /><span>Historial completo de mensajes</span></div>
                <div><CalendarDays size={16} /><span>Acceso rápido para agendar</span></div>
                <div><Sparkles size={16} /><span>Ayuda del agente AI al responder</span></div>
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
              </div>

              <div className={styles.infoSection}>
                <h3>Resumen</h3>
                <div className={styles.metricsGrid}>
                  <span><strong>{formatCurrency(contactPayments.filter(isSuccessfulPayment).reduce((sum, payment) => sum + payment.amount, 0))}</strong><small>Comprado</small></span>
                  <span><strong>{contactAppointments.filter(isActiveAppointment).length}</strong><small>Citas activas</small></span>
                  <span><strong>{Number(activeContact.messageCount || messages.length)}</strong><small>Mensajes</small></span>
                </div>
              </div>

              <div className={styles.infoSection}>
                <div className={styles.sectionTitleRow}>
                  <h3>Próximas citas</h3>
                  <button type="button" onClick={() => setAppointmentOpen(true)}>Nueva</button>
                </div>
                <div className={styles.compactList}>
                  {contactAppointments.slice(0, 3).map((appointment) => (
                    <div key={appointment.id}>
                      <CalendarDays size={15} />
                      <span>
                        <strong>{appointment.title}</strong>
                        <small>{formatLocalDateTime(appointment.startTime)} · {formatPlainStatus(appointment.status)}</small>
                      </span>
                    </div>
                  ))}
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
        onClose={() => setAppointmentOpen(false)}
        mode="create"
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
        onSave={handleCreateAppointment}
      />
    </PageContainer>
  )
}
