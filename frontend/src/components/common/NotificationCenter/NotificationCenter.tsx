import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bell,
  Check,
  CheckCheck,
  CircleAlert,
  History,
  Info,
  RefreshCw,
  Undo2
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTimezone } from '@/contexts/TimezoneContext'
import { formatDate } from '@/utils/format'
import {
  notificationsService,
  type SystemNotification,
  type SystemNotificationSeverity,
  type SystemNotificationsResponse
} from '@/services/notificationsService'
import { Button } from '../Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '../DropdownMenu'
import { Loading } from '../Loading'
import styles from './NotificationCenter.module.css'

const PREVIEW_LIMIT = 30
const HISTORY_LIMIT = 100
const PREVIEW_VISIBLE_ITEMS = 6

type NotificationTone = 'critical' | 'warning' | 'info'

function normalizeNotificationTone(severity?: SystemNotificationSeverity): NotificationTone {
  if (severity === 'critical') return 'critical'
  if (severity === 'warning') return 'warning'
  return 'info'
}

function getNotificationTone(severity?: SystemNotificationSeverity) {
  const tone = normalizeNotificationTone(severity)
  if (tone === 'critical') return { tone, icon: AlertTriangle, label: 'Crítico' }
  if (tone === 'warning') return { tone, icon: CircleAlert, label: 'Atención' }
  return { tone, icon: Info, label: 'Info' }
}

