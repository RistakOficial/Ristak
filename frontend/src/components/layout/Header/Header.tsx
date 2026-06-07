import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bell, CircleAlert, Info, RefreshCw, Smartphone } from 'lucide-react'
import { cn } from '@/utils/cn'
import { Link, useNavigate } from 'react-router-dom'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { GlobalSearch } from '@/components/common/GlobalSearch/GlobalSearch'
import { notificationsService, type SystemNotification } from '@/services/notificationsService'
import {
  PHONE_APP_HOME_PATH,
  TABLET_VIEW_PREFERENCE_EVENT,
  isTabletDevice,
  writeTabletViewPreference
} from '@/utils/phoneAccess'

interface HeaderProps {
  sitesEditorActive?: boolean
}

const NOTIFICATION_SEEN_KEY = 'ristak.systemNotifications.seen'

function getSeenNotificationIds() {
  if (typeof window === 'undefined') return new Set<string>()

  try {
    const raw = window.localStorage.getItem(NOTIFICATION_SEEN_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set<string>(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set<string>()
  }
}

function saveSeenNotificationIds(ids: Set<string>) {
  try {
    window.localStorage.setItem(NOTIFICATION_SEEN_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    // Ignore restricted storage contexts.
  }
}

function formatNotificationTime(value?: string) {
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

  return date.toLocaleDateString('es-MX', { month: 'short', day: 'numeric' })
}

function getNotificationTone(severity?: string) {
  if (severity === 'critical') {
    return {
      icon: AlertTriangle,
      dot: 'bg-red-500',
      iconClass: 'text-red-500 bg-red-500/10 border-red-500/20',
      label: 'Critico'
    }
  }

  if (severity === 'warning') {
    return {
      icon: CircleAlert,
      dot: 'bg-amber-500',
      iconClass: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
      label: 'Atencion'
    }
  }

  return {
    icon: Info,
    dot: 'bg-sky-500',
    iconClass: 'text-sky-500 bg-sky-500/10 border-sky-500/20',
    label: 'Info'
  }
}

export const Header: React.FC<HeaderProps> = ({ sitesEditorActive = false }) => {
  const navigate = useNavigate()
  const [showNotifications, setShowNotifications] = useState(false)
  const [showTabletSwitcher, setShowTabletSwitcher] = useState(false)
  const [notifications, setNotifications] = useState<SystemNotification[]>([])
  const [notificationsLoading, setNotificationsLoading] = useState(false)
  const [notificationsError, setNotificationsError] = useState('')
  const [seenNotificationIds, setSeenNotificationIds] = useState<Set<string>>(() => getSeenNotificationIds())
  const notificationsRef = useRef<HTMLDivElement>(null)
  const scrollDirection = useScrollDirection()
  const [scrollY, setScrollY] = useState(0)

  // Track scroll position
  useEffect(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setShowNotifications(false)
      }
    }

    if (showNotifications) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showNotifications])

  const fetchNotifications = async (liveMetaCheck = true) => {
    setNotificationsLoading(true)
    setNotificationsError('')
    try {
      const data = await notificationsService.getNotifications({ liveMetaCheck, limit: 30 })
      setNotifications(data.items || [])
    } catch (error) {
      setNotificationsError(error instanceof Error ? error.message : 'No se pudieron cargar las notificaciones')
    } finally {
      setNotificationsLoading(false)
    }
  }

  const markNotificationsSeen = (items = notifications) => {
    if (!items.length) return

    setSeenNotificationIds((current) => {
      const next = new Set(current)
      items.forEach((item) => next.add(item.id))
      saveSeenNotificationIds(next)
      return next
    })
  }

  useEffect(() => {
    fetchNotifications(true)
    const interval = window.setInterval(() => fetchNotifications(true), 120000)
    return () => window.clearInterval(interval)
  }, [])

  useEffect(() => {
    if (showNotifications) markNotificationsSeen()
  }, [showNotifications, notifications])

  useEffect(() => {
    const pointerMedia = window.matchMedia?.('(pointer: coarse)')
    const updateTabletSwitcher = () => setShowTabletSwitcher(isTabletDevice())

    updateTabletSwitcher()
    pointerMedia?.addEventListener('change', updateTabletSwitcher)
    window.addEventListener('resize', updateTabletSwitcher)
    window.addEventListener('orientationchange', updateTabletSwitcher)
    window.visualViewport?.addEventListener('resize', updateTabletSwitcher)
    window.addEventListener(TABLET_VIEW_PREFERENCE_EVENT, updateTabletSwitcher)

    return () => {
      pointerMedia?.removeEventListener('change', updateTabletSwitcher)
      window.removeEventListener('resize', updateTabletSwitcher)
      window.removeEventListener('orientationchange', updateTabletSwitcher)
      window.visualViewport?.removeEventListener('resize', updateTabletSwitcher)
      window.removeEventListener(TABLET_VIEW_PREFERENCE_EVENT, updateTabletSwitcher)
    }
  }, [])

  const handleSwitchToTabletMode = () => {
    writeTabletViewPreference('tablet')
    setShowNotifications(false)
    navigate(PHONE_APP_HOME_PATH)
  }

  const unreadNotifications = notifications.filter((notification) => !seenNotificationIds.has(notification.id))
  const unreadCount = unreadNotifications.length
  const badgeTone = getNotificationTone(unreadNotifications[0]?.severity || notifications[0]?.severity)

  // Determinar si el header debe estar oculto
  const shouldHide = !sitesEditorActive && scrollDirection === 'down' && scrollY > 50

  return (
    <header
      data-ristak-header
      className={cn(
        "glass border-b border-[rgba(148,163,184,0.12)] px-4 sm:px-6 flex items-center justify-between sticky top-0",
        "transition-transform duration-300 ease-in-out",
        shouldHide ? '-translate-y-full' : 'translate-y-0'
      )}
      style={{ height: 'var(--header-height)', zIndex: 'var(--z-index-header)' }}
    >
      <div className="flex items-center gap-2 sm:gap-4 flex-1 max-w-xl ml-12 lg:ml-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GlobalSearch />
        </div>
      </div>

      <div className="flex items-center gap-1 sm:gap-3">
        {showTabletSwitcher && (
          <button
            type="button"
            className="hidden sm:inline-flex min-h-[38px] items-center gap-2 whitespace-nowrap rounded-xl border border-[rgba(var(--color-primary-rgb),0.24)] bg-[rgba(var(--color-primary-rgb),0.08)] px-3 text-xs font-bold text-[var(--color-primary)] transition-colors hover:bg-[rgba(var(--color-primary-rgb),0.14)]"
            onClick={handleSwitchToTabletMode}
          >
            <Smartphone className="h-4 w-4" />
            Cambiar a modo tableta
          </button>
        )}
        <div className="relative" ref={notificationsRef}>
          <button
            type="button"
            className="relative p-1.5 sm:p-2 rounded-xl glass border border-[rgba(148,163,184,0.18)] text-[var(--color-text-primary)] hover:glass-hover transition-colors"
            onClick={() => {
              setShowNotifications((current) => !current)
            }}
            aria-label={unreadCount ? `${unreadCount} notificaciones nuevas` : 'Notificaciones'}
            title="Notificaciones"
          >
            <Bell className="w-4 h-4 sm:w-5 sm:h-5" />
            {unreadCount > 0 && (
              <span className={cn(
                'absolute -right-1 -top-1 min-w-[18px] rounded-full px-1 text-[10px] font-bold leading-[18px] text-white shadow-sm',
                badgeTone.dot
              )}>
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {showNotifications && (
            <div
              data-ristak-notification-menu
              className="absolute right-0 mt-2 w-[360px] max-w-[calc(100vw-1rem)] glass rounded-xl border border-[rgba(148,163,184,0.18)] shadow-xl z-50 overflow-hidden"
            >
              <div className="flex items-center justify-between gap-3 border-b border-[rgba(148,163,184,0.1)] px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-[var(--color-text-primary)]">Notificaciones</p>
                  <p className="text-xs text-[var(--color-text-tertiary)]">
                    {notifications.length ? `${notifications.length} aviso${notifications.length === 1 ? '' : 's'} activos` : 'Todo en orden'}
                  </p>
                </div>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[rgba(148,163,184,0.16)] text-[var(--color-text-secondary)] transition-colors hover:glass-hover"
                  onClick={() => fetchNotifications(true)}
                  disabled={notificationsLoading}
                  title="Actualizar"
                >
                  <RefreshCw className={cn('h-4 w-4', notificationsLoading && 'animate-spin')} />
                </button>
              </div>

              <div className="max-h-[420px] overflow-y-auto py-2">
                {notificationsError && (
                  <div className="mx-3 mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-500">
                    {notificationsError}
                  </div>
                )}

                {!notifications.length && !notificationsLoading && (
                  <div className="px-4 py-8 text-center">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-[rgba(148,163,184,0.16)] text-[var(--color-text-tertiary)]">
                      <Bell className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-semibold text-[var(--color-text-primary)]">Sin alertas importantes</p>
                    <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">Meta, WhatsApp, dominios y storage se ven tranquilos.</p>
                  </div>
                )}

                {notifications.map((notification) => {
                  const tone = getNotificationTone(notification.severity)
                  const Icon = tone.icon
                  const unread = !seenNotificationIds.has(notification.id)

                  return (
                    <div
                      key={notification.id}
                      data-ristak-notification-item
                      data-unread={unread ? 'true' : undefined}
                      className={cn(
                        'mx-2 mb-2 rounded-lg border border-[rgba(148,163,184,0.12)] px-3 py-3 transition-colors',
                        unread ? 'bg-[rgba(var(--color-primary-rgb),0.08)]' : 'bg-[rgba(148,163,184,0.04)]'
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <span className={cn('mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border', tone.iconClass)}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm font-semibold leading-snug text-[var(--color-text-primary)]">{notification.title}</p>
                            {unread && <span className={cn('mt-1 h-2 w-2 flex-shrink-0 rounded-full', tone.dot)} />}
                          </div>
                          {notification.message && (
                            <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-secondary)]">{notification.message}</p>
                          )}
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
                            <span>{notification.source}</span>
                            <span>·</span>
                            <span>{tone.label}</span>
                            {notification.updatedAt && (
                              <>
                                <span>·</span>
                                <span>{formatNotificationTime(notification.updatedAt)}</span>
                              </>
                            )}
                          </div>
                          {notification.actionUrl && (
                            <Link
                              to={notification.actionUrl}
                              onClick={() => setShowNotifications(false)}
                              className="mt-2 inline-flex items-center rounded-md px-0 text-xs font-bold text-[var(--color-primary)] hover:underline"
                            >
                              {notification.actionLabel || 'Revisar'}
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
