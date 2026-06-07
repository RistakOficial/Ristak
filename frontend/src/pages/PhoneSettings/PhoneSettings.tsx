import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  BellRing,
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock,
  FileText,
  ListChecks,
  Loader2,
  MessageCircle,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
  type LucideIcon
} from 'lucide-react'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhonePageTransition } from '@/components/phone/PhonePageTransition'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig, usePhoneElasticScroll, usePhoneTheme, type PhoneThemePreference } from '@/hooks'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import { contactsService } from '@/services/contactsService'
import { mobileAppService } from '@/services/mobileAppService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { whatsappApiService, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import type { ContactCustomFieldDefinition } from '@/types'
import { getContactCustomFieldIdentity } from '@/utils/contactCustomFields'
import styles from './PhoneSettings.module.css'

type SettingsSection = 'numbers' | 'templates' | 'agent' | 'chats' | 'custom-fields' | 'appearance' | 'notifications' | null
type WhatsAppNumberMode = 'merged' | 'separated'
type ConversationSortMode = 'recent' | 'unread'
type PhoneNotificationPermission = NotificationPermission | 'native_granted' | 'native_denied' | 'native_prompt' | 'unsupported' | 'checking'

const PHONE_CHAT_THEME_OPTIONS: Array<{
  id: PhoneThemePreference
  label: string
  description: string
  Icon: LucideIcon
}> = [
  { id: 'system', label: 'Sistema', description: 'Usa el modo que tiene tu celular.', Icon: Smartphone },
  { id: 'light', label: 'Claro', description: 'Mantiene la app con fondo claro.', Icon: Sun },
  { id: 'dark', label: 'Noche', description: 'Mantiene la app oscura todo el tiempo.', Icon: Moon },
  { id: 'auto', label: 'Horario', description: 'Claro de día y noche después de las 7 PM.', Icon: Clock }
]

