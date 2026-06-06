import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Archive,
  Bell,
  Bot,
  CalendarDays,
  Camera,
  Check,
  ChevronLeft,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Loader2,
  MapPin,
  MessageCircle,
  Mic,
  MonitorX,
  MoreHorizontal,
  Phone,
  Plus,
  Search,
  Send,
  Smile,
  Smartphone,
  User,
  Video,
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
import styles from './PhoneChat.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_CHAT_SELECTOR = '[data-phone-chat-scrollable="true"], [contenteditable="true"], textarea, input, select'

type AccessState = 'checking' | 'allowed' | 'blocked'
type ComposerStatus = 'idle' | 'sending'
type PaymentMode = 'single' | 'partial'
type ActionSheet = 'attachments' | 'payment' | 'appointment' | 'notifications' | 'newChat' | null
type ChatFilter = 'all' | 'unread' | 'appointments' | 'customers' | 'leads'

interface ChatMessage {
  id: string
  text: string
  date: string
  direction: 'inbound' | 'outbound' | 'system'
  status?: string
  attachment?: {
    type: 'image'
    dataUrl: string
    name?: string
  }
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

function getContactName(contact?: Partial<Contact> | null) {
  return contact?.name || contact?.email || contact?.phone || 'Unnamed contact'
}

function getContactDetail(contact?: Partial<Contact> | null) {
  return contact?.phone || contact?.email || 'No saved phone'
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

  return new Intl.DateTimeFormat('en-US', {
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

  return new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: 'short'
  }).format(date).replace('.', '')
}

function getJourneyMessage(event: JourneyEvent, index: number): ChatMessage | null {
  if (event.type !== 'whatsapp_message') return null

  const text = String(
    event.data?.message_text ||
    event.data?.message ||
    event.data?.body ||
    ''
  ).trim()

  if (!text && !event.data?.message_type) return null

  const direction = String(event.data?.direction || '').toLowerCase() === 'outbound' ? 'outbound' : 'inbound'

  return {
    id: String(event.data?.whatsapp_api_message_id || event.data?.whatsapp_message_id || event.data?.attribution_record_id || `message-${index}`),
    text: text || getMessageTypeLabel(String(event.data?.message_type || '')),
    date: event.date,
    direction,
    status: String(event.data?.status || '')
  }
}

function getMessageTypeLabel(type = '') {
  const normalized = type.toLowerCase()
  if (normalized.includes('image')) return 'Photo'
  if (normalized.includes('video')) return 'Video'
  if (normalized.includes('audio') || normalized.includes('voice')) return 'Voice message'
  if (normalized.includes('document')) return 'Document'
  if (normalized.includes('location')) return 'Location'
  return 'WhatsApp message'
}

function getChatPreview(contact: ChatContact) {
  const text = String(contact.lastMessageText || '').trim()
  const typeLabel = text ? text : getMessageTypeLabel(contact.lastMessageType || '')
  return contact.lastMessageDirection === 'outbound' ? `You: ${typeLabel}` : typeLabel
}

function getNotificationPermissionLabel() {
  if (mobileAppService.isNative()) return 'Tap Enable to allow alerts on this phone.'
  if (typeof window === 'undefined' || !('Notification' in window)) return 'This phone does not allow app alerts.'
  if (Notification.permission === 'granted') return 'This phone can already receive alerts.'
  if (Notification.permission === 'denied') return 'This phone blocked alerts. Enable them from browser settings.'
  return 'Tap Enable to allow alerts on this phone.'
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
  const { timezone } = useTimezone()
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
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [draftAttachments, setDraftAttachments] = useState<MobilePhotoAttachment[]>([])
  const [composerStatus, setComposerStatus] = useState<ComposerStatus>('idle')
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppApiStatus | null>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [selectedCalendarId, setSelectedCalendarId] = useState('')
  const [sheet, setSheet] = useState<ActionSheet>(null)
  const [paymentMode, setPaymentMode] = useState<PaymentMode>('single')
  const [appointmentOpen, setAppointmentOpen] = useState(false)
  const [requestingPush, setRequestingPush] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const composerInputRef = useRef<HTMLDivElement | null>(null)
  const cameraInputRef = useRef<HTMLInputElement | null>(null)
  const photosInputRef = useRef<HTMLInputElement | null>(null)

  const activeContact = useMemo(
    () => chats.find((contact) => contact.id === activeContactId) || null,
    [activeContactId, chats]
  )

  const selectedCalendar = useMemo(
    () => calendars.find((calendar) => calendar.id === selectedCalendarId) || calendars[0] || null,
    [calendars, selectedCalendarId]
  )

  const initialContact = useMemo(() => toPaymentContact(activeContact), [activeContact])
  const defaultAppointmentRange = useMemo(() => createDefaultAppointmentRange(timezone), [timezone])
  const whatsappConnected = Boolean(whatsappStatus?.connected && whatsappStatus?.configured)
  const canSendMessage = Boolean(activeContact?.phone && (messageText.trim() || draftAttachments.length > 0) && composerStatus !== 'sending')
  const hasChats = chats.length > 0
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
      setChatsError('Chats could not be loaded.')
      setChats([])
    } finally {
      setChatsLoading(false)
    }
  }, [chatQuery, requestedContactParam])

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
      const nextMessages = journey
        .map(getJourneyMessage)
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime())

      setMessages(nextMessages)
    } catch {
      setMessages([])
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
    loadSupportData()
  }, [accessState, loadSupportData])

  useEffect(() => {
    if (!activeContact?.id || accessState !== 'allowed') {
      setMessages([])
      return
    }
    loadConversation(activeContact.id)
  }, [accessState, activeContact?.id, loadConversation])

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

  const handleSelectContact = (contact: Contact) => {
    const nextContact = ensureChatContact(contact)
    setActiveContactId(nextContact.id)
    setConversationOpen(true)
    setSheet(null)
    setContactQuery('')
    setDraftAttachments([])
  }

  const handleBackToChats = () => {
    setConversationOpen(false)
    setSheet(null)
    setDraftAttachments([])
  }

  const handleUnavailableAttachment = (label: string) => {
    showToast('info', label, 'This option is already in the menu. The real connection turns on when phone files are connected.')
  }

  const addDraftAttachment = (attachment: MobilePhotoAttachment) => {
    setDraftAttachments((current) => [attachment, ...current].slice(0, 4))
    showToast('success', 'Photo ready', 'Review the preview and tap send.')
  }

  const readImageFile = (file: File, source: 'camera' | 'photos') => {
    if (!file.type.startsWith('image/')) {
      showToast('error', 'Invalid file', 'Choose a JPG, PNG, or WebP photo.')
      return
    }

    if (file.size > 8 * 1024 * 1024) {
      showToast('error', 'Photo is too large', 'Choose a lighter photo so it can be sent through WhatsApp.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      if (!dataUrl) {
        showToast('error', 'Could not read it', 'Try choosing the photo again.')
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
    reader.onerror = () => showToast('error', 'Could not read it', 'Try choosing the photo again.')
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
        showToast('error', source === 'camera' ? 'Camera did not open' : 'Photos did not open', error?.message || 'Check phone permissions and try again.')
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

  const handleSendMessage = async () => {
    const text = messageText.trim()
    const attachmentsToSend = draftAttachments
    if (!activeContact || (!text && attachmentsToSend.length === 0)) return

    if (!activeContact.phone) {
      showToast('error', 'Missing phone', 'Save the contact phone number before writing through WhatsApp.')
      return
    }

    if (!whatsappConnected) {
      showToast('error', 'WhatsApp is not connected', 'Connect WhatsApp API in settings to send messages from Ristak.')
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
    const optimisticMessages: ChatMessage[] = attachmentsToSend.length > 0
      ? attachmentsToSend.map((attachment, index) => ({
          id: `${optimisticId}-image-${index}`,
          text: index === 0 ? text : '',
          date: sentAt,
          direction: 'outbound',
          status: 'enviando',
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
          status: 'enviando'
        }]

    setMessages((current) => [...current, ...optimisticMessages])
    setChats((current) => current.map((contact) => (
      contact.id === activeContact.id
        ? {
            ...contact,
            lastMessageText: attachmentsToSend.length > 0 ? (text || 'Photo') : text,
            lastMessageDate: sentAt,
            lastMessageDirection: 'outbound',
            messageCount: Number(contact.messageCount || 0) + Math.max(1, attachmentsToSend.length)
          }
        : contact
    )))

    try {
      if (attachmentsToSend.length > 0) {
        await Promise.all(attachmentsToSend.map((attachment, index) => (
          whatsappApiService.sendImage({
            to: activeContact.phone || '',
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
          text,
          externalId: optimisticId
        })
        setMessages((current) => current.map((message) => (
          message.id === optimisticId ? { ...message, status: 'sent' } : message
        )))
      }
      await loadConversation(activeContact.id)
      await loadChats()
    } catch (error: any) {
      setMessages((current) => current.map((message) => (
        message.id === optimisticId || message.id.startsWith(`${optimisticId}-image-`) ? { ...message, status: 'error' } : message
      )))
      setDraftAttachments(attachmentsToSend)
      showToast('error', 'Message was not sent', error?.message || 'Try sending the message again.')
    } finally {
      setComposerStatus('idle')
    }
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
      showToast('success', 'Appointment scheduled', 'The appointment was saved.')
      setMessages((current) => [
        ...current,
        {
          id: `appointment-${Date.now()}`,
          text: 'Appointment scheduled from this chat.',
          date: new Date().toISOString(),
          direction: 'system'
        }
      ])
    } catch (error) {
      showToast('error', 'Could not schedule', 'Try again in a few minutes.')
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
        showToast('success', 'Alerts enabled', 'This phone can now receive Ristak alerts.')
      } else {
        showToast('warning', 'Alerts were not enabled', result.reason)
      }
    } catch (error: any) {
      showToast('error', 'Alerts were not enabled', error?.message || 'Try again.')
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

    return (
      <button
        key={contact.id}
        type="button"
        className={`${styles.chatItem} ${activeContact?.id === contact.id ? styles.chatItemActive : ''}`}
        onClick={() => handleSelectContact(contact)}
      >
        {renderAvatar(contact)}
        <span className={styles.chatMain}>
          <strong>{getContactName(contact)}</strong>
          <small>{subtitle}</small>
        </span>
        <span className={styles.chatMeta}>
          {dateLabel && <small>{dateLabel}</small>}
          {unreadCount > 0 && <i>{unreadCount}</i>}
        </span>
      </button>
    )
  }

  const renderChats = () => {
    if (chatsLoading) {
      return (
        <div className={styles.centerState}>
          <Loader2 size={20} className={styles.spinIcon} />
          <span>Loading chats...</span>
        </div>
      )
    }

    if (chatsError) {
      return (
        <div className={styles.centerState}>
          <span>{chatsError}</span>
          <button type="button" onClick={loadChats}>Try again</button>
        </div>
      )
    }

    if (chats.length === 0 && chatQuery.trim().length >= 2) {
      if (contactsLoading) {
        return (
          <div className={styles.centerState}>
            <Loader2 size={20} className={styles.spinIcon} />
            <span>Searching contacts...</span>
          </div>
        )
      }

      if (contactResults.length > 0) {
        return (
          <div className={styles.contactResultGroup}>
            <p>Contacts found</p>
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
          <strong>No chats yet</strong>
          <small>Tap the green button to search for a contact and start a conversation.</small>
          <button type="button" onClick={() => setSheet('newChat')}>
            <Plus size={17} />
            New chat
          </button>
        </div>
      )
    }

    return (
      <>
        <button type="button" className={styles.archiveRow}>
          <Archive size={21} />
          <strong>Archived</strong>
          <span>0</span>
        </button>
        {filteredChats.length > 0 ? (
          filteredChats.map((contact) => renderContactButton(contact, 'chat'))
        ) : (
          <div className={styles.emptyChats}>
            <span className={styles.emptyChatsIcon}>
              <Icon name="whatsapp" size={30} />
            </span>
            <strong>No chats in this filter</strong>
            <small>Change the filter or search for a contact to start a conversation.</small>
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
          <strong>Choose a chat</strong>
          <span>Open a conversation to write, charge, or schedule.</span>
        </div>
      )
    }

    if (messagesLoading) {
      return (
        <div className={styles.emptyConversation}>
          <Loader2 size={22} className={styles.spinIcon} />
          <span>Loading conversation...</span>
        </div>
      )
    }

    if (messages.length === 0) {
      return (
        <div className={styles.emptyConversation}>
          <Icon name="whatsapp" size={38} />
          <strong>No messages yet</strong>
          <span>Write the first message or open + to charge or schedule.</span>
        </div>
      )
    }

    return messages.map((message) => (
      <div
        key={message.id}
        className={`${styles.messageRow} ${styles[`messageRow_${message.direction}`]}`}
      >
        <div className={styles.messageBubble}>
          {message.attachment?.type === 'image' && (
            <img className={styles.messageImage} src={message.attachment.dataUrl} alt={message.attachment.name || 'Sent photo'} />
          )}
          {message.text && <p>{message.text}</p>}
          <span>
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
            <img src={attachment.dataUrl} alt={attachment.name || 'Photo ready'} />
            <button type="button" onClick={() => removeDraftAttachment(attachment.id)} aria-label="Remove photo">
              <X size={15} />
            </button>
          </figure>
        ))}
      </div>
    )
  }

  const renderNewChatSheet = () => (
    <div className={styles.newChatStack}>
      <div className={styles.sheetSearchBox}>
        <Search size={18} />
        <input
          value={contactQuery}
          onChange={(event) => setContactQuery(event.target.value)}
          placeholder="Search by name, number, or email"
          aria-label="Search contact for chat"
        />
        {contactQuery && (
          <button type="button" onClick={() => setContactQuery('')} aria-label="Clear contact search">
            <X size={16} />
          </button>
        )}
      </div>

      <div className={styles.sheetList} data-phone-chat-scrollable="true">
        {contactsLoading ? (
          <div className={styles.centerState}>
            <Loader2 size={20} className={styles.spinIcon} />
            <span>Searching contacts...</span>
          </div>
        ) : contactResults.length > 0 ? (
          contactResults.map((contact) => renderContactButton(contact, 'contact'))
        ) : (
          <div className={styles.emptySheetState}>
            <User size={24} />
            <strong>No contacts</strong>
            <span>Type at least two letters or check that the contact has a phone number.</span>
          </div>
        )}
      </div>
    </div>
  )

  const renderAttachmentsSheet = () => {
    const attachmentActions = [
      { label: 'Photos', Icon: ImageIcon, className: styles.actionBlue, onClick: () => handlePickPhoto('photos') },
      { label: 'Camera', Icon: Camera, className: styles.actionDark, onClick: () => handlePickPhoto('camera') },
      { label: 'Location', Icon: MapPin, className: styles.actionGreen, onClick: () => handleUnavailableAttachment('Location') },
      { label: 'Contact', Icon: User, className: styles.actionGray, onClick: () => handleUnavailableAttachment('Contact') },
      { label: 'Document', Icon: FileText, className: styles.actionSky, onClick: () => handleUnavailableAttachment('Document') },
      {
        label: 'Payment',
        Icon: CreditCard,
        className: styles.actionGold,
        onClick: () => {
          setPaymentMode('single')
          setSheet('payment')
        }
      },
      {
        label: 'Appointment',
        Icon: CalendarDays,
        className: styles.actionRed,
        onClick: () => setSheet('appointment')
      },
      {
        label: 'AI Agent',
        Icon: Bot,
        className: styles.actionPurple,
        onClick: () => handleUnavailableAttachment('AI Agent')
      }
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
            <h1 id="phone-chat-blocked-title">Mobile or tablet only</h1>
            <p>This chat app is built to be used from your phone, like an app saved to your home screen.</p>
          </div>
          <Link className={styles.dashboardLink} to="/dashboard">
            Back to dashboard
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className={`${styles.phoneChatPage} ${conversationOpen ? styles.conversationOpen : ''}`} aria-label="Ristak mobile chat">
      <div className={styles.phoneFrame}>
        <section className={styles.chatListScreen} aria-label="Lista de chats">
          <header className={styles.chatListHeader}>
            <div className={styles.topActionRow}>
              <button type="button" className={styles.roundButton} onClick={() => setSheet('notifications')} aria-label="More options">
                <MoreHorizontal size={24} />
              </button>
              <div className={styles.topRightActions}>
                <button type="button" className={styles.roundButton} onClick={() => handlePickPhoto('camera')} aria-label="Open camera">
                  <Camera size={24} />
                </button>
                <button type="button" className={styles.newChatButton} onClick={() => setSheet('newChat')} aria-label="New chat">
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
                placeholder="Search chats or contacts"
                aria-label="Search chats or contacts"
              />
              {chatQuery && (
                <button type="button" onClick={() => setChatQuery('')} aria-label="Clear search">
                  <X size={17} />
                </button>
              )}
            </div>
            <div className={styles.filterChips} data-phone-chat-scrollable="true">
              {([
                ['all', 'Todos'],
                ['unread', 'No leídos'],
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

          <PhoneEcosystemNav active="chat" />
        </section>

        <section className={styles.conversationScreen} aria-label="Conversation">
          <header className={styles.conversationHeader}>
            <button type="button" className={styles.backButton} onClick={handleBackToChats} aria-label="Back to chats">
              <ChevronLeft size={32} />
            </button>

            {activeContact ? (
              <>
                {renderAvatar(activeContact)}
                <div className={styles.conversationIdentity}>
                  <strong>{getContactName(activeContact)}</strong>
                  <span>{getContactDetail(activeContact)}</span>
                </div>
              </>
            ) : (
              <div className={styles.conversationIdentity}>
                <strong>No contact</strong>
                <span>Choose a conversation</span>
              </div>
            )}

            <div className={styles.callActions}>
              <button type="button" onClick={() => handleUnavailableAttachment('Video call')} aria-label="Video call">
                <Video size={26} />
              </button>
              <button type="button" onClick={() => handleUnavailableAttachment('Call')} aria-label="Call">
                <Phone size={25} />
              </button>
            </div>
          </header>

          <div className={styles.messagesPane} data-phone-chat-scrollable="true">
            {renderMessages()}
            <div ref={messagesEndRef} />
          </div>

          <div className={styles.composerShell}>
            {renderDraftAttachments()}
            <div className={styles.composer}>
              <button type="button" className={styles.composerPlus} onClick={() => setSheet('attachments')} aria-label="Open attachments">
                <Plus size={34} />
              </button>
              <div className={styles.messageInputWrap}>
                <div
                  ref={composerInputRef}
                  className={styles.composerInput}
                  role="textbox"
                  aria-multiline="true"
                  aria-label="Mensaje"
                  aria-disabled={!activeContact?.phone || composerStatus === 'sending'}
                  data-placeholder={activeContact?.phone ? '' : 'Sin teléfono'}
                  contentEditable={Boolean(activeContact?.phone && composerStatus !== 'sending')}
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
                <button type="button" onClick={() => handleUnavailableAttachment('Stickers')} aria-label="Stickers">
                  <Smile size={26} />
                </button>
              </div>
              <button type="button" className={styles.composerIconButton} onClick={() => handlePickPhoto('camera')} aria-label="Camera">
                <Camera size={29} />
              </button>
              <button
                type="button"
                className={styles.composerIconButton}
                onClick={canSendMessage ? handleSendMessage : () => handleUnavailableAttachment('Voice message')}
                disabled={composerStatus === 'sending'}
                aria-label={canSendMessage ? 'Send message' : 'Voice message'}
              >
                {composerStatus === 'sending' ? <Loader2 size={23} className={styles.spinIcon} /> : canSendMessage ? <Send size={25} /> : <Mic size={30} />}
              </button>
            </div>
          </div>
        </section>
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
            aria-label="Chat actions"
          >
            <div className={styles.sheetHandle} />
            <div className={styles.sheetHeader}>
              <div>
                <p>{activeContact ? getContactName(activeContact) : 'Ristak Chat'}</p>
                <h2>
                  {sheet === 'attachments' && 'Add'}
                  {sheet === 'payment' && 'Record payment'}
                  {sheet === 'appointment' && 'Schedule appointment'}
                  {sheet === 'notifications' && 'Phone alerts'}
                  {sheet === 'newChat' && 'New chat'}
                </h2>
              </div>
              <button type="button" onClick={() => setSheet(null)} aria-label="Close panel">
                <X size={20} />
              </button>
            </div>

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
                    Single payment
                  </button>
                  <button
                    type="button"
                    className={paymentMode === 'partial' ? styles.segmentActive : ''}
                    onClick={() => setPaymentMode('partial')}
                  >
                    Payment plan
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
                          text: 'Payment recorded from this chat.',
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
                    <strong>Calendar</strong>
                    <span>Choose where you want to save the appointment.</span>
                  </div>
                </div>

                <select
                  value={selectedCalendar?.id || ''}
                  onChange={(event) => setSelectedCalendarId(event.target.value)}
                  disabled={calendars.length === 0}
                >
                  {calendars.length === 0 ? (
                    <option value="">No calendars available</option>
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
                  Schedule appointment
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
                    <strong>This phone</strong>
                    <small>{getNotificationPermissionLabel()}</small>
                  </div>
                  <button type="button" onClick={handleRequestPush} disabled={requestingPush}>
                    {requestingPush ? <Loader2 size={16} className={styles.spinIcon} /> : <Bell size={16} />}
                    Enable
                  </button>
                </section>

                <label className={styles.toggleRow}>
                  <span>
                    <strong>Chat messages</strong>
                    <small>Alert me when a new WhatsApp arrives.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={chatPushEnabled}
                    onChange={(event) => setChatPushEnabled(event.target.checked).catch(() => showToast('error', 'Setting was not saved', 'Try again.'))}
                  />
                </label>

                <label className={styles.toggleRow}>
                  <span>
                    <strong>Appointments</strong>
                    <small>Alert me when someone schedules an appointment.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={calendarPushEnabled}
                    onChange={(event) => setCalendarPushEnabled(event.target.checked).catch(() => showToast('error', 'Setting was not saved', 'Try again.'))}
                  />
                </label>

                <label className={styles.toggleRow}>
                  <span>
                    <strong>Payments</strong>
                    <small>Alert me when a payment is recorded.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={paymentPushEnabled}
                    onChange={(event) => setPaymentPushEnabled(event.target.checked).catch(() => showToast('error', 'Setting was not saved', 'Try again.'))}
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
