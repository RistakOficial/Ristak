import React, { useCallback, useEffect, useMemo, useState } from 'react'
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
import { useAppConfig, usePhoneTheme, type PhoneThemePreference } from '@/hooks'
import { calendarsService, type Calendar } from '@/services/calendarsService'
import { mobileAppService } from '@/services/mobileAppService'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { whatsappApiService, type WhatsAppApiTemplate } from '@/services/whatsappApiService'
import styles from './PhoneSettings.module.css'

type SettingsSection = 'numbers' | 'templates' | 'agent' | 'chats' | 'appearance' | 'notifications' | null
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
  const [requestingPush, setRequestingPush] = useState(false)
  const [permission, setPermission] = useState(getNotificationPermission)

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

  useEffect(() => {
    loadCalendars()
  }, [loadCalendars])

  useEffect(() => {
    if (activeSection === 'templates') loadTemplates()
  }, [activeSection, loadTemplates])

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
      <input
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
      description: string
      meta?: string
      Icon: LucideIcon
    }> = [
      { id: 'numbers', title: 'Números de WhatsApp', description: 'Cómo se muestran tus líneas.', meta: whatsappNumberMode === 'merged' ? 'Juntos' : 'Separados', Icon: Smartphone },
      { id: 'templates', title: 'Plantillas', description: 'Crear y revisar estados de Meta.', meta: templates.length ? `${templates.length} guardadas` : 'Revisar', Icon: FileText },
      { id: 'agent', title: 'Agente IA', description: 'Chat fijo y sugerencias.', meta: aiAgentChatEnabled ? 'Activo' : 'Apagado', Icon: Bot },
      { id: 'chats', title: 'Lista de chats', description: 'Orden, archivados y vista previa.', meta: conversationSortMode === 'recent' ? 'Recientes' : 'No leídas', Icon: MessageCircle },
      { id: 'appearance', title: 'Apariencia', description: 'Claro, noche, sistema u horario.', meta: themeMeta, Icon: Sun },
      { id: 'notifications', title: 'Notificaciones', description: 'Mensajes, citas y pagos.', meta: permissionLabel, Icon: Bell }
    ]

    return (
      <div className={styles.settingsListGroup}>
        {items.map(({ id, title, description, meta, Icon }) => (
          <button key={id} type="button" className={styles.settingsListItem} onClick={() => setActiveSection(id)}>
            <span className={styles.settingsListIcon}><Icon size={18} /></span>
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
    if (activeSection === 'appearance') return 'Apariencia'
    if (activeSection === 'notifications') return 'Notificaciones'
    return 'Ajustes'
  }, [activeSection])

  const renderSection = () => {
    if (activeSection === 'numbers') return renderNumbers()
    if (activeSection === 'templates') return renderTemplates()
    if (activeSection === 'agent') return renderAgent()
    if (activeSection === 'chats') return renderChats()
    if (activeSection === 'appearance') return renderAppearance()
    if (activeSection === 'notifications') return renderNotifications()
    return renderMainList()
  }

  return (
    <main className={styles.phoneSettingsPage} aria-label="Ajustes móviles de Ristak Chat">
      <PhonePageTransition active="settings" className={styles.phoneFrame}>
        <header className={styles.header}>
          <p>Ristak Chat</p>
          <h1>{activeSection ? sectionTitle : 'Ajustes'}</h1>
          {activeSection && (
            <button type="button" className={styles.backButton} onClick={() => setActiveSection(null)} aria-label="Volver a ajustes">
              <ChevronLeft size={22} />
              Ajustes
            </button>
          )}
        </header>
        <div className={styles.content} data-phone-scrollable="true">
          {renderSection()}
        </div>
      </PhonePageTransition>
      <PhoneEcosystemNav active="settings" />
    </main>
  )
}
