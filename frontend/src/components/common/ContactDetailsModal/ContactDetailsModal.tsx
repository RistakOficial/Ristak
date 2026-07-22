import { useCallback, useState, useMemo, useEffect, useRef, type ReactNode } from 'react'
import { CheckCheck, CircleAlert, Clock, Loader2, Mail, MessageCircle, Send } from 'lucide-react'
import { FaFacebookMessenger, FaInstagram, FaWhatsapp } from 'react-icons/fa'
import { Badge, type BadgeVariant } from '../Badge/Badge'
import { Button } from '../Button/Button'
import { ChatMessageSurface } from '../ChatMessageSurface/ChatMessageSurface'
import { ContactAvatar } from '../ContactAvatar/ContactAvatar'
import { ContactCustomFieldsPanel } from '../ContactCustomFieldsPanel/ContactCustomFieldsPanel'
import { ContactJourney } from '../ContactJourney/ContactJourney'
import { ContactPhoneSelector } from '../ContactPhoneSelector/ContactPhoneSelector'
import { CustomSelect } from '../CustomSelect/CustomSelect'
import {
  EmailChatMessageBubble,
  buildEmailChatMessageData,
  hasEmailChatMessageContent,
  type EmailChatMessageData
} from '../EmailChatMessageBubble/EmailChatMessageBubble'
import {
  EmailRichTextEditor,
  emailHtmlToPlainText,
  plainTextToEmailHtml,
  sanitizeEmailRichHtmlForEditor,
  type EmailRichTextVariable
} from '../EmailRichTextEditor/EmailRichTextEditor'
import { Icon } from '../Icon/Icon'
import { InlineEditableText } from '../InlineEditableText/InlineEditableText'
import { Modal } from '../Modal/Modal'
import { Switch } from '../Switch/Switch'
import { TagPicker } from '../TagPicker/TagPicker'
import { WhatsAppFormattedText } from '../WhatsAppFormattedText/WhatsAppFormattedText'
import automationsService, {
  type AutomationSummary,
  type ContactAutomationActivity,
  type ContactAutomationActivityItem
} from '@/services/automationsService'
import {
  contactsService,
  getOldestJourneyMessageCursor,
  type JourneyEvent
} from '@/services/contactsService'
import { conversationalAgentService, type ConversationalAgentCompletionEvent } from '@/services/conversationalAgentService'
import { emailService } from '@/services/emailService'
import { highLevelService, type HighLevelChatChannel } from '@/services/highLevelService'
import { getIntegrationsStatus } from '@/services/integrationsService'
import {
  whatsappApiService,
  type ScheduledChatMessage,
  type WhatsAppApiPhoneNumber,
  type WhatsAppApiStatus
} from '@/services/whatsappApiService'
import { subscribeToChatLiveEvents } from '@/services/chatLiveEventsService'
import { getContactDetailLabel, getContactDisplayName } from '@/utils/contactAvatar'
import { isChatMessageSendInFlight } from '@/utils/chatMessageDeliveryState'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import { CONTACT_STAGE_BADGE_VARIANTS, getContactStageBadge } from '@/utils/contactStageBadge'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'
import { parseSortableDateValue } from '@/utils/dateSort'
import { formatChatDaySeparatorLabel, formatChatMessageTime } from '@/utils/chatTimestamps'
import { convertUTCToLocal, formatDateOnlyFromDate, localDateTimeInputToUTCISOString, toDateTimeLocalInputValue as toZonedDateTimeLocalInputValue } from '@/utils/timezone'
import { AgentRobot } from '@/components/ai'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAuth } from '@/contexts/AuthContext'
import { hasLicenseFeature } from '@/utils/accessControl'
import type { ContactCustomField, ContactMetaAttribution, ContactPhoneNumber } from '@/types'
import styles from './ContactDetailsModal.module.css'

interface ContactPaymentDetail {
  id: string
  amount: number
  status?: string | null
  date: string
  payment_mode?: 'live' | 'test'
  paymentMode?: 'live' | 'test'
}

interface ContactAppointmentDetail {
  id: string
  title?: string | null
  status?: string | null
  start_time: string
}

interface ContactFirstSession {
  started_at?: string | null
  page_url?: string | null
  landing_page?: string | null
  referrer_url?: string | null
  utm_source?: string | null
  utm_medium?: string | null
  utm_campaign?: string | null
  utm_content?: string | null
  utm_term?: string | null
  source_platform?: string | null
  site_source_name?: string | null
  campaign_name?: string | null
  adset_name?: string | null
  ad_name?: string | null
  ad_id?: string | null
  device_type?: string | null
  browser?: string | null
  os?: string | null
  placement?: string | null
  geo_city?: string | null
  geo_region?: string | null
  geo_country?: string | null
}

interface ContactDetail {
  id: string
  name?: string | null
  email?: string | null
  phone?: string | null
  profilePhotoUrl?: string | null
  avatarUrl?: string | null
  photoUrl?: string | null
  pictureUrl?: string | null
  profile_picture_url?: string | null
  created_at: string | Date
  ltv?: number
  purchases?: number
  payments?: ContactPaymentDetail[]
  paymentsTotal?: number
  hasPaymentRecords?: boolean
  paymentsTruncated?: boolean
  paymentsNextCursor?: string | null
  appointments?: ContactAppointmentDetail[]
  appointmentsTotal?: number
  appointmentsTruncated?: boolean
  appointmentsNextCursor?: string | null
  firstAppointmentDate?: string | null
  nextAppointmentDate?: string | null
  source?: string | null
  attribution_session_source?: string | null
  whatsappAttributionPlatform?: string | null
  attribution_medium?: string | null
  ad_name?: string | null
  ad_id?: string | null
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  metaAttribution?: ContactMetaAttribution | null
  lifetimeLtv?: number
  lifetimePurchases?: number
  isCustomer?: boolean
  hasAppointments?: boolean
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
  is_sale?: boolean
  firstSession?: ContactFirstSession | null
  customFields?: ContactCustomField[]
  tags?: string[]
  phones?: ContactPhoneNumber[]
  phoneNumbers?: ContactPhoneNumber[]
  preferredWhatsAppPhoneNumberId?: string | null
  preferred_whatsapp_phone_number_id?: string | null
  lastBusinessPhone?: string | null
  lastBusinessPhoneNumberId?: string | null
  lastInboundBusinessPhone?: string | null
  lastInboundBusinessPhoneNumberId?: string | null
  firstInboundBusinessPhone?: string | null
  firstInboundBusinessPhoneNumberId?: string | null
}

interface WhatsAppPhoneOption {
  id: string
  phone_number?: string | null
  display_phone_number?: string | null
  verified_name?: string | null
  label?: string | null
  is_default_sender?: boolean
}

type ContactChatPhoneOption = WhatsAppPhoneOption | WhatsAppApiPhoneNumber
type ContactChatComposerChannel = 'whatsapp' | 'email' | 'messenger' | 'instagram' | 'none'

interface ContactChatMessage {
  id: string
  cursorDate?: string
  cursorKey?: string
  optimisticId?: string
  text: string
  subject?: string
  date: string
  direction: 'inbound' | 'outbound' | 'system'
  status?: string
  errorReason?: string
  scheduledAt?: string
  scheduledMessageId?: string
  businessPhone?: string
  businessPhoneNumberId?: string
  transport?: string
  channel?: ContactChatComposerChannel
  email?: EmailChatMessageData
}

type ContactChatTimelineItem =
  | { type: 'message'; id: string; date: string; message: ContactChatMessage }
  | { type: 'agentCompletion'; id: string; date: string; completion: ConversationalAgentCompletionEvent }

const CONTACT_FAILED_MESSAGE_STATUSES = new Set(['failed', 'error', 'undelivered', 'rejected', 'cancelled'])
const CONTACT_OPTIMISTIC_MESSAGE_ID_PREFIXES = ['contact-modal-chat-']
const CONTACT_OPTIMISTIC_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000
const CONTACT_CHAT_PAGE_LIMIT = 50

interface ContactDetailsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  data: ContactDetail[]
  loading: boolean
  type?: 'interesados' | 'sales' | 'appointments' | 'attendances' | null
  onUpdateCustomFields?: (contactId: string, customFields: ContactCustomField[]) => Promise<ContactCustomField[]>
  onUpdateContact?: (contactId: string, updates: ContactIdentityUpdate) => Promise<Partial<ContactDetail> | void>
  onUpdateTags?: (contactId: string, tagIds: string[]) => Promise<string[] | void>
  whatsappPhoneNumbers?: WhatsAppPhoneOption[]
  onUpdatePreferredWhatsAppPhoneNumber?: (contactId: string, phoneNumberId: string) => Promise<Partial<ContactDetail> | void>
  totalCount?: number
  totalCountIsCapped?: boolean
  currentPage?: number
  hasNextPage?: boolean
  hasPreviousPage?: boolean
  onPageChange?: (direction: 'next' | 'previous') => void
  onSearchChange?: (search: string) => void
  onSelectContact?: (contact: ContactDetail) => Promise<Partial<ContactDetail> | void>
  totalValue?: number | null
}

type ContactIdentityField = 'name' | 'email' | 'phone'
type ContactIdentityUpdate = Partial<Pick<ContactDetail, ContactIdentityField>>

const getContactPhoneEntries = (contact?: ContactDetail | null): ContactPhoneNumber[] => {
  const byPhone = new Map<string, ContactPhoneNumber>()
  const addPhone = (entry?: ContactPhoneNumber | null) => {
    const phone = String(entry?.phone || '').trim()
    if (!phone || byPhone.has(phone)) return
    const isPrimary = Boolean(entry?.isPrimary || entry?.is_primary || phone === String(contact?.phone || '').trim())
    const label = isPrimary
      ? 'Principal'
      : entry?.label && entry.label !== 'Principal'
        ? entry.label
        : 'Adicional'
    byPhone.set(phone, {
      ...entry,
      id: entry?.id || phone,
      phone,
      label,
      isPrimary,
      is_primary: isPrimary
    })
  }

  if (contact?.phone) {
    addPhone({
      id: `${contact.id}-primary-phone`,
      phone: contact.phone,
      label: 'Principal',
      isPrimary: true
    })
  }
  ;(contact?.phones || contact?.phoneNumbers || []).forEach(addPhone)

  return Array.from(byPhone.values()).sort((left, right) => {
    const leftPrimary = Boolean(left.isPrimary || left.is_primary)
    const rightPrimary = Boolean(right.isPrimary || right.is_primary)
    if (leftPrimary !== rightPrimary) return leftPrimary ? -1 : 1
    return String(left.createdAt || '').localeCompare(String(right.createdAt || ''))
  })
}

const getWhatsAppPhoneLabel = (phone: ContactChatPhoneOption) => {
  const number = phone.display_phone_number || phone.phone_number || phone.id
  const name = phone.label || phone.verified_name || ''
  return name && name !== number ? `${name} · ${number}` : number
}

const getPreferredWhatsAppPhoneNumberId = (contact?: ContactDetail | null) =>
  String(contact?.preferredWhatsAppPhoneNumberId || contact?.preferred_whatsapp_phone_number_id || '')

const getWhatsAppPhoneValue = (phone?: ContactChatPhoneOption | null) =>
  phone?.display_phone_number || phone?.phone_number || ''

const getContactChatPhoneLabel = (phone?: ContactChatPhoneOption | null) =>
  phone?.label || phone?.verified_name || getWhatsAppPhoneValue(phone) || 'WhatsApp'

const normalizePhoneProbe = (value?: string | null) =>
  String(value || '').replace(/\D/g, '')

const phoneValueMatches = (left?: string | null, right?: string | null) => {
  const leftDigits = normalizePhoneProbe(left)
  const rightDigits = normalizePhoneProbe(right)
  if (!leftDigits || !rightDigits) return false
  return leftDigits === rightDigits || leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits)
}

const findContactChatPhoneByRoute = (
  phones: ContactChatPhoneOption[],
  phoneNumberId?: string | null,
  businessPhone?: string | null
): ContactChatPhoneOption | null => {
  const cleanPhoneNumberId = String(phoneNumberId || '').trim()
  const cleanBusinessPhone = String(businessPhone || '').trim()
  if (cleanPhoneNumberId) {
    const byId = phones.find((phone) => phone.id === cleanPhoneNumberId)
    if (byId) return byId
  }
  if (cleanBusinessPhone) {
    const byPhone = phones.find((phone) => (
      phoneValueMatches(phone.phone_number, cleanBusinessPhone) ||
      phoneValueMatches(phone.display_phone_number, cleanBusinessPhone) ||
      phoneValueMatches((phone as WhatsAppApiPhoneNumber).qr_connected_phone, cleanBusinessPhone)
    ))
    if (byPhone) return byPhone
  }
  if (!cleanBusinessPhone && !cleanPhoneNumberId) return null
  return {
    id: cleanPhoneNumberId || cleanBusinessPhone,
    label: 'Número recibido',
    phone_number: cleanBusinessPhone || cleanPhoneNumberId,
    display_phone_number: cleanBusinessPhone || cleanPhoneNumberId
  }
}

const CONTACT_CHAT_CHANNEL_LABELS: Record<ContactChatComposerChannel, string> = {
  whatsapp: 'WhatsApp',
  email: 'Correo',
  messenger: 'Messenger',
  instagram: 'Instagram',
  none: 'Sin canal'
}

const CONTACT_EMAIL_VARIABLES: EmailRichTextVariable[] = [
  { value: 'contact.name', label: 'Nombre del contacto' },
  { value: 'contact.email', label: 'Correo del contacto' },
  { value: 'contact.phone', label: 'Telefono del contacto' },
  { value: 'business.name', label: 'Nombre del negocio' }
]

const getRecordValue = (record: Record<string, unknown>, key: string) => record[key]

const stringifyChannelProbeValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (Array.isArray(value)) return value.map(stringifyChannelProbeValue).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(stringifyChannelProbeValue).filter(Boolean).join(' ')
  }
  return String(value)
}

const buildChannelProbe = (values: unknown[]) =>
  values.map(stringifyChannelProbeValue).filter(Boolean).join(' ').toLowerCase()

const inferContactChatChannel = (value?: unknown): ContactChatComposerChannel | '' => {
  const normalized = buildChannelProbe([value])
  if (!normalized) return ''
  if (normalized.includes('instagram') || normalized.includes('ig_direct') || normalized.includes('ig_dm')) return 'instagram'
  if (normalized.includes('messenger') || normalized.includes('facebook') || normalized.includes('fb_')) return 'messenger'
  if (normalized.includes('email') || normalized.includes('mail') || normalized.includes('smtp') || normalized.includes('correo')) return 'email'
  if (normalized.includes('whatsapp') || normalized.includes('wa_') || normalized.includes('waapi') || normalized.includes('ycloud') || normalized.includes('ctwa')) return 'whatsapp'
  return ''
}

