import React, { useEffect, useMemo, useState } from 'react'
import { BellRing, CalendarCheck2, CalendarClock, CheckCircle2, CreditCard, MessageCircle, RotateCcw, Save, ShieldCheck, Smartphone, UserRound, UsersRound, Vibrate, Volume2, Workflow } from 'lucide-react'
import { Badge } from '@/components/common/Badge'
import { Button, Card, CustomSelect, Switch } from '@/components/common'
import { useAuth } from '@/contexts/AuthContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useAppConfig } from '@/hooks'
import { pushNotificationsService } from '@/services/pushNotificationsService'
import { type TeamUser, userAccessService } from '@/services/userAccessService'
import styles from './Settings.module.css'

const NOTIFICATION_PREFERENCES_CONFIG_KEY = 'notification_preferences_matrix'
const NOTIFICATION_PREFERENCES_VERSION = 1

type NotificationEventKey = 'conversations' | 'agent_priority' | 'appointment_booked' | 'appointment_confirmed' | 'payments' | 'automation_internal' | 'system'
type NotificationChannel = 'off' | 'app' | 'push' | 'email' | 'whatsapp' | 'app_push' | 'app_email' | 'app_whatsapp' | 'all'
type NotificationRecipientKind = 'all' | 'role' | 'user'

interface NotificationPreferencesConfig {
  version: number
  updatedAt?: string
  rows: Record<string, Partial<Record<NotificationEventKey, NotificationChannel>>>
}

interface NotificationRecipientRow {
  id: string
  label: string
  detail: string
  kind: NotificationRecipientKind
  badge: string
}

const EMPTY_NOTIFICATION_PREFERENCES: NotificationPreferencesConfig = {
  version: NOTIFICATION_PREFERENCES_VERSION,
  rows: {}
}

const NOTIFICATION_EVENTS: Array<{
  key: NotificationEventKey
  label: string
  description: string
  icon: React.ComponentType<{ size?: number }>
}> = [
  {
    key: 'conversations',
    label: 'Conversaciones',
    description: 'Mensajes nuevos y conversaciones entrantes.',
    icon: MessageCircle
  },
  {
    key: 'agent_priority',
    label: 'Atención humana',
    description: 'Cuando el agente pida que entre una persona.',
    icon: BellRing
  },
  {
    key: 'appointment_booked',
    label: 'Cita agendada',
    description: 'Reservas nuevas desde calendario o equipo.',
    icon: CalendarClock
  },
  {
    key: 'appointment_confirmed',
    label: 'Cita confirmada',
    description: 'Clientes que confirman asistencia.',
    icon: CalendarCheck2
  },
  {
    key: 'payments',
    label: 'Pagos',
    description: 'Cobros registrados y pagos completados.',
    icon: CreditCard
  },
  {
    key: 'automation_internal',
    label: 'Automatizaciones',
    description: 'Avisos internos lanzados por flujos.',
    icon: Workflow
  },
  {
    key: 'system',
    label: 'Sistema',
    description: 'Alertas generales de Ristak.',
    icon: BellRing
  }
]

const CHANNEL_OPTIONS: Array<{ value: NotificationChannel; label: string }> = [
  { value: 'off', label: 'Apagado' },
  { value: 'app', label: 'Campanita' },
  { value: 'push', label: 'Push celular' },
  { value: 'email', label: 'Correo' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'app_push', label: 'Campanita + push' },
  { value: 'app_email', label: 'Campanita + correo' },
  { value: 'app_whatsapp', label: 'Campanita + WhatsApp' },
  { value: 'all', label: 'Todo' }
]

const CHANNEL_LABELS = Object.fromEntries(CHANNEL_OPTIONS.map((option) => [option.value, option.label])) as Record<NotificationChannel, string>
const VALID_CHANNELS = new Set<NotificationChannel>(CHANNEL_OPTIONS.map((option) => option.value))
const PUSH_CHANNELS = new Set<NotificationChannel>(['push', 'app_push', 'all'])

