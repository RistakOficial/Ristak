import React, { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bell, ChevronDown, CircleAlert, Info, LogOut, Moon, Palette, RefreshCw, Settings as SettingsIcon, Sun, Check } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { Link } from 'react-router-dom'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { GlobalSearch } from '@/components/common/GlobalSearch/GlobalSearch'
import { notificationsService, type SystemNotification } from '@/services/notificationsService'

interface HeaderProps {
  onLogout: () => void
}

const getInitials = (name?: string, email?: string) => {
  if (name) {
    const parts = name.trim().split(' ')
    if (parts.length === 1) {
      return parts[0].slice(0, 2).toUpperCase()
    }
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
  }
  if (email) {
    return email.slice(0, 2).toUpperCase()
  }
  return 'U'
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

export const Header: React.FC<HeaderProps> = ({ onLogout }) => {
  const { theme, toggleTheme, themeSource, resetToSystem, isSystemTheme, designPreset, setDesignPreset, designPresets } = useTheme()
  const { user } = useAuth()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const [showNotifications, setShowNotifications] = useState(false)
  const [notifications, setNotifications] = useState<SystemNotification[]>([])
  const [notificationsLoading, setNotificationsLoading] = useState(false)
  const [notificationsError, setNotificationsError] = useState('')
  const [seenNotificationIds, setSeenNotificationIds] = useState<Set<string>>(() => getSeenNotificationIds())
  const menuRef = useRef<HTMLDivElement>(null)
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
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setShowNotifications(false)
      }
    }

    if (showUserMenu || showNotifications) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserMenu, showNotifications])

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

  const initials = getInitials(user?.name, user?.email)
  const unreadNotifications = notifications.filter((notification) => !seenNotificationIds.has(notification.id))
  const unreadCount = unreadNotifications.length
  const badgeTone = getNotificationTone(unreadNotifications[0]?.severity || notifications[0]?.severity)

  // Determinar si el header debe estar oculto
  const shouldHide = scrollDirection === 'down' && scrollY > 50

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
        <div className="relative" ref={notificationsRef}>
          <button
            type="button"
            className="relative p-1.5 sm:p-2 rounded-xl glass border border-[rgba(148,163,184,0.18)] text-[var(--color-text-primary)] hover:glass-hover transition-colors"
            onClick={() => {
              setShowNotifications((current) => !current)
              setShowUserMenu(false)
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

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => {
              setShowUserMenu(!showUserMenu)
              setShowNotifications(false)
            }}
            className="flex items-center gap-2 p-1.5 sm:p-2 rounded-lg hover:glass-hover focus:outline-none transition-all"
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full glass border border-[rgba(148,163,184,0.2)] flex items-center justify-center">
              <span className="text-xs sm:text-sm font-medium text-[var(--color-text-tertiary)]">{initials}</span>
            </div>
            <ChevronDown
              className={cn(
                'w-3 h-3 sm:w-4 sm:h-4 text-[var(--color-text-tertiary)] transition-transform',
                showUserMenu && 'rotate-180'
              )}
            />
          </button>

          {showUserMenu && (
            <div
              data-ristak-user-menu
              className="absolute right-0 mt-2 w-80 max-w-[calc(100vw-1rem)] glass rounded-xl border border-[rgba(148,163,184,0.18)] shadow-xl z-50 overflow-hidden"
            >
              <div className="p-4 border-b border-[rgba(148,163,184,0.1)]">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full glass border border-[rgba(148,163,184,0.2)] flex items-center justify-center">
                    <span className="text-sm font-medium text-[var(--color-text-tertiary)]">{initials}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-[var(--color-text-primary)] truncate">{user?.name || 'Usuario'}</p>
                    <p className="text-xs text-[var(--color-text-tertiary)] truncate">{user?.email || 'usuario@example.com'}</p>
                  </div>
                </div>
              </div>

              <div className="py-2">
                <div className="px-4 py-2">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-tertiary)]">
                    <Palette className="h-3.5 w-3.5" />
                    Diseño de app
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {designPresets.map((preset) => {
                      const isActive = preset.id === designPreset

                      return (
                        <button
                          key={preset.id}
                          type="button"
                          title={preset.description}
                          onClick={() => setDesignPreset(preset.id)}
                          className={cn(
                            'flex min-h-[58px] items-center gap-2 rounded-lg border border-[rgba(148,163,184,0.14)] px-2.5 py-2 text-left text-sm text-[var(--color-text-primary)] transition-colors hover:glass-hover',
                            isActive && 'bg-[rgba(var(--color-primary-rgb),0.12)] border-[rgba(var(--color-primary-rgb),0.28)]'
                          )}
                          aria-pressed={isActive}
                        >
                          <span
                            className="design-preset-preview"
                            data-preset={preset.id}
                            aria-hidden="true"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">{preset.label}</span>
                          {isActive && <Check className="h-4 w-4 flex-shrink-0 text-[var(--color-status-success)]" />}
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={toggleTheme}
                      className="flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-[rgba(148,163,184,0.14)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] transition-colors hover:glass-hover"
                    >
                      {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                      {theme === 'light' ? 'Modo noche' : 'Modo claro'}
                    </button>
                    <button
                      type="button"
                      onClick={resetToSystem}
                      disabled={isSystemTheme}
                      className={cn(
                        'flex min-h-[42px] items-center justify-center gap-2 rounded-lg border border-[rgba(148,163,184,0.14)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] transition-colors',
                        isSystemTheme ? 'opacity-70' : 'hover:glass-hover'
                      )}
                    >
                      {isSystemTheme && <Check className="h-4 w-4 text-[var(--color-status-success)]" />}
                      {themeSource === 'system' ? 'Automático' : 'Auto'}
                    </button>
                  </div>
                </div>

                <div className="my-2 mx-4 border-t border-[rgba(148,163,184,0.12)]" />

                <Link
                  to="/settings"
                  onClick={() => setShowUserMenu(false)}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm text-[var(--color-text-primary)] hover:glass-hover transition-colors"
                >
                  <SettingsIcon className="w-4 h-4" />
                  Configuración
                </Link>
                <div className="my-2 mx-4 border-t border-[rgba(148,163,184,0.12)]" />
                <button
                  onClick={() => {
                    setShowUserMenu(false)
                    onLogout()
                  }}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm text-red-500 hover:glass-hover transition-colors w-full text-left"
                >
                  <LogOut className="w-4 h-4" />
                  Cerrar Sesión
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