const getContactDetectedSocialChannels = (contact?: ContactDetail | null, messages: ContactChatMessage[] = []) => {
  const channels = new Set<ContactChatComposerChannel>()
  if (!contact) return channels

  const record = contact as unknown as Record<string, unknown>
  const directProbe = buildChannelProbe([
    getRecordValue(record, 'lastMessageChannel'),
    getRecordValue(record, 'lastMessageTransport'),
    getRecordValue(record, 'lastMessageProvider'),
    getRecordValue(record, 'conversationChannel'),
    getRecordValue(record, 'lastChannel'),
    getRecordValue(record, 'channel'),
    getRecordValue(record, 'source'),
    getRecordValue(record, 'attribution_session_source'),
    getRecordValue(record, 'whatsappAttributionPlatform'),
    getRecordValue(record, 'attribution_medium'),
    getRecordValue(record, 'attribution_source'),
    contact.firstSession?.utm_source,
    contact.firstSession?.source_platform,
    contact.firstSession?.placement
  ])

  const directChannel = inferContactChatChannel(directProbe)
  if (directChannel) channels.add(directChannel)

  contact.customFields?.forEach((field) => {
    const fieldChannel = inferContactChatChannel([
      field.id,
      field.key,
      field.fieldKey,
      field.label,
      field.name,
      field.value
    ])
    if (fieldChannel) channels.add(fieldChannel)
  })

  messages.forEach((message) => {
    const messageChannel = message.channel || inferContactChatChannel([
      message.transport,
      message.subject,
      message.status
    ])
    if (messageChannel) channels.add(messageChannel)
  })

  return channels
}

const getContactChatChannelFromValue = (value: string): ContactChatComposerChannel => {
  if (value.startsWith('whatsapp')) return 'whatsapp'
  if (value === 'email' || value === 'messenger' || value === 'instagram') return value
  return 'none'
}

const getHighLevelChannelForContactChat = (channel: ContactChatComposerChannel): HighLevelChatChannel => {
  if (channel === 'email') return 'email'
  if (channel === 'messenger' || channel === 'instagram') return channel
  return 'whatsapp_api'
}

const renderContactChatChannelIcon = (channel: ContactChatComposerChannel) => {
  if (channel === 'whatsapp') return <FaWhatsapp className={styles.contactChatBrandIcon} aria-hidden="true" />
  if (channel === 'messenger') return <FaFacebookMessenger className={styles.contactChatBrandIcon} aria-hidden="true" />
  if (channel === 'instagram') return <FaInstagram className={styles.contactChatBrandIcon} aria-hidden="true" />
  if (channel === 'email') return <Mail size={18} aria-hidden="true" />
  return <MessageCircle size={18} aria-hidden="true" />
}

const renderContactAvatar = (contact: ContactDetail | null | undefined, className: string) => {
  return <ContactAvatar contact={contact} className={className} />
}

