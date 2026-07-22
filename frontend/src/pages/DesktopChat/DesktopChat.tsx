import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Archive,
  Banknote,
  Bot,
  CalendarDays,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  CreditCard,
  ExternalLink,
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
  Send,
  ListFilter,
  Square,
  Tag,
  Trash2,
  User,
  Video,
  Workflow,
  X
} from 'lucide-react'
import { FaFacebook, FaFacebookMessenger, FaInstagram, FaWhatsapp } from 'react-icons/fa'
import { useAppConfig } from '@/hooks'
import {
  AppointmentModal,
  Button,
  ChatMessageSurface,
  ContactAvatar,
  ContentFocusModal,
  ContactCustomFieldsPanel,
  CustomSelect,
  ContactPhoneSelector,
  DatePicker,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmailRichTextEditor,
  EmailChatMessageBubble,
  Icon,
  InlineEditableText,
  Modal,
  RecordPaymentModal,
  SearchField,
  Switch,
  TagPicker,
  WhatsAppFormattedText,
  buildEmailChatMessageData,
  emailHtmlToPlainText,
  hasEmailChatMessageContent,
  plainTextToEmailHtml,
  sanitizeEmailRichHtmlForEditor,
  type EmailChatMessageData,
  type EmailRichTextVariable,
  type ContentFocusItem
} from '@/components/common'
import { ContactJourney } from '@/components/common/ContactJourney/ContactJourney'
import { AgentRobot } from '@/components/ai'
import { PhoneMessageChannelIcon } from '@/components/phone/PhoneMessageChannelIcon'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import {
  formatInTimezone,
  getStoredBusinessTimezone,
  localDateTimeInputToUTCISOString,
  toDateTimeLocalInputValue,
  todayDateOnlyInTimezone
} from '@/utils/timezone'
import { hasLicenseFeature } from '@/utils/accessControl'
import { optimizeChatImageFile } from '@/utils/chatMedia'
import {
  getChatSendResponseIds,
  reconcileServerMessageIntoOptimistic
} from '@/utils/chatMessageReconciliation'
import { isChatMessageSendInFlight } from '@/utils/chatMessageDeliveryState'
import { getChatBubbleColorChannel, resolveChatMessageChannel } from '@/utils/chatMessageChannel'
import {
  getHighLevelChatSendOutcome,
  getHighLevelRouteChangeMessage,
  getHighLevelWhatsAppRouteLabel,
  getLatestHighLevelWhatsAppInboundSender,
  resolveHighLevelChatFromNumber
} from '@/utils/highLevelChatSend'
import apiClient from '@/services/apiClient'
import { createAuthScopedLocalStorageNamespace } from '@/services/authScopedLocalStorage'
import automationsService, { type AutomationSummary } from '@/services/automationsService'
import { calendarsService, type Calendar, type CalendarEvent, type CreateAppointmentPayload } from '@/services/calendarsService'
import {
  conversationalAgentService,
  type ConversationAgentState,
  type ConversationStateAction,
  type ConversationalAgentCompletionEvent,
  type ConversationalAgentDef
} from '@/services/conversationalAgentService'
import {
  compareLosslessNumericCursorValues,
  compareLosslessTimestampCursorTuples,
  contactsService,
  getOldestJourneyMessageCursor,
  type JourneyEvent
} from '@/services/contactsService'
import { createDesktopChatConversationRequestCoordinator } from '@/services/desktopChatConversationRequest'
import { subscribeToChatLiveEvents, reportViewing, type ChatLiveEvent } from '@/services/chatLiveEventsService'
import { emailService } from '@/services/emailService'
import { highLevelService, type HighLevelChatChannel, type HighLevelPhoneNumber } from '@/services/highLevelService'
import { getIntegrationsStatus } from '@/services/integrationsService'
import {
  messageTemplatesService,
  type MessageTemplateCategory,
  type MessageTemplatePayload
} from '@/services/messageTemplatesService'
import {
  hasWhatsAppPhoneApiAvailable,
  isWhatsAppPhoneApiAvailable,
  whatsappApiService,
  type ScheduledChatMessage,
  type WhatsAppApiPhoneNumber,
  type WhatsAppApiStatus,
  type WhatsAppApiTemplate
} from '@/services/whatsappApiService'
import type { Contact, ContactAppointment, ContactCustomField, ContactPayment, ContactPhoneNumber } from '@/types'
import { formatChatDayLabel, formatChatListTimestamp, formatChatMessageTime, getChatTimestampDayKey, isChatTimestampToday } from '@/utils/chatTimestamps'
import { mergeContactCustomFields } from '@/utils/contactCustomFields'
import { getContactStageBadge } from '@/utils/contactStageBadge'
import { parseSortableDateValue } from '@/utils/dateSort'
import {
  getAssignedConversationAgentStates,
  getConversationAgentAssignmentStatus,
  type ConversationAgentAssignmentStatus
} from '@/utils/conversationAgentAssignment'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower, formatCrmLabelWithDefiniteArticle } from '@/utils/crmLabels'
import {
  buildChatActivityMarkers,
  isChatActivityEvent,
  type ChatActivityMarker
} from '@/utils/chatActivityMarkers'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { useAccountCurrency } from '@/hooks/useAccountCurrency'
import { stripRistakAdIdMarkersFromText } from '@/utils/whatsappAttributionText'
import styles from './DesktopChat.module.css'

type ChatFilter = 'all' | 'agent' | 'unread' | 'appointments' | 'customers'
type AgentInboxStatusFilter = 'active' | 'completed' | 'paused' | 'skipped' | 'unassigned'
type AdvancedChannelFilter = 'all' | 'whatsapp' | 'messenger' | 'instagram' | 'webchat' | 'sms' | 'email'
type AdvancedSocialFilter = 'all' | 'facebook' | 'instagram' | 'messenger' | 'whatsapp' | 'google' | 'unknown'
type AdvancedOriginFilter = 'all' | 'meta' | 'site' | 'organic' | 'trigger' | 'unknown'
type AdvancedStageFilter = 'all' | 'lead' | 'appointment' | 'customer'
type AdvancedActivityFilter = 'all' | 'payments' | 'appointments' | 'with_source' | 'no_phone'
type ComposerStatus = 'idle' | 'sending'
type ChatAttachmentType = 'image' | 'audio' | 'video' | 'document' | 'file'
type DraftAttachmentKind = 'image' | 'video' | 'audio' | 'document'
type DraftAttachmentDeliveryMode = 'media' | 'document' | 'voice'
type InfoPanelView = 'summary' | 'journey'
type BulkChatConfirmAction = 'archive' | 'remove'
type BulkAgentSelectionAction = Extract<ConversationStateAction, 'activate' | 'pause' | 'take_over' | 'skip'>
type ContactChannelBadgeKind = 'whatsapp' | 'messenger' | 'instagram' | 'email' | 'sms' | 'webchat' | 'meta' | 'facebook_comment' | 'instagram_comment'
type SchedulePeriod = 'AM' | 'PM'
type TemplatePanelMode = 'choice' | 'select' | 'create'
type CommentComposerChannel = 'facebook_comment' | 'instagram_comment'
type ComposerChannel = 'whatsapp' | 'sms' | 'messenger' | 'instagram' | 'email' | CommentComposerChannel
type CommentReplyTarget = { messageId: string; commentId: string; platform: 'instagram' | 'messenger'; preview: string }
type ContactIdentityField = 'name' | 'email' | 'phone'
type ManualAgentInterruptionAction = 'pause' | 'skip'
type ManualAgentSendOptions = { skipAgentInterruptionConfirm?: boolean }
type DesktopMessageReactionChannel = 'whatsapp_api' | 'whatsapp_qr' | 'messenger' | 'instagram'
type AgentAvatarBadgeState = ConversationAgentAssignmentStatus | 'attention'

const RISTAK_AD_ID_PATTERN = /\brstkad_id\s*=\s*(\d+)!/i

type ChatLocation = {
  latitude: number
  longitude: number
  name?: string
  address?: string
  url?: string
}

interface MessageAdPreview {
  platform?: string
  title: string
  body?: string
  sourceUrl?: string
  previewUrl?: string
  adAccountId?: string
  imageUrl?: string
  videoUrl?: string
  campaignName?: string
  adsetName?: string
  adName?: string
  sourceId?: string
  sourceType?: string
}

interface ManualAgentSendPrompt {
  contactId: string
  textOverride?: string
}

interface MessageReactionMenuState {
  messageId: string
  x: number
  y: number
  pickerOpen?: boolean
}

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
  lastMessageCursorSort?: string
  lastMessageCursorScope?: string
  lastMessageDirection?: string
  lastBusinessPhone?: string
  lastBusinessPhoneNumberId?: string
  lastInboundBusinessPhone?: string
  lastInboundBusinessPhoneNumberId?: string
  firstInboundBusinessPhone?: string
  firstInboundBusinessPhoneNumberId?: string
  messageCount?: number
  unreadCount?: number
  profilePhotoUrl?: string | null
  avatarUrl?: string | null
  photoUrl?: string | null
  pictureUrl?: string | null
  profile_picture_url?: string | null
  hasMetaMessengerProfile?: boolean
  hasMetaInstagramProfile?: boolean
}

interface ChatListKeysetCursor {
  beforeMessageDate: string
  beforeMessageSort?: string
  beforeMessageScope?: string
  beforeContactId: string
  scope: string
}

interface RemovedChatState {
  contactId: string
  lastMessageDate: string
  messageCount: number
  removedAt: string
}

interface ChatListCacheSnapshot {
  chats: DesktopChatContact[]
  isFresh: boolean
}

interface DesktopChatMessage {
  id: string
  optimisticId?: string
  serverMessageId?: string
  providerMessageId?: string
  text: string
  subject?: string
  date: string
  direction: 'inbound' | 'outbound' | 'system'
  status?: string
  errorReason?: string
  scheduledAt?: string
  scheduledMessageId?: string
  messageType?: string
  sentAt?: string
  deliveredAt?: string
  readAt?: string
  businessPhone?: string
  businessPhoneNumberId?: string
  transport?: string
  provider?: string
  channel?: string
  routingReason?: string
  sentByAgent?: boolean
  agentId?: string
  replyToMessageId?: string
  replyToProviderMessageId?: string
  reactionEmoji?: string
  reactionTargetMessageId?: string
  reactionTargetProviderMessageId?: string
  reactions?: Array<{
    id: string
    emoji: string
    direction: 'inbound' | 'outbound' | 'system'
  }>
  // Comentarios de FB/IG: globo distinto + contexto de la publicación comentada.
  isComment?: boolean
  commentReplyMode?: 'public' | 'private'
  commentId?: string
  commentPlatform?: 'instagram' | 'messenger'
  commentPost?: {
    message?: string
    imageUrl?: string
    permalink?: string
    deleted?: boolean
  }
  email?: EmailChatMessageData
  attachment?: {
    type: ChatAttachmentType
    url?: string
    dataUrl?: string
    name?: string
    mimeType?: string
    durationMs?: number
    isGif?: boolean
  }
  location?: ChatLocation
  adPreview?: MessageAdPreview
}

interface ConversationCacheSnapshot {
  journey: JourneyEvent[]
  messages: DesktopChatMessage[]
  agentCompletions: ConversationalAgentCompletionEvent[]
  contactInfo: Contact | null
  agentState: ConversationAgentState | null
}

// Perfil social del contacto + contacto ENLAZADO (misma persona en el mismo
// canal, viviendo como registro separado: DM ↔ comentario).
interface LinkedSocialProfile {
  platform: string
  platformLabel: string
  kind: 'dm' | 'comment'
  name: string | null
  username: string | null
  photo: string | null
  metaUserId: string | null
}

interface LinkedSocialContact {
  contactId: string
  platform: string
  platformLabel: string
  kind: 'dm' | 'comment'
  name: string | null
  username: string | null
  photo: string | null
}

type DesktopConversationTimelineItem =
  | { type: 'message'; id: string; date: string; message: DesktopChatMessage }
  | { type: 'activity'; id: string; date: string; marker: ChatActivityMarker }
  | { type: 'agentCompletion'; id: string; date: string; completion: ConversationalAgentCompletionEvent }

interface DesktopDraftAttachment {
  id: string
  kind: DraftAttachmentKind
  deliveryMode: DraftAttachmentDeliveryMode
  name: string
  mimeType: string
  dataUrl: string
  size: number
}

interface MediaDeliveryPromptState {
  kind: 'video' | 'audio'
  name: string
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
  currency?: string | null
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

const BASE_CHAT_FILTERS: Array<{ id: Exclude<ChatFilter, 'customers'>; label: string }> = [
  { id: 'all', label: 'Todos' },
  { id: 'unread', label: 'No leídos' },
  { id: 'appointments', label: 'Con cita' }
]

const DEFAULT_AGENT_INBOX_STATUS_FILTER: AgentInboxStatusFilter = 'active'
const AGENT_INBOX_STATUS_FILTERS: Array<{ id: AgentInboxStatusFilter; label: string }> = [
  { id: 'active', label: 'Activos' },
  { id: 'completed', label: 'Meta cumplida' },
  { id: 'paused', label: 'Pausados 24 horas' },
  { id: 'skipped', label: 'Omitidos' },
  { id: 'unassigned', label: 'No asignados' }
]

const CHAT_REQUEST_TIMEOUT_MS = 20000
const CHAT_ARCHIVED_STATE_KEY = 'ristak_phone_chat_archived_state_v1'
const CHAT_REMOVED_STATE_KEY = 'ristak_desktop_chat_removed_state_v1'
const CHAT_CACHE_KEY = 'ristak_desktop_chat_list_cache_v1'
const CHAT_CONVERSATION_CACHE_KEY_PREFIX = 'ristak_desktop_chat_conversation_cache_v1'
const CHAT_PERSISTENT_CACHE_PREFIXES = [
  CHAT_ARCHIVED_STATE_KEY,
  CHAT_REMOVED_STATE_KEY,
  CHAT_CACHE_KEY,
  CHAT_CONVERSATION_CACHE_KEY_PREFIX
] as const
const CHAT_CACHE_MAX_AGE_MS = 30 * 60 * 1000
const CHAT_CACHE_STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CHAT_CACHE_ENTRY_LIMIT = 400
const CHAT_CONVERSATION_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const CHAT_CONVERSATION_CACHE_MAX_ENTRY_CHARS = 360_000
const CHAT_CONVERSATION_MESSAGE_LIMIT = 50
const CHAT_FALLBACK_REFRESH_INTERVAL_MS = 30_000
const CHAT_HEALTHY_RECONCILE_INTERVAL_MS = 2 * 60_000
const CHAT_LIVE_REFRESH_DEBOUNCE_MS = 80
const CHAT_ACTIVITY_REFRESH_INTERVAL_MS = 30_000
const MESSAGE_REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '🙏']
const MESSAGE_REACTION_PICKER_EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '🥹', '😂', '🤣',
  '🙂', '😉', '😊', '😍', '😘', '😎', '🤩', '🥳',
  '😌', '😔', '😅', '😮‍💨', '🤔', '🙌', '👏', '🙏',
  '👍', '👀', '🔥', '✨', '💯', '❤️', '💚', '💬',
  '📸', '🎥', '📍', '📅', '⏰', '✅', '💵', '🚀'
]
const META_MESSAGE_REACTION_EMOJIS = ['❤️']
// Lotes moderados: la bandeja calcula stats de mensajes y debe pintar rápido sin ahogar Postgres.
const CHAT_LIST_PAGE_SIZE = 50
// Distancia mínima al fondo para empezar a prefetch del siguiente lote. El disparo real
// usa varias pantallas (ver loadMoreChatsIfNeeded) para que el lote llegue ANTES de tocar
// el fondo y nunca se sienta "trabado".
const CHAT_LIST_AUTO_LOAD_GAP_PX = 900
const CHAT_LIST_PREFETCH_VIEWPORTS = 3
const MESSAGE_PANE_BOTTOM_LOCK_GAP_PX = 120
const CHAT_CONVERSATION_TOP_LOAD_GAP_PX = 96
const BULK_CHAT_ARCHIVE_CONFIRM_WORD = 'ARCHIVAR'
const BULK_CHAT_RESTORE_CONFIRM_WORD = 'RESTAURAR'
const BULK_CHAT_REMOVE_CONFIRM_WORD = 'ELIMINAR'
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_MESSAGE_BYTES = 16 * 1024 * 1024
const MAX_DOCUMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024
const MAX_VIDEO_ATTACHMENT_BYTES = 25 * 1024 * 1024
const MAX_DRAFT_ATTACHMENTS = 4
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
  '.aac',
  '.amr',
  '.m4a',
  '.mp3',
  '.oga',
  '.ogg',
  '.opus',
  '.wav',
  '.webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'audio/*'
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
const VIDEO_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  qt: 'video/quicktime',
  webm: 'video/webm',
  '3gp': 'video/3gpp',
  '3gpp': 'video/3gpp'
}
const AUDIO_MIME_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  amr: 'audio/amr',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  webm: 'audio/webm'
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

const BASE_STAGE_FILTER_OPTIONS = [
  { value: 'all', label: 'Todas las etapas' },
  { value: 'appointment', label: 'Con cita' }
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
const OPTIMISTIC_MESSAGE_ID_PREFIXES = ['desktop-chat-', 'desktop-email-', 'desktop-template-']
const OPTIMISTIC_MESSAGE_MAX_AGE_MS = 10 * 60 * 1000
const TEMPLATE_DISABLED_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED', 'ARCHIVED', 'DELETED', 'PENDING', 'IN_APPEAL'])
const HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID = '__highlevel_whatsapp__'
const HIGHLEVEL_WHATSAPP_COMPOSER_VALUE = 'whatsapp:highlevel'
const HIGHLEVEL_SMS_COMPOSER_VALUE_PREFIX = 'sms:highlevel:'
const SUCCESS_PAYMENT_STATUSES = new Set(['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'])
const CANCELED_APPOINTMENT_STATUSES = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'invalid', 'failed', 'missed', 'deleted', 'void', 'voided'])
const COMPOSER_CHANNEL_OPTIONS: Array<{ value: ComposerChannel; label: string }> = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS · HighLevel' },
  { value: 'messenger', label: 'Messenger' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'email', label: 'Correo' }
]

const DESKTOP_EMAIL_VARIABLES: EmailRichTextVariable[] = [
  { value: 'contact.name', label: 'Nombre del contacto' },
  { value: 'contact.email', label: 'Correo del contacto' },
  { value: 'contact.phone', label: 'Telefono del contacto' },
  { value: 'business.name', label: 'Nombre del negocio' }
]

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
  paused: 'Agente pausado por 24hrs en este chat',
  human: 'Conversación tomada por humano',
  skipped: 'Agente omitido en este chat',
  completed: 'Objetivo completado por el agente',
  discarded: 'Conversación descartada'
}

function getConversationAgentObjectiveLabel(objective: ConversationalAgentDef['objective']) {
  if (objective === 'ventas') return 'Ventas'
  if (objective === 'datos') return 'Datos'
  if (objective === 'filtrar') return 'Filtrar'
  if (objective === 'custom') return 'Personalizado'
  return 'Citas y seguimiento'
}

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

function getTemplateBlockedReason(template: WhatsAppApiTemplate) {
  const status = getTemplateStatus(template)
  if (status === 'APPROVED') return ''
  return template.reason || `${getTemplateStatusLabel(status)}. Solo se pueden enviar plantillas aprobadas.`
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
    variableBindings: { headerText: {}, bodyText: {} }
  }
}

function getContactName(contact?: Partial<Contact> | null) {
  return contact?.name || contact?.email || contact?.phone || 'Contacto sin nombre'
}

function getContactDetail(contact?: Partial<Contact> | null) {
  // Teléfono si hay; si no, el @usuario de la red social; si no, correo; y
  // como último recurso, un estado genérico.
  if (contact?.phone) return contact.phone
  const username = String(contact?.socialUsername || '').trim().replace(/^@+/, '')
  if (username) return `@${username}`
  return contact?.email || 'Sin datos de contacto'
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

function getVideoMimeType(file: File) {
  const fileType = String(file.type || '').trim().toLowerCase()
  const extension = getFileExtension(file.name)
  if (VIDEO_MIME_BY_EXTENSION[extension]) return VIDEO_MIME_BY_EXTENSION[extension]
  return fileType.startsWith('video/') ? fileType : ''
}

function getAudioMimeType(file: File) {
  const fileType = String(file.type || '').trim().toLowerCase()
  const extension = getFileExtension(file.name)
  if (AUDIO_MIME_BY_EXTENSION[extension]) return AUDIO_MIME_BY_EXTENSION[extension]
  return fileType.startsWith('audio/') ? fileType : ''
}

function isSupportedVideoFile(file: File) {
  const mimeType = getVideoMimeType(file)
  return Boolean(VIDEO_MIME_BY_EXTENSION[getFileExtension(file.name)] || Object.values(VIDEO_MIME_BY_EXTENSION).includes(mimeType))
}

function isSupportedAudioFile(file: File) {
  const mimeType = getAudioMimeType(file)
  return Boolean(AUDIO_MIME_BY_EXTENSION[getFileExtension(file.name)] || Object.values(AUDIO_MIME_BY_EXTENSION).includes(mimeType))
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

function readFileAsDataUrl(file: File, mimeType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? normalizeDataUrlMimeType(reader.result, mimeType) : ''
      if (!dataUrl) {
        reject(new Error('No se pudo leer el archivo.'))
        return
      }
      resolve(dataUrl)
    }
    reader.onerror = () => reject(reader.error || new Error('No se pudo leer el archivo.'))
    reader.readAsDataURL(file)
  })
}

function getDraftAttachmentMessageType(attachment: DesktopDraftAttachment): ChatAttachmentType {
  if (attachment.deliveryMode === 'document') return 'document'
  if (attachment.kind === 'image') return 'image'
  if (attachment.kind === 'video') return 'video'
  if (attachment.kind === 'audio') return 'audio'
  return 'document'
}

function getNativeMetaAudioDurationMs(audio: DesktopDraftAttachment | VoiceDraftAttachment | null | undefined) {
  if (!audio || !('durationMs' in audio)) return undefined
  return Number(audio.durationMs || 0) || undefined
}

function getDraftAttachmentLabel(attachment: DesktopDraftAttachment) {
  if (attachment.deliveryMode === 'document') return 'Archivo'
  if (attachment.kind === 'image') return 'Foto'
  if (attachment.kind === 'video') return 'Video'
  if (attachment.kind === 'audio') return attachment.deliveryMode === 'voice' ? 'Nota de voz' : 'Audio'
  return 'Documento'
}

function getAttachmentPreviewText(attachments: DesktopDraftAttachment[], fallbackText = '') {
  if (!attachments.length) return fallbackText
  const hasFile = attachments.some((attachment) => attachment.deliveryMode === 'document' || attachment.kind === 'document')
  const hasVideo = attachments.some((attachment) => attachment.kind === 'video' && attachment.deliveryMode !== 'document')
  const hasAudio = attachments.some((attachment) => attachment.kind === 'audio' && attachment.deliveryMode !== 'document')
  if (attachments.length > 1) return hasFile ? 'Archivos' : hasVideo ? 'Fotos y videos' : hasAudio ? 'Audios' : 'Fotos'
  return getDraftAttachmentLabel(attachments[0])
}

function formatAttachmentSize(size?: number) {
  const value = Number(size || 0)
  if (!Number.isFinite(value) || value <= 0) return 'Archivo'
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} KB`
  return `${value} B`
}

function formatCurrencyNoDecimals(value: number, currency: string) {
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

// Un chat es "comentario" cuando su último mensaje es de tipo comment (llega de
// feed de Facebook o del objeto de comentarios de Instagram). Los comentarios NO
// se mezclan con los DMs: viven en su propia vista de filtro.
function isCommentContact(contact?: DesktopChatContact | Contact | null): boolean {
  // Misma persona = UN contacto por red; la distinción vive a nivel mensaje. Un
  // contacto es "de comentario" (va al tab Comentarios) cuando SOLO ha comentado
  // y aún NO tiene chat privado: hasCommentMessage && !hasPrivateDm. En cuanto
  // llega un DM (hasPrivateDm) pasa solo a los tabs normales, con sus comentarios
  // fusionados dentro. Fallback por último mensaje para filas optimistas/inyectadas
  // que aún no traen los flags.
  const record = contact as unknown as Record<string, unknown>
  if (record?.hasCommentMessage !== undefined) {
    return Boolean(record.hasCommentMessage) && !record.hasPrivateDm
  }
  return String(record?.lastMessageType || '').toLowerCase().startsWith('comment')
}

// LENTE de Comentarios: cualquier contacto que haya comentado, AUNQUE también
// tenga chat privado. Al abrirlo bajo esta lente se ven solo sus comentarios.
function contactHasCommentActivity(contact?: DesktopChatContact | Contact | null): boolean {
  const record = contact as unknown as Record<string, unknown>
  if (record?.hasCommentMessage !== undefined) return Boolean(record.hasCommentMessage)
  return String(record?.lastMessageType || '').toLowerCase().startsWith('comment')
}

function getCommentPlatform(contact?: DesktopChatContact | Contact | null): 'facebook' | 'instagram' {
  const record = contact as unknown as Record<string, unknown>
  const channel = String(record?.lastMessageChannel || '').toLowerCase()
  return channel.includes('instagram') ? 'instagram' : 'facebook'
}

function isCommentComposerChannel(channel: ComposerChannel): channel is CommentComposerChannel {
  return channel === 'facebook_comment' || channel === 'instagram_comment'
}

function getCommentComposerPlatform(channel: CommentComposerChannel): 'messenger' | 'instagram' {
  return channel === 'instagram_comment' ? 'instagram' : 'messenger'
}

function getCommentComposerChannelForPlatform(platform: 'messenger' | 'instagram'): CommentComposerChannel {
  return platform === 'instagram' ? 'instagram_comment' : 'facebook_comment'
}

function getCommentComposerLabel(platform: 'messenger' | 'instagram') {
  return platform === 'instagram' ? 'Comentario de Instagram' : 'Comentario de Facebook'
}

function canStartCommentPublicReply(message: DesktopChatMessage) {
  return Boolean(
    message.isComment &&
    message.direction === 'inbound' &&
    !message.commentReplyMode &&
    message.commentId
  )
}

function buildCommentReplyTarget(message: DesktopChatMessage): CommentReplyTarget | null {
  if (!canStartCommentPublicReply(message) || !message.commentId) return null

  return {
    messageId: message.id,
    commentId: message.commentId,
    platform: message.commentPlatform || 'messenger',
    preview: String(message.text || '').replace(/\s+/g, ' ').trim().slice(0, 60)
  }
}

function getLatestEligibleCommentReplyTarget(messages: DesktopChatMessage[]): CommentReplyTarget | null {
  const latestComment = [...messages]
    .filter(canStartCommentPublicReply)
    .sort((left, right) => getMessageTimeValue(right.date) - getMessageTimeValue(left.date))[0]
  if (!latestComment) return null

  const latestCommentTime = getMessageTimeValue(latestComment.date)
  const hasLaterInboundPrivateMessage = messages.some((message) => (
    message.direction === 'inbound' &&
    !message.isComment &&
    getMessageTimeValue(message.date) > latestCommentTime
  ))
  if (hasLaterInboundPrivateMessage) return null

  return buildCommentReplyTarget(latestComment)
}

function getContactChannelBadge(contact?: DesktopChatContact | Contact | null): ContactChannelBadge | null {
  if (!contact) return null

  if (isCommentContact(contact)) {
    return getCommentPlatform(contact) === 'instagram'
      ? { kind: 'instagram_comment', label: 'Comentario de Instagram' }
      : { kind: 'facebook_comment', label: 'Comentario de Facebook' }
  }

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
  if (kind === 'facebook_comment') return styles.avatarChannelBadgeFacebookComment
  if (kind === 'instagram_comment') return styles.avatarChannelBadgeInstagramComment
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
    if (!state?.contactId) return
    const current = next[state.contactId]
    next[state.contactId] = selectPrimaryAgentState([current, state].filter(Boolean) as ConversationAgentState[]) || state
  })
  return next
}

function selectPrimaryAgentState(states: ConversationAgentState[] = []) {
  return [...states].filter(Boolean).sort((left, right) => {
    const priority = (state: ConversationAgentState) => {
      if (state.status === 'active' && state.agentId && !state.signal) return 0
      if (state.signal) return 1
      if (state.agentId) return 2
      return 3
    }
    const priorityDiff = priority(left) - priority(right)
    if (priorityDiff !== 0) return priorityDiff
    return parseSortableDateValue(right.updatedAt || right.activatedAt || right.signalAt) - parseSortableDateValue(left.updatedAt || left.activatedAt || left.signalAt)
  })[0] || null
}

function mapAgentStateListsByContactId(states: ConversationAgentState[] = []) {
  const next: Record<string, ConversationAgentState[]> = {}
  states.forEach((state) => {
    if (!state?.contactId) return
    next[state.contactId] = [...(next[state.contactId] || []), state]
  })
  return next
}

function upsertAgentStateList(current: ConversationAgentState[] = [], state: ConversationAgentState) {
  const sameState = (item: ConversationAgentState) => (
    item.id && state.id
      ? item.id === state.id
      : item.contactId === state.contactId && (item.agentId || '') === (state.agentId || '')
  )
  return [state, ...current.filter((item) => !sameState(item))]
}

function hasAgentInboxHistory(state: ConversationAgentState | null | undefined) {
  if (!state) return false
  if (state.activatedAt || state.activationSource || state.agentId || state.signal) return true
  if (state.lastReplyAt || state.lastAnsweredInboundMessageId) return true
  return state.status === 'paused' ||
    state.status === 'skipped' ||
    state.status === 'human' ||
    state.status === 'completed' ||
    state.status === 'discarded'
}

function isAgentInboxStateVisible(state: ConversationAgentState | null | undefined, filter: AgentInboxStatusFilter) {
  const hasHistory = hasAgentInboxHistory(state)
  if (filter === 'unassigned') return !hasHistory
  if (!state || !hasHistory) return false
  if (filter === 'skipped') {
    return state.status === 'skipped' || state.status === 'human' || state.status === 'discarded' || state.signal === 'discarded'
  }
  return state.status === filter
}

function getAgentInboxStatusLabel(state: ConversationAgentState | null | undefined) {
  if (state?.status === 'paused') return 'Pausado 24 horas'
  if (state?.status === 'skipped' || state?.status === 'human' || state?.status === 'discarded' || state?.signal === 'discarded') return 'Omitido'
  if (state?.status === 'completed') return 'Meta cumplida'
  if (state?.status === 'active') return 'Activo'
  return ''
}

function createAgentInboxContactFromState(state: ConversationAgentState): DesktopChatContact {
  const fallbackDate = state.updatedAt || state.activatedAt || state.signalAt || new Date().toISOString()
  const name = state.contactName || state.contactPhone || 'Contacto sin nombre'
  return {
    id: state.contactId,
    createdAt: fallbackDate,
    name,
    phone: state.contactPhone || '',
    email: '',
    ltv: 0,
    status: 'lead',
    purchases: 0,
    lastMessageText: state.signalSummary || '',
    lastMessageDate: fallbackDate,
    lastMessageDirection: 'system',
    messageCount: 0,
    unreadCount: 0
  }
}

const desktopChatStorage = createAuthScopedLocalStorageNamespace(CHAT_PERSISTENT_CACHE_PREFIXES)

function getScopedChatStorageKey(prefix: string) {
  return desktopChatStorage.getKey(prefix)
}

function readStoredChatIds(key: string) {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(getScopedChatStorageKey(key)) || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  } catch {
    return []
  }
}

function writeStoredChatIds(key: string, ids: string[]) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(getScopedChatStorageKey(key), JSON.stringify(Array.from(new Set(ids))))
  } catch {
    // Cache best-effort.
  }
}

function readStoredRemovedChatStates(): RemovedChatState[] {
  if (typeof window === 'undefined') return []

  try {
    const parsed = JSON.parse(window.localStorage.getItem(getScopedChatStorageKey(CHAT_REMOVED_STATE_KEY)) || '[]')
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
  try {
    window.localStorage.setItem(
      getScopedChatStorageKey(CHAT_REMOVED_STATE_KEY),
      JSON.stringify(states.slice(0, 200))
    )
  } catch {
    // Cache best-effort.
  }
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

function readCachedChatList(): ChatListCacheSnapshot {
  if (typeof window === 'undefined') return { chats: [], isFresh: false }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(getScopedChatStorageKey(CHAT_CACHE_KEY)) || 'null')
    if (!parsed || typeof parsed !== 'object') return { chats: [], isFresh: false }
    const cacheAgeMs = Date.now() - Number(parsed.storedAt || 0)
    if (cacheAgeMs > CHAT_CACHE_STALE_MAX_AGE_MS) return { chats: [], isFresh: false }
    if (!Array.isArray(parsed.chats)) return { chats: [], isFresh: false }

    const chats = parsed.chats
      .filter((contact: unknown): contact is DesktopChatContact => Boolean(
        contact &&
        typeof contact === 'object' &&
        typeof (contact as DesktopChatContact).id === 'string' &&
        (contact as DesktopChatContact).id.trim()
      ))
      .slice(0, CHAT_CACHE_ENTRY_LIMIT)

    return {
      chats,
      isFresh: cacheAgeMs <= CHAT_CACHE_MAX_AGE_MS
    }
  } catch {
    return { chats: [], isFresh: false }
  }
}

function writeCachedChatList(chats: DesktopChatContact[]) {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(getScopedChatStorageKey(CHAT_CACHE_KEY), JSON.stringify({
      storedAt: Date.now(),
      chats: chats.slice(0, CHAT_CACHE_ENTRY_LIMIT)
    }))
  } catch {
    // Cache best-effort: si el navegador no deja guardar, la red sigue siendo la fuente.
  }
}

function compactCompareValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value)
}

function dedupeChatsById<T extends { id?: string | null }>(chats: T[]) {
  const map = new Map<string, T>()
  chats.forEach((chat) => {
    const key = String(chat?.id || '').trim()
    if (!key) return
    if (!map.has(key)) map.set(key, chat)
  })
  return Array.from(map.values())
}

function getChatListKeysetCursor(chats: DesktopChatContact[], scope: string): ChatListKeysetCursor | null {
  const boundary = chats[chats.length - 1]
  const beforeMessageDate = String(boundary?.lastMessageDate || boundary?.createdAt || '').trim()
  const beforeMessageSort = String(boundary?.lastMessageCursorSort || '').trim()
  const beforeMessageScope = String(boundary?.lastMessageCursorScope || '').trim()
  const beforeContactId = String(boundary?.id || '').trim()
  return beforeMessageDate && beforeContactId
    ? {
      beforeMessageDate,
      beforeMessageSort: beforeMessageSort || undefined,
      beforeMessageScope: beforeMessageScope || undefined,
      beforeContactId,
      scope
    }
    : null
}

function didChatListCursorAdvance(previous: ChatListKeysetCursor, next: ChatListKeysetCursor | null) {
  return Boolean(
    next &&
    (
      next.beforeMessageSort !== previous.beforeMessageSort ||
      next.beforeMessageScope !== previous.beforeMessageScope ||
      next.beforeMessageDate !== previous.beforeMessageDate ||
      next.beforeContactId !== previous.beforeContactId
    )
  )
}

function compareChatListContactCursors(left: DesktopChatContact, right: DesktopChatContact) {
  const leftSort = String(left.lastMessageCursorSort || '').trim()
  const rightSort = String(right.lastMessageCursorSort || '').trim()
  if (leftSort && rightSort) {
    const sortDifference = compareLosslessNumericCursorValues(leftSort, rightSort)
    if (sortDifference !== null && sortDifference !== 0) return sortDifference
    if (sortDifference !== null) {
      return left.id === right.id ? 0 : left.id < right.id ? -1 : 1
    }
  }

  return compareLosslessTimestampCursorTuples(
    String(left.lastMessageDate || left.createdAt || ''),
    left.id,
    String(right.lastMessageDate || right.createdAt || ''),
    right.id
  )
}

// Reconcilia la cola cacheada contra la primera página fresca del servidor: descarta
// contactos que el servidor ya NO devuelve (fusionados/borrados/ocultos) SIN perder la
// cola real que el usuario reveló al hacer scroll. Regla: si la página fresca es
// incompleta (< pageSize) es la lista COMPLETA → no se conserva nada extra; si es una
// página llena, se conserva solo lo cacheado genuinamente más viejo que el borde de la
// página (lo que caería dentro de la página pero falta = borrado).
function reconcileCachedChatTail(freshPage: DesktopChatContact[], current: DesktopChatContact[], pageSize: number): DesktopChatContact[] {
  const freshIds = new Set(freshPage.map((contact) => contact.id))
  const notFresh = current.filter((contact) => !freshIds.has(contact.id))
  if (freshPage.length < pageSize) return []
  const boundary = freshPage[freshPage.length - 1]
  if (!boundary) return []
  return notFresh.filter((contact) => compareChatListContactCursors(contact, boundary) < 0)
}

function getDesktopMessageSignature(message: DesktopChatMessage) {
  const attachment = message.attachment
  return [
    message.id,
    message.optimisticId,
    message.serverMessageId,
    message.providerMessageId,
    message.text,
    message.subject,
    message.date,
    message.direction,
    message.status,
    message.errorReason,
    message.scheduledAt,
    message.scheduledMessageId,
    message.messageType,
    message.sentAt,
    message.deliveredAt,
    message.readAt,
    message.businessPhone,
    message.businessPhoneNumberId,
    message.transport,
    message.provider,
    message.routingReason,
    message.sentByAgent,
    message.agentId,
    message.adPreview?.platform,
    message.adPreview?.title,
    message.adPreview?.body,
    message.adPreview?.sourceUrl,
    message.adPreview?.previewUrl,
    message.adPreview?.adAccountId,
    message.adPreview?.imageUrl,
    message.adPreview?.videoUrl,
    message.adPreview?.campaignName,
    message.adPreview?.adsetName,
    message.adPreview?.adName,
    message.adPreview?.sourceId,
    message.adPreview?.sourceType,
    message.replyToMessageId,
    message.replyToProviderMessageId,
    message.reactionEmoji,
    message.reactionTargetMessageId,
    message.reactionTargetProviderMessageId,
    message.reactions?.map((reaction) => [reaction.id, reaction.emoji, reaction.direction].map(compactCompareValue).join(':')).join('|'),
    attachment?.type,
    attachment?.url,
    attachment?.dataUrl,
    attachment?.name,
    attachment?.mimeType,
    attachment?.durationMs,
    attachment?.isGif
  ].map(compactCompareValue).join('\u001f')
}

function areDesktopMessagesEquivalent(left: DesktopChatMessage[], right: DesktopChatMessage[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((message, index) => getDesktopMessageSignature(message) === getDesktopMessageSignature(right[index]))
}

function normalizeMessageMatchText(value?: string) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function getMessageTimeValue(value?: string) {
  return parseSortableDateValue(value)
}

function getMessageProviderMessageId(message: DesktopChatMessage) {
  return String(message.providerMessageId || '').trim()
}

function isOptimisticDesktopMessage(message: DesktopChatMessage) {
  if (message.optimisticId) return true
  return OPTIMISTIC_MESSAGE_ID_PREFIXES.some((prefix) => message.id.startsWith(prefix))
}

function isRecentOptimisticDesktopMessage(message: DesktopChatMessage) {
  if (!isOptimisticDesktopMessage(message)) return false
  // Una vez reconciliado con la fila persistida, esta identidad local vive
  // mientras el chat siga abierto. Caducarla remontaría el globo minutos después.
  if (message.serverMessageId) return true
  const timestamp = getMessageTimeValue(message.date)
  if (!timestamp) return true
  return Date.now() - timestamp < OPTIMISTIC_MESSAGE_MAX_AGE_MS
}

function getOptimisticMessageKey(message: DesktopChatMessage) {
  return message.optimisticId || message.id
}

function getMessageAttachmentMatchKey(message: DesktopChatMessage) {
  const attachment = message.attachment
  if (!attachment) return ''
  return [
    attachment.type,
    normalizeMessageMatchText(attachment.name),
    normalizeMessageMatchText(attachment.mimeType)
  ].join(':')
}

function messagesLookLikeSameOptimisticSend(loaded: DesktopChatMessage, optimistic: DesktopChatMessage) {
  const optimisticKey = getOptimisticMessageKey(optimistic)
  if (
    loaded.id === optimistic.id ||
    loaded.id === optimisticKey ||
    loaded.id === optimistic.serverMessageId ||
    loaded.optimisticId === optimisticKey ||
    Boolean(loaded.providerMessageId && loaded.providerMessageId === optimistic.providerMessageId)
  ) return true
  if (loaded.direction !== optimistic.direction || optimistic.direction !== 'outbound') return false

  const loadedTime = getMessageTimeValue(loaded.date)
  const optimisticTime = getMessageTimeValue(optimistic.date)
  if (loadedTime && optimisticTime && Math.abs(loadedTime - optimisticTime) > OPTIMISTIC_MESSAGE_MAX_AGE_MS) return false

  const loadedText = normalizeMessageMatchText(loaded.text)
  const optimisticText = normalizeMessageMatchText(optimistic.text)
  const sameText = Boolean(loadedText && optimisticText && loadedText === optimisticText)
  const sameSubject = normalizeMessageMatchText(loaded.subject) === normalizeMessageMatchText(optimistic.subject)
  const loadedAttachment = getMessageAttachmentMatchKey(loaded)
  const optimisticAttachment = getMessageAttachmentMatchKey(optimistic)
  const sameAttachment = Boolean(loadedAttachment && optimisticAttachment && loadedAttachment === optimisticAttachment)

  if ((sameText || sameAttachment) && sameSubject) {
    return !loadedTime || !optimisticTime || loadedTime >= optimisticTime - 5000
  }
  return optimistic.id.startsWith('desktop-template-') &&
    Boolean(loadedText || loaded.attachment) &&
    (!loadedTime || !optimisticTime || loadedTime >= optimisticTime - 5000)
}

function mergeDesktopMessagesWithOptimistic(loadedMessages: DesktopChatMessage[], currentMessages: DesktopChatMessage[]) {
  const merged = [...loadedMessages]
  const matchedLoadedIndexes = new Set<number>()

  currentMessages.forEach((message) => {
    if (!isRecentOptimisticDesktopMessage(message)) return

    const matchIndex = loadedMessages.findIndex((loaded, index) => (
      !matchedLoadedIndexes.has(index) && messagesLookLikeSameOptimisticSend(loaded, message)
    ))
    if (matchIndex >= 0) {
      matchedLoadedIndexes.add(matchIndex)
      merged[matchIndex] = reconcileServerMessageIntoOptimistic(loadedMessages[matchIndex], message)
      return
    }

    if (!merged.some((loaded) => loaded.id === message.id || loaded.id === getOptimisticMessageKey(message))) {
      merged.push(message)
    }
  })

  return merged.sort((left, right) => getMessageTimeValue(left.date) - getMessageTimeValue(right.date))
}

function mergeDesktopMessagesById(messages: DesktopChatMessage[]) {
  const merged = new Map<string, DesktopChatMessage>()

  messages.forEach((message) => {
    if (!message.id) return
    merged.set(message.id, message)
  })

  const mergedMessages = Array.from(merged.values())
  const byLocalId = new Map(mergedMessages.map((message) => [message.id, message]))
  const byProviderId = new Map(
    mergedMessages
      .map((message) => [getMessageProviderMessageId(message), message] as const)
      .filter(([providerMessageId]) => Boolean(providerMessageId))
  )
  const visibleMessages: DesktopChatMessage[] = []

  mergedMessages.forEach((message) => {
    if (String(message.messageType || '').toLowerCase() === 'reaction' && message.reactionEmoji) {
      const target = (message.reactionTargetMessageId ? byLocalId.get(message.reactionTargetMessageId) : null) ||
        (message.reactionTargetProviderMessageId ? byProviderId.get(message.reactionTargetProviderMessageId) : null)

      if (target) {
        const nextReactions = [
          ...(target.reactions || []).filter((reaction) => reaction.id !== message.id),
          { id: message.id, emoji: message.reactionEmoji, direction: message.direction }
        ]
        const updatedTarget = { ...target, reactions: nextReactions }
        byLocalId.set(updatedTarget.id, updatedTarget)
        const providerMessageId = getMessageProviderMessageId(updatedTarget)
        if (providerMessageId) byProviderId.set(providerMessageId, updatedTarget)
        return
      }
    }

    visibleMessages.push(message)
  })

  return visibleMessages
    .map((message) => byLocalId.get(message.id) || message)
    .sort((left, right) => getMessageTimeValue(left.date) - getMessageTimeValue(right.date))
}

function mergeDesktopConversationMessagesWithCurrent(
  loadedMessages: DesktopChatMessage[],
  currentMessages: DesktopChatMessage[]
) {
  const scheduledMessages = currentMessages.filter(isMessageScheduled)
  return mergeDesktopMessagesWithOptimistic(
    mergeDesktopMessagesById([...loadedMessages, ...scheduledMessages]),
    currentMessages
  )
}

function getJourneyEventSignature(event: JourneyEvent) {
  const data = event.data || {}
  return [
    event.type,
    event.date,
    data.whatsapp_api_message_id,
    data.whatsapp_message_id,
    data.meta_social_message_id,
    data.meta_message_id,
    data.provider_message_id,
    data.provider,
    data.message_provider,
    data.source_provider,
    data.email_message_id,
    data.smtp_message_id,
    data.appointment_id,
    data.id,
    data.message_text,
    data.messageText,
    data.message,
    data.body,
    data.text,
    data.message_body,
    data.messageBody,
    data.content,
    data.caption,
    data.message_type,
    data.reply_to_message_id,
    data.reply_to_provider_message_id,
    data.reaction_emoji,
    data.reaction_target_message_id,
    data.reaction_target_provider_message_id,
    data.direction,
    data.status,
    data.error_message,
    data.media_url,
    data.media_mime_type,
    data.media_filename,
    data.media_duration_ms,
    data.social_platform,
    data.transport,
    data.is_ad_attributed,
    data.ad_platform,
    data.referral_source_url,
    data.referral_source_type,
    data.referral_source_id,
    data.detected_source_url,
    data.detected_source_type,
    data.detected_source_id,
    data.referral_headline,
    data.referral_body,
    data.detected_headline,
    data.detected_body,
    data.referral_image_url,
    data.referral_video_url,
    data.referral_thumbnail_url,
    data.referral_ctwa_clid,
    data.detected_ctwa_clid,
    data.referral_source_app,
    data.detected_source_app,
    data.referral_entry_point,
    data.detected_entry_point,
    data.ad_id_thru_message,
    data.message_ad_id,
    data.ad_account_id,
    data.campaign_name,
    data.adset_name,
    data.attribution_ad_name,
    data.attribution_ad_id,
    data.creative_thumbnail_url,
    data.creative_image_url,
    data.creative_video_url,
    data.creative_preview_url,
    data.comment_id,
    data.post_message,
    data.post_image_url,
    data.post_permalink,
    data.post_type,
    data.post_deleted,
    data.subject,
    data.amount,
    data.title,
    data.start_time,
    data.end_time,
    data.source
  ].map(compactCompareValue).join('\u001f')
}

function areJourneyEventsEquivalent(left: JourneyEvent[], right: JourneyEvent[]) {
  if (left === right) return true
  if (left.length !== right.length) return false
  return left.every((event, index) => (
    getJourneyEventSignature(event) === getJourneyEventSignature(right[index]) &&
    compactCompareValue(event.cursorDate) === compactCompareValue(right[index]?.cursorDate) &&
    compactCompareValue(event.cursorKey) === compactCompareValue(right[index]?.cursorKey)
  ))
}

function isConversationJourneyMessage(event: JourneyEvent) {
  return event.type === 'whatsapp_message' ||
    event.type === 'meta_message' ||
    event.type === 'email_message' ||
    event.type === 'appointment_confirmation'
}

function mergeJourneyEvents(...eventGroups: JourneyEvent[][]) {
  const merged = new Map<string, JourneyEvent>()

  eventGroups.flat().forEach((event) => {
    const key = getJourneyEventSignature(event)
    if (!key) return
    const previous = merged.get(key)
    merged.set(key, previous
      ? {
        ...event,
        cursorDate: event.cursorDate || previous.cursorDate,
        cursorKey: event.cursorKey || previous.cursorKey
      }
      : event)
  })

  return Array.from(merged.values())
    .sort((left, right) => getMessageTimeValue(left.date) - getMessageTimeValue(right.date))
}

function getConversationCacheKey(locationId: string | null | undefined, contactId: string) {
  return [
    getScopedChatStorageKey(CHAT_CONVERSATION_CACHE_KEY_PREFIX),
    encodeURIComponent(locationId || 'default'),
    encodeURIComponent(contactId)
  ].join(':')
}

function normalizeCachedContact(value: unknown): Contact | null {
  if (!value || typeof value !== 'object') return null
  const contact = value as Contact
  return typeof contact.id === 'string' && contact.id.trim() ? contact : null
}

function readCachedConversation(locationId: string | null | undefined, contactId: string): ConversationCacheSnapshot | null {
  if (typeof window === 'undefined' || !contactId) return null

  const cacheKey = getConversationCacheKey(locationId, contactId)
  try {
    const parsed = JSON.parse(window.localStorage.getItem(cacheKey) || 'null')
    if (!parsed || typeof parsed !== 'object') return null
    const cacheAgeMs = Date.now() - Number(parsed.storedAt || 0)
    if (cacheAgeMs > CHAT_CONVERSATION_CACHE_MAX_AGE_MS) {
      window.localStorage.removeItem(cacheKey)
      return null
    }

    const journey = Array.isArray(parsed.journey) ? parsed.journey : []
    const messages = Array.isArray(parsed.messages) ? parsed.messages : []
    const agentCompletions = Array.isArray(parsed.agentCompletions) ? parsed.agentCompletions : []
    const contactInfo = parsed.contactInfo && typeof parsed.contactInfo === 'object' ? normalizeCachedContact(parsed.contactInfo) : null
    const agentState = parsed.agentState && typeof parsed.agentState === 'object' ? parsed.agentState as ConversationAgentState : null

    return { journey, messages, agentCompletions, contactInfo, agentState }
  } catch {
    window.localStorage.removeItem(cacheKey)
    return null
  }
}

function writeCachedConversation(
  locationId: string | null | undefined,
  contactId: string,
  snapshot: ConversationCacheSnapshot
) {
  if (typeof window === 'undefined' || !contactId) return

  const cacheKey = getConversationCacheKey(locationId, contactId)
  try {
    const payload = JSON.stringify({
      storedAt: Date.now(),
      journey: snapshot.journey,
      messages: snapshot.messages.slice(-320),
      agentCompletions: snapshot.agentCompletions.slice(0, 40),
      contactInfo: snapshot.contactInfo,
      agentState: snapshot.agentState
    })
    if (payload.length > CHAT_CONVERSATION_CACHE_MAX_ENTRY_CHARS) {
      window.localStorage.removeItem(cacheKey)
      return
    }
    window.localStorage.setItem(cacheKey, payload)
  } catch {
    window.localStorage.removeItem(cacheKey)
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
  return formatChatMessageTime(value)
}

function formatMessageDate(value?: string | null) {
  return formatChatDayLabel(value)
}

function padTwoDigits(value: number) {
  return String(value).padStart(2, '0')
}

function formatDateInputValue(date: Date) {
  return `${date.getFullYear()}-${padTwoDigits(date.getMonth() + 1)}-${padTwoDigits(date.getDate())}`
}

function createDefaultScheduleDraft(timezone?: string): ScheduleDraft {
  const date = timezone
    ? new Date(toDateTimeLocalInputValue(new Date(Date.now() + 15 * 60 * 1000), timezone))
    : new Date(Date.now() + 15 * 60 * 1000)
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

function createScheduleDraftFromDate(value?: string | null, timezone?: string): ScheduleDraft {
  const date = value
    ? new Date(timezone ? toDateTimeLocalInputValue(value, timezone) : value)
    : null
  if (!date || Number.isNaN(date.getTime())) return createDefaultScheduleDraft(timezone)

  const hour24 = date.getHours()
  const hour12 = hour24 % 12 || 12
  return {
    date: formatDateInputValue(date),
    hour: String(hour12),
    minute: padTwoDigits(date.getMinutes()),
    period: hour24 >= 12 ? 'PM' : 'AM'
  }
}

function getScheduleDateFromDraft(draft: ScheduleDraft, timezone?: string) {
  const [year, month, day] = draft.date.split('-').map(Number)
  const hour = Number(draft.hour)
  const minute = Number(draft.minute)

  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
  if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null

  const hour24 = draft.period === 'PM'
    ? (hour === 12 ? 12 : hour + 12)
    : (hour === 12 ? 0 : hour)
  const localInput = `${draft.date}T${padTwoDigits(hour24)}:${padTwoDigits(minute)}`
  const date = timezone
    ? new Date(localDateTimeInputToUTCISOString(localInput, timezone) || '')
    : new Date(year, month - 1, day, hour24, minute, 0, 0)
  return Number.isNaN(date.getTime()) ? null : date
}

function formatScheduledMessageLabel(value?: string | null) {
  if (!value) return 'Programado'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Programado'

  const time = formatMessageTime(value)
  if (isChatTimestampToday(value)) return `Programado ${time}`

  return `Programado ${formatMessageDate(value)} ${time}`.trim()
}

function formatSchedulePreviewLabel(value?: string | null) {
  if (!value) return 'Elige fecha y hora'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Elige fecha y hora'

  const time = formatMessageTime(value)
  if (isChatTimestampToday(value)) return `Se enviará a las ${time}`

  return `Se enviará el ${formatMessageDate(value)} a las ${time}`.trim()
}

function getConversationDayKey(value?: string | null, timeZone?: string) {
  return getChatTimestampDayKey(value, timeZone || getStoredBusinessTimezone())
}

function getConversationDayLabel(value?: string | null, timeZone?: string) {
  return formatChatDayLabel(value, timeZone || getStoredBusinessTimezone())
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

function extractRistakAdIdFromMessageText(value = '') {
  const match = String(value || '').match(RISTAK_AD_ID_PATTERN)
  return match?.[1]?.trim() || ''
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

function getReadableDataValue(value: unknown) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return ''
  const text = String(value).trim()
  if (!text) return ''
  return ['null', 'undefined', 'nan'].includes(text.toLowerCase()) ? '' : text
}

function pickReadableDataValue(data: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = getReadableDataValue(data[key])
    if (value) return value
  }
  return ''
}

function sourceTypeLooksLikeMessageAd(value = '') {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, '_')
  return ['ad', 'ads', 'advertisement', 'click_to_whatsapp', 'ctwa'].includes(normalized)
}

function getMessageAdPreviewPlatformLabel(data: Record<string, unknown>) {
  const platform = pickReadableDataValue(data, ['ad_platform', 'source_platform', 'social_platform', 'source', 'referral_source_app', 'detected_source_app', 'transport'])
  const normalized = platform.toLowerCase()
  if (normalized.includes('instagram')) return 'Instagram'
  if (normalized.includes('messenger') || normalized.includes('facebook')) return 'Messenger'
  if (normalized.includes('whatsapp') || normalized === 'api' || normalized === 'ycloud' || normalized === 'whatsapp_api') return 'WhatsApp'
  return platform || 'Meta Ads'
}

function getMessageAdPreviewFallbackTitle(data: Record<string, unknown>) {
  const platform = getMessageAdPreviewPlatformLabel(data).toLowerCase()
  if (platform.includes('instagram')) return 'Anuncio de Instagram'
  if (platform.includes('messenger') || platform.includes('facebook')) return 'Anuncio de Messenger'
  if (platform.includes('whatsapp')) return 'Anuncio de WhatsApp'
  return 'Anuncio de Meta'
}

function isAbsoluteHttpUrl(value = '') {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function isCurrentOriginUrl(value = '') {
  if (typeof window === 'undefined') return false

  try {
    const url = new URL(value, window.location.href)
    return url.origin === window.location.origin
  } catch {
    return false
  }
}

function getExternalMessageAdUrl(value = '') {
  const url = getReadableDataValue(value)
  if (!url || !isAbsoluteHttpUrl(url)) return ''
  if (isCurrentOriginUrl(url)) return ''
  return url
}

function buildMetaAdsManagerAdUrl(adId = '', adAccountId = '') {
  const cleanAdId = getReadableDataValue(adId)
  const cleanAccountId = getReadableDataValue(adAccountId).replace(/^act_/i, '')
  if (!cleanAdId || !cleanAccountId) return ''

  const params = new URLSearchParams({
    act: cleanAccountId,
    selected_ad_ids: cleanAdId
  })
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?${params.toString()}`
}

function getMessageAdPreviewActionUrl(preview: MessageAdPreview) {
  return getExternalMessageAdUrl(preview.previewUrl) ||
    buildMetaAdsManagerAdUrl(preview.sourceId, preview.adAccountId) ||
    getExternalMessageAdUrl(preview.sourceUrl)
}

function buildMessageAdPreview(data: Record<string, unknown>, direction: DesktopChatMessage['direction']): MessageAdPreview | undefined {
  if (direction !== 'inbound') return undefined

  const messageTextAdId = extractRistakAdIdFromMessageText(pickMessageText(data))
  const messageSourceId = pickReadableDataValue(data, [
    'referral_source_id',
    'detected_source_id',
    'source_id',
    'ad_id_thru_message',
    'message_ad_id'
  ]) || messageTextAdId
  const sourceUrl = pickReadableDataValue(data, ['referral_source_url', 'detected_source_url', 'source_url'])
  const ctwaClid = pickReadableDataValue(data, ['referral_ctwa_clid', 'detected_ctwa_clid', 'ctwa_clid'])
  const sourceType = pickReadableDataValue(data, ['referral_source_type', 'detected_source_type', 'source_type']) || (messageTextAdId ? 'ad' : '')
  const headline = pickReadableDataValue(data, ['referral_headline', 'detected_headline', 'headline', 'title'])
  const body = pickReadableDataValue(data, ['referral_body', 'detected_body', 'ad_body', 'description'])
  const sourceTypeIsAd = sourceTypeLooksLikeMessageAd(sourceType)
  const backendConfirmedAd = isTruthyDataFlag(data.is_ad_attributed)
  const hasAdPayloadDetails = Boolean(
    messageSourceId ||
    sourceUrl ||
    headline ||
    body ||
    pickReadableDataValue(data, ['referral_image_url', 'creative_image_url', 'creative_thumbnail_url', 'referral_thumbnail_url']) ||
    pickReadableDataValue(data, ['referral_video_url', 'creative_video_url'])
  )
  const hasMessageAdSignal = Boolean(
    backendConfirmedAd ||
    messageTextAdId ||
    ctwaClid ||
    (sourceTypeIsAd && hasAdPayloadDetails)
  )

  if (!hasMessageAdSignal) return undefined

  const enrichedAdId = pickReadableDataValue(data, ['attribution_ad_id', 'ad_id', 'meta_ad_id'])
  const sourceId = messageSourceId || enrichedAdId
  const platform = getMessageAdPreviewPlatformLabel(data)
  const adName = pickReadableDataValue(data, ['attribution_ad_name', 'ad_name', 'meta_ad_name'])
  const title = headline || adName || getMessageAdPreviewFallbackTitle(data)
  const adAccountId = pickReadableDataValue(data, ['ad_account_id', 'adAccountId'])
  const imageUrl = pickReadableDataValue(data, [
    'referral_image_url',
    'creative_image_url',
    'creative_thumbnail_url',
    'referral_thumbnail_url'
  ])
  const videoUrl = pickReadableDataValue(data, ['referral_video_url', 'creative_video_url'])
  const previewUrl = pickReadableDataValue(data, ['creative_preview_url'])
  const campaignName = pickReadableDataValue(data, ['campaign_name'])
  const adsetName = pickReadableDataValue(data, ['adset_name'])

  return {
    platform,
    title,
    body,
    sourceUrl,
    previewUrl,
    adAccountId,
    imageUrl,
    videoUrl,
    campaignName,
    adsetName,
    adName,
    sourceId,
    sourceType
  }
}

function parseLocationCoordinate(value: unknown) {
  if (value === null || value === undefined || value === '') return null
  const number = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(number) ? number : null
}

function buildLocationUrl(location: Pick<ChatLocation, 'latitude' | 'longitude'>) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${location.latitude},${location.longitude}`)}`
}

const LOCATION_MAP_TILE_ZOOM = 16
const LOCATION_MAP_TILE_SIZE = 144
const LOCATION_MAP_MAX_LATITUDE = 85.05112878

type LocationMapTile = {
  key: string
  url: string
  left: number
  top: number
}

function clampLocationLatitude(latitude: number) {
  return Math.max(-LOCATION_MAP_MAX_LATITUDE, Math.min(LOCATION_MAP_MAX_LATITUDE, latitude))
}

function normalizeLocationLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180
}

function getOpenStreetMapTilePosition(location: Pick<ChatLocation, 'latitude' | 'longitude'>) {
  const latitude = clampLocationLatitude(location.latitude)
  const longitude = normalizeLocationLongitude(location.longitude)
  const latitudeRad = (latitude * Math.PI) / 180
  const scale = 2 ** LOCATION_MAP_TILE_ZOOM
  const x = ((longitude + 180) / 360) * scale
  const y = (
    1 - Math.log(Math.tan(latitudeRad) + (1 / Math.cos(latitudeRad))) / Math.PI
  ) / 2 * scale

  return { x, y, scale }
}

function getLocationMapTiles(location: ChatLocation): LocationMapTile[] {
  const { x, y, scale } = getOpenStreetMapTilePosition(location)
  const baseX = Math.floor(x)
  const baseY = Math.floor(y)
  const fractionX = x - baseX
  const fractionY = y - baseY
  const tiles: LocationMapTile[] = []

  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      const wrappedX = ((baseX + column) % scale + scale) % scale
      const clampedY = Math.max(0, Math.min(scale - 1, baseY + row))

      tiles.push({
        key: `${LOCATION_MAP_TILE_ZOOM}-${wrappedX}-${clampedY}`,
        url: `https://tile.openstreetmap.org/${LOCATION_MAP_TILE_ZOOM}/${wrappedX}/${clampedY}.png`,
        left: (column - fractionX) * LOCATION_MAP_TILE_SIZE,
        top: (row - fractionY) * LOCATION_MAP_TILE_SIZE
      })
    }
  }

  return tiles
}

function normalizeLocationValue(value: unknown): ChatLocation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const location = value as Record<string, unknown>
  const latitude = parseLocationCoordinate(
    location.latitude ??
    location.lat ??
    location.degreesLatitude ??
    location.degrees_latitude
  )
  const longitude = parseLocationCoordinate(
    location.longitude ??
    location.lng ??
    location.lon ??
    location.degreesLongitude ??
    location.degrees_longitude
  )
  if (latitude === null || longitude === null) return undefined

  const normalized: ChatLocation = {
    latitude,
    longitude,
    name: String(location.name || location.title || '').trim() || undefined,
    address: String(location.address || location.description || '').trim() || undefined,
    url: String(location.url || location.href || '').trim() || undefined
  }
  if (!normalized.url) normalized.url = buildLocationUrl(normalized)
  return normalized
}

function getJourneyLocation(event: JourneyEvent): ChatLocation | undefined {
  const data = (event.data || {}) as Record<string, unknown>
  const messageType = String(data.message_type || data.messageType || data.type || '').toLowerCase()
  const direct = normalizeLocationValue({
    latitude: data.location_latitude ?? data.locationLatitude ?? data.latitude ?? data.lat,
    longitude: data.location_longitude ?? data.locationLongitude ?? data.longitude ?? data.lng ?? data.lon,
    name: data.location_name || data.locationName || data.name,
    address: data.location_address || data.locationAddress || data.address,
    url: data.location_url || data.locationUrl || data.url
  })
  if (direct) return direct

  const candidates = [
    data.location,
    data.locationMessage,
    data.qrRaw && typeof data.qrRaw === 'object' ? (data.qrRaw as Record<string, unknown>).location : null,
    data.whatsappMessage && typeof data.whatsappMessage === 'object' ? (data.whatsappMessage as Record<string, unknown>).location : null,
    data.whatsappInboundMessage && typeof data.whatsappInboundMessage === 'object' ? (data.whatsappInboundMessage as Record<string, unknown>).location : null,
    data.message && typeof data.message === 'object' ? (data.message as Record<string, unknown>).location : null,
    data.response && typeof data.response === 'object' ? (data.response as Record<string, unknown>).location : null,
    data.request && typeof data.request === 'object' ? (data.request as Record<string, unknown>).location : null
  ]
  for (const candidate of candidates) {
    const location = normalizeLocationValue(candidate)
    if (location) return location
  }

  return messageType.includes('location') ? direct : undefined
}

function cleanLocationMessageText(text = '', location?: ChatLocation) {
  if (!location) return text
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized || ['ubicacion', 'ubicación', 'location'].includes(normalized)) return ''
  return text
}

function getLocationTitle(location?: ChatLocation) {
  return location?.name || 'Ubicación'
}

function getMediaPathExtension(value = '') {
  const clean = String(value || '').trim().split('?')[0].split('#')[0].toLowerCase()
  const leaf = clean.split('/').pop() || clean
  const extension = leaf.split('.').pop() || ''
  return /^[a-z0-9]{2,8}$/.test(extension) ? extension : ''
}

const INLINE_IMAGE_MEDIA_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'])

function hasImageFileSignature(mimeType = '', name = '', mediaUrl = '') {
  const normalizedMime = mimeType.split(';')[0].trim().toLowerCase()
  return normalizedMime.startsWith('image/') ||
    INLINE_IMAGE_MEDIA_EXTENSIONS.has(getMediaPathExtension(name)) ||
    INLINE_IMAGE_MEDIA_EXTENSIONS.has(getMediaPathExtension(mediaUrl))
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
  const imageFile = hasImageFileSignature(mimeType, name, mediaUrl)
  const gifMessageType = normalizedType.includes('gif')
  if (normalizedType.includes('audio') || normalizedType.includes('voice') || normalizedMime.startsWith('audio/')) return 'audio'
  if (gifFile || (gifMessageType && !normalizedMime.startsWith('video/'))) return 'image'
  if (normalizedType.includes('image') || normalizedType.includes('sticker') || imageFile) return 'image'
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
  // El preview local ya está decodificado y tiene dimensiones estables. Mantenerlo
  // primero evita cerrar/reabrir el globo al aparecer la URL remota.
  return attachment?.dataUrl || attachment?.url || ''
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

function isTruthyDataFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'si' || normalized === 'sí'
}

function getJourneyAgentMessageMetadata(data: Record<string, unknown>) {
  const agentId = String(data.agent_id || data.agentId || '').trim()
  return {
    sentByAgent: isTruthyDataFlag(data.sent_by_agent || data.sentByAgent || data.answered_by_agent || data.answeredByAgent) || Boolean(agentId),
    agentId: agentId || undefined
  }
}

function isCommentMessageType(messageType = '') {
  return ['comment', 'comment_reply_public', 'comment_reply_private'].includes(String(messageType || '').trim().toLowerCase())
}

function getCommentFallbackText(messageType = '', status: unknown = '', postDeleted = false) {
  const normalizedType = String(messageType || '').trim().toLowerCase()
  const normalizedStatus = String(status || '').trim().toLowerCase()
  if (!isCommentMessageType(normalizedType)) return ''
  if (postDeleted || ['removed', 'deleted', 'delete', 'remove', 'hide', 'hidden'].includes(normalizedStatus)) return 'Comentario eliminado'
  if (normalizedType === 'comment_reply_public') return 'Respuesta pública al comentario'
  if (normalizedType === 'comment_reply_private') return 'Respuesta por privado al comentario'
  return 'Comentario sin texto'
}

function formatAppointmentConfirmationTime(value?: unknown) {
  if (!value) return ''
  try {
    return formatInTimezone(String(value), getStoredBusinessTimezone(), {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).replace('.', '')
  } catch {
    return ''
  }
}

function getAppointmentConfirmationSystemText(event: JourneyEvent) {
  const data = event.data || {}
  const title = String(data.title || '').trim() || 'la cita'
  const when = formatAppointmentConfirmationTime(data.start_time)
  return `Cita confirmada por IA: ${title}${when ? ` · ${when}` : ''}.`
}

function getJourneyMessage(event: JourneyEvent, index: number): DesktopChatMessage | null {
  if (event.type === 'appointment_confirmation') {
    return {
      id: String(event.data?.id || event.data?.appointment_id || `appointment-confirmation-${index}`),
      text: getAppointmentConfirmationSystemText(event),
      date: event.date,
      direction: 'system',
      status: 'confirmed'
    }
  }

  if (event.type !== 'whatsapp_message' && event.type !== 'meta_message' && event.type !== 'email_message') return null
  const data = event.data || {}
  const attachment = getJourneyMediaAttachment(event)
  const location = getJourneyLocation(event)
  const rawText = pickMessageText(data)
  const text = cleanLocationMessageText(cleanAttachmentMessageText(stripRistakAdIdMarkersFromText(rawText), attachment), location)
  const messageType = String(data.message_type || data.messageType || data.type || '').trim()
  const normalizedMessageType = messageType.toLowerCase()
  if (normalizedMessageType === 'status') return null
  const subject = String(data.subject || '').trim()
  const direction = normalizeWhatsAppBusinessDirection(data.direction || data.message_direction || data.from_type)
  const date = pickMessageTimestamp(data, ['date', 'timestamp', 'created_at', 'createdAt', 'message_timestamp', 'messageTimestamp']) || event.date
  const status = String(data.status || data.message_status || '').trim()
  const providerMessageId = String(data.provider_message_id || data.providerMessageId || data.whatsapp_message_id || data.meta_message_id || '').trim()
  const replyToProviderMessageId = String(data.reply_to_provider_message_id || data.replyToProviderMessageId || '').trim()
  const reactionEmoji = String(data.reaction_emoji || data.reactionEmoji || (normalizedMessageType === 'reaction' ? text : '')).trim()
  const reactionTargetMessageId = String(data.reaction_target_message_id || data.reactionTargetMessageId || '').trim()
  const reactionTargetProviderMessageId = String(
    data.reaction_target_provider_message_id ||
    data.reactionTargetProviderMessageId ||
    (normalizedMessageType === 'reaction' ? replyToProviderMessageId : '')
  ).trim()
  const postDeleted = isTruthyDataFlag(data.post_deleted || data.postDeleted || data.post_removed || data.postRemoved || data.post_unavailable || data.postUnavailable)
  const rawEmailHtml = event.type === 'email_message'
    ? String(data.html_body || data.htmlBody || '').trim()
    : ''
  const emailBodyText = event.type === 'email_message' && !text && rawEmailHtml
    ? emailHtmlToPlainText(rawEmailHtml)
    : ''
  const effectiveText = text || emailBodyText || getCommentFallbackText(messageType, status, postDeleted)
  const errorReason = String(data.error_message || data.errorMessage || data.error_reason || data.errorReason || '').trim()
  const provider = String(data.provider || data.message_provider || data.source_provider || '').trim()
  const transport = String(data.transport || data.channel || '').trim() || provider
  const platform = String(data.social_platform || data.platform || '').trim()
  const channel = resolveChatMessageChannel({
    eventType: event.type,
    channel: data.channel,
    transport,
    provider,
    platform,
    messageType,
    hasEmail: event.type === 'email_message'
  })
  const agentMetadata = getJourneyAgentMessageMetadata(data)
  const adPreview = event.type === 'whatsapp_message' || event.type === 'meta_message'
    ? buildMessageAdPreview(data, direction)
    : undefined
  const email = event.type === 'email_message'
    ? buildEmailChatMessageData(data, {
        bodyText: effectiveText,
        direction,
        status,
        errorReason,
        transport
      })
    : undefined
  if (!effectiveText && !attachment && !location && !adPreview && !messageType && !subject && !hasEmailChatMessageContent(email)) return null
  const fallbackText = location
    ? ''
    : attachment
    ? (['audio', 'image', 'video'].includes(attachment.type) ? '' : getMessageTypeLabel(attachment.type, 'Archivo'))
    : getMessageTypeLabel(messageType)
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
    providerMessageId: providerMessageId || undefined,
    text: effectiveText || fallbackText,
    subject,
    date,
    direction,
    status,
    errorReason,
    messageType,
    sentAt: pickMessageTimestamp(data, ['sent_at', 'sentAt']),
    deliveredAt: pickMessageTimestamp(data, ['delivered_at', 'deliveredAt']),
    readAt: pickMessageTimestamp(data, ['read_at', 'readAt']),
    businessPhone: String(data.business_phone || data.businessPhone || '').trim(),
    businessPhoneNumberId: String(data.business_phone_number_id || data.businessPhoneNumberId || '').trim(),
    transport,
    provider,
    channel: channel === 'unknown' ? String(data.channel || transport || '').trim() : channel,
    routingReason: String(data.routing_reason || data.routingReason || data.fallbackReason || '').trim(),
    ...agentMetadata,
    replyToMessageId: String(data.reply_to_message_id || data.replyToMessageId || '').trim() || undefined,
    replyToProviderMessageId: replyToProviderMessageId || undefined,
    reactionEmoji: reactionEmoji || undefined,
    reactionTargetMessageId: reactionTargetMessageId || undefined,
    reactionTargetProviderMessageId: reactionTargetProviderMessageId || undefined,
    isComment: isCommentMessageType(messageType),
    commentReplyMode: normalizedMessageType === 'comment_reply_public' ? 'public' : normalizedMessageType === 'comment_reply_private' ? 'private' : undefined,
    commentId: String(data.comment_id || data.commentId || '').trim() || undefined,
    commentPlatform: platform.toLowerCase() === 'instagram' ? 'instagram' : 'messenger',
    commentPost: (isCommentMessageType(messageType) && (data.post_message || data.post_image_url || data.post_permalink || postDeleted))
      ? {
          message: String(data.post_message || (postDeleted ? 'Publicación eliminada' : '')).trim(),
          imageUrl: String(data.post_image_url || '').trim(),
          permalink: String(data.post_permalink || data.permalink || '').trim(),
          deleted: postDeleted
      }
      : undefined,
    email,
    attachment,
    location,
    adPreview
  }
}

function getScheduledChatMessageBubble(message: ScheduledChatMessage): DesktopChatMessage | null {
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
    transport: message.transport || message.provider,
    provider: message.provider,
    channel: resolveChatMessageChannel({
      channel: message.channel,
      transport: message.transport,
      provider: message.provider,
      messageType: message.messageType
    }),
    routingReason: message.routingReason || ''
  }
}

function buildConversationMessages(journey: JourneyEvent[], scheduledMessages: ScheduledChatMessage[]) {
  const journeyMessages = journey.map(getJourneyMessage).filter((message): message is DesktopChatMessage => Boolean(message))
  const scheduledBubbles = scheduledMessages.map(getScheduledChatMessageBubble).filter((message): message is DesktopChatMessage => Boolean(message))
  return mergeDesktopMessagesById([...journeyMessages, ...scheduledBubbles])
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

function getContactPhoneEntries(contact?: Contact | null): ContactPhoneNumber[] {
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

function getContactInfoPayments(contact?: Contact | null, journey: JourneyEvent[] = []): ContactInfoPayment[] {
  const contactPayments = (contact?.payments || []).map((payment: ContactPayment, index: number) => ({
    id: String(payment.id || `${contact?.id || 'contact'}-payment-${index}`),
    amount: Number(payment.amount || 0),
    currency: payment.currency || null,
    status: payment.status,
    date: payment.date || contact?.createdAt || new Date().toISOString(),
    title: null
  }))
  if (contactPayments.length > 0) return contactPayments.sort((left, right) => parseSortableDateValue(right.date) - parseSortableDateValue(left.date))
  return journey
    .filter((event) => event.type === 'payment')
    .map((event, index) => ({
      id: String(event.data?.id || `${contact?.id || 'contact'}-journey-payment-${index}`),
      amount: Number(event.data?.amount || 0),
      currency: event.data?.currency || null,
      status: event.data?.status || null,
      date: event.date,
      title: event.data?.title || event.data?.type || null
    }))
    .sort((left, right) => parseSortableDateValue(right.date) - parseSortableDateValue(left.date))
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
  if (contactAppointments.length > 0) return contactAppointments.sort((left, right) => parseSortableDateValue(left.startTime) - parseSortableDateValue(right.startTime))
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
    .sort((left, right) => parseSortableDateValue(left.startTime) - parseSortableDateValue(right.startTime))
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
  const startTimestamp = parseSortableDateValue(appointment.startTime)
  const effectiveStartTimestamp = startTimestamp > 0 ? startTimestamp : Date.now()
  const startTime = new Date(effectiveStartTimestamp).toISOString()
  const parsedEndTimestamp = appointment.endTime ? parseSortableDateValue(appointment.endTime) : 0
  const effectiveEndTimestamp = parsedEndTimestamp > effectiveStartTimestamp
    ? parsedEndTimestamp
    : effectiveStartTimestamp + 60 * 60 * 1000
  const endTime = new Date(effectiveEndTimestamp).toISOString()

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

function normalizeComposerChannel(value?: string | null): ComposerChannel {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (normalized.includes('instagram') && normalized.includes('comment')) return 'instagram_comment'
  if ((normalized.includes('facebook') || normalized.includes('comment')) && normalized.includes('comment')) return 'facebook_comment'
  if (normalized.includes('instagram')) return 'instagram'
  if (normalized.includes('messenger') || normalized.includes('facebook')) return 'messenger'
  if (normalized === 'sms' || normalized === 'sms_qr' || normalized === 'ghl_sms') return 'sms'
  if (normalized.includes('email') || normalized.includes('correo') || normalized.includes('mail') || normalized === 'smtp') return 'email'
  return 'whatsapp'
}

function getDefaultComposerChannel(contact?: DesktopChatContact | null): ComposerChannel {
  if (!contact) return 'whatsapp'
  if (isCommentContact(contact)) {
    return getCommentPlatform(contact) === 'instagram' ? 'instagram_comment' : 'facebook_comment'
  }
  const inferred = normalizeComposerChannel(contact.lastMessageChannel || contact.lastMessageTransport || '')
  if (isCommentComposerChannel(inferred)) {
    return inferred === 'instagram_comment' ? 'instagram' : 'messenger'
  }
  if (inferred === 'email' && contact.email) return 'email'
  if (inferred === 'sms' || inferred === 'messenger' || inferred === 'instagram') return inferred
  if (contact.phone) return 'whatsapp'
  if (contact.email) return 'email'
  return inferred
}

function getHighLevelChannelForComposer(channel: ComposerChannel): HighLevelChatChannel {
  if (channel === 'sms') return 'sms_qr'
  if (channel === 'email') return 'email'
  if (channel === 'messenger' || channel === 'instagram') return channel
  if (channel === 'facebook_comment') return 'messenger'
  if (channel === 'instagram_comment') return 'instagram'
  return 'whatsapp_api'
}

function getSelectedBusinessPhone(status?: WhatsAppApiStatus | null): WhatsAppApiPhoneNumber | null {
  const phones = status?.phoneNumbers || []
  return status?.selectedPhone || phones.find((phone) => phone.is_default_sender) || phones[0] || null
}

function getBusinessPhoneValue(phone?: WhatsAppApiPhoneNumber | null) {
  return phone?.display_phone_number || phone?.phone_number || phone?.qr_connected_phone || ''
}

function getBusinessPhoneLabel(phone?: WhatsAppApiPhoneNumber | null) {
  return phone?.label || phone?.verified_name || getBusinessPhoneValue(phone) || 'WhatsApp'
}

function getBusinessPhoneDisplay(phone?: WhatsAppApiPhoneNumber | null) {
  const value = getBusinessPhoneValue(phone)
  const label = getBusinessPhoneLabel(phone)
  if (!value) return label
  return label && label !== value ? `${label} · ${value}` : value
}

function getNativeWhatsAppRouteLabel(phone?: WhatsAppApiPhoneNumber | null) {
  const provider = String(phone?.provider || '').trim().toLowerCase()
  const route = provider === 'meta_direct'
    ? 'Meta Direct'
    : provider === 'ycloud'
      ? 'YCloud'
      : isPhoneQrReadyForSend(phone) && !phone?.api_send_enabled
        ? 'QR de Ristak'
        : 'Ristak'
  return `WhatsApp · ${route} · ${getBusinessPhoneDisplay(phone)}`
}

function getPreferredWhatsAppPhoneNumberId(contact?: Contact | DesktopChatContact | null) {
  return String(contact?.preferredWhatsAppPhoneNumberId || contact?.preferred_whatsapp_phone_number_id || '').trim()
}

function findBusinessPhoneByRoute(
  phones: WhatsAppApiPhoneNumber[],
  phoneNumberId?: string | null,
  businessPhone?: string | null
) {
  const cleanPhoneNumberId = String(phoneNumberId || '').trim()
  const cleanBusinessPhone = String(businessPhone || '').trim()
  if (cleanPhoneNumberId) {
    const byId = phones.find((phone) => phone.id === cleanPhoneNumberId)
    if (byId) return byId
  }
  if (!cleanBusinessPhone) return null

  return phones.find((phone) => (
    phoneValueMatches(phone.phone_number, cleanBusinessPhone) ||
    phoneValueMatches(phone.display_phone_number, cleanBusinessPhone) ||
    phoneValueMatches(phone.qr_connected_phone, cleanBusinessPhone)
  )) || null
}

function renderComposerChannelIcon(channel: ComposerChannel) {
  if (channel === 'whatsapp') return <FaWhatsapp className={styles.composerChannelBrandIcon} aria-hidden="true" />
  if (channel === 'sms') return <PhoneMessageChannelIcon channel="sms_qr" size={18} />
  if (channel === 'facebook_comment') return <FaFacebook className={styles.composerChannelBrandIcon} aria-hidden="true" />
  if (channel === 'messenger') return <FaFacebookMessenger className={styles.composerChannelBrandIcon} aria-hidden="true" />
  if (channel === 'instagram') return <FaInstagram className={styles.composerChannelBrandIcon} aria-hidden="true" />
  if (channel === 'instagram_comment') return <FaInstagram className={styles.composerChannelBrandIcon} aria-hidden="true" />
  return <Mail size={18} aria-hidden="true" />
}

function getComposerBusinessPhone(status?: WhatsAppApiStatus | null, contact?: DesktopChatContact | null): WhatsAppApiPhoneNumber | null {
  const phones = status?.phoneNumbers || []
  const preferredId = contact?.preferredWhatsAppPhoneNumberId || contact?.preferred_whatsapp_phone_number_id || ''
  if (preferredId) {
    const preferred = phones.find((phone) => phone.id === preferredId)
    if (preferred) return preferred
  }
  if (contact?.lastInboundBusinessPhoneNumberId) {
    const lastInboundById = phones.find((phone) => phone.id === contact.lastInboundBusinessPhoneNumberId)
    if (lastInboundById) return lastInboundById
  }
  if (contact?.lastInboundBusinessPhone) {
    const lastInboundByPhone = phones.find((phone) => (
      phoneValueMatches(phone.phone_number, contact.lastInboundBusinessPhone) ||
      phoneValueMatches(phone.display_phone_number, contact.lastInboundBusinessPhone) ||
      phoneValueMatches(phone.qr_connected_phone, contact.lastInboundBusinessPhone)
    ))
    if (lastInboundByPhone) return lastInboundByPhone
  }
  if (contact?.lastBusinessPhoneNumberId) {
    const lastById = phones.find((phone) => phone.id === contact.lastBusinessPhoneNumberId)
    if (lastById) return lastById
  }
  if (contact?.lastBusinessPhone) {
    const lastByPhone = phones.find((phone) => (
      phoneValueMatches(phone.phone_number, contact.lastBusinessPhone) ||
      phoneValueMatches(phone.display_phone_number, contact.lastBusinessPhone) ||
      phoneValueMatches(phone.qr_connected_phone, contact.lastBusinessPhone)
    ))
    if (lastByPhone) return lastByPhone
  }
  return getSelectedBusinessPhone(status)
}

function normalizePhoneProbe(value?: string | null) {
  return String(value || '').replace(/\D/g, '')
}

function phoneValueMatches(left?: string | null, right?: string | null) {
  const leftDigits = normalizePhoneProbe(left)
  const rightDigits = normalizePhoneProbe(right)
  if (!leftDigits || !rightDigits) return false
  return leftDigits === rightDigits || leftDigits.endsWith(rightDigits) || rightDigits.endsWith(leftDigits)
}

function desktopMessageMatchesBusinessPhone(
  message: Pick<DesktopChatMessage, 'businessPhone' | 'businessPhoneNumberId'>,
  phone?: WhatsAppApiPhoneNumber | null,
  phoneValue?: string | null
) {
  const messagePhoneNumberId = String(message.businessPhoneNumberId || '').trim()
  if (messagePhoneNumberId && phone?.id && messagePhoneNumberId === phone.id) return true

  const targetPhoneValue = String(phoneValue || getBusinessPhoneValue(phone)).trim()
  return Boolean(targetPhoneValue && phoneValueMatches(message.businessPhone, targetPhoneValue))
}

function isPhoneQrConnected(phone?: WhatsAppApiPhoneNumber | null) {
  return String(phone?.qr_status || '').trim().toLowerCase() === 'connected' || Boolean(phone?.qr_send_enabled && phone?.qr_connected_phone)
}

function isPhoneQrReadyForSend(phone?: WhatsAppApiPhoneNumber | null) {
  return Boolean(phone?.qr_send_enabled) && String(phone?.qr_status || '').trim().toLowerCase() === 'connected'
}

function isPhoneApiEnabled(phone?: WhatsAppApiPhoneNumber | null, status?: WhatsAppApiStatus | null) {
  return isWhatsAppPhoneApiAvailable(phone, status)
}

function isInsideWhatsAppReplyWindow(date?: string | null) {
  if (!date) return false
  const timestamp = parseSortableDateValue(date)
  if (!timestamp) return false
  return Date.now() - timestamp < 24 * 60 * 60 * 1000
}

function desktopMessageCanOpenWhatsAppReplyWindow(message: DesktopChatMessage) {
  if (message.direction !== 'inbound') return false
  if (message.subject) return false

  const transport = String(message.transport || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (transport.startsWith('ghl_')) return transport === 'ghl_whatsapp' || transport === 'ghl_whatsapp_api'
  if (transport === 'sms_qr' || transport === 'messenger' || transport === 'instagram' || transport === 'email') return false

  return !transport || ['api', 'qr', 'whatsapp', 'whatsapp_api', 'whatsapp_qr', 'baileys', 'bailey'].includes(transport)
}

function getSocialPlatformForDesktopMessage(message: DesktopChatMessage): 'messenger' | 'instagram' | null {
  const messageProbe = normalizeFilterProbe([
    message.provider,
    message.transport,
    message.commentPlatform
  ])
  if (messageProbe.includes('instagram') || messageProbe.includes('ig_')) return 'instagram'
  if (messageProbe.includes('messenger') || messageProbe.includes('facebook_messenger')) return 'messenger'
  if (messageProbe.includes('facebook') && !message.isComment) return 'messenger'
  return null
}

function getMetaPlatformForDesktopMessage(message: DesktopChatMessage, contact?: DesktopChatContact | Contact | null): 'messenger' | 'instagram' | null {
  if (isHighLevelMessageTransport(message)) return null

  const messagePlatform = getSocialPlatformForDesktopMessage(message)
  if (messagePlatform) return messagePlatform

  const messageProbe = normalizeFilterProbe([
    message.provider,
    message.transport,
    message.commentPlatform
  ])
  if (messageProbe && !messageProbe.includes('meta') && !messageProbe.includes('social') && messageProbe !== 'dm') return null

  const contactRecord = (contact || {}) as Record<string, unknown>
  const contactProbe = normalizeFilterProbe([
    getRecordValue(contactRecord, 'lastMessageChannel'),
    getRecordValue(contactRecord, 'lastMessageTransport')
  ])
  if (contactProbe.includes('instagram') || contactProbe.includes('ig_')) return 'instagram'
  if (contactProbe.includes('messenger') || contactProbe.includes('facebook_messenger')) return 'messenger'
  if (contactProbe.includes('facebook') && !message.isComment) return 'messenger'
  return null
}

function isHighLevelMessageTransport(message: DesktopChatMessage) {
  const probe = normalizeFilterProbe([message.provider, message.transport])
  const transport = String(message.transport || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  return probe.includes('highlevel') || transport.startsWith('ghl_') || transport === 'sms_qr'
}

function getNativeWhatsAppReactionChannel(message: DesktopChatMessage): Extract<DesktopMessageReactionChannel, 'whatsapp_api' | 'whatsapp_qr'> | null {
  if (isHighLevelMessageTransport(message)) return null

  const probe = normalizeFilterProbe([message.provider, message.transport])
  const transport = String(message.transport || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (
    probe.includes('messenger') ||
    probe.includes('instagram') ||
    probe.includes('facebook') ||
    probe.includes('email') ||
    probe.includes('webchat') ||
    probe.includes('sms')
  ) return null

  if (transport === 'qr' || transport === 'whatsapp_qr' || transport === 'baileys' || transport === 'bailey') return 'whatsapp_qr'
  if (!transport || ['api', 'ycloud', 'meta_direct', 'whatsapp', 'whatsapp_api'].includes(transport)) return 'whatsapp_api'
  return null
}

function getMessageReactionEmojis(channel: DesktopMessageReactionChannel) {
  return channel === 'messenger' || channel === 'instagram'
    ? META_MESSAGE_REACTION_EMOJIS
    : MESSAGE_REACTION_EMOJIS
}

function getMessageReactionPickerEmojis(channel: DesktopMessageReactionChannel) {
  return channel === 'messenger' || channel === 'instagram'
    ? META_MESSAGE_REACTION_EMOJIS
    : MESSAGE_REACTION_PICKER_EMOJIS
}

function getMessageBusinessPhone(message: DesktopChatMessage, status?: WhatsAppApiStatus | null) {
  const phones = status?.phoneNumbers || []
  if (message.businessPhoneNumberId) {
    const byId = phones.find((phone) => phone.id === message.businessPhoneNumberId)
    if (byId) return byId
  }
  return phones.find((phone) => (
    phoneValueMatches(phone.phone_number, message.businessPhone) ||
    phoneValueMatches(phone.display_phone_number, message.businessPhone) ||
    phoneValueMatches(phone.qr_connected_phone, message.businessPhone)
  )) || null
}

function getMessageTransportLabel(message: DesktopChatMessage, status?: WhatsAppApiStatus | null) {
  if (String(message.transport || '').trim().toLowerCase() === 'email' || message.subject) return 'Email'
  const phone = getMessageBusinessPhone(message, status)
  const dualConnection = Boolean(phone && isPhoneApiEnabled(phone, status) && isPhoneQrConnected(phone))
  if (!dualConnection) return ''

  const transport = String(message.transport || '').trim().toLowerCase()
  if (transport === 'qr') return 'QR'
  if (transport === 'api' || transport === 'whatsapp_api') return 'API'
  return ''
}

function isQrTransport(value?: string | null) {
  return String(value || '').trim().toLowerCase() === 'qr'
}

function getMessageRoutingDetails(message: DesktopChatMessage, status?: WhatsAppApiStatus | null) {
  if (message.direction !== 'outbound') return { label: '', reason: '' }
  const label = getMessageTransportLabel(message, status)
  if (isQrTransport(message.transport)) return { label, reason: '' }

  const reason = String(message.routingReason || '').trim()
  const cleanReason = reason === 'Capturado desde la sesión de WhatsApp Web.' ? '' : reason
  return { label, reason: cleanReason }
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
  const { accessToken, locationId, user } = useAuth()
  const { labels } = useLabels()
  const { showToast } = useNotification()
  const { timezone, formatLocalDateTime } = useTimezone()
  const [accountCurrency] = useAccountCurrency()

  const customerLowerLabel = formatCrmLabelLower(labels.customer, DEFAULT_CRM_LABELS.customer)
  const customersLabel = labels.customers?.trim() || DEFAULT_CRM_LABELS.customers
  const leadsLabel = labels.leads?.trim() || DEFAULT_CRM_LABELS.leads
  const customerWithArticle = formatCrmLabelWithDefiniteArticle(labels.customer, DEFAULT_CRM_LABELS.customer)
  const chatFilters = useMemo<Array<{ id: ChatFilter; label: string }>>(() => ([
    ...BASE_CHAT_FILTERS,
    { id: 'customers', label: customersLabel }
  ]), [customersLabel])
  const stageFilterOptions = useMemo(() => ([
    BASE_STAGE_FILTER_OPTIONS[0],
    { value: 'lead', label: leadsLabel },
    BASE_STAGE_FILTER_OPTIONS[1],
    { value: 'customer', label: customersLabel }
  ]), [customersLabel, leadsLabel])
  const messagePaneRef = useRef<HTMLDivElement | null>(null)
  const chatsRequestRef = useRef<AbortController | null>(null)
  const chatListRef = useRef<HTMLDivElement | null>(null)
  const photoInputRef = useRef<HTMLInputElement | null>(null)
  const documentInputRef = useRef<HTMLInputElement | null>(null)
  const composerMenuRef = useRef<HTMLDivElement | null>(null)
  const agentComposerMenuRef = useRef<HTMLDivElement | null>(null)
  const voiceRecorderRef = useRef<MediaRecorder | null>(null)
  const voiceStreamRef = useRef<MediaStream | null>(null)
  const voiceChunksRef = useRef<Blob[]>([])
  const voiceStartedAtRef = useRef(0)
  const voiceTimerRef = useRef<number | null>(null)
  const messageAudioRefs = useRef<Record<string, HTMLAudioElement | null>>({})
  const selectAllChatCheckboxRef = useRef<HTMLInputElement | null>(null)
  const chatsRef = useRef<DesktopChatContact[]>([])
  const [initialChatCache] = useState<ChatListCacheSnapshot>(() => readCachedChatList())
  const chatListCursorRef = useRef<ChatListKeysetCursor | null>(null)
  const chatListHasAppendedRef = useRef(false)
  const chatListHasMoreRef = useRef(initialChatCache.chats.length > 0)
  const chatListLoadingMoreRef = useRef(false)
  // Controller propio para "cargar más" (append), independiente de chatsRequestRef, para que
  // el load-more nunca quede bloqueado por una carga inicial o un refresco en segundo plano.
  const chatListLoadMoreRequestRef = useRef<AbortController | null>(null)
  // Término de búsqueda de la última carga completa (no-append). Vacío = lista completa.
  // Sirve para que al limpiar la búsqueda la recarga REEMPLACE en vez de fusionar sobre los
  // resultados de búsqueda anteriores.
  const chatListLoadedSearchRef = useRef('')
  const activeContactIdRef = useRef('')
  const contactJourneyRef = useRef<JourneyEvent[]>([])
  const messagePanePinnedToBottomRef = useRef(true)
  const conversationHistoryPrependRef = useRef(false)
  const scrollContactIdRef = useRef('')
  const openingConversationScrollContactIdRef = useRef('')
  const previousMessagesScrollRef = useRef({
    activeContactId: '',
    count: 0,
    lastMessageId: ''
  })
  const conversationLoadGenerationRef = useRef(0)
  const [conversationRequestCoordinator] = useState(() => createDesktopChatConversationRequestCoordinator())
  const chatReadRequestsRef = useRef(new Map<string, Promise<unknown>>())
  const conversationActivityLoadedAtRef = useRef(0)
  const olderMessagesLoadingRef = useRef(false)
  const conversationHasOlderMessagesRef = useRef(false)
  const conversationHistoryExhaustedContactIdRef = useRef<string | null>(null)
  const chatLiveRefreshTimeoutRef = useRef<number | null>(null)
  const chatLiveRefreshInFlightRef = useRef(false)
  const chatLiveRefreshQueuedRef = useRef(false)
  const chatLiveConnectedRef = useRef(false)
  const chatLastFallbackReconcileAtRef = useRef(Date.now())
  const archivedChatIdSetRef = useRef<Set<string>>(new Set())
  const removedChatStatesRef = useRef<RemovedChatState[]>([])
  const agentPriorityChatIdSetRef = useRef<Set<string>>(new Set())
  const [chats, setChats] = useState<DesktopChatContact[]>(() => initialChatCache.chats)
  const [chatsLoading, setChatsLoading] = useState(() => initialChatCache.chats.length === 0)
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false)
  const [chatsError, setChatsError] = useState('')
  const [chatQuery, setChatQuery] = useState('')
  const [chatFilter, setChatFilter] = useState<ChatFilter>('all')
  const [commentsView, setCommentsView] = useState(false)
  const [commentsPlatform, setCommentsPlatform] = useState<'all' | 'facebook' | 'instagram'>('all')
  const [facebookCommentsEnabled] = useAppConfig('meta_facebook_comments_enabled', false)
  const [instagramCommentsEnabled] = useAppConfig('meta_instagram_comments_enabled', false)
  const commentsFeatureEnabled = facebookCommentsEnabled === true || instagramCommentsEnabled === true
  const [advancedFilters, setAdvancedFilters] = useState<AdvancedChatFilters>(DEFAULT_ADVANCED_FILTERS)
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [archivedViewOpen, setArchivedViewOpen] = useState(false)
  const [archivedChatIds, setArchivedChatIds] = useState<string[]>(() => readStoredChatIds(CHAT_ARCHIVED_STATE_KEY))
  const [removedChatStates, setRemovedChatStates] = useState<RemovedChatState[]>(() => readStoredRemovedChatStates())
  const [activeContactId, setActiveContactId] = useState<string>('')
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([])
  const [bulkChatConfirmAction, setBulkChatConfirmAction] = useState<BulkChatConfirmAction | null>(null)
  const [bulkAgentActionBusy, setBulkAgentActionBusy] = useState<BulkAgentSelectionAction | null>(null)

  const [messages, setMessages] = useState<DesktopChatMessage[]>([])
  const [agentCompletionEvents, setAgentCompletionEvents] = useState<ConversationalAgentCompletionEvent[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messagesRefreshing, setMessagesRefreshing] = useState(false)
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false)
  const [messagesError, setMessagesError] = useState('')
  const [contactJourney, setContactJourney] = useState<JourneyEvent[]>([])
  const [contactInfoData, setContactInfoData] = useState<Contact | null>(null)
  // (Asignación) Responsable del contacto: lista de usuarios y asignado actual.
  const [assignableUsers, setAssignableUsers] = useState<{ id: string; name: string }[]>([])
  const [assignedUserId, setAssignedUserId] = useState<string>('')
  // (Social enlazado) Perfil social del contacto + contacto vinculado (DM ↔ comentario).
  const [socialProfiles, setSocialProfiles] = useState<LinkedSocialProfile[]>([])
  const [linkedSocialContacts, setLinkedSocialContacts] = useState<LinkedSocialContact[]>([])
  const [contactInfoLoading, setContactInfoLoading] = useState(false)
  const [savingPrimaryPhone, setSavingPrimaryPhone] = useState<string | null>(null)
  const [infoPanelView, setInfoPanelView] = useState<InfoPanelView>('summary')
  const [agentHistoryExpanded, setAgentHistoryExpanded] = useState(false)

  const [composerText, setComposerText] = useState('')
  const [composerChannel, setComposerChannel] = useState<ComposerChannel>('whatsapp')
  const composerChannelPreferenceRequestRef = useRef(0)
  const [contentFocusItem, setContentFocusItem] = useState<ContentFocusItem | null>(null)
  // Responder PÚBLICO a un comentario puede venir del canal de comentario
  // seleccionado o del botón de la tarjeta, que fija el target exacto.
  const [commentReplyTarget, setCommentReplyTarget] = useState<CommentReplyTarget | null>(null)
  const [composerBusinessPhoneId, setComposerBusinessPhoneId] = useState('')
  const [composerHighLevelFromNumber, setComposerHighLevelFromNumber] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  const [emailBodyHtml, setEmailBodyHtml] = useState('')
  const [emailIncludeSignature, setEmailIncludeSignature] = useState(true)
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [composerMenuOpen, setComposerMenuOpen] = useState(false)
  const [templatePanelOpen, setTemplatePanelOpen] = useState(false)
  const [templatePanelMode, setTemplatePanelMode] = useState<TemplatePanelMode>('choice')
  const [templates, setTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesLoaded, setTemplatesLoaded] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [templateSearch, setTemplateSearch] = useState('')
  const [templateSendingId, setTemplateSendingId] = useState<string | null>(null)
  const [creatingTemplate, setCreatingTemplate] = useState(false)
  const [newTemplateName, setNewTemplateName] = useState('')
  const [newTemplateBody, setNewTemplateBody] = useState('')
  const [newTemplateCategory, setNewTemplateCategory] = useState<MessageTemplateCategory>('utility')
  const [newTemplateLanguage, setNewTemplateLanguage] = useState('es_MX')
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState<ScheduleDraft>(() => createDefaultScheduleDraft(timezone))
  const [scheduleEditingMessageId, setScheduleEditingMessageId] = useState<string | null>(null)
  const [scheduleError, setScheduleError] = useState('')
  const [schedulingMessage, setSchedulingMessage] = useState(false)
  const [cancelingScheduledMessageId, setCancelingScheduledMessageId] = useState<string | null>(null)
  const [draftAttachments, setDraftAttachments] = useState<DesktopDraftAttachment[]>([])
  const [draggingFilesOverChat, setDraggingFilesOverChat] = useState(false)
  const [mediaDeliveryPrompt, setMediaDeliveryPrompt] = useState<MediaDeliveryPromptState | null>(null)
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraftAttachment | null>(null)
  const [voiceRecording, setVoiceRecording] = useState(false)
  const [voiceProcessing, setVoiceProcessing] = useState(false)
  const [, setVoiceElapsedMs] = useState(0)
  const [playingAudioId, setPlayingAudioId] = useState('')
  const [messageAudioProgress, setMessageAudioProgress] = useState<Record<string, { currentTime: number; duration: number }>>({})
  const [reactingMessageId, setReactingMessageId] = useState<string | null>(null)
  const [messageReactionMenu, setMessageReactionMenu] = useState<MessageReactionMenuState | null>(null)
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [highLevelConnected, setHighLevelConnected] = useState(false)
  const [highLevelPhoneNumbers, setHighLevelPhoneNumbers] = useState<HighLevelPhoneNumber[]>([])
  const [metaMessengerConnected, setMetaMessengerConnected] = useState(false)
  const [metaInstagramConnected, setMetaInstagramConnected] = useState(false)
  const [emailConnected, setEmailConnected] = useState(false)
  const [conversationAgentState, setConversationAgentState] = useState<ConversationAgentState | null>(null)
  const [agentStates, setAgentStates] = useState<Record<string, ConversationAgentState>>({})
  const [agentStateLists, setAgentStateLists] = useState<Record<string, ConversationAgentState[]>>({})
  const [agentDefs, setAgentDefs] = useState<ConversationalAgentDef[]>([])
  const conversationAgentEnabled = agentDefs.some((agent) => agent.enabled)
  const [agentInboxStatusFilter, setAgentInboxStatusFilter] = useState<AgentInboxStatusFilter>(DEFAULT_AGENT_INBOX_STATUS_FILTER)
  const [agentComposerMenuOpen, setAgentComposerMenuOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const [conversationAgentBusy, setConversationAgentBusy] = useState(false)
  const [manualAgentSendPrompt, setManualAgentSendPrompt] = useState<ManualAgentSendPrompt | null>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [calendarsLoading, setCalendarsLoading] = useState(false)
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [editingAppointmentEvent, setEditingAppointmentEvent] = useState<CalendarEvent | null>(null)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [savingTags, setSavingTags] = useState(false)
  const [savingWhatsAppPreference, setSavingWhatsAppPreference] = useState(false)
  const [whatsappPreferenceError, setWhatsappPreferenceError] = useState('')
  const [automationModalOpen, setAutomationModalOpen] = useState(false)
  const [automations, setAutomations] = useState<AutomationSummary[]>([])
  const [automationsLoading, setAutomationsLoading] = useState(false)
  const [selectedAutomationId, setSelectedAutomationId] = useState('')
  const [automationSubmitting, setAutomationSubmitting] = useState(false)
  const mediaDeliveryPromptResolveRef = useRef<((mode: DraftAttachmentDeliveryMode | 'cancel') => void) | null>(null)
  const dragDepthRef = useRef(0)

  const activeContact = useMemo(
    () => chats.find((contact) => contact.id === activeContactId) || null,
    [activeContactId, chats]
  )
  const activeInfoContact = useMemo<Contact | DesktopChatContact | null>(() => {
    if (!activeContact && !contactInfoData) return null
    return {
      ...(activeContact || {}),
      ...(contactInfoData || {})
    } as Contact | DesktopChatContact
  }, [activeContact, contactInfoData])
  const activeContactPhones = useMemo(
    () => getContactPhoneEntries(activeInfoContact),
    [activeInfoContact]
  )
  const activeInfoContactHasPhone = activeContactPhones.length > 0
  const businessPhones = useMemo(() => whatsappStatus?.phoneNumbers || [], [whatsappStatus?.phoneNumbers])
  const defaultComposerBusinessPhone = useMemo(() => getComposerBusinessPhone(whatsappStatus, activeContact), [activeContact, whatsappStatus])
  const selectedBusinessPhone = useMemo(() => {
    if (composerChannel === 'sms' || composerBusinessPhoneId === HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID) return null

    return businessPhones.find((phone) => phone.id === composerBusinessPhoneId) ||
      defaultComposerBusinessPhone ||
      null
  }, [businessPhones, composerBusinessPhoneId, composerChannel, defaultComposerBusinessPhone])
  const preferredWhatsAppPhoneNumberId = getPreferredWhatsAppPhoneNumberId(activeInfoContact)
  const automaticWhatsAppRoutePhone = useMemo(() => {
    const routedMessage = [...messages]
      .reverse()
      .find((message) => message.direction === 'inbound' && Boolean(message.businessPhoneNumberId || message.businessPhone))
    return findBusinessPhoneByRoute(
      businessPhones,
      routedMessage?.businessPhoneNumberId ||
        activeInfoContact?.lastInboundBusinessPhoneNumberId ||
        activeInfoContact?.lastBusinessPhoneNumberId ||
        '',
      routedMessage?.businessPhone ||
        activeInfoContact?.lastInboundBusinessPhone ||
        activeInfoContact?.lastBusinessPhone ||
        ''
    )
  }, [activeInfoContact, businessPhones, messages])
  const selectedWhatsAppPreferencePhone = preferredWhatsAppPhoneNumberId
    ? businessPhones.find((phone) => phone.id === preferredWhatsAppPhoneNumberId) || null
    : null
  const whatsappPreferenceRoutePhone = selectedWhatsAppPreferencePhone ||
    automaticWhatsAppRoutePhone ||
    defaultComposerBusinessPhone ||
    getSelectedBusinessPhone(whatsappStatus)
  const whatsappPreferenceRouteMode = preferredWhatsAppPhoneNumberId
    ? 'Responde desde'
    : automaticWhatsAppRoutePhone
    ? 'Último mensaje'
    : 'Principal actual'
  const whatsappPreferenceDescription = preferredWhatsAppPhoneNumberId
    ? 'Número fijo para este contacto.'
    : automaticWhatsAppRoutePhone
    ? 'Automático: usa el número por donde llegó.'
    : 'Automático: usa el remitente principal mientras no haya historial de WhatsApp.'
  const automaticWhatsAppPreferenceOptionLabel = automaticWhatsAppRoutePhone
    ? 'Automático: usar el número por donde llegó'
    : 'Automático: usar remitente principal'
  const whatsappPreferenceRouteDisplay = whatsappPreferenceRoutePhone
    ? getBusinessPhoneDisplay(whatsappPreferenceRoutePhone)
    : 'Sin número configurado'
  const selectedBusinessPhoneValue = getBusinessPhoneValue(selectedBusinessPhone)
  const defaultHighLevelPhoneNumber = useMemo(() => (
    highLevelPhoneNumbers.find((phone) => phone.isDefault) || highLevelPhoneNumbers[0] || null
  ), [highLevelPhoneNumbers])
  const selectedHighLevelFromNumber = composerChannel === 'sms'
    ? composerHighLevelFromNumber || defaultHighLevelPhoneNumber?.phoneNumber || ''
    : ''
  const selectedHighLevelPhoneNumber = selectedHighLevelFromNumber
    ? highLevelPhoneNumbers.find((phone) => phone.phoneNumber === selectedHighLevelFromNumber) || null
    : null
  const highLevelWhatsAppSender = useMemo(
    () => getLatestHighLevelWhatsAppInboundSender(messages),
    [messages]
  )
  const whatsappConnected = Boolean(
    selectedBusinessPhoneValue && isWhatsAppPhoneApiAvailable(selectedBusinessPhone, whatsappStatus)
  )
  const lastInboundForSelectedPhone = useMemo(() => {
    return [...messages]
      .filter((message) => {
        if (!desktopMessageCanOpenWhatsAppReplyWindow(message)) return false
        if (!selectedBusinessPhoneValue && !selectedBusinessPhone?.id) return true
        return desktopMessageMatchesBusinessPhone(message, selectedBusinessPhone, selectedBusinessPhoneValue)
      })
      .sort((left, right) => getMessageTimeValue(right.date) - getMessageTimeValue(left.date))[0] || null
  }, [messages, selectedBusinessPhone, selectedBusinessPhoneValue])
  const apiReplyWindowOpen = isInsideWhatsAppReplyWindow(lastInboundForSelectedPhone?.date)
  const selectedQrReady = isPhoneQrReadyForSend(selectedBusinessPhone)
  const selectedApiUnavailable = Boolean(selectedBusinessPhone && !isWhatsAppPhoneApiAvailable(selectedBusinessPhone, whatsappStatus))
  const nativeWhatsAppTransport: 'api' | 'qr' = selectedQrReady && (!whatsappConnected || selectedApiUnavailable)
    ? 'qr'
    : 'api'

  const getMessageReactionChannel = useCallback((message: DesktopChatMessage): DesktopMessageReactionChannel | null => {
    if (!activeContact) return null
    if (message.direction !== 'inbound') return null
    if (message.isComment || message.email || isHighLevelMessageTransport(message)) return null
    if (!getMessageProviderMessageId(message)) return null

    const metaPlatform = getMetaPlatformForDesktopMessage(message, activeContact)
    if (metaPlatform === 'messenger') return metaMessengerConnected ? 'messenger' : null
    if (metaPlatform === 'instagram') return metaInstagramConnected ? 'instagram' : null

    const whatsappReactionChannel = getNativeWhatsAppReactionChannel(message)
    if (!whatsappReactionChannel || !activeContact.phone) return null

    const messagePhone = getMessageBusinessPhone(message, whatsappStatus)
    const routePhone = messagePhone || selectedBusinessPhone
    if (whatsappReactionChannel === 'whatsapp_qr') {
      return isPhoneQrReadyForSend(routePhone) ? 'whatsapp_qr' : null
    }

    const fromPhone = message.businessPhone || getBusinessPhoneValue(routePhone)
    return isWhatsAppPhoneApiAvailable(routePhone, whatsappStatus) && fromPhone ? 'whatsapp_api' : null
  }, [activeContact, metaInstagramConnected, metaMessengerConnected, selectedBusinessPhone, whatsappStatus])

  useEffect(() => {
    setMessageReactionMenu(null)
  }, [activeContact?.id])

  useEffect(() => {
    if (!messageReactionMenu) return

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('[data-message-reaction-context-menu="true"]')) return
      setMessageReactionMenu(null)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMessageReactionMenu(null)
    }
    const handleScroll = () => setMessageReactionMenu(null)

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [messageReactionMenu])

  useEffect(() => {
    setCommentReplyTarget(null)
    if (!activeContact) {
      setComposerChannel('whatsapp')
      setComposerBusinessPhoneId('')
      setComposerHighLevelFromNumber('')
      setEmailSubject('')
      setEmailBodyHtml('')
      setEmailIncludeSignature(true)
      return
    }
    const defaultChannel = getDefaultComposerChannel(activeContact)
    const lastMessageTransport = String(activeContact.lastMessageTransport || '').trim().toLowerCase()
    setComposerChannel(defaultChannel)
    setComposerBusinessPhoneId(
      highLevelConnected && (
        defaultChannel === 'sms' ||
        (defaultChannel === 'whatsapp' && lastMessageTransport.startsWith('ghl_whatsapp'))
      )
        ? HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID
        : defaultComposerBusinessPhone?.id || ''
    )
    setComposerHighLevelFromNumber(defaultChannel === 'sms' ? defaultHighLevelPhoneNumber?.phoneNumber || '' : '')
    setEmailSubject('')
    setEmailBodyHtml('')
    setEmailIncludeSignature(true)
  }, [activeContact?.id, defaultComposerBusinessPhone?.id, defaultHighLevelPhoneNumber?.phoneNumber, highLevelConnected])
  useEffect(() => {
    if (!activeContact?.id || !highLevelConnected) return
    const requestId = composerChannelPreferenceRequestRef.current + 1
    composerChannelPreferenceRequestRef.current = requestId
    let cancelled = false

    void contactsService.getConversationalChannelPreference(activeContact.id)
      .then((preference) => {
        if (cancelled || composerChannelPreferenceRequestRef.current !== requestId || !preference?.channel) return
        setCommentReplyTarget(null)
        setComposerChannel(preference.channel)
        setComposerBusinessPhoneId(HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID)
        setComposerHighLevelFromNumber(
          preference.channel === 'sms' ? defaultHighLevelPhoneNumber?.phoneNumber || '' : ''
        )
      })
      .catch(() => undefined)

    return () => { cancelled = true }
  }, [activeContact?.id, defaultHighLevelPhoneNumber?.phoneNumber, highLevelConnected])
  useEffect(() => {
    setComposerBusinessPhoneId((current) => {
      if (!activeContact) return ''
      if (current === HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID && highLevelConnected) return current
      if (current && businessPhones.some((phone) => phone.id === current)) return current
      return defaultComposerBusinessPhone?.id || ''
    })
  }, [activeContact, businessPhones, defaultComposerBusinessPhone?.id, highLevelConnected])
  useEffect(() => {
    setComposerHighLevelFromNumber((current) => {
      if (!highLevelConnected || highLevelPhoneNumbers.length === 0) return ''
      if (current && highLevelPhoneNumbers.some((phone) => phone.phoneNumber === current)) return current
      return defaultHighLevelPhoneNumber?.phoneNumber || ''
    })
  }, [defaultHighLevelPhoneNumber?.phoneNumber, highLevelConnected, highLevelPhoneNumbers])
  const filteredTemplates = useMemo(() => {
    const query = templateSearch.trim().toLowerCase()
    if (!query) return templates
    return templates.filter((template) => [
      template.name,
      template.language,
      template.category,
      template.status,
      getTemplateBodyPreview(template)
    ].filter(Boolean).join(' ').toLowerCase().includes(query))
  }, [templateSearch, templates])
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
  const normalizedChatQuery = chatQuery.trim()
  const isChatQueryActive = normalizedChatQuery.length > 0
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
  const allAgentStates = useMemo(
    () => Object.values(agentStateLists).flat(),
    [agentStateLists]
  )
  const agentPriorityStates = useMemo(
    () => conversationAgentEnabled
      ? allAgentStates.filter((state) => (
        Boolean(state.signal) &&
        state.signal !== 'discarded' &&
        !['human', 'skipped', 'discarded'].includes(state.status)
      ))
      : [],
    [allAgentStates, conversationAgentEnabled]
  )
  const agentPriorityChatIdSet = useMemo(
    () => new Set(agentPriorityStates.map((state) => state.contactId)),
    [agentPriorityStates]
  )
  const agentInboxSourceChats = useMemo(() => {
    const rows = new Map<string, DesktopChatContact>()
    visibleChatsForList.forEach((contact) => {
      rows.set(contact.id, contact)
    })
    allAgentStates.forEach((state) => {
      if (!hasAgentInboxHistory(state) || rows.has(state.contactId)) return
      rows.set(state.contactId, createAgentInboxContactFromState(state))
    })
    return Array.from(rows.values())
  }, [allAgentStates, visibleChatsForList])
  const agentInboxStatusCounts = useMemo(() => {
    const counts: Record<AgentInboxStatusFilter, number> = {
      active: 0,
      completed: 0,
      paused: 0,
      skipped: 0,
      unassigned: 0
    }

	    agentInboxSourceChats.forEach((contact) => {
	      if (archivedChatIdSet.has(contact.id)) return
	      const states = agentStateLists[contact.id] || []
	      const primaryState = agentStates[contact.id]
	      if (!states.length && isAgentInboxStateVisible(primaryState, 'unassigned')) {
	        counts.unassigned += 1
	        return
	      }
	      const visibleStates = states.length ? states : [primaryState].filter(Boolean) as ConversationAgentState[]
	      if (visibleStates.some((state) => state?.status === 'active')) counts.active += 1
	      if (visibleStates.some((state) => state?.status === 'completed')) counts.completed += 1
	      if (visibleStates.some((state) => state?.status === 'paused')) counts.paused += 1
	      if (visibleStates.some((state) => isAgentInboxStateVisible(state, 'skipped'))) counts.skipped += 1
	    })

    return counts
	  }, [agentInboxSourceChats, agentStateLists, agentStates, archivedChatIdSet])
  const agentAssignedChatCount = agentInboxStatusCounts[agentInboxStatusFilter]
  const listBaseChats = useMemo(
    () => (chatFilter === 'agent' ? agentInboxSourceChats : visibleChatsForList).filter((contact) => {
	      if (chatFilter === 'agent') {
	        const states = agentStateLists[contact.id] || []
	        return !archivedChatIdSet.has(contact.id) && (
	          states.length
	            ? states.some((state) => isAgentInboxStateVisible(state, agentInboxStatusFilter))
	            : isAgentInboxStateVisible(agentStates[contact.id], agentInboxStatusFilter)
	        )
	      }
      if (archivedViewOpen) return archivedChatIdSet.has(contact.id)
      if (archivedChatIdSet.has(contact.id)) return false
      if (agentPriorityChatIdSet.has(contact.id)) return false
      return true
    }),
	    [agentInboxSourceChats, agentInboxStatusFilter, agentPriorityChatIdSet, agentStateLists, agentStates, archivedChatIdSet, archivedViewOpen, chatFilter, visibleChatsForList]
  )
  const agentAssignedViewOpen = chatFilter === 'agent'
  const hasTextOrAdvancedChatFilters = isChatQueryActive || activeAdvancedFilterCount > 0
  const hasAgentInboxStatusFilter = agentAssignedViewOpen && agentInboxStatusFilter !== DEFAULT_AGENT_INBOX_STATUS_FILTER
  const hasAgentInboxListFilters = agentAssignedViewOpen && (hasTextOrAdvancedChatFilters || hasAgentInboxStatusFilter)
  const hasActiveChatFilters = hasTextOrAdvancedChatFilters || chatFilter !== 'all' || hasAgentInboxStatusFilter
  const filteredChats = useMemo(() => {
    return listBaseChats
      .filter((contact) => (isChatQueryActive ? true : contactMatchesQuery(contact, normalizedChatQuery)))
      .filter((contact) => contactMatchesAdvancedFilters(contact, advancedFilters))
      .filter((contact) => {
        const isComment = isCommentContact(contact)
        // LENTE de Comentarios: muestra a CUALQUIER contacto que haya comentado,
        // aunque también tenga chat privado. Al abrirlo aquí solo se ven sus
        // comentarios (la conversación se filtra a comentarios más abajo).
        if (commentsView) {
          if (!contactHasCommentActivity(contact)) return false
          if (commentsPlatform === 'facebook') return getCommentPlatform(contact) === 'facebook'
          if (commentsPlatform === 'instagram') return getCommentPlatform(contact) === 'instagram'
          return true
        }
        // Vista normal: nunca mostrar los "solo comentario". En cuanto la persona
        // tiene un DM (hasPrivateDm) deja de ser "solo comentario" y aparece aquí,
        // con sus comentarios fusionados dentro de su conversación.
        if (isComment) return false
        if (chatFilter === 'agent') return true
        if (chatFilter === 'unread') return Number(contact.unreadCount || 0) > 0
        if (chatFilter === 'appointments') return Boolean(contact.hasAppointments || contact.nextAppointmentDate)
        if (chatFilter === 'customers') return contact.status === 'customer'
        return true
      })
  }, [advancedFilters, chatFilter, commentsView, commentsPlatform, isChatQueryActive, normalizedChatQuery, listBaseChats])
  const agentPriorityChatRows = useMemo(() => {
    if (archivedViewOpen || chatFilter !== 'all' || isChatQueryActive || activeAdvancedFilterCount > 0) return []
    return visibleChatsForList
      .filter((contact) => agentPriorityChatIdSet.has(contact.id) && !archivedChatIdSet.has(contact.id))
      .sort((left, right) => {
        const leftState = agentStates[left.id]
        const rightState = agentStates[right.id]
        return parseSortableDateValue(rightState?.signalAt || right.lastMessageDate || right.createdAt) -
          parseSortableDateValue(leftState?.signalAt || left.lastMessageDate || left.createdAt)
      })
  }, [activeAdvancedFilterCount, agentPriorityChatIdSet, agentStates, archivedChatIdSet, archivedViewOpen, chatFilter, isChatQueryActive, visibleChatsForList])
  const selectableChatRows = useMemo(() => {
    const rows = [...agentPriorityChatRows, ...filteredChats]
    const seen = new Set<string>()
    return rows.filter((contact) => {
      if (seen.has(contact.id)) return false
      seen.add(contact.id)
      return true
    })
  }, [agentPriorityChatRows, filteredChats])
  const selectedChatIdSet = useMemo(() => new Set(selectedChatIds), [selectedChatIds])
  const selectedChatContacts = useMemo(
    () => selectableChatRows.filter((contact) => selectedChatIdSet.has(contact.id)),
    [selectableChatRows, selectedChatIdSet]
  )
  const selectedVisibleChatCount = selectedChatContacts.length
  const allVisibleChatsSelected = selectableChatRows.length > 0 && selectedVisibleChatCount === selectableChatRows.length
  const someVisibleChatsSelected = selectedVisibleChatCount > 0 && !allVisibleChatsSelected
  const chatSelectionToggleLabel = allVisibleChatsSelected ? 'Deseleccionar todos' : 'Seleccionar todos'
  const chatSelectionToggleAriaLabel = allVisibleChatsSelected ? 'Deseleccionar todos los chats visibles' : 'Seleccionar todos los chats visibles'
  useEffect(() => {
    chatsRef.current = chats
  }, [chats])
  useEffect(() => {
    if (!selectAllChatCheckboxRef.current) return
    selectAllChatCheckboxRef.current.indeterminate = someVisibleChatsSelected
  }, [someVisibleChatsSelected])
  useEffect(() => {
    if (selectedChatIds.length === 0) return
    const selectableIds = new Set(selectableChatRows.map((contact) => contact.id))
    setSelectedChatIds((current) => current.filter((id) => selectableIds.has(id)))
  }, [selectableChatRows, selectedChatIds.length])
  useEffect(() => {
    activeContactIdRef.current = activeContactId
  }, [activeContactId])
  useEffect(() => {
    contactJourneyRef.current = contactJourney
  }, [contactJourney])
  const markChatsReadLocally = useCallback((contactIds: string[]) => {
    const idSet = new Set(contactIds.filter(Boolean))
    if (!idSet.size) return
    chatsRef.current = chatsRef.current.map((contact) => (
      idSet.has(contact.id) ? { ...contact, unreadCount: 0 } : contact
    ))
    setChats((current) => {
      const next = current.map((contact) => (
        idSet.has(contact.id) ? { ...contact, unreadCount: 0 } : contact
      ))
      chatsRef.current = next
      writeCachedChatList(next)
      return next
    })
  }, [])
  const persistChatsRead = useCallback((contactIds: string[]) => {
    const ids = [...new Set(contactIds.filter(Boolean))]
      .filter((contactId) => !chatReadRequestsRef.current.has(contactId))
    if (!ids.length) return

    const request = ids.length === 1
      ? contactsService.markChatRead(ids[0])
      : contactsService.markChatsRead(ids)

    ids.forEach((contactId) => chatReadRequestsRef.current.set(contactId, request))
    void request
      .catch((error: any) => {
        showToast('warning', 'No se pudo guardar leído', error?.message || 'El chat se marcó localmente; se corregirá al refrescar.')
      })
      .finally(() => {
        ids.forEach((contactId) => {
          if (chatReadRequestsRef.current.get(contactId) === request) {
            chatReadRequestsRef.current.delete(contactId)
          }
        })
      })
  }, [showToast])
  useEffect(() => {
    if (!activeContactId || Number(activeContact?.unreadCount || 0) <= 0) return
    markChatsReadLocally([activeContactId])
    persistChatsRead([activeContactId])
  }, [activeContact?.unreadCount, activeContactId, markChatsReadLocally, persistChatsRead])
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
    if (!composerMenuOpen && !templatePanelOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && composerMenuRef.current?.contains(target)) return
      setComposerMenuOpen(false)
      setTemplatePanelOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setComposerMenuOpen(false)
        setTemplatePanelOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [composerMenuOpen, templatePanelOpen])
  useEffect(() => {
    if (!agentComposerMenuOpen && !agentPickerOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && agentComposerMenuRef.current?.contains(target)) return
      setAgentComposerMenuOpen(false)
      setAgentPickerOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setAgentComposerMenuOpen(false)
        setAgentPickerOpen(false)
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [agentComposerMenuOpen, agentPickerOpen])
  const visibleChatCount = filteredChats.length + agentPriorityChatRows.length
  const inboxTitle = archivedViewOpen
    ? 'Archivados'
    : agentAssignedViewOpen
    ? agentInboxStatusFilter === 'active' ? 'Chats activos' : AGENT_INBOX_STATUS_FILTERS.find((filter) => filter.id === agentInboxStatusFilter)?.label || 'Chats del bot'
    : 'Conversaciones'
  const inboxSubtitle = archivedViewOpen
    ? `${filteredChats.length} de ${archivedChatCount} archivados`
    : agentAssignedViewOpen
    ? agentInboxStatusFilter === 'unassigned'
      ? `${filteredChats.length} chats que nunca han entrado al bot`
      : `${filteredChats.length} de ${agentAssignedChatCount} en esta bandeja`
    : `${visibleChatCount} de ${Math.max(0, visibleChatsForList.length - archivedChatCount)} visibles`
  const agentInboxEmptyTitle = agentInboxStatusFilter === 'paused'
    ? 'Sin chats pausados 24 horas'
    : agentInboxStatusFilter === 'skipped'
    ? 'Sin chats omitidos'
    : agentInboxStatusFilter === 'completed'
    ? 'Sin metas cumplidas'
    : agentInboxStatusFilter === 'unassigned'
    ? 'Sin chats no asignados'
    : agentInboxStatusFilter === 'active'
    ? 'Sin chats activos del bot'
    : 'Sin chats del bot'
  const agentInboxEmptyDescription = agentInboxStatusFilter === 'paused'
    ? 'Cuando pauses un chat por 24 horas, aparecerá aquí hasta que se reactive solo o lo prendas manualmente.'
    : agentInboxStatusFilter === 'skipped'
    ? 'Cuando saques un chat a humano u omitas el bot, aparecerá aquí para que puedas reactivarlo cuando quieras.'
    : agentInboxStatusFilter === 'completed'
    ? 'Cuando un contacto cumpla el objetivo configurado, quedará visible aquí.'
    : agentInboxStatusFilter === 'unassigned'
    ? 'Los contactos que nunca han entrado al chatbot aparecerán aquí.'
    : agentInboxStatusFilter === 'active'
    ? 'Cuando el bot esté atendiendo una conversación activa, aparecerá aquí.'
    : conversationAgentEnabled
    ? 'Cuando el bot atienda, pause, omita o cierre una conversación, aparecerá aquí.'
    : 'Cuando enciendas el chatbot y tome chats, aparecerán aquí.'
  const emptyChatTitle = archivedViewOpen
    ? 'No hay chats archivados'
    : agentAssignedViewOpen
    ? hasAgentInboxListFilters && hasTextOrAdvancedChatFilters ? 'No encontré chats del bot' : agentInboxEmptyTitle
    : hasActiveChatFilters ? 'No encontré chats' : chats.length === 0 ? 'Todavía no hay conversaciones' : 'No hay chats en esta vista'
  const emptyChatDescription = archivedViewOpen
    ? 'Cuando archives una conversación, aparecerá en esta sección.'
    : agentAssignedViewOpen
    ? hasTextOrAdvancedChatFilters
      ? 'Prueba con menos filtros o busca otro contacto atendido por el bot.'
      : agentInboxEmptyDescription
    : hasActiveChatFilters
    ? 'Prueba con menos filtros o busca otro contacto.'
    : chats.length === 0
    ? 'Cuando lleguen mensajes, aparecerán aquí con su canal, estado y último movimiento.'
    : 'Cuando llegue un mensaje nuevo, aparecerá aquí.'
  const resetChatFiltersLabel = agentAssignedViewOpen && !hasAgentInboxListFilters ? 'Volver a conversaciones' : 'Limpiar filtros'
  const bulkArchiveActionLabel = archivedViewOpen ? 'Restaurar todos' : 'Archivar todos'
  const bulkArchiveConfirmWord = archivedViewOpen ? BULK_CHAT_RESTORE_CONFIRM_WORD : BULK_CHAT_ARCHIVE_CONFIRM_WORD
  const bulkArchiveConfirmTitle = archivedViewOpen ? 'Restaurar chats seleccionados' : 'Archivar chats seleccionados'
  const bulkArchiveConfirmMessage = archivedViewOpen
    ? `${selectedVisibleChatCount} chat${selectedVisibleChatCount === 1 ? '' : 's'} volverá${selectedVisibleChatCount === 1 ? '' : 'n'} a la bandeja principal.`
    : `${selectedVisibleChatCount} chat${selectedVisibleChatCount === 1 ? '' : 's'} se moverá${selectedVisibleChatCount === 1 ? '' : 'n'} a Archivados.`
  const bulkRemoveConfirmMessage = `${selectedVisibleChatCount} chat${selectedVisibleChatCount === 1 ? '' : 's'} se ocultará${selectedVisibleChatCount === 1 ? '' : 'n'} de esta lista. El historial no se borra y volverá${selectedVisibleChatCount === 1 ? '' : 'n'} si llega un mensaje nuevo.`
  const showBulkAgentAssignmentActions = !agentAssignedViewOpen && !archivedViewOpen
  const bulkSelectionMenuDescription = agentAssignedViewOpen
    ? 'Gestiona los chats atendidos por el bot.'
    : showBulkAgentAssignmentActions
    ? 'Gestiona estos chats o mándalos a un agente.'
    : 'Gestiona estos chats sin abrirlos uno por uno.'
  const conversationActivityMarkers = useMemo(
    () => commentsView
      ? []
      : buildChatActivityMarkers(activeContactId, contactJourney, timezone, accountCurrency),
    [accountCurrency, activeContactId, commentsView, contactJourney, timezone]
  )
  const conversationTimelineGroups = useMemo(() => {
    // Bajo la lente de Comentarios se ven SOLO los comentarios de la persona (no
    // la conversación privada ni eventos del agente).
    const timelineMessages = commentsView ? messages.filter((message) => message.isComment) : messages
    const timelineCompletions = commentsView ? [] : agentCompletionEvents
    const items: DesktopConversationTimelineItem[] = [
      ...timelineMessages.map((message) => ({
        type: 'message' as const,
        id: `message-${message.id}`,
        date: message.date,
        message
      })),
      ...timelineCompletions.map((completion) => ({
        type: 'agentCompletion' as const,
        id: `agent-completion-${completion.id}`,
        date: completion.createdAt,
        completion
      })),
      ...conversationActivityMarkers.map((marker) => ({
        type: 'activity' as const,
        id: `activity-${marker.kind}-${marker.id}`,
        date: marker.date,
        marker
      }))
    ].sort((left, right) => {
      return parseSortableDateValue(left.date) - parseSortableDateValue(right.date)
    })
    const groups: Array<{ key: string; label: string; items: DesktopConversationTimelineItem[] }> = []
    items.forEach((item) => {
      const key = getConversationDayKey(item.date, timezone) || 'unknown'
      const current = groups[groups.length - 1]
      if (!current || current.key !== key) {
        groups.push({ key, label: getConversationDayLabel(item.date, timezone), items: [item] })
        return
      }
      current.items.push(item)
    })
    return groups
  }, [agentCompletionEvents, conversationActivityMarkers, messages, timezone, commentsView])
  const latestEligibleCommentReplyTarget = useMemo(() => getLatestEligibleCommentReplyTarget(messages), [messages])
  const selectedCommentReplyTarget = commentReplyTarget || (isCommentComposerChannel(composerChannel) ? latestEligibleCommentReplyTarget : null)
  const selectedCommentComposerPlatform = isCommentComposerChannel(composerChannel)
    ? getCommentComposerPlatform(composerChannel)
    : selectedCommentReplyTarget?.platform || null
  const detectedComposerChannel = normalizeComposerChannel(activeContact?.lastMessageChannel || activeContact?.lastMessageTransport || messages[messages.length - 1]?.transport || '')
  const activeConversationChannel = getHighLevelChannelForComposer(composerChannel)
  const hasEmailAccess = hasLicenseFeature(user, ['email'])
  const hasAutomationsAccess = hasLicenseFeature(user, ['automations'])
  const isEmailComposer = composerChannel === 'email'
  const emailPlainText = useMemo(
    () => isEmailComposer ? emailHtmlToPlainText(emailBodyHtml) : '',
    [emailBodyHtml, isEmailComposer]
  )
  const hasDetectedMessenger = detectedComposerChannel === 'messenger' || (
    Boolean(activeContact) &&
    contactHasCommentActivity(activeContact) &&
    getCommentPlatform(activeContact) === 'facebook'
  )
  const hasDetectedInstagram = detectedComposerChannel === 'instagram' || (
    Boolean(activeContact) &&
    contactHasCommentActivity(activeContact) &&
    getCommentPlatform(activeContact) === 'instagram'
  )
  const whatsappComposerPhones = businessPhones.length
    ? businessPhones
    : selectedBusinessPhone
    ? [selectedBusinessPhone]
    : []
  const whatsappApiSourcesAvailable = hasWhatsAppPhoneApiAvailable(whatsappStatus)
  const whatsappNativeSourcesAvailable = whatsappComposerPhones.some((phone) => (
    Boolean(getBusinessPhoneValue(phone)) && (isPhoneApiEnabled(phone, whatsappStatus) || isPhoneQrReadyForSend(phone))
  ))
  const canSendMessenger = metaMessengerConnected || highLevelConnected
  const canSendInstagram = metaInstagramConnected || highLevelConnected
  const activeContactRecord = (activeContact || {}) as Record<string, unknown>
  const latestSelectedSocialMessage = [...messages].reverse().find((message) => (
    !message.isComment &&
    message.direction !== 'system' &&
    getSocialPlatformForDesktopMessage(message) === composerChannel
  ))
  const contactLastSocialProbe = normalizeFilterProbe([
    activeContact?.lastMessageChannel,
    activeContact?.lastMessageTransport
  ])
  const contactLastSocialPlatform = contactLastSocialProbe.includes('instagram')
    ? 'instagram'
    : contactLastSocialProbe.includes('messenger') || contactLastSocialProbe.includes('facebook')
      ? 'messenger'
      : null
  const contactLastTransportUsesHighLevel = contactLastSocialPlatform === composerChannel &&
    String(activeContact?.lastMessageTransport || '').trim().toLowerCase().startsWith('ghl_')
  const activeSocialConversationUsesHighLevel = latestSelectedSocialMessage
    ? isHighLevelMessageTransport(latestSelectedSocialMessage)
    : contactLastTransportUsesHighLevel
  const contactHasNativeMetaProfile = (platform: 'messenger' | 'instagram') => {
    const field = platform === 'instagram' ? 'hasMetaInstagramProfile' : 'hasMetaMessengerProfile'
    if (typeof activeContactRecord[field] === 'boolean') return Boolean(activeContactRecord[field])
    return messages.some((message) => !isHighLevelMessageTransport(message) && getMetaPlatformForDesktopMessage(message, activeContact) === platform)
  }
  const activeNativeMetaChannel: 'messenger' | 'instagram' | null = composerChannel === 'messenger' && metaMessengerConnected && contactHasNativeMetaProfile('messenger') && !activeSocialConversationUsesHighLevel
    ? 'messenger'
    : composerChannel === 'instagram' && metaInstagramConnected && contactHasNativeMetaProfile('instagram') && !activeSocialConversationUsesHighLevel
      ? 'instagram'
      : null
  const socialVoiceChannelReady = Boolean(
    activeNativeMetaChannel ||
    ((composerChannel === 'messenger' || composerChannel === 'instagram') && highLevelConnected)
  )
  const highLevelPhoneVoiceChannelReady = Boolean(
    highLevelConnected && (
      composerChannel === 'sms' ||
      (composerChannel === 'whatsapp' && !selectedBusinessPhone)
    )
  )
  const canSendSelectedCommentPlatform = selectedCommentComposerPlatform === 'instagram'
    ? Boolean(metaInstagramConnected && instagramCommentsEnabled)
    : selectedCommentComposerPlatform === 'messenger'
      ? Boolean(metaMessengerConnected && facebookCommentsEnabled)
      : false
  const emailChannelConnected = highLevelConnected || emailConnected
  const commentChannelOption = latestEligibleCommentReplyTarget
    ? {
        value: getCommentComposerChannelForPlatform(latestEligibleCommentReplyTarget.platform),
        label: getCommentComposerLabel(latestEligibleCommentReplyTarget.platform)
      }
    : null
  const baseComposerChannelOptions = commentChannelOption
    ? [commentChannelOption, ...COMPOSER_CHANNEL_OPTIONS]
    : COMPOSER_CHANNEL_OPTIONS
  const composerChannelOptions = baseComposerChannelOptions.flatMap((option) => {
    if (isCommentComposerChannel(option.value)) {
      const platform = getCommentComposerPlatform(option.value)
      const commentsEnabled = platform === 'instagram' ? instagramCommentsEnabled : facebookCommentsEnabled
      const metaConnected = platform === 'instagram' ? metaInstagramConnected : metaMessengerConnected
      return [{
        ...option,
        icon: renderComposerChannelIcon(option.value),
        disabled: !latestEligibleCommentReplyTarget || !commentsEnabled || !metaConnected
      }]
    }
    if (option.value === 'whatsapp') {
      const whatsappDisabled = !activeContact?.phone
      const nativeWhatsAppOptions = whatsappComposerPhones.map((phone) => ({
        value: `whatsapp:${phone.id}`,
        label: getNativeWhatsAppRouteLabel(phone),
        icon: renderComposerChannelIcon(option.value),
        disabled: whatsappDisabled || !getBusinessPhoneValue(phone) || (!isPhoneApiEnabled(phone, whatsappStatus) && !isPhoneQrReadyForSend(phone))
      }))
      return [
        ...nativeWhatsAppOptions,
        {
          value: HIGHLEVEL_WHATSAPP_COMPOSER_VALUE,
          label: getHighLevelWhatsAppRouteLabel(highLevelWhatsAppSender),
          icon: renderComposerChannelIcon(option.value),
          disabled: whatsappDisabled || !highLevelConnected
        }
      ]
    }
    if (option.value === 'sms') {
      const highLevelSmsOptions = highLevelPhoneNumbers.map((phone) => ({
        value: `${HIGHLEVEL_SMS_COMPOSER_VALUE_PREFIX}${phone.id}`,
        label: `SMS · ${phone.label} · ${phone.phoneNumber}`,
        icon: renderComposerChannelIcon(option.value),
        disabled: !activeContact?.phone || !highLevelConnected
      }))
      return highLevelSmsOptions.length > 0
        ? highLevelSmsOptions
        : [{
            ...option,
            icon: renderComposerChannelIcon(option.value),
            disabled: !activeContact?.phone || !highLevelConnected
          }]
    }
    if (option.value === 'email') {
      if (!hasEmailAccess) return []
      return [{
        ...option,
        icon: renderComposerChannelIcon(option.value),
        disabled: !activeContact?.email || !emailChannelConnected
      }]
    }
    return [{
      ...option,
      icon: renderComposerChannelIcon(option.value),
      disabled: option.value === 'messenger'
        ? !hasDetectedMessenger || !canSendMessenger
        : !hasDetectedInstagram || !canSendInstagram
    }]
  })
  const composerRouteValue = composerChannel === 'whatsapp'
    ? composerBusinessPhoneId === HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID
      ? HIGHLEVEL_WHATSAPP_COMPOSER_VALUE
      : selectedBusinessPhone?.id
        ? `whatsapp:${selectedBusinessPhone.id}`
        : highLevelConnected
          ? HIGHLEVEL_WHATSAPP_COMPOSER_VALUE
          : composerChannel
    : composerChannel === 'sms' && selectedHighLevelPhoneNumber
      ? `${HIGHLEVEL_SMS_COMPOSER_VALUE_PREFIX}${selectedHighLevelPhoneNumber.id}`
      : composerChannel
  const composerChannelReady = isEmailComposer
    ? Boolean(hasEmailAccess && activeContact?.email && emailChannelConnected)
    : isCommentComposerChannel(composerChannel)
    ? Boolean(selectedCommentReplyTarget && canSendSelectedCommentPlatform)
    : composerChannel === 'whatsapp'
    ? Boolean(activeContact?.phone && (
      selectedBusinessPhone
        ? whatsappConnected || selectedQrReady
        : highLevelConnected
    ))
    : composerChannel === 'sms'
    ? Boolean(activeContact?.phone && highLevelConnected)
    : composerChannel === 'messenger'
    ? Boolean(hasDetectedMessenger && canSendMessenger)
    : Boolean(hasDetectedInstagram && canSendInstagram)
  const composerChannelHint = !activeContact
    ? ''
    : isEmailComposer && !hasEmailAccess
    ? 'El correo no está incluido en los accesos de esta cuenta.'
    : isEmailComposer && !activeContact.email
    ? 'Este contacto no tiene correo guardado.'
    : isEmailComposer && !emailChannelConnected
    ? 'Conecta HighLevel o tu correo de envío en Configuración > Correos.'
    : composerChannel === 'whatsapp' && !activeContact.phone
    ? 'Este contacto no tiene teléfono guardado.'
    : composerChannel === 'sms' && !activeContact.phone
    ? 'Este contacto no tiene teléfono guardado.'
    : composerChannel === 'sms' && !highLevelConnected
    ? 'Conecta HighLevel para enviar SMS.'
    : composerChannel === 'whatsapp' && selectedBusinessPhone && !whatsappConnected && !selectedQrReady
    ? selectedBusinessPhone.availability?.apiReason || 'El WhatsApp seleccionado no tiene una conexión disponible para enviar.'
    : composerChannel === 'whatsapp' && whatsappApiSourcesAvailable && !selectedBusinessPhoneValue && !highLevelConnected
    ? 'Elige una caja de WhatsApp para responder.'
    : composerChannel === 'whatsapp' && !whatsappNativeSourcesAvailable && !highLevelConnected
    ? 'Conecta WhatsApp API o QR para responder desde Ristak.'
    : isCommentComposerChannel(composerChannel) && !selectedCommentReplyTarget
    ? 'Para responder en la publicación elige el comentario exacto.'
    : isCommentComposerChannel(composerChannel) && selectedCommentComposerPlatform === 'messenger' && !facebookCommentsEnabled
    ? 'Activa comentarios de Facebook en Configuración > Meta > Redes sociales.'
    : isCommentComposerChannel(composerChannel) && selectedCommentComposerPlatform === 'instagram' && !instagramCommentsEnabled
    ? 'Activa comentarios de Instagram en Configuración > Meta > Redes sociales.'
    : isCommentComposerChannel(composerChannel) && !canSendSelectedCommentPlatform
    ? 'Conecta Meta para responder comentarios desde Ristak.'
    : composerChannel === 'messenger' && !hasDetectedMessenger
    ? 'Este contacto no tiene Messenger detectado.'
    : composerChannel === 'instagram' && !hasDetectedInstagram
    ? 'Este contacto no tiene Instagram detectado.'
    : composerChannel === 'messenger' && !canSendMessenger
    ? 'Activa Messenger en Configuración > Meta para responder desde Ristak.'
    : composerChannel === 'instagram' && !canSendInstagram
    ? 'Activa Instagram en Configuración > Meta para responder desde Ristak.'
    : ''
  const hasComposerContent = isEmailComposer
    ? Boolean(emailSubject.trim() && emailPlainText.trim())
    : Boolean(composerText.trim()) || draftAttachments.length > 0 || Boolean(voiceDraft)
  const canSend = Boolean(activeContact && composerChannelReady && hasComposerContent && composerStatus === 'idle' && !voiceRecording && !voiceProcessing)
  useEffect(() => {
    if (hasEmailAccess || composerChannel !== 'email') return
    setComposerChannel('whatsapp')
  }, [composerChannel, hasEmailAccess])
  useEffect(() => {
    if (!isEmailComposer || emailBodyHtml.trim() || !composerText.trim()) return
    setEmailBodyHtml(plainTextToEmailHtml(composerText))
  }, [composerText, emailBodyHtml, isEmailComposer])
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
	    ? CONVERSATION_AGENT_STATUS_LABELS[conversationAgentState.status] || 'Chatbot'
	    : 'Sin agente asignado'
  const activeContactAgentStates = useMemo(
    () => {
      if (!activeContact?.id) return []
      const states = agentStateLists[activeContact.id] || []
      return getAssignedConversationAgentStates(
        states.length ? states : (conversationAgentState ? [conversationAgentState] : [])
      )
    },
    [activeContact?.id, agentStateLists, conversationAgentState]
  )
  const activeManualAgentStates = useMemo(
    () => activeContactAgentStates.filter((state) => state.agentId && state.status === 'active'),
    [activeContactAgentStates]
  )
  const conversationAgentPaused = activeManualAgentStates.length === 0
    && activeContactAgentStates.some((state) => state.status === 'paused')
  const manualAgentSendLabel = useMemo(() => {
    if (activeManualAgentStates.length === 1) {
      const state = activeManualAgentStates[0]
      return state.agentName || agentDefs.find((agent) => agent.id === state.agentId)?.name || 'el chatbot'
    }
    return `${activeManualAgentStates.length} chatbots`
  }, [activeManualAgentStates, agentDefs])
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
      options: stageFilterOptions,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, stage: value as AdvancedStageFilter }))
    },
    {
      id: 'activity',
      label: 'Actividad',
      value: advancedFilters.activity,
      options: ACTIVITY_FILTER_OPTIONS,
      onSelect: (value: string) => setAdvancedFilters((current) => ({ ...current, activity: value as AdvancedActivityFilter }))
    }
  ]), [advancedFilters, stageFilterOptions])

  const loadChats = useCallback(async (options: { silent?: boolean; append?: boolean; search?: string } = {}) => {
    const silent = options.silent === true
    const append = options.append === true
    const normalizedSearch = String(options.search ?? chatQuery).trim()
    const hasSearch = normalizedSearch.length > 0
    const cursorScope = normalizedSearch.toLocaleLowerCase('es-MX')
    const appendCursor = chatListCursorRef.current

    if (append) {
      // El load-more usa su propio controller y solo se bloquea por otro load-more en curso o
      // porque ya no hay más. NO lo bloquea la carga inicial ni los refrescos: dispara de
      // inmediato al llegar al fondo.
      if (chatListLoadingMoreRef.current || !chatListHasMoreRef.current) return
      if (!appendCursor || appendCursor.scope !== cursorScope) return
    } else if (silent && chatsRequestRef.current) {
      return
    }

    if (!append) {
      setChatsError('')
      // Loader de pantalla completa solo si todavía no hay nada que mostrar.
      if (chatsRef.current.length === 0 || hasSearch) {
        setChatsLoading(true)
      }
      // Coalescamos cargas no-append concurrentes. La recarga explícita trae una sola página
      // y conserva el cursor profundo cuando el usuario ya reveló más historial.
      chatsRequestRef.current?.abort()
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), CHAT_REQUEST_TIMEOUT_MS)
    if (append) {
      chatListLoadMoreRequestRef.current = controller
      chatListLoadingMoreRef.current = true
      setIsLoadingMoreChats(true)
    } else {
      chatsRequestRef.current = controller
    }

    const fetchChatPage = async (cursor: ChatListKeysetCursor | null) => {
      const data = await apiClient.get<DesktopChatContact[]>('/contacts/chats', {
        params: {
          limit: String(CHAT_LIST_PAGE_SIZE),
          ...(cursor ? {
            beforeMessageDate: cursor.beforeMessageDate,
            ...(cursor.beforeMessageSort ? { beforeMessageSort: cursor.beforeMessageSort } : {}),
            ...(cursor.beforeMessageScope ? { beforeMessageScope: cursor.beforeMessageScope } : {}),
            beforeContactId: cursor.beforeContactId
          } : {}),
          ...(hasSearch ? { q: normalizedSearch } : {})
        },
        signal: controller.signal
      })
      return dedupeChatsById(Array.isArray(data) ? data : [])
    }

    try {
      if (append) {
        const cursor = appendCursor as ChatListKeysetCursor
        const pageChats = await fetchChatPage(cursor)
        // Si una recarga cambió la frontera mientras esperaba este lote, se descarta. Aplicarlo
        // mezclaría dos snapshots y podría saltar conversaciones.
        if (controller.signal.aborted || chatListLoadMoreRequestRef.current !== controller || chatListCursorRef.current !== cursor) return
        const nextCursor = getChatListKeysetCursor(pageChats, cursorScope)
        const cursorAdvanced = didChatListCursorAdvance(cursor, nextCursor)
        if (nextCursor) chatListCursorRef.current = nextCursor
        if (pageChats.length > 0) chatListHasAppendedRef.current = true
        chatListHasMoreRef.current = pageChats.length >= CHAT_LIST_PAGE_SIZE && cursorAdvanced
        setChats((currentChats) => dedupeChatsById([...currentChats, ...pageChats]))
      } else if (hasSearch) {
        const pageChats = await fetchChatPage(null)

        if (chatsRequestRef.current !== controller) return

        chatListLoadedSearchRef.current = normalizedSearch
        chatListCursorRef.current = getChatListKeysetCursor(pageChats, cursorScope)
        chatListHasAppendedRef.current = false
        chatListHasMoreRef.current = pageChats.length >= CHAT_LIST_PAGE_SIZE && Boolean(chatListCursorRef.current)
        setRemovedChatStates((current) => pruneRevealedRemovedChatStates(current, pageChats))
        setChats(pageChats)
        setActiveContactId((current) => {
          const removedStates = removedChatStatesRef.current
          if (current && pageChats.some((contact) => contact.id === current && !isChatRemovedFromList(contact, getRemovedChatState(removedStates, contact.id)))) {
            return current
          }
          const archivedSet = archivedChatIdSetRef.current
          const agentSet = agentPriorityChatIdSetRef.current
          return getDefaultActiveChatId(pageChats, archivedSet, agentSet, removedStates)
        })
      } else if (silent) {
        // Refresco en segundo plano: NO recortar ni reconstruir la lista entera (eso causa
        // tirones de scroll). Traemos solo la primera página (lo más reciente) y la fusionamos
        // sobre los chats ya cargados, conservando la cola que el usuario reveló con scroll.
        // El cursor sólo avanza por páginas reales traídas del servidor; el caché no cuenta.
        const freshPage = await fetchChatPage(null)
        if (chatsRequestRef.current !== controller) return

        const currentCursor = chatListCursorRef.current
        const preserveDeepCursor = Boolean(
          chatListHasAppendedRef.current && currentCursor?.scope === cursorScope
        )
        const freshCursor = getChatListKeysetCursor(freshPage, cursorScope)
        if (!preserveDeepCursor) {
          chatListCursorRef.current = freshCursor
          chatListHasAppendedRef.current = false
        }
        chatListHasMoreRef.current = (
          freshPage.length >= CHAT_LIST_PAGE_SIZE && Boolean(freshCursor)
        ) || (preserveDeepCursor && chatListHasMoreRef.current)
        // setChats funcional: fusionamos sobre el estado MÁS reciente para no pisar un
        // "cargar más" que pudiera estar corriendo en paralelo.
        setChats((current) => dedupeChatsById([
          ...freshPage,
          ...reconcileCachedChatTail(freshPage, current, CHAT_LIST_PAGE_SIZE)
        ]))
        const mergedForCache = dedupeChatsById([
          ...freshPage,
          ...reconcileCachedChatTail(freshPage, chatsRef.current, CHAT_LIST_PAGE_SIZE)
        ])
        writeCachedChatList(mergedForCache)
        setRemovedChatStates((current) => pruneRevealedRemovedChatStates(current, mergedForCache))
      } else {
        // Carga inicial / refresco / al limpiar la búsqueda: UNA sola página rápida fusionada
        // sobre lo ya mostrado (caché). Sin bucle multi-página y sin bloquear el "cargar más",
        // por lo que la lista aparece al instante y se rellena al hacer scroll.
        const freshPage = await fetchChatPage(null)
        if (chatsRequestRef.current !== controller) return

        // Si veníamos de una búsqueda, REEMPLAZAMOS (no fusionamos sobre esos resultados).
        const fromSearch = chatListLoadedSearchRef.current !== ''
        chatListLoadedSearchRef.current = ''
        const merged = dedupeChatsById([
          ...freshPage,
          ...(fromSearch ? [] : reconcileCachedChatTail(freshPage, chatsRef.current, CHAT_LIST_PAGE_SIZE))
        ])

        // La frontera keyset representa la última página real, no las filas del caché.
        const currentCursor = chatListCursorRef.current
        const preserveDeepCursor = Boolean(
          !fromSearch && chatListHasAppendedRef.current && currentCursor?.scope === cursorScope
        )
        const freshCursor = getChatListKeysetCursor(freshPage, cursorScope)
        if (!preserveDeepCursor) {
          chatListCursorRef.current = freshCursor
          chatListHasAppendedRef.current = false
        }
        chatListHasMoreRef.current = (
          freshPage.length >= CHAT_LIST_PAGE_SIZE && Boolean(freshCursor)
        ) || (preserveDeepCursor && chatListHasMoreRef.current)
        writeCachedChatList(merged)
        setRemovedChatStates((current) => pruneRevealedRemovedChatStates(current, merged))
        // setChats funcional: no pisar un "cargar más" que el usuario haya disparado al hacer
        // scroll mientras llegaba esta primera página.
        setChats((current) => dedupeChatsById([
          ...freshPage,
          ...(fromSearch ? [] : reconcileCachedChatTail(freshPage, current, CHAT_LIST_PAGE_SIZE))
        ]))
        setActiveContactId((current) => {
          const removedStates = removedChatStatesRef.current
          if (current && merged.some((contact) => contact.id === current && !isChatRemovedFromList(contact, getRemovedChatState(removedStates, contact.id)))) {
            return current
          }
          const archivedSet = archivedChatIdSetRef.current
          const agentSet = agentPriorityChatIdSetRef.current
          return getDefaultActiveChatId(merged, archivedSet, agentSet, removedStates)
        })
      }
    } catch (error: any) {
      if (controller.signal.aborted && chatsRequestRef.current !== controller) return
      if (append && Number(error?.status) === 400 && chatListCursorRef.current === appendCursor) {
        chatListCursorRef.current = null
        chatListHasAppendedRef.current = false
        chatListHasMoreRef.current = true
        window.setTimeout(() => void loadChats({ silent: true }), 0)
        return
      }
      if (!silent && !append) {
        const timedOut = controller.signal.aborted || error?.name === 'AbortError'
        if (chatsRef.current.length === 0 || hasSearch) {
          setChatsError(timedOut ? 'Los chats tardaron demasiado en cargar. Intenta otra vez.' : 'No se pudieron cargar los chats.')
          setChats([])
        }
      }
    } finally {
      window.clearTimeout(timeoutId)
      if (append) {
        if (chatListLoadMoreRequestRef.current === controller) {
          chatListLoadMoreRequestRef.current = null
        }
        chatListLoadingMoreRef.current = false
        setIsLoadingMoreChats(false)
      } else {
        if (chatsRequestRef.current === controller) {
          chatsRequestRef.current = null
        }
        setChatsLoading(false)
      }
    }
  }, [chatQuery])

  const loadMoreChatsIfNeeded = useCallback((event?: React.UIEvent<HTMLDivElement>) => {
    if (chatListLoadingMoreRef.current || !chatListHasMoreRef.current) return
    const pane = event?.currentTarget || chatListRef.current
    if (!pane) return

    // Prefetch anticipado: disparamos varias pantallas antes del fondo, así el
    // siguiente lote llega antes de que el usuario lo alcance y el scroll nunca se "traba".
    const prefetchDistance = Math.max(CHAT_LIST_AUTO_LOAD_GAP_PX, pane.clientHeight * CHAT_LIST_PREFETCH_VIEWPORTS)
    const bottomGap = pane.scrollHeight - pane.scrollTop - pane.clientHeight
    if (bottomGap > prefetchDistance) return

    void loadChats({ silent: true, append: true })
  }, [loadChats])

  useEffect(() => {
    if (chatListLoadingMoreRef.current || !chatListHasMoreRef.current) return
    const list = chatListRef.current
    if (!list) return
    // Sólo anticipamos el siguiente lote cuando la lista no llena la pantalla o el
    // usuario ya está cerca del fondo. Evita descargar cinco páginas al abrir Chats.
    const prefetchDistance = Math.max(CHAT_LIST_AUTO_LOAD_GAP_PX, list.clientHeight * CHAT_LIST_PREFETCH_VIEWPORTS)
    const bottomGap = list.scrollHeight - list.scrollTop - list.clientHeight
    if (list.scrollHeight <= list.clientHeight + CHAT_LIST_AUTO_LOAD_GAP_PX || bottomGap <= prefetchDistance) {
      void loadChats({ silent: true, append: true })
    }
  }, [chats.length, loadChats])

  const loadConversation = useCallback((
    contactId: string,
    options: { silent?: boolean; useCache?: boolean; showCacheRefresh?: boolean } = {}
  ): Promise<void> => {
    if (!contactId) return Promise.resolve()
    const silent = options.silent === true
    return conversationRequestCoordinator.run(
      contactId,
      silent ? 'background' : 'foreground',
      async (signal) => {
    const loadGeneration = conversationLoadGenerationRef.current + 1
    conversationLoadGenerationRef.current = loadGeneration
    const isCurrentConversationLoad = () => (
      conversationLoadGenerationRef.current === loadGeneration &&
      activeContactIdRef.current === contactId &&
      !signal.aborted
    )
    const useCache = options.useCache !== false && !silent
    const shouldRefreshActivityJourney = !silent || Date.now() - conversationActivityLoadedAtRef.current >= CHAT_ACTIVITY_REFRESH_INTERVAL_MS
    if (!silent) {
      conversationHistoryExhaustedContactIdRef.current = null
      olderMessagesLoadingRef.current = false
      conversationHasOlderMessagesRef.current = false
      setOlderMessagesLoading(false)
    }
    const cachedConversation = useCache ? readCachedConversation(locationId, contactId) : null
    const showedCachedConversation = Boolean(cachedConversation)

    if (cachedConversation) {
      contactJourneyRef.current = cachedConversation.journey
      setContactJourney((current) => (
        areJourneyEventsEquivalent(current, cachedConversation.journey) ? current : cachedConversation.journey
      ))
      setMessages((current) => (
        (() => {
          const nextMessages = mergeDesktopMessagesWithOptimistic(cachedConversation.messages, current)
          return areDesktopMessagesEquivalent(current, nextMessages) ? current : nextMessages
        })()
      ))
      setAgentCompletionEvents(cachedConversation.agentCompletions)
      setContactInfoData(cachedConversation.contactInfo)
      setConversationAgentState(cachedConversation.agentState)
      if (cachedConversation.agentState) {
        setAgentStates((current) => ({ ...current, [contactId]: cachedConversation.agentState as ConversationAgentState }))
        setAgentStateLists((current) => ({ ...current, [contactId]: [cachedConversation.agentState as ConversationAgentState] }))
      }
      setMessagesLoading(false)
      setContactInfoLoading(options.showCacheRefresh !== false)
      setMessagesRefreshing(options.showCacheRefresh !== false)
      conversationHasOlderMessagesRef.current = cachedConversation.journey.filter(isConversationJourneyMessage).length >= CHAT_CONVERSATION_MESSAGE_LIMIT &&
        conversationHistoryExhaustedContactIdRef.current !== contactId
    } else if (!silent) {
      setMessages([])
      setAgentCompletionEvents([])
      setContactJourney([])
      contactJourneyRef.current = []
      setContactInfoData(null)
      setMessagesRefreshing(false)
      setMessagesLoading(true)
      setContactInfoLoading(true)
      setConversationAgentState(null)
      olderMessagesLoadingRef.current = false
      conversationHasOlderMessagesRef.current = false
      setOlderMessagesLoading(false)
    }
    setMessagesError('')
    let messagesLoaded = false
    const activityJourneyPromise = shouldRefreshActivityJourney
      ? contactsService.getContactJourney(contactId, {
        refreshExternalStatuses: false,
        throwOnError: true,
        chatActivityOnly: true,
        signal
      })
        .then((events) => ({ events, loaded: true }))
        .catch(() => ({ events: [] as JourneyEvent[], loaded: false }))
      : Promise.resolve({ events: [] as JourneyEvent[], loaded: false })
    const scheduledMessagesPromise = whatsappApiService.getScheduledMessages(contactId, { signal }).catch(() => [])
    try {
      // La conversación es la ruta crítica. Programados, perfil, agente y
      // marcadores se hidratan después sin retener el primer paint.
      const journey = await contactsService.getContactConversation(contactId, {
        refreshExternalStatuses: false,
        messageLimit: CHAT_CONVERSATION_MESSAGE_LIMIT,
        throwOnError: true,
        signal
      })
      if (!isCurrentConversationLoad()) return

      const receivedFullPage = journey.filter(isConversationJourneyMessage).length >= CHAT_CONVERSATION_MESSAGE_LIMIT
      conversationHasOlderMessagesRef.current = receivedFullPage &&
        conversationHistoryExhaustedContactIdRef.current !== contactId
      const cachedActivityEvents = contactJourneyRef.current.filter(isChatActivityEvent)
      const nextJourney = silent
        ? mergeJourneyEvents(contactJourneyRef.current, journey)
        : mergeJourneyEvents(journey, cachedActivityEvents)
      contactJourneyRef.current = nextJourney
      const nextMessages = buildConversationMessages(nextJourney, [])
      setContactJourney((current) => (
        areJourneyEventsEquivalent(current, nextJourney) ? current : nextJourney
      ))
      setMessages((current) => (
        (() => {
          const mergedMessages = mergeDesktopConversationMessagesWithCurrent(nextMessages, current)
          return areDesktopMessagesEquivalent(current, mergedMessages) ? current : mergedMessages
        })()
      ))
      messagesLoaded = true
      setMessagesLoading(false)
      setMessagesRefreshing(false)

      const [scheduledMessages, details, contactAgentStates, agentCompletions, activityJourney] = await Promise.all([
        scheduledMessagesPromise,
        contactsService.getContactDetails(contactId, {
          warmProfilePictures: false,
          refreshExternalAppointments: false,
          signal
        }).catch(() => null),
        conversationalAgentService.getStates(contactId, { signal }).catch(() => [] as ConversationAgentState[]),
        conversationalAgentService.listCompletionEvents({ contactId, limit: 20 }, { signal }).catch(() => []),
        activityJourneyPromise
      ])
      if (!isCurrentConversationLoad()) return

      const agentState = selectPrimaryAgentState(contactAgentStates)
      const activityEvents = activityJourney.events.filter(isChatActivityEvent)
      const canonicalJourney = activityJourney.loaded
        ? mergeJourneyEvents(
            nextJourney.filter((event) => !isChatActivityEvent(event)),
            activityEvents
          )
        : nextJourney
      const canonicalMessages = buildConversationMessages(canonicalJourney, scheduledMessages)
      if (shouldRefreshActivityJourney) conversationActivityLoadedAtRef.current = Date.now()
      contactJourneyRef.current = canonicalJourney
      setAgentCompletionEvents(agentCompletions)
      setContactJourney((current) => (
        areJourneyEventsEquivalent(current, canonicalJourney) ? current : canonicalJourney
      ))
      setMessages((current) => (
        (() => {
          const mergedMessages = mergeDesktopConversationMessagesWithCurrent(canonicalMessages, current)
          return areDesktopMessagesEquivalent(current, mergedMessages) ? current : mergedMessages
        })()
      ))
      setContactInfoData(details)
      setConversationAgentState(agentState)
      setAgentStates((current) => (agentState ? { ...current, [contactId]: agentState } : current))
      setAgentStateLists((current) => ({ ...current, [contactId]: contactAgentStates }))
      writeCachedConversation(locationId, contactId, {
        journey: canonicalJourney,
        messages: canonicalMessages,
        agentCompletions,
        contactInfo: details,
        agentState
      })
    } catch {
      if (!isCurrentConversationLoad()) return
      if (!messagesLoaded && !silent && !showedCachedConversation) {
        setMessages([])
        setAgentCompletionEvents([])
        setContactJourney([])
        contactJourneyRef.current = []
        setContactInfoData(null)
        setConversationAgentState(null)
        setMessagesError('No se pudo cargar la conversación.')
      }
    } finally {
      if (!isCurrentConversationLoad()) return
      if (!messagesLoaded) {
        setMessagesLoading(false)
        setMessagesRefreshing(false)
      }
      setContactInfoLoading(false)
    }
      }
    )
  }, [conversationRequestCoordinator, locationId])

  const loadOlderConversationMessages = useCallback(async (contactId: string) => {
    if (!contactId) return
    if (olderMessagesLoadingRef.current || !conversationHasOlderMessagesRef.current) return

    const oldestCursor = getOldestJourneyMessageCursor(contactJourneyRef.current)
    if (!oldestCursor) {
      conversationHasOlderMessagesRef.current = false
      conversationHistoryExhaustedContactIdRef.current = contactId
      return
    }

    const pane = messagePaneRef.current
    const previousScrollHeight = pane?.scrollHeight || 0
    const previousScrollTop = pane?.scrollTop || 0

    messagePanePinnedToBottomRef.current = false
    conversationHistoryPrependRef.current = true
    olderMessagesLoadingRef.current = true
    setOlderMessagesLoading(true)
    let restoreScheduled = false

    try {
      const olderJourney = await contactsService.getContactConversation(contactId, {
        refreshExternalStatuses: false,
        messageLimit: CHAT_CONVERSATION_MESSAGE_LIMIT,
        beforeMessageDate: oldestCursor.beforeMessageDate,
        beforeMessageCursor: oldestCursor.beforeMessageCursor
      })
      if (activeContactIdRef.current !== contactId) return

      const receivedFullPage = olderJourney.filter(isConversationJourneyMessage).length >= CHAT_CONVERSATION_MESSAGE_LIMIT
      conversationHasOlderMessagesRef.current = receivedFullPage
      if (!receivedFullPage) {
        conversationHistoryExhaustedContactIdRef.current = contactId
      }
      if (olderJourney.length === 0) return

      const nextJourney = mergeJourneyEvents(olderJourney, contactJourneyRef.current)
      contactJourneyRef.current = nextJourney
      setContactJourney((current) => (
        areJourneyEventsEquivalent(current, nextJourney) ? current : nextJourney
      ))

      const nextMessages = buildConversationMessages(nextJourney, [])
      setMessages((current) => {
        const mergedMessages = mergeDesktopConversationMessagesWithCurrent(nextMessages, current)
        return areDesktopMessagesEquivalent(current, mergedMessages) ? current : mergedMessages
      })

      restoreScheduled = true
      window.requestAnimationFrame(() => {
        const currentPane = messagePaneRef.current
        if (!currentPane || activeContactIdRef.current !== contactId || previousScrollHeight <= 0) {
          conversationHistoryPrependRef.current = false
          return
        }
        const restoreScrollTop = () => {
          currentPane.scrollTop = Math.max(0, currentPane.scrollHeight - previousScrollHeight + previousScrollTop)
          currentPane.scrollLeft = 0
          messagePanePinnedToBottomRef.current = false
        }
        restoreScrollTop()
        window.requestAnimationFrame(() => {
          if (activeContactIdRef.current === contactId) {
            restoreScrollTop()
          }
          conversationHistoryPrependRef.current = false
        })
      })
    } finally {
      olderMessagesLoadingRef.current = false
      setOlderMessagesLoading(false)
      if (!restoreScheduled) {
        conversationHistoryPrependRef.current = false
      }
    }
  }, [])

  const loadSupportData = useCallback(async () => {
    setCalendarsLoading(true)
    try {
      const [status, integrationsStatus, emailStatus, calendarList, agentList] = await Promise.all([
        whatsappApiService.getStatus().catch(() => null),
        getIntegrationsStatus().catch(() => null),
        emailService.getStatus().catch(() => null),
        calendarsService.getCalendars(locationId, accessToken).catch(() => []),
        conversationalAgentService.listAgents().catch(() => [] as ConversationalAgentDef[])
      ])
      const highLevelIsConnected = Boolean(integrationsStatus?.highlevel?.connected)
      const highLevelPhoneCatalog = highLevelIsConnected
        ? await highLevelService.getPhoneNumbers().catch(() => null)
        : null
      const stateList = await conversationalAgentService.listStates().catch(() => [] as ConversationAgentState[])
      if (status) setWhatsappStatus(status)
      if (integrationsStatus) {
        setHighLevelConnected(highLevelIsConnected)
        if (!highLevelIsConnected) {
          setHighLevelPhoneNumbers([])
        } else if (Array.isArray(highLevelPhoneCatalog?.phoneNumbers)) {
          setHighLevelPhoneNumbers(highLevelPhoneCatalog.phoneNumbers)
        }
        setMetaMessengerConnected(Boolean(integrationsStatus.meta?.connected && integrationsStatus.meta?.pageId))
        setMetaInstagramConnected(Boolean(integrationsStatus.meta?.connected && integrationsStatus.meta?.instagramAccountId))
      }
      if (emailStatus) setEmailConnected(Boolean(emailStatus.connected))
      setAgentStates(mapAgentStatesByContactId(stateList))
      setAgentStateLists(mapAgentStateListsByContactId(stateList))
      setAgentDefs(agentList)
      setCalendars(calendarList)
      setSelectedCalendarId((current) => current || calendarList[0]?.id || '')
    } finally {
      setCalendarsLoading(false)
    }
  }, [accessToken, locationId])

  const loadTemplates = useCallback(async () => {
    setTemplatesError('')
    setTemplatesLoading(true)

    try {
      const [status, response] = await Promise.all([
        whatsappApiService.getStatus().catch(() => null),
        whatsappApiService.getTemplates()
      ])
      if (status) setWhatsappStatus(status)
      setTemplates(Array.isArray(response.items) ? response.items : [])
      setTemplatesLoaded(true)
    } catch (error) {
      setTemplates([])
      setTemplatesLoaded(true)
      setTemplatesError(getErrorMessage(error, 'No se pudieron cargar las plantillas.'))
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const streamConnected = chatLiveConnectedRef.current
      const now = Date.now()
      if (streamConnected && now - chatLastFallbackReconcileAtRef.current < CHAT_HEALTHY_RECONCILE_INTERVAL_MS) return
      chatLastFallbackReconcileAtRef.current = now
      void loadChats({ silent: true })
      // Red de seguridad: la conversación ABIERTA también se reconcilia en el
      // intervalo. Antes SOLO la lista se refrescaba aquí, así que si se perdía
      // el frame SSE (proxy, reconexión, app en 2º plano) el globo se quedaba
      // congelado hasta salir y volver a entrar. loadConversation es no-op
      // visual cuando no hay cambios (areDesktopMessagesEquivalent), sin spinner
      // ni salto de scroll.
      const openContactId = activeContactIdRef.current
      if (openContactId) {
        void loadConversation(openContactId, { silent: true, useCache: false })
      }
      void conversationalAgentService.listStates()
        .then((states) => {
          setAgentStates(mapAgentStatesByContactId(states))
          setAgentStateLists(mapAgentStateListsByContactId(states))
        })
        .catch(() => null)
    }, CHAT_FALLBACK_REFRESH_INTERVAL_MS)

    return () => window.clearInterval(intervalId)
  }, [loadChats, loadConversation])

  const refreshFromLiveChatEvent = useCallback((event?: ChatLiveEvent) => {
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
          ? loadConversation(openContactId, { silent: true, useCache: false })
          : Promise.resolve()
      ])
        .finally(() => {
          chatLiveRefreshInFlightRef.current = false
          if (chatLiveRefreshQueuedRef.current) {
            chatLiveRefreshQueuedRef.current = false
            refreshFromLiveChatEvent()
          }
        })
    }, CHAT_LIVE_REFRESH_DEBOUNCE_MS)
  }, [loadChats, loadConversation])

  useEffect(() => {
    return subscribeToChatLiveEvents({
      onMessage: refreshFromLiveChatEvent,
      onDataChanged: refreshFromLiveChatEvent,
      onStatusChange: (status) => {
        chatLiveConnectedRef.current = status === 'connected'
      }
    })
  }, [refreshFromLiveChatEvent])

  // Al volver a la app/pestaña (o tras despertar de 2º plano) reconciliamos de
  // inmediato lista + conversación abierta. Cubre el caso clásico: el stream SSE
  // se congeló mientras la ventana estaba en 2º plano, llegó la notificación
  // push, y al regresar el globo debe estar ya, sin tener que salir y entrar.
  useEffect(() => {
    const reconcileOnReturn = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      refreshFromLiveChatEvent()
    }
    window.addEventListener('focus', reconcileOnReturn)
    document.addEventListener('visibilitychange', reconcileOnReturn)
    return () => {
      window.removeEventListener('focus', reconcileOnReturn)
      document.removeEventListener('visibilitychange', reconcileOnReturn)
    }
  }, [refreshFromLiveChatEvent])

  // (Presencia) Le reportamos al backend qué contacto tengo abierto y si la app
  // está al frente, para que NO me llegue push del chat que estoy viendo (solo a
  // mí; los demás sí reciben). Se reporta al cambiar de chat, al ganar/perder
  // foco y con un latido cada 20s; se limpia al salir del chat o al desmontar.
  useEffect(() => {
    const openId = activeContactId || null
    const isForeground = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'
    reportViewing(openId, isForeground())
    if (!openId) return

    const onFocus = () => reportViewing(openId, true)
    const onBlur = () => reportViewing(openId, false)
    const onVisibility = () => reportViewing(openId, isForeground())
    const keepAlive = window.setInterval(() => {
      if (isForeground()) reportViewing(openId, true)
    }, 20_000)

    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(keepAlive)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('visibilitychange', onVisibility)
      reportViewing(null, false)
    }
  }, [activeContactId])

  // (Asignación) Lista de usuarios asignables (una vez).
  useEffect(() => {
    let cancelled = false
    fetch('/api/contacts/assignable-users')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.success && Array.isArray(data.users)) {
          setAssignableUsers(data.users.map((user: { id: string; name: string }) => ({
            id: String(user.id),
            name: String(user.name)
          })))
        }
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  // (Asignación) Responsable actual al abrir/cambiar de contacto.
  useEffect(() => {
    if (!activeContactId) {
      setAssignedUserId('')
      return
    }
    let cancelled = false
    fetch(`/api/contacts/${encodeURIComponent(activeContactId)}/assignment`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setAssignedUserId(data.assignedUserId ? String(data.assignedUserId) : '')
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [activeContactId])

  // (Social enlazado) Perfil social del contacto + contacto vinculado al abrir/cambiar.
  useEffect(() => {
    if (!activeContactId) {
      setSocialProfiles([])
      setLinkedSocialContacts([])
      return
    }
    let cancelled = false
    fetch(`/api/contacts/${encodeURIComponent(activeContactId)}/linked-social`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data?.success) return
        setSocialProfiles(Array.isArray(data.profiles) ? (data.profiles as LinkedSocialProfile[]) : [])
        setLinkedSocialContacts(Array.isArray(data.linked) ? (data.linked as LinkedSocialContact[]) : [])
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [activeContactId])

  const handleAssignContact = useCallback(async (userId: string) => {
    if (!activeContactId) return
    const nextUserId = userId || ''
    const previous = assignedUserId
    setAssignedUserId(nextUserId)
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(activeContactId)}/assignment`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: nextUserId || null })
      })
      if (!response.ok) throw new Error('assign_failed')
    } catch {
      setAssignedUserId(previous)
      showToast('error', 'No se pudo asignar', 'Intenta de nuevo en un momento.')
    }
  }, [activeContactId, assignedUserId, showToast])

  const assignableUserOptions = useMemo(
    () => [
      { value: '', label: 'Sin asignar' },
      ...assignableUsers.map((user) => ({ value: user.id, label: user.name }))
    ],
    [assignableUsers]
  )

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
    chatListLoadMoreRequestRef.current?.abort()
    conversationRequestCoordinator.scheduleAbort()
    if (chatLiveRefreshTimeoutRef.current !== null) {
      window.clearTimeout(chatLiveRefreshTimeoutRef.current)
      chatLiveRefreshTimeoutRef.current = null
    }
  }, [conversationRequestCoordinator])

  useEffect(() => {
    loadSupportData()
  }, [loadSupportData])

  useEffect(() => {
    if (!activeContactId) {
      conversationRequestCoordinator.abort()
      openingConversationScrollContactIdRef.current = ''
      scrollContactIdRef.current = ''
      conversationActivityLoadedAtRef.current = 0
      setMessages([])
      setAgentCompletionEvents([])
      setContactJourney([])
      contactJourneyRef.current = []
      setContactInfoData(null)
      setConversationAgentState(null)
      setMessagesLoading(false)
      setMessagesRefreshing(false)
      setContactInfoLoading(false)
      olderMessagesLoadingRef.current = false
      conversationHasOlderMessagesRef.current = false
      conversationHistoryExhaustedContactIdRef.current = null
      setOlderMessagesLoading(false)
      return
    }
    openingConversationScrollContactIdRef.current = activeContactId
    conversationActivityLoadedAtRef.current = 0
    messagePanePinnedToBottomRef.current = true
    setInfoPanelView('summary')
    setAgentHistoryExpanded(false)
    void loadConversation(activeContactId)
    return () => conversationRequestCoordinator.scheduleAbort(activeContactId)
  }, [activeContactId, conversationRequestCoordinator, loadConversation])

  const updateMessagePaneBottomLock = useCallback(() => {
    const pane = messagePaneRef.current
    if (!pane) {
      messagePanePinnedToBottomRef.current = true
      return
    }
    const bottomGap = pane.scrollHeight - pane.scrollTop - pane.clientHeight
    messagePanePinnedToBottomRef.current = bottomGap <= MESSAGE_PANE_BOTTOM_LOCK_GAP_PX
    if (bottomGap > MESSAGE_PANE_BOTTOM_LOCK_GAP_PX && openingConversationScrollContactIdRef.current === activeContactIdRef.current) {
      openingConversationScrollContactIdRef.current = ''
    }
    if (pane.scrollTop <= CHAT_CONVERSATION_TOP_LOAD_GAP_PX && activeContactIdRef.current) {
      void loadOlderConversationMessages(activeContactIdRef.current)
    }
  }, [loadOlderConversationMessages])

  const scrollConversationToBottom = useCallback(() => {
    if (conversationHistoryPrependRef.current) return
    const pane = messagePaneRef.current
    if (!pane) return

    const pinToBottom = () => {
      pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight)
      messagePanePinnedToBottomRef.current = true
    }

    pinToBottom()
  }, [])

  useLayoutEffect(() => {
    if (!activeContactId) return
    const previous = previousMessagesScrollRef.current
    const contactChanged = scrollContactIdRef.current !== activeContactId
    const openingConversation = openingConversationScrollContactIdRef.current === activeContactId
    if (contactChanged) {
      scrollContactIdRef.current = activeContactId
      messagePanePinnedToBottomRef.current = true
    }

    const lastMessage = messages[messages.length - 1]
    const lastMessageId = lastMessage?.id || ''
    const messageWasAppended = messages.length > previous.count && lastMessageId !== previous.lastMessageId
    const shouldScroll =
      openingConversation ||
      contactChanged ||
      messagePanePinnedToBottomRef.current ||
      (messageWasAppended && lastMessage?.direction === 'outbound')

    previousMessagesScrollRef.current = {
      activeContactId,
      count: messages.length,
      lastMessageId
    }

    if (conversationHistoryPrependRef.current) {
      return
    }

    const pane = messagePaneRef.current
    const shouldReleaseInitialPosition = !messagesLoading && !messagesRefreshing && !contactInfoLoading
    let initialLayoutObserver: ResizeObserver | null = null

    // El contenido puede crecer después del primer commit (caché, actividad,
    // fuentes o media). Mientras se presenta un chat recién abierto, el fondo
    // es la referencia semántica: no se conserva el scroll viejo del contacto
    // anterior ni se depende de una animación para corregirlo.
    if (openingConversation && pane && typeof ResizeObserver !== 'undefined') {
      initialLayoutObserver = new ResizeObserver(() => {
        if (openingConversationScrollContactIdRef.current !== activeContactId) return
        if (messagePanePinnedToBottomRef.current) scrollConversationToBottom()
        if (shouldReleaseInitialPosition) {
          openingConversationScrollContactIdRef.current = ''
          initialLayoutObserver?.disconnect()
        }
      })
      initialLayoutObserver.observe(pane)
    }

    if (shouldScroll) {
      scrollConversationToBottom()
    }
    if (openingConversation && shouldReleaseInitialPosition && !initialLayoutObserver) {
      openingConversationScrollContactIdRef.current = ''
    }

    return () => initialLayoutObserver?.disconnect()
  }, [
    activeContactId,
    agentCompletionEvents.length,
    conversationActivityMarkers,
    contactInfoLoading,
    messages,
    messagesLoading,
    messagesRefreshing,
    scrollConversationToBottom
  ])

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

    if (composerChannel === 'messenger' || composerChannel === 'instagram') {
      if (!socialVoiceChannelReady) {
        showToast('warning', 'Conecta el canal para audio', 'Activa la conexión de este canal antes de mandar una nota de voz.')
        return
      }
    } else {
      if (!activeContact?.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar una nota de voz.')
        return
      }

      if (!highLevelPhoneVoiceChannelReady && !whatsappConnected && !selectedQrReady) {
        showToast('warning', 'Conecta el canal para audio', 'Conecta WhatsApp API o QR antes de mandar una nota de voz.')
        return
      }
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
            showToast('error', 'Audio muy pesado', 'Graba un audio más corto para enviarlo.')
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
  }, [activeContact?.phone, clearVoiceTimer, composerChannel, composerText, draftAttachments.length, highLevelPhoneVoiceChannelReady, selectedQrReady, showToast, socialVoiceChannelReady, stopVoiceStream, voiceDraft, voiceProcessing, voiceRecording, whatsappConnected])

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

  const handleSearchContacts = useCallback(() => {
    void loadChats({
      silent: false,
      search: isChatQueryActive ? normalizedChatQuery : undefined
    })
  }, [isChatQueryActive, loadChats, normalizedChatQuery])

  const resolveMediaDeliveryPrompt = useCallback((mode: DraftAttachmentDeliveryMode | 'cancel') => {
    const resolve = mediaDeliveryPromptResolveRef.current
    mediaDeliveryPromptResolveRef.current = null
    setMediaDeliveryPrompt(null)
    resolve?.(mode)
  }, [])

  const askMediaDeliveryMode = useCallback((file: File, kind: 'video' | 'audio') => (
    new Promise<DraftAttachmentDeliveryMode | 'cancel'>((resolve) => {
      mediaDeliveryPromptResolveRef.current = resolve
      setMediaDeliveryPrompt({
        kind,
        name: file.name || (kind === 'video' ? 'video' : 'audio'),
        size: file.size
      })
    })
  ), [])

  const addDraftAttachment = useCallback((attachment: DesktopDraftAttachment) => {
    setDraftAttachments((current) => [...current, attachment].slice(0, MAX_DRAFT_ATTACHMENTS))
    showToast('success', `${getDraftAttachmentLabel(attachment)} listo`, 'Revisa la vista previa y manda el mensaje.')
  }, [showToast])

  const readAttachmentFile = useCallback(async (
    file: File,
    kind: DraftAttachmentKind,
    mimeType: string,
    deliveryMode: DraftAttachmentDeliveryMode,
    source: string
  ) => {
    const preparedFile = kind === 'image' ? await optimizeChatImageFile(file) : file
    const preparedMimeType = preparedFile.type || mimeType
    const dataUrl = await readFileAsDataUrl(preparedFile, preparedMimeType)
    addDraftAttachment({
      id: `${source}-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      kind,
      deliveryMode,
      name: preparedFile.name || file.name || `${kind}-${Date.now()}`,
      mimeType: preparedMimeType,
      dataUrl,
      size: preparedFile.size
    })
  }, [addDraftAttachment])

  const addFilesToDraft = useCallback(async (files: File[], source = 'drop') => {
    if (!files.length) return
    if (isEmailComposer) {
      showToast('info', 'Adjuntos en correo', 'Por ahora arrastra archivos en WhatsApp, Messenger o Instagram; correo lo dejamos fuera hasta amarrar bien el flujo.')
      return
    }
    if (voiceDraft || voiceRecording || voiceProcessing) {
      showToast('warning', 'Audio en progreso', 'Termina o elimina la nota de voz antes de agregar archivos.')
      return
    }

    const availableSlots = Math.max(0, MAX_DRAFT_ATTACHMENTS - draftAttachments.length)
    if (availableSlots === 0) {
      showToast('warning', 'Límite de archivos', `Puedes mandar hasta ${MAX_DRAFT_ATTACHMENTS} adjuntos por mensaje.`)
      return
    }

    const selectedFiles = files.slice(0, availableSlots)
    if (files.length > selectedFiles.length) {
      showToast('info', 'Solo se agregaron algunos', `El mensaje admite ${MAX_DRAFT_ATTACHMENTS} adjuntos.`)
    }

    for (const file of selectedFiles) {
      try {
        const fileType = String(file.type || '').toLowerCase()
        const image = fileType.startsWith('image/')
        const videoMimeType = getVideoMimeType(file)
        const audioMimeType = getAudioMimeType(file)

        if (image) {
          if (file.size > MAX_IMAGE_ATTACHMENT_BYTES) {
            showToast('error', 'La foto pesa demasiado', 'Elige una foto de menos de 8 MB.')
            continue
          }
          await readAttachmentFile(file, 'image', file.type || 'image/jpeg', 'media', source)
          continue
        }

        if (videoMimeType) {
          if (!isSupportedVideoFile(file)) {
            showToast('error', 'Video no válido', 'Usa MP4, MOV, WebM o 3GP.')
            continue
          }

          let deliveryMode: DraftAttachmentDeliveryMode = 'media'
          if (file.size > MAX_VIDEO_ATTACHMENT_BYTES) {
            showToast('error', 'Video muy pesado', 'El video debe pesar menos de 25 MB para que Ristak lo pueda preparar.')
            continue
          }
          if (activeNativeMetaChannel === 'instagram') {
            deliveryMode = 'media'
          } else if (file.size > MAX_MEDIA_MESSAGE_BYTES && file.size <= MAX_DOCUMENT_ATTACHMENT_BYTES) {
            deliveryMode = 'document'
          } else if (file.size <= MAX_MEDIA_MESSAGE_BYTES) {
            const answer = await askMediaDeliveryMode(file, 'video')
            if (answer === 'cancel') continue
            deliveryMode = answer === 'document' ? 'document' : 'media'
          }

          await readAttachmentFile(file, 'video', videoMimeType, deliveryMode, source)
          continue
        }

        if (audioMimeType) {
          if (!isSupportedAudioFile(file)) {
            showToast('error', 'Audio no válido', 'Usa MP3, M4A, OGG, WAV, AAC, AMR o WebM.')
            continue
          }
          if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
            showToast('error', 'Audio muy pesado', 'El audio debe pesar menos de 20 MB para mandarlo desde el chat.')
            continue
          }

          let deliveryMode: DraftAttachmentDeliveryMode = activeNativeMetaChannel === 'instagram'
            ? 'voice'
            : file.size > MAX_MEDIA_MESSAGE_BYTES ? 'document' : 'voice'
          if (activeNativeMetaChannel !== 'instagram' && file.size <= MAX_MEDIA_MESSAGE_BYTES) {
            const answer = await askMediaDeliveryMode(file, 'audio')
            if (answer === 'cancel') continue
            deliveryMode = answer === 'document' ? 'document' : 'voice'
          }

          await readAttachmentFile(file, 'audio', audioMimeType, deliveryMode, source)
          continue
        }

        if (activeNativeMetaChannel === 'instagram') {
          showToast('warning', 'Instagram no envía documentos', 'En este canal puedes mandar fotos, videos, audios y notas de voz.')
          continue
        }

        if (!isSupportedDocumentFile(file)) {
          showToast('error', 'Archivo no válido', 'Elige un PDF, Word, Excel, PowerPoint, TXT o CSV.')
          continue
        }

        if (file.size > MAX_DOCUMENT_ATTACHMENT_BYTES) {
          showToast('error', 'Archivo muy pesado', 'Elige un documento de menos de 20 MB.')
          continue
        }

        await readAttachmentFile(file, 'document', getDocumentMimeType(file), 'document', source)
      } catch (error) {
        showToast('error', 'No se pudo leer', getErrorMessage(error, 'Intenta elegir el archivo otra vez.'))
      }
    }
  }, [
    askMediaDeliveryMode,
    activeNativeMetaChannel,
    draftAttachments.length,
    isEmailComposer,
    readAttachmentFile,
    showToast,
    voiceDraft,
    voiceProcessing,
    voiceRecording
  ])

  const handleImageSelected = useCallback((source: 'photos', event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    void addFilesToDraft(files, source)
    setComposerMenuOpen(false)
  }, [addFilesToDraft])

  const handleDocumentSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || [])
    event.target.value = ''
    if (!files.length) return
    void addFilesToDraft(files, 'document')
    setComposerMenuOpen(false)
  }, [addFilesToDraft])

  const removeDraftAttachment = useCallback((attachmentId: string) => {
    setDraftAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }, [])

  const resetChatDragState = useCallback(() => {
    dragDepthRef.current = 0
    setDraggingFilesOverChat(false)
  }, [])

  const hasDraggedFiles = useCallback((event: React.DragEvent<HTMLElement>) => (
    Array.from(event.dataTransfer?.types || []).includes('Files')
  ), [])

  const handleChatDragEnter = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event) || isEmailComposer) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current += 1
    setDraggingFilesOverChat(true)
  }, [hasDraggedFiles, isEmailComposer])

  const handleChatDragOver = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event) || isEmailComposer) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setDraggingFilesOverChat(true)
  }, [hasDraggedFiles, isEmailComposer])

  const handleChatDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDraggingFilesOverChat(false)
  }, [hasDraggedFiles])

  const handleChatDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!hasDraggedFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    const files = Array.from(event.dataTransfer.files || [])
    resetChatDragState()
    void addFilesToDraft(files, 'drop')
  }, [addFilesToDraft, hasDraggedFiles, resetChatDragState])

  const closeComposerAgentMenu = useCallback(() => {
    setAgentComposerMenuOpen(false)
    setAgentPickerOpen(false)
  }, [])

  const closeTemplatePanel = useCallback(() => {
    setTemplatePanelOpen(false)
  }, [])

  const handleUpdatePreferredWhatsAppPhoneNumber = useCallback(async (
    phoneNumberId: string,
    source: 'composer' | 'contact_info' = 'contact_info'
  ) => {
    const contactId = activeContact?.id || ''
    const previousContact = contactInfoData || activeContact
    if (!contactId || savingWhatsAppPreference) return

    const previousPreferredId = getPreferredWhatsAppPhoneNumberId(previousContact)
    const nextPreferredId = String(phoneNumberId || '').trim()
    if (previousPreferredId === nextPreferredId) return
    const patch = {
      preferredWhatsAppPhoneNumberId: nextPreferredId,
      preferred_whatsapp_phone_number_id: nextPreferredId
    } as Partial<Contact>

    setWhatsappPreferenceError('')
    setSavingWhatsAppPreference(true)
    setComposerBusinessPhoneId(nextPreferredId)
    setContactInfoData((current) => current?.id === contactId ? { ...current, ...patch } : current)
    setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, ...patch } : contact))

    try {
      const updatedContact = await contactsService.updateContact(contactId, {
        ...patch,
        routingReason: nextPreferredId
          ? source === 'composer'
            ? 'Cambio desde selector inferior del chat'
            : 'Cambio desde panel derecho del chat'
          : 'Automático desde panel derecho del chat',
        routingSource: 'manual'
      } as Partial<Contact> & Record<string, unknown>)
      const nextPatch = {
        ...updatedContact,
        ...patch
      }
      setContactInfoData((current) => current?.id === contactId ? { ...current, ...nextPatch } : current)
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, ...nextPatch } : contact))
      showToast(
        'success',
        nextPreferredId ? 'WhatsApp de respuesta actualizado' : 'Respuesta automática activada',
        nextPreferredId
          ? 'Este contacto quedará ligado a ese número para responder por WhatsApp.'
          : automaticWhatsAppRoutePhone
          ? 'Ristak volverá a usar el número por donde llegó la conversación.'
          : 'Ristak usará el remitente principal mientras no haya historial de WhatsApp.'
      )
    } catch (error: any) {
      const rollbackPatch = {
        preferredWhatsAppPhoneNumberId: previousPreferredId,
        preferred_whatsapp_phone_number_id: previousPreferredId
      } as Partial<Contact>
      setContactInfoData((current) => current?.id === contactId ? { ...current, ...rollbackPatch } : current)
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, ...rollbackPatch } : contact))
      setWhatsappPreferenceError(error?.message || 'No se pudo guardar el número de respuesta.')
      showToast(
        'warning',
        'Se usará este WhatsApp ahora',
        'La ruta elegida sigue activa para este chat, pero no se pudo guardar como preferencia permanente.'
      )
    } finally {
      setSavingWhatsAppPreference(false)
    }
  }, [activeContact, automaticWhatsAppRoutePhone, contactInfoData, savingWhatsAppPreference, showToast])

  const handleComposerChannelChange = useCallback((value: string) => {
    const highLevelSmsPhoneId = value.startsWith(HIGHLEVEL_SMS_COMPOSER_VALUE_PREFIX)
      ? value.slice(HIGHLEVEL_SMS_COMPOSER_VALUE_PREFIX.length)
      : ''
    const nextChannel = highLevelSmsPhoneId ? 'sms' : normalizeComposerChannel(value)
    const preferredHighLevelPhoneChannel = nextChannel === 'sms'
      ? 'sms'
      : value === HIGHLEVEL_WHATSAPP_COMPOSER_VALUE
        ? 'whatsapp'
        : null
    if (activeContact?.id && preferredHighLevelPhoneChannel) {
      composerChannelPreferenceRequestRef.current += 1
      void contactsService.updateConversationalChannelPreference(activeContact.id, preferredHighLevelPhoneChannel)
        .catch((error: any) => {
          showToast(
            'warning',
            'Canal elegido sólo por ahora',
            error?.message || 'No se pudo guardar este canal para las siguientes respuestas del agente.'
          )
        })
    }
    if (!isCommentComposerChannel(nextChannel)) {
      setCommentReplyTarget(null)
    }
    if (nextChannel === 'email' && composerChannel !== 'email' && !emailBodyHtml.trim() && composerText.trim()) {
      setEmailBodyHtml(plainTextToEmailHtml(composerText))
    }
    if (composerChannel === 'email' && nextChannel !== 'email') {
      const nextText = emailHtmlToPlainText(emailBodyHtml)
      if (nextText && !composerText.trim()) setComposerText(nextText)
      setEmailSubject('')
    }
    setComposerChannel(nextChannel)
    if (nextChannel === 'whatsapp') {
      const nextBusinessPhoneId = value.startsWith('whatsapp:') ? value.slice('whatsapp:'.length) : ''
      if (nextBusinessPhoneId === 'highlevel') {
        setComposerBusinessPhoneId(HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID)
      } else if (nextBusinessPhoneId) {
        setComposerBusinessPhoneId(nextBusinessPhoneId)
        void handleUpdatePreferredWhatsAppPhoneNumber(nextBusinessPhoneId, 'composer')
      }
    } else if (nextChannel === 'sms') {
      setComposerBusinessPhoneId(HIGHLEVEL_WHATSAPP_COMPOSER_PHONE_ID)
      const nextHighLevelPhone = highLevelSmsPhoneId
        ? highLevelPhoneNumbers.find((phone) => phone.id === highLevelSmsPhoneId)
        : defaultHighLevelPhoneNumber
      setComposerHighLevelFromNumber(nextHighLevelPhone?.phoneNumber || '')
    }
    setComposerMenuOpen(false)
    closeTemplatePanel()
    closeComposerAgentMenu()
    if (nextChannel === 'email') {
      setDraftAttachments([])
      setVoiceDraft(null)
      setVoiceElapsedMs(0)
    }
  }, [activeContact?.id, closeComposerAgentMenu, closeTemplatePanel, composerChannel, composerText, defaultHighLevelPhoneNumber, emailBodyHtml, handleUpdatePreferredWhatsAppPhoneNumber, highLevelPhoneNumbers, showToast])

  const handleOpenTemplatePanel = useCallback(() => {
    setComposerMenuOpen(false)
    closeComposerAgentMenu()
    setTemplatePanelMode('choice')
    setTemplateSearch('')
    setTemplatePanelOpen(true)
    void loadTemplates()
  }, [closeComposerAgentMenu, loadTemplates])

  const handleComposerMenuAction = useCallback((action: 'templates' | 'photos' | 'documents' | 'location' | 'clabe') => {
    if (action === 'photos') {
      photoInputRef.current?.click()
      return
    }
    if (action === 'documents') {
      if (activeNativeMetaChannel === 'instagram') {
        showToast('info', 'Instagram no envía documentos', 'Usa foto, video, audio o nota de voz.')
        setComposerMenuOpen(false)
        return
      }
      documentInputRef.current?.click()
      return
    }
    if (action === 'templates') {
      handleOpenTemplatePanel()
      return
    }
    showToast('info', action === 'location' ? 'Ubicación' : 'CLABE', 'Esta opción ya está en el menú. La conexión completa queda lista para el siguiente paso.')
    setComposerMenuOpen(false)
  }, [activeNativeMetaChannel, handleOpenTemplatePanel, showToast])

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
    if (status !== 'APPROVED') {
      showToast('warning', getTemplateStatusLabel(status), getTemplateBlockedReason(template))
      return
    }

    const optimisticId = `desktop-template-${Date.now()}`
    const sentAt = new Date().toISOString()
    const preview = getTemplateBodyPreview(template)
    setTemplateSendingId(template.id)
    setTemplatePanelOpen(false)
    setComposerMenuOpen(false)
    setMessages((current) => [
      ...current,
      {
        id: optimisticId,
        optimisticId,
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
        contactId: activeContact.id,
        templateId: template.id,
        templateName: template.name,
        language: template.language,
        externalId: optimisticId,
        phoneNumberId: selectedBusinessPhone?.id || undefined
      })
      const responseIds = getChatSendResponseIds(result)
      setMessages((current) => current.map((message) => (
        message.id === optimisticId
          ? {
              ...message,
              serverMessageId: responseIds.serverMessageId || message.serverMessageId,
              providerMessageId: responseIds.providerMessageId || message.providerMessageId,
              status: 'sent',
              errorReason: '',
              transport: result.transport || message.transport,
              routingReason: result.routingReason || result.fallbackReason || message.routingReason
            }
          : message
      )))
      showToast(
        'success',
        result.transport === 'qr' ? 'Plantilla enviada por QR' : 'Plantilla enviada',
        result.transport === 'qr'
          ? `${template.name} se mandó como texto por el respaldo QR.`
          : `${template.name} se mandó por WhatsApp.`
      )
      void Promise.all([
        loadConversation(activeContact.id, { silent: true, useCache: false }),
        loadChats({ silent: true })
      ])
      await loadTemplates()
    } catch (error) {
      const message = getErrorMessage(error, 'Intenta enviar la plantilla otra vez.')
      setMessages((current) => current.map((item) => (
        item.id === optimisticId ? { ...item, status: 'error', errorReason: message } : item
      )))
      showToast('error', 'No se envió la plantilla', message)
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
      showToast('warning', 'Falta el mensaje', `Escribe el texto que quieres mandar al ${customerLowerLabel}.`)
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
      setTemplatePanelMode('select')
      showToast('success', 'Plantilla enviada a revisión', 'Cuando Meta la apruebe, aparecerá lista para enviar aquí mismo.')
      await loadTemplates()
    } catch (error) {
      showToast('error', 'No se pudo crear', getErrorMessage(error, 'Revisa la plantilla e intenta otra vez.'))
      await loadTemplates()
    } finally {
      setCreatingTemplate(false)
    }
  }

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

  const handleUpdateContactCustomFields = useCallback(async (contactId: string, customFields: ContactCustomField[]) => {
    if (!contactId) return []
    const currentContact = contactInfoData?.id === contactId
      ? contactInfoData
      : activeContact?.id === contactId ? activeContact : null

    try {
      const updatedContact = await contactsService.updateContact(contactId, { customFields } as Partial<Contact>)
      const nextCustomFields = Array.isArray(updatedContact.customFields)
        ? updatedContact.customFields
        : mergeContactCustomFields(currentContact?.customFields || [], customFields)

      setContactInfoData((current) => current?.id === contactId ? { ...current, ...updatedContact, customFields: nextCustomFields } : current)
      setChats((current) => current.map((contact) => contact.id === contactId
        ? { ...contact, ...updatedContact, customFields: nextCustomFields }
        : contact
      ))
      showToast('success', 'Campo actualizado', 'El dato quedó guardado en el contacto.')
      return nextCustomFields
    } catch (error: any) {
      showToast('error', 'No se guardó el campo', error?.message || 'Intenta editarlo otra vez.')
      throw error
    }
  }, [activeContact, contactInfoData, showToast])

  const handleUpdateContactIdentityField = useCallback(async (field: ContactIdentityField, value: string) => {
    if (!activeContact?.id) return

    const contactId = activeContact.id
    const previousContact = contactInfoData || activeContact
    const patch = { [field]: value } as Partial<Contact>

    setContactInfoData((current) => current?.id === contactId ? { ...current, ...patch } : current)
    setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, ...patch } : contact))

    try {
      const updatedContact = await contactsService.updateContact(contactId, patch)
      const identityPatch: Partial<Contact> = {}

      if (field === 'name') {
        identityPatch.name = updatedContact.name ?? (updatedContact as any).full_name ?? value
      } else if (field === 'email') {
        identityPatch.email = updatedContact.email ?? value
      } else if (field === 'phone') {
        identityPatch.phone = updatedContact.phone ?? value
      }

      const nextPatch: Partial<Contact> = {
        ...updatedContact,
        ...identityPatch
      }

      setContactInfoData((current) => current?.id === contactId ? { ...current, ...nextPatch } : current)
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, ...nextPatch } : contact))
    } catch (error: any) {
      setContactInfoData((current) => current?.id === contactId ? { ...current, ...previousContact } : current)
      setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, ...previousContact } : contact))
      showToast('error', 'No se guardó el contacto', error?.message || 'Intenta editarlo otra vez.')
      throw error
    }
  }, [activeContact, contactInfoData, showToast])

  const handleMakePrimaryPhone = useCallback(async (phone: string) => {
    const nextPhone = String(phone || '').trim()
    const currentContact = contactInfoData || activeContact
    if (!activeContact?.id || !nextPhone || nextPhone === String(currentContact?.phone || '').trim()) return

    setSavingPrimaryPhone(nextPhone)
    try {
      await handleUpdateContactIdentityField('phone', nextPhone)
    } finally {
      setSavingPrimaryPhone(null)
    }
  }, [activeContact, contactInfoData, handleUpdateContactIdentityField])

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

  const handleSaveAppointment = async (
    eventIdOrPayload: string | CreateAppointmentPayload,
    updates?: Partial<CalendarEvent>
  ) => {
    if (typeof eventIdOrPayload === 'string') {
      if (!updates) return
      await calendarsService.updateAppointment(eventIdOrPayload, updates, accessToken || undefined)
      setAppointmentOpen(false)
      setEditingAppointmentEvent(null)
      showToast('success', 'Cita actualizada', 'Los cambios quedaron guardados.')
      if (activeContactId) await loadConversation(activeContactId)
      return
    }

    const calendarId = String(eventIdOrPayload.calendarId || selectedCalendar?.id || '').trim()
    if (!calendarId) {
      showToast('error', 'Calendario requerido', 'Selecciona un calendario activo antes de agendar la cita.')
      return
    }
    const created = await calendarsService.createAppointment({
      ...eventIdOrPayload,
      calendarId
    }, accessToken || undefined)
    setAppointmentOpen(false)
    setEditingAppointmentEvent(null)
    if (created?.syncStatus === 'error') {
      showToast('warning', 'Cita guardada en Ristak', 'HighLevel quedó pendiente y Ristak volverá a intentarlo automáticamente.')
    } else {
      showToast('success', 'Cita agendada', 'La cita quedó guardada para este contacto.')
    }
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
    setConversationAgentState((current) => selectPrimaryAgentState([nextState, current].filter(Boolean) as ConversationAgentState[]))
    setAgentStates((current) => ({
      ...current,
      [nextState.contactId]: selectPrimaryAgentState([nextState, current[nextState.contactId]].filter(Boolean) as ConversationAgentState[]) || nextState
    }))
    setAgentStateLists((current) => ({
      ...current,
      [nextState.contactId]: upsertAgentStateList(current[nextState.contactId] || [], nextState)
    }))
  }, [])

  const handleOpenComposerAgentMenu = useCallback(() => {
    if (!activeContact?.id || conversationAgentBusy) return
    setComposerMenuOpen(false)
    closeTemplatePanel()
    setAgentComposerMenuOpen((current) => {
      const nextOpen = !current
      setAgentPickerOpen(nextOpen && (!conversationAgentActive || !conversationAgentState?.agentId))
      return nextOpen
    })
  }, [activeContact?.id, closeTemplatePanel, conversationAgentActive, conversationAgentBusy, conversationAgentState?.agentId])

  const closeScheduleModal = useCallback(() => {
    if (schedulingMessage) return
    setScheduleOpen(false)
    setScheduleEditingMessageId(null)
    setScheduleError('')
  }, [schedulingMessage])

	  const handleOpenScheduleModal = useCallback(() => {
	    if (!activeContact) return
	    setComposerMenuOpen(false)
	    closeTemplatePanel()
	    closeComposerAgentMenu()

	    if (composerChannel === 'email') {
	      showToast('warning', 'Correo al momento', 'Por ahora los correos se envían al momento desde el chat.')
	      return
	    }

	    if (!composerText.trim()) {
      showToast('warning', 'Escribe el mensaje', 'Primero escribe el texto que quieres programar.')
      return
    }

    if (draftAttachments.length > 0 || voiceDraft) {
      showToast('warning', 'Solo texto por ahora', 'Programa mensajes escritos; las fotos, documentos y audios se mandan al momento.')
      return
    }

    setScheduleDraft(createDefaultScheduleDraft(timezone))
    setScheduleError('')
    setScheduleEditingMessageId(null)
    setScheduleOpen(true)
	  }, [activeContact, closeComposerAgentMenu, closeTemplatePanel, composerChannel, composerText, draftAttachments.length, showToast, voiceDraft])

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

    const scheduledDate = getScheduleDateFromDraft(scheduleDraft, timezone)
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
    let transport: 'api' | 'qr' | undefined = 'api'

    if ((composerChannel === 'messenger' || composerChannel === 'instagram') && !highLevelConnected) {
      setScheduleError('La programación para Messenger e Instagram todavía no está disponible en Meta nativo. Puedes enviarlo al momento desde Ristak.')
      return
    }

    if (composerChannel === 'whatsapp' && selectedBusinessPhone) {
      if (!activeContact.phone) {
        setScheduleError('Este contacto necesita teléfono para programar por WhatsApp.')
        return
      }
      if (!whatsappConnected && !selectedQrReady) {
        setScheduleError(selectedBusinessPhone.availability?.apiReason || 'El WhatsApp seleccionado no tiene una conexión disponible para programar.')
        return
      }
      provider = 'whatsapp_api'
      transport = selectedQrReady && !whatsappConnected ? 'qr' : 'api'
    } else if (highLevelConnected) {
      provider = 'highlevel'
      channel = activeConversationChannel
      transport = undefined
      if (!activeContact.phone && channel !== 'instagram' && channel !== 'messenger') {
        setScheduleError('Este contacto necesita teléfono para programar por este canal.')
        return
      }
    } else {
      setScheduleError('Conecta WhatsApp API para programar mensajes de WhatsApp.')
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

    if (provider === 'whatsapp_api' && transport === 'api' && !apiReplyWindowOpen) {
      setScheduleError('Para este chat necesitas mandar una plantilla antes de programar un mensaje libre.')
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
        fromPhone: provider === 'highlevel'
          ? resolveHighLevelChatFromNumber(channel, {
              smsFromNumber: selectedHighLevelFromNumber,
              whatsappSender: highLevelWhatsAppSender
            }) || undefined
          : selectedBusinessPhoneValue || undefined,
        businessPhoneNumberId: provider === 'whatsapp_api' ? selectedBusinessPhone?.id || undefined : undefined,
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
          return next.sort((left, right) => getMessageTimeValue(left.date) - getMessageTimeValue(right.date))
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
    composerChannel,
    scheduleDraft,
    scheduleEditingMessageId,
    schedulingMessage,
    selectedBusinessPhone?.id,
    selectedBusinessPhoneValue,
    selectedHighLevelFromNumber,
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
    setScheduleDraft(createScheduleDraftFromDate(message.scheduledAt || message.date, timezone))
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
      showToast('warning', 'Chatbot apagado', 'Actívalo en Chatbot para usarlo en los chats.')
      return
    }

    setConversationAgentBusy(true)
    try {
      const nextState = await conversationalAgentService.updateState(activeContact.id, action, options)
      updateActiveConversationAgentState(nextState)
      showToast('success', 'Chatbot', successMessage)
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
	    setAgentStateLists((current) => ({
	      ...current,
	      [contactId]: (current[contactId] || []).map((item) => (
	        (item.id && state.id ? item.id === state.id : item.agentId === state.agentId) ? {
	          ...item,
	          signal: null,
	          signalReason: null,
	          signalSummary: null,
	          signalAt: null,
	          updatedBy: 'user',
	          updatedAt: acknowledgedAt
	        } : item
	      ))
	    }))

	    void conversationalAgentService.updateState(contactId, 'clear_signal', { agentId: state.agentId || undefined })
	      .then((nextState) => {
	        setAgentStateLists((current) => ({
	          ...current,
	          [contactId]: upsertAgentStateList(current[contactId] || [], nextState)
	        }))
	        setAgentStates((current) => ({
	          ...current,
	          [contactId]: selectPrimaryAgentState([nextState, current[contactId]].filter(Boolean) as ConversationAgentState[]) || nextState
	        }))
	        if (contactId === activeContactId) {
	          setConversationAgentState((current) => selectPrimaryAgentState([nextState, current].filter(Boolean) as ConversationAgentState[]))
	        }
	      })
      .catch((error: any) => {
        setAgentStates((current) => ({ ...current, [contactId]: state }))
        showToast('error', 'Chatbot', error?.message || 'No se pudo quitar la prioridad del chat')
      })
  }, [activeContactId, agentStates, showToast])

  const handleSelectChat = useCallback((contact: DesktopChatContact) => {
    setActiveContactId(contact.id)
    acknowledgeAgentPriorityOnOpen(contact.id)
    if (Number(contact.unreadCount || 0) > 0) {
      markChatsReadLocally([contact.id])
      persistChatsRead([contact.id])
    }
  }, [acknowledgeAgentPriorityOnOpen, markChatsReadLocally, persistChatsRead])

  // (Social enlazado) Abre el contacto vinculado (DM ↔ comentario). Como es un
  // registro SEPARADO, puede no estar en la página de chats ya cargada; si no
  // está, lo inyectamos (deduplicado) para que `activeContact` resuelva y el
  // panel no quede en blanco. loadConversation lo hidrata después.
  const handleOpenLinkedContact = useCallback((link: LinkedSocialContact) => {
    const injected = {
      id: link.contactId,
      name: link.name || 'Contacto vinculado',
      source: link.platform,
      profilePhotoUrl: link.photo || null,
      lastMessageType: link.kind === 'comment' ? 'comment' : undefined,
      lastMessageChannel: link.platform
    } as DesktopChatContact
    setChats((current) => dedupeChatsById([...current, injected]))
    handleSelectChat(injected)
  }, [handleSelectChat])

  const handleToggleAgentAssignedView = useCallback(() => {
    setArchivedViewOpen(false)
    setAgentInboxStatusFilter(DEFAULT_AGENT_INBOX_STATUS_FILTER)
    setChatFilter((current) => (current === 'agent' ? 'all' : 'agent'))
  }, [])

  const handleToggleChatSelection = useCallback((contactId: string) => {
    setSelectedChatIds((current) => (
      current.includes(contactId)
        ? current.filter((id) => id !== contactId)
        : [...current, contactId]
    ))
  }, [])

  const handleToggleVisibleChatSelection = useCallback(() => {
    const visibleIds = selectableChatRows.map((contact) => contact.id)
    if (visibleIds.length === 0) return

    setSelectedChatIds((current) => {
      const currentSet = new Set(current)
      const allSelected = visibleIds.every((id) => currentSet.has(id))
      if (allSelected) return current.filter((id) => !visibleIds.includes(id))
      visibleIds.forEach((id) => currentSet.add(id))
      return Array.from(currentSet)
    })
  }, [selectableChatRows])

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
    markChatsReadLocally([contact.id])
    persistChatsRead([contact.id])

    showToast(
      unread > 0 ? 'success' : 'info',
      unread > 0 ? 'Chat marcado como leído' : 'Chat sin pendientes',
      unread > 0 ? `${getContactName(contact)} ya no aparece como pendiente.` : `${getContactName(contact)} ya estaba leído.`
    )
  }, [markChatsReadLocally, persistChatsRead, showToast])

  const handleMarkSelectedChatsAsRead = useCallback(() => {
    if (selectedChatContacts.length === 0) return
    const selectedIds = new Set(selectedChatContacts.map((contact) => contact.id))
    const unreadCount = selectedChatContacts.filter((contact) => Number(contact.unreadCount || 0) > 0).length

    markChatsReadLocally([...selectedIds])
    persistChatsRead([...selectedIds])

    showToast(
      unreadCount > 0 ? 'success' : 'info',
      unreadCount > 0 ? 'Chats marcados como leídos' : 'Chats sin pendientes',
      unreadCount > 0
        ? `${unreadCount} chat${unreadCount === 1 ? '' : 's'} ya no aparece${unreadCount === 1 ? '' : 'n'} como pendiente${unreadCount === 1 ? '' : 's'}.`
        : 'Los chats seleccionados ya estaban leídos.'
    )
  }, [markChatsReadLocally, persistChatsRead, selectedChatContacts, showToast])

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

  const handleArchiveSelectedChats = useCallback(() => {
    if (selectedChatContacts.length === 0) return
    const selectedIds = selectedChatContacts.map((contact) => contact.id)
    const selectedSet = new Set(selectedIds)

    setArchivedChatIds((current) => {
      if (archivedViewOpen) return current.filter((id) => !selectedSet.has(id))
      const next = new Set(current)
      selectedIds.forEach((id) => next.add(id))
      return Array.from(next)
    })

    if (!archivedViewOpen && activeContactId && selectedSet.has(activeContactId)) {
      const nextArchivedSet = new Set(archivedChatIdSetRef.current)
      selectedIds.forEach((id) => nextArchivedSet.add(id))
      setActiveContactId(getDefaultActiveChatId(chatsRef.current, nextArchivedSet, agentPriorityChatIdSetRef.current, removedChatStatesRef.current))
    }

    setSelectedChatIds([])
    showToast(
      'success',
      archivedViewOpen ? 'Chats restaurados' : 'Chats archivados',
      archivedViewOpen
        ? `${selectedIds.length} chat${selectedIds.length === 1 ? '' : 's'} volvió${selectedIds.length === 1 ? '' : 'ieron'} a conversaciones.`
        : `${selectedIds.length} chat${selectedIds.length === 1 ? '' : 's'} se movió${selectedIds.length === 1 ? '' : 'ieron'} a Archivados.`
    )
  }, [activeContactId, archivedViewOpen, selectedChatContacts, showToast])

  const handleRemoveSelectedChatsFromList = useCallback(() => {
    if (selectedChatContacts.length === 0) return
    const selectedSet = new Set(selectedChatContacts.map((contact) => contact.id))
    const nextRemovedStates = [
      ...selectedChatContacts.map((contact) => {
        const snapshot = getChatRemovalSnapshot(contact)
        return {
          contactId: contact.id,
          lastMessageDate: snapshot.lastMessageDate,
          messageCount: snapshot.messageCount,
          removedAt: new Date().toISOString()
        }
      }),
      ...removedChatStatesRef.current.filter((state) => !selectedSet.has(state.contactId))
    ].slice(0, 200)
    const nextArchivedSet = new Set(archivedChatIdSetRef.current)
    selectedSet.forEach((id) => nextArchivedSet.delete(id))

    setRemovedChatStates(nextRemovedStates)
    setArchivedChatIds((current) => current.filter((id) => !selectedSet.has(id)))
    setActiveContactId((current) => (
      current && selectedSet.has(current)
        ? getDefaultActiveChatId(chatsRef.current.filter((item) => !selectedSet.has(item.id)), nextArchivedSet, agentPriorityChatIdSetRef.current, nextRemovedStates)
        : current
    ))
    setSelectedChatIds([])

    showToast(
      'success',
      'Chats eliminados de la vista',
      `${selectedSet.size} chat${selectedSet.size === 1 ? '' : 's'} se ocultó${selectedSet.size === 1 ? '' : 'aron'} sin borrar historial. Volverán si llega un mensaje nuevo.`
    )
  }, [selectedChatContacts, showToast])

  const handleRunBulkConversationAgentAction = useCallback(async (
    action: BulkAgentSelectionAction,
    successTitle: string,
    buildSuccessMessage: (count: number) => string,
    options: { agentId?: string } = {}
  ) => {
    if (selectedChatContacts.length === 0 || bulkAgentActionBusy) return
    if (!conversationAgentEnabled) {
      showToast('warning', 'Chatbot apagado', 'Actívalo en Chatbot para usarlo en los chats.')
      return
    }

    const targets = selectedChatContacts
    setBulkAgentActionBusy(action)
    try {
      const results = await Promise.allSettled(
        targets.map((contact) => conversationalAgentService.updateState(contact.id, action, options))
      )
      const updatedStates = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
      const failedCount = results.length - updatedStates.length
      const firstRejectedResult = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      const firstErrorMessage = firstRejectedResult?.reason?.message

	      if (updatedStates.length > 0) {
	        setAgentStates((current) => {
	          const next = { ...current }
	          updatedStates.forEach((state) => {
	            next[state.contactId] = selectPrimaryAgentState([state, next[state.contactId]].filter(Boolean) as ConversationAgentState[]) || state
	          })
	          return next
	        })
	        setAgentStateLists((current) => {
	          const next = { ...current }
	          updatedStates.forEach((state) => {
	            next[state.contactId] = upsertAgentStateList(next[state.contactId] || [], state)
	          })
	          return next
	        })

	        const activeState = updatedStates.find((state) => state.contactId === activeContactId)
	        if (activeState) {
	          setConversationAgentState((current) => selectPrimaryAgentState([activeState, current].filter(Boolean) as ConversationAgentState[]))
	        }

        setSelectedChatIds([])
        showToast(
          failedCount > 0 ? 'warning' : 'success',
          failedCount > 0 ? 'Algunos chats no cambiaron' : successTitle,
          failedCount > 0
            ? `${updatedStates.length} chat${updatedStates.length === 1 ? '' : 's'} actualizado${updatedStates.length === 1 ? '' : 's'} y ${failedCount} quedó${failedCount === 1 ? '' : 'aron'} pendiente${failedCount === 1 ? '' : 's'}.`
            : buildSuccessMessage(updatedStates.length)
        )
      } else {
        showToast('error', 'No se pudo cambiar el bot', firstErrorMessage || 'Ningún chat seleccionado pudo actualizarse. Intenta otra vez.')
      }
    } finally {
      setBulkAgentActionBusy(null)
    }
  }, [activeContactId, bulkAgentActionBusy, conversationAgentEnabled, selectedChatContacts, showToast])

  const handleAssignSelectedChatsToConversationAgent = useCallback((agentId: string) => {
    const agent = availableAgentDefs.find((item) => item.id === agentId)
    if (!agent) {
      showToast('warning', 'Agente no disponible', 'Elige un agente activo para atender los chats seleccionados.')
      return
    }

    void handleRunBulkConversationAgentAction(
      'activate',
      'Chats enviados a inteligencia artificial',
      (count) => `${agent.name || 'El agente'} atenderá ${count} chat${count === 1 ? '' : 's'} seleccionado${count === 1 ? '' : 's'}.`,
      { agentId }
    )
  }, [availableAgentDefs, handleRunBulkConversationAgentAction, showToast])

  const handleOpenBulkArchiveConfirm = useCallback(() => {
    if (selectedChatContacts.length === 0) return
    setBulkChatConfirmAction('archive')
  }, [selectedChatContacts.length])

  const handleOpenBulkRemoveConfirm = useCallback(() => {
    if (selectedChatContacts.length === 0) return
    setBulkChatConfirmAction('remove')
  }, [selectedChatContacts.length])

  const closeBulkChatConfirm = useCallback(() => {
    setBulkChatConfirmAction(null)
  }, [])

  const openAutomationModal = useCallback(() => {
    if (!hasAutomationsAccess) return
    setAutomationModalOpen(true)
  }, [hasAutomationsAccess])

  useEffect(() => {
    if (!hasAutomationsAccess || !automationModalOpen) return
    let cancelled = false
    setAutomationsLoading(true)
    automationsService.getOverview({ status: 'published', limit: 100 })
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
  }, [automationModalOpen, hasAutomationsAccess])

  const handleEnrollAutomation = async () => {
    if (!hasAutomationsAccess || !activeContact?.id || !selectedAutomationId) return
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
    setAgentInboxStatusFilter(DEFAULT_AGENT_INBOX_STATUS_FILTER)
    setArchivedViewOpen(false)
  }, [])

  const resetAgentInboxFilters = useCallback(() => {
    setChatQuery('')
    setAdvancedFilters(DEFAULT_ADVANCED_FILTERS)
    setAgentInboxStatusFilter(DEFAULT_AGENT_INBOX_STATUS_FILTER)
  }, [])

	  const handleSendMessage = async (textOverride?: string, options: ManualAgentSendOptions = {}) => {
		    const isEmailMessage = isEmailComposer
		    const cleanEmailHtml = isEmailMessage ? sanitizeEmailRichHtmlForEditor(emailBodyHtml) : ''
		    const text = isEmailMessage ? emailHtmlToPlainText(cleanEmailHtml) : (textOverride || composerText).trim()
		    const attachmentsToSend = textOverride || isEmailMessage ? [] : draftAttachments
		    const voiceToSend = textOverride || isEmailMessage ? null : voiceDraft
		    if (!activeContact) return
		    if (!isEmailMessage && !text && attachmentsToSend.length === 0 && !voiceToSend) return

		    // Respuesta a un COMENTARIO (FB/IG).
		    //  - Canal Facebook/Instagram comentario o botón "Responder" => público.
		    //  - Contacto nacido de comentario + canal Messenger/Instagram DM => privado.
		    const privateCommentReply = !selectedCommentReplyTarget &&
		      isCommentContact(activeContact) &&
		      (composerChannel === 'messenger' || composerChannel === 'instagram')
		    if (!isEmailMessage && (selectedCommentReplyTarget || privateCommentReply)) {
		      if (!text) return
		      if (attachmentsToSend.length > 0 || voiceToSend) {
		        showToast('warning', 'Solo texto', 'Las respuestas a comentarios son solo de texto por ahora.')
		        return
		      }
		      const replyType: 'public' | 'private' = selectedCommentReplyTarget ? 'public' : 'private'
		      const commentPlatform = selectedCommentReplyTarget
		        ? selectedCommentReplyTarget.platform
		        : composerChannel === 'instagram'
		          ? 'instagram'
		          : (getCommentPlatform(activeContact) === 'instagram' ? 'instagram' : 'messenger')
		      const optimisticId = `desktop-comment-${Date.now()}`
		      const sentAt = new Date().toISOString()
		      setComposerStatus('sending')
		      if (!textOverride) setComposerText('')
		      setComposerMenuOpen(false)
		      setMessages((current) => [...current, {
		        id: optimisticId,
		        optimisticId,
		        text,
		        date: sentAt,
		        direction: 'outbound',
		        status: 'enviando',
		        transport: commentPlatform,
		        isComment: true,
		        commentReplyMode: replyType
		      } as DesktopChatMessage])
		      try {
		        await whatsappApiService.sendMetaSocialCommentReply({
		          contactId: activeContact.id,
		          platform: commentPlatform,
		          message: text,
		          replyType,
		          commentId: selectedCommentReplyTarget?.commentId,
		          externalId: optimisticId
		        })
		        setCommentReplyTarget(null)
		        setComposerStatus('idle')
		        void loadConversation(activeContact.id, { silent: true, useCache: false })
		      } catch (error) {
		        setComposerStatus('idle')
		        setMessages((current) => current.filter((message) => message.id !== optimisticId))
		        showToast('error', 'No se pudo responder', error instanceof Error ? error.message : 'Intenta de nuevo en un momento.')
		      }
		      return
		    }

		    if (
		      !options.skipAgentInterruptionConfirm &&
		      !isEmailMessage &&
		      conversationAgentEnabled &&
		      activeManualAgentStates.length > 0
		    ) {
		      setManualAgentSendPrompt({ contactId: activeContact.id, textOverride })
		      setComposerMenuOpen(false)
		      closeComposerAgentMenu()
		      return
		    }

		    if (isEmailMessage) {
		      const subject = emailSubject.trim()
		      const recipient = activeContact.email?.trim() || ''
		      const sendEmailThroughHighLevel = highLevelConnected
		      if (!recipient) {
		        showToast('error', 'Falta el correo', 'Guarda el correo del contacto antes de enviarle un email.')
	        return
	      }
	      if (!sendEmailThroughHighLevel && !emailConnected) {
	        showToast('warning', 'Correo no conectado', 'Conecta HighLevel o tu correo de envío en Configuración > Correos.')
	        return
	      }
	      if (!subject) {
	        showToast('warning', 'Falta el asunto', 'Escribe el asunto del correo.')
	        return
	      }
		      if (!text) {
		        showToast('warning', 'Falta el mensaje', 'Escribe el cuerpo del correo.')
		        return
		      }

		      const optimisticId = `desktop-email-${Date.now()}`
		      const sentAt = new Date().toISOString()
	      const optimisticMessage: DesktopChatMessage = {
        id: optimisticId,
        optimisticId,
        text,
	        subject,
	        date: sentAt,
	        direction: 'outbound',
	        status: 'enviando',
	        transport: sendEmailThroughHighLevel ? 'ghl_email' : 'email'
	      }

		      setComposerStatus('sending')
		      if (!textOverride) {
		        setComposerText('')
		        setEmailSubject('')
		        setEmailBodyHtml('')
		      }
		      setComposerMenuOpen(false)
	      setMessages((current) => [...current, optimisticMessage])
	      setChats((current) => {
	        const next = current.map((contact) => (
	          contact.id === activeContact.id
	            ? {
	                ...contact,
	                lastMessageText: `${subject} · ${text}`,
	                lastMessageDate: sentAt,
	                lastMessageDirection: 'outbound',
	                lastMessageChannel: 'email',
	                lastMessageTransport: sendEmailThroughHighLevel ? 'ghl_email' : 'email',
	                messageCount: Number(contact.messageCount || 0) + 1
	              }
	            : contact
	        ))
	        writeCachedChatList(next)
	        return next
	      })

	      try {
	        if (sendEmailThroughHighLevel) {
	          const result = await highLevelService.sendConversationMessage({
	            contactId: activeContact.id,
	            channel: 'email',
	            message: text,
	            subject,
	            html: cleanEmailHtml,
	            externalId: optimisticId
	          })
	          const outcome = getHighLevelChatSendOutcome(result, 'email')
	          const responseIds = getChatSendResponseIds(result)
	          setMessages((current) => current.map((message) => message.id === optimisticId
	            ? {
	                ...message,
	                serverMessageId: responseIds.serverMessageId || message.serverMessageId,
	                providerMessageId: responseIds.providerMessageId || message.providerMessageId,
	                status: outcome.status,
	                transport: outcome.transport || 'ghl_email'
	              }
	            : message
	          ))
	        } else {
	          const result = await emailService.send({
	            contactId: activeContact.id,
		            to: recipient,
		            subject,
		            text,
		            html: cleanEmailHtml,
		            includeSignature: emailIncludeSignature,
		            externalId: optimisticId
		          })
	          const responseIds = getChatSendResponseIds(result)
	          setMessages((current) => current.map((message) => message.id === optimisticId
	            ? {
	                ...message,
	                serverMessageId: responseIds.serverMessageId || message.serverMessageId,
	                providerMessageId: responseIds.providerMessageId || message.providerMessageId,
	                status: result.status || 'sent',
	                transport: 'email'
	              }
	            : message
	          ))
	        }
	        void Promise.all([
	          loadConversation(activeContact.id, { silent: true, useCache: false }),
	          loadChats({ silent: true })
	        ])
	      } catch (error: any) {
	        const message = error?.message || 'Intenta enviar el correo otra vez.'
	        setMessages((current) => current.map((item) => (
	          item.id === optimisticId ? { ...item, status: 'error', errorReason: message } : item
	        )))
		        if (!textOverride) {
		          setComposerText(text)
		          setEmailSubject(subject)
		          setEmailBodyHtml(cleanEmailHtml || plainTextToEmailHtml(text))
		        }
	        showToast('error', 'No se envió el correo', message)
	      } finally {
	        setComposerStatus('idle')
	      }
	      return
	    }

    const sendAttachmentsThroughHighLevel = attachmentsToSend.length > 0 && !activeNativeMetaChannel && highLevelConnected && (
      composerChannel === 'sms' ||
      composerChannel === 'messenger' ||
      composerChannel === 'instagram' ||
      (composerChannel === 'whatsapp' && !selectedBusinessPhone)
    )
    const sendVoiceThroughNativeMeta = Boolean(voiceToSend && activeNativeMetaChannel)
    const sendVoiceThroughHighLevel = Boolean(
      voiceToSend &&
      !activeNativeMetaChannel &&
      highLevelConnected &&
      (
        composerChannel === 'sms' ||
        composerChannel === 'messenger' ||
        composerChannel === 'instagram' ||
        (composerChannel === 'whatsapp' && !selectedBusinessPhone)
      )
    )
    const sendAttachmentsThroughNativeMeta = attachmentsToSend.length > 0 && Boolean(activeNativeMetaChannel)
    const nativeMetaAudio = sendVoiceThroughNativeMeta ? voiceToSend : null

    if (activeNativeMetaChannel === 'instagram' && attachmentsToSend.some((attachment) => getDraftAttachmentMessageType(attachment) === 'document')) {
      showToast('warning', 'Instagram no envía documentos', 'Quita el archivo o mándalo como foto, video, audio o nota de voz.')
      return
    }

    if (nativeMetaAudio && text) {
      showToast('warning', 'Audio sin texto', 'Messenger e Instagram desde Meta nativo no combinan texto y audio en el mismo envío.')
      return
    }

	    if (voiceToSend && !sendVoiceThroughNativeMeta && !sendVoiceThroughHighLevel) {
      if (!activeContact.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar audio por WhatsApp.')
        return
      }
      if (!whatsappConnected && !selectedQrReady) {
        showToast('warning', 'Conecta WhatsApp para audio', 'Los mensajes de voz salen por WhatsApp API o QR.')
        return
      }
    } else if (attachmentsToSend.length > 0 && !sendAttachmentsThroughHighLevel && !sendAttachmentsThroughNativeMeta) {
      if (!activeContact.phone) {
        showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de mandar archivos por WhatsApp.')
        return
      }
      if (!whatsappConnected && !selectedQrReady) {
        showToast('warning', 'Conecta WhatsApp para adjuntos', 'Las fotos y documentos se mandan desde WhatsApp API o QR.')
        return
      }
    } else if (!activeContact.phone && activeConversationChannel !== 'instagram' && activeConversationChannel !== 'messenger') {
      showToast('error', 'Falta el teléfono', 'Guarda el número del contacto antes de escribirle por WhatsApp o SMS.')
      return
    }

    if (
      composerChannel === 'whatsapp' &&
      activeContact.phone &&
      (whatsappConnected || selectedQrReady) &&
      !apiReplyWindowOpen &&
      nativeWhatsAppTransport === 'api' &&
      !sendAttachmentsThroughHighLevel
    ) {
      showToast('warning', 'Usa una plantilla', 'La ventana de 24 horas está cerrada. Con WhatsApp API activa debes enviar una plantilla aprobada.')
      return
    }

    const optimisticId = `desktop-chat-${Date.now()}`
    const sentAt = new Date().toISOString()
    const nativeSendStatus = nativeWhatsAppTransport === 'qr' ? 'enviando por QR' : 'enviando'
    const voiceOptimisticTransport = sendVoiceThroughNativeMeta
      ? activeNativeMetaChannel || activeConversationChannel
      : sendVoiceThroughHighLevel
        ? activeConversationChannel
        : nativeWhatsAppTransport
    const attachmentOptimisticTransport = sendAttachmentsThroughHighLevel
      ? activeConversationChannel
      : sendAttachmentsThroughNativeMeta
        ? activeNativeMetaChannel || activeConversationChannel
        : nativeWhatsAppTransport
    const highLevelOptimisticFromNumber = resolveHighLevelChatFromNumber(activeConversationChannel, {
      smsFromNumber: selectedHighLevelFromNumber,
      whatsappSender: highLevelWhatsAppSender
    })
    const defaultOptimisticUsesHighLevel = Boolean(
      highLevelConnected &&
      !activeNativeMetaChannel &&
      (composerChannel !== 'whatsapp' || !selectedBusinessPhone)
    )
    const optimisticMessages: DesktopChatMessage[] = voiceToSend
      ? [{
          id: `${optimisticId}-audio`,
          optimisticId: `${optimisticId}-audio`,
          text: '',
          date: sentAt,
          direction: 'outbound',
          status: sendVoiceThroughNativeMeta || sendVoiceThroughHighLevel ? 'enviando' : nativeSendStatus,
          businessPhone: sendVoiceThroughHighLevel ? highLevelOptimisticFromNumber : selectedBusinessPhoneValue,
          businessPhoneNumberId: sendVoiceThroughHighLevel ? '' : selectedBusinessPhone?.id || '',
          transport: voiceOptimisticTransport,
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
          optimisticId: `${optimisticId}-attachment-${index}`,
          text: sendAttachmentsThroughNativeMeta ? '' : index === 0 ? text : '',
          date: sentAt,
          direction: 'outbound',
          status: sendAttachmentsThroughHighLevel || sendAttachmentsThroughNativeMeta ? 'enviando' : nativeSendStatus,
          businessPhone: sendAttachmentsThroughHighLevel ? highLevelOptimisticFromNumber : selectedBusinessPhoneValue,
          businessPhoneNumberId: sendAttachmentsThroughHighLevel ? '' : selectedBusinessPhone?.id || '',
          transport: attachmentOptimisticTransport,
          attachment: {
            type: getDraftAttachmentMessageType(attachment),
            dataUrl: attachment.dataUrl,
            name: attachment.name,
            mimeType: attachment.mimeType
          }
        }))
      : [{
          id: optimisticId,
          optimisticId,
          text,
          date: sentAt,
          direction: 'outbound',
          status: composerChannel === 'whatsapp' && (whatsappConnected || selectedQrReady) ? nativeSendStatus : 'enviando',
          businessPhone: defaultOptimisticUsesHighLevel ? highLevelOptimisticFromNumber : selectedBusinessPhoneValue,
          businessPhoneNumberId: defaultOptimisticUsesHighLevel ? '' : selectedBusinessPhone?.id || '',
          transport: composerChannel === 'whatsapp' && (whatsappConnected || selectedQrReady) ? nativeWhatsAppTransport : activeConversationChannel
        }]

    if (sendAttachmentsThroughNativeMeta && text) {
      optimisticMessages.unshift({
        id: `${optimisticId}-text`,
        optimisticId: `${optimisticId}-text`,
        text,
        date: sentAt,
        direction: 'outbound',
        status: 'enviando',
        businessPhone: selectedBusinessPhoneValue,
        businessPhoneNumberId: selectedBusinessPhone?.id || '',
        transport: activeNativeMetaChannel || activeConversationChannel
      })
    }

    setComposerStatus('sending')
    if (!textOverride) setComposerText('')
    setDraftAttachments([])
    setVoiceDraft(null)
    setVoiceElapsedMs(0)
    setComposerMenuOpen(false)
    setMessages((current) => [...current, ...optimisticMessages])
    setChats((current) => {
      const next = current.map((contact) => (
        contact.id === activeContact.id
          ? {
              ...contact,
              lastMessageText: voiceToSend ? 'Mensaje de voz' : attachmentsToSend.length > 0 ? (text || getAttachmentPreviewText(attachmentsToSend)) : text,
              lastMessageDate: sentAt,
              lastMessageDirection: 'outbound',
              messageCount: Number(contact.messageCount || 0) + Math.max(
                1,
                voiceToSend ? 1 : attachmentsToSend.length + (sendAttachmentsThroughNativeMeta && text ? 1 : 0)
              )
            }
          : contact
      ))
      writeCachedChatList(next)
      return next
    })

    try {
      if (nativeMetaAudio && activeNativeMetaChannel) {
        const nativeMetaOptimisticId = voiceToSend ? `${optimisticId}-audio` : `${optimisticId}-attachment-0`
        const nativeMetaAudioDurationMs = getNativeMetaAudioDurationMs(nativeMetaAudio)
        const result = await whatsappApiService.sendMetaSocialAudio({
          contactId: activeContact.id,
          platform: activeNativeMetaChannel,
          audioDataUrl: nativeMetaAudio.dataUrl,
          audioMimeType: nativeMetaAudio.type,
          filename: nativeMetaAudio.name,
          durationMs: nativeMetaAudioDurationMs,
          voice: Boolean(sendVoiceThroughNativeMeta),
          externalId: nativeMetaOptimisticId
        })
        const resultData = result.data || result
        const responseAudioUrl = result.audio?.link || result.audio?.url || result.localMedia?.publicUrl || ''
        const responseAudioMimeType = result.audio?.mimeType || result.audio?.mimetype || result.localMedia?.mimeType || ''
        const responseAudioDurationMs = Number(result.audio?.durationMs || 0) || nativeMetaAudioDurationMs
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => message.id === nativeMetaOptimisticId
          ? {
              ...message,
              serverMessageId: responseIds.serverMessageId || message.serverMessageId,
              providerMessageId: responseIds.providerMessageId || message.providerMessageId,
              status: resultData.status || 'sent',
              transport: resultData.transport || activeNativeMetaChannel,
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
        ))
      } else if (voiceToSend && sendVoiceThroughHighLevel) {
        const result = await highLevelService.sendConversationMessage({
          contactId: activeContact.id,
          channel: activeConversationChannel,
          fromNumber: resolveHighLevelChatFromNumber(activeConversationChannel, {
            smsFromNumber: selectedHighLevelFromNumber,
            whatsappSender: highLevelWhatsAppSender
          }) || undefined,
          message: '',
          audioDataUrl: voiceToSend.dataUrl,
          durationMs: voiceToSend.durationMs,
          toNumber: activeContact.phone || undefined,
          externalId: `${optimisticId}-audio`
        })
        const resultData = result.data || result
        const outcome = getHighLevelChatSendOutcome(result, activeConversationChannel)
        const responseAudioUrl = resultData.audio?.link || resultData.audio?.url || resultData.localMedia?.publicUrl || ''
        const responseAudioMimeType = resultData.audio?.mimeType || resultData.localMedia?.mimeType || ''
        const responseAudioDurationMs = Number(resultData.audio?.durationMs || 0) || voiceToSend.durationMs
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => message.id === `${optimisticId}-audio`
          ? {
              ...message,
              serverMessageId: responseIds.serverMessageId || message.serverMessageId,
              providerMessageId: responseIds.providerMessageId || message.providerMessageId,
              status: outcome.status,
              transport: outcome.transport || activeConversationChannel,
              routingReason: getHighLevelRouteChangeMessage(outcome) || message.routingReason,
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
        ))
        const routeChangeMessage = getHighLevelRouteChangeMessage(outcome)
        if (routeChangeMessage) showToast('warning', 'HighLevel cambió el canal', routeChangeMessage)
      } else if (voiceToSend) {
        const result = await whatsappApiService.sendAudio({
          to: activeContact.phone || '',
          from: selectedBusinessPhoneValue,
          contactId: activeContact.id,
          audioDataUrl: voiceToSend.dataUrl,
          durationMs: voiceToSend.durationMs,
          voice: true,
          externalId: `${optimisticId}-audio`,
          transport: nativeWhatsAppTransport,
          phoneNumberId: selectedBusinessPhone?.id || undefined,
          messageOrigin: 'manual_chat'
        })
        const responseAudioUrl = result.audio?.link || result.audio?.url || result.localMedia?.publicUrl || ''
        const responseAudioMimeType = result.audio?.mimeType || result.audio?.mimetype || result.localMedia?.mimeType || ''
        const responseAudioDurationMs = Number(result.audio?.durationMs || 0) || voiceToSend.durationMs
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => message.id === `${optimisticId}-audio`
          ? {
              ...message,
              serverMessageId: responseIds.serverMessageId || message.serverMessageId,
              providerMessageId: responseIds.providerMessageId || message.providerMessageId,
              status: result.status || 'sent',
              transport: result.transport || message.transport,
              routingReason: result.routingReason || result.fallbackReason || message.routingReason,
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
        if (sendAttachmentsThroughHighLevel) {
          const result = await highLevelService.sendConversationMessage({
            contactId: activeContact.id,
            channel: activeConversationChannel,
            fromNumber: resolveHighLevelChatFromNumber(activeConversationChannel, {
              smsFromNumber: selectedHighLevelFromNumber,
              whatsappSender: highLevelWhatsAppSender
            }) || undefined,
            message: text,
            attachmentDataUrls: attachmentsToSend.map((attachment) => ({
              dataUrl: attachment.dataUrl,
              filename: attachment.name,
              mimeType: attachment.mimeType,
              kind: attachment.deliveryMode === 'document' ? 'document' : attachment.kind
            })),
            toNumber: activeContact.phone || undefined,
            externalId: optimisticId
          })
          const outcome = getHighLevelChatSendOutcome(result, activeConversationChannel)
          const responseIds = getChatSendResponseIds(result)
          setMessages((current) => current.map((message) => (
            message.id.startsWith(`${optimisticId}-attachment-`)
              ? {
                  ...message,
                  serverMessageId: message.id === `${optimisticId}-attachment-0`
                    ? responseIds.serverMessageId || message.serverMessageId
                    : message.serverMessageId,
                  providerMessageId: message.id === `${optimisticId}-attachment-0`
                    ? responseIds.providerMessageId || message.providerMessageId
                    : message.providerMessageId,
                  status: outcome.status,
                  transport: outcome.transport || activeConversationChannel,
                  routingReason: getHighLevelRouteChangeMessage(outcome) || message.routingReason
                }
              : message
          )))
          const routeChangeMessage = getHighLevelRouteChangeMessage(outcome)
          if (routeChangeMessage) showToast('warning', 'HighLevel cambió el canal', routeChangeMessage)
        } else if (sendAttachmentsThroughNativeMeta && activeNativeMetaChannel) {
          const failedAttachments: DesktopDraftAttachment[] = []
          let textFailed = false
          let firstErrorMessage = ''

          if (text) {
            const nativeMetaTextOptimisticId = `${optimisticId}-text`
            try {
              const result = await whatsappApiService.sendMetaSocialText({
                contactId: activeContact.id,
                platform: activeNativeMetaChannel,
                message: text,
                externalId: nativeMetaTextOptimisticId
              })
              const resultData = result.data || result
              const responseIds = getChatSendResponseIds(result)
              setMessages((current) => current.map((message) => message.id === nativeMetaTextOptimisticId
                ? {
                    ...message,
                    serverMessageId: responseIds.serverMessageId || message.serverMessageId,
                    providerMessageId: responseIds.providerMessageId || message.providerMessageId,
                    status: resultData.status || 'sent',
                    transport: resultData.transport || activeNativeMetaChannel
                  }
                : message
              ))
            } catch (error: any) {
              textFailed = true
              firstErrorMessage = error?.message || 'No se pudo enviar el texto.'
              setMessages((current) => current.map((message) => message.id === nativeMetaTextOptimisticId
                ? { ...message, status: 'error', errorReason: firstErrorMessage }
                : message
              ))
            }
          }

          for (const [index, attachment] of attachmentsToSend.entries()) {
            const nativeMetaOptimisticId = `${optimisticId}-attachment-${index}`
            const attachmentType = getDraftAttachmentMessageType(attachment)
            try {
              const result = attachmentType === 'audio'
                ? await whatsappApiService.sendMetaSocialAudio({
                    contactId: activeContact.id,
                    platform: activeNativeMetaChannel,
                    audioDataUrl: attachment.dataUrl,
                    audioMimeType: attachment.mimeType,
                    filename: attachment.name,
                    voice: attachment.deliveryMode === 'voice',
                    externalId: nativeMetaOptimisticId
                  })
                : await whatsappApiService.sendMetaSocialAttachment({
                    contactId: activeContact.id,
                    platform: activeNativeMetaChannel,
                    attachmentType: attachmentType === 'document' ? 'file' : attachmentType,
                    attachmentDataUrl: attachment.dataUrl,
                    filename: attachment.name,
                    mimeType: attachment.mimeType,
                    externalId: nativeMetaOptimisticId
                  })
              const resultData = result.data || result
              const resultMedia = (result.attachment || result.document || result.image || result.video || result.audio || null) as {
                link?: string
                url?: string
                mimeType?: string
                mimetype?: string
                filename?: string
                fileName?: string
                durationMs?: number
              } | null
              const mediaUrl = resultMedia?.link || resultMedia?.url || result.localMedia?.publicUrl || ''
              const mediaMimeType = resultMedia?.mimeType || resultMedia?.mimetype || result.localMedia?.mimeType || ''
              const mediaFilename = resultMedia?.filename || resultMedia?.fileName || result.localMedia?.filename || ''
              const mediaDurationMs = Number(resultMedia?.durationMs || 0) || undefined
              const responseIds = getChatSendResponseIds(result)
              setMessages((current) => current.map((message) => message.id === nativeMetaOptimisticId
                ? {
                    ...message,
                    serverMessageId: responseIds.serverMessageId || message.serverMessageId,
                    providerMessageId: responseIds.providerMessageId || message.providerMessageId,
                    status: resultData.status || 'sent',
                    transport: resultData.transport || activeNativeMetaChannel,
                    attachment: message.attachment
                      ? {
                          ...message.attachment,
                          ...(mediaUrl ? { url: mediaUrl } : {}),
                          ...(mediaMimeType ? { mimeType: mediaMimeType } : {}),
                          ...(mediaFilename ? { name: mediaFilename } : {}),
                          ...(mediaDurationMs ? { durationMs: mediaDurationMs } : {})
                        }
                      : message.attachment
                  }
                : message
              ))
            } catch (error: any) {
              const errorMessage = error?.message || `No se pudo enviar ${attachment.name}.`
              if (!firstErrorMessage) firstErrorMessage = errorMessage
              failedAttachments.push(attachment)
              setMessages((current) => current.map((message) => message.id === nativeMetaOptimisticId
                ? { ...message, status: 'error', errorReason: errorMessage }
                : message
              ))
            }
          }

          if (textFailed || failedAttachments.length > 0) {
            if (!textOverride) {
              if (textFailed) setComposerText(text)
              setDraftAttachments(failedAttachments)
            }
            showToast(
              'error',
              textFailed && failedAttachments.length === attachmentsToSend.length ? 'No se envió el mensaje' : 'Parte del envío falló',
              firstErrorMessage || 'Revisa los elementos marcados e intenta enviarlos otra vez.'
            )
          }
        } else {
          const results = await Promise.all(attachmentsToSend.map((attachment, index) => {
            const attachmentType = getDraftAttachmentMessageType(attachment)
            if (attachmentType === 'image') {
              return whatsappApiService.sendImage({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                contactId: activeContact.id,
                imageDataUrl: attachment.dataUrl,
                caption: index === 0 ? text : '',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: nativeWhatsAppTransport,
                phoneNumberId: selectedBusinessPhone?.id || undefined,
                messageOrigin: 'manual_chat'
              })
            }

            if (attachmentType === 'video') {
              return whatsappApiService.sendVideo({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                contactId: activeContact.id,
                videoDataUrl: attachment.dataUrl,
                caption: index === 0 ? text : '',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: nativeWhatsAppTransport,
                phoneNumberId: selectedBusinessPhone?.id || undefined,
                messageOrigin: 'manual_chat'
              })
            }

            if (attachmentType === 'audio') {
              return whatsappApiService.sendAudio({
                to: activeContact.phone || '',
                from: selectedBusinessPhoneValue,
                contactId: activeContact.id,
                audioDataUrl: attachment.dataUrl,
                durationMs: undefined,
                voice: attachment.deliveryMode === 'voice',
                externalId: `${optimisticId}-attachment-${index}`,
                transport: nativeWhatsAppTransport,
                phoneNumberId: selectedBusinessPhone?.id || undefined,
                messageOrigin: 'manual_chat'
              })
            }

            return whatsappApiService.sendDocument({
              to: activeContact.phone || '',
              from: selectedBusinessPhoneValue,
              contactId: activeContact.id,
              documentDataUrl: attachment.dataUrl,
              filename: attachment.name,
              mimeType: attachment.mimeType,
              caption: index === 0 ? text : '',
              externalId: `${optimisticId}-attachment-${index}`,
              transport: nativeWhatsAppTransport,
              phoneNumberId: selectedBusinessPhone?.id || undefined,
              messageOrigin: 'manual_chat'
            })
          }))
          setMessages((current) => current.map((message) => (
            message.id.startsWith(`${optimisticId}-attachment-`)
              ? (() => {
                  const result = results[Number(message.id.replace(`${optimisticId}-attachment-`, ''))]
                  const resultMedia = result?.document || result?.image || result?.video || result?.audio || null
                  const mediaUrl = resultMedia?.link || resultMedia?.url || result?.localMedia?.publicUrl || ''
                  const mediaMimeType = resultMedia?.mimeType || resultMedia?.mimetype || result?.localMedia?.mimeType || ''
                  const mediaFilename = result?.document?.filename || result?.document?.fileName || result?.video?.filename || result?.localMedia?.filename || ''
                  const responseIds = getChatSendResponseIds(result)
                  return {
                    ...message,
                    serverMessageId: responseIds.serverMessageId || message.serverMessageId,
                    providerMessageId: responseIds.providerMessageId || message.providerMessageId,
                    status: result?.status || 'sent',
                    transport: result?.transport || message.transport,
                    routingReason: result?.routingReason || result?.fallbackReason || message.routingReason,
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
        }
      } else if (composerChannel === 'whatsapp' && (whatsappConnected || selectedQrReady) && activeContact.phone) {
        const result = await whatsappApiService.sendText({
          to: activeContact.phone,
          from: selectedBusinessPhoneValue,
          contactId: activeContact.id,
          text,
          externalId: optimisticId,
          transport: nativeWhatsAppTransport,
          phoneNumberId: selectedBusinessPhone?.id || undefined,
          messageOrigin: 'manual_chat'
        })
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => message.id === optimisticId ? {
          ...message,
          serverMessageId: responseIds.serverMessageId || message.serverMessageId,
          providerMessageId: responseIds.providerMessageId || message.providerMessageId,
          status: result.status || 'sent',
          transport: result.transport || message.transport,
          routingReason: result.routingReason || result.fallbackReason || message.routingReason
        } : message))
      } else if (activeNativeMetaChannel === 'messenger') {
        const result = await whatsappApiService.sendMetaSocialText({
          contactId: activeContact.id,
          platform: 'messenger',
          message: text,
          externalId: optimisticId
        })
        const data = result.data || result
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? { ...message, serverMessageId: responseIds.serverMessageId || message.serverMessageId, providerMessageId: responseIds.providerMessageId || message.providerMessageId, status: data.status || 'sent', transport: data.transport || 'messenger' }
            : message
        )))
      } else if (activeNativeMetaChannel === 'instagram') {
        const result = await whatsappApiService.sendMetaSocialText({
          contactId: activeContact.id,
          platform: 'instagram',
          message: text,
          externalId: optimisticId
        })
        const data = result.data || result
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? { ...message, serverMessageId: responseIds.serverMessageId || message.serverMessageId, providerMessageId: responseIds.providerMessageId || message.providerMessageId, status: data.status || 'sent', transport: data.transport || 'instagram' }
            : message
        )))
      } else if (highLevelConnected && (composerChannel !== 'whatsapp' || !selectedBusinessPhone)) {
        const result = await highLevelService.sendConversationMessage({
          contactId: activeContact.id,
          channel: activeConversationChannel,
          fromNumber: resolveHighLevelChatFromNumber(activeConversationChannel, {
            smsFromNumber: selectedHighLevelFromNumber,
            whatsappSender: highLevelWhatsAppSender
          }) || undefined,
          message: text,
          toNumber: activeContact.phone || undefined,
          externalId: optimisticId
        })
        const outcome = getHighLevelChatSendOutcome(result, activeConversationChannel)
        const responseIds = getChatSendResponseIds(result)
        setMessages((current) => current.map((message) => (
          message.id === optimisticId
            ? {
                ...message,
                serverMessageId: responseIds.serverMessageId || message.serverMessageId,
                providerMessageId: responseIds.providerMessageId || message.providerMessageId,
                status: outcome.status,
                transport: outcome.transport || activeConversationChannel,
                routingReason: getHighLevelRouteChangeMessage(outcome) || message.routingReason
              }
            : message
        )))
        const routeChangeMessage = getHighLevelRouteChangeMessage(outcome)
        if (routeChangeMessage) showToast('warning', 'HighLevel cambió el canal', routeChangeMessage)
      } else {
        throw new Error('Conecta el canal nativo correspondiente para enviar mensajes desde esta pantalla.')
      }
      void Promise.all([
        loadConversation(activeContact.id, { silent: true, useCache: false }),
        loadChats({ silent: true })
      ])
    } catch (error: any) {
      const message = error?.message || 'Intenta enviar el mensaje otra vez.'
      setMessages((current) => current.map((item) => (
        item.id === optimisticId || item.id === `${optimisticId}-text` || item.id === `${optimisticId}-audio` || item.id.startsWith(`${optimisticId}-attachment-`)
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

  const handleReactToMessage = async (message: DesktopChatMessage, emoji: string) => {
    if (!activeContact || reactingMessageId === message.id) return
    const reactionChannel = getMessageReactionChannel(message)
    const providerMessageId = getMessageProviderMessageId(message)
    if (!reactionChannel) {
      showToast('warning', 'Canal sin reacción nativa', 'Ese mensaje no tiene una ruta nativa conectada para reaccionar al globo.')
      return
    }
    if (!providerMessageId) {
      showToast('warning', 'Falta ID del mensaje', 'Este mensaje no tiene el ID remoto necesario para reaccionar.')
      return
    }

    const metaPlatform = reactionChannel === 'messenger' || reactionChannel === 'instagram' ? reactionChannel : null
    if (metaPlatform && !META_MESSAGE_REACTION_EMOJIS.includes(emoji)) {
      showToast('warning', 'Meta solo permite corazón', 'Messenger e Instagram solo aceptan corazón como reacción desde la API.')
      return
    }

    const optimisticReactionId = `desktop-reaction-${Date.now()}`
    setReactingMessageId(message.id)
    setMessages((current) => current.map((item) => (
      item.id === message.id
        ? {
            ...item,
            reactions: [
              ...(item.reactions || []).filter((reaction) => reaction.direction !== 'outbound'),
              { id: optimisticReactionId, emoji, direction: 'outbound' as const }
            ]
          }
        : item
    )))

    try {
      if (metaPlatform) {
        await whatsappApiService.sendMetaSocialReaction({
          contactId: activeContact.id,
          platform: metaPlatform,
          emoji,
          targetMessageId: message.id,
          targetProviderMessageId: providerMessageId,
          externalId: optimisticReactionId
        })
      } else {
        if (!activeContact.phone) throw new Error('Guarda el teléfono del contacto antes de reaccionar.')
        const reactionBusinessPhone = getMessageBusinessPhone(message, whatsappStatus) || selectedBusinessPhone
        const fromPhone = message.businessPhone || getBusinessPhoneValue(reactionBusinessPhone) || selectedBusinessPhoneValue
        if (!fromPhone) throw new Error('Selecciona el número de WhatsApp del negocio.')
        await whatsappApiService.sendReaction({
          to: activeContact.phone,
          from: fromPhone,
          contactId: activeContact.id,
          emoji,
          targetMessageId: message.id,
          targetProviderMessageId: providerMessageId,
          externalId: optimisticReactionId,
          transport: reactionChannel === 'whatsapp_qr' ? 'qr' : 'api',
          phoneNumberId: message.businessPhoneNumberId || reactionBusinessPhone?.id || selectedBusinessPhone?.id || undefined,
          messageOrigin: 'manual_chat'
        })
      }

      await Promise.all([
        loadConversation(activeContact.id, { silent: true, useCache: false }),
        loadChats({ silent: true })
      ])
    } catch (error) {
      setMessages((current) => current.map((item) => (
        item.id === message.id
          ? { ...item, reactions: (item.reactions || []).filter((reaction) => reaction.id !== optimisticReactionId) }
          : item
      )))
      showToast('error', 'No se pudo reaccionar', getErrorMessage(error, 'Intenta reaccionar otra vez.'))
    } finally {
      setReactingMessageId((current) => (current === message.id ? null : current))
    }
  }

  const handleManualAgentSendDecision = async (action: ManualAgentInterruptionAction) => {
    if (!manualAgentSendPrompt || !activeContact?.id) return false
    if (manualAgentSendPrompt.contactId !== activeContact.id) {
      setManualAgentSendPrompt(null)
      showToast('warning', 'El chat cambió', 'Vuelve a mandar el mensaje desde la conversación abierta.')
      return false
    }

    const targetStates = activeManualAgentStates.filter((state) => state.agentId)
    if (!targetStates.length) {
      setManualAgentSendPrompt(null)
      await handleSendMessage(manualAgentSendPrompt.textOverride, { skipAgentInterruptionConfirm: true })
      return
    }

    setConversationAgentBusy(true)
    try {
      const updatedStates = await Promise.all(targetStates.map((state) => (
        conversationalAgentService.updateState(activeContact.id, action, { agentId: state.agentId || undefined })
      )))
      updatedStates.forEach(updateActiveConversationAgentState)
      setManualAgentSendPrompt(null)
      showToast(
        'success',
        action === 'pause' ? 'Agente pausado 24 horas' : 'Contacto omitido del agente',
        action === 'pause'
          ? `${manualAgentSendLabel} no responderá este chat durante 24 horas.`
          : `${manualAgentSendLabel} ya no tomará este contacto automáticamente.`
      )
      await handleSendMessage(manualAgentSendPrompt.textOverride, { skipAgentInterruptionConfirm: true })
    } catch (error: any) {
      showToast('error', 'No se pudo pausar el agente', error?.message || 'El mensaje no se envió. Intenta otra vez.')
      return false
    } finally {
      setConversationAgentBusy(false)
    }
  }

  const renderTemplatePanel = () => {
    if (!templatePanelOpen) return null

    const closePanel = () => {
      setTemplatePanelOpen(false)
      setTemplateSearch('')
    }
    const canSelectTemplates = templates.length > 0

    const renderPanelHeader = (title: string, subtitle?: string, showBack = false) => (
      <div className={styles.templatePanelHeader}>
        <div className={styles.templatePanelTitle}>
          {showBack ? (
            <button type="button" className={styles.templateBackButton} onClick={() => setTemplatePanelMode('choice')} aria-label="Volver a opciones de plantillas">
              <ChevronLeft size={16} />
            </button>
          ) : (
            <span className={styles.templateHeaderIcon}>
              <FileText size={16} />
            </span>
          )}
          <span>
            <strong>{title}</strong>
            {subtitle ? <small>{subtitle}</small> : null}
          </span>
        </div>
        <button type="button" className={styles.templateCloseButton} onClick={closePanel} aria-label="Cerrar plantillas">
          <X size={16} />
        </button>
      </div>
    )

    if (templatePanelMode === 'create') {
      return (
        <div className={styles.templatePanel} role="dialog" aria-label="Crear plantilla desde el chat">
          {renderPanelHeader('Nueva plantilla', 'Guárdala sin salir del chat.', true)}
          <form
            className={styles.templateForm}
            onSubmit={(event) => {
              event.preventDefault()
              void handleCreateQuickTemplate()
            }}
          >
            <label>
              <span>Nombre</span>
              <input
                value={newTemplateName}
                onChange={(event) => setNewTemplateName(event.target.value)}
                onBlur={() => setNewTemplateName(normalizeTemplateNameInput(newTemplateName))}
                placeholder="ej. recordatorio_cita"
              />
            </label>
            <div className={styles.templateFormGrid}>
              <label>
                <span>Categoría</span>
                <CustomSelect value={newTemplateCategory} onChange={(event) => setNewTemplateCategory(event.target.value as MessageTemplateCategory)}>
                  {QUICK_TEMPLATE_CATEGORIES.map((category) => (
                    <option key={category.value} value={category.value}>{category.label}</option>
                  ))}
                </CustomSelect>
              </label>
              <label>
                <span>Idioma</span>
                <CustomSelect value={newTemplateLanguage} onChange={(event) => setNewTemplateLanguage(event.target.value)}>
                  {QUICK_TEMPLATE_LANGUAGES.map((language) => (
                    <option key={language.value} value={language.value}>{language.label}</option>
                  ))}
                </CustomSelect>
              </label>
            </div>
            <label>
              <span>Mensaje</span>
              <textarea
                value={newTemplateBody}
                onChange={(event) => setNewTemplateBody(event.target.value)}
                placeholder="Hola, te escribo para confirmar..."
                rows={5}
              />
            </label>
            <Button type="submit" loading={creatingTemplate} fullWidth>
              Guardar y enviar a revisión
            </Button>
          </form>
        </div>
      )
    }

    if (templatePanelMode === 'select') {
      return (
        <div className={styles.templatePanel} role="dialog" aria-label="Seleccionar plantilla guardada">
          {renderPanelHeader('Seleccionar plantilla', `${templates.length} guardada${templates.length === 1 ? '' : 's'}`, true)}
          <SearchField
            className={styles.templateSearchField}
            value={templateSearch}
            placeholder="Buscar plantilla..."
            autoFocus
            onChange={(nextSearch) => setTemplateSearch(nextSearch)}
            onClear={() => setTemplateSearch('')}
            clearLabel="Limpiar búsqueda de plantillas"
            size="sm"
          />
          {templatesError ? (
            <div className={styles.templateEmptyState}>
              <CircleAlert size={18} />
              <span>{templatesError}</span>
              <button type="button" onClick={() => { void loadTemplates() }}>Reintentar</button>
            </div>
          ) : templatesLoading && templates.length === 0 ? (
            <div className={styles.templateLoadingState} role="status" aria-live="polite">
              <Loader2 size={18} className={styles.spin} />
              <span>Cargando plantillas</span>
            </div>
          ) : filteredTemplates.length === 0 ? (
            <div className={styles.templateEmptyState}>
              <FileText size={18} />
              <span>{templateSearch ? 'No encontré plantillas con ese nombre.' : 'Todavía no hay plantillas guardadas.'}</span>
              <button type="button" onClick={() => setTemplatePanelMode('create')}>Crear nueva</button>
            </div>
          ) : (
            <div className={styles.templateList} role="listbox" aria-label="Plantillas guardadas">
              {filteredTemplates.map((template) => {
                const status = getTemplateStatus(template)
                const approved = status === 'APPROVED'
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
                    onClick={() => { void handleSendTemplate(template) }}
                    disabled={!approved || Boolean(templateSendingId)}
                    role="option"
                    aria-selected="false"
                  >
                    <span className={styles.templateRowIcon}>
                      <FileText size={16} />
                    </span>
                    <span className={styles.templateRowMain}>
                      <strong>{template.name}</strong>
                      <small>{getTemplateBodyPreview(template)}</small>
                      {!approved ? <em>{getTemplateBlockedReason(template)}</em> : null}
                    </span>
                    <span className={`${styles.templateStatus} ${statusClass}`}>
                      {templateSendingId === template.id ? <Loader2 size={12} className={styles.spin} /> : getTemplateStatusLabel(status)}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )
    }

    return (
      <div className={styles.templatePanel} role="dialog" aria-label="Plantillas del chat">
        {renderPanelHeader('Plantillas', templatesLoaded && !canSelectTemplates ? 'Crea la primera plantilla.' : 'Trabaja sin salir del chat.')}
        <div className={styles.templateChoiceList}>
          {templatesLoading && !templatesLoaded ? (
            <div className={styles.templateLoadingState} role="status" aria-live="polite">
              <Loader2 size={18} className={styles.spin} />
              <span>Cargando plantillas</span>
            </div>
          ) : null}
          {canSelectTemplates ? (
            <button type="button" className={styles.templateChoiceButton} onClick={() => {
              setTemplateSearch('')
              setTemplatePanelMode('select')
            }}>
              <span><Search size={17} /></span>
              <strong>Seleccionar plantilla</strong>
              <small>Busca una guardada y envíala directo al chat.</small>
            </button>
          ) : null}
          <button type="button" className={styles.templateChoiceButton} onClick={() => setTemplatePanelMode('create')}>
            <span><Plus size={17} /></span>
            <strong>Crear nueva plantilla</strong>
            <small>Escribe el mensaje y mándalo a revisión.</small>
          </button>
        </div>
        {templatesError ? (
          <div className={styles.templateInlineError}>
            <CircleAlert size={15} />
            <span>{templatesError}</span>
            <button type="button" onClick={() => { void loadTemplates() }}>Reintentar</button>
          </div>
        ) : null}
      </div>
    )
  }

	  const renderComposerAgentMenu = () => {
	    if (!agentComposerMenuOpen || !activeContact) return null

	    const contactAgentStates = activeContactAgentStates.filter((state) => state.agentId)
	    const showPicker = agentPickerOpen || !contactAgentStates.length
	    const noPublishedAgents = availableAgentDefs.length === 0
	    const getStateAgentName = (state: ConversationAgentState) => (
	      state.agentName ||
	      agentDefs.find((agent) => agent.id === state.agentId)?.name ||
	      'Chatbot'
	    )

	    if (showPicker) {
      return (
        <div className={styles.agentComposerMenu} role="menu" aria-label="Seleccionar chatbot">
          <div className={styles.agentComposerMenuHeader}>
            <strong>Asignar agente</strong>
            <span>{noPublishedAgents ? 'No hay agentes publicados.' : 'Elige quién atenderá este chat.'}</span>
          </div>
          {availableAgentDefs.length > 0 ? (
            <div className={styles.agentPickerList}>
              {availableAgentDefs.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="menuitem"
                  onClick={() => handleAssignConversationAgent(agent.id)}
                  disabled={conversationAgentBusy}
                >
                  <span className={styles.agentPickerIcon}>
                    <Bot size={15} />
                  </span>
                  <span>
                    <strong>{agent.name || 'Agente sin nombre'}</strong>
                    <small>{getConversationAgentObjectiveLabel(agent.objective)}</small>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className={styles.agentComposerHint}>No hay agentes publicados. Créalo en Chatbot.</p>
          )}
        </div>
      )
    }

	    return (
	      <div className={styles.agentComposerMenu} role="menu" aria-label="Acciones del chatbot">
	        <div className={styles.agentComposerMenuHeader}>
	          <strong>{contactAgentStates.length > 1 ? 'Agentes asignados' : (activeAgentDef?.name || contactAgentStates[0]?.agentName || 'Chatbot')}</strong>
	          <span>{contactAgentStates.length > 1 ? `${contactAgentStates.length} agentes en este chat` : conversationAgentStatusLabel}</span>
	        </div>
	        {contactAgentStates.map((state) => {
	          const agentName = getStateAgentName(state)
	          const statusLabel = CONVERSATION_AGENT_STATUS_LABELS[state.status] || 'Chatbot'
	          const actionOptions = { agentId: state.agentId || undefined }
	          if (state.status !== 'active') {
	            return (
	              <button
	                key={state.id || `${state.contactId}-${state.agentId || 'legacy'}`}
	                type="button"
	                role="menuitem"
	                className={styles.agentMenuAction}
	                disabled={conversationAgentBusy}
	                onClick={() => handleRunConversationAgentAction('activate', `${agentName} volvió a atender este chat.`, actionOptions)}
	              >
	                <Play size={15} />
	                <span>
	                  <strong>Reactivar {agentName}</strong>
	                  <small>{statusLabel}</small>
	                </span>
	              </button>
	            )
	          }
	          return (
	            <React.Fragment key={state.id || `${state.contactId}-${state.agentId || 'legacy'}`}>
	              <button
	                type="button"
	                role="menuitem"
	                className={styles.agentMenuAction}
	                disabled={conversationAgentBusy}
	                onClick={() => handleRunConversationAgentAction('take_over', `Tomaste la conversación de ${getContactName(activeContact)} con ${agentName}.`, actionOptions)}
	              >
	                <User size={15} />
	                <span>
	                  <strong>Tomar {agentName}</strong>
	                  <small>Solo este agente deja de responder aquí.</small>
	                </span>
	              </button>
	              <button
	                type="button"
	                role="menuitem"
	                className={styles.agentMenuAction}
	                disabled={conversationAgentBusy}
	                onClick={() => handleRunConversationAgentAction('pause', `${agentName} quedó pausado por 24hrs en este chat.`, actionOptions)}
	              >
	                <Pause size={15} />
	                <span>
	                  <strong>Pausar {agentName}</strong>
	                  <small>Detiene solo este agente durante 24 horas.</small>
	                </span>
	              </button>
	              <button
	                type="button"
	                role="menuitem"
	                className={styles.agentMenuAction}
	                disabled={conversationAgentBusy}
	                onClick={() => handleRunConversationAgentAction('skip', `${agentName} quedó omitido en este chat.`, actionOptions)}
	              >
	                <X size={15} />
	                <span>
	                  <strong>Omitir {agentName}</strong>
	                  <small>Solo este agente no vuelve a tomar este chat.</small>
	                </span>
	              </button>
	            </React.Fragment>
	          )
	        })}
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

  const renderComposerAgentControl = () => (
    <div ref={agentComposerMenuRef} className={styles.agentComposerWrap}>
      <button
        type="button"
        className={styles.agentComposerButton}
        data-active={conversationAgentActive ? 'true' : undefined}
        data-enabled={conversationAgentEnabled ? 'true' : undefined}
        onClick={handleOpenComposerAgentMenu}
        disabled={!activeContact || conversationAgentBusy}
        aria-label={conversationAgentActive ? 'Abrir acciones del chatbot' : 'Asignar chatbot'}
        aria-expanded={agentComposerMenuOpen}
        title={conversationAgentActive ? 'Chatbot activo' : 'Asignar chatbot'}
      >
        {conversationAgentBusy ? <Loader2 size={17} className={styles.spin} /> : (
          <>
            <AgentRobot size={30} active={conversationAgentActive} />
            {conversationAgentPaused ? (
              <span className={styles.agentComposerPauseMarker} aria-hidden="true">
                <Pause size={9} />
              </span>
            ) : null}
          </>
        )}
      </button>
      {renderComposerAgentMenu()}
    </div>
  )

  const renderChannelBadgeIcon = (kind: ContactChannelBadgeKind, size: 'sm' | 'md') => {
    return (
      <PhoneMessageChannelIcon
        channel={kind}
        variant="asset"
        size={size === 'sm' ? 16 : 18}
        className={styles.avatarChannelBadgeAssetIcon}
      />
    )
  }

  const renderAvatar = (
    contact: DesktopChatContact | Contact | null,
    size: 'sm' | 'md' = 'md',
    options: { showChannelBadge?: boolean; agentBadgeState?: AgentAvatarBadgeState | null; agentBadgeLabel?: string } = {}
  ) => {
    const photo = getContactProfilePhoto(contact)
    const initials = getContactInitials(contact)
    const channelBadge = options.showChannelBadge ? getContactChannelBadge(contact) : null
    return (
      <ContactAvatar
        contact={contact}
        className={`${styles.avatar} ${size === 'sm' ? styles.avatarSm : ''}`}
        avatarUrl={photo}
        initials={initials}
        alt={`Foto de ${getContactName(contact)}`}
      >
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
        {options.agentBadgeState ? (
          <span
            className={styles.avatarAgentBadge}
            data-agent-badge-state={options.agentBadgeState}
            title={options.agentBadgeLabel || 'Chat asignado al agente'}
            aria-label={options.agentBadgeLabel || 'Chat asignado al agente'}
          >
            {options.agentBadgeState === 'attention' ? <CircleAlert size={10} /> : <Bot size={10} />}
            {options.agentBadgeState === 'paused' ? (
              <span className={styles.avatarAgentPauseMarker} aria-hidden="true">
                <Pause size={7} />
              </span>
            ) : null}
          </span>
        ) : null}
      </ContactAvatar>
    )
  }

  const renderChatSelectionControl = (contact: DesktopChatContact) => {
    const selected = selectedChatIdSet.has(contact.id)
    return (
      <label
        className={styles.chatSelectControl}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        title={`Seleccionar ${getContactName(contact)}`}
      >
        <input
          type="checkbox"
          checked={selected}
          onChange={() => handleToggleChatSelection(contact.id)}
          aria-label={`Seleccionar chat de ${getContactName(contact)}`}
        />
      </label>
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

  const canReactToMessage = (message: DesktopChatMessage) => Boolean(getMessageReactionChannel(message))

  const renderMessageReactions = (message: DesktopChatMessage) => {
    if (!message.reactions?.length) return null
    const reactions = message.reactions.slice(-3)
    return (
      <span className={styles.messageReactions} aria-label="Reacciones">
        {reactions.map((reaction) => (
          <span key={reaction.id} className={styles.messageReaction}>
            {reaction.emoji}
          </span>
        ))}
      </span>
    )
  }

  const handleMessageReactionContextMenu = (message: DesktopChatMessage, event: React.MouseEvent<HTMLElement>) => {
    if (!canReactToMessage(message) || typeof window === 'undefined') return
    event.preventDefault()
    event.stopPropagation()

    const margin = 8
    const menuWidth = 230
    const menuHeight = 42
    const maxX = Math.max(margin, window.innerWidth - menuWidth - margin)
    const maxY = Math.max(margin, window.innerHeight - menuHeight - margin)
    setMessageReactionMenu({
      messageId: message.id,
      x: Math.min(Math.max(event.clientX, margin), maxX),
      y: Math.min(Math.max(event.clientY, margin), maxY)
    })
  }

  const openMessageReactionEmojiPicker = () => {
    if (typeof window === 'undefined') return
    const margin = 8
    const menuWidth = 312
    setMessageReactionMenu((current) => {
      if (!current) return current
      const maxX = Math.max(margin, window.innerWidth - menuWidth - margin)
      return {
        ...current,
        x: Math.min(current.x, maxX),
        pickerOpen: true
      }
    })
  }

  const renderMessageReactionContextMenu = () => {
    if (!messageReactionMenu) return null

    const message = messages.find((item) => item.id === messageReactionMenu.messageId)
    const reactionChannel = message ? getMessageReactionChannel(message) : null
    if (!message || !reactionChannel) return null

    const emojis = getMessageReactionEmojis(reactionChannel)
    const pickerEmojis = getMessageReactionPickerEmojis(reactionChannel)
    const showEmojiPickerButton = pickerEmojis.length > emojis.length
    const reacting = reactingMessageId === message.id

    return (
      <div
        data-message-reaction-context-menu="true"
        className={styles.messageReactionContextMenu}
        style={{
          '--message-reaction-menu-x': `${messageReactionMenu.x}px`,
          '--message-reaction-menu-y': `${messageReactionMenu.y}px`
        } as React.CSSProperties}
        role="menu"
        aria-label="Reaccionar al mensaje"
        aria-busy={reacting}
      >
        <div className={styles.messageReactionQuickList}>
          {emojis.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={styles.messageReactionButton}
              onClick={() => {
                setMessageReactionMenu(null)
                void handleReactToMessage(message, emoji)
              }}
              disabled={reacting}
              role="menuitem"
              aria-label={`Reaccionar con ${emoji}`}
            >
              {emoji}
            </button>
          ))}
          {showEmojiPickerButton ? (
            <button
              type="button"
              className={`${styles.messageReactionButton} ${styles.messageReactionMoreButton}`}
              onClick={openMessageReactionEmojiPicker}
              disabled={reacting}
              role="menuitem"
              aria-label="Mostrar más emojis"
              aria-expanded={Boolean(messageReactionMenu.pickerOpen)}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {messageReactionMenu.pickerOpen ? (
          <div className={styles.messageReactionEmojiGrid} role="group" aria-label="Más emojis">
            {pickerEmojis.map((emoji, index) => (
              <button
                key={`${emoji}-${index}`}
                type="button"
                className={styles.messageReactionEmojiButton}
                onClick={() => {
                  setMessageReactionMenu(null)
                  void handleReactToMessage(message, emoji)
                }}
                disabled={reacting}
                role="menuitem"
                aria-label={`Reaccionar con ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

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

  const renderLocationMessage = (message: DesktopChatMessage) => {
    const location = message.location
    if (!location) return null

    const href = location.url || buildLocationUrl(location)
    const title = getLocationTitle(location)
    const tiles = getLocationMapTiles(location)

    return (
      <a
        className={styles.messageLocation}
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={`Abrir ${title} en Maps`}
      >
        <span className={styles.messageLocationMap}>
          <span className={styles.messageLocationTileLayer} aria-hidden="true">
            {tiles.map((tile) => (
              <img
                key={tile.key}
                className={styles.messageLocationTile}
                src={tile.url}
                alt=""
                loading="lazy"
                decoding="async"
                style={{
                  left: `calc(50% + ${tile.left}px)`,
                  top: `calc(50% + ${tile.top}px)`
                }}
              />
            ))}
          </span>
          <span className={styles.messageLocationMapOverlay} aria-hidden="true" />
          <span className={styles.messageLocationPin}>
            <MapPin size={26} fill="currentColor" />
          </span>
          <span className={styles.messageLocationAttribution}>© OpenStreetMap contributors</span>
          <span className={styles.messageLocationAction}>
            Abrir
            <ExternalLink size={12} />
          </span>
        </span>
      </a>
    )
  }

  const renderAdPreview = (message: DesktopChatMessage) => {
    const preview = message.adPreview
    if (!preview) return null

    const href = getMessageAdPreviewActionUrl(preview)
    const campaignLine = [
      preview.campaignName ? `Campaña ${formatUrlParameter(preview.campaignName)}` : '',
      preview.adName ? formatUrlParameter(preview.adName) : '',
      !preview.adName && preview.sourceId ? `ID ${preview.sourceId}` : ''
    ].filter(Boolean).join(' · ')
    const sourceLine = [
      preview.sourceType ? formatUrlParameter(preview.sourceType) : '',
      preview.sourceId && preview.adName ? `ID ${preview.sourceId}` : ''
    ].filter(Boolean).join(' · ')
    const content = (
      <>
        {preview.imageUrl ? (
          <img
            className={styles.messageAdPreviewMedia}
            src={preview.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
          />
        ) : (
          <span className={styles.messageAdPreviewMediaPlaceholder} aria-hidden="true">
            {preview.videoUrl ? <Video size={24} /> : <Icon name="meta-ads" size={24} />}
          </span>
        )}
        <span className={styles.messageAdPreviewContent}>
          <span className={styles.messageAdPreviewLabel}>
            <Icon name="meta-ads" size={12} />
            Anuncio {preview.platform || 'Meta Ads'}
          </span>
          <strong className={styles.messageAdPreviewTitle}>{formatUrlParameter(preview.title)}</strong>
          {preview.body ? <span className={styles.messageAdPreviewBody}>{formatUrlParameter(preview.body)}</span> : null}
          {campaignLine ? <span className={styles.messageAdPreviewMeta}>{campaignLine}</span> : null}
          {sourceLine ? <span className={styles.messageAdPreviewSource}>{sourceLine}</span> : null}
          {href ? (
            <span className={styles.messageAdPreviewAction}>
              Ver anuncio
              <ExternalLink size={12} />
            </span>
          ) : null}
        </span>
      </>
    )

    if (href) {
      return (
        <a className={styles.messageAdPreview} href={href} target="_blank" rel="noreferrer">
          {content}
        </a>
      )
    }

    return <div className={styles.messageAdPreview}>{content}</div>
  }

  const getMessageBubbleMediaClass = (message: DesktopChatMessage) => {
    if (message.location) return styles.messageLocationBubble
    const attachmentType = message.attachment?.type
    if (attachmentType === 'image' || attachmentType === 'video') return styles.messageMediaBubble
    if (attachmentType === 'audio') return styles.messageAudioBubble
    return ''
  }

  const renderAttachment = (message: DesktopChatMessage) => {
    if (!message.attachment) return null
    const { attachment } = message
    const attachmentSrc = getAttachmentSource(attachment)
    const attachmentCaption = String(message.text || '').trim()
    const openAttachmentFocus = () => {
      if (!attachmentSrc) return
      setContentFocusItem({
        url: attachmentSrc,
        title: attachment.name || getMessageTypeLabel(attachment.type, 'Archivo'),
        caption: attachmentCaption,
        kind: attachment.type === 'image'
          ? 'image'
          : attachment.type === 'video'
            ? 'video'
            : attachment.type === 'document'
              ? 'document'
              : 'file',
        mimeType: attachment.mimeType,
        isGif: attachment.isGif
      })
    }

    if (attachment.type === 'audio') {
      const progress = messageAudioProgress[message.id]
      const durationSeconds = progress?.duration || (attachment.durationMs ? attachment.durationMs / 1000 : 0)
      const currentSeconds = progress?.currentTime || 0
      const progressPercent = durationSeconds > 0 ? Math.max(0, Math.min(100, (currentSeconds / durationSeconds) * 100)) : 0
      const isPlaying = playingAudioId === message.id
      const audioTitle = attachment.name && attachment.name !== 'Mensaje de voz' ? attachment.name : 'Mensaje de voz'
      const routePhone = message.direction === 'outbound'
        ? getMessageBusinessPhone(message, whatsappStatus) || selectedBusinessPhone
        : null
      const audioAvatarUrl = message.direction === 'outbound'
        ? String(routePhone?.profile_picture_url || '').trim()
        : getContactProfilePhoto(activeContact)
      const audioAvatarName = message.direction === 'outbound'
        ? getBusinessPhoneLabel(routePhone)
        : getContactName(activeContact)
      const audioAvatarInitials = audioAvatarName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'R'

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
          <span className={styles.audioAvatar} aria-label={`Foto de ${audioAvatarName}`}>
            <span className={styles.audioAvatarFallback}>{audioAvatarInitials}</span>
            {audioAvatarUrl ? (
              <img
                src={audioAvatarUrl}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                onError={(event) => { event.currentTarget.hidden = true }}
              />
            ) : null}
            <span className={styles.audioAvatarMicBadge} aria-hidden="true"><Mic size={11} /></span>
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
        <button
          type="button"
          className={`${styles.mediaAttachment} ${styles.mediaAttachmentImage}`}
          onClick={openAttachmentFocus}
          aria-label={attachment.name || (attachment.isGif ? 'Abrir GIF' : 'Abrir foto')}
        >
          <span className={styles.mediaAttachmentPlaceholder} aria-hidden="true"><ImageIcon size={28} /></span>
          <img
            src={attachmentSrc}
            alt={attachment.name || (attachment.isGif ? 'GIF enviado' : 'Foto enviada')}
            loading="lazy"
            decoding="async"
            width={360}
            height={270}
            onError={(event) => { event.currentTarget.hidden = true }}
          />
        </button>
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
        <div className={`${styles.mediaAttachment} ${styles.mediaAttachmentVideo}`}>
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
          <button
            type="button"
            className={styles.mediaAttachmentFocusButton}
            onClick={openAttachmentFocus}
            aria-label={isGifVideo ? (attachment.name || 'Abrir GIF') : (attachment.name || 'Abrir video')}
          >
            <ExternalLink size={13} />
            Ver en grande
          </button>
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
      <button type="button" className={styles.fileAttachment} onClick={openAttachmentFocus} aria-label={`Abrir ${fileMeta.name}`}>
        {fileContent}
      </button>
    ) : (
      <span className={`${styles.fileAttachment} ${styles.attachmentUnavailable}`}>
        {fileContent}
      </span>
    )
  }

  const renderMessageMeta = (message: DesktopChatMessage, transportLabel = '') => {
    const status = String(message.status || '').trim().toLowerCase()
    const failed = FAILED_MESSAGE_STATUSES.has(status) || Boolean(message.errorReason)
    const scheduled = isMessageScheduled(message)
    const sending = message.direction === 'outbound' && isChatMessageSendInFlight(status) && !scheduled && !failed
    return (
      <span className={styles.messageMeta}>
        {transportLabel ? <em className={styles.messageTransport}>{transportLabel}</em> : null}
        {formatMessageTime(message.date)}
        {message.direction === 'outbound' && !failed && !scheduled && !sending ? <CheckCheck size={13} /> : null}
        {scheduled ? <Clock size={13} /> : null}
        {sending ? <Loader2 size={13} className={styles.spin} aria-label="Enviando" /> : null}
      </span>
    )
  }

  const renderAgentSideMarker = (message: DesktopChatMessage) => {
    if (!message.sentByAgent || message.direction === 'system') return null
    return (
      <span className={styles.messageAgentSideMarker} title="Respondido por agente conversacional" aria-label="Respondido por agente conversacional">
        <Bot size={15} strokeWidth={2.45} aria-hidden="true" />
      </span>
    )
  }

  const renderMessageErrorBadge = (message: DesktopChatMessage) => {
    const failed = FAILED_MESSAGE_STATUSES.has(String(message.status || '').trim().toLowerCase()) || Boolean(message.errorReason)
    if (!failed) return null
    const errorText = String(message.errorReason || '').trim() || 'No se pudo enviar este mensaje.'
    return (
      <button
        type="button"
        className={styles.messageErrorBadge}
        aria-label={`Error del mensaje: ${errorText}`}
        data-tooltip={errorText}
        data-tooltip-side={message.direction === 'outbound' ? 'left' : 'right'}
      >
        <CircleAlert size={14} />
      </button>
    )
  }

  const renderAgentCompletionCard = (completion: ConversationalAgentCompletionEvent) => (
    <article className={styles.agentCompletionCard} aria-label={`Resumen del agente: ${completion.title}`}>
      <span className={styles.agentCompletionIcon} aria-hidden="true">
        <AgentRobot size={36} active label="Chatbot" className={styles.agentCompletionRobot} />
      </span>
      <div className={styles.agentCompletionBody}>
        <span className={styles.agentCompletionHeader}>
          <span className={styles.agentCompletionTitle}>
            <span className={styles.agentCompletionSignalIcon} aria-hidden="true">{completion.icon}</span>
            <strong>{completion.title}</strong>
          </span>
          <small>{formatLocalDateTime(completion.createdAt)}</small>
        </span>
        <p className={styles.agentCompletionAction}>{completion.actionSummary}</p>
        {completion.summary && completion.summary !== completion.actionSummary ? (
          <p className={styles.agentCompletionSummary}><strong>Resumen:</strong> {completion.summary}</p>
        ) : null}
      </div>
    </article>
  )

  const renderActivityMarker = (marker: ChatActivityMarker) => {
    const ActivityIcon = marker.kind === 'payment' ? Banknote : CalendarDays
    const markerTime = formatChatMessageTime(marker.date, timezone)
    return (
      <div
        className={styles.activityMarkerRow}
        aria-label={`${marker.title}${marker.amountLabel ? ` · ${marker.amountLabel}` : ''}`}
      >
        <span className={styles.activityMarkerLine} aria-hidden="true" />
        <div className={styles.activityMarkerPill}>
          <span className={styles.activityMarkerIcon} aria-hidden="true">
            <ActivityIcon size={14} strokeWidth={2.4} />
          </span>
          <span className={styles.activityMarkerCopy}>
            <strong>{marker.title}{marker.amountLabel ? ` · ${marker.amountLabel}` : ''}</strong>
            <small>{[marker.subtitle, markerTime].filter(Boolean).join(' · ')}</small>
          </span>
        </div>
        <span className={styles.activityMarkerLine} aria-hidden="true" />
      </div>
    )
  }

  const schedulePreviewDate = getScheduleDateFromDraft(scheduleDraft, timezone)
  const canSubmitSchedule = Boolean(schedulePreviewDate && composerText.trim() && !schedulingMessage)

  return (
    <div
      className={`${styles.page} ${agentAssignedViewOpen ? styles.pageAgentInbox : ''}`}
      data-ristak-page
      data-fullbleed="true"
      data-desktop-chat-agent-view={agentAssignedViewOpen ? 'true' : undefined}
    >
      <section className={styles.chatShell} data-desktop-chat-page>
        <aside
          className={`${styles.inboxPanel} ${agentAssignedViewOpen ? styles.inboxPanelAgent : ''} ${advancedFiltersOpen ? styles.inboxPanelFiltersOpen : ''}`}
          aria-label={agentAssignedViewOpen ? 'Lista de chats del bot' : 'Lista de chats'}
        >
          <div className={`${styles.inboxHeader} ${agentAssignedViewOpen ? styles.inboxHeaderAgent : ''}`}>
            <div className={styles.inboxHeaderCopy}>
              <span className={styles.inboxTitleLine}>
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
              aria-label={agentAssignedViewOpen ? 'Cerrar actividad del agente' : 'Ver actividad del agente'}
              aria-pressed={agentAssignedViewOpen}
              title={agentAssignedViewOpen ? 'Cerrar actividad del agente' : 'Actividad del agente'}
            >
              <AgentRobot size={42} active={conversationAgentEnabled} label="Chatbot" />
            </Button>
          </div>

          <div className={styles.chatSearchBar}>
            <SearchField
              className={styles.chatSearchField}
              value={chatQuery}
              placeholder="Buscar chat, contacto, teléfono o correo"
              onChange={(nextQuery) => setChatQuery(nextQuery)}
              onClear={() => setChatQuery('')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSearchContacts()
              }}
            />
          </div>

          <div className={`${styles.chatFilterStack} ${advancedFiltersOpen ? styles.chatFilterStackOpen : ''}`}>
            <div className={styles.filterRow} role="tablist" aria-label="Filtros de chat">
              {!commentsView ? (
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
              {commentsView ? (
                <>
                  <button
                    type="button"
                    className={`${styles.filterCommentsChip} ${styles.filterCommentsChipActive}`}
                    onClick={() => setCommentsView(false)}
                    aria-pressed
                  >
                    Comentarios
                  </button>
                  <span className={styles.filterSeparator} aria-hidden="true" />
                  <button
                    type="button"
                    className={`${styles.filterCommentsPlatform} ${commentsPlatform === 'all' ? styles.filterActive : ''}`}
                    onClick={() => setCommentsPlatform('all')}
                  >
                    Todas
                  </button>
                  {facebookCommentsEnabled === true ? (
                    <button
                      type="button"
                      className={`${styles.filterCommentsPlatform} ${commentsPlatform === 'facebook' ? styles.filterActive : ''}`}
                      onClick={() => setCommentsPlatform('facebook')}
                    >
                      Facebook
                    </button>
                  ) : null}
                  {instagramCommentsEnabled === true ? (
                    <button
                      type="button"
                      className={`${styles.filterCommentsPlatform} ${commentsPlatform === 'instagram' ? styles.filterActive : ''}`}
                      onClick={() => setCommentsPlatform('instagram')}
                    >
                      Instagram
                    </button>
                  ) : null}
                </>
              ) : agentAssignedViewOpen ? (
                AGENT_INBOX_STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    className={filter.id === agentInboxStatusFilter ? styles.filterActive : ''}
                    onClick={() => setAgentInboxStatusFilter(filter.id)}
                  >
                    <span>{filter.label}</span>
                    <small>{agentInboxStatusCounts[filter.id]}</small>
                  </button>
                ))
              ) : (
                <>
                  {chatFilters.map((filter) => (
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
                  {commentsFeatureEnabled ? (
                    <>
                      <span className={styles.filterSeparator} aria-hidden="true" />
                      <button
                        type="button"
                        className={styles.filterCommentsChip}
                        onClick={() => {
                          setArchivedViewOpen(false)
                          setCommentsPlatform('all')
                          setCommentsView(true)
                        }}
                      >
                        Comentarios
                      </button>
                    </>
                  ) : null}
                </>
              )}
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
          </div>

          <div
            className={styles.chatList}
            data-chat-list
            ref={chatListRef}
            onScroll={loadMoreChatsIfNeeded}
          >
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
                {hasActiveChatFilters ? (
                  <button type="button" onClick={agentAssignedViewOpen && hasAgentInboxListFilters ? resetAgentInboxFilters : resetChatFilters}>
                    {resetChatFiltersLabel}
                  </button>
                ) : null}
              </div>
            ) : (
              <>
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
                <div className={styles.chatSelectionBar} data-chat-selection-active={selectedVisibleChatCount > 0 ? 'true' : undefined}>
                  <div className={styles.chatSelectionSummary}>
                    <label className={styles.chatSelectAll}>
                      <input
                        ref={selectAllChatCheckboxRef}
                        type="checkbox"
                        checked={allVisibleChatsSelected}
                        disabled={selectableChatRows.length === 0}
                        onChange={handleToggleVisibleChatSelection}
                        aria-label={chatSelectionToggleAriaLabel}
                      />
                      <span>{chatSelectionToggleLabel}</span>
                    </label>
                    <span className={styles.chatSelectionCount}>
                      {selectedVisibleChatCount > 0
                        ? `${selectedVisibleChatCount} seleccionado${selectedVisibleChatCount === 1 ? '' : 's'}`
                        : `${selectableChatRows.length} visible${selectableChatRows.length === 1 ? '' : 's'}`}
                    </span>
                  </div>
                  {selectedVisibleChatCount > 0 ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          className={styles.chatSelectionMenuButton}
                          aria-label="Abrir acciones para chats seleccionados"
                        >
                          {bulkAgentActionBusy ? <Loader2 size={14} className={styles.spin} /> : <ListFilter size={14} />}
                          Acciones
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" sideOffset={8} className={styles.chatSelectionMenu}>
                        <div className={styles.chatSelectionMenuHeader}>
                          <strong>{selectedVisibleChatCount} seleccionado{selectedVisibleChatCount === 1 ? '' : 's'}</strong>
                          <span>{bulkSelectionMenuDescription}</span>
                        </div>
                        <DropdownMenuItem className={styles.chatSelectionMenuItem} onSelect={() => handleMarkSelectedChatsAsRead()}>
                          <CheckCheck size={15} />
                          <span>
                            <span className={styles.chatSelectionMenuItemTitle}>Marcar como leídos</span>
                            <small>Quita pendientes de los seleccionados.</small>
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem className={styles.chatSelectionMenuItem} onSelect={() => handleOpenBulkArchiveConfirm()}>
                          <Archive size={15} />
                          <span>
                            <span className={styles.chatSelectionMenuItemTitle}>{bulkArchiveActionLabel}</span>
                            <small>{archivedViewOpen ? 'Devuelve estos chats a conversaciones.' : 'Mueve estos chats fuera de la bandeja principal.'}</small>
                          </span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className={`${styles.chatSelectionMenuItem} ${styles.chatActionMenuItemDanger}`}
                          onSelect={() => handleOpenBulkRemoveConfirm()}
                        >
                          <Trash2 size={15} />
                          <span>
                            <span className={styles.chatSelectionMenuItemTitle}>Eliminar de la vista</span>
                            <small>Oculta los chats sin borrar historial.</small>
                          </span>
                        </DropdownMenuItem>
                        {showBulkAgentAssignmentActions ? (
                          <>
                            <DropdownMenuSeparator />
                            <div className={styles.chatSelectionMenuHeader}>
                              <strong>Mandar a inteligencia artificial</strong>
                              <span>Elige el agente que atenderá todos los chats seleccionados.</span>
                            </div>
                            {!conversationAgentEnabled ? (
                              <DropdownMenuItem className={styles.chatSelectionMenuItem} disabled>
                                <Bot size={15} />
                                <span>
                                  <span className={styles.chatSelectionMenuItemTitle}>Chatbot apagado</span>
                                  <small>Actívalo en Chatbot para usarlo aquí.</small>
                                </span>
                              </DropdownMenuItem>
                            ) : availableAgentDefs.length > 0 ? (
                              availableAgentDefs.map((agent) => (
                                <DropdownMenuItem
                                  key={agent.id}
                                  className={styles.chatSelectionMenuItem}
                                  disabled={Boolean(bulkAgentActionBusy)}
                                  onSelect={() => handleAssignSelectedChatsToConversationAgent(agent.id)}
                                >
                                  <Bot size={15} />
                                  <span>
                                    <span className={styles.chatSelectionMenuItemTitle}>{agent.name || 'Agente sin nombre'}</span>
                                    <small>{getConversationAgentObjectiveLabel(agent.objective)}</small>
                                  </span>
                                </DropdownMenuItem>
                              ))
                            ) : (
                              <DropdownMenuItem className={styles.chatSelectionMenuItem} disabled>
                                <Bot size={15} />
                                <span>
                                  <span className={styles.chatSelectionMenuItemTitle}>Sin agentes activos</span>
                                  <small>Crea o activa un agente en Chatbot.</small>
                                </span>
                              </DropdownMenuItem>
                            )}
                          </>
                        ) : null}
                        {agentAssignedViewOpen ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className={styles.chatSelectionMenuItem}
                              disabled={Boolean(bulkAgentActionBusy)}
                              onSelect={() => {
                                void handleRunBulkConversationAgentAction(
                                  'pause',
                                  'Chats pausados por 24hrs',
                                  (count) => `${count} chat${count === 1 ? '' : 's'} quedó${count === 1 ? '' : 'aron'} pausado${count === 1 ? '' : 's'} por 24hrs.`
                                )
                              }}
                            >
                              <Pause size={15} />
                              <span>
                                <span className={styles.chatSelectionMenuItemTitle}>Pausar por 24hrs</span>
                                <small>Detiene respuestas automáticas durante 24 horas.</small>
                              </span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className={styles.chatSelectionMenuItem}
                              disabled={Boolean(bulkAgentActionBusy)}
                              onSelect={() => {
                                void handleRunBulkConversationAgentAction(
                                  'take_over',
                                  'Chats fuera del bot',
                                  (count) => `Tomaste ${count} conversación${count === 1 ? '' : 'es'} y el bot deja de responder ahí.`
                                )
                              }}
                            >
                              <User size={15} />
                              <span>
                                <span className={styles.chatSelectionMenuItemTitle}>Sacar del bot</span>
                                <small>Pasa estos chats a atención humana.</small>
                              </span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              className={styles.chatSelectionMenuItem}
                              disabled={Boolean(bulkAgentActionBusy)}
                              onSelect={() => {
                                void handleRunBulkConversationAgentAction(
                                  'skip',
                                  'Chats omitidos',
                                  (count) => `El bot ya no volverá a tomar ${count} chat${count === 1 ? '' : 's'} seleccionado${count === 1 ? '' : 's'}.`
                                )
                              }}
                            >
                              <X size={15} />
                              <span>
                                <span className={styles.chatSelectionMenuItemTitle}>Omitir bot</span>
                                <small>Bloquea que el bot los retome después.</small>
                              </span>
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
                {!archivedViewOpen && agentPriorityChatRows.map((contact) => {
                  const active = contact.id === activeContactId
                  const unread = Number(contact.unreadCount || 0)
                  const agentState = agentStates[contact.id]
                  const assignmentStatus = getConversationAgentAssignmentStatus(agentState)
                  return (
                    <div
                      key={`agent-${contact.id}`}
                      role="button"
                      tabIndex={0}
                      data-chat-row="agent-priority"
                      className={`${styles.chatRow} ${styles.chatRowAgentAction} ${unread > 0 ? styles.chatRowUnread : ''} ${active ? styles.chatRowActive : ''} ${selectedChatIdSet.has(contact.id) ? styles.chatRowSelected : ''}`}
                      onClick={() => handleSelectChat(contact)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          handleSelectChat(contact)
                        }
                      }}
                    >
                      {renderChatSelectionControl(contact)}
                      {renderAvatar(contact, 'sm', {
                        showChannelBadge: true,
                        agentBadgeState: assignmentStatus || 'attention',
                        agentBadgeLabel: assignmentStatus === 'paused'
                          ? 'Agente asignado y pausado'
                          : assignmentStatus === 'active'
                            ? 'Agente asignado y necesita atención'
                            : 'Necesita atención humana'
                      })}
                      <span className={styles.chatRowBody}>
                        <span className={styles.chatRowTop}>
                          <strong>{getContactName(contact)}</strong>
                          <small>{contact.lastMessageDate ? formatChatListTimestamp(contact.lastMessageDate, timezone) : ''}</small>
                        </span>
                        <span className={styles.chatPreviewLine}>
                          <span className={styles.agentPriorityText}>
                            {[AGENT_SIGNAL_LABELS[agentState?.signal || ''] || 'Prioridad del agente', agentState?.signalReason || agentState?.signalSummary].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                      </span>
                      <span className={styles.chatRowAside}>
                        {unread > 0 ? <span className={styles.unread} aria-label={`${unread} mensajes no leídos`}>{unread > 99 ? '99+' : unread}</span> : null}
                        {renderChatActionsMenu(contact)}
                      </span>
                    </div>
                  )
                })}
                {filteredChats.map((contact) => {
                  const active = contact.id === activeContactId
                  const unread = Number(contact.unreadCount || 0)
                  const agentState = agentStates[contact.id]
                  const isAgentHistoryChat = hasAgentInboxHistory(agentState)
                  const isAgentActionChat = Boolean(agentState?.signal && agentState?.signal !== 'discarded')
                  const assignmentStatus = getConversationAgentAssignmentStatus(agentState)
                  const agentBadgeState: AgentAvatarBadgeState | null = assignmentStatus || (isAgentActionChat ? 'attention' : null)
                  const agentStatusLabel = agentAssignedViewOpen
                    ? isAgentHistoryChat
                      ? getAgentInboxStatusLabel(agentState)
                      : agentInboxStatusFilter === 'unassigned'
                        ? 'No asignado'
                        : ''
                    : ''
                  const agentBadgeLabel = assignmentStatus === 'paused'
                    ? 'Agente asignado y pausado'
                    : assignmentStatus === 'active'
                      ? isAgentActionChat ? 'Agente asignado y necesita atención' : 'Agente asignado y activo'
                      : 'Necesita atención humana'
                  return (
                    <div
                      key={contact.id}
                      role="button"
                      tabIndex={0}
                      data-chat-row={agentAssignedViewOpen ? 'agent-assigned' : unread > 0 ? 'unread' : 'chat'}
                      className={`${styles.chatRow} ${agentAssignedViewOpen ? styles.chatRowAgentAssigned : ''} ${unread > 0 ? styles.chatRowUnread : ''} ${active ? styles.chatRowActive : ''} ${selectedChatIdSet.has(contact.id) ? styles.chatRowSelected : ''}`}
                      onClick={() => handleSelectChat(contact)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          handleSelectChat(contact)
                        }
                      }}
                    >
                      {renderChatSelectionControl(contact)}
                      {renderAvatar(contact, 'sm', { showChannelBadge: true, agentBadgeState, agentBadgeLabel })}
                      <span className={styles.chatRowBody}>
                        <span className={styles.chatRowTop}>
                          <strong>{getContactName(contact)}</strong>
                          <small>{contact.lastMessageDate ? formatChatListTimestamp(contact.lastMessageDate, timezone) : ''}</small>
                        </span>
                        <span className={styles.chatPreviewLine}>
                          {agentStatusLabel ? <span className={styles.agentInboxStatusText}>{agentStatusLabel}</span> : null}
                          <span className={styles.chatPreview}>{getChatPreview(contact)}</span>
                        </span>
                      </span>
                      <span className={styles.chatRowAside}>
                        {unread > 0 ? <span className={styles.unread} aria-label={`${unread} mensajes no leídos`}>{unread > 99 ? '99+' : unread}</span> : null}
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
                    {hasActiveChatFilters ? (
                      <button type="button" onClick={agentAssignedViewOpen && hasAgentInboxListFilters ? resetAgentInboxFilters : resetChatFilters}>
                        {resetChatFiltersLabel}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {isLoadingMoreChats ? (
                  <div className={styles.chatListLoadingMore} role="status" aria-live="polite">
                    <Loader2 size={16} className={styles.spin} aria-hidden="true" />
                    <span>Cargando más chats…</span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </aside>

        <main
          className={styles.conversationPanel}
          aria-label="Conversación"
          onDragEnter={handleChatDragEnter}
          onDragOver={handleChatDragOver}
          onDragLeave={handleChatDragLeave}
          onDrop={handleChatDrop}
        >
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

              <div className={styles.messagePaneFrame}>
                <ChatMessageSurface
                  ref={messagePaneRef}
                  className={`${styles.messagePane} ${draggingFilesOverChat ? styles.messagePaneDropActive : ''}`}
                  onScroll={updateMessagePaneBottomLock}
                >
                  {olderMessagesLoading ? (
                    <div className={styles.cacheRefreshPill} role="status" aria-live="polite">
                      <Loader2 size={13} className={styles.spin} aria-hidden="true" />
                      Cargando mensajes anteriores
                    </div>
                  ) : null}
                  {messagesRefreshing && !messagesLoading ? (
                    <div className={styles.cacheRefreshPill} role="status" aria-live="polite">
                      <Loader2 size={13} className={styles.spin} aria-hidden="true" />
                      Actualizando conversación
                    </div>
                  ) : null}
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
                  ) : conversationTimelineGroups.length === 0 ? (
                    <div className={styles.emptyConversation}>
                      <MessageCircle size={22} />
                      <strong>{commentsView ? 'Sin comentarios' : 'Sin mensajes todavía'}</strong>
                      <span>{commentsView ? 'Este contacto no tiene comentarios registrados.' : 'Escribe abajo para empezar la conversación.'}</span>
                    </div>
                  ) : conversationTimelineGroups.map((group) => (
                    <div key={group.key} className={styles.messageGroup}>
                      <div className={styles.dayDivider}>{group.label}</div>
                      {group.items.map((item) => {
                        if (item.type === 'activity') {
                          return (
                            <div key={item.id} className={styles.activityMarkerRowWrap}>
                              {renderActivityMarker(item.marker)}
                            </div>
                          )
                        }
                        if (item.type === 'agentCompletion') {
                          return (
                            <div key={item.id} className={styles.agentCompletionRow}>
                              {renderAgentCompletionCard(item.completion)}
                            </div>
                          )
                        }
                        const message = item.message
                        const routingDetails = getMessageRoutingDetails(message, whatsappStatus)
                        const messageChannel = resolveChatMessageChannel({
                          channel: message.channel,
                          transport: message.transport,
                          provider: message.provider,
                          commentPlatform: message.commentPlatform,
                          messageType: message.messageType,
                          hasEmail: Boolean(message.email)
                        })
                        const directionClass = message.direction === 'outbound'
                          ? styles.messageOutbound
                          : message.direction === 'system'
                            ? styles.messageSystem
                            : styles.messageInbound
                        const bubbleMediaClass = getMessageBubbleMediaClass(message)
                        return (
                          <div
                            key={item.id}
                            className={`${styles.messageRow} ${message.direction === 'outbound' ? styles.messageRowOutbound : message.direction === 'system' ? styles.messageRowSystem : styles.messageRowInbound}`}
                          >
                            <div className={styles.messageStack}>
                              <div className={styles.messageBubbleWrap}>
                                {message.direction === 'outbound' ? renderMessageErrorBadge(message) : null}
                                {message.direction !== 'outbound' ? renderAgentSideMarker(message) : null}
                                <article
                                  className={`${styles.messageBubble} ${directionClass} ${isMessageScheduled(message) ? styles.messageScheduled : ''} ${message.isComment ? styles.messageComment : ''} ${message.email ? styles.messageEmail : ''} ${bubbleMediaClass}`}
                                  data-chat-channel={getChatBubbleColorChannel(messageChannel, message.direction)}
                                  onContextMenu={(event) => handleMessageReactionContextMenu(message, event)}
                                >
                                  {message.isComment ? (
                                    <div className={styles.commentCard}>
                                      <span className={styles.commentContextLabel}>
                                        <MessageCircle size={13} aria-hidden="true" />
                                        {message.commentReplyMode === 'public'
                                          ? 'Respuesta pública al comentario'
                                          : message.commentReplyMode === 'private'
                                            ? 'Respuesta por privado'
                                            : 'Comentó en tu publicación'}
                                      </span>
                                      {message.commentPost ? (
                                        (() => {
                                          const visiblePostMessage = message.commentPost.message && !(message.commentPost.deleted && message.commentPost.message === 'Publicación eliminada')
                                            ? message.commentPost.message
                                            : ''
                                          const postFocusUrl = message.commentPost.imageUrl || message.commentPost.permalink || ''
                                          const openPostFocus = () => {
                                            if (!postFocusUrl) return
                                            setContentFocusItem({
                                              url: postFocusUrl,
                                              title: message.commentPost?.deleted ? 'Publicación eliminada' : 'Publicación',
                                              caption: visiblePostMessage || message.commentPost?.permalink || '',
                                              kind: message.commentPost?.imageUrl ? 'image' : 'link'
                                            })
                                          }
                                          const postInner = (
                                            <>
                                              <span className={styles.commentPostThumbPlaceholder}><ImageIcon size={30} aria-hidden="true" /></span>
                                              {message.commentPost.imageUrl ? (
                                                <img
                                                  src={message.commentPost.imageUrl}
                                                  alt=""
                                                  className={styles.commentPostThumb}
                                                  loading="lazy"
                                                  decoding="async"
                                                  onError={(event) => { event.currentTarget.hidden = true }}
                                                />
                                              ) : null}
                                              <span className={styles.commentPostMeta}>
                                                <span className={styles.commentPostKind}>{message.commentPost.deleted ? 'Publicación eliminada' : 'Publicación'}</span>
                                                {visiblePostMessage ? (
                                                  <span className={styles.commentPostText}>{visiblePostMessage}</span>
                                                ) : (
                                                  <span className={styles.commentPostTextMuted}>{message.commentPost.deleted ? 'Comentario conservado en Ristak' : 'Ver publicación'}</span>
                                                )}
                                              </span>
                                              {message.commentPost.permalink ? (
                                                <ExternalLink size={14} className={styles.commentPostExternal} aria-hidden="true" />
                                              ) : null}
                                            </>
                                          )
                                          return postFocusUrl ? (
                                            <button type="button" className={styles.commentPostChip} onClick={openPostFocus}>
                                              {postInner}
                                            </button>
                                          ) : (
                                            <div className={`${styles.commentPostChip} ${styles.commentPostChipStatic}`}>
                                              {postInner}
                                            </div>
                                          )
                                        })()
                                      ) : null}
                                      {message.text ? <WhatsAppFormattedText text={message.text} className={styles.commentBody} /> : null}
                                      {renderMessageMeta(message, routingDetails.label)}
                                      {message.direction === 'inbound' && !message.commentReplyMode && message.commentId ? (
                                        <button
                                          type="button"
                                          className={styles.commentReplyButton}
                                          onClick={() => setCommentReplyTarget(buildCommentReplyTarget(message))}
                                        >
                                          <MessageCircle size={13} aria-hidden="true" />
                                          Responder en la publicación
                                        </button>
                                      ) : null}
                                    </div>
                                  ) : (
                                    <>
                                      {message.email ? (
                                        <EmailChatMessageBubble email={message.email} />
                                      ) : (
                                        <>
                                          {message.location ? renderLocationMessage(message) : null}
                                          {renderAdPreview(message)}
                                          {renderAttachment(message)}
                                          {message.subject ? <strong className={styles.emailMessageSubject}>{message.subject}</strong> : null}
                                          {message.text ? <WhatsAppFormattedText text={message.text} className={styles.messageText} /> : null}
                                        </>
                                      )}
                                    </>
                                  )}
                                  {message.scheduledAt ? <small className={styles.scheduledText}>Programado para {formatLocalDateTime(message.scheduledAt)}</small> : null}
                                  {renderScheduledMessageActions(message)}
                                </article>
                                {message.direction === 'outbound' ? renderAgentSideMarker(message) : null}
                                {message.direction !== 'outbound' ? renderMessageErrorBadge(message) : null}
                              </div>
                              {renderMessageReactions(message)}
                              {routingDetails.reason ? <small className={styles.messageRoutingNote}>{routingDetails.reason}</small> : null}
                              {!message.isComment ? renderMessageMeta(message, routingDetails.label) : null}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  ))}
                </ChatMessageSurface>
                {renderMessageReactionContextMenu()}
                {draggingFilesOverChat ? (
                  <div className={styles.chatDropOverlay} aria-live="polite">
                    <div className={styles.chatDropOverlayCard}>
                      <Plus size={28} aria-hidden="true" />
                      <strong>Suelta aquí tu contenido multimedia</strong>
                      <span>Se agregará a la caja del mensaje antes de enviarlo.</span>
                    </div>
                  </div>
                ) : null}
              </div>

	              <form
	                className={styles.composer}
	                data-email-mode={isEmailComposer ? 'true' : undefined}
	                data-chat-composer="true"
	                data-enter-submit-ignore
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleSendMessage()
                }}
              >
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*,video/*"
                  className={styles.hiddenFileInput}
                  multiple
                  onChange={(event) => handleImageSelected('photos', event)}
                  tabIndex={-1}
                />
                <input
                  ref={documentInputRef}
                  type="file"
                  accept={DOCUMENT_ATTACHMENT_ACCEPT}
                  className={styles.hiddenFileInput}
                  multiple
                  onChange={handleDocumentSelected}
                  tabIndex={-1}
                />
	                {!isEmailComposer && draftAttachments.length > 0 ? (
	                  <div className={styles.draftAttachmentList}>
	                    {draftAttachments.map((attachment) => (
	                      <div key={attachment.id} className={styles.draftAttachment}>
                        <span className={styles.draftAttachmentIcon}>
                          {attachment.deliveryMode === 'document'
                            ? <FileText size={16} />
                            : attachment.kind === 'image'
                              ? <ImageIcon size={16} />
                              : attachment.kind === 'video'
                                ? <Video size={16} />
                                : attachment.kind === 'audio'
                                  ? <Mic size={16} />
                                  : <FileText size={16} />}
                        </span>
                        <span className={styles.draftAttachmentText}>
                          <strong>{attachment.name}</strong>
                          <small>{getDraftAttachmentLabel(attachment)} · {formatAttachmentSize(attachment.size)}</small>
                        </span>
                        <button type="button" onClick={() => removeDraftAttachment(attachment.id)} aria-label={`Quitar ${attachment.name}`}>
                          <Trash2 size={14} />
                        </button>
                      </div>
	                    ))}
	                  </div>
	                ) : null}
	                {!isEmailComposer ? renderVoiceWave() : null}
	                {!isEmailComposer ? renderVoiceDraft() : null}
	                {composerChannelHint ? (
	                  <span className={styles.composerChannelHint}>{composerChannelHint}</span>
	                ) : null}
	                {!isEmailComposer && selectedCommentReplyTarget ? (
	                  <div className={styles.commentReplyBanner}>
	                    <span className={styles.commentReplyBannerLabel}>
	                      <MessageCircle size={13} aria-hidden="true" />
	                      <span>
	                        Respondiendo <strong>público</strong> {commentReplyTarget ? 'al comentario' : 'al último comentario'}
	                      </span>
	                      {selectedCommentReplyTarget.preview ? (
	                        <span className={styles.commentReplyBannerPreview}>“{selectedCommentReplyTarget.preview}”</span>
	                      ) : null}
	                    </span>
	                    <button
	                      type="button"
	                      className={styles.commentReplyBannerClose}
	                      onClick={() => {
	                        setCommentReplyTarget(null)
	                        if (isCommentComposerChannel(composerChannel)) {
	                          setComposerChannel(selectedCommentReplyTarget.platform === 'instagram' ? 'instagram' : 'messenger')
	                        }
	                      }}
	                      aria-label="Cancelar respuesta pública"
	                    >
	                      <X size={14} />
	                    </button>
	                  </div>
	                ) : (!isEmailComposer && (isCommentContact(activeContact) || messages.some((message) => message.isComment))) ? (
	                  <span className={styles.composerPrivateHint}>
	                    {latestEligibleCommentReplyTarget
	                      ? `Mensaje privado — para responder en publicación cambia el canal a ${getCommentComposerLabel(latestEligibleCommentReplyTarget.platform)}.`
	                      : 'Mensaje privado — para responder en la publicación usa “Responder” en el comentario.'}
	                  </span>
	                ) : null}
	                {isEmailComposer ? (
		                  <>
		                    <div className={styles.emailComposerHeaderRow}>
		                      {renderComposerAgentControl()}
		                      <div className={styles.emailComposerChannelSelect}>
		                        <CustomSelect
		                          value={composerRouteValue}
	                          options={composerChannelOptions}
	                          onValueChange={handleComposerChannelChange}
	                          portal
	                          dropdownPlacement="top"
	                          iconOnly
	                          placeholder="Canal de envío"
	                          placeholderIcon={renderComposerChannelIcon(composerChannel)}
	                          dropdownMinWidth={240}
		                          aria-label="Canal de envío"
		                        />
		                      </div>
		                      <label className={styles.emailSubjectField}>
	                        <span>Asunto</span>
	                        <input
	                          data-ristak-unstyled
	                          className={styles.emailSubjectInput}
	                          value={emailSubject}
	                          onChange={(event) => setEmailSubject(event.target.value)}
	                          onKeyDown={(event) => {
	                            if (event.key === 'Enter') event.preventDefault()
	                          }}
	                          placeholder="Asunto del correo"
	                          disabled={!activeContact || composerStatus === 'sending'}
	                        />
	                      </label>
	                    </div>

	                    <EmailRichTextEditor
	                      value={emailBodyHtml}
	                      onChange={setEmailBodyHtml}
	                      className={styles.emailEditor}
	                      editorClassName={styles.emailEditorBody}
	                      density="regular"
	                      variables={DESKTOP_EMAIL_VARIABLES}
	                      placeholder="Escribe el correo..."
	                      codePlaceholder="<table><tr><td>Contenido del correo...</td></tr></table>"
	                    />

	                    <div className={styles.emailFooter}>
	                      <label className={styles.emailSignatureToggle}>
	                        <Switch
	                          checked={emailIncludeSignature}
	                          onChange={setEmailIncludeSignature}
	                          disabled={composerStatus === 'sending'}
	                          aria-label="Agregar firma guardada al enviar"
	                        />
	                        <span>Agregar la firma guardada al enviar</span>
	                      </label>

	                      <Button
	                        type="submit"
	                        variant="primary"
	                        size="sm"
	                        className={styles.emailSendButton}
	                        loading={composerStatus === 'sending'}
	                        disabled={!canSend}
	                      >
	                        <Send size={16} />
	                        Enviar
	                      </Button>
	                    </div>
	                  </>
	                ) : (
	                  <>
	                    {renderComposerAgentControl()}
	                    <div className={styles.composerChannelSelect}>
	                      <CustomSelect
	                        value={composerRouteValue}
	                        options={composerChannelOptions}
	                        onValueChange={handleComposerChannelChange}
	                        portal
	                        iconOnly
	                        placeholder="Canal de envío"
	                        placeholderIcon={renderComposerChannelIcon(composerChannel)}
	                        dropdownMinWidth={240}
	                        aria-label="Canal de envío"
	                      />
	                    </div>
	                    <div className={styles.composerTextField}>
	                      <div ref={composerMenuRef} className={styles.composerActionWrap}>
	                        <button
	                          type="button"
	                          className={styles.composerPlusButton}
	                          onClick={() => {
	                            closeComposerAgentMenu()
	                            closeTemplatePanel()
	                            setComposerMenuOpen((current) => !current)
	                          }}
	                          aria-label="Abrir opciones de adjuntos"
	                          aria-expanded={composerMenuOpen || templatePanelOpen}
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
	                              <span>Fotos y videos</span>
	                            </button>
	                            {activeNativeMetaChannel !== 'instagram' ? (
	                              <button type="button" role="menuitem" onClick={() => handleComposerMenuAction('documents')}>
	                                <FileText size={16} />
	                                <span>Documentos</span>
	                              </button>
	                            ) : null}
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
	                        {renderTemplatePanel()}
	                      </div>
	                      <textarea
	                        data-ristak-unstyled
	                        value={composerText}
	                        onChange={(event) => setComposerText(event.target.value)}
	                        onKeyDown={(event) => {
	                          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
	                            event.preventDefault()
	                            event.stopPropagation()
	                            if (canSend) void handleSendMessage()
	                          }
	                        }}
	                        placeholder={voiceRecording ? 'Grabando audio...' : voiceDraft ? 'Audio listo para enviar' : 'Escribe una respuesta...'}
	                        rows={1}
	                        onFocus={() => {
	                          setComposerMenuOpen(false)
	                          closeTemplatePanel()
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
                      <ArrowUp size={18} />
                    </button>
	                  </>
	                )}
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
                <div className={styles.infoHeaderBody}>
                  <InlineEditableText
                    className={styles.infoHeaderName}
                    value={(contactInfoData || activeContact).name || ''}
                    emptyLabel="Contacto sin nombre"
                    ariaLabel="Editar nombre del contacto"
                    onSave={(value) => handleUpdateContactIdentityField('name', value)}
                  />
                  <p>{stageLabel}</p>
                </div>
              </div>

              <div className={styles.infoSection}>
                <h3>Contacto</h3>
                <dl className={styles.detailList}>
                  <div>
                    <dt><Phone size={14} /> Teléfono</dt>
                    <dd>
                      <ContactPhoneSelector
                        phones={activeContactPhones}
                        emptyLabel="Sin teléfono"
                        savingPhone={savingPrimaryPhone}
                        onSavePrimaryPhone={(value) => handleUpdateContactIdentityField('phone', value)}
                        onMakePrimary={handleMakePrimaryPhone}
                      />
                    </dd>
                  </div>
                  {businessPhones.length > 0 && activeInfoContactHasPhone ? (
                    <div>
                      <dt><FaWhatsapp aria-hidden="true" /> WhatsApp de respuesta</dt>
                      <dd>
                        <CustomSelect
                          value={preferredWhatsAppPhoneNumberId}
                          options={[
                            { value: '', label: automaticWhatsAppPreferenceOptionLabel },
                            ...businessPhones.map((phone) => ({
                              value: phone.id,
                              label: `${getBusinessPhoneDisplay(phone)}${phone.is_default_sender ? ' · Principal' : ''}`,
                              disabled: !getBusinessPhoneValue(phone)
                            }))
                          ]}
                          onValueChange={handleUpdatePreferredWhatsAppPhoneNumber}
                          disabled={savingWhatsAppPreference}
                          portal
                          dropdownMinWidth={280}
                          aria-label="WhatsApp de respuesta del contacto"
                        />
                        <p className={styles.mutedLine}>{whatsappPreferenceDescription}</p>
                        <p className={styles.mutedLine}>
                          <strong>{whatsappPreferenceRouteMode}:</strong> {whatsappPreferenceRouteDisplay}
                        </p>
                        {savingWhatsAppPreference ? <p className={styles.mutedLine}>Guardando cambio...</p> : null}
                        {whatsappPreferenceError ? <p className={styles.errorText}>{whatsappPreferenceError}</p> : null}
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt><Mail size={14} /> Correo</dt>
                    <dd>
                      <InlineEditableText
                        value={(contactInfoData || activeContact).email || ''}
                        emptyLabel="Sin correo"
                        ariaLabel="Editar correo del contacto"
                        type="email"
                        inputMode="email"
                        layout="block"
                        onSave={(value) => handleUpdateContactIdentityField('email', value)}
                      />
                    </dd>
                  </div>
                  <div><dt><Tag size={14} /> Estado</dt><dd>{stageLabel}</dd></div>
                </dl>
                <div className={styles.contactTools}>
                  <div className={styles.contactTagTool}>
                    <TagPicker
                      multiple
                      selectedIds={(contactInfoData || activeContact).tags || []}
                      onChange={handleUpdateContactTags}
                      allowCreate
                      disabled={savingTags}
                      portal
                      placeholder="Agregar etiqueta"
                      triggerVariant="chip"
                      chipTriggerPlacement="header"
                      headerLabel="Etiquetas"
                      headerClassName={styles.contactTagHeader}
                      headerLabelClassName={styles.contactTagTitle}
                      closeOnSelect
                      aria-label="Etiquetas del contacto"
                    />
                    {savingTags ? <small>Guardando etiquetas...</small> : null}
                  </div>
                  {hasAutomationsAccess && (
                    <button type="button" className={styles.automationButton} onClick={openAutomationModal}>
                      <Workflow size={15} />
                      <span>Mandar a automatización</span>
                    </button>
                  )}
                </div>
              </div>

              <div className={styles.infoSection}>
                <ContactCustomFieldsPanel
                  contactId={(contactInfoData || activeContact).id}
                  customFields={(contactInfoData || activeContact).customFields || []}
                  onUpdateCustomFields={handleUpdateContactCustomFields}
                  onCustomFieldsChange={(customFields) => {
                    const contactId = (contactInfoData || activeContact).id
                    setContactInfoData((current) => current?.id === contactId ? { ...current, customFields } : current)
                    setChats((current) => current.map((contact) => contact.id === contactId ? { ...contact, customFields } : contact))
                  }}
                  collapsible
                  defaultExpanded={false}
                  compact
                />
              </div>

              {(socialProfiles.length > 0 || linkedSocialContacts.length > 0) ? (
                <div className={styles.infoSection}>
                  <h3>Perfil social</h3>
                  {socialProfiles.length > 0 ? (
                    <dl className={styles.detailList}>
                      {socialProfiles.map((profile) => (
                        <div key={`${profile.platform}-${profile.kind}`}>
                          <dt>
                            {profile.platform === 'instagram'
                              ? <FaInstagram aria-hidden="true" />
                              : profile.kind === 'comment'
                                ? <FaFacebook aria-hidden="true" />
                                : <FaFacebookMessenger aria-hidden="true" />}
                            {profile.platformLabel}
                            {' · '}
                            {profile.kind === 'comment' ? 'Comentarios' : 'Mensajes directos'}
                          </dt>
                          <dd>
                            {profile.name ? (
                              <span className={styles.socialProfileName}>{profile.name}</span>
                            ) : null}
                            {profile.username ? (
                              <span className={styles.socialProfileHandle}>@{profile.username}</span>
                            ) : null}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {linkedSocialContacts.length > 0 ? (
                    <div className={styles.linkedContacts}>
                      <span className={styles.linkedContactsLabel}>Mismo contacto en otro canal</span>
                      {linkedSocialContacts.map((link) => (
                        <button
                          key={link.contactId}
                          type="button"
                          className={styles.linkedContactButton}
                          onClick={() => handleOpenLinkedContact(link)}
                        >
                          <span className={styles.linkedContactAvatar}>
                            {link.photo
                              ? <img src={link.photo} alt="" loading="lazy" />
                              : (link.name || '?').slice(0, 1).toUpperCase()}
                          </span>
                          <span className={styles.linkedContactBody}>
                            <strong>{link.name || 'Contacto vinculado'}</strong>
                            <small>{link.kind === 'comment' ? 'Comentarios' : 'Mensajes directos'} · {link.platformLabel}</small>
                          </span>
                          <ChevronRight size={15} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

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
                        Viaje {customerWithArticle}
                      </Button>
                    </div>
                    <div className={styles.metricsGrid}>
                      <span><strong>{formatCurrencyNoDecimals(contactPayments.filter(isSuccessfulPayment).reduce((sum, payment) => sum + payment.amount, 0), accountCurrency)}</strong><small>Total Pagado</small></span>
                      <span><strong>{contactAppointments.length}</strong><small>Citas totales</small></span>
                      <span><strong>{Number(activeContact.messageCount || messages.length)}</strong><small>Mensajes</small></span>
                    </div>
                  </div>

                  <div className={styles.infoSection}>
                    <div className={styles.sectionTitleRow}>
                      <h3>Responsable</h3>
                    </div>
                    <CustomSelect
                      value={assignedUserId}
                      options={assignableUserOptions}
                      onValueChange={handleAssignContact}
                      placeholder="Sin asignar"
                      aria-label="Responsable del contacto"
                    />
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
                            <strong>{formatCurrency(payment.amount, payment.currency || accountCurrency)}</strong>
                            <small>{formatLocalDateTime(payment.date)} · {formatPlainStatus(payment.status)}</small>
                          </span>
                        </div>
                      ))}
                      {contactPayments.length === 0 ? <p className={styles.mutedLine}>Sin pagos registrados.</p> : null}
                    </div>
                  </div>

                  {agentCompletionEvents.length > 0 ? (
                    <div className={styles.infoSection}>
                      <div className={styles.sectionTitleRow}>
                        <h3>Historial del agente</h3>
                        {agentCompletionEvents.length > 2 ? (
                          <button type="button" onClick={() => setAgentHistoryExpanded((current) => !current)}>
                            {agentHistoryExpanded ? 'Ver menos' : `Ver ${agentCompletionEvents.length}`}
                          </button>
                        ) : null}
                      </div>
                      <div className={styles.agentHistoryList}>
                        {(agentHistoryExpanded ? agentCompletionEvents : agentCompletionEvents.slice(0, 2)).map((completion) => (
                          <div
                            key={completion.id}
                            className={styles.agentHistoryItem}
                          >
                            <span aria-hidden="true">{completion.icon}</span>
                            <span>
                              <strong>{completion.title}</strong>
                              <small>{completion.actionSummary}</small>
                              <em>{formatLocalDateTime(completion.createdAt)}</em>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

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
                <div><span>Etapa</span><strong>{labels.lead}, cita o {customerLowerLabel}</strong></div>
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

      <ContentFocusModal item={contentFocusItem} onClose={() => setContentFocusItem(null)} />

      <RecordPaymentModal
        isOpen={paymentOpen}
        onClose={() => setPaymentOpen(false)}
        initialPaymentMode="single"
        lockPaymentMode
        initialContact={activeContact}
        lockInitialContact={Boolean(activeContact?.id)}
        onSuccess={(context) => {
          if (context?.keepOpen) {
            if (activeContactId) void loadConversation(activeContactId)
            return
          }

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
        isOpen={Boolean(mediaDeliveryPrompt)}
        onClose={() => resolveMediaDeliveryPrompt('cancel')}
        title={mediaDeliveryPrompt?.kind === 'audio' ? 'Enviar audio' : 'Enviar video'}
        size="sm"
        closeOnBackdropClick={false}
      >
        <div className={styles.mediaDeliveryPrompt}>
          <p>
            {mediaDeliveryPrompt?.kind === 'audio'
              ? 'Este audio puede salir como nota de voz o como archivo.'
              : 'Este video puede salir como video reproducible o como archivo.'}
          </p>
          {mediaDeliveryPrompt ? (
            <span>
              {mediaDeliveryPrompt.name} · {formatAttachmentSize(mediaDeliveryPrompt.size)}
            </span>
          ) : null}
          <div className={styles.mediaDeliveryActions}>
            <Button
              type="button"
              variant="primary"
              size="sm"
              leftIcon={mediaDeliveryPrompt?.kind === 'audio' ? <Mic size={15} /> : <Video size={15} />}
              onClick={() => resolveMediaDeliveryPrompt(mediaDeliveryPrompt?.kind === 'audio' ? 'voice' : 'media')}
            >
              {mediaDeliveryPrompt?.kind === 'audio' ? 'Nota de voz' : 'Video'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leftIcon={<FileText size={15} />}
              onClick={() => resolveMediaDeliveryPrompt('document')}
            >
              Archivo
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => resolveMediaDeliveryPrompt('cancel')}
            >
              Cancelar
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={Boolean(manualAgentSendPrompt)}
        onClose={() => setManualAgentSendPrompt(null)}
        title="Agente activo en este chat"
        message={`Si envías este mensaje, ${manualAgentSendLabel} dejará de responder este chat. Elige si quieres pausarlo 24 horas o quitar este contacto del agente hasta que lo reactives.`}
        type="confirm"
        size="sm"
        confirmText="Pausar 24h y enviar"
        cancelText="Cancelar"
        secondaryActionText="Quitar del agente y enviar"
        secondaryActionVariant="danger"
        onConfirm={() => handleManualAgentSendDecision('pause')}
        onSecondaryAction={() => handleManualAgentSendDecision('skip')}
        onCancel={() => setManualAgentSendPrompt(null)}
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
          <div className={styles.scheduleField}>
            <span>Fecha</span>
            <DatePicker
              value={scheduleDraft.date}
              min={todayDateOnlyInTimezone(timezone)}
              today={todayDateOnlyInTimezone(timezone)}
              ariaLabel="Fecha"
              disabled={schedulingMessage}
              onChange={(date) => handleScheduleDraftChange({ date })}
            />
          </div>
          <div className={styles.scheduleTimeRow}>
            <label className={styles.scheduleField}>
              <span>Hora</span>
              <input
                type="text"
                min="1"
                max="12"
                inputMode="numeric"
                value={scheduleDraft.hour}
                onChange={(event) => handleScheduleDraftChange({ hour: event.target.value.replace(/\D/g, '').slice(0, 2) })}
              />
            </label>
            <label className={styles.scheduleField}>
              <span>Min</span>
              <input
                type="text"
                min="0"
                max="59"
                inputMode="numeric"
                value={scheduleDraft.minute}
                onChange={(event) => handleScheduleDraftChange({ minute: event.target.value.replace(/\D/g, '').slice(0, 2) })}
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
        isOpen={bulkChatConfirmAction === 'archive'}
        onClose={closeBulkChatConfirm}
        title={bulkArchiveConfirmTitle}
        message={bulkArchiveConfirmMessage}
        type="confirm"
        size="sm"
        confirmText={bulkArchiveActionLabel}
        cancelText="Cancelar"
        typeToConfirm={bulkArchiveConfirmWord}
        onConfirm={handleArchiveSelectedChats}
      />

      <Modal
        isOpen={bulkChatConfirmAction === 'remove'}
        onClose={closeBulkChatConfirm}
        title="Eliminar chats seleccionados"
        message={bulkRemoveConfirmMessage}
        type="confirm"
        size="sm"
        confirmText="Eliminar"
        cancelText="Cancelar"
        typeToConfirm={BULK_CHAT_REMOVE_CONFIRM_WORD}
        onConfirm={handleRemoveSelectedChatsFromList}
      />

      <Modal
        isOpen={hasAutomationsAccess && automationModalOpen}
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
