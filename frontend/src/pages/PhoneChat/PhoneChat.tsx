import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Archive,
  BadgeDollarSign,
  Bell,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
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
  MonitorX,
  MoreHorizontal,
  MousePointerClick,
  Phone,
  Plus,
  ReceiptText,
  Search,
  Send,
  Smartphone,
  Tag,
  User,
  X
} from 'lucide-react'
import { AppointmentModal, Icon, RecordPaymentModal } from '@/components/common'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig } from '@/hooks'
import apiClient from '@/services/apiClient'
import { calendarsService, type Calendar, type CalendarEvent } from '@/services/calendarsService'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { mobileAppService, type MobilePhotoAttachment } from '@/services/mobileAppService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { whatsappApiService, type WhatsAppApiStatus } from '@/services/whatsappApiService'
import type { Contact } from '@/types'
import { getContactStageBadge } from '@/utils/contactStageBadge'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import styles from './PhoneChat.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_CHAT_SELECTOR = '[data-phone-chat-scrollable="true"], [contenteditable="true"], textarea, input, select'
const CHAT_READ_STATE_KEY = 'ristak_phone_chat_read_state_v1'
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
type ActionSheet = 'attachments' | 'payment' | 'appointment' | 'notifications' | 'newChat' | null
type ChatFilter = 'all' | 'unread' | 'appointments' | 'customers' | 'leads'

const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const CANCELED_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'deleted', 'failed', 'invalid'])

interface ChatMessage {
  id: string
  text: string
  date: string
  direction: 'inbound' | 'outbound' | 'system'
  status?: string
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
  lastMessageDate?: string
  lastMessageDirection?: string
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
  if (event.type !== 'whatsapp_message') return null

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
    id: String(event.data?.whatsapp_api_message_id || event.data?.whatsapp_message_id || event.data?.attribution_record_id || `message-${index}`),
    text: text || (attachment ? '' : getMessageTypeLabel(messageType)),
    date: event.date,
    direction,
    status: String(event.data?.status || ''),
    businessPhone: String(event.data?.business_phone || ''),
    businessPhoneNumberId: String(event.data?.business_phone_number_id || ''),
    transport: String(event.data?.transport || 'api'),
    attachment
  }
}

function getMessageTypeLabel(type = '') {
  const normalized = type.toLowerCase()
  if (normalized.includes('image')) return 'Foto'
  if (normalized.includes('video')) return 'Video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Mensaje de voz'
  if (normalized.includes('document')) return 'Documento'
  if (normalized.includes('location')) return 'Ubicación'
  return 'Mensaje de WhatsApp'
}

function getReadableValue(value?: string | number | null) {
  if (value === null || value === undefined) return ''
  const normalized = String(value).trim()
  if (!normalized || ['null', 'undefined', 'nan'].includes(normalized.toLowerCase())) return ''
  return formatUrlParameter(normalized) || normalized
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
  if (event.type === 'whatsapp_message') return 'Mensaje de WhatsApp'
  return 'Actividad'
}

function isWhatsAppJourneyEvent(event?: JourneyEvent | null) {
  if (!event) return false
  const data = event.data || {}
  const source = String(data.source || data.referral_source_app || data.referral_entry_point || '').toLowerCase()

  return event.type === 'whatsapp_message' || source.includes('whatsapp')
}

function getJourneyEventIcon(event: JourneyEvent) {
  if (isWhatsAppJourneyEvent(event)) return <Icon name="whatsapp" size={15} />

  if (event.type === 'page_visit') return <MousePointerClick size={15} />
  if (event.type === 'contact_created') return <User size={15} />
  if (event.type === 'appointment') return <CalendarDays size={15} />
  if (event.type === 'payment') return <DollarSign size={15} />

  return <MousePointerClick size={15} />
}

function getJourneyEventIconClass(event: JourneyEvent) {
  if (isWhatsAppJourneyEvent(event)) return styles.contactInfoTimelineIconWhatsapp

  if (event.type === 'page_visit') return styles.contactInfoTimelineIconVisit
  if (event.type === 'contact_created') return styles.contactInfoTimelineIconContact
  if (event.type === 'appointment') return styles.contactInfoTimelineIconAppointment
  if (event.type === 'payment') return styles.contactInfoTimelineIconPayment

  return styles.contactInfoTimelineIconDefault
}