const TEMPLATE_BLOCKED_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED'])

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
  const { locationId, accessToken } = useAuth()
  const { showToast } = useNotification()
  const [defaultCalendarId] = useAppConfig<string>('default_calendar_id', '')
  const [whatsappNumberMode, setWhatsappNumberMode] = useAppConfig<WhatsAppNumberMode>('mobile_chat_whatsapp_number_mode', 'merged')
  const [aiAgentChatEnabled, setAiAgentChatEnabled] = useAppConfig<boolean>('mobile_chat_ai_agent_enabled', true)
  const [aiReplySuggestionsEnabled, setAiReplySuggestionsEnabled] = useAppConfig<boolean>('mobile_chat_ai_reply_suggestions_enabled', false)
  const [showArchivedChats, setShowArchivedChats] = useAppConfig<boolean>('mobile_chat_show_archived', true)
  const [conversationSortMode, setConversationSortMode] = useAppConfig<ConversationSortMode>('mobile_chat_sort_mode', 'recent')
  const [showLastMessagePreview, setShowLastMessagePreview] = useAppConfig<boolean>('mobile_chat_show_last_preview', true)
  const [showUnreadIndicators, setShowUnreadIndicators] = useAppConfig<boolean>('mobile_chat_show_unread_indicators', true)
  const [enabledContactInfoCustomFieldIds, setEnabledContactInfoCustomFieldIds] = useAppConfig<string[]>('mobile_chat_contact_info_custom_field_ids', [])
  const [calendarPushEnabled, setCalendarPushEnabled] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [chatPushEnabled, setChatPushEnabled] = useAppConfig<boolean>('chat_push_notifications_enabled', true)
  const [paymentPushEnabled, setPaymentPushEnabled] = useAppConfig<boolean>('payment_push_notifications_enabled', true)
  const [pushCalendarIds, setPushCalendarIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])
  const {
    safePreference,
    setPreference: setChatThemePreference,
    resolvedThemeLabel,
    themeMeta,
    systemThemeAvailable,
    deviceLabel
  } = usePhoneTheme({ active: false })

  const [activeSection, setActiveSection] = useState<SettingsSection>(null)
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [calendarsLoading, setCalendarsLoading] = useState(false)
  const [templates, setTemplates] = useState<WhatsAppApiTemplate[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [templatesError, setTemplatesError] = useState('')
  const [customFieldDefinitions, setCustomFieldDefinitions] = useState<ContactCustomFieldDefinition[]>([])
  const [customFieldsLoading, setCustomFieldsLoading] = useState(false)
  const [customFieldsError, setCustomFieldsError] = useState('')
  const [requestingPush, setRequestingPush] = useState(false)
  const [permission, setPermission] = useState(getNotificationPermission)
  const [backButtonCollapsed, setBackButtonCollapsed] = useState(false)
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
      const definitions = await contactsService.getCustomFieldDefinitions()
      setCustomFieldDefinitions(Array.isArray(definitions) ? definitions.filter((definition) => !definition.archived) : [])
    } catch (error: any) {
      setCustomFieldDefinitions([])
      setCustomFieldsError(error?.message || 'No se pudieron cargar los campos personalizados.')
    } finally {
      setCustomFieldsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadCalendars()
  }, [loadCalendars])

  useEffect(() => {
    if (activeSection === 'templates') loadTemplates()
  }, [activeSection, loadTemplates])

  useEffect(() => {
    if (activeSection === 'custom-fields') loadCustomFieldDefinitions()
  }, [activeSection, loadCustomFieldDefinitions])

  const selectedCalendarCount = pushCalendarIds.length || calendars.length
  const permissionLabel = getNotificationPermissionLabel(permission)
  const showPhoneActivation = shouldShowPhoneActivation(permission)
  const blockedTemplates = templates.filter((template) => TEMPLATE_BLOCKED_STATUSES.has(getTemplateStatus(template))).length
  const enabledCustomFieldCount = enabledContactInfoCustomFieldIds.length

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

  const toggleContactInfoCustomField = (fieldId: string) => {
    const next = enabledContactInfoCustomFieldIds.includes(fieldId)
      ? enabledContactInfoCustomFieldIds.filter((id) => id !== fieldId)
      : [...enabledContactInfoCustomFieldIds, fieldId]
    saveConfigPreference(setEnabledContactInfoCustomFieldIds, next)
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
      { id: 'numbers', title: 'Números de WhatsApp', description: 'Cómo se muestran tus líneas.', meta: whatsappNumberMode === 'merged' ? 'Juntos' : 'Separados', Icon: Smartphone, tone: 'green' },
      { id: 'templates', title: 'Plantillas', description: 'Crear y revisar estados de Meta.', meta: templates.length ? `${templates.length} guardadas` : 'Revisar', Icon: FileText, tone: 'black' },
      { id: 'agent', title: 'Agente IA', mobileTitle: 'Agente de inteligencia artificial', description: 'Chat fijo y sugerencias.', meta: aiAgentChatEnabled ? 'Activo' : 'Apagado', Icon: Bot, tone: 'blue' },
      { id: 'chats', title: 'Lista de chats', mobileTitle: 'Lista de chat', description: 'Orden, archivados y vista previa.', meta: conversationSortMode === 'recent' ? 'Recientes' : 'No leídas', Icon: MessageCircle, tone: 'green' },
      { id: 'custom-fields', title: 'Campos personalizados', description: 'Datos visibles en cada contacto.', meta: enabledCustomFieldCount ? `${enabledCustomFieldCount} activo${enabledCustomFieldCount === 1 ? '' : 's'}` : 'Elegir', Icon: ListChecks, tone: 'gold' },
      { id: 'appearance', title: 'Apariencia', description: 'Claro, noche, sistema u horario.', meta: themeMeta, Icon: Sun, tone: 'blue' },
      { id: 'notifications', title: 'Notificaciones', description: 'Mensajes, citas y pagos.', meta: permissionLabel, Icon: Bell, tone: 'red' }
    ]

    return (
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
    )
  }

  const renderNumbers = () => (
    <section className={styles.settingsSection}>
      <div className={styles.sectionTitle}>
        <Smartphone size={18} />
        <span>
          <strong>Vista de conversaciones</strong>
          <small>Elige cómo ver los chats cuando tengas más de un número conectado.</small>
        </span>
      </div>
      <div className={styles.segmented} role="group" aria-label="Modo de números de WhatsApp">
        <button type="button" className={whatsappNumberMode === 'merged' ? styles.segmentActive : ''} onClick={() => saveConfigPreference(setWhatsappNumberMode, 'merged')}>
          Todos juntos
        </button>
        <button type="button" className={whatsappNumberMode === 'separated' ? styles.segmentActive : ''} onClick={() => saveConfigPreference(setWhatsappNumberMode, 'separated')}>
          Separados
        </button>
      </div>
      <p className={styles.hint}>Si eliges separados, en Chats podrás revisar cada número por su cuenta.</p>
    </section>
  )

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
          <div className={styles.loadingInline}>
            <Loader2 size={17} className={styles.spinIcon} />
            Cargando plantillas...
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

  const renderAgent = () => (
    <>
      {renderToggle('Mostrar como primer chat', 'El agente aparece fijo arriba de tus conversaciones.', aiAgentChatEnabled, (checked) => saveConfigPreference(setAiAgentChatEnabled, checked))}
      {renderToggle('Sugerir respuestas', 'El agente puede preparar un texto para responder en chats reales.', aiReplySuggestionsEnabled, (checked) => saveConfigPreference(setAiReplySuggestionsEnabled, checked), !aiAgentChatEnabled)}
    </>
  )

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
      {customFieldsError && (
        <div className={styles.alertBox}>
          <CircleAlert size={18} />
          <span>{customFieldsError}</span>
        </div>
      )}

      {customFieldsLoading ? (
        <div className={styles.loadingInline}>
          <Loader2 size={17} className={styles.spinIcon} />
          Cargando campos...
        </div>
      ) : customFieldDefinitions.length ? (
        <div className={styles.customFieldsList}>
          {customFieldDefinitions.map((definition, index) => {
            const fieldId = getContactCustomFieldIdentity(definition)
            if (!fieldId) return null
            const checked = enabledContactInfoCustomFieldIds.includes(fieldId)
            return (
              <React.Fragment key={fieldId}>
                {renderToggle(
                  definition.label || definition.name || `Campo ${index + 1}`,
                  definition.description || (definition.folderName ? `Carpeta: ${definition.folderName}` : 'Disponible para la info del contacto.'),
                  checked,
                  () => toggleContactInfoCustomField(fieldId)
                )}
              </React.Fragment>
            )
          })}
        </div>
      ) : (
        <div className={styles.emptyState}>Todavía no hay campos personalizados guardados.</div>
      )}
    </>
  )

  const renderAppearance = () => (
    <section className={styles.settingsSection}>
      <div className={styles.sectionTitle}>
        <Sun size={18} />
        <span>
          <strong>Color del chat</strong>
          <small>Elige cómo quieres ver esta app en este celular.</small>
        </span>
      </div>
      <div className={styles.choiceList} role="radiogroup" aria-label="Apariencia del chat">
        {PHONE_CHAT_THEME_OPTIONS.map(({ id, label, description, Icon }) => {
          const selected = safePreference === id
          const optionDescription = id === 'system'
            ? systemThemeAvailable ? `Sigue el modo de ${deviceLabel}.` : 'Si no se puede leer el modo del equipo, usa el horario.'
            : description
          return (
            <button key={id} type="button" className={`${styles.choiceButton} ${selected ? styles.choiceActive : ''}`} role="radio" aria-checked={selected} onClick={() => saveConfigPreference(setChatThemePreference, id)}>
              <span><Icon size={18} /></span>
              <span>
                <strong>{label}</strong>
                <small>{optionDescription}</small>
              </span>
              <i>{selected && <Check size={16} />}</i>
            </button>
          )
        })}
      </div>
      <p className={styles.hint}>Ahorita el chat se ve en modo {resolvedThemeLabel.toLowerCase()}.</p>
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
      {renderToggle('Citas', 'Avísame cuando alguien agende una cita.', calendarPushEnabled, handleCalendarPushToggle)}
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
            <div className={styles.loadingInline}>
              <Loader2 size={17} className={styles.spinIcon} />
              Cargando calendarios...
            </div>
          ) : calendars.length ? (
            <div className={styles.calendarGrid}>
              {calendars.map((calendar) => {
                const active = pushCalendarIds.includes(calendar.id)
                return (
                  <button key={calendar.id} type="button" className={`${styles.calendarChip} ${active ? styles.calendarActive : ''}`} onClick={() => togglePushCalendar(calendar.id)}>
                    <span style={{ backgroundColor: calendar.eventColor || '#25d366' }} />
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
      {renderToggle('Pagos', 'Avísame cuando se registre un pago.', paymentPushEnabled, (checked) => saveConfigPreference(setPaymentPushEnabled, checked))}
    </>
  )

  const sectionTitle = useMemo(() => {
    if (activeSection === 'numbers') return 'Números de WhatsApp'
    if (activeSection === 'templates') return 'Plantillas'
    if (activeSection === 'agent') return 'Agente IA'
    if (activeSection === 'chats') return 'Lista de chats'
    if (activeSection === 'custom-fields') return 'Campos personalizados'
    if (activeSection === 'appearance') return 'Apariencia'
    if (activeSection === 'notifications') return 'Notificaciones'
    return 'Ajustes'
  }, [activeSection])

  const mobileSectionTitle = useMemo(() => {
    if (activeSection === 'agent') return 'Agente de inteligencia artificial'
    if (activeSection === 'chats') return 'Lista de chat'
    return sectionTitle
  }, [activeSection, sectionTitle])

  const renderSection = () => {
    if (activeSection === 'numbers') return renderNumbers()
    if (activeSection === 'templates') return renderTemplates()
    if (activeSection === 'agent') return renderAgent()
    if (activeSection === 'chats') return renderChats()
    if (activeSection === 'custom-fields') return renderCustomFields()
    if (activeSection === 'appearance') return renderAppearance()
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
