import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  BellRing,
  Bot,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileText,
  ListChecks,
  Loader2,
  LogOut,
  MessageCircle,
  Mic,
  Plus,
  RefreshCw,
  Save,
  Smartphone,
  Sparkles,
  Square,
  Sun,
  Tag,
  Trash2,
  type LucideIcon
} from 'lucide-react'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhonePageTransition } from '@/components/phone/PhonePageTransition'
import { useAuth } from '@/contexts/AuthContext'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useAIAgentAvailability, useAppConfig, useUserConfig, usePhoneElasticScroll, usePhoneTheme } from '@/hooks' // (MOB-006) useUserConfig
import { calendarsService, type Calendar } from '@/services/calendarsService'
import { customFieldsService, isSystemCustomFieldDefinition } from '@/services/customFieldsService'
import { contactTagsService, type ContactTag } from '@/services/contactTagsService'
import { aiAgentService } from '@/services/aiAgentService'
import { mobileAppService } from '@/services/mobileAppService'
import { clearRuntimeApiBaseUrl, isNativeAppRuntime } from '@/services/apiBaseUrl'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { whatsappApiService, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import type { ContactCustomFieldDefinition } from '@/types'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
import { PHONE_APP_LOGIN_PATH, PHONE_APP_TENANT_PATH } from '@/utils/phoneAccess'
import styles from './PhoneSettings.module.css'

type SettingsSection = 'templates' | 'agent' | 'chats' | 'custom-fields' | 'tags' | 'appearance' | 'privacy' | 'notifications' | null
type ConversationSortMode = 'recent' | 'unread'
type PhoneNotificationPermission = NotificationPermission | 'native_granted' | 'native_denied' | 'native_prompt' | 'unsupported' | 'checking'
type BusinessVoiceState = 'idle' | 'recording' | 'processing'

const CHAT_SEND_READ_RECEIPTS_CONFIG_KEY = 'chat_send_read_receipts_enabled'

const TEMPLATE_BLOCKED_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED'])
const BUSINESS_VOICE_MIME_CANDIDATES = [
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm'
]
const EMPTY_BUSINESS_CONTEXT_TEXT = new Set([
  'No se proporcionaron detalles del negocio.'
])
const PERSONAL_ASSISTANT_AI_LABEL = 'Asistente Personal AI'

function getBusinessVoiceMimeType() {
  if (typeof window === 'undefined' || typeof MediaRecorder === 'undefined') return ''
  return BUSINESS_VOICE_MIME_CANDIDATES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || ''
}

function normalizeBusinessContextDraft(value = '') {
  const cleaned = value.trim()
  return EMPTY_BUSINESS_CONTEXT_TEXT.has(cleaned) ? '' : cleaned
}

function getNotificationPermission(): PhoneNotificationPermission {
  if (mobileAppService.isNative()) return 'checking'
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return window.Notification.permission
}

function mapNativePermission(permission: Awaited<ReturnType<typeof mobileAppService.getPushPermissionStatus>>): PhoneNotificationPermission {
  if (permission === 'granted') return 'native_granted'
  if (permission === 'denied') return 'native_denied'
  if (permission === 'prompt') return 'native_prompt'
  return 'unsupported'
}

function getNotificationPermissionLabel(permission: PhoneNotificationPermission) {
  if (permission === 'checking') return 'Revisando'
  if (permission === 'native_granted') return 'Activo en este celular'
  if (permission === 'native_denied') return 'Bloqueado por el celular'
  if (permission === 'native_prompt') return 'Falta activar'
  if (permission === 'granted') return 'Activo en este celular'
  if (permission === 'denied') return 'Bloqueado por el celular'
  if (permission === 'default') return 'Falta activar'
  return 'No disponible'
}

function shouldShowPhoneActivation(permission: PhoneNotificationPermission) {
  return permission !== 'granted' && permission !== 'native_granted' && permission !== 'checking'
}

function getTemplateStatus(template: WhatsAppApiTemplate) {
  return String(template.status || 'UNKNOWN').toUpperCase()
}

function getTemplateStatusLabel(status: string) {
  if (status === 'APPROVED') return 'Aprobada'
  if (status === 'PENDING' || status === 'IN_REVIEW') return 'En revisión'
  if (status === 'REJECTED') return 'Rechazada'
  if (status === 'PAUSED' || status === 'DISABLED') return 'Bloqueada'
  return status === 'UNKNOWN' ? 'Sin estado' : status
}

function getTemplatePreview(template: WhatsAppApiTemplate) {
  const body = template.components?.find((component) => String(component.type || '').toUpperCase() === 'BODY')
  const text = typeof body?.text === 'string' ? body.text : ''
  return text || template.reason || 'Sin vista previa.'
}

export const PhoneSettings: React.FC = () => {
  const { locationId, accessToken, logout } = useAuth()
  const { showToast, showConfirm } = useNotification()
  const { labels } = useLabels()
  const customerLowerLabel = formatCrmLabelLower(labels.customer, DEFAULT_CRM_LABELS.customer)
  const customersLowerLabel = formatCrmLabelLower(labels.customers, DEFAULT_CRM_LABELS.customers)
  const [defaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [aiAgentChatEnabled, setAiAgentChatEnabled] = useAppConfig<boolean>('mobile_chat_ai_agent_enabled', true)
  const [aiReplySuggestionsEnabled, setAiReplySuggestionsEnabled] = useAppConfig<boolean>('mobile_chat_ai_reply_suggestions_enabled', false)
  const aiAvailability = useAIAgentAvailability()
  const [showArchivedChats, setShowArchivedChats] = useAppConfig<boolean>('mobile_chat_show_archived', true)
  const [conversationSortMode, setConversationSortMode] = useAppConfig<ConversationSortMode>('mobile_chat_sort_mode', 'recent')
  const [showLastMessagePreview, setShowLastMessagePreview] = useAppConfig<boolean>('mobile_chat_show_last_preview', true)
  const [showUnreadIndicators, setShowUnreadIndicators] = useAppConfig<boolean>('mobile_chat_show_unread_indicators', true)
  const [sendReadReceipts, setSendReadReceipts] = useAppConfig<boolean>(CHAT_SEND_READ_RECEIPTS_CONFIG_KEY, true)
  const [calendarPushEnabled, setCalendarPushEnabled] = useUserConfig<boolean>('calendar_push_notifications_enabled', false) // (MOB-006) preferencia por usuario
  const [appointmentConfirmationPushEnabled, setAppointmentConfirmationPushEnabled] = useUserConfig<boolean>('appointment_confirmation_push_notifications_enabled', true) // (MOB-006) preferencia por usuario
  const [chatPushEnabled, setChatPushEnabled] = useUserConfig<boolean>('chat_push_notifications_enabled', true) // (MOB-006) preferencia por usuario
  const [paymentPushEnabled, setPaymentPushEnabled] = useUserConfig<boolean>('payment_push_notifications_enabled', true) // (MOB-006) preferencia por usuario
  const [notificationSoundEnabled, setNotificationSoundEnabled] = useUserConfig<boolean>('push_notification_sound_enabled', true) // (MOB-006) preferencia por usuario
  const [notificationVibrationEnabled, setNotificationVibrationEnabled] = useUserConfig<boolean>('push_notification_vibration_enabled', true) // (MOB-006) preferencia por usuario
  const [pushCalendarIds, setPushCalendarIds] = useUserConfig<string[]>('calendar_push_notification_calendar_ids', []) // (MOB-006) preferencia por usuario
  const { resolvedThemeLabel } = usePhoneTheme({ active: false })

  const [activeSection, setActiveSection] = useState<SettingsSection>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [calendarsLoading, setCalendarsLoading] = useState(false)
  const [templates, setTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<ContactCustomFieldDefinition[]>([])
  const [customFieldsLoading, setCustomFieldsLoading] = useState(false)
  const [customFieldsError, setCustomFieldsError] = useState('')
  const [settingsTags, setSettingsTags] = useState<ContactTag[]>([])
  const [newCustomFieldName, setNewCustomFieldName] = useState('')
  const [newTagName, setNewTagName] = useState('')
  const [catalogBusyId, setCatalogBusyId] = useState<string | null>(null)
  const [requestingPush, setRequestingPush] = useState(false)
  const [permission, setPermission] = useState(getNotificationPermission)
  const [backButtonCollapsed, setBackButtonCollapsed] = useState(false)
  const [aiAgentConfigLoading, setAiAgentConfigLoading] = useState(false)
  const [businessContextDraft, setBusinessContextDraft] = useState('')
  const [savedBusinessContext, setSavedBusinessContext] = useState('')
  const [businessContextSaving, setBusinessContextSaving] = useState(false)
  const [businessContextMessage, setBusinessContextMessage] = useState('')
  const [businessVoiceState, setBusinessVoiceState] = useState<BusinessVoiceState>('idle')
  const businessVoiceRecorderRef = useRef<MediaRecorder | null>(null)
  const businessVoiceChunksRef = useRef<Blob[]>([])
  const businessVoiceStreamRef = useRef<MediaStream | null>(null)
  const lastSettingsScrollTopRef = useRef(0)

  usePhoneElasticScroll()

  const refreshPermission = useCallback(() => {
    if (mobileAppService.isNative()) {
      mobileAppService.getPushPermissionStatus()
        .then((status) => setPermission(mapNativePermission(status)))
        .catch(() => setPermission('unsupported'))
      return
    }

    setPermission(getNotificationPermission())
  }, [])

  useEffect(() => {
    refreshPermission()
    if (typeof window === 'undefined') return undefined
    window.addEventListener('focus', refreshPermission)
    document.addEventListener('visibilitychange', refreshPermission)
    return () => {
      window.removeEventListener('focus', refreshPermission)
      document.removeEventListener('visibilitychange', refreshPermission)
    }
  }, [refreshPermission])

  useEffect(() => {
    setBackButtonCollapsed(false)
    lastSettingsScrollTopRef.current = 0
  }, [activeSection])

  const handleSettingsFrameScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const nextScrollTop = event.currentTarget.scrollTop
    const previousScrollTop = lastSettingsScrollTopRef.current

    if (!activeSection || nextScrollTop <= 8) {
      setBackButtonCollapsed(false)
      lastSettingsScrollTopRef.current = nextScrollTop
      return
    }

    if (nextScrollTop > previousScrollTop + 4) {
      setBackButtonCollapsed(true)
    } else if (nextScrollTop < previousScrollTop - 4) {
      setBackButtonCollapsed(false)
    }

    lastSettingsScrollTopRef.current = nextScrollTop
  }, [activeSection])

  const saveConfigPreference = useCallback(<T,>(setter: (value: T) => Promise<void>, value: T) => {
    setter(value).catch(() => showToast('error', 'No se guardó el ajuste', 'Intenta otra vez.'))
  }, [showToast])

  const stopBusinessVoiceStream = useCallback(() => {
    businessVoiceStreamRef.current?.getTracks().forEach((track) => track.stop())
    businessVoiceStreamRef.current = null
  }, [])

  useEffect(() => () => {
    try {
      if (businessVoiceRecorderRef.current?.state === 'recording') {
        businessVoiceRecorderRef.current.stop()
      }
    } catch {
      // ignore cleanup recorder errors
    }
    stopBusinessVoiceStream()
  }, [stopBusinessVoiceStream])

  const loadAIAgentStatus = useCallback(async () => {
    setAiAgentConfigLoading(true)
    setBusinessContextMessage('')
    try {
      const status = await aiAgentService.getConfig()
      const context = normalizeBusinessContextDraft(status.businessContext)
      setBusinessContextDraft(context)
      setSavedBusinessContext(context)
    } catch (error: any) {
      showToast('error', 'No se cargó el agente', error?.message || 'Intenta otra vez.')
    } finally {
      setAiAgentConfigLoading(false)
    }
  }, [showToast])

  const loadCalendars = useCallback(async () => {
    setCalendarsLoading(true)
    try {
      const items = await calendarsService.getCalendars(locationId, accessToken)
      const available = Array.isArray(items) ? items.filter((calendar) => calendar.isActive !== false) : []
      const preferred = defaultCalendarId
        ? available.find((calendar) => calendar.id === defaultCalendarId)
        : null
      setCalendars(preferred
        ? [preferred, ...available.filter((calendar) => calendar.id !== preferred.id)]
        : available)
    } catch {
      setCalendars([])
    } finally {
      setCalendarsLoading(false)
    }
  }, [accessToken, defaultCalendarId, locationId])

  const loadTemplates = useCallback(async () => {
    setTemplatesError('')
    setTemplatesLoading(true)
    try {
      const [status, response] = await Promise.all([
        whatsappApiService.getStatus().catch(() => null),
        whatsappApiService.getTemplates()
      ])
      const statusItems = status?.templates?.items || []
      const responseItems = Array.isArray(response.items) ? response.items : []
      setTemplates(responseItems.length ? responseItems : statusItems)
    } catch (error: any) {
      setTemplates([])
      setTemplatesError(error?.message || 'No se pudieron cargar las plantillas.')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  const loadCustomFieldDefinitions = useCallback(async () => {
    setCustomFieldsError('')
    setCustomFieldsLoading(true)
    try {
      const catalog = await customFieldsService.listCatalog()
      setCustomFieldDefinitions((catalog.fields || []).filter((definition) => !definition.archived && !isSystemCustomFieldDefinition(definition)))
    } catch (error: any) {
      setCustomFieldDefinitions([])
      setCustomFieldsError(error?.message || 'No se pudieron cargar los campos personalizados.')
    } finally {
      setCustomFieldsLoading(false)
    }
  }, [])

  const loadSettingsTags = useCallback(async () => {
    try { setSettingsTags(await contactTagsService.getTags({ includeSystem: false, forceRefresh: true })) }
    catch { setSettingsTags([]) }
  }, [])

  useEffect(() => {
    loadCalendars()
  }, [loadCalendars])

  useEffect(() => {
    if (activeSection === 'templates') loadTemplates()
  }, [activeSection, loadTemplates])

  useEffect(() => {
    if (activeSection === 'custom-fields') loadCustomFieldDefinitions()
    if (activeSection === 'tags') loadSettingsTags()
  }, [activeSection, loadCustomFieldDefinitions, loadSettingsTags])

  useEffect(() => {
    if (activeSection === 'agent') {
      void loadAIAgentStatus()
    }
  }, [activeSection, loadAIAgentStatus])

  const selectedCalendarCount = pushCalendarIds.length || calendars.length
  const permissionLabel = getNotificationPermissionLabel(permission)
  const showPhoneActivation = shouldShowPhoneActivation(permission)
  const blockedTemplates = templates.filter((template) => TEMPLATE_BLOCKED_STATUSES.has(getTemplateStatus(template))).length
  const togglePushCalendar = (calendarId: string) => {
    const next = pushCalendarIds.includes(calendarId)
      ? pushCalendarIds.filter((id) => id !== calendarId)
      : [...pushCalendarIds, calendarId]
    saveConfigPreference(setPushCalendarIds, next)
  }

  const handleCalendarPushToggle = (enabled: boolean) => {
    saveConfigPreference(setCalendarPushEnabled, enabled)
    if (enabled && calendars.length === 1 && pushCalendarIds.length === 0) {
      saveConfigPreference(setPushCalendarIds, [calendars[0].id])
    }
  }

  const handleRequestPush = async () => {
    setRequestingPush(true)
    try {
      const calendarIds = calendarPushEnabled
        ? pushCalendarIds.length ? pushCalendarIds : calendars.map((calendar) => calendar.id)
        : []
      const result = await pushNotificationsService.subscribeToAppNotifications({ calendarIds })

      if (result.status === 'subscribed') {
        refreshPermission()
        showToast('success', 'Alertas activadas', 'Este celular ya puede recibir notificaciones de Ristak.')
        return
      }

      showToast(
        result.status === 'denied' ? 'warning' : 'info',
        result.status === 'not_configured' ? 'Falta preparar alertas' : 'No se activaron',
        result.reason
      )
    } catch (error: any) {
      showToast('error', 'No se activaron las alertas', error?.message || 'Intenta otra vez.')
    } finally {
      setRequestingPush(false)
    }
  }

  const saveRefinedBusinessContext = useCallback(async (answer: string, successMessage: string) => {
    if (!aiAvailability.configured) {
      const message = aiAvailability.needsReconnect
        ? 'Reconecta OpenAI para pulir la descripción.'
        : 'Conecta OpenAI para pulir la descripción.'
      setBusinessContextMessage(message)
      showToast('warning', 'OpenAI no está listo', message)
      return false
    }

    const cleanAnswer = answer.trim()

    if (!cleanAnswer) {
      showToast('warning', 'Falta la descripción', 'Dicta o escribe lo que hace tu negocio primero.')
      return false
    }

    setBusinessContextSaving(true)
    setBusinessContextMessage('Puliendo y guardando...')

    try {
      const result = await aiAgentService.saveBusinessContextAnswer('businessContext', cleanAnswer)
      const nextText = (result.text || result.status?.businessContext || cleanAnswer).trim()
      setBusinessContextDraft(nextText)
      setSavedBusinessContext(nextText)
      setBusinessContextMessage('Guardado.')
      showToast('success', 'Descripción guardada', successMessage)
      return true
    } catch (error: any) {
      const message = error?.message || 'No se pudo guardar la descripción.'
      setBusinessContextMessage(message)
      showToast('error', 'No se guardó la descripción', message)
      return false
    } finally {
      setBusinessContextSaving(false)
    }
  }, [aiAvailability.configured, aiAvailability.needsReconnect, showToast])

  const completeBusinessVoiceDictation = useCallback(async (audioBlob: Blob) => {
    if (!audioBlob.size) {
      setBusinessContextMessage('No se grabó audio. Intenta otra vez.')
      setBusinessVoiceState('idle')
      return
    }

    setBusinessVoiceState('processing')
    setBusinessContextMessage('Transcribiendo audio...')

    try {
      const transcription = await aiAgentService.transcribeVoice(audioBlob)
      const transcript = transcription.text.trim()

      if (!transcript) {
        throw new Error('No se detectó texto en el audio.')
      }

      await saveRefinedBusinessContext(transcript, 'Tu dictado quedó pulido y guardado.')
    } catch (error: any) {
      const message = error?.message || 'No pude transcribir el audio.'
      setBusinessContextMessage(message)
      showToast('error', 'No se pudo usar el dictado', message)
    } finally {
      setBusinessVoiceState('idle')
    }
  }, [saveRefinedBusinessContext, showToast])

  const startBusinessVoiceDictation = async () => {
    if (businessVoiceState !== 'idle' || businessContextSaving || aiAgentConfigLoading) return

    if (!aiAvailability.configured) {
      const message = aiAvailability.needsReconnect
        ? 'Reconecta OpenAI para dictar la descripción.'
        : 'Conecta OpenAI para dictar y pulir la descripción.'
      setBusinessContextMessage(message)
      showToast('warning', 'OpenAI no está listo', message)
      return
    }

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      const message = 'Este celular no permite grabar audio desde aquí.'
      setBusinessContextMessage(message)
      showToast('warning', 'Micrófono no disponible', message)
      return
    }

    try {
      businessVoiceChunksRef.current = []
      setBusinessContextMessage('')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = getBusinessVoiceMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      businessVoiceStreamRef.current = stream

      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          businessVoiceChunksRef.current.push(event.data)
        }
      }

      recorder.onerror = () => {
        setBusinessContextMessage('No pude grabar el audio del micrófono.')
      }

      recorder.onstop = () => {
        const chunks = businessVoiceChunksRef.current
        const audioType = recorder.mimeType || mimeType || chunks[0]?.type || 'audio/webm'
        const audioBlob = new Blob(chunks, { type: audioType })
        businessVoiceRecorderRef.current = null
        businessVoiceChunksRef.current = []
        stopBusinessVoiceStream()
        void completeBusinessVoiceDictation(audioBlob)
      }

      businessVoiceRecorderRef.current = recorder
      recorder.start()
      setBusinessVoiceState('recording')
      setBusinessContextMessage('Grabando... toca detener cuando termines.')
    } catch (error: any) {
      businessVoiceRecorderRef.current = null
      businessVoiceChunksRef.current = []
      stopBusinessVoiceStream()
      const message = error?.message || 'No pude activar el micrófono.'
      setBusinessVoiceState('idle')
      setBusinessContextMessage(message)
      showToast('error', 'Micrófono bloqueado', message)
    }
  }

  const stopBusinessVoiceDictation = () => {
    if (businessVoiceState !== 'recording') return

    setBusinessContextMessage('Preparando audio...')
    setBusinessVoiceState('processing')

    try {
      if (businessVoiceRecorderRef.current?.state === 'recording') {
        businessVoiceRecorderRef.current.stop()
        return
      }
    } catch {
      // fallback below
    }

    const audioBlob = new Blob(businessVoiceChunksRef.current, {
      type: businessVoiceRecorderRef.current?.mimeType || 'audio/webm'
    })
    businessVoiceRecorderRef.current = null
    businessVoiceChunksRef.current = []
    stopBusinessVoiceStream()
    void completeBusinessVoiceDictation(audioBlob)
  }

  const handleBusinessVoiceButton = () => {
    if (businessVoiceState === 'recording') {
      stopBusinessVoiceDictation()
      return
    }

    void startBusinessVoiceDictation()
  }

  const handleSaveBusinessContext = () => {
    void saveRefinedBusinessContext(businessContextDraft, 'La descripción quedó pulida y guardada.')
  }

  const renderToggle = (
    title: string,
    description: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    disabled = false
  ) => (
    <label className={`${styles.toggleRow} ${disabled ? styles.toggleRowDisabled : ''}`}>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className={`${styles.toggleControl} ${checked ? styles.toggleControlChecked : ''}`} aria-hidden="true">
        {checked && <Check size={18} strokeWidth={3} />}
      </span>
      <input
        className={styles.toggleInput}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  )

  const handleLogout = () => {
    showConfirm(
      'Cerrar sesión',
      '¿Seguro que quieres cerrar tu sesión en este dispositivo?',
      () => {
        logout()
        if (isNativeAppRuntime()) {
          // App nativa: vuelve al login único (correo + contraseña).
          clearRuntimeApiBaseUrl()
          window.location.replace(PHONE_APP_TENANT_PATH)
        } else {
          // Web: el login de este backend funciona en el mismo origen.
          window.location.replace(PHONE_APP_LOGIN_PATH)
        }
      },
      'Cerrar sesión',
      'Cancelar'
    )
  }

  const renderMainList = () => {
    const items: Array<{
      id: Exclude<SettingsSection, null>
      title: string
      mobileTitle?: string
      description: string
      meta?: string
      Icon: LucideIcon
      tone: 'green' | 'black' | 'blue' | 'gold' | 'red'
    }> = [
      { id: 'templates', title: 'Plantillas', description: 'Crear y revisar estados de Meta.', meta: templates.length ? `${templates.length} guardadas` : 'Revisar', Icon: FileText, tone: 'black' },
      { id: 'agent', title: PERSONAL_ASSISTANT_AI_LABEL, mobileTitle: PERSONAL_ASSISTANT_AI_LABEL, description: 'Chat fijo y sugerencias.', meta: aiAvailability.configured ? aiAgentChatEnabled ? 'Activo' : 'Apagado' : 'Sin OpenAI', Icon: Bot, tone: 'blue' },
      { id: 'chats', title: 'Lista de chats', mobileTitle: 'Lista de chat', description: 'Orden, archivados y vista previa.', meta: conversationSortMode === 'recent' ? 'Recientes' : 'No leídas', Icon: MessageCircle, tone: 'green' },
      { id: 'custom-fields', title: 'Campos personalizados', description: 'Datos visibles en cada contacto.', meta: 'Todos', Icon: ListChecks, tone: 'gold' },
      { id: 'tags', title: 'Etiquetas', description: 'Crea y elimina etiquetas del CRM.', meta: settingsTags.length ? `${settingsTags.length}` : 'Crear', Icon: Tag, tone: 'gold' },
      { id: 'appearance', title: 'Apariencia', description: 'El chat sigue el tema de tu app.', meta: resolvedThemeLabel, Icon: Sun, tone: 'blue' },
      { id: 'privacy', title: 'Privacidad', description: 'Controla vistos de WhatsApp, Messenger e Instagram.', meta: sendReadReceipts ? 'Vistos activos' : 'Vistos apagados', Icon: CheckCheck, tone: 'blue' },
      { id: 'notifications', title: 'Notificaciones', description: 'Mensajes, citas, sonido y vibración.', meta: permissionLabel, Icon: Bell, tone: 'red' }
    ]

    return (
      <>
        <div className={styles.settingsListGroup}>
        {items.map(({ id, title, mobileTitle, description, meta, Icon, tone }) => (
          <button key={id} type="button" className={styles.settingsListItem} onClick={() => setActiveSection(id)}>
            <span className={`${styles.settingsListIcon} ${styles[`settingsListIcon_${tone}`]}`}><Icon size={18} /></span>
            <span className={styles.settingsListText}>
              <strong>
                <span className={styles.desktopTitle}>{title}</span>
                <span className={styles.mobileTitle}>{mobileTitle || title}</span>
              </strong>
              <small>{description}</small>
            </span>
            <span className={styles.settingsListMeta}>
              {meta && <small>{meta}</small>}
              <ChevronRight size={18} />
            </span>
          </button>
        ))}
        </div>
        <button type="button" className={styles.logoutButton} onClick={handleLogout}>
          <LogOut size={18} />
          <span>Cerrar sesión</span>
        </button>
      </>
    )
  }

  const renderTemplates = () => (
    <>
      <section className={styles.actionCard}>
        <span><FileText size={18} /></span>
        <div>
          <strong>Plantillas de WhatsApp</strong>
          <small>{blockedTemplates ? `${blockedTemplates} necesitan revisión.` : 'Revisa estados y aprobaciones de Meta.'}</small>
        </div>
        <button type="button" onClick={loadTemplates} disabled={templatesLoading}>
          {templatesLoading ? <Loader2 size={16} className={styles.spinIcon} /> : <RefreshCw size={16} />}
          Actualizar
        </button>
      </section>
      {templatesError && (
        <div className={styles.alertBox}>
          <CircleAlert size={18} />
          <span>{templatesError}</span>
        </div>
      )}
      <div className={styles.templateList}>
        {templatesLoading ? (
          <div className={styles.loadingInline} role="status" aria-live="polite" aria-label="Cargando plantillas">
            <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
          </div>
        ) : templates.length ? templates.map((template) => {
          const status = getTemplateStatus(template)
          const blocked = TEMPLATE_BLOCKED_STATUSES.has(status)
          return (
            <div key={`${template.id}-${template.language}`} className={styles.templateRow}>
              <span className={styles.templateIcon}><FileText size={17} /></span>
              <span className={styles.templateMain}>
                <strong>{template.name}</strong>
                <small>{getTemplatePreview(template)}</small>
                {blocked && <em>{template.reason || template.status_update_event || 'Meta no permite usar esta plantilla por ahora.'}</em>}
              </span>
              <span className={`${styles.templateStatus} ${blocked ? styles.templateBlocked : status === 'APPROVED' ? styles.templateApproved : styles.templatePending}`}>
                {getTemplateStatusLabel(status)}
              </span>
            </div>
          )
        }) : (
          <div className={styles.emptyState}>Todavía no hay plantillas guardadas.</div>
        )}
      </div>
    </>
  )

  const renderAgent = () => {
    const aiReady = aiAvailability.configured
    const descriptionChanged = businessContextDraft.trim() !== savedBusinessContext.trim()
    const busyDescription = aiAgentConfigLoading || businessContextSaving || businessVoiceState === 'processing'
    const recording = businessVoiceState === 'recording'
    const micLabel = recording
      ? 'Detener'
      : businessVoiceState === 'processing'
        ? 'Procesando'
        : 'Dictar'

    return (
      <>
        <section className={styles.businessDescriptionPanel}>
          {!aiReady && (
            <div className={styles.emptyState}>
              {aiAvailability.needsReconnect
                ? 'Reconecta OpenAI para activar el agente en este celular.'
                : 'Conecta OpenAI para activar el agente en este celular.'}
            </div>
          )}
          <div className={styles.businessDescriptionHeader}>
            <span><Sparkles size={18} /></span>
            <div>
              <strong>Descripción del negocio</strong>
              <small>Dicta tu giro, servicios y {customersLowerLabel}; la IA lo pule y lo guarda aquí.</small>
            </div>
          </div>

          <div className={styles.businessDescriptionField}>
            <textarea
              value={businessContextDraft}
              placeholder="Ejemplo: Somos una clínica dental en Ciudad Juárez, atendemos familias, vendemos tratamientos de ortodoncia y queremos responder con tono cercano..."
              aria-label={`Descripción del negocio para ${PERSONAL_ASSISTANT_AI_LABEL}`}
              disabled={busyDescription || recording}
              onChange={(event) => {
                setBusinessContextDraft(event.target.value)
                setBusinessContextMessage('')
              }}
              rows={8}
            />
            <button
              type="button"
              className={`${styles.businessVoiceButton} ${recording ? styles.businessVoiceButtonRecording : ''}`}
              onClick={handleBusinessVoiceButton}
              disabled={!aiReady || businessContextSaving || aiAgentConfigLoading || businessVoiceState === 'processing'}
              aria-label={recording ? 'Detener dictado de descripción del negocio' : 'Dictar descripción del negocio'}
            >
              {businessVoiceState === 'processing'
                ? <Loader2 size={18} className={styles.spinIcon} />
                : recording
                  ? <Square size={16} fill="currentColor" />
                  : <Mic size={18} />}
              <span>{micLabel}</span>
            </button>
          </div>

          <div className={styles.businessDescriptionActions}>
            <small>
              {aiAgentConfigLoading
                ? ''
                : businessContextMessage || (aiReady ? 'El dictado se guarda automático al terminar.' : 'OpenAI debe estar conectado para dictar y pulir.')}
            </small>
            <button
              type="button"
              onClick={handleSaveBusinessContext}
              disabled={!aiReady || busyDescription || recording || !descriptionChanged || !businessContextDraft.trim()}
            >
              {businessContextSaving ? <Loader2 size={16} className={styles.spinIcon} /> : <Save size={16} />}
              Guardar
            </button>
          </div>
        </section>

        {renderToggle('Mostrar como primer chat', 'El agente aparece fijo arriba de tus conversaciones.', aiReady && aiAgentChatEnabled, (checked) => saveConfigPreference(setAiAgentChatEnabled, checked), !aiReady)}
        {renderToggle('Sugerir respuestas', 'El agente puede preparar un texto para responder en chats reales.', aiReady && aiReplySuggestionsEnabled, (checked) => saveConfigPreference(setAiReplySuggestionsEnabled, checked), !aiReady || !aiAgentChatEnabled)}
      </>
    )
  }

  const renderChats = () => (
    <>
      <section className={styles.settingsSection}>
        <strong className={styles.fieldTitle}>Ordenar conversaciones</strong>
        <div className={styles.segmented} role="group" aria-label="Orden de conversaciones">
          <button type="button" className={conversationSortMode === 'recent' ? styles.segmentActive : ''} onClick={() => saveConfigPreference(setConversationSortMode, 'recent')}>
            Más recientes
          </button>
          <button type="button" className={conversationSortMode === 'unread' ? styles.segmentActive : ''} onClick={() => saveConfigPreference(setConversationSortMode, 'unread')}>
            No leídas
          </button>
        </div>
      </section>
      {renderToggle('Mostrar archivados', 'Deja visible el acceso a chats archivados.', showArchivedChats, (checked) => saveConfigPreference(setShowArchivedChats, checked))}
      {renderToggle('Vista previa', 'Muestra un resumen debajo del nombre del contacto.', showLastMessagePreview, (checked) => saveConfigPreference(setShowLastMessagePreview, checked))}
      {renderToggle('Indicadores de no leídos', 'Muestra el contador verde cuando hay mensajes nuevos.', showUnreadIndicators, (checked) => saveConfigPreference(setShowUnreadIndicators, checked))}
    </>
  )

  const renderCustomFields = () => (
    <>
      <section className={styles.catalogCreateSection}>
        <strong>Crear campo personalizado</strong>
        <input value={newCustomFieldName} onChange={(event) => setNewCustomFieldName(event.target.value)} placeholder="Ej. Historia clínica" />
        <button type="button" disabled={!newCustomFieldName.trim() || catalogBusyId === 'new-field'} onClick={async () => {
          const name = newCustomFieldName.trim(); if (!name) return
          setCatalogBusyId('new-field')
          try {
            await customFieldsService.createField({ label: name, dataType: 'text' })
            setNewCustomFieldName('')
            await loadCustomFieldDefinitions()
          } catch (error: any) { showToast('error', 'No se creó el campo', error?.message || 'Intenta otra vez.') }
          finally { setCatalogBusyId(null) }
        }}>{catalogBusyId === 'new-field' ? <Loader2 size={16} className={styles.spinIcon} /> : <Plus size={16} />} Crear</button>
      </section>
      {customFieldsError && (
        <div className={styles.alertBox}>
          <CircleAlert size={18} />
          <span>{customFieldsError}</span>
        </div>
      )}

      {customFieldsLoading ? (
        <div className={styles.loadingInline} role="status" aria-live="polite" aria-label="Cargando campos">
          <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
        </div>
      ) : customFieldDefinitions.length ? (
        <section className={styles.settingsSection}>
          <strong className={styles.fieldTitle}>Todos aparecen en la info del contacto</strong>
          <small>El chat móvil muestra el catálogo completo, agrupado por carpeta, y cada campo se edita desde la ficha del contacto.</small>
          <div className={styles.customFieldsList}>
            {customFieldDefinitions.map((definition, index) => (
              <div key={definition.definitionId || definition.fieldKey || definition.key || index} className={styles.customFieldSummaryRow}>
                <span>
                  <strong>{definition.label || definition.name || `Campo ${index + 1}`}</strong>
                  <small>{definition.folderName || 'Campos personalizados'} · {definition.dataType || 'text'}</small>
                </span>
                {definition.deletable !== false && (
                  <button type="button" className={styles.catalogDeleteButton} disabled={Boolean(catalogBusyId)} onClick={() => showConfirm(
                    'Eliminar campo',
                    `Se borrará “${definition.label || definition.name}” y sus datos guardados en todos los contactos.`,
                    async () => {
                      setCatalogBusyId(definition.definitionId || '')
                      try { await customFieldsService.deleteField(definition.definitionId || ''); await loadCustomFieldDefinitions() }
                      catch (error: any) { showToast('error', 'No se eliminó el campo', error?.message || 'Intenta otra vez.') }
                      finally { setCatalogBusyId(null) }
                    },
                    'Eliminar',
                    'Cancelar'
                  )}><Trash2 size={17} /></button>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : (
        <div className={styles.emptyState}>Todavía no hay campos personalizados guardados.</div>
      )}
    </>
  )

  const renderTags = () => (
    <>
      <section className={styles.catalogCreateSection}>
        <strong>Crear etiqueta</strong>
        <input value={newTagName} onChange={(event) => setNewTagName(event.target.value)} placeholder="Ej. Seguimiento" />
        <button type="button" disabled={!newTagName.trim() || catalogBusyId === 'new-tag'} onClick={async () => {
          const name = newTagName.trim(); if (!name) return
          setCatalogBusyId('new-tag')
          try { await contactTagsService.createTag(name); setNewTagName(''); await loadSettingsTags() }
          catch (error: any) { showToast('error', 'No se creó la etiqueta', error?.message || 'Intenta otra vez.') }
          finally { setCatalogBusyId(null) }
        }}>{catalogBusyId === 'new-tag' ? <Loader2 size={16} className={styles.spinIcon} /> : <Plus size={16} />} Crear</button>
      </section>
      <section className={styles.settingsSection}>
        <div className={styles.customFieldsList}>
          {settingsTags.map((tag) => (
            <div key={tag.id} className={styles.customFieldSummaryRow}>
              <span><strong>{tag.name}</strong><small>Etiqueta del CRM</small></span>
              <button type="button" className={styles.catalogDeleteButton} disabled={Boolean(catalogBusyId)} onClick={() => showConfirm(
                'Eliminar etiqueta',
                `Se quitará “${tag.name}” de todos los contactos.`,
                async () => {
                  setCatalogBusyId(tag.id)
                  try { await contactTagsService.deleteTag(tag.id); await loadSettingsTags() }
                  catch (error: any) { showToast('error', 'No se eliminó la etiqueta', error?.message || 'Intenta otra vez.') }
                  finally { setCatalogBusyId(null) }
                },
                'Eliminar',
                'Cancelar'
              )}><Trash2 size={17} /></button>
            </div>
          ))}
          {!settingsTags.length && <div className={styles.emptyState}>Todavía no hay etiquetas creadas.</div>}
        </div>
      </section>
    </>
  )

  const renderAppearance = () => (
    <section className={styles.settingsSection}>
      <div className={styles.sectionTitle}>
        <Sun size={18} />
        <span>
          <strong>Color del chat</strong>
          <small>El chat usa el mismo tema que tu app.</small>
        </span>
      </div>
      <p className={styles.hint}>
        Los colores y el modo claro/oscuro del chat siguen el tema que elijas en tu app
        (familia y claro/noche). Cámbialo desde “Diseño de app” en el menú de tu cuenta y el
        chat se actualiza solo. Ahorita se ve en modo {resolvedThemeLabel.toLowerCase()}.
      </p>
    </section>
  )

  const renderPrivacy = () => (
    <section className={styles.settingsSection}>
      <div className={styles.sectionTitle}>
        <CheckCheck size={18} />
        <span>
          <strong>Vistos de chat</strong>
          <small>Decide si Ristak le avisa al proveedor cuando ya viste un mensaje.</small>
        </span>
      </div>
      {renderToggle(
        'Marcar mensajes como leídos o vistos',
        'Envía el visto real al abrir o marcar leído un chat.',
        sendReadReceipts,
        (checked) => saveConfigPreference(setSendReadReceipts, checked)
      )}
      <p className={styles.hint}>
        Si lo apagas, Ristak limpia los no leídos dentro de la app, pero no manda doble check,
        mark seen ni acuse externo a WhatsApp API, WhatsApp QR, Messenger o Instagram.
      </p>
    </section>
  )

  const renderNotifications = () => (
    <>
      {showPhoneActivation && (
        <section className={styles.permissionCard}>
          <span><Smartphone size={18} /></span>
          <div>
            <strong>Este celular</strong>
            <small>{permissionLabel}</small>
          </div>
          <button type="button" onClick={handleRequestPush} disabled={requestingPush}>
            {requestingPush ? <Loader2 size={16} className={styles.spinIcon} /> : <BellRing size={16} />}
            Activar
          </button>
        </section>
      )}
      {!showPhoneActivation && (
        <section className={styles.enabledCard}>
          <Check size={18} />
          <span>Este celular ya tiene permiso para recibir notificaciones.</span>
        </section>
      )}
      {renderToggle('Mensajes del chat', 'Avísame cuando llegue un WhatsApp nuevo.', chatPushEnabled, (checked) => saveConfigPreference(setChatPushEnabled, checked))}
      {renderToggle('Citas agendadas', 'Avísame cuando alguien reserve una cita nueva.', calendarPushEnabled, handleCalendarPushToggle)}
      {calendarPushEnabled && (
        <section className={styles.calendarPicker}>
          <div className={styles.calendarPickerHeader}>
            <strong>Calendarios con alertas</strong>
            <span>{pushCalendarIds.length ? `${selectedCalendarCount} seleccionados` : 'Todos'}</span>
          </div>
          <button type="button" className={`${styles.allCalendarsButton} ${pushCalendarIds.length === 0 ? styles.calendarActive : ''}`} onClick={() => saveConfigPreference(setPushCalendarIds, [])}>
            Todos los calendarios
          </button>
          {calendarsLoading ? (
            <div className={styles.loadingInline} role="status" aria-live="polite" aria-label="Cargando calendarios">
              <Loader2 size={17} className={styles.spinIcon} aria-hidden="true" />
            </div>
          ) : calendars.length ? (
            <div className={styles.calendarGrid}>
              {calendars.map((calendar) => {
                const active = pushCalendarIds.includes(calendar.id)
                return (
                  <button key={calendar.id} type="button" className={`${styles.calendarChip} ${active ? styles.calendarActive : ''}`} onClick={() => togglePushCalendar(calendar.id)}>
                    <span style={{ backgroundColor: calendar.eventColor || '#0078f8' }} />
                    {calendar.name}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className={styles.hint}>No hay calendarios activos para elegir.</p>
          )}
        </section>
      )}
      {renderToggle('Citas confirmadas', `Avísame cuando un ${customerLowerLabel} confirme que sí asistirá.`, appointmentConfirmationPushEnabled, (checked) => saveConfigPreference(setAppointmentConfirmationPushEnabled, checked))}
      {renderToggle('Pagos', 'Avísame cuando se registre un pago.', paymentPushEnabled, (checked) => saveConfigPreference(setPaymentPushEnabled, checked))}
      <section className={styles.settingsSection}>
        <div className={styles.sectionTitle}>
          <BellRing size={18} />
          <span>
            <strong>Sonido y vibración</strong>
            <small>Controla cómo se sienten las alertas en este celular.</small>
          </span>
        </div>
        {renderToggle('Timbre de notificación', 'Hace sonar el celular cuando llegue una alerta.', notificationSoundEnabled, (checked) => saveConfigPreference(setNotificationSoundEnabled, checked))}
        {renderToggle('Vibración de notificación', 'Vibra cuando entren mensajes, citas, confirmaciones o pagos.', notificationVibrationEnabled, (checked) => saveConfigPreference(setNotificationVibrationEnabled, checked))}
      </section>
    </>
  )

  const sectionTitle = useMemo(() => {
    if (activeSection === 'templates') return 'Plantillas'
    if (activeSection === 'agent') return PERSONAL_ASSISTANT_AI_LABEL
    if (activeSection === 'chats') return 'Lista de chats'
    if (activeSection === 'custom-fields') return 'Campos personalizados'
    if (activeSection === 'tags') return 'Etiquetas'
    if (activeSection === 'appearance') return 'Apariencia'
    if (activeSection === 'privacy') return 'Privacidad'
    if (activeSection === 'notifications') return 'Notificaciones'
    return 'Ajustes'
  }, [activeSection])

  const mobileSectionTitle = useMemo(() => {
    if (activeSection === 'agent') return PERSONAL_ASSISTANT_AI_LABEL
    if (activeSection === 'chats') return 'Lista de chat'
    return sectionTitle
  }, [activeSection, sectionTitle])

  const renderSection = () => {
    if (activeSection === 'templates') return renderTemplates()
    if (activeSection === 'agent') return renderAgent()
    if (activeSection === 'chats') return renderChats()
    if (activeSection === 'custom-fields') return renderCustomFields()
    if (activeSection === 'tags') return renderTags()
    if (activeSection === 'appearance') return renderAppearance()
    if (activeSection === 'privacy') return renderPrivacy()
    if (activeSection === 'notifications') return renderNotifications()
    return renderMainList()
  }

  return (
    <main className={styles.phoneSettingsPage} aria-label="Ajustes móviles de Ristak">
      <PhonePageTransition
        active="settings"
        className={styles.phoneFrame}
        data-phone-elastic-scroll="true"
        onScroll={handleSettingsFrameScroll}
      >
        <div className={styles.elasticContent} data-phone-elastic-target="true">
          {activeSection && (
            <div className={`${styles.backDock} ${backButtonCollapsed ? styles.backDockCollapsed : ''}`}>
              <button type="button" className={styles.backButton} onClick={() => setActiveSection(null)} aria-label="Volver a ajustes">
                <ChevronLeft size={22} />
                <span>Ajustes</span>
              </button>
            </div>
          )}
          <header className={styles.header}>
            <p>Ristak</p>
            <h1>
              <span className={styles.desktopTitle}>{activeSection ? sectionTitle : 'Ajustes'}</span>
              <span className={styles.mobileTitle}>{activeSection ? mobileSectionTitle : 'Ajustes'}</span>
            </h1>
            {activeSection === 'custom-fields' && (
              <span className={styles.headerSubtitle}>Elige qué datos quieres ver en la info de cada contacto.</span>
            )}
            {activeSection === 'privacy' && (
              <span className={styles.headerSubtitle}>Ajustes que afectan lo que tus {customersLowerLabel} pueden saber de tu lectura.</span>
            )}
          </header>
          <div className={styles.content} data-phone-scrollable="true">
            {renderSection()}
          </div>
        </div>
      </PhonePageTransition>
      <PhoneEcosystemNav active="settings" />
    </main>
  )
}