const normalizeBusinessMessageDirection = (value?: unknown): ContactChatMessage['direction'] => {
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

const pickChatTimestamp = (data: Record<string, unknown>, keys: string[]) => {
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

const pickChatText = (data: Record<string, unknown>) => {
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
    if (value === null || value === undefined || typeof value === 'object') continue
    const text = String(value).trim()
    if (text) return text
  }

  return ''
}

const getChatMessageTypeLabel = (type = '', fallback = 'Mensaje') => {
  const normalized = type.toLowerCase()
  if (normalized.includes('gif')) return 'GIF'
  if (normalized.includes('image')) return 'Foto'
  if (normalized.includes('video')) return 'Video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Mensaje de voz'
  if (normalized.includes('document')) return 'Documento'
  if (normalized.includes('location')) return 'Ubicacion'
  if (normalized.includes('reaction')) return 'Reaccion'
  return fallback
}

const getJourneyChatMessage = (event: JourneyEvent, index: number): ContactChatMessage | null => {
  if (event.type === 'appointment_confirmation') {
    return {
      id: String(event.data?.id || event.data?.appointment_id || `appointment-confirmation-${index}`),
      text: 'Cita confirmada por IA.',
      date: event.date,
      direction: 'system',
      status: 'confirmed'
    }
  }

  if (event.type !== 'whatsapp_message' && event.type !== 'meta_message' && event.type !== 'email_message') return null
  const data = event.data || {}
  const messageType = String(data.message_type || data.messageType || data.type || '').trim()
  const subject = String(data.subject || '').trim()
  const text = pickChatText(data)
  const inferredChannel = inferContactChatChannel([
    data.transport,
    data.channel,
    data.provider,
    data.source,
    data.platform,
    event.type
  ]) || (event.type === 'email_message' ? 'email' : event.type === 'whatsapp_message' ? 'whatsapp' : '')
  const direction = normalizeBusinessMessageDirection(data.direction || data.message_direction || data.from_type)
  const rawEmailHtml = event.type === 'email_message'
    ? String(data.html_body || data.htmlBody || '').trim()
    : ''
  const emailBodyText = event.type === 'email_message' && !text && rawEmailHtml
    ? emailHtmlToPlainText(rawEmailHtml)
    : ''
  const effectiveText = text || emailBodyText
  const status = String(data.status || data.message_status || '').trim()
  const errorReason = String(data.error_message || data.errorMessage || data.error_reason || data.errorReason || '').trim()
  const transport = String(data.transport || data.channel || data.provider || inferredChannel || '').trim()
  const email = event.type === 'email_message'
    ? buildEmailChatMessageData(data, {
        bodyText: effectiveText,
        direction,
        status,
        errorReason,
        transport
      })
    : undefined
  if (!effectiveText && !messageType && !subject && !hasEmailChatMessageContent(email)) return null

  return {
    id: String(
      data.whatsapp_api_message_id ||
      data.whatsapp_message_id ||
      data.meta_social_message_id ||
      data.meta_message_id ||
      data.email_message_id ||
      data.smtp_message_id ||
      data.message_id ||
      data.messageId ||
      data.attribution_record_id ||
      data.id ||
      `${event.type}-${event.date}-${index}`
    ),
    cursorDate: event.cursorDate || event.date,
    cursorKey: event.cursorKey,
    text: effectiveText || getChatMessageTypeLabel(messageType),
    subject,
    date: pickChatTimestamp(data, ['date', 'timestamp', 'created_at', 'createdAt', 'message_timestamp', 'messageTimestamp']) || event.date,
    direction,
    status,
    errorReason,
    businessPhone: String(data.business_phone || data.businessPhone || data.from_phone || data.fromPhone || data.to_phone || data.toPhone || '').trim(),
    businessPhoneNumberId: String(data.business_phone_number_id || data.businessPhoneNumberId || data.phone_number_id || data.phoneNumberId || '').trim(),
    transport,
    channel: inferredChannel || undefined,
    email
  }
}

const getScheduledChatBubble = (message: ScheduledChatMessage): ContactChatMessage | null => {
  if (!message?.id) return null
  const text = message.text || (message.messageType === 'template' ? `Plantilla: ${message.templateName || message.templateId || 'WhatsApp'}` : '')
  if (!text) return null
  return {
    id: `scheduled-${message.id}`,
    text,
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

const getChatDayKey = (date: string, timeZone: string) => {
  const value = convertUTCToLocal(date, timeZone)
  if (Number.isNaN(value.getTime())) return 'unknown'
  return formatDateOnlyFromDate(value)
}

const getChatDayLabel = (date: string, timeZone: string) => {
  return formatChatDaySeparatorLabel(date, timeZone)
}

const getChatTimeLabel = (date: string, timeZone: string) => {
  return formatChatMessageTime(date, timeZone)
}

const isScheduledContactChatMessage = (message: ContactChatMessage) =>
  String(message.status || '').trim().toLowerCase() === 'scheduled' || Boolean(message.scheduledAt && message.scheduledMessageId)

const normalizeContactChatMatchText = (value?: string) =>
  String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()

const getContactChatTimeValue = (value?: string) => {
  return parseSortableDateValue(value)
}

const isOptimisticContactChatMessage = (message: ContactChatMessage) => {
  if (message.optimisticId) return true
  return CONTACT_OPTIMISTIC_MESSAGE_ID_PREFIXES.some((prefix) => message.id.startsWith(prefix))
}

const isRecentOptimisticContactChatMessage = (message: ContactChatMessage) => {
  if (!isOptimisticContactChatMessage(message)) return false
  const timestamp = getContactChatTimeValue(message.date)
  if (!timestamp) return true
  return Date.now() - timestamp < CONTACT_OPTIMISTIC_MESSAGE_MAX_AGE_MS
}

const getOptimisticContactChatMessageKey = (message: ContactChatMessage) =>
  message.optimisticId || message.id

const contactChatMessagesLookLikeSameSend = (loaded: ContactChatMessage, optimistic: ContactChatMessage) => {
  const optimisticKey = getOptimisticContactChatMessageKey(optimistic)
  if (loaded.id === optimistic.id || loaded.id === optimisticKey || loaded.optimisticId === optimisticKey) return true
  if (loaded.direction !== optimistic.direction || optimistic.direction !== 'outbound') return false

  const loadedTime = getContactChatTimeValue(loaded.date)
  const optimisticTime = getContactChatTimeValue(optimistic.date)
  if (loadedTime && optimisticTime && Math.abs(loadedTime - optimisticTime) > CONTACT_OPTIMISTIC_MESSAGE_MAX_AGE_MS) return false

  const loadedText = normalizeContactChatMatchText(loaded.text)
  const optimisticText = normalizeContactChatMatchText(optimistic.text)
  const sameSubject = normalizeContactChatMatchText(loaded.subject) === normalizeContactChatMatchText(optimistic.subject)
  return Boolean(loadedText && optimisticText && loadedText === optimisticText && sameSubject) &&
    (!loadedTime || !optimisticTime || loadedTime >= optimisticTime - 5000)
}

const mergeContactChatMessagesWithOptimistic = (loadedMessages: ContactChatMessage[], currentMessages: ContactChatMessage[]) => {
  const merged = [...loadedMessages]
  const matchedLoadedIndexes = new Set<number>()

  currentMessages.forEach((message) => {
    if (!isRecentOptimisticContactChatMessage(message)) return
    const matchIndex = loadedMessages.findIndex((loaded, index) => (
      !matchedLoadedIndexes.has(index) && contactChatMessagesLookLikeSameSend(loaded, message)
    ))
    if (matchIndex >= 0) {
      matchedLoadedIndexes.add(matchIndex)
      return
    }
    if (!merged.some((loaded) => loaded.id === message.id || loaded.id === getOptimisticContactChatMessageKey(message))) {
      merged.push(message)
    }
  })

  return merged.sort((left, right) => getContactChatTimeValue(left.date) - getContactChatTimeValue(right.date))
}

const toDateTimeLocalInputValue = (date: Date) => {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const defaultAutomationScheduleValue = (timezone?: string) => {
  const date = timezone
    ? new Date(toZonedDateTimeLocalInputValue(new Date(Date.now() + 60 * 60 * 1000), timezone))
    : new Date(Date.now() + 60 * 60 * 1000)
  date.setSeconds(0, 0)
  return toDateTimeLocalInputValue(date)
}

const formatStatusText = (value: string) =>
  value
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

const automationStatusLabels: Record<string, string> = {
  active: 'Activa',
  waiting: 'En espera',
  scheduled: 'Programada',
  processing: 'Procesando',
  completed: 'Completada',
  exited: 'Terminada',
  goal_met: 'Objetivo cumplido',
  error: 'Error',
  cancelled: 'Cancelada'
}

const getAutomationStatusLabel = (status?: string | null) =>
  automationStatusLabels[String(status || '').toLowerCase()] || formatStatusText(String(status || 'Activa'))

const getAutomationStatusVariant = (status?: string | null): BadgeVariant => {
  const normalized = String(status || '').toLowerCase()
  if (['active', 'processing'].includes(normalized)) return 'info'
  if (normalized === 'waiting' || normalized === 'scheduled') return 'warning'
  if (normalized === 'completed' || normalized === 'goal_met') return 'success'
  if (normalized === 'error' || normalized === 'cancelled') return 'error'
  return 'neutral'
}

const getResolvedAttributionDisplay = (contact?: ContactDetail | null) => ({
  campaignName: contact?.metaAttribution?.campaignName || contact?.campaign_name || null,
  adsetName: contact?.metaAttribution?.adsetName || contact?.adset_name || null,
  adName: contact?.metaAttribution?.adName || contact?.ad_name || null,
  adId: contact?.metaAttribution?.adId || contact?.ad_id || null
})

export function ContactDetailsModal({
  isOpen,
  onClose,
  title,
  subtitle,
  data,
  loading,
  type,
  onUpdateCustomFields,
  onUpdateContact,
  onUpdateTags,
  whatsappPhoneNumbers = [],
  onUpdatePreferredWhatsAppPhoneNumber,
  totalCount,
  totalCountIsCapped = false,
  currentPage = 1,
  hasNextPage = false,
  hasPreviousPage = false,
  onPageChange,
  onSearchChange,
  onSelectContact,
  totalValue
}: ContactDetailsModalProps) {
  const { user } = useAuth()
  const hasEmailAccess = hasLicenseFeature(user, ['email'])
  const hasAutomationsAccess = hasLicenseFeature(user, ['automations'])
  const [selectedContact, setSelectedContact] = useState<ContactDetail | null>(null)
  const selectedContactLoadRevisionRef = useRef(0)
  const chatMessagesRef = useRef<HTMLDivElement | null>(null)
  const preserveChatScrollRef = useRef(false)
  const chatAbortRef = useRef<AbortController | null>(null)
  const paymentsAbortRef = useRef<AbortController | null>(null)
  const appointmentsAbortRef = useRef<AbortController | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [chatMessages, setChatMessages] = useState<ContactChatMessage[]>([])
  const [agentCompletionEvents, setAgentCompletionEvents] = useState<ConversationalAgentCompletionEvent[]>([])
  const [chatLoading, setChatLoading] = useState(false)
  const [chatOlderLoading, setChatOlderLoading] = useState(false)
  const [chatHasOlder, setChatHasOlder] = useState(false)
  const [chatError, setChatError] = useState('')
  const [chatDraft, setChatDraft] = useState('')
  const [chatSubject, setChatSubject] = useState('')
  const [chatEmailHtml, setChatEmailHtml] = useState('')
  const [chatEmailIncludeSignature, setChatEmailIncludeSignature] = useState(true)
  const [chatChannelValue, setChatChannelValue] = useState('whatsapp')
  const [chatSending, setChatSending] = useState(false)
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [whatsappStatusLoading, setWhatsappStatusLoading] = useState(false)
  const [emailConnected, setEmailConnected] = useState(false)
  const [emailStatusLoading, setEmailStatusLoading] = useState(false)
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [metaMessengerConnected, setMetaMessengerConnected] = useState(false)
  const [metaInstagramConnected, setMetaInstagramConnected] = useState(false)
  const [highLevelStatusLoading, setHighLevelStatusLoading] = useState(false)
  const [paymentsExpanded, setPaymentsExpanded] = useState(false)
  const [paymentsLoading, setPaymentsLoading] = useState(false)
  const [paymentsHydrated, setPaymentsHydrated] = useState(false)
  const [paymentsHasMore, setPaymentsHasMore] = useState(false)
  const [paymentsCursor, setPaymentsCursor] = useState<string | null>(null)
  const [paymentsError, setPaymentsError] = useState('')
  const [refundsExpanded, setRefundsExpanded] = useState(false)
  const [appointmentsExpanded, setAppointmentsExpanded] = useState(false)
  const [appointmentsLoading, setAppointmentsLoading] = useState(false)
  const [appointmentsHydrated, setAppointmentsHydrated] = useState(false)
  const [appointmentsHasMore, setAppointmentsHasMore] = useState(false)
  const [appointmentsCursor, setAppointmentsCursor] = useState<string | null>(null)
  const [appointmentsError, setAppointmentsError] = useState('')
  const [agentHistoryExpanded, setAgentHistoryExpanded] = useState(false)
  const [automationsExpanded, setAutomationsExpanded] = useState(false)
  const [automationActivity, setAutomationActivity] = useState<ContactAutomationActivity | null>(null)
  const [automationActivityLoading, setAutomationActivityLoading] = useState(false)
  const [automationCatalogLoading, setAutomationCatalogLoading] = useState(false)
  const [automationError, setAutomationError] = useState<string | null>(null)
  const [automationNotice, setAutomationNotice] = useState<string | null>(null)
  const [automationQuery, setAutomationQuery] = useState('')
  const [automationCatalog, setAutomationCatalog] = useState<AutomationSummary[]>([])
  const [enrollModalOpen, setEnrollModalOpen] = useState(false)
  const [enrollMode, setEnrollMode] = useState<'now' | 'scheduled'>('now')
  const [enrollScheduledAt, setEnrollScheduledAt] = useState(defaultAutomationScheduleValue)
  const [enrollSubmitting, setEnrollSubmitting] = useState(false)
  const [enrollError, setEnrollError] = useState<string | null>(null)
  const [selectedAutomationForEnrollment, setSelectedAutomationForEnrollment] = useState<AutomationSummary | null>(null)
  const [savingWhatsAppPreference, setSavingWhatsAppPreference] = useState(false)
  const [whatsappPreferenceError, setWhatsappPreferenceError] = useState<string | null>(null)
  const [savingTags, setSavingTags] = useState(false)
  const [tagsError, setTagsError] = useState<string | null>(null)
  const [savingPrimaryPhone, setSavingPrimaryPhone] = useState<string | null>(null)
  const { labels } = useLabels()
  const { formatLocalDateShort, formatLocalDateTime, timezone } = useTimezone()

  // Seleccionar automáticamente el primer contacto cuando se abre el modal
  useEffect(() => {
    if (isOpen && data.length > 0) {
      setSelectedContact(data[0])
    } else if (!isOpen) {
      setSelectedContact(null)
      setSearchQuery('')
      setChatMessages([])
      setAgentCompletionEvents([])
      setChatLoading(false)
      setChatOlderLoading(false)
      setChatHasOlder(false)
      setChatError('')
      setChatDraft('')
      setChatSubject('')
      setChatEmailHtml('')
      setChatEmailIncludeSignature(true)
      setChatChannelValue('whatsapp')
      setChatSending(false)
      setWhatsappStatus(null)
      setWhatsappStatusLoading(false)
      setEmailConnected(false)
      setEmailStatusLoading(false)
      setHighLevelConnected(false)
      setMetaMessengerConnected(false)
      setMetaInstagramConnected(false)
      setHighLevelStatusLoading(false)
      setPaymentsExpanded(false)
      setPaymentsLoading(false)
      setPaymentsHydrated(false)
      setPaymentsHasMore(false)
      setPaymentsCursor(null)
      setPaymentsError('')
      setRefundsExpanded(false)
      setAppointmentsExpanded(false)
      setAppointmentsLoading(false)
      setAppointmentsHydrated(false)
      setAppointmentsHasMore(false)
      setAppointmentsCursor(null)
      setAppointmentsError('')
      setAgentHistoryExpanded(false)
      setAutomationsExpanded(false)
      setAutomationActivity(null)
      setAutomationActivityLoading(false)
      setAutomationCatalogLoading(false)
      setAutomationError(null)
      setAutomationNotice(null)
      setAutomationQuery('')
      setEnrollModalOpen(false)
      setEnrollMode('now')
      setEnrollScheduledAt(defaultAutomationScheduleValue(timezone))
      setEnrollSubmitting(false)
      setEnrollError(null)
      setSelectedAutomationForEnrollment(null)
      setSavingWhatsAppPreference(false)
      setWhatsappPreferenceError(null)
      setSavingTags(false)
      setTagsError(null)
      setSavingPrimaryPhone(null)
    }
  }, [isOpen, data, timezone])

  useEffect(() => {
    if (!isOpen || !onSearchChange) return
    const timer = window.setTimeout(() => onSearchChange(searchQuery.trim()), 300)
    return () => window.clearTimeout(timer)
  }, [isOpen, onSearchChange, searchQuery])

  useEffect(() => {
    if (!isOpen || !selectedContact || !onSelectContact) return
    const revision = selectedContactLoadRevisionRef.current + 1
    selectedContactLoadRevisionRef.current = revision
    const contactId = selectedContact.id

    void onSelectContact(selectedContact)
      .then((detail) => {
        if (!detail || selectedContactLoadRevisionRef.current !== revision) return
        setSelectedContact((current) => {
          if (current?.id !== contactId) return current
          const hydrated = { ...current, ...detail }
          // Los endpoints ligeros mandan cinco citas + metadata. Si la
          // hidratacion entrega la coleccion completa, esa metadata anterior ya
          // no aplica y no debe afirmar que diez filas siguen siendo solo cinco.
          if (Array.isArray(detail.appointments) && detail.appointmentsTotal === undefined) {
            hydrated.appointmentsTotal = detail.appointments.length
            hydrated.appointmentsTruncated = false
          }
          return hydrated
        })
      })
      .catch(() => {
        // El DTO ligero sigue siendo utilizable aunque el detalle falle.
      })

    return () => {
      if (selectedContactLoadRevisionRef.current === revision) {
        selectedContactLoadRevisionRef.current += 1
      }
    }
  }, [isOpen, onSelectContact, selectedContact?.id])

  useEffect(() => {
    chatAbortRef.current?.abort()
    paymentsAbortRef.current?.abort()
    appointmentsAbortRef.current?.abort()
    setPaymentsExpanded(false)
    setPaymentsLoading(false)
    setPaymentsHydrated(false)
    setPaymentsHasMore(false)
    setPaymentsCursor(null)
    setPaymentsError('')
    setRefundsExpanded(false)
    setAppointmentsExpanded(false)
    setAppointmentsLoading(false)
    setAppointmentsHydrated(false)
    setAppointmentsHasMore(false)
    setAppointmentsCursor(null)
    setAppointmentsError('')
    setAgentHistoryExpanded(false)
    setAutomationsExpanded(false)
    setChatMessages([])
    setAgentCompletionEvents([])
    setChatLoading(false)
    setChatOlderLoading(false)
    setChatHasOlder(false)
    setChatError('')
    setChatDraft('')
    setChatSubject('')
    setChatEmailHtml('')
    setChatEmailIncludeSignature(true)
    setChatChannelValue('whatsapp')
    setChatSending(false)
    setAutomationActivity(null)
    setAutomationActivityLoading(false)
    setAutomationCatalogLoading(false)
    setAutomationError(null)
    setAutomationNotice(null)
    setAutomationQuery('')
    setEnrollModalOpen(false)
    setEnrollMode('now')
    setEnrollScheduledAt(defaultAutomationScheduleValue(timezone))
    setEnrollSubmitting(false)
    setEnrollError(null)
    setSelectedAutomationForEnrollment(null)
    setSavingWhatsAppPreference(false)
    setWhatsappPreferenceError(null)
    setSavingTags(false)
    setTagsError(null)
    setSavingPrimaryPhone(null)
  }, [selectedContact?.id])

  const loadContactPayments = useCallback(async (contactId: string, append = false) => {
    if (!contactId || paymentsLoading) return
    paymentsAbortRef.current?.abort()
    const controller = new AbortController()
    paymentsAbortRef.current = controller
    setPaymentsLoading(true)
    setPaymentsError('')
    try {
      const page = await contactsService.getContactPaymentsPage(contactId, {
        cursor: append ? paymentsCursor : null,
        limit: 20,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      setSelectedContact(current => {
        if (current?.id !== contactId) return current
        const existing = append && Array.isArray(current.payments) ? current.payments : []
        const byId = new Map(existing.map(payment => [payment.id, payment]))
        page.payments.forEach(payment => byId.set(payment.id, payment))
        return {
          ...current,
          payments: [...byId.values()],
          paymentsTruncated: page.pagination.hasNext,
          paymentsNextCursor: page.pagination.nextCursor
        }
      })
      setPaymentsHydrated(true)
      setPaymentsHasMore(page.pagination.hasNext)
      setPaymentsCursor(page.pagination.nextCursor)
    } catch (error) {
      if (!controller.signal.aborted) setPaymentsError(error instanceof Error ? error.message : 'No se pudieron cargar los pagos.')
    } finally {
      if (!controller.signal.aborted) setPaymentsLoading(false)
      if (paymentsAbortRef.current === controller) paymentsAbortRef.current = null
    }
  }, [paymentsCursor, paymentsLoading])

  const loadContactAppointments = useCallback(async (contactId: string, append = false) => {
    if (!contactId || appointmentsLoading) return
    appointmentsAbortRef.current?.abort()
    const controller = new AbortController()
    appointmentsAbortRef.current = controller
    setAppointmentsLoading(true)
    setAppointmentsError('')
    try {
      const page = await contactsService.getContactAppointmentsPage(contactId, {
        cursor: append ? appointmentsCursor : null,
        limit: 20,
        signal: controller.signal
      })
      if (controller.signal.aborted) return
      setSelectedContact(current => {
        if (current?.id !== contactId) return current
        const existing = append && Array.isArray(current.appointments) ? current.appointments : []
        const byId = new Map(existing.map(appointment => [appointment.id, appointment]))
        page.appointments.forEach(appointment => byId.set(appointment.id, appointment))
        return {
          ...current,
          appointments: [...byId.values()],
          appointmentsTruncated: page.pagination.hasNext,
          appointmentsNextCursor: page.pagination.nextCursor
        }
      })
      setAppointmentsHydrated(true)
      setAppointmentsHasMore(page.pagination.hasNext)
      setAppointmentsCursor(page.pagination.nextCursor)
    } catch (error) {
      if (!controller.signal.aborted) setAppointmentsError(error instanceof Error ? error.message : 'No se pudieron cargar las citas.')
    } finally {
      if (!controller.signal.aborted) setAppointmentsLoading(false)
      if (appointmentsAbortRef.current === controller) appointmentsAbortRef.current = null
    }
  }, [appointmentsCursor, appointmentsLoading])

  useEffect(() => {
    const contactId = selectedContact?.id
    if (!isOpen || !contactId || !paymentsExpanded || paymentsHydrated) return
    void loadContactPayments(contactId)
  }, [isOpen, loadContactPayments, paymentsExpanded, paymentsHydrated, selectedContact?.id])

  useEffect(() => {
    const contactId = selectedContact?.id
    if (!isOpen || !contactId || !appointmentsExpanded || appointmentsHydrated) return
    void loadContactAppointments(contactId)
  }, [appointmentsExpanded, appointmentsHydrated, isOpen, loadContactAppointments, selectedContact?.id])

  const loadContactChat = useCallback(async (contactId: string, options: { silent?: boolean } = {}) => {
    if (!contactId) return
    chatAbortRef.current?.abort()
    const controller = new AbortController()
    chatAbortRef.current = controller
    const silent = options.silent === true
    if (!silent) setChatLoading(true)
    setChatError('')

    try {
      const [journey, scheduledMessages, agentCompletions] = await Promise.all([
        contactsService.getContactConversation(contactId, {
          messageLimit: CONTACT_CHAT_PAGE_LIMIT,
          signal: controller.signal,
          throwOnError: true
        }),
        whatsappApiService.getScheduledMessages(contactId).catch(() => [] as ScheduledChatMessage[]),
        conversationalAgentService.listCompletionEvents({ contactId, limit: 20 }).catch(() => [])
      ])
      const journeyMessages = journey
        .map(getJourneyChatMessage)
        .filter((message): message is ContactChatMessage => Boolean(message))
      const scheduledBubbles = scheduledMessages
        .map(getScheduledChatBubble)
        .filter((message): message is ContactChatMessage => Boolean(message))

      const loadedMessages = [...journeyMessages, ...scheduledBubbles]
        .sort((left, right) => parseSortableDateValue(left.date) - parseSortableDateValue(right.date))
      if (controller.signal.aborted) return
      setChatHasOlder(journeyMessages.length >= CONTACT_CHAT_PAGE_LIMIT)
      setAgentCompletionEvents(agentCompletions)
      setChatMessages((current) => mergeContactChatMessagesWithOptimistic(loadedMessages, current))
    } catch {
      if (!silent && !controller.signal.aborted) {
        setChatMessages([])
        setAgentCompletionEvents([])
        setChatError('No se pudo cargar la conversacion.')
      }
    } finally {
      if (!silent && !controller.signal.aborted) setChatLoading(false)
      if (chatAbortRef.current === controller) chatAbortRef.current = null
    }
  }, [])

  const loadOlderContactChat = useCallback(async () => {
    const contactId = selectedContact?.id
    if (!contactId || chatOlderLoading || !chatHasOlder) return
    const oldestCursor = getOldestJourneyMessageCursor(chatMessages.map(message => ({
      type: 'whatsapp_message' as const,
      date: message.date,
      cursorDate: message.cursorDate,
      cursorKey: message.cursorKey,
      data: {}
    })))
    if (!oldestCursor) {
      setChatHasOlder(false)
      return
    }

    const pane = chatMessagesRef.current
    const previousHeight = pane?.scrollHeight || 0
    const previousTop = pane?.scrollTop || 0
    const controller = new AbortController()
    chatAbortRef.current?.abort()
    chatAbortRef.current = controller
    setChatOlderLoading(true)
    try {
      const journey = await contactsService.getContactConversation(contactId, {
        messageLimit: CONTACT_CHAT_PAGE_LIMIT,
        beforeMessageDate: oldestCursor.beforeMessageDate,
        beforeMessageCursor: oldestCursor.beforeMessageCursor,
        signal: controller.signal,
        throwOnError: true
      })
      if (controller.signal.aborted) return
      const olderMessages = journey.map(getJourneyChatMessage).filter((message): message is ContactChatMessage => Boolean(message))
      setChatHasOlder(olderMessages.length >= CONTACT_CHAT_PAGE_LIMIT)
      preserveChatScrollRef.current = true
      setChatMessages(current => mergeContactChatMessagesWithOptimistic(olderMessages, current))
      window.requestAnimationFrame(() => {
        const currentPane = chatMessagesRef.current
        if (currentPane && previousHeight > 0) {
          currentPane.scrollTop = previousTop + currentPane.scrollHeight - previousHeight
        }
        preserveChatScrollRef.current = false
      })
    } catch {
      if (!controller.signal.aborted) setChatError('No se pudieron cargar mensajes anteriores.')
    } finally {
      if (!controller.signal.aborted) setChatOlderLoading(false)
      if (chatAbortRef.current === controller) chatAbortRef.current = null
    }
  }, [chatHasOlder, chatMessages, chatOlderLoading, selectedContact?.id])

  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    setWhatsappStatusLoading(true)
    setEmailStatusLoading(true)
    setHighLevelStatusLoading(true)

    Promise.all([
      whatsappApiService.getStatus().catch(() => null),
      emailService.getStatus().catch(() => null),
      getIntegrationsStatus().catch(() => null)
    ])
      .then(([status, emailStatus, integrationsStatus]) => {
        if (cancelled) return
        setWhatsappStatus(status)
        setEmailConnected(Boolean(emailStatus?.connected))
        setHighLevelConnected(Boolean(integrationsStatus?.highlevel?.connected))
        setMetaMessengerConnected(Boolean(integrationsStatus?.meta?.connected && integrationsStatus?.meta?.pageId))
        setMetaInstagramConnected(Boolean(integrationsStatus?.meta?.connected && integrationsStatus?.meta?.instagramAccountId))
      })
      .finally(() => {
        if (cancelled) return
        setWhatsappStatusLoading(false)
        setEmailStatusLoading(false)
        setHighLevelStatusLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [isOpen])

  useEffect(() => {
    const contactId = selectedContact?.id
    if (!isOpen || !contactId) {
      setChatMessages([])
      setAgentCompletionEvents([])
      return
    }

    void loadContactChat(contactId)
  }, [isOpen, loadContactChat, selectedContact?.id])

  useEffect(() => {
    const contactId = selectedContact?.id
    if (!isOpen || !contactId) return

    return subscribeToChatLiveEvents({
      onMessage: (event) => {
        if (!event?.contactId || event.contactId === contactId) {
          void loadContactChat(contactId, { silent: true })
        }
      },
      onDataChanged: (event) => {
        if (!event?.contactId || event.contactId === contactId) {
          void loadContactChat(contactId, { silent: true })
        }
      }
    })
  }, [isOpen, loadContactChat, selectedContact?.id])

  useEffect(() => {
    const messagesSurface = chatMessagesRef.current
    if (!messagesSurface || preserveChatScrollRef.current) return

    messagesSurface.scrollTop = messagesSurface.scrollHeight
  }, [agentCompletionEvents, chatLoading, chatMessages])

  const preparedContactSearch = useMemo(() => prepareSearchQuery(searchQuery), [searchQuery])
  const contactSearchIndexes = useMemo(() => {
    return data.map(contact => buildSearchIndex([contact.name, contact.email, contact.phone, contact.id]))
  }, [data, timezone])

  // Filtrar contactos según búsqueda
  const filteredData = useMemo(() => {
    if (onSearchChange) return data
    if (!preparedContactSearch.normalized) return data

    return data.filter((contact, index) =>
      searchIndexIncludes(
        contactSearchIndexes[index] ?? buildSearchIndex([contact.name, contact.email, contact.phone, contact.id]),
        preparedContactSearch
      )
    )
  }, [contactSearchIndexes, data, onSearchChange, preparedContactSearch])

  const loadAutomationData = useCallback(async (options: { silent?: boolean } = {}) => {
    const contactId = selectedContact?.id
    if (!contactId || !hasAutomationsAccess) return
    if (!options.silent) {
      setAutomationActivityLoading(true)
      setAutomationCatalogLoading(true)
    }
    setAutomationError(null)
    try {
      const [activity, overview] = await Promise.all([
        automationsService.getContactActivity(contactId),
        automationsService.getOverview({ status: 'published', limit: 100 })
      ])
      setAutomationActivity(activity)
      setAutomationCatalog(overview.automations)
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : 'No se pudieron cargar las automatizaciones.')
    } finally {
      setAutomationActivityLoading(false)
      setAutomationCatalogLoading(false)
    }
  }, [hasAutomationsAccess, selectedContact?.id])

  useEffect(() => {
    if (!hasAutomationsAccess) {
      setAutomationsExpanded(false)
      setAutomationActivity(null)
      setAutomationCatalog([])
      return
    }
    if (!isOpen || !selectedContact) return
    void loadAutomationData({ silent: true })
  }, [hasAutomationsAccess, isOpen, loadAutomationData, selectedContact?.id])

  useEffect(() => {
    if (!hasAutomationsAccess || !isOpen || !selectedContact || !automationsExpanded) return
    void loadAutomationData()
  }, [automationsExpanded, hasAutomationsAccess, isOpen, loadAutomationData, selectedContact?.id])

  const publishedAutomations = useMemo(
    () => automationCatalog.filter(automation => automation.status === 'published'),
    [automationCatalog]
  )
  const preparedAutomationSearch = useMemo(() => prepareSearchQuery(automationQuery), [automationQuery])
  const automationSearchResults = useMemo(() => {
    if (!preparedAutomationSearch.normalized) return publishedAutomations.slice(0, 6)
    return publishedAutomations
      .filter(automation =>
        searchIndexIncludes(
          buildSearchIndex([automation.name, automation.description, automation.id]),
          preparedAutomationSearch
        )
      )
      .slice(0, 8)
  }, [preparedAutomationSearch, publishedAutomations])

  const openEnrollmentModal = (automation: AutomationSummary) => {
    if (!hasAutomationsAccess) return
    setSelectedAutomationForEnrollment(automation)
    setEnrollMode('now')
    setEnrollScheduledAt(defaultAutomationScheduleValue(timezone))
    setEnrollError(null)
    setEnrollModalOpen(true)
  }

  const closeEnrollmentModal = () => {
    if (enrollSubmitting) return
    setEnrollModalOpen(false)
    setEnrollError(null)
    setSelectedAutomationForEnrollment(null)
  }

  const submitAutomationEnrollment = async () => {
    if (!hasAutomationsAccess || !selectedContact || !selectedAutomationForEnrollment) return
    let scheduledAt: string | undefined
    if (enrollMode === 'scheduled') {
      const scheduledIso = localDateTimeInputToUTCISOString(enrollScheduledAt, timezone)
      const scheduledDate = scheduledIso ? new Date(scheduledIso) : new Date(NaN)
      if (!enrollScheduledAt || Number.isNaN(scheduledDate.getTime())) {
        setEnrollError('Elige una fecha y hora válidas.')
        return
      }
      if (scheduledDate.getTime() < Date.now() - 60_000) {
        setEnrollError('Elige una fecha futura.')
        return
      }
      scheduledAt = scheduledDate.toISOString()
    }

    setEnrollSubmitting(true)
    setEnrollError(null)
    try {
      await automationsService.enrollContact(selectedAutomationForEnrollment.id, {
        contactId: selectedContact.id,
        mode: enrollMode,
        scheduledAt
      })
      setAutomationNotice(enrollMode === 'scheduled'
        ? 'Contacto programado para entrar a la automatización.'
        : 'Contacto agregado a la automatización.')
      setAutomationQuery('')
      setEnrollModalOpen(false)
      setSelectedAutomationForEnrollment(null)
      await loadAutomationData({ silent: true })
    } catch (error) {
      setEnrollError(error instanceof Error ? error.message : 'No se pudo agregar el contacto.')
    } finally {
      setEnrollSubmitting(false)
    }
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(value)
  }

  const getStatusLabel = (status?: string | null): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: '', variant: 'neutral' }
    const statusLower = status.toLowerCase()

    if (['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'].includes(statusLower)) {
      return { text: 'Pagado', variant: 'success' }
    }
    if (['refunded', 'refund'].includes(statusLower)) {
      return { text: 'Reembolsado', variant: 'error' }
    }
    if (['pending', 'processing'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }
    if (['failed', 'canceled', 'cancelled'].includes(statusLower)) {
      return { text: 'Fallido', variant: 'error' }
    }
    if (['booked', 'confirmed', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  const getAppointmentStatusLabel = (status?: string | null): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: 'Reservado', variant: 'warning' }
    const statusLower = status.toLowerCase()

    if (['confirmed', 'booked', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }
    if (['completed', 'showed', 'attended'].includes(statusLower)) {
      return { text: 'Asistió', variant: CONTACT_STAGE_BADGE_VARIANTS.attended }
    }
    if (['cancelled', 'canceled', 'no_show', 'noshow'].includes(statusLower)) {
      return { text: 'Cancelado', variant: 'error' }
    }
    if (['pending', 'unconfirmed'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  const resolveContactBadge = (contact?: ContactDetail | null) =>
    getContactStageBadge(contact, labels)

  const saveContactIdentityField = async (field: ContactIdentityField, value: string) => {
    if (!selectedContact || !onUpdateContact) return

    const contactId = selectedContact.id
    const previousValue = selectedContact[field] || ''
    const patch = { [field]: value } as ContactIdentityUpdate

    setSelectedContact(prev => prev?.id === contactId ? { ...prev, ...patch } : prev)

    try {
      const updatedContact = await onUpdateContact(contactId, patch)
      setSelectedContact(prev => prev?.id === contactId
        ? { ...prev, ...patch, ...(updatedContact || {}) }
        : prev
      )
    } catch (error) {
      setSelectedContact(prev => prev?.id === contactId ? { ...prev, [field]: previousValue } : prev)
      throw error
    }
  }

  const makeContactPhonePrimary = async (phone: string) => {
    if (!selectedContact || !onUpdateContact) return

    const nextPhone = String(phone || '').trim()
    if (!nextPhone || nextPhone === String(selectedContact.phone || '').trim()) return

    setSavingPrimaryPhone(nextPhone)
    try {
      await saveContactIdentityField('phone', nextPhone)
    } finally {
      setSavingPrimaryPhone(null)
    }
  }

  const updateContactTags = async (tagIds: string[]) => {
    if (!selectedContact || !onUpdateTags) return
    const previous = selectedContact.tags || []
    // Optimista: el chip aparece/desaparece al instante
    setSelectedContact(prev => prev?.id === selectedContact.id ? { ...prev, tags: tagIds } : prev)
    setSavingTags(true)
    setTagsError(null)
    try {
      const saved = await onUpdateTags(selectedContact.id, tagIds)
      if (Array.isArray(saved)) {
        setSelectedContact(prev => prev?.id === selectedContact.id ? { ...prev, tags: saved } : prev)
      }
    } catch (error) {
      setSelectedContact(prev => prev?.id === selectedContact.id ? { ...prev, tags: previous } : prev)
      setTagsError(error instanceof Error ? error.message : 'No se pudieron guardar las etiquetas.')
    } finally {
      setSavingTags(false)
    }
  }

  const updatePreferredWhatsAppPhoneNumber = async (phoneNumberId: string) => {
    if (!selectedContact || !onUpdatePreferredWhatsAppPhoneNumber) return

    setSavingWhatsAppPreference(true)
    setWhatsappPreferenceError(null)

    try {
      const updatedContact = await onUpdatePreferredWhatsAppPhoneNumber(selectedContact.id, phoneNumberId)
      setSelectedContact(prev => prev?.id === selectedContact.id
        ? {
            ...prev,
            ...(updatedContact || {}),
            preferredWhatsAppPhoneNumberId: phoneNumberId,
            preferred_whatsapp_phone_number_id: phoneNumberId
          }
        : prev
      )
    } catch (error) {
      setWhatsappPreferenceError(error instanceof Error ? error.message : 'No se pudo guardar el número para responder.')
    } finally {
      setSavingWhatsAppPreference(false)
    }
  }

  // Separar pagos exitosos de reembolsos/cancelados
  // CRÍTICO: Solo pagos con status exitoso, NO incluir refunded/cancelled
  const validPaymentStatuses = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success']
  const isTestPayment = (payment: ContactPaymentDetail) => (
    payment.paymentMode === 'test' || payment.payment_mode === 'test'
  )
  const payments = useMemo(() => {
    return selectedContact?.payments?.filter(p =>
      p.amount > 0 && !isTestPayment(p) && validPaymentStatuses.includes(p.status?.toLowerCase() || '')
    ) || []
  }, [selectedContact])

  const refunds = useMemo(() => {
    return selectedContact?.payments?.filter(p =>
      !isTestPayment(p) && (p.amount < 0 || p.status?.toLowerCase() === 'refunded' || p.status?.toLowerCase() === 'cancelled')
    ) || []
  }, [selectedContact])
  const paymentsTotalCount = selectedContact?.paymentsTotal ?? (payments.length + refunds.length)
  const appointmentsTotalCount = selectedContact?.appointmentsTotal ?? selectedContact?.appointments?.length ?? 0
  const resolvedAttribution = useMemo(
    () => getResolvedAttributionDisplay(selectedContact),
    [selectedContact]
  )
  const activeAutomationItems = automationActivity?.active || []
  const pastAutomationItems = automationActivity?.past || []
  const automationActivityCount = activeAutomationItems.length + pastAutomationItems.length
  const automationInputMin = useMemo(
    () => toZonedDateTimeLocalInputValue(new Date(), timezone),
    [enrollModalOpen, timezone]
  )
  const selectedContactPhones = useMemo(() => getContactPhoneEntries(selectedContact), [selectedContact])
  const availableWhatsAppPhones = useMemo<ContactChatPhoneOption[]>(() => {
    const statusPhones = whatsappStatus?.phoneNumbers || []
    return statusPhones.length > 0 ? statusPhones : whatsappPhoneNumbers
  }, [whatsappPhoneNumbers, whatsappStatus?.phoneNumbers])
  const whatsappPreferenceOptions = whatsappPhoneNumbers.length > 0 ? whatsappPhoneNumbers : availableWhatsAppPhones
  const preferredWhatsAppPhoneNumberId = getPreferredWhatsAppPhoneNumberId(selectedContact)
  const selectedContactHasPhone = selectedContactPhones.length > 0
  const automaticWhatsAppRoutePhone = useMemo<ContactChatPhoneOption | null>(() => {
    const routedMessage = [...chatMessages]
      .reverse()
      .find((message) => (
        message.channel === 'whatsapp' &&
        message.direction !== 'outbound' &&
        Boolean(message.businessPhoneNumberId || message.businessPhone)
      ))
    const routePhoneNumberId = String(
      routedMessage?.businessPhoneNumberId ||
      selectedContact?.lastInboundBusinessPhoneNumberId ||
      selectedContact?.lastBusinessPhoneNumberId ||
      ''
    ).trim()
    const routeBusinessPhone = String(
      routedMessage?.businessPhone ||
      selectedContact?.lastInboundBusinessPhone ||
      selectedContact?.lastBusinessPhone ||
      ''
    ).trim()
    return findContactChatPhoneByRoute(
      [...availableWhatsAppPhones, ...whatsappPhoneNumbers],
      routePhoneNumberId,
      routeBusinessPhone
    )
  }, [availableWhatsAppPhones, chatMessages, selectedContact, whatsappPhoneNumbers])
  const selectedBusinessPhone = useMemo<ContactChatPhoneOption | null>(() => {
    const routePhoneId = chatChannelValue.startsWith('whatsapp:') ? chatChannelValue.slice('whatsapp:'.length) : ''
    if (routePhoneId) {
      const routePhone = availableWhatsAppPhones.find((phone) => phone.id === routePhoneId)
      if (routePhone) return routePhone
    }

    if (preferredWhatsAppPhoneNumberId) {
      const preferredPhone = availableWhatsAppPhones.find((phone) => phone.id === preferredWhatsAppPhoneNumberId)
      if (preferredPhone) return preferredPhone
    }

    if (automaticWhatsAppRoutePhone) return automaticWhatsAppRoutePhone

    return availableWhatsAppPhones.find((phone) => phone.is_default_sender) ||
      whatsappStatus?.selectedPhone ||
      availableWhatsAppPhones[0] ||
      null
  }, [automaticWhatsAppRoutePhone, availableWhatsAppPhones, chatChannelValue, preferredWhatsAppPhoneNumberId, whatsappStatus?.selectedPhone])
  const selectedBusinessPhoneValue = getWhatsAppPhoneValue(selectedBusinessPhone) || whatsappStatus?.sender?.phone || ''
  const selectedWhatsAppPreferencePhone = preferredWhatsAppPhoneNumberId
    ? availableWhatsAppPhones.find((phone) => phone.id === preferredWhatsAppPhoneNumberId) ||
      whatsappPhoneNumbers.find((phone) => phone.id === preferredWhatsAppPhoneNumberId) ||
      null
    : null
  const whatsappPreferenceRoutePhone = selectedWhatsAppPreferencePhone || automaticWhatsAppRoutePhone || selectedBusinessPhone
  const whatsappPreferenceRouteLabel = getContactChatPhoneLabel(whatsappPreferenceRoutePhone)
  const whatsappPreferenceRouteNumber =
    getWhatsAppPhoneValue(whatsappPreferenceRoutePhone) || selectedBusinessPhoneValue || ''
  const whatsappPreferenceRouteDisplay = whatsappPreferenceRouteNumber
    ? whatsappPreferenceRouteLabel && whatsappPreferenceRouteLabel !== whatsappPreferenceRouteNumber
      ? `${whatsappPreferenceRouteLabel} · ${whatsappPreferenceRouteNumber}`
      : whatsappPreferenceRouteNumber
    : 'Sin número configurado'
  const whatsappPreferenceModeLabel = preferredWhatsAppPhoneNumberId
    ? 'Número fijo'
    : 'Automático'
  const whatsappPreferenceRouteMode = preferredWhatsAppPhoneNumberId
    ? 'Responde desde'
    : automaticWhatsAppRoutePhone
    ? 'Último mensaje'
    : 'Principal actual'
  const whatsappPreferenceDescription = preferredWhatsAppPhoneNumberId
    ? 'Siempre usa este remitente para este contacto.'
    : automaticWhatsAppRoutePhone
    ? 'Usa la conversación; si no hay historial, toma el principal.'
    : 'Usa el remitente principal mientras no haya historial de WhatsApp.'
  const automaticWhatsAppPreferenceOptionLabel = automaticWhatsAppRoutePhone
    ? 'Automático: usar el número por donde llegó'
    : 'Automático: usar remitente principal'
  const showWhatsAppPreference = selectedContactHasPhone && whatsappPreferenceOptions.length > 0
  const whatsappConnected = Boolean(whatsappStatus?.connected && selectedBusinessPhoneValue)
  const detectedContactChannels = useMemo(
    () => getContactDetectedSocialChannels(selectedContact, chatMessages),
    [chatMessages, selectedContact]
  )
  const selectedChatChannel = getContactChatChannelFromValue(chatChannelValue)
  const chatEmailPlainText = useMemo(
    () => selectedChatChannel === 'email' ? emailHtmlToPlainText(chatEmailHtml) : '',
    [chatEmailHtml, selectedChatChannel]
  )
  const hasDetectedMessenger = detectedContactChannels.has('messenger')
  const hasDetectedInstagram = detectedContactChannels.has('instagram')
  const channelStatusLoading = whatsappStatusLoading || emailStatusLoading || highLevelStatusLoading
  const whatsappApiSourcesAvailable = Boolean(whatsappStatus?.connected && availableWhatsAppPhones.some((phone) => getWhatsAppPhoneValue(phone)))
  const canSendMessenger = metaMessengerConnected || highLevelConnected
  const canSendInstagram = metaInstagramConnected || highLevelConnected
  const emailChannelConnected = highLevelConnected || emailConnected
  const chatChannelOptions = useMemo<Array<{ value: string; label: string; disabled?: boolean; icon: ReactNode }>>(() => {
    if (!selectedContact) {
      return [{ value: 'none', label: CONTACT_CHAT_CHANNEL_LABELS.none, disabled: true, icon: renderContactChatChannelIcon('none') }]
    }

    const options: Array<{ value: string; label: string; disabled?: boolean; icon: ReactNode }> = []
    const whatsappDisabled = !selectedContact.phone || (!whatsappApiSourcesAvailable && !highLevelConnected)

    if (selectedContact.phone) {
      if (availableWhatsAppPhones.length > 0) {
        availableWhatsAppPhones.forEach((phone) => {
          const phoneValue = getWhatsAppPhoneValue(phone)
          options.push({
            value: `whatsapp:${phone.id}`,
            label: `${CONTACT_CHAT_CHANNEL_LABELS.whatsapp} · ${getContactChatPhoneLabel(phone)}`,
            icon: renderContactChatChannelIcon('whatsapp'),
            disabled: whatsappDisabled || (!phoneValue && !highLevelConnected)
          })
        })
      } else {
        options.push({
          value: 'whatsapp',
          label: CONTACT_CHAT_CHANNEL_LABELS.whatsapp,
          icon: renderContactChatChannelIcon('whatsapp'),
          disabled: whatsappDisabled
        })
      }
    }

    if (hasEmailAccess && selectedContact.email) {
      options.push({
        value: 'email',
        label: `${CONTACT_CHAT_CHANNEL_LABELS.email} · ${selectedContact.email}`,
        icon: renderContactChatChannelIcon('email'),
        disabled: !emailChannelConnected
      })
    }

    if (hasDetectedMessenger) {
      options.push({
        value: 'messenger',
        label: CONTACT_CHAT_CHANNEL_LABELS.messenger,
        icon: renderContactChatChannelIcon('messenger'),
        disabled: !canSendMessenger
      })
    }

    if (hasDetectedInstagram) {
      options.push({
        value: 'instagram',
        label: CONTACT_CHAT_CHANNEL_LABELS.instagram,
        icon: renderContactChatChannelIcon('instagram'),
        disabled: !canSendInstagram
      })
    }

    return options.length > 0
      ? options
      : [{ value: 'none', label: CONTACT_CHAT_CHANNEL_LABELS.none, disabled: true, icon: renderContactChatChannelIcon('none') }]
  }, [
    availableWhatsAppPhones,
    emailChannelConnected,
    hasEmailAccess,
    hasDetectedInstagram,
    hasDetectedMessenger,
    highLevelConnected,
    canSendInstagram,
    canSendMessenger,
    selectedContact,
    whatsappApiSourcesAvailable
  ])
  useEffect(() => {
    if (hasEmailAccess || selectedChatChannel !== 'email') return
    setChatChannelValue('whatsapp')
  }, [hasEmailAccess, selectedChatChannel])
  const selectedChatChannelOption = chatChannelOptions.find((option) => option.value === chatChannelValue) || chatChannelOptions[0]
  const selectedChatRouteLabel = selectedChatChannelOption?.label || CONTACT_CHAT_CHANNEL_LABELS[selectedChatChannel]
  const chatMessageGroups = useMemo(() => {
    const items: ContactChatTimelineItem[] = [
      ...chatMessages.map((message) => ({
        type: 'message' as const,
        id: `message-${message.id}`,
        date: message.date,
        message
      })),
      ...agentCompletionEvents.map((completion) => ({
        type: 'agentCompletion' as const,
        id: `agent-completion-${completion.id}`,
        date: completion.createdAt,
        completion
      }))
    ].sort((left, right) => {
      return parseSortableDateValue(left.date) - parseSortableDateValue(right.date)
    })
    const groups: Array<{ key: string; label: string; items: ContactChatTimelineItem[] }> = []
    items.forEach((item) => {
      const key = getChatDayKey(item.date, timezone)
      const current = groups[groups.length - 1]
      if (!current || current.key !== key) {
        groups.push({ key, label: getChatDayLabel(item.date, timezone), items: [item] })
        return
      }
      current.items.push(item)
    })
    return groups
  }, [agentCompletionEvents, chatMessages, timezone])
  const chatChannelReady = selectedChatChannel === 'email'
    ? Boolean(hasEmailAccess && selectedContact?.email && emailChannelConnected)
    : selectedChatChannel === 'whatsapp'
    ? Boolean(selectedContact?.phone && (whatsappConnected || highLevelConnected))
    : selectedChatChannel === 'messenger'
    ? Boolean(hasDetectedMessenger && canSendMessenger)
    : selectedChatChannel === 'instagram'
    ? Boolean(hasDetectedInstagram && canSendInstagram)
    : false
  const chatHasContent = selectedChatChannel === 'email'
    ? Boolean(chatSubject.trim() && chatEmailPlainText.trim())
    : Boolean(chatDraft.trim())
  const chatComposerHint = !selectedContact
    ? ''
    : channelStatusLoading
    ? 'Revisando canales disponibles...'
    : selectedChatChannel === 'none'
    ? 'Este contacto no tiene telefono, correo ni canal social detectado.'
    : selectedChatChannel === 'email' && !hasEmailAccess
    ? 'El correo no está incluido en los accesos de esta cuenta.'
    : selectedChatChannel === 'email' && !selectedContact.email
    ? 'Este contacto no tiene correo guardado.'
    : selectedChatChannel === 'email' && !emailChannelConnected
    ? 'Conecta HighLevel o tu correo de envio en Configuracion > Correos.'
    : selectedChatChannel === 'whatsapp' && !selectedContact.phone
    ? 'Este contacto no tiene telefono guardado.'
    : selectedChatChannel === 'whatsapp' && whatsappApiSourcesAvailable && !selectedBusinessPhoneValue && !highLevelConnected
    ? 'Elige una caja de WhatsApp para responder.'
    : selectedChatChannel === 'whatsapp' && !whatsappApiSourcesAvailable && !highLevelConnected
    ? 'Conecta WhatsApp API para responder desde Ristak.'
    : selectedChatChannel === 'messenger' && !hasDetectedMessenger
    ? 'Este contacto no tiene Messenger detectado.'
    : selectedChatChannel === 'instagram' && !hasDetectedInstagram
    ? 'Este contacto no tiene Instagram detectado.'
    : selectedChatChannel === 'messenger' && !canSendMessenger
    ? 'Activa Messenger en Configuracion > Meta para responder desde Ristak.'
    : selectedChatChannel === 'instagram' && !canSendInstagram
    ? 'Activa Instagram en Configuracion > Meta para responder desde Ristak.'
    : ''
  const canSendChatMessage = Boolean(
    selectedContact?.id &&
    chatChannelReady &&
    chatHasContent &&
    !chatSending
  )

  useEffect(() => {
    if (!isOpen || !selectedContact) return
    if (chatChannelOptions.some((option) => option.value === chatChannelValue)) return

    const preferredWhatsAppOption = selectedBusinessPhone?.id
      ? chatChannelOptions.find((option) => option.value === `whatsapp:${selectedBusinessPhone.id}`)
      : undefined
    const preferredOption =
      preferredWhatsAppOption ||
      chatChannelOptions.find((option) => option.value.startsWith('whatsapp')) ||
      chatChannelOptions.find((option) => option.value === 'email') ||
      chatChannelOptions.find((option) => option.value === 'messenger') ||
      chatChannelOptions.find((option) => option.value === 'instagram') ||
      chatChannelOptions[0]

    if (preferredOption) setChatChannelValue(preferredOption.value)
  }, [chatChannelOptions, chatChannelValue, isOpen, selectedBusinessPhone?.id, selectedContact])

  useEffect(() => {
    if (selectedChatChannel !== 'email' || chatEmailHtml.trim() || !chatDraft.trim()) return
    setChatEmailHtml(plainTextToEmailHtml(chatDraft))
  }, [chatDraft, chatEmailHtml, selectedChatChannel])

  const handleContactChatChannelChange = useCallback((value: string) => {
    const currentChannel = getContactChatChannelFromValue(chatChannelValue)
    const nextChannel = getContactChatChannelFromValue(value)

    if (nextChannel === 'email' && currentChannel !== 'email' && !chatEmailHtml.trim() && chatDraft.trim()) {
      setChatEmailHtml(plainTextToEmailHtml(chatDraft))
    }

    if (currentChannel === 'email' && nextChannel !== 'email') {
      const emailText = emailHtmlToPlainText(chatEmailHtml)
      if (emailText && !chatDraft.trim()) setChatDraft(emailText)
      setChatSubject('')
    }

    setChatChannelValue(value)
  }, [chatChannelValue, chatDraft, chatEmailHtml])

  const sendContactChatMessage = async () => {
    if (!selectedContact || !canSendChatMessage) return

    const isEmailChannel = selectedChatChannel === 'email'
    const cleanEmailHtml = isEmailChannel ? sanitizeEmailRichHtmlForEditor(chatEmailHtml) : ''
    const text = isEmailChannel ? emailHtmlToPlainText(cleanEmailHtml) : chatDraft.trim()
    const subject = chatSubject.trim()
    const sendEmailThroughHighLevel = isEmailChannel && highLevelConnected
    const optimisticId = `contact-modal-chat-${Date.now()}`
    const sentAt = new Date().toISOString()
    const optimisticMessage: ContactChatMessage = {
      id: optimisticId,
      optimisticId,
      text,
      subject: selectedChatChannel === 'email' ? subject : undefined,
      date: sentAt,
      direction: 'outbound',
      status: 'enviando',
      transport: sendEmailThroughHighLevel
        ? 'ghl_email'
        : selectedChatChannel === 'whatsapp'
        ? (whatsappConnected ? 'api' : 'whatsapp_api')
        : selectedChatChannel,
      channel: selectedChatChannel
    }

    setChatSending(true)
    setChatDraft('')
    if (isEmailChannel) {
      setChatSubject('')
      setChatEmailHtml('')
    }
    setChatMessages((current) => [...current, optimisticMessage])

    try {
      if (isEmailChannel) {
        if (sendEmailThroughHighLevel) {
          const result = await highLevelService.sendConversationMessage({
            contactId: selectedContact.id,
            channel: 'email',
            message: text,
            subject,
            html: cleanEmailHtml,
            externalId: optimisticId
          })
          const data = result.data || result

          setChatMessages((current) => current.map((message) => message.id === optimisticId
            ? {
                ...message,
                id: data.localMessageId || message.id,
                status: data.status || 'sent',
                transport: data.transport || 'ghl_email',
                channel: 'email'
              }
            : message
          ))
        } else {
          const result = await emailService.send({
            contactId: selectedContact.id,
            to: selectedContact.email || '',
            subject,
            text,
            html: cleanEmailHtml,
            includeSignature: chatEmailIncludeSignature,
            externalId: optimisticId
          })

          setChatMessages((current) => current.map((message) => message.id === optimisticId
            ? {
                ...message,
                id: result.localMessageId || message.id,
                status: result.status || 'sent',
                transport: 'email',
                channel: 'email'
              }
            : message
          ))
        }
      } else if (selectedChatChannel === 'whatsapp' && whatsappConnected && selectedContact.phone) {
        const result = await whatsappApiService.sendText({
          to: selectedContact.phone,
          from: selectedBusinessPhoneValue,
          contactId: selectedContact.id,
          text,
          externalId: optimisticId,
          transport: 'api',
          phoneNumberId: selectedBusinessPhone?.id || undefined,
          messageOrigin: 'manual_chat'
        })

        setChatMessages((current) => current.map((message) => message.id === optimisticId
          ? {
              ...message,
              status: result.status || 'sent',
              transport: result.transport || message.transport,
              channel: 'whatsapp'
            }
          : message
        ))
      } else if (selectedChatChannel === 'messenger' && metaMessengerConnected) {
        const result = await whatsappApiService.sendMetaSocialText({
          contactId: selectedContact.id,
          platform: 'messenger',
          message: text,
          externalId: optimisticId
        })
        const data = result.data || result

        setChatMessages((current) => current.map((message) => message.id === optimisticId
          ? {
              ...message,
              id: data.localMessageId || message.id,
              status: data.status || 'sent',
              transport: data.transport || 'messenger',
              channel: 'messenger'
            }
          : message
        ))
      } else if (selectedChatChannel === 'instagram' && metaInstagramConnected) {
        const result = await whatsappApiService.sendMetaSocialText({
          contactId: selectedContact.id,
          platform: 'instagram',
          message: text,
          externalId: optimisticId
        })
        const data = result.data || result

        setChatMessages((current) => current.map((message) => message.id === optimisticId
          ? {
              ...message,
              id: data.localMessageId || message.id,
              status: data.status || 'sent',
              transport: data.transport || 'instagram',
              channel: 'instagram'
            }
          : message
        ))
      } else if (selectedChatChannel === 'whatsapp' || selectedChatChannel === 'messenger' || selectedChatChannel === 'instagram') {
        const result = await highLevelService.sendConversationMessage({
          contactId: selectedContact.id,
          channel: getHighLevelChannelForContactChat(selectedChatChannel),
          message: text,
          fromNumber: selectedBusinessPhoneValue || undefined,
          toNumber: selectedContact.phone || undefined,
          externalId: optimisticId
        })
        const data = result.data || result

        setChatMessages((current) => current.map((message) => message.id === optimisticId
          ? {
              ...message,
              id: data.localMessageId || message.id,
              status: data.status || 'pending',
              transport: data.transport || data.channel || message.transport,
              channel: selectedChatChannel
            }
          : message
        ))
      } else {
        throw new Error('Este contacto no tiene un canal disponible para responder.')
      }

      await loadContactChat(selectedContact.id, { silent: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Intenta enviar el mensaje otra vez.'
      setChatMessages((current) => current.map((item) => item.id === optimisticId
        ? { ...item, status: 'error', errorReason: message }
        : item
      ))
      if (isEmailChannel) {
        setChatSubject(subject)
        setChatEmailHtml(cleanEmailHtml || plainTextToEmailHtml(text))
      } else {
        setChatDraft(text)
      }
    } finally {
      setChatSending(false)
    }
  }

  const describeAutomationActivityItem = (item: ContactAutomationActivityItem) => {
    if (item.kind === 'scheduled') {
      if (item.status === 'scheduled' && item.scheduledAt) {
        return `Programada para ${formatLocalDateTime(item.scheduledAt)}`
      }
      if (item.error) return item.error
      if (item.executedAt) return `Procesada ${formatLocalDateTime(item.executedAt)}`
      return item.scheduledAt ? `Programada para ${formatLocalDateTime(item.scheduledAt)}` : 'Programada'
    }

    if (item.status === 'waiting') {
      return item.currentNodeId ? `En espera en ${item.currentNodeId}` : 'En espera dentro del flujo'
    }
    if (item.status === 'active') {
      return item.currentNodeId ? `Paso actual: ${item.currentNodeId}` : 'Activa dentro del flujo'
    }
    if (item.updatedAt) return `Último movimiento: ${formatLocalDateTime(item.updatedAt)}`
    if (item.enteredAt) return `Entró: ${formatLocalDateTime(item.enteredAt)}`
    return 'Sin fecha registrada'
  }

  const renderAutomationActivityList = (items: ContactAutomationActivityItem[], emptyText: string) => {
    if (automationActivityLoading) {
      return (
        <div className={styles.automationListState} role="status" aria-live="polite" aria-label="Cargando automatizaciones">
          <Icon name="refresh" size={16} className={styles.spinIcon} />
        </div>
      )
    }

    if (items.length === 0) {
      return <p className={styles.automationEmptyText}>{emptyText}</p>
    }

    return (
      <ul className={styles.automationActivityList}>
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className={styles.automationActivityItem}>
            <div className={styles.automationActivityMain}>
              <p className={styles.automationActivityName}>{item.automationName}</p>
              <span className={styles.automationActivityMeta}>
                {describeAutomationActivityItem(item)}
              </span>
            </div>
            <Badge variant={getAutomationStatusVariant(item.status)} className={styles.automationActivityBadge}>
              {getAutomationStatusLabel(item.status)}
            </Badge>
          </li>
        ))}
      </ul>
    )
  }

  const renderAgentCompletionCard = (completion: ConversationalAgentCompletionEvent) => (
    <article className={styles.contactChatAgentSummary} aria-label={`Resumen del agente: ${completion.title}`}>
      <span className={styles.contactChatAgentSummaryIcon} aria-hidden="true">
        <AgentRobot size={34} active label="Chatbot" className={styles.contactChatAgentSummaryRobot} />
      </span>
      <span className={styles.contactChatAgentSummaryBody}>
        <span className={styles.contactChatAgentSummaryHeader}>
          <span className={styles.contactChatAgentSummaryTitle}>
            <span className={styles.contactChatAgentSummarySignal} aria-hidden="true">{completion.icon}</span>
            <strong>{completion.title}</strong>
          </span>
          <small>{getChatTimeLabel(completion.createdAt, timezone)}</small>
        </span>
        <p className={styles.contactChatAgentSummaryAction}>{completion.actionSummary}</p>
        {completion.summary && completion.summary !== completion.actionSummary ? (
          <p className={styles.contactChatAgentSummaryText}><strong>Resumen:</strong> {completion.summary}</p>
        ) : null}
      </span>
    </article>
  )

  const renderContactChatPanel = () => {
    if (!selectedContact) return null

    return (
      <section className={styles.contactChatPanel} aria-label={`Chat con ${getContactDisplayName(selectedContact)}`}>
        <header className={styles.contactChatHeader}>
          <div className={styles.contactChatTitle}>
            {renderContactAvatar(selectedContact, styles.contactChatAvatar)}
            <div>
              <h4>Chat</h4>
              <p>{getContactDetailLabel(selectedContact)}</p>
            </div>
          </div>
          <span className={styles.contactChatRoute}>
            {selectedChatRouteLabel}
          </span>
        </header>

        <ChatMessageSurface ref={chatMessagesRef} className={styles.contactChatMessages}>
          {!chatLoading && chatHasOlder ? (
            <div className={styles.contactChatState}>
              <Button variant="secondary" size="sm" disabled={chatOlderLoading} onClick={() => { void loadOlderContactChat() }}>
                {chatOlderLoading ? <Loader2 size={14} className={styles.spinIcon} aria-hidden="true" /> : null}
                Cargar mensajes anteriores
              </Button>
            </div>
          ) : null}
          {chatLoading ? (
            <div className={styles.contactChatState} role="status" aria-live="polite">
              <Loader2 size={18} className={styles.spinIcon} aria-hidden="true" />
            </div>
          ) : chatError ? (
            <div className={styles.contactChatState}>
              <CircleAlert size={18} aria-hidden="true" />
              <span>{chatError}</span>
              <Button variant="secondary" size="sm" onClick={() => { void loadContactChat(selectedContact.id) }}>
                Reintentar
              </Button>
            </div>
          ) : chatMessages.length === 0 && agentCompletionEvents.length === 0 ? (
            <div className={styles.contactChatEmpty}>
              <MessageCircle size={22} aria-hidden="true" />
              <strong>Sin mensajes todavía</strong>
              <span>Escribe abajo para empezar la conversación con este contacto.</span>
            </div>
          ) : (
            chatMessageGroups.map((group) => (
              <div key={group.key} className={styles.contactChatGroup}>
                <div className={styles.contactChatDay}>{group.label}</div>
                {group.items.map((item) => {
                  if (item.type === 'agentCompletion') {
                    return (
                      <div key={item.id} className={styles.contactChatAgentSummaryRow}>
                        {renderAgentCompletionCard(item.completion)}
                      </div>
                    )
                  }
                  const message = item.message
                  const status = String(message.status || '').trim().toLowerCase()
                  const failed = CONTACT_FAILED_MESSAGE_STATUSES.has(status) || Boolean(message.errorReason)
                  const scheduled = isScheduledContactChatMessage(message)
                  const sending = message.direction === 'outbound' && isChatMessageSendInFlight(status) && !scheduled && !failed

                  return (
                    <article
                      key={item.id}
                      className={`${styles.contactChatBubble} ${
                        message.direction === 'outbound'
                          ? styles.contactChatOutbound
                          : message.direction === 'system'
                          ? styles.contactChatSystem
                          : styles.contactChatInbound
                      } ${scheduled ? styles.contactChatScheduled : ''} ${message.email ? styles.contactChatEmail : ''}`}
                    >
                      {message.email ? (
                        <EmailChatMessageBubble email={message.email} compact />
                      ) : (
                        <>
                          {message.subject ? <strong className={styles.contactChatSubject}>{message.subject}</strong> : null}
                          {message.text ? <WhatsAppFormattedText text={message.text} className={styles.contactChatText} /> : null}
                        </>
                      )}
                      {message.errorReason && !message.email ? <small className={styles.contactChatError}>{message.errorReason}</small> : null}
                      {message.scheduledAt ? (
                        <small className={styles.contactChatScheduledText}>
                          Programado para {formatLocalDateTime(message.scheduledAt)}
                        </small>
                      ) : null}
                      <small className={styles.contactChatMeta}>
                        {failed ? <CircleAlert size={12} aria-hidden="true" /> : null}
                        <span>{getChatTimeLabel(message.date, timezone)}</span>
                        {message.transport ? <em>{message.transport}</em> : null}
                        {message.direction === 'outbound' && !failed && !scheduled && !sending ? <CheckCheck size={13} aria-hidden="true" /> : null}
                        {scheduled ? <Clock size={12} aria-hidden="true" /> : null}
                        {sending ? <Loader2 size={12} className={styles.spinIcon} aria-label="Enviando" /> : null}
                      </small>
                    </article>
                  )
                })}
              </div>
            ))
          )}
        </ChatMessageSurface>

        <form
          className={selectedChatChannel === 'email' ? styles.contactEmailComposer : styles.contactChatComposer}
          data-enter-submit-ignore
          onSubmit={(event) => {
            event.preventDefault()
            void sendContactChatMessage()
          }}
        >
          {chatComposerHint ? <span className={styles.contactChatHint}>{chatComposerHint}</span> : null}
          {selectedChatChannel === 'email' ? (
            <>
              <div className={styles.contactEmailHeaderRow}>
                <div className={styles.contactChatChannelSelect}>
                  <CustomSelect
                    value={chatChannelValue}
                    options={chatChannelOptions}
                    onValueChange={handleContactChatChannelChange}
                    portal
                    dropdownPlacement="top"
                    iconOnly
                    dropdownMinWidth={240}
                    aria-label="Canal de envio"
                  />
                </div>
                <label className={styles.contactEmailSubjectField}>
                  <span>Asunto</span>
                  <input
                    data-ristak-unstyled
                    className={styles.contactEmailSubjectInput}
                    value={chatSubject}
                    onChange={(event) => setChatSubject(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.preventDefault()
                    }}
                    placeholder="Asunto del correo"
                    disabled={chatSending}
                  />
                </label>
              </div>

              <EmailRichTextEditor
                value={chatEmailHtml}
                onChange={setChatEmailHtml}
                className={styles.contactEmailEditor}
                editorClassName={styles.contactEmailEditorBody}
                density="regular"
                variables={CONTACT_EMAIL_VARIABLES}
                placeholder="Escribe el correo..."
                codePlaceholder="<table><tr><td>Contenido del correo...</td></tr></table>"
              />

              <div className={styles.contactEmailFooter}>
                <label className={styles.contactEmailSignatureToggle}>
                  <Switch
                    checked={chatEmailIncludeSignature}
                    onChange={setChatEmailIncludeSignature}
                    disabled={chatSending}
                    aria-label="Agregar firma guardada al enviar"
                  />
                  <span>Agregar la firma guardada al enviar</span>
                </label>

                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  className={styles.contactEmailSendButton}
                  loading={chatSending}
                  disabled={!canSendChatMessage}
                >
                  <Send size={16} />
                  Enviar
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className={styles.contactChatChannelSelect}>
                <CustomSelect
                  value={chatChannelValue}
                  options={chatChannelOptions}
                  onValueChange={handleContactChatChannelChange}
                  portal
                  dropdownPlacement="top"
                  iconOnly
                  dropdownMinWidth={240}
                  aria-label="Canal de envio"
                />
              </div>
              <textarea
                data-ristak-unstyled
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    if (canSendChatMessage) void sendContactChatMessage()
                  }
                }}
                placeholder="Escribe una respuesta..."
                rows={1}
                disabled={chatSending}
              />
              <Button
                type="submit"
                variant="primary"
                size="sm"
                className={styles.contactChatSendButton}
                disabled={!canSendChatMessage}
                aria-label="Enviar mensaje"
              >
                <Send size={16} />
              </Button>
            </>
          )}
        </form>
      </section>
    )
  }

  const resolvedTotalCount = totalCount ?? data.length
  const hasSingleResult = resolvedTotalCount === 1 && !onPageChange

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title=""
      size={hasSingleResult ? 'xl' : 'lg'}
      showCloseButton={false}
      flushContent
    >
      <div className={styles.modalContainer}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            <div className={styles.headerTitleGroup}>
              <div className={styles.titleRow}>
                <h3 className={styles.title}>{title}</h3>
                <div className={styles.stats}>
                  <span className={styles.statItem}>
                    {totalCountIsCapped ? `${resolvedTotalCount}+` : resolvedTotalCount} {hasSingleResult ? 'elemento' : 'elementos'}
                  </span>
                  {type === 'sales' && (totalValue !== null) && (totalValue !== undefined || data.some(d => (d.ltv || 0) > 0)) && (
                    <span className={styles.statValue}>
                      Total: {formatCurrency(totalValue ?? data.reduce((sum, d) => sum + (d.ltv || 0), 0))}
                    </span>
                  )}
                </div>
              </div>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            <button onClick={onClose} className={styles.closeButton}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className={`${styles.mainContent} ${selectedContact && hasSingleResult ? styles.mainContentWithChat : ''}`}>
          {/* Left panel - Lista de contactos.
              Con un solo contacto no tiene sentido el buscador ni la lista:
              se oculta y la ficha ocupa todo el ancho. */}
          {!hasSingleResult && (
          <div className={selectedContact ? styles.leftPanel : styles.leftPanelFull}>
            {/* Search bar */}
            <div className={styles.searchContainer}>
              <div className={styles.searchInputWrapper}>
                <Icon name="search" size={16} className={styles.searchIcon} />
                <input
                  type="text"
                  placeholder="Buscar..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className={styles.clearButton}
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Contact list */}
            <div className={styles.contactList}>
              {loading ? (
                <div className={styles.emptyState} role="status" aria-live="polite" aria-label="Cargando elementos">
                  <Icon name="refresh" size={24} className={styles.spinIcon} />
                </div>
              ) : filteredData.length === 0 ? (
                <div className={styles.emptyState}>
                  <Icon name="users" size={24} />
                  <p>{searchQuery ? 'No se encontraron resultados' : 'No hay elementos para mostrar'}</p>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className={styles.clearSearchButton}
                    >
                      Limpiar búsqueda
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {filteredData.map((contact) => (
                    <div
                      key={contact.id}
                      onClick={() => setSelectedContact(contact)}
                      className={`${styles.contactItem} ${selectedContact?.id === contact.id ? styles.contactItemSelected : ''}`}
                    >
                      {renderContactAvatar(contact, styles.contactAvatar)}

                      <div className={styles.contactInfo}>
                        <p className={styles.contactName}>
                          {contact.name || '—'}
                        </p>
                        {(contact.email || contact.phone) && (
                          <p className={styles.contactDetail}>
                            {contact.email || contact.phone}
                          </p>
                        )}
                      </div>

                      <div className={styles.contactIndicators}>
                        {(() => {
                          const badge = resolveContactBadge(contact)
                          return badge ? (
                            <Badge variant={badge.variant} className={styles.contactBadge}>
                              {badge.text}
                            </Badge>
                          ) : null
                        })()}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Footer */}
            {(data.length > 0 || (onPageChange && (hasPreviousPage || hasNextPage))) && (
              <div className={styles.footer}>
                <span>
                  {onPageChange
                    ? `Mostrando ${filteredData.length} en página ${currentPage}`
                    : `Mostrando ${filteredData.length} de ${data.length}`}
                </span>
                {onPageChange && (
                  <div className={styles.footerPagination}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!hasPreviousPage || loading}
                      onClick={() => onPageChange('previous')}
                    >
                      Anterior
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!hasNextPage || loading}
                      onClick={() => onPageChange('next')}
                    >
                      Siguiente
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
          )}

          {/* Right panel - Detalles del contacto */}
          {selectedContact && (
            <>
              <div className={`${styles.rightPanel} ${hasSingleResult ? styles.singleContactInfoPanel : ''}`}>
                {/* Contact header */}
                <div className={styles.contactHeader}>
                  {renderContactAvatar(selectedContact, styles.contactHeaderAvatar)}
                  <div className={styles.contactHeaderInfo}>
                    <div className={styles.contactHeaderNameRow}>
                      <InlineEditableText
                        className={styles.contactHeaderName}
                        value={selectedContact.name || ''}
                        emptyLabel="Sin nombre"
                        ariaLabel="Editar nombre del contacto"
                        disabled={!onUpdateContact}
                        onSave={(value) => saveContactIdentityField('name', value)}
                      />
                      {(() => {
                        const badge = resolveContactBadge(selectedContact)
                        return badge ? (
                          <Badge variant={badge.variant} className={styles.contactHeaderBadge}>
                            {badge.text}
                          </Badge>
                        ) : null
                      })()}
                    </div>
                    {(selectedContact.email || selectedContact.phone) && (
                      <div className={styles.contactHeaderMeta}>
                        {selectedContact.email && (
                          <InlineEditableText
                            value={selectedContact.email}
                            ariaLabel="Editar correo del contacto"
                            type="email"
                            inputMode="email"
                            disabled={!onUpdateContact}
                            onSave={(value) => saveContactIdentityField('email', value)}
                          />
                        )}
                        {selectedContact.email && selectedContact.phone && (
                          <span className={styles.metaSeparator}>/</span>
                        )}
                        {selectedContact.phone && (
                          <InlineEditableText
                            value={selectedContact.phone}
                            ariaLabel="Editar teléfono del contacto"
                            type="tel"
                            inputMode="tel"
                            disabled={!onUpdateContact}
                            onSave={(value) => saveContactIdentityField('phone', value)}
                          />
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Contact details */}
                <div className={styles.contactDetails}>
                  {/* Información básica */}
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Información de Contacto
                    </h5>
                    <div className={styles.detailSectionContent}>
                      <div className={styles.detailItem}>
                        <Icon name="mail" size={16} />
                        <InlineEditableText
                          value={selectedContact.email || ''}
                          emptyLabel="Sin correo"
                          ariaLabel="Editar correo del contacto"
                          type="email"
                          inputMode="email"
                          layout="block"
                          disabled={!onUpdateContact}
                          onSave={(value) => saveContactIdentityField('email', value)}
                        />
                      </div>
                      <div className={`${styles.detailItem} ${styles.phoneDetailItem}`}>
                        <Icon name="phone" size={16} />
                        <ContactPhoneSelector
                          phones={selectedContactPhones}
                          emptyLabel="Sin teléfono"
                          disabled={!onUpdateContact}
                          savingPhone={savingPrimaryPhone}
                          onSavePrimaryPhone={(value) => saveContactIdentityField('phone', value)}
                          onMakePrimary={makeContactPhonePrimary}
                        />
                      </div>
                      <div className={styles.detailItem}>
                        <Icon name="calendar" size={16} />
                        <span>{formatLocalDateShort(selectedContact.created_at)}</span>
                      </div>
                    </div>
                  </div>

                  {showWhatsAppPreference && (
                    <div className={styles.detailSection}>
                      <h5 className={styles.detailSectionTitle}>Respuesta por WhatsApp</h5>
                      <div className={styles.detailSectionContent}>
                        <p className={styles.whatsappPreferenceDescription}>
                          {whatsappPreferenceModeLabel} · {whatsappPreferenceDescription}
                        </p>
                        <CustomSelect
                          value={preferredWhatsAppPhoneNumberId}
                          onChange={(event) => updatePreferredWhatsAppPhoneNumber(event.target.value)}
                          disabled={savingWhatsAppPreference || !onUpdatePreferredWhatsAppPhoneNumber}
                        >
                          <option value="">{automaticWhatsAppPreferenceOptionLabel}</option>
                          {whatsappPreferenceOptions.map((phone) => (
                            <option key={phone.id} value={phone.id}>
                              {getWhatsAppPhoneLabel(phone)}{phone.is_default_sender ? ' · Principal' : ''}
                            </option>
                          ))}
                        </CustomSelect>
                        <p className={styles.whatsappPreferenceRoute}>
                          <strong>{whatsappPreferenceRouteMode}</strong>
                          <span>{whatsappPreferenceRouteDisplay}</span>
                        </p>
                        {savingWhatsAppPreference && (
                          <p className={styles.whatsappPreferenceHint}>Guardando cambio...</p>
                        )}
                        {whatsappPreferenceError && (
                          <p className={styles.customFieldError}>{whatsappPreferenceError}</p>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Etiquetas: la interna (según actividad) + las del usuario como chips */}
                  <div className={styles.detailSection}>
                    <TagPicker
                      multiple
                      selectedIds={selectedContact.tags || []}
                      onChange={updateContactTags}
                      lockedTags={(() => {
                        const badge = resolveContactBadge(selectedContact)
                        return badge ? [{ id: 'system', name: badge.text }] : []
                      })()}
                      allowCreate
                      disabled={savingTags || !onUpdateTags}
                      placeholder="Agregar etiqueta"
                      aria-label="Agregar etiqueta al contacto"
                      triggerVariant="chip"
                      chipTriggerPlacement="header"
                      headerLabel="Etiquetas"
                      headerClassName={styles.contactTagHeader}
                      headerLabelClassName={styles.contactTagTitle}
                      closeOnSelect
                      portal
                      className={styles.contactTagPicker}
                    />
                    {savingTags && <p className={styles.whatsappPreferenceHint}>Guardando etiquetas...</p>}
                    {tagsError && <p className={styles.customFieldError}>{tagsError}</p>}
                  </div>

                <div className={styles.detailSection}>
                  <ContactCustomFieldsPanel
                    contactId={selectedContact.id}
                    customFields={selectedContact.customFields || []}
                    onUpdateCustomFields={onUpdateCustomFields}
                    onCustomFieldsChange={(customFields) => {
                      setSelectedContact(prev => prev?.id === selectedContact.id ? { ...prev, customFields } : prev)
                    }}
                    collapsible
                    defaultExpanded={false}
                    compact
                  />
                </div>

                {hasAutomationsAccess && (
                  <div className={styles.detailSection}>
                  <button
                    type="button"
                    className={styles.customFieldsToggle}
                    onClick={() => setAutomationsExpanded(prev => !prev)}
                    aria-expanded={automationsExpanded}
                    data-ristak-unstyled
                  >
                    <span className={styles.customFieldsToggleLabel}>
                      <Icon name={automationsExpanded ? 'chevron-down' : 'chevron-right'} size={14} />
                      Automatizaciones
                    </span>
                    <span className={styles.customFieldsToggleMeta}>
                      {automationActivityCount}
                    </span>
                  </button>

                  {automationsExpanded && (
                    <div className={styles.automationsPanel}>
                      <div className={styles.automationEnrollBox}>
                        <label className={styles.automationEnrollLabel} htmlFor={`automation-search-${selectedContact.id}`}>
                          Meter este contacto a una automatización
                        </label>
                        <div className={styles.automationSearchWrapper}>
                          <Icon name="search" size={15} className={styles.automationSearchIcon} />
                          <input
                            id={`automation-search-${selectedContact.id}`}
                            type="text"
                            value={automationQuery}
                            onChange={(event) => {
                              setAutomationQuery(event.target.value)
                              setAutomationNotice(null)
                            }}
                            placeholder="Escribe el nombre de la automatización..."
                            className={styles.automationSearchInput}
                          />
                        </div>

                        {(automationQuery.trim() || automationCatalogLoading) && (
                          <div className={styles.automationSearchResults}>
                            {automationCatalogLoading ? (
                              <div className={styles.automationResultState} role="status" aria-live="polite" aria-label="Cargando automatizaciones">
                                <Icon name="refresh" size={15} className={styles.spinIcon} />
                              </div>
                            ) : automationSearchResults.length === 0 ? (
                              <div className={styles.automationResultState}>
                                No encontré una automatización publicada con ese nombre.
                              </div>
                            ) : (
                              automationSearchResults.map(automation => (
                                <button
                                  key={automation.id}
                                  type="button"
                                  className={styles.automationResultButton}
                                  onClick={() => openEnrollmentModal(automation)}
                                >
                                  <span>{automation.name}</span>
                                  <Icon name="arrow-right" size={14} />
                                </button>
                              ))
                            )}
                          </div>
                        )}

                        {automationNotice && (
                          <p className={styles.automationNotice}>{automationNotice}</p>
                        )}
                        {automationError && (
                          <p className={styles.customFieldError}>{automationError}</p>
                        )}
                      </div>

                      <div className={styles.automationColumns}>
                        <div className={styles.automationColumn}>
                          <div className={styles.automationColumnHeader}>
                            <span>Activas</span>
                            <strong>{activeAutomationItems.length}</strong>
                          </div>
                          {renderAutomationActivityList(activeAutomationItems, 'Este contacto no está activo en ninguna automatización.')}
                        </div>

                        <div className={styles.automationColumn}>
                          <div className={styles.automationColumnHeader}>
                            <span>Pasadas</span>
                            <strong>{pastAutomationItems.length}</strong>
                          </div>
                          {renderAutomationActivityList(pastAutomationItems, 'Aún no hay automatizaciones pasadas.')}
                        </div>
                      </div>
                    </div>
                  )}
                  </div>
                )}

                {/* Primera Atribución (Primer Toque) */}
                {selectedContact.firstSession && (
                  <div className={`${styles.detailSection} ${styles.contactOriginSection}`}>
                    <h5 className={styles.detailSectionTitle}>
                      Primera Atribución (Primer Toque)
                    </h5>
                    <div className={styles.detailSectionContent}>
                      <div className={styles.detailItem}>
                        <Icon name="calendar" size={16} />
                        <div>
                          <span className={styles.detailItemLabel}>Primera visita:</span>
                          <span> {formatLocalDateTime(selectedContact.firstSession.started_at || selectedContact.created_at)}</span>
                        </div>
                      </div>

                      {(() => {
                        const source = normalizeTrafficSource({
                          site_source_name: selectedContact.firstSession.site_source_name,
                          source_platform: selectedContact.firstSession.source_platform,
                          utm_source: selectedContact.firstSession.utm_source,
                          referrer_url: selectedContact.firstSession.referrer_url
                        })
                        return source && source !== 'Desconocido' ? (
                          <div className={styles.detailItem}>
                            <Icon name="globe" size={16} />
                            <div>
                              <span className={styles.detailItemLabel}>Fuente:</span>
                              <span> {source}</span>
                            </div>
                          </div>
                        ) : null
                      })()}

                      {(selectedContact.firstSession.campaign_name || selectedContact.firstSession.utm_campaign) && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {selectedContact.firstSession.campaign_name || selectedContact.firstSession.utm_campaign}</span>
                          </div>
                        </div>
                      )}

                      {(selectedContact.firstSession.ad_name || selectedContact.firstSession.utm_content) && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {selectedContact.firstSession.ad_name || selectedContact.firstSession.utm_content}</span>
                          </div>
                        </div>
                      )}

                      {selectedContact.firstSession.device_type && (
                        <div className={styles.detailItem}>
                          <Icon name="smartphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Dispositivo:</span>
                            <span> {selectedContact.firstSession.device_type}{selectedContact.firstSession.browser && ` · ${selectedContact.firstSession.browser}`}</span>
                          </div>
                        </div>
                      )}

                      {(selectedContact.firstSession.geo_city || selectedContact.firstSession.geo_country) && (
                        <div className={styles.detailItem}>
                          <Icon name="map-pin" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Ubicación:</span>
                            <span> {[selectedContact.firstSession.geo_city, selectedContact.firstSession.geo_country].filter(Boolean).join(', ')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Atribución (solo si NO hay firstSession) */}
                {!selectedContact.firstSession && (selectedContact.source || resolvedAttribution.campaignName || resolvedAttribution.adsetName || resolvedAttribution.adName) && (
                  <div className={`${styles.detailSection} ${styles.contactOriginSection}`}>
                    <h5 className={styles.detailSectionTitle}>
                      De dónde llegó el contacto:
                    </h5>
                    <div className={styles.detailSectionContent}>
                      {selectedContact.source && (
                        <div className={styles.detailItem}>
                          <Icon name="globe" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Fuente:</span>
                            <span> {selectedContact.source}</span>
                          </div>
                        </div>
                      )}
                      {resolvedAttribution.campaignName && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {resolvedAttribution.campaignName}</span>
                          </div>
                        </div>
                      )}
                      {resolvedAttribution.adsetName && (
                        <div className={styles.detailItem}>
                          <Icon name="layers" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Conjunto de anuncios:</span>
                            <span> {resolvedAttribution.adsetName}</span>
                          </div>
                        </div>
                      )}
                      {resolvedAttribution.adName && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {resolvedAttribution.adName}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Información de Citas */}
                {(selectedContact.firstAppointmentDate || selectedContact.nextAppointmentDate) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>Información de Citas</h5>
                    <div className={styles.detailSectionContent}>
                      {selectedContact.firstAppointmentDate && (
                        <div className={styles.detailItem}>
                          <Icon name="calendar" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Primera cita:</span>
                            <span>{formatLocalDateTime(selectedContact.firstAppointmentDate)}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.nextAppointmentDate && (
                        <div className={styles.detailItem}>
                          <Icon name="clock" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Próxima cita:</span>
                            <span>{formatLocalDateTime(selectedContact.nextAppointmentDate)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Grid de 2 columnas: Citas y Pagos */}
                <div className={styles.twoColumnGrid}>
                  {/* COLUMNA IZQUIERDA: Citas */}
                  {appointmentsTotalCount > 0 && (
                    <div className={styles.detailSection}>
                      <button
                        type="button"
                        className={`${styles.summaryCardButton} ${appointmentsExpanded ? styles.summaryCardButtonOpen : ''}`}
                        onClick={() => setAppointmentsExpanded(prev => !prev)}
                        aria-expanded={appointmentsExpanded}
                        data-contact-summary-trigger="appointments"
                      >
                        <div className={styles.summaryCardContent}>
                          <div>
                            <h5 className={styles.summaryTitle}>Citas</h5>
                            <p className={styles.summaryCount}>
                              {appointmentsTotalCount}
                            </p>
                          </div>
                          <Icon
                            name={appointmentsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={20}
                            className={styles.summaryCardChevron}
                          />
                        </div>
                      </button>

                      {appointmentsExpanded && (
                        <ul className={styles.paymentList} data-contact-summary-list="appointments">
                          {(selectedContact.appointments || []).map(appointment => {
                            const statusInfo = getAppointmentStatusLabel(appointment.status)
                            const timeStr = new Date(appointment.start_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: timezone })

                            return (
                              <li key={appointment.id} className={styles.paymentItem}>
                                <div className={styles.paymentItemContent}>
                                  <div className={styles.paymentItemHeader}>
                                    <p className={styles.paymentAmount}>{appointment.title || 'Cita'}</p>
                                    <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                      {statusInfo.text}
                                    </Badge>
                                  </div>
                                  <div className={styles.paymentItemDetails}>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="calendar" size={12} />
                                      {formatLocalDateTime(appointment.start_time)}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="clock" size={12} />
                                      {timeStr}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="hash" size={12} />
                                      ID: {appointment.id.substring(0, 8)}...
                                    </span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                          {appointmentsLoading && (
                            <li className={styles.paymentItem}>
                              <span className={styles.paymentDetailItem}>
                                <Loader2 size={14} className={styles.spinIcon} aria-hidden="true" /> Cargando citas…
                              </span>
                            </li>
                          )}
                          {appointmentsError && !appointmentsLoading ? (
                            <li className={styles.paymentItem}>
                              <span className={styles.paymentDetailItem}>{appointmentsError}</span>
                            </li>
                          ) : null}
                          {appointmentsHasMore && appointmentsHydrated && !appointmentsLoading ? (
                            <li className={styles.paymentItem}>
                              <Button variant="secondary" size="sm" onClick={() => { void loadContactAppointments(selectedContact.id, true) }}>
                                Cargar más citas
                              </Button>
                            </li>
                          ) : null}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* COLUMNA DERECHA: Pagos */}
                      {(selectedContact.hasPaymentRecords || paymentsTotalCount > 0) && (
                    <div className={styles.detailSection}>
                      <button
                        type="button"
                        className={`${styles.summaryCardButton} ${paymentsExpanded ? styles.summaryCardButtonOpen : ''}`}
                        onClick={() => setPaymentsExpanded(prev => !prev)}
                        aria-expanded={paymentsExpanded}
                        data-contact-summary-trigger="payments"
                      >
                        <div className={styles.summaryCardContent}>
                          <div>
                            <h5 className={styles.summaryTitle}>Pagos</h5>
                            <p className={styles.summaryAmount}>{formatCurrency(selectedContact.ltv || payments.reduce((sum, payment) => sum + payment.amount, 0))}</p>
                          </div>
                          <Icon
                            name={paymentsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={20}
                            className={styles.summaryCardChevron}
                          />
                        </div>
                      </button>

                      {paymentsExpanded && (
                        <ul className={styles.paymentList} data-contact-summary-list="payments">
                          {payments.map(payment => {
                            const statusInfo = getStatusLabel(payment.status)
                            return (
                              <li key={payment.id} className={styles.paymentItem}>
                                <div className={styles.paymentItemContent}>
                                  <div className={styles.paymentItemHeader}>
                                    <p className={styles.paymentAmount}>{formatCurrency(payment.amount)}</p>
                                    {payment.status && statusInfo.text && (
                                      <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                        {statusInfo.text}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className={styles.paymentItemDetails}>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="calendar" size={12} />
                                      {formatLocalDateShort(payment.date)}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="hash" size={12} />
                                      ID: {payment.id.substring(0, 8)}...
                                    </span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                          {paymentsLoading ? (
                            <li className={styles.paymentItem}>
                              <span className={styles.paymentDetailItem}>
                                <Loader2 size={14} className={styles.spinIcon} aria-hidden="true" /> Cargando pagos…
                              </span>
                            </li>
                          ) : null}
                          {paymentsError && !paymentsLoading ? (
                            <li className={styles.paymentItem}>
                              <span className={styles.paymentDetailItem}>{paymentsError}</span>
                            </li>
                          ) : null}
                          {paymentsHasMore && paymentsHydrated && !paymentsLoading ? (
                            <li className={styles.paymentItem}>
                              <Button variant="secondary" size="sm" onClick={() => { void loadContactPayments(selectedContact.id, true) }}>
                                Cargar más pagos
                              </Button>
                            </li>
                          ) : null}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

                {agentCompletionEvents.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={`${styles.summaryCardButton} ${agentHistoryExpanded ? styles.summaryCardButtonOpen : ''}`}
                      onClick={() => setAgentHistoryExpanded(prev => !prev)}
                      aria-expanded={agentHistoryExpanded}
                      data-contact-summary-trigger="agent-history"
                    >
                      <div className={styles.summaryCardContent}>
                        <div>
                          <h5 className={styles.summaryTitle}>Historial del agente</h5>
                          <p className={styles.summaryCount}>{agentCompletionEvents.length}</p>
                        </div>
                        <Icon
                          name={agentHistoryExpanded ? 'chevron-down' : 'chevron-right'}
                          size={20}
                          className={styles.summaryCardChevron}
                        />
                      </div>
                    </button>

                    {agentHistoryExpanded && (
                      <ul className={styles.agentHistoryList} data-contact-summary-list="agent-history">
                        {agentCompletionEvents.map((completion) => (
                          <li key={completion.id} className={styles.agentHistoryItem}>
                            <span className={styles.agentHistoryIcon}>
                              {completion.icon}
                            </span>
                            <div>
                              <strong>{completion.title}</strong>
                              <p>{completion.actionSummary}</p>
                              <small>{formatLocalDateTime(completion.createdAt)}</small>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {/* Reembolsos */}
                {refunds.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={`${styles.summaryCardButton} ${refundsExpanded ? styles.summaryCardButtonOpen : ''}`}
                      onClick={() => setRefundsExpanded(prev => !prev)}
                      aria-expanded={refundsExpanded}
                      data-contact-summary-trigger="refunds"
                    >
                      <div className={styles.summaryCardContent}>
                        <div>
                          <h5 className={styles.summaryTitle}>Reembolsos</h5>
                          <p className={styles.summaryAmountNeutral}>
                            {formatCurrency(refunds.reduce((sum, refund) => sum + Math.abs(refund.amount), 0))}
                          </p>
                        </div>
                        <Icon
                          name={refundsExpanded ? 'chevron-down' : 'chevron-right'}
                          size={20}
                          className={styles.summaryCardChevron}
                        />
                      </div>
                    </button>

                    {refundsExpanded && (
                      <ul className={styles.paymentList} data-contact-summary-list="refunds">
                        {refunds.map(refund => {
                          const statusInfo = getStatusLabel(refund.status)
                          return (
                            <li key={refund.id} className={styles.paymentItem}>
                              <div>
                                <p className={styles.paymentAmount}>{formatCurrency(Math.abs(refund.amount))}</p>
                                {refund.status && statusInfo.text && (
                                  <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                    {statusInfo.text}
                                  </Badge>
                                )}
                              </div>
                              <span className={styles.paymentDate}>{formatLocalDateShort(refund.date)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* Viaje del contacto */}
                <div className={styles.detailSection}>
                  <ContactJourney contactId={selectedContact.id} layout="snake" />
                </div>
              </div>
              </div>
              {hasSingleResult ? renderContactChatPanel() : null}
            </>
          )}
        </div>

        {hasAutomationsAccess && selectedAutomationForEnrollment && (
          <Modal
            isOpen={enrollModalOpen}
            onClose={closeEnrollmentModal}
            title="Agregar a automatización"
            size="md"
          >
            <form
              className={styles.enrollModalBody}
              onSubmit={(event) => {
                event.preventDefault()
                void submitAutomationEnrollment()
              }}
            >
              <div className={styles.enrollModalIntro}>
                <p>
                  <strong>{selectedContact?.name || selectedContact?.phone || 'Este contacto'}</strong>
                  {' '}entrará a <strong>{selectedAutomationForEnrollment.name}</strong>.
                </p>
              </div>

              <div className={styles.enrollModeGrid} role="group" aria-label="Cuándo agregar el contacto">
                <button
                  type="button"
                  className={`${styles.enrollModeButton} ${enrollMode === 'now' ? styles.enrollModeButtonActive : ''}`}
                  onClick={() => setEnrollMode('now')}
                >
                  <Icon name="check" size={16} />
                  <span>En este momento</span>
                </button>
                <button
                  type="button"
                  className={`${styles.enrollModeButton} ${enrollMode === 'scheduled' ? styles.enrollModeButtonActive : ''}`}
                  onClick={() => setEnrollMode('scheduled')}
                >
                  <Icon name="calendar" size={16} />
                  <span>Programado</span>
                </button>
              </div>

              {enrollMode === 'scheduled' && (
                <label className={styles.enrollField}>
                  <span>Fecha y hora</span>
                  <input
                    type="datetime-local"
                    value={enrollScheduledAt}
                    min={automationInputMin}
                    onChange={(event) => {
                      setEnrollScheduledAt(event.target.value)
                      setEnrollError(null)
                    }}
                  />
                </label>
              )}

              {enrollError && (
                <p className={styles.customFieldError}>{enrollError}</p>
              )}

              <div className={styles.enrollModalActions}>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={closeEnrollmentModal}
                  disabled={enrollSubmitting}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  loading={enrollSubmitting}
                >
                  Agregar
                </Button>
              </div>
            </form>
          </Modal>
        )}
      </div>
    </Modal>
  )
}