function formatNotificationTime(value?: string, timezone?: string) {
  if (!value) return ''

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const diffMs = Date.now() - date.getTime()
  const minutes = Math.max(0, Math.round(diffMs / 60000))
  if (minutes < 1) return 'Ahora'
  if (minutes < 60) return `Hace ${minutes} min`

  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Hace ${hours} h`

  const days = Math.round(hours / 24)
  if (days < 7) return `Hace ${days} d`

  return formatDate(value, { timezone, padDay: false, fallback: '' })
}

const EMPTY_SUMMARY: SystemNotificationsResponse['summary'] = {
  total: 0,
  critical: 0,
  warning: 0,
  info: 0,
  unread: 0,
  highestSeverity: ''
}

export const NotificationCenter: React.FC = () => {
  const { timezone } = useTimezone()
  const [open, setOpen] = useState(false)
  const [historyMode, setHistoryMode] = useState(false)
  const [notifications, setNotifications] = useState<SystemNotification[]>([])
  const [summary, setSummary] = useState<SystemNotificationsResponse['summary']>(EMPTY_SUMMARY)
  const [loading, setLoading] = useState(false)
  const [mutationKey, setMutationKey] = useState('')
  const [error, setError] = useState('')
  const requestSequence = useRef(0)

  const fetchNotifications = useCallback(async ({
    liveMetaCheck = false,
    limit = PREVIEW_LIMIT
  }: { liveMetaCheck?: boolean; limit?: number } = {}) => {
    const requestId = ++requestSequence.current
    setLoading(true)
    setError('')

    try {
      const data = await notificationsService.getNotifications({ liveMetaCheck, limit })
      if (requestId !== requestSequence.current) return
      setNotifications(data.items || [])
      setSummary(data.summary || EMPTY_SUMMARY)
    } catch (fetchError) {
      if (requestId !== requestSequence.current) return
      setError(fetchError instanceof Error ? fetchError.message : 'No se pudieron cargar las notificaciones')
    } finally {
      if (requestId === requestSequence.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void fetchNotifications()
    const interval = window.setInterval(() => void fetchNotifications(), 120000)
    return () => window.clearInterval(interval)
  }, [fetchNotifications])

  const unreadNotifications = useMemo(
    () => notifications.filter((notification) => !notification.isRead),
    [notifications]
  )
  const unreadCount = summary.unread
  const visibleNotifications = historyMode
    ? notifications
    : unreadNotifications.slice(0, PREVIEW_VISIBLE_ITEMS)
  const highestUnreadTone = getNotificationTone(unreadNotifications[0]?.severity)

  const markRead = async (notification: SystemNotification) => {
    if (notification.isRead || mutationKey) return
    setMutationKey(notification.readKey)
    setError('')
    try {
      await notificationsService.markRead([notification])
      setNotifications((current) => current.map((item) => (
        item.readKey === notification.readKey ? { ...item, isRead: true } : item
      )))
      setSummary((current) => ({ ...current, unread: Math.max(0, current.unread - 1) }))
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : 'No se pudo marcar la notificación')
    } finally {
      setMutationKey('')
    }
  }

  const markAllRead = async () => {
    if (!unreadCount || mutationKey) return
    setMutationKey('all')
    setError('')
    try {
      await notificationsService.markAllRead(notifications)
      setNotifications((current) => current.map((item) => ({ ...item, isRead: true })))
      setSummary((current) => ({ ...current, unread: 0 }))
    } catch (markError) {
      setError(markError instanceof Error ? markError.message : 'No se pudieron marcar todas las notificaciones')
    } finally {
      setMutationKey('')
    }
  }

  const showHistory = () => {
    setHistoryMode(true)
    void fetchNotifications({ limit: HISTORY_LIMIT })
  }

  const showUnread = () => {
    setHistoryMode(false)
    if (notifications.length > PREVIEW_LIMIT) void fetchNotifications()
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setHistoryMode(false)
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          iconOnly
          className={styles.trigger}
          aria-label={unreadCount ? `${unreadCount} notificaciones sin leer` : 'Notificaciones'}
          title="Notificaciones"
        >
          <Bell aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              className={styles.countBubble}
              data-severity={highestUnreadTone.tone}
              aria-hidden="true"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        className={styles.notificationPanel}
        data-ristak-notification-menu
      >
        <div className={styles.panelHeader}>
          <div className={styles.headingCopy}>
            <p className={styles.heading}>Notificaciones</p>
            <p className={styles.subheading}>
              {unreadCount ? `${unreadCount} sin leer` : 'Todo al día'}
            </p>
          </div>
          <div className={styles.headerActions}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<CheckCheck aria-hidden="true" />}
              onClick={() => void markAllRead()}
              disabled={!unreadCount || Boolean(mutationKey)}
            >
              Marcar todas
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              iconOnly
              onClick={() => void fetchNotifications({
                liveMetaCheck: true,
                limit: historyMode ? HISTORY_LIMIT : PREVIEW_LIMIT
              })}
              disabled={loading}
              aria-label="Actualizar notificaciones"
              title="Actualizar"
            >
              <RefreshCw className={loading ? styles.spinning : undefined} aria-hidden="true" />
            </Button>
          </div>
        </div>

        {error && (
          <div className={styles.errorNotice} role="alert">{error}</div>
        )}

        <div className={styles.notificationList} data-history={historyMode ? 'true' : undefined}>
          {loading && !notifications.length && (
            <Loading compact size="sm" message="Cargando notificaciones" />
          )}

          {!visibleNotifications.length && !loading && (
            <div className={styles.emptyState}>
              <span className={styles.emptySymbol}><Bell aria-hidden="true" /></span>
              <p className={styles.emptyTitle}>
                {historyMode ? 'Todavía no hay historial' : 'Ya viste todo'}
              </p>
              <p className={styles.emptyCopy}>
                {historyMode
                  ? 'Las notificaciones aparecerán aquí cuando Ristak tenga algo que contarte.'
                  : 'No volveremos a marcar estos avisos como nuevos. Puedes consultarlos en el historial.'}
              </p>
            </div>
          )}

          {visibleNotifications.map((notification) => {
            const tone = getNotificationTone(notification.severity)
            const Icon = tone.icon
            const marking = mutationKey === notification.readKey

            return (
              <article
                key={notification.readKey}
                className={styles.notificationEntry}
                data-unread={notification.isRead ? undefined : 'true'}
                data-ristak-notification-item
              >
                <span className={styles.notificationSymbol} data-severity={tone.tone}>
                  <Icon aria-hidden="true" />
                </span>
                <div className={styles.notificationContent}>
                  <div className={styles.notificationTitleRow}>
                    <p className={styles.notificationTitle}>{notification.title}</p>
                    {!notification.isRead && (
                      <span className={styles.unreadDot} data-severity={tone.tone} aria-label="Sin leer" />
                    )}
                  </div>
                  {notification.message && (
                    <p className={styles.notificationMessage}>{notification.message}</p>
                  )}
                  <p className={styles.notificationMeta}>
                    <span>{notification.source}</span>
                    <span aria-hidden="true">·</span>
                    <span>{tone.label}</span>
                    {notification.updatedAt && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{formatNotificationTime(notification.updatedAt, timezone)}</span>
                      </>
                    )}
                  </p>
                  <div className={styles.notificationActions}>
                    {notification.actionUrl && (
                      <Link
                        to={notification.actionUrl}
                        className={styles.actionLink}
                        onClick={() => {
                          if (!notification.isRead) void markRead(notification)
                          setOpen(false)
                        }}
                      >
                        {notification.actionLabel || 'Revisar'}
                      </Link>
                    )}
                    {!notification.isRead && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        leftIcon={<Check aria-hidden="true" />}
                        onClick={() => void markRead(notification)}
                        disabled={Boolean(mutationKey)}
                        loading={marking}
                      >
                        Marcar leída
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            )
          })}
        </div>

        <div className={styles.panelFooter}>
          {historyMode ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<Undo2 aria-hidden="true" />}
              onClick={showUnread}
            >
              Volver a nuevas
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              leftIcon={<History aria-hidden="true" />}
              onClick={showHistory}
            >
              Ver historial
            </Button>
          )}
          {historyMode && (
            <span className={styles.historyCount}>{notifications.length} mostradas</span>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