const safeJsonParse = <T,>(value: unknown, fallback: T): T => {
  if (!value) return fallback
  if (typeof value === 'object') return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

const normalizeNotificationChannel = (value: unknown, fallback: NotificationChannel): NotificationChannel => {
  const channel = String(value || '').trim() as NotificationChannel
  return VALID_CHANNELS.has(channel) ? channel : fallback
}

const getNotificationPermissionState = () => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unavailable'
  return Notification.permission
}

const getNotificationPermissionLabel = (permission: string) => {
  if (permission === 'granted') return 'Este dispositivo ya recibe push de Ristak.'
  if (permission === 'denied') return 'Este dispositivo bloqueó los push desde el navegador.'
  if (permission === 'unavailable') return 'Este dispositivo no soporta push web.'
  return 'Este dispositivo todavía no tiene permiso de push.'
}

const getUserDisplayName = (member: TeamUser) => (
  member.fullName || [member.firstName, member.lastName].filter(Boolean).join(' ') || member.email || member.username || 'Usuario'
)

const getCurrentUserDisplayName = (user: ReturnType<typeof useAuth>['user']) => (
  user?.name || [user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email || user?.username || 'Mi usuario'
)

const hasPushChannel = (channel?: NotificationChannel) => PUSH_CHANNELS.has(channel || 'off')

const countActiveCells = (preferences: NotificationPreferencesConfig) => (
  Object.values(preferences.rows).reduce((total, row) => (
    total + NOTIFICATION_EVENTS.reduce((rowTotal, event) => rowTotal + (row[event.key] && row[event.key] !== 'off' ? 1 : 0), 0)
  ), 0)
)

const eventHasPush = (preferences: NotificationPreferencesConfig, eventKey: NotificationEventKey) => (
  Object.values(preferences.rows).some((row) => hasPushChannel(row[eventKey]))
)

const getExistingFallbackChannel = (
  eventKey: NotificationEventKey,
  existingRow: Partial<Record<NotificationEventKey | 'appointments', NotificationChannel>>
) => {
  if ((eventKey === 'appointment_booked' || eventKey === 'appointment_confirmed') && existingRow.appointments) {
    return normalizeNotificationChannel(existingRow.appointments, 'off')
  }
  if (eventKey === 'agent_priority' && existingRow.conversations) {
    return normalizeNotificationChannel(existingRow.conversations, 'off')
  }
  return null
}

const getFallbackChannel = (
  eventKey: NotificationEventKey,
  recipientId: string,
  legacyPush: Record<'conversations' | 'appointments' | 'payments', boolean>
): NotificationChannel => {
  if (eventKey === 'conversations') return legacyPush.conversations ? 'push' : 'off'
  if (eventKey === 'agent_priority') return legacyPush.conversations ? 'push' : 'off'
  if (eventKey === 'appointment_booked') return legacyPush.appointments ? 'push' : 'off'
  if (eventKey === 'appointment_confirmed') return legacyPush.appointments ? 'push' : 'off'
  if (eventKey === 'payments') return legacyPush.payments ? 'push' : 'off'
  if (recipientId === 'all' && eventKey === 'system') return 'app'
  if (recipientId === 'admins' && eventKey === 'automation_internal') return 'app'
  return 'off'
}

const normalizePreferences = (
  rawPreferences: NotificationPreferencesConfig | string | null | undefined,
  recipients: NotificationRecipientRow[],
  legacyPush: Record<'conversations' | 'appointments' | 'payments', boolean>
): NotificationPreferencesConfig => {
  const source = safeJsonParse<NotificationPreferencesConfig>(rawPreferences, EMPTY_NOTIFICATION_PREFERENCES)
  const sourceRows = source?.rows && typeof source.rows === 'object' ? source.rows : {}
  const rows = recipients.reduce<NotificationPreferencesConfig['rows']>((acc, recipient) => {
    const existingRow = sourceRows[recipient.id] || {}
    acc[recipient.id] = NOTIFICATION_EVENTS.reduce<Partial<Record<NotificationEventKey, NotificationChannel>>>((row, event) => {
      row[event.key] = normalizeNotificationChannel(
        existingRow[event.key],
        getExistingFallbackChannel(event.key, existingRow as Partial<Record<NotificationEventKey | 'appointments', NotificationChannel>>) ||
          getFallbackChannel(event.key, recipient.id, legacyPush)
      )
      return row
    }, {})
    return acc
  }, {})

  return {
    version: NOTIFICATION_PREFERENCES_VERSION,
    updatedAt: source?.updatedAt || '',
    rows
  }
}

const createCurrentUserRecipient = (user: ReturnType<typeof useAuth>['user']): NotificationRecipientRow | null => {
  if (!user?.id) return null
  return {
    id: `user:${user.id}`,
    label: getCurrentUserDisplayName(user),
    detail: user.email || user.username || 'Usuario actual',
    kind: 'user',
    badge: user.role === 'admin' ? 'Admin' : 'Usuario'
  }
}

export const NotificationSettings: React.FC = () => {
  const { user } = useAuth()
  const { showToast } = useNotification()
  const [storedPreferences, setStoredPreferences, syncingPreferences] = useAppConfig<NotificationPreferencesConfig>(
    NOTIFICATION_PREFERENCES_CONFIG_KEY,
    EMPTY_NOTIFICATION_PREFERENCES
  )
  const [calendarPushEnabled, setCalendarPushEnabled, savingCalendarPush] = useAppConfig<boolean>('calendar_push_notifications_enabled', false)
  const [appointmentConfirmationPushEnabled, setAppointmentConfirmationPushEnabled, savingAppointmentConfirmationPush] = useAppConfig<boolean>('appointment_confirmation_push_notifications_enabled', true)
  const [chatPushEnabled, setChatPushEnabled, savingChatPush] = useAppConfig<boolean>('chat_push_notifications_enabled', true)
  const [paymentPushEnabled, setPaymentPushEnabled, savingPaymentPush] = useAppConfig<boolean>('payment_push_notifications_enabled', true)
  const [notificationSoundEnabled, setNotificationSoundEnabled, savingNotificationSound] = useAppConfig<boolean>('push_notification_sound_enabled', true)
  const [notificationVibrationEnabled, setNotificationVibrationEnabled, savingNotificationVibration] = useAppConfig<boolean>('push_notification_vibration_enabled', true)
  const [mobileHapticsEnabled, setMobileHapticsEnabled, savingMobileHaptics] = useAppConfig<boolean>('mobile_haptics_enabled', true)
  const [mobileKeyboardFeedbackEnabled, setMobileKeyboardFeedbackEnabled, savingMobileKeyboardFeedback] = useAppConfig<boolean>('mobile_keyboard_feedback_enabled', true)
  const [pushCalendarIds] = useAppConfig<string[]>('calendar_push_notification_calendar_ids', [])
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [requestingPush, setRequestingPush] = useState(false)
  const [savingPreferences, setSavingPreferences] = useState(false)
  const [permissionState, setPermissionState] = useState(getNotificationPermissionState)

  const canManageTeam = user?.role === 'admin'

  useEffect(() => {
    if (!canManageTeam) {
      setTeamUsers([])
      return
    }

    let cancelled = false
    setLoadingUsers(true)
    userAccessService.listUsers()
      .then((users) => {
        if (!cancelled) setTeamUsers(users.filter((member) => member.isActive))
      })
      .catch((error) => {
        if (!cancelled) {
          setTeamUsers([])
          showToast('error', 'No se cargaron usuarios', error instanceof Error ? error.message : 'Intenta de nuevo.')
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingUsers(false)
      })

    return () => {
      cancelled = true
    }
  }, [canManageTeam, showToast])

  const recipients = useMemo<NotificationRecipientRow[]>(() => {
    if (canManageTeam) {
      const rows: NotificationRecipientRow[] = [
        {
          id: 'all',
          label: 'Todos los usuarios',
          detail: 'Cualquier usuario interno activo.',
          kind: 'all',
          badge: 'Global'
        },
        {
          id: 'admins',
          label: 'Administradores',
          detail: 'Todos los admins activos del sistema.',
          kind: 'role',
          badge: 'Admin'
        }
      ]

      teamUsers.forEach((member) => {
        rows.push({
          id: `user:${member.id}`,
          label: getUserDisplayName(member),
          detail: member.email || member.username || member.phone || 'Usuario interno',
          kind: 'user',
          badge: member.role === 'admin' ? 'Admin' : 'Usuario'
        })
      })

      return rows
    }

    const currentUserRecipient = createCurrentUserRecipient(user)
    return currentUserRecipient ? [currentUserRecipient] : []
  }, [canManageTeam, teamUsers, user])

  const resolvedPreferences = useMemo(() => normalizePreferences(storedPreferences, recipients, {
    conversations: chatPushEnabled,
    appointments: calendarPushEnabled || appointmentConfirmationPushEnabled,
    payments: paymentPushEnabled
  }), [appointmentConfirmationPushEnabled, calendarPushEnabled, chatPushEnabled, paymentPushEnabled, recipients, storedPreferences])

  const [preferencesDraft, setPreferencesDraft] = useState<NotificationPreferencesConfig>(resolvedPreferences)

  useEffect(() => {
    setPreferencesDraft(resolvedPreferences)
  }, [resolvedPreferences])

  const savedRowsKey = useMemo(() => JSON.stringify(resolvedPreferences.rows), [resolvedPreferences.rows])
  const draftRowsKey = useMemo(() => JSON.stringify(preferencesDraft.rows), [preferencesDraft.rows])
  const preferencesChanged = savedRowsKey !== draftRowsKey
  const activeCellCount = countActiveCells(preferencesDraft)
  const activePushEventCount = NOTIFICATION_EVENTS.filter((event) => eventHasPush(preferencesDraft, event.key)).length
  const savingExperience = savingNotificationSound || savingNotificationVibration || savingMobileHaptics || savingMobileKeyboardFeedback
  const busy = savingPreferences || syncingPreferences || savingCalendarPush || savingAppointmentConfirmationPush || savingChatPush || savingPaymentPush || loadingUsers || savingExperience

  const handleChannelChange = (recipientId: string, eventKey: NotificationEventKey, channel: NotificationChannel) => {
    setPreferencesDraft((current) => ({
      ...current,
      rows: {
        ...current.rows,
        [recipientId]: {
          ...current.rows[recipientId],
          [eventKey]: channel
        }
      }
    }))
  }

  const handleSavePreferences = async () => {
    const nextPreferences: NotificationPreferencesConfig = {
      version: NOTIFICATION_PREFERENCES_VERSION,
      updatedAt: new Date().toISOString(),
      rows: preferencesDraft.rows
    }

    setSavingPreferences(true)
    try {
      await setStoredPreferences(nextPreferences)
      await Promise.all([
        setChatPushEnabled(eventHasPush(nextPreferences, 'conversations') || eventHasPush(nextPreferences, 'agent_priority')),
        setCalendarPushEnabled(eventHasPush(nextPreferences, 'appointment_booked')),
        setAppointmentConfirmationPushEnabled(eventHasPush(nextPreferences, 'appointment_confirmed')),
        setPaymentPushEnabled(eventHasPush(nextPreferences, 'payments'))
      ])
      showToast('success', 'Notificaciones guardadas', 'Las reglas internas quedaron actualizadas.')
    } catch (error: any) {
      showToast('error', 'No se guardó', error?.message || 'Intenta guardar la configuración otra vez.')
    } finally {
      setSavingPreferences(false)
    }
  }

  const handleResetDraft = () => {
    setPreferencesDraft(resolvedPreferences)
  }

  const handleActivateDevice = async () => {
    setRequestingPush(true)
    try {
      const result = await pushNotificationsService.subscribeToAppNotifications({
        calendarIds: pushCalendarIds
      })

      setPermissionState(getNotificationPermissionState())
      if (result.status === 'subscribed') {
        showToast('success', 'Push activado', 'Este dispositivo ya puede recibir notificaciones de Ristak.')
      } else {
        showToast('warning', 'No se activó', result.reason)
      }
    } catch (error: any) {
      setPermissionState(getNotificationPermissionState())
      showToast('error', 'No se activó', error?.message || 'Intenta nuevamente.')
    } finally {
      setRequestingPush(false)
    }
  }

  const getDraftChannel = (recipientId: string, eventKey: NotificationEventKey) => (
    normalizeNotificationChannel(
      preferencesDraft.rows[recipientId]?.[eventKey],
      getFallbackChannel(eventKey, recipientId, {
        conversations: chatPushEnabled,
        appointments: calendarPushEnabled || appointmentConfirmationPushEnabled,
        payments: paymentPushEnabled
      })
    )
  )

  const renderExperienceToggle = (
    id: string,
    title: string,
    description: string,
    checked: boolean,
    onChange: (checked: boolean) => void,
    Icon: React.ComponentType<{ size?: number }>,
    disabled = false
  ) => (
    <div className={styles.notificationExperienceRow}>
      <span className={styles.notificationExperienceIcon}>
        <Icon size={17} />
      </span>
      <span className={styles.notificationExperienceText}>
        <label htmlFor={id}>{title}</label>
        <small>{description}</small>
      </span>
      <Switch
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled || busy}
        aria-label={title}
      />
    </div>
  )

  return (
    <div className={styles.settingsContent}>
      <Card>
        <div className={styles.panelHeader}>
          <div className={styles.panelHeaderLeft}>
            <div className={styles.iconBox}>
              <BellRing size={22} />
            </div>
            <div>
              <h2 className={styles.panelTitle}>Notificaciones</h2>
              <p className={styles.panelDescription}>
                Configura quién recibe avisos internos, push, correo o WhatsApp por cada evento importante.
              </p>
            </div>
          </div>
          <div className={styles.panelHeaderActions}>
            <Badge variant={permissionState === 'granted' ? 'success' : permissionState === 'denied' ? 'warning' : 'neutral'}>
              <CheckCircle2 size={15} />
              {permissionState === 'granted' ? 'Push activo' : 'Push pendiente'}
            </Badge>
          </div>
        </div>

        <div className={styles.panelSection}>
          <div className={styles.notificationOverviewGrid}>
            <section className={styles.notificationDevicePanel}>
              <div className={styles.notificationDeviceIcon}>
                <Smartphone size={20} />
              </div>
              <div className={styles.notificationDeviceText}>
                <strong>Este dispositivo</strong>
                <span>{getNotificationPermissionLabel(permissionState)}</span>
              </div>
              <Button
                type="button"
                variant="secondary"
                onClick={handleActivateDevice}
                loading={requestingPush}
                disabled={requestingPush}
              >
                <BellRing size={16} />
                Activar push
              </Button>
            </section>

            <section className={styles.notificationSummaryPanel} aria-label="Resumen de notificaciones">
              <div>
                <span>Destinatarios</span>
                <strong>{recipients.length}</strong>
              </div>
              <div>
                <span>Reglas activas</span>
                <strong>{activeCellCount}</strong>
              </div>
              <div>
                <span>Eventos con push</span>
                <strong>{activePushEventCount}</strong>
              </div>
            </section>
          </div>
        </div>
      </Card>

      <Card>
        <div className={styles.notificationMatrixHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Experiencia en celular</h3>
            <p className={styles.sectionDescription}>
              Define si las push suenan, vibran y si la app da microvibraciones al tocar o escribir.
            </p>
          </div>
        </div>
        <div className={styles.notificationExperienceGrid}>
          {renderExperienceToggle(
            'push-sound-enabled',
            'Timbre de notificación',
            'Mensajes, citas, confirmaciones y pagos pueden sonar al llegar.',
            notificationSoundEnabled,
            setNotificationSoundEnabled,
            Volume2
          )}
          {renderExperienceToggle(
            'push-vibration-enabled',
            'Vibración de notificación',
            'Android usa canal con vibración e iPhone usa la alerta sonora del sistema.',
            notificationVibrationEnabled,
            setNotificationVibrationEnabled,
            Vibrate
          )}
          {renderExperienceToggle(
            'mobile-haptics-enabled',
            'Toques y gestos',
            'Vibra suave al abrir acciones, dejar picado, deslizar o enviar.',
            mobileHapticsEnabled,
            setMobileHapticsEnabled,
            Smartphone
          )}
          {renderExperienceToggle(
            'mobile-keyboard-feedback-enabled',
            'Clics al escribir',
            'Da un toque ligero mientras se escribe en el chat móvil.',
            mobileKeyboardFeedbackEnabled,
            setMobileKeyboardFeedbackEnabled,
            MessageCircle,
            !mobileHapticsEnabled
          )}
        </div>
      </Card>

      <Card>
        <div className={styles.notificationMatrixHeader}>
          <div>
            <h3 className={styles.sectionTitle}>Reglas por destinatario</h3>
            <p className={styles.sectionDescription}>
              Cada cruce define el canal que usará Ristak cuando ocurra ese evento.
            </p>
          </div>
          <div className={styles.panelHeaderActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={handleResetDraft}
              disabled={!preferencesChanged || busy}
            >
              <RotateCcw size={16} />
              Deshacer
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleSavePreferences}
              loading={savingPreferences}
              disabled={!preferencesChanged || busy}
            >
              <Save size={16} />
              Guardar
            </Button>
          </div>
        </div>

        <div className={styles.notificationMatrixWrap} data-ristak-table>
          <table className={styles.notificationMatrix} data-ristak-table-element>
            <thead>
              <tr>
                <th>Destinatario</th>
                {NOTIFICATION_EVENTS.map((event) => {
                  const Icon = event.icon
                  return (
                    <th key={event.key}>
                      <span className={styles.notificationEventHeading}>
                        <Icon size={15} />
                        <span>
                          <strong>{event.label}</strong>
                          <small>{event.description}</small>
                        </span>
                      </span>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {recipients.map((recipient) => {
                const RecipientIcon = recipient.kind === 'all' ? UsersRound : recipient.kind === 'role' ? ShieldCheck : UserRound
                return (
                  <tr key={recipient.id}>
                    <td>
                      <span className={styles.notificationRecipientCell}>
                        <span className={styles.notificationRecipientIcon}>
                          <RecipientIcon size={16} />
                        </span>
                        <span className={styles.notificationRecipientText}>
                          <strong>{recipient.label}</strong>
                          <small>{recipient.detail}</small>
                        </span>
                        <Badge variant={recipient.kind === 'role' ? 'primary' : recipient.kind === 'all' ? 'info' : 'neutral'}>
                          {recipient.badge}
                        </Badge>
                      </span>
                    </td>
                    {NOTIFICATION_EVENTS.map((event) => {
                      const value = getDraftChannel(recipient.id, event.key)
                      return (
                        <td key={`${recipient.id}-${event.key}`}>
                          <CustomSelect
                            value={value}
                            onValueChange={(nextValue) => handleChannelChange(recipient.id, event.key, nextValue as NotificationChannel)}
                            className={styles.notificationChannelSelect}
                            aria-label={`${recipient.label}: ${event.label}`}
                            disabled={busy}
                          >
                            {CHANNEL_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </CustomSelect>
                          <span className={styles.notificationChannelLabel}>
                            {CHANNEL_LABELS[value]}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