function getJourneyEventDescription(event: JourneyEvent) {
  const data = event.data || {}

  if (event.type === 'page_visit') {
    return getPageName(data.page_url || data.landing_page) || normalizeTrafficSource(data) || 'Visita registrada'
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
    return getReadableValue(data.message_text || data.message || data.body) || getMessageTypeLabel(String(data.message_type || ''))
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
  const typeLabel = text ? text : getMessageTypeLabel(contact.lastMessageType || '')
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
  const [searchParams] = useSearchParams()
  const requestedContactParam = searchParams.get('contact')
  const { locationId, accessToken } = useAuth()
  const { labels } = useLabels()
  const { showToast } = useNotification()
  const { timezone, formatLocalDateShort, formatLocalDateTime } = useTimezone()
  const [defaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [calendarPushEnabled, setCalendarPushEnabled] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [chatPushEnabled, setChatPushEnabled] = useAppConfig<boolean>('chat_push_notifications_enabled', true)
  const [paymentPushEnabled, setPaymentPushEnabled] = useAppConfig<boolean>('payment_push_notifications_enabled', true)
  const [pushCalendarIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])

  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  const [chats, setChats] = useState<ChatContact[]>([])
  const [chatsLoading, setChatsLoading] = useState(true)
  const [chatsError, setChatsError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [contactQuery, setContactQuery] = useState('')
  const [contactResults, setContactResults] = useState<Contact[]>([])
  const [contactsLoading, setContactsLoading] = useState(false)
  const [activeContactId, setActiveContactId] = useState<string | null>(null)
  const [conversationOpen, setConversationOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [contactJourney, setContactJourney] = useState<JourneyEvent[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<MobilePhotoAttachment[]>([])
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftAttachment | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceElapsedMs, setVoiceElapsedMs] = useState(0)
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [selectedBusinessPhoneId, setSelectedBusinessPhoneId] = useState('')
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [sheet, setSheet] = useState<ActionSheet>(null)
  const [contactInfoOpen, setContactInfoOpen] = useState(false)
  const [contactInfoContact, setContactInfoContact] = useState<Contact | null>(null)
  const [contactInfoLoading, setContactInfoLoading] = useState(false)
  const [contactInfoError, setContactInfoError] = useState('')
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single')
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [requestingPush, setRequestingPush] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLDivElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const photosInputRef = useRef<HTMLInputElement | null>(null)
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtRef = useRef(0)
  const voiceTimerRef = useRef<number | null>(null)
  const voiceCancelRef = useRef(false)

  const activeContact = useMemo(
    () => chats.find((contact) => contact.id === activeContactId) || null,
    [activeContactId, chats]
  )
  const contactInfoData = contactInfoContact || activeContact
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
  const contactInfoRecentEvents = useMemo(
    () => [...contactJourney].sort((left, right) => Date.parse(right.date) - Date.parse(left.date)).slice(0, 6),
    [contactJourney]
  )

  const selectedCalendar = useMemo(
    () => calendars.find((calendar) => calendar.id === selectedCalendarId) || calendars[0] || null,
    [calendars, selectedCalendarId]
  )

  const initialContact = useMemo(() => toPaymentContact(activeContact), [activeContact])
  const defaultAppointmentRange = useMemo(() => createDefaultAppointmentRange(timezone), [timezone])
  const whatsappConnected = Boolean(whatsappStatus?.connected && whatsappStatus?.configured)
  const businessPhones = whatsappStatus?.phoneNumbers || []
  const selectedBusinessPhone = useMemo(() => {
    return businessPhones.find((phone) => phone.id === selectedBusinessPhoneId) ||
      businessPhones.find((phone) => phone.is_default_sender) ||
      whatsappStatus?.selectedPhone ||
      businessPhones[0] ||
      null
  }, [businessPhones, selectedBusinessPhoneId, whatsappStatus?.selectedPhone])
  const selectedBusinessPhoneValue = getBusinessPhoneValue(selectedBusinessPhone)
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
  const hasComposerContent = Boolean(messageText.trim() || draftAttachments.length > 0 || voiceDraft)
  const canSendMessage = Boolean(activeContact?.phone && hasComposerContent && composerStatus !== 'sending' && !voiceRecording)
  const hasChats = chats.length > 0
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
    if (chatFilter === 'unread') return chats.filter((contact) => Number(contact.unreadCount || 0) > 0)
    if (chatFilter === 'appointments') return chats.filter(isAppointmentContact)
    if (chatFilter === 'customers') return chats.filter(isCustomerContact)
    if (chatFilter === 'leads') return chats.filter(isLeadContact)
    return chats
  }, [chatFilter, chats, isAppointmentContact, isCustomerContact, isLeadContact])
  const unreadTotal = useMemo(
    () => chats.reduce((total, contact) => total + Math.max(0, Number(contact.unreadCount || 0)), 0),
    [chats]
  )

  const ensureChatContact = useCallback((contact: Contact) => {
    const nextContact = toChatContact(contact)
    setChats((current) => {
      if (current.some((item) => item.id === nextContact.id)) return current
      return [nextContact, ...current]
    })
    return nextContact
  }, [])

  const loadChats = useCallback(async () => {
    setChatsLoading(true)
    setChatsError('')

    try {
      const trimmed = chatQuery.trim()
      const data = await apiClient.get<ChatContact[]>('/contacts/chats', {
        params: {
          limit: '60',
          ...(trimmed ? { q: trimmed } : {})
        }
      })

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

      const readState = ensureReadBaselines(nextChats, readChatReadState())
      nextChats = nextChats.map((contact) => applyLocalUnreadState(contact, readState))

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
        if (current && nextChats.some((contact) => contact.id === current)) return current
        return null
      })

      if (requestedContact) {
        setConversationOpen(true)
      }
    } catch {
      setChatsError('No se pudieron cargar los chats.')
      setChats([])
    } finally {
      setChatsLoading(false)
    }
  }, [activeContactId, chatQuery, conversationOpen, requestedContactParam])

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

  const loadConversation = useCallback(async (contactId: string) => {
    setMessagesLoading(true)
    try {
      const journey = await contactsService.getContactJourney(contactId)
      setContactJourney(journey)
      const nextMessages = journey
        .map(getJourneyMessage)
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())

      setMessages(nextMessages)
    } catch {
      setMessages([])
      setContactJourney([])
    } finally {
      setMessagesLoading(false)
    }
  }, [])

  const loadSupportData = useCallback(async () => {
    const [status] = await Promise.all([
      whatsappApiService.getStatus().catch(() => null),
      locationId && accessToken
        ? calendarsService.getCalendars(locationId, accessToken).then((items) => {
            setCalendars(items)
            const preferred = items.find((calendar) => calendar.id === defaultCalendarId)
            setSelectedCalendarId((current) => current || preferred?.id || items[0]?.id || '')
          }).catch(() => setCalendars([]))
        : Promise.resolve()
    ])

    if (status) setWhatsappStatus(status)
  }, [accessToken, defaultCalendarId, locationId])

  useEffect(() => {
    document.title = activeContact ? `${getContactName(activeContact)} | Ristak Chat` : 'Ristak Chat'
  }, [activeContact])

  useEffect(() => {
    if (!businessPhones.length) {
      setSelectedBusinessPhoneId('')
      return
    }

    setSelectedBusinessPhoneId((current) => {
      if (current && businessPhones.some((phone) => phone.id === current)) return current

      const lastInboundBusinessPhone = [...messages]
        .filter((message) => message.direction === 'inbound' && message.businessPhone)
        .sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0]?.businessPhone

      const fromConversation = lastInboundBusinessPhone
        ? businessPhones.find((phone) => phoneLooksSame(getBusinessPhoneValue(phone), lastInboundBusinessPhone))
        : null

      return fromConversation?.id ||
        businessPhones.find((phone) => phone.is_default_sender)?.id ||
        whatsappStatus?.selectedPhone?.id ||
        businessPhones[0]?.id ||
        ''
    })
  }, [businessPhones, messages, whatsappStatus?.selectedPhone?.id])

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
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlHeight = html.style.height
    const previousHtmlOverscroll = html.style.overscrollBehavior
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    let startX = 0
    let startY = 0

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'

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

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })

    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)
      html.style.overflow = previousHtmlOverflow
      html.style.height = previousHtmlHeight
      html.style.overscrollBehavior = previousHtmlOverscroll
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
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

  useEffect(() => {
    setContactInfoOpen(false)
    setContactInfoContact(null)
    setContactInfoError('')
    setContactInfoLoading(false)
  }, [activeContactId])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const shouldSearchContacts = sheet === 'newChat' || (!hasChats && chatQuery.trim().length >= 2)
    if (!shouldSearchContacts) {
      setContactResults([])
      return
    }

    const timer = window.setTimeout(() => {
      loadContactResults(sheet === 'newChat' ? contactQuery : chatQuery)
    }, 160)

    return () => window.clearTimeout(timer)
  }, [accessState, chatQuery, contactQuery, hasChats, loadContactResults, sheet])

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
    handleCancelVoiceDraft()
    markContactReadState(chatContact)
    setActiveContactId(nextContact.id)
    setChats((current) => current.map((item) => (
      item.id === nextContact.id ? { ...item, unreadCount: 0 } : item
    )))
    setConversationOpen(true)
    setSheet(null)
    setContactInfoOpen(false)
    setContactQuery('')
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleBackToChats = () => {
    handleCancelVoiceDraft()
    setConversationOpen(false)
    setSheet(null)
    setContactInfoOpen(false)
    setDraftAttachments([])
    setVoiceDraft(null)
  }

  const handleOpenContactInfo = async () => {
    if (!activeContact) return

    setSheet(null)
    setContactInfoOpen(true)
    setContactInfoError('')

    if (contactInfoContact?.id === activeContact.id) return

    setContactInfoContact(activeContact)
    setContactInfoLoading(true)

    try {
      const details = await contactsService.getContactDetails(activeContact.id)
      setContactInfoContact(details)
      setChats((current) => current.map((contact) => (
        contact.id === details.id ? { ...contact, ...details } : contact
      )))
    } catch {
      setContactInfoError('No se pudo cargar todo el detalle. Te muestro lo que ya está guardado en este chat.')
    } finally {
      setContactInfoLoading(false)
    }
  }

  const handleContactInfoAction = (nextSheet: Exclude<ActionSheet, 'newChat' | 'notifications' | null>) => {
    if (nextSheet === 'payment') setPaymentMode('single')
    setContactInfoOpen(false)
    setSheet(nextSheet)
  }

  const handleUnavailableAttachment = (label: string) => {
    showToast('info', label, 'Esta opción ya está en el menú. La conexión real se activa cuando los archivos del celular estén conectados.')
  }

  const addDraftAttachment = (attachment: MobilePhotoAttachment) => {
    setDraftAttachments((current) => [attachment, ...current].slice(0, 4))
    showToast('success', 'Foto lista', 'Revisa la vista previa y toca enviar.')
  }

  const readImageFile = (file: File, source: 'camera' | 'photos') => {
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

      addDraftAttachment({
        id: `photo-${Date.now()}`,
        name: file.name || `photo-${Date.now()}`,
        type: file.type || 'image/jpeg',
        dataUrl,
        source
      })
    }
    reader.onerror = () => showToast('error', 'No se pudo leer', 'Intenta elegir la foto otra vez.')
    reader.readAsDataURL(file)
  }

  const handleWebPhotoSelected = (source: 'camera' | 'photos', event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    readImageFile(file, source)
  }

  const handlePickPhoto = async (source: 'camera' | 'photos') => {
    setSheet(null)

    if (mobileAppService.isNative()) {
      try {
        const photo = await mobileAppService.pickPhoto(source)
        if (photo) addDraftAttachment(photo)
      } catch (error: any) {
        showToast('error', source === 'camera' ? 'No se abrió la cámara' : 'No se abrieron las fotos', error?.message || 'Revisa los permisos del celular e intenta otra vez.')
      }
      return
    }

    const input = source === 'camera' ? cameraInputRef.current : photosInputRef.current
    input?.click()
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

    if (!activeContact.phone) {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribir por WhatsApp.')
      return
    }

    if (!whatsappConnected) {
      showToast('error', 'WhatsApp no está conectado', 'Conecta WhatsApp API en configuración para enviar mensajes desde Ristak.')
      return
    }

    if (!selectedBusinessPhoneValue) {
      showToast('error', 'Falta el número emisor', 'Elige el WhatsApp del negocio que responderá este chat.')
      return
    }

    if (transport === 'qr' && (attachmentsToSend.length > 0 || voiceToSend)) {
      showToast('warning', 'QR solo manda texto', 'Quita el archivo o envía con la conexión oficial si todavía está disponible.')
      return
    }

    if (transport === 'api' && !apiReplyWindowOpen) {
      showToast('warning', 'Ya pasaron 24 horas', selectedQrReady
        ? 'Usa el botón QR o manda una plantilla aprobada desde WhatsApp.'
        : 'Manda una plantilla aprobada o conecta el QR de este número en Configuración.')
      return
    }

    if (transport === 'qr' && !selectedQrReady) {
      showToast('error', 'QR no conectado', 'Conecta este número por QR en Configuración > WhatsApp.')
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
          transport,
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
          transport,
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
          status: transport === 'qr' ? 'enviando por QR' : 'enviando',
          businessPhone: selectedBusinessPhoneValue,
          businessPhoneNumberId: selectedBusinessPhone?.id || '',
          transport
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
        await whatsappApiService.sendAudio({
          to: activeContact.phone || '',
          from: selectedBusinessPhoneValue,
          audioDataUrl: voiceToSend.dataUrl,
          durationMs: voiceToSend.durationMs,
          externalId: `${optimisticId}-audio`
        })
        setMessages((current) => current.map((message) => (
          message.id === `${optimisticId}-audio` ? { ...message, status: 'sent' } : message
        )))
      } else if (attachmentsToSend.length > 0) {
        await Promise.all(attachmentsToSend.map((attachment, index) => (
          whatsappApiService.sendImage({
            to: activeContact.phone || '',
            from: selectedBusinessPhoneValue,
            imageDataUrl: attachment.dataUrl,
            caption: index === 0 ? text : '',
            externalId: `${optimisticId}-image-${index}`
          })
        )))
        setMessages((current) => current.map((message) => (
          message.id.startsWith(`${optimisticId}-image-`) ? { ...message, status: 'sent' } : message
        )))
      } else {
        await whatsappApiService.sendText({
          to: activeContact.phone,
          from: selectedBusinessPhoneValue,
          text,
          externalId: optimisticId,
          transport,
          phoneNumberId: selectedBusinessPhone?.id || undefined
        })
        setMessages((current) => current.map((message) => (
          message.id === optimisticId ? { ...message, status: 'sent' } : message
        )))
      }
      await loadConversation(activeContact.id)
      await loadChats()
    } catch (error: any) {
      setMessages((current) => current.map((message) => (
        message.id === optimisticId || message.id === `${optimisticId}-audio` || message.id.startsWith(`${optimisticId}-image-`) ? { ...message, status: 'error' } : message
      )))
      setDraftAttachments(attachmentsToSend)
      setVoiceDraft(voiceToSend)
      showToast('error', 'No se envió el mensaje', error?.message || 'Intenta enviar el mensaje otra vez.')
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
    if (!selectedCalendar) return

    try {
      await calendarsService.createAppointment({
        calendarId: selectedCalendar.id,
        ...(locationId ? { locationId } : {}),
        ...payload
      }, accessToken || undefined)

      setAppointmentOpen(false)
      setSheet(null)
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

  const renderAvatar = (contact: Contact) => {
    const photoUrl = getContactProfilePhoto(contact as ChatContact)

    return (
      <span className={styles.avatar}>
        {photoUrl ? (
          <img src={photoUrl} alt="" loading="lazy" referrerPolicy="no-referrer" />
        ) : getContactInitials(contact)}
      </span>
    )
  }

  const renderContactButton = (contact: Contact, source: 'chat' | 'contact') => {
    const chatContact = contact as ChatContact
    const subtitle = source === 'chat' ? getChatPreview(chatContact) : getContactDetail(contact)
    const dateLabel = source === 'chat' ? formatMessageDate(chatContact.lastMessageDate || contact.createdAt) : ''
    const unreadCount = Number(chatContact.unreadCount || 0)
    const hasUnread = source === 'chat' && unreadCount > 0

    return (
      <button
        key={contact.id}
        type="button"
        className={`${styles.chatItem} ${activeContact?.id === contact.id ? styles.chatItemActive : ''} ${hasUnread ? styles.chatItemUnread : ''}`}
        onClick={() => handleSelectContact(contact)}
      >
        {renderAvatar(contact)}
        <span className={styles.chatMain}>
          <strong>{getContactName(contact)}</strong>
          <small>{subtitle}</small>
        </span>
        <span className={styles.chatMeta}>
          {dateLabel && <small className={hasUnread ? styles.chatUnreadTime : undefined}>{dateLabel}</small>}
          {hasUnread && <i aria-label={`${unreadCount} mensajes no leídos`}>{unreadCount > 9 ? '9+' : unreadCount}</i>}
        </span>
      </button>
    )
  }

  const renderChats = () => {
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
          <button type="button" onClick={loadChats}>Intentar otra vez</button>
        </div>
      )
    }

    if (chats.length === 0 && chatQuery.trim().length >= 2) {
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

    if (chats.length === 0) {
      return (
        <div className={styles.emptyChats}>
          <span className={styles.emptyChatsIcon}>
            <Icon name="whatsapp" size={34} />
          </span>
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
        <button type="button" className={styles.archiveRow}>
          <Archive size={21} />
          <strong>Archivados</strong>
          <span>0</span>
        </button>
        {filteredChats.length > 0 ? (
          filteredChats.map((contact) => renderContactButton(contact, 'chat'))
        ) : (
          <div className={styles.emptyChats}>
            <span className={styles.emptyChatsIcon}>
              <Icon name="whatsapp" size={30} />
            </span>
            <strong>No hay chats en este filtro</strong>
            <small>Cambia el filtro o busca un contacto para iniciar una conversación.</small>
          </div>
        )}
      </>
    )
  }

  const renderMessages = () => {
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

    return messages.map((message) => (
      <div
        key={message.id}
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
          <span>
            {message.transport === 'qr' && <em className={styles.messageTransport}>QR</em>}
            {formatMessageTime(message.date)}
            {message.direction === 'outbound' && (
              <Check size={15} className={message.status === 'error' ? styles.messageErrorIcon : undefined} />
            )}
          </span>
        </div>
      </div>
    ))
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

  const renderSenderBar = () => {
    if (!activeContact || businessPhones.length === 0) return null

    const windowLabel = apiReplyWindowOpen
      ? 'API disponible'
      : selectedQrReady
        ? 'Fuera de 24 h · QR listo'
        : 'Fuera de 24 h'

    return (
      <div className={styles.senderBar}>
        <div className={styles.senderSelectWrap}>
          <Smartphone size={15} />
          <select
            value={selectedBusinessPhone?.id || ''}
            onChange={(event) => setSelectedBusinessPhoneId(event.target.value)}
            aria-label="Numero de WhatsApp que respondera"
          >
            {businessPhones.map((phone) => (
              <option key={phone.id} value={phone.id}>
                {getBusinessPhoneLabel(phone)}
              </option>
            ))}
          </select>
        </div>
        <span className={apiReplyWindowOpen ? styles.senderStatusOpen : styles.senderStatusClosed}>
          {windowLabel}
        </span>
        {!apiReplyWindowOpen && selectedQrReady && messageText.trim() && draftAttachments.length === 0 && (
          <button
            type="button"
            className={styles.senderQrButton}
            onClick={() => handleSendMessage('qr')}
            disabled={composerStatus === 'sending'}
          >
            <Send size={14} />
            Enviar QR
          </button>
        )}
      </div>
    )
  }

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
    const resolvedMetaAttribution = getResolvedMetaAttribution(contactInfoData, contactJourney)
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

          {contactInfoRecentEvents.length > 0 && (
            <section className={styles.contactInfoSection}>
              <h3>Viaje del cliente</h3>
              <div className={styles.contactInfoTimeline}>
                {contactInfoRecentEvents.map((event, index) => (
                  <div key={`${event.type}-${event.date}-${index}`} className={styles.contactInfoTimelineItem}>
                    <span className={`${styles.contactInfoTimelineIcon} ${getJourneyEventIconClass(event)}`}>
                      {getJourneyEventIcon(event)}
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

  const renderAttachmentsSheet = () => {
    const attachmentActions = [
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
    <main className={`${styles.phoneChatPage} ${conversationOpen ? styles.conversationOpen : ''}`} aria-label="Chat móvil de Ristak">
      <div className={styles.phoneFrame}>
        <section className={styles.chatListScreen} aria-label="Lista de chats">
          <header className={styles.chatListHeader}>
            <div className={styles.topActionRow}>
              <button type="button" className={styles.roundButton} onClick={() => setSheet('notifications')} aria-label="Más opciones">
                <MoreHorizontal size={24} />
              </button>
              <div className={styles.topRightActions}>
                <button type="button" className={styles.roundButton} onClick={() => handlePickPhoto('camera')} aria-label="Abrir cámara">
                  <Camera size={24} />
                </button>
                <button type="button" className={styles.newChatButton} onClick={() => setSheet('newChat')} aria-label="Nuevo chat">
                  <Plus size={32} />
                </button>
              </div>
            </div>
            <h1>Chats</h1>
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
            <div className={styles.filterChips} data-phone-chat-scrollable="true">
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

          <PhoneEcosystemNav active="chat" badges={{ chat: unreadTotal }} />
        </section>

        <section className={styles.conversationScreen} aria-label="Conversación">
          <header className={styles.conversationHeader}>
            <button type="button" className={styles.backButton} onClick={handleBackToChats} aria-label="Volver a chats">
              <ChevronLeft size={32} />
            </button>

            {activeContact ? (
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

            <div className={styles.callActions}>
              <button type="button" onClick={() => setSheet('appointment')} aria-label="Agendar cita">
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
                <BadgeDollarSign size={25} />
              </button>
            </div>
          </header>

          <div className={styles.messagesPane} data-phone-chat-scrollable="true">
            {renderMessages()}
            <div ref={messagesEndRef} />
          </div>

          <div className={styles.composerShell}>
            {renderSenderBar()}
            {renderDraftAttachments()}
            {renderVoiceDraft()}
            <div className={styles.composer}>
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
                  aria-disabled={!activeContact?.phone || composerStatus === 'sending' || voiceRecording || Boolean(voiceDraft)}
                  data-placeholder={voiceRecording ? 'Grabando...' : voiceDraft ? 'Audio listo' : activeContact?.phone ? '' : 'Sin teléfono'}
                  contentEditable={Boolean(activeContact?.phone && composerStatus !== 'sending' && !voiceRecording && !voiceDraft)}
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
              <button type="button" className={styles.composerIconButton} onClick={() => handlePickPhoto('camera')} aria-label="Cámara">
                <Camera size={29} />
              </button>
              <button
                type="button"
                className={`${styles.composerIconButton} ${voiceRecording ? styles.composerMicRecording : ''}`}
                onClick={handleVoiceOrSendButtonClick}
                disabled={composerStatus === 'sending'}
                aria-label={voiceRecording ? 'Detener grabación' : canSendMessage ? 'Enviar mensaje' : 'Grabar mensaje de voz'}
              >
                {composerStatus === 'sending' ? <Loader2 size={23} className={styles.spinIcon} /> : canSendMessage ? <Send size={25} /> : <Mic size={30} />}
              </button>
            </div>
          </div>
        </section>

        {renderContactInfoScreen()}
      </div>

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
        <div className={styles.sheetBackdrop} onClick={() => setSheet(null)}>
          <section
            className={`${styles.sheetPanel} ${sheet === 'payment' ? styles.paymentSheet : ''} ${sheet === 'attachments' ? styles.attachmentsSheet : ''}`}
            onClick={(event) => event.stopPropagation()}
            aria-label="Acciones del chat"
          >
            <div className={styles.sheetHandle} />
            {sheet !== 'attachments' && (
              <div className={styles.sheetHeader}>
                <div>
                  <p>{activeContact ? getContactName(activeContact) : 'Ristak Chat'}</p>
                  <h2>
                    {sheet === 'payment' && 'Registrar pago'}
                    {sheet === 'appointment' && 'Agendar cita'}
                    {sheet === 'notifications' && 'Alertas del celular'}
                    {sheet === 'newChat' && 'Nuevo chat'}
                  </h2>
                </div>
                <button type="button" onClick={() => setSheet(null)} aria-label="Cerrar panel">
                  <X size={20} />
                </button>
              </div>
            )}

            {sheet === 'newChat' && renderNewChatSheet()}
            {sheet === 'attachments' && renderAttachmentsSheet()}

            {sheet === 'payment' && (
              <>
                <div className={styles.segmentedControl}>
                  <button
                    type="button"
                    className={paymentMode === 'single' ? styles.segmentActive : ''}
                    onClick={() => setPaymentMode('single')}
                  >
                    Pago único
                  </button>
                  <button
                    type="button"
                    className={paymentMode === 'partial' ? styles.segmentActive : ''}
                    onClick={() => setPaymentMode('partial')}
                  >
                    Plan de pagos
                  </button>
                </div>
                <div className={styles.embeddedPayment} data-phone-chat-scrollable="true">
                  <RecordPaymentModal
                    key={`${paymentMode}-${initialContact?.id || 'empty'}`}
                    variant="embedded"
                    isOpen
                    initialPaymentMode={paymentMode}
                    initialContact={initialContact}
                    onClose={() => setSheet(null)}
                    onSuccess={() => {
                      setSheet(null)
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

            {sheet === 'appointment' && (
              <div className={styles.appointmentSetup}>
                <div className={styles.setupCard}>
                  <CalendarDays size={22} />
                  <div>
                    <strong>Calendario</strong>
                    <span>Elige dónde quieres guardar la cita.</span>
                  </div>
                </div>

                <select
                  value={selectedCalendar?.id || ''}
                  onChange={(event) => setSelectedCalendarId(event.target.value)}
                  disabled={calendars.length === 0}
                >
                  {calendars.length === 0 ? (
                    <option value="">No hay calendarios disponibles</option>
                  ) : calendars.map((calendar) => (
                    <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
                  ))}
                </select>

                <button
                  type="button"
                  className={styles.primarySheetButton}
                  onClick={() => setAppointmentOpen(true)}
                  disabled={!selectedCalendar || !activeContact}
                >
                  <CalendarDays size={18} />
                  Agendar cita
                </button>
              </div>
            )}

            {sheet === 'notifications' && (
              <div className={styles.notificationsStack}>
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
                    onChange={(event) => setChatPushEnabled(event.target.checked).catch(() => showToast('error', 'No se guardó la configuración', 'Intenta otra vez.'))}
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
                    onChange={(event) => setCalendarPushEnabled(event.target.checked).catch(() => showToast('error', 'No se guardó la configuración', 'Intenta otra vez.'))}
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
                    onChange={(event) => setPaymentPushEnabled(event.target.checked).catch(() => showToast('error', 'No se guardó la configuración', 'Intenta otra vez.'))}
                  />
                </label>
              </div>
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
        defaultScheduleMode="default"
        accessToken={accessToken || undefined}
        locationId={locationId || undefined}
        presentation="mobileSheet"
        onSave={handleCreateAppointment}
      />
    </main>
  )
}
