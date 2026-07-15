import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  FileBarChart,
  Megaphone,
  Banknote,
  Bot,
  Users,
  Calendar,
  Settings,
  BarChart3,
  PanelTop,
  Workflow,
  GripVertical,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Magnet,
  MessageCircle,
  Moon,
  Palette,
  Rocket,
  Sun
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAppConfig, useAppVersion } from '@/hooks'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { useInitialization } from '@/contexts/InitializationContext'
import {
  hasModuleAccess,
  hasLicenseFeature,
  type AccessControlledUser,
  type PermissionKey
} from '@/utils/accessControl'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { prefetchRouteModule } from '@/routing/routeModules'
import { getFirstAllowedSettingsPath } from '@/pages/Settings/settingsNav'

interface SidebarProps {
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
  onNavigate?: () => void
  onLogout?: () => void
}

type IconType = React.ComponentType<React.SVGProps<SVGSVGElement>>

interface NavItem {
  id: string
  name: string
  href: string
  icon: IconType
  isDivider?: boolean
  isAction?: boolean
  isMdpProgram?: boolean
  action?: () => void
}

interface SidebarNavChild {
  to: string
  label: string
  exact?: boolean
  featureKeys?: readonly string[]
}

const MDP_PROGRAM_ROOT_PATH = '/mdp-program'

const PAYMENTS_NAV_ITEMS: SidebarNavChild[] = [
  { to: '/transactions', label: 'Transacciones', exact: true },
  { to: '/transactions/payment-plans', label: 'Planes de pago', featureKeys: ['payment_plans'] },
  { to: '/transactions/subscriptions', label: 'Suscripciones', featureKeys: ['subscriptions'] },
  { to: '/transactions/products', label: 'Productos' }
]

const baseNavigation: NavItem[] = [
  { id: 'dashboard', name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { id: 'chat', name: 'Chat', href: '/chat', icon: MessageCircle },
  { id: 'ai_agent', name: 'Chatbot', href: '/ai-agent', icon: Bot },
  { id: 'appointments', name: 'Citas', href: '/appointments', icon: Calendar },
  { id: 'transactions', name: 'Pagos', href: '/transactions', icon: Banknote },
  { id: 'contacts', name: 'Contactos', href: '/contacts', icon: Users },
  { id: 'divider-contacts', name: '', href: '#', icon: LayoutDashboard, isDivider: true },
  { id: 'reports', name: 'Reportes', href: '/reports/table/month/cashflow', icon: FileBarChart },
  { id: 'analytics', name: 'Analíticas', href: '/analytics', icon: BarChart3 },
  { id: 'divider-1', name: '', href: '#', icon: LayoutDashboard, isDivider: true },
  { id: 'campaigns', name: 'Publicidad', href: '/campaigns/classic', icon: Megaphone },
  { id: 'automations', name: 'Automatizaciones', href: '/automations', icon: Workflow },
  { id: 'sites', name: 'Sitios', href: '/sites', icon: PanelTop },
]

const mdpProgramNavigationItem: NavItem = {
  id: 'mdp_program',
  name: 'Magnetismo',
  href: MDP_PROGRAM_ROOT_PATH,
  icon: Magnet,
  isMdpProgram: true
}

const defaultNavigationPositionById: Record<string, number> = {
  dashboard: 10,
  chat: 20,
  ai_agent: 25,
  appointments: 30,
  transactions: 40,
  contacts: 50,
  'divider-contacts': 56,
  reports: 60,
  analytics: 70,
  'divider-1': 76,
  campaigns: 80,
  automations: 90,
  sites: 100
}

const DEFAULT_MDP_NAVIGATION_POSITION = 25

const navPermissionById: Partial<Record<string, PermissionKey>> = {
  dashboard: 'dashboard',
  chat: 'chat',
  ai_agent: 'ai_agent',
  appointments: 'appointments',
  transactions: 'payments',
  contacts: 'contacts',
  reports: 'reports',
  analytics: 'analytics',
  campaigns: 'campaigns',
  automations: 'automations',
  sites: 'sites'
}

// La pestaña de Inicialización siempre va primera y solo se muestra mientras el
// onboarding de integraciones no esté completo (o el usuario no lo haya ocultado).
const initializationNavigation: NavItem = {
  id: 'initialization',
  name: 'Inicialización',
  href: '/initialization',
  icon: Rocket
}

const cleanNavigationDividers = (items: NavItem[]) => {
  const cleaned: NavItem[] = []

  items.forEach((item) => {
    if (item.isDivider) {
      if (!cleaned.length || cleaned[cleaned.length - 1].isDivider) return
    }
    cleaned.push(item)
  })

  while (cleaned[0]?.isDivider) cleaned.shift()
  while (cleaned[cleaned.length - 1]?.isDivider) cleaned.pop()

  return cleaned
}

const externalModuleSidebarPosition = (user: AccessControlledUser | null | undefined, key: string) => {
  const position = Number(user?.licenseExternalModules?.[key]?.sidebarPosition)
  return Number.isFinite(position) ? position : DEFAULT_MDP_NAVIGATION_POSITION
}

const sortNavigationByDefaultPosition = (items: NavItem[], user?: AccessControlledUser | null): NavItem[] => {
  return [...items].sort((a, b) => {
    const aPosition = a.id === mdpProgramNavigationItem.id
      ? externalModuleSidebarPosition(user, mdpProgramNavigationItem.id)
      : defaultNavigationPositionById[a.id] ?? 1000
    const bPosition = b.id === mdpProgramNavigationItem.id
      ? externalModuleSidebarPosition(user, mdpProgramNavigationItem.id)
      : defaultNavigationPositionById[b.id] ?? 1000

    if (aPosition !== bPosition) return aPosition - bPosition
    return items.indexOf(a) - items.indexOf(b)
  })
}

const getNavigationItems = (user?: AccessControlledUser | null): NavItem[] => {
  const items = baseNavigation.filter((item) => {
    if (item.isDivider) return true
    const permissionKey = navPermissionById[item.id]
    return !permissionKey || hasModuleAccess(user, permissionKey, 'read')
  })

  if (user?.licenseFeatures?.mdp_program === true) {
    items.push(mdpProgramNavigationItem)
  }

  return cleanNavigationDividers(sortNavigationByDefaultPosition(items, user))
}

const getInitials = (name?: string, email?: string) => {
  if (name) {
    const parts = name.trim().split(' ').filter(Boolean)
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

const applyNavigationOrder = (items: NavItem[], order: string[]): NavItem[] => {
  if (!order.length) return items

  const itemsById = new Map(items.map(item => [item.id, item]))
  const orderedItems: NavItem[] = []
  const orderIncludesChat = order.includes('chat')

  order.forEach(id => {
    const item = itemsById.get(id)
    if (item) {
      orderedItems.push(item)
      itemsById.delete(id)
    }
  })

  // Items nuevos no presentes en el orden guardado se insertan segun el orden
  // actual del producto. Asi un modulo externo nuevo no aparece hasta abajo
  // solo porque el cliente ya tenia un sidebar personalizado.
  itemsById.forEach(item => {
    const defaultIndex = items.findIndex(candidate => candidate.id === item.id)
    const insertAt = orderedItems.findIndex(candidate => {
      const candidateDefaultIndex = items.findIndex(defaultItem => defaultItem.id === candidate.id)
      return candidateDefaultIndex >= 0 && candidateDefaultIndex > defaultIndex
    })
    orderedItems.splice(insertAt >= 0 ? insertAt : orderedItems.length, 0, item)
  })

  if (!orderIncludesChat) {
    const chatIndex = orderedItems.findIndex(item => item.id === 'chat')
    const dashboardIndex = orderedItems.findIndex(item => item.id === 'dashboard')
    if (chatIndex >= 0 && dashboardIndex >= 0 && chatIndex !== dashboardIndex + 1) {
      const [chatItem] = orderedItems.splice(chatIndex, 1)
      const nextDashboardIndex = orderedItems.findIndex(item => item.id === 'dashboard')
      orderedItems.splice(nextDashboardIndex + 1, 0, chatItem)
    }
  }

  return orderedItems
}

const withInitializationNavigation = (
  items: NavItem[],
  user: AccessControlledUser | null | undefined,
  isInitialized: boolean
): NavItem[] => {
  if (isInitialized || user?.role !== 'admin') return items
  if (items[0]?.isMdpProgram) return [items[0], initializationNavigation, ...items.slice(1)]
  return [initializationNavigation, ...items]
}

interface NavigationItemProps {
  item: NavItem
  isActive: boolean
  collapsed?: boolean
  onNavigate?: () => void
}

interface SortableItemProps {
  item: NavItem
  isActive: boolean
  isDragging: boolean
  isEditMode: boolean
  onNavigate?: () => void
}

const getNavLinkClasses = (isActive: boolean, extraClasses?: string, collapsed = false) => cn(
  'flex items-center rounded-lg text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
  collapsed ? 'min-h-[42px] justify-center px-0 py-2.5' : 'gap-3 px-3 py-2.5',
  isActive
    ? 'bg-[var(--accent-soft)] text-[var(--text)]'
    : 'text-[var(--text-mute)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
  extraClasses
)

const getNavChildLinkClasses = (isActive: boolean) => cn(
  'flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium leading-[1.2] transition-colors',
  isActive
    ? 'bg-[var(--accent-soft)] text-[var(--text)]'
    : 'text-[var(--text-mute)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
)

const ROUTE_PREFETCH_POINTER_DWELL_MS = 150
const SITES_IDLE_PREFETCH_STABLE_MS = 4000
const sidebarRoutePrefetchTimers = new Map<string, number>()

const prefetchSidebarRoute = (destination: string) => {
  const pendingTimer = sidebarRoutePrefetchTimers.get(destination)
  if (pendingTimer !== undefined) {
    window.clearTimeout(pendingTimer)
    sidebarRoutePrefetchTimers.delete(destination)
  }

  void prefetchRouteModule(destination).catch(() => {
    // La navegación normal vuelve a intentar el chunk. Una precarga sin
    // conexión no debe generar ruido ni bloquear la interacción del menú.
  })
}

const scheduleSidebarRoutePrefetch = (destination: string) => {
  const pendingTimer = sidebarRoutePrefetchTimers.get(destination)
  if (pendingTimer !== undefined) window.clearTimeout(pendingTimer)

  const timer = window.setTimeout(() => {
    sidebarRoutePrefetchTimers.delete(destination)
    prefetchSidebarRoute(destination)
  }, ROUTE_PREFETCH_POINTER_DWELL_MS)
  sidebarRoutePrefetchTimers.set(destination, timer)
}

const cancelSidebarRoutePrefetch = (destination: string) => {
  const pendingTimer = sidebarRoutePrefetchTimers.get(destination)
  if (pendingTimer === undefined) return
  window.clearTimeout(pendingTimer)
  sidebarRoutePrefetchTimers.delete(destination)
}

const cancelAllSidebarRoutePrefetches = () => {
  sidebarRoutePrefetchTimers.forEach((timer) => window.clearTimeout(timer))
  sidebarRoutePrefetchTimers.clear()
}

const routePrefetchIntentProps = (destination: string) => ({
  onPointerEnter: () => scheduleSidebarRoutePrefetch(destination),
  onPointerLeave: () => cancelSidebarRoutePrefetch(destination),
  onPointerDown: () => prefetchSidebarRoute(destination),
  onFocus: () => prefetchSidebarRoute(destination),
  onBlur: () => cancelSidebarRoutePrefetch(destination),
  onTouchStart: () => prefetchSidebarRoute(destination)
})

interface SettingsNavLinkProps {
  pathname: string
  destination: string
  collapsed?: boolean
  onNavigate?: () => void
}

const SettingsNavLink: React.FC<SettingsNavLinkProps> = ({ pathname, destination, collapsed = false, onNavigate }) => {
  const isSettingsRoute = pathname.startsWith('/settings')

  return (
    <Link
      to={destination}
      {...routePrefetchIntentProps(destination)}
      onClick={onNavigate}
      aria-label={collapsed ? 'Configuración' : undefined}
      title={collapsed ? 'Configuración' : undefined}
      data-ristak-sidebar-nav-item
      data-active={isSettingsRoute ? 'true' : undefined}
      className={cn(getNavLinkClasses(isSettingsRoute, 'w-full', collapsed))}
    >
      <Settings className="h-5 w-5 flex-shrink-0" />
      <span className={collapsed ? 'sr-only' : 'flex-1 text-left'}>Configuración</span>
    </Link>
  )
}

interface PaymentsNavGroupProps {
  pathname: string
  open: boolean
  items: SidebarNavChild[]
  collapsed?: boolean
  onToggle: () => void
  onRequestExpand?: () => void
  onNavigate?: () => void
}

const PaymentsNavGroup: React.FC<PaymentsNavGroupProps> = ({
  pathname,
  open,
  items,
  collapsed = false,
  onToggle,
  onRequestExpand,
  onNavigate
}) => {
  const isPaymentsRoute = pathname.startsWith('/transactions')

  if (collapsed) {
    return (
      <button
        type="button"
        {...routePrefetchIntentProps('/transactions')}
        onClick={() => {
          if (!open) onToggle()
          onRequestExpand?.()
        }}
        aria-label="Pagos"
        title="Pagos"
        data-ristak-sidebar-nav-item
        data-active={isPaymentsRoute ? 'true' : undefined}
        className={cn(getNavLinkClasses(isPaymentsRoute, 'w-full', true))}
      >
        <Banknote className="h-5 w-5 flex-shrink-0" />
        <span className="sr-only">Pagos</span>
      </button>
    )
  }

  return (
    <div>
      <button
        type="button"
        {...routePrefetchIntentProps('/transactions')}
        onClick={onToggle}
        aria-expanded={open}
        data-ristak-sidebar-nav-item
        data-active={isPaymentsRoute && !open ? 'true' : undefined}
        className={cn(getNavLinkClasses(isPaymentsRoute && !open, 'w-full'))}
      >
        <Banknote className="h-5 w-5 flex-shrink-0" />
        <span className="flex-1 text-left">Pagos</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 flex-shrink-0 text-[var(--text-mute)] transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div className="ml-[1.55rem] mt-1 space-y-0.5 border-l border-[var(--border)] pl-2.5">
          {items.map((child) => {
            const childActive = child.exact ? pathname === child.to : pathname.startsWith(child.to)
            return (
              <Link
                key={child.to}
                to={child.to}
                {...routePrefetchIntentProps(child.to)}
                onClick={onNavigate}
                data-ristak-sidebar-nav-item
                data-ristak-sidebar-subnav-item
                data-active={childActive ? 'true' : undefined}
                className={getNavChildLinkClasses(childActive)}
              >
                {child.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

interface MdpProgramSidebarBlockProps {
  pathname: string
  item: NavItem
  title: string
  collapsed?: boolean
  showSeparator?: boolean
  onNavigate?: () => void
}

const MdpProgramSidebarBlock: React.FC<MdpProgramSidebarBlockProps> = ({
  pathname,
  item,
  title,
  collapsed = false,
  showSeparator = true,
  onNavigate
}) => {
  const Icon = item.icon
  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)

  return (
    <div data-ristak-mdp-sidebar-block className="space-y-1">
      {!collapsed && (
        <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase text-[var(--text-mute)]">
          <span className="block truncate">{title}</span>
        </div>
      )}

      <Link
        to={item.href}
        {...routePrefetchIntentProps(item.href)}
        onClick={onNavigate}
        aria-label={item.name}
        title={collapsed ? item.name : undefined}
        data-ristak-sidebar-nav-item
        data-ristak-mdp-sidebar-item
        data-active={isActive ? 'true' : undefined}
        className={getNavLinkClasses(isActive, undefined, collapsed)}
      >
        <Icon className="h-5 w-5 flex-shrink-0" />
        <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{item.name}</span>
      </Link>

      {showSeparator && (
        <div className="py-2" aria-hidden="true">
          <div className="border-t border-[var(--border)]" />
        </div>
      )}
    </div>
  )
}

const NavigationItem: React.FC<NavigationItemProps> = ({ item, isActive, collapsed = false, onNavigate }) => {
  const Icon = item.icon

  if (item.isDivider) {
    return (
      <div className="py-2">
        <div className="border-t border-[var(--border)]" />
      </div>
    )
  }

  if (item.isAction) {
    return (
      <button
        type="button"
        onClick={() => item.action?.()}
        aria-label={item.name}
        title={collapsed ? item.name : undefined}
        data-ristak-sidebar-nav-item
        className={getNavLinkClasses(false, 'w-full', collapsed)}
      >
        <Icon className="h-5 w-5 flex-shrink-0" />
        <span className={collapsed ? 'sr-only' : undefined}>{item.name}</span>
      </button>
    )
  }

  return (
    <Link
      to={item.href}
      {...routePrefetchIntentProps(item.href)}
      onClick={() => {
        onNavigate?.()
      }}
      aria-label={item.name}
      title={collapsed ? item.name : undefined}
      data-ristak-sidebar-nav-item
      data-active={isActive ? 'true' : undefined}
      className={getNavLinkClasses(isActive, undefined, collapsed)}
    >
      <Icon className="h-5 w-5 flex-shrink-0" />
      <span className={collapsed ? 'sr-only' : undefined}>{item.name}</span>
    </Link>
  )
}

const SortableItem: React.FC<SortableItemProps> = ({ item, isActive, isDragging, isEditMode, onNavigate }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging: isSortableDragging
  } = useSortable({ id: item.id })

  const Icon = item.icon

  const style = {
    transform: CSS.Transform.toString(transform),
    transition
  }

  if (item.isDivider) {
    return (
      <div ref={setNodeRef} style={style} className="relative py-2">
        <div className="border-t border-[var(--border)]" />
      </div>
    )
  }

  if (item.isAction) {
    return (
      <div ref={setNodeRef} style={style} className="relative">
        <button
          type="button"
          onClick={() => {
            if (isDragging || isEditMode) return
            item.action?.()
          }}
          data-ristak-sidebar-nav-item
          className={getNavLinkClasses(false, cn('w-full', isSortableDragging ? 'opacity-50' : undefined))}
        >
          {isEditMode && (
            <button
              type="button"
              className={cn(
                'cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-white/[0.1] transition-colors',
                'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
              )}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}
          <Icon className="h-5 w-5 flex-shrink-0" />
          <span>{item.name}</span>
        </button>
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} className="relative">
      <Link
        to={item.href}
        {...routePrefetchIntentProps(item.href)}
        onClick={(e) => {
          if (isDragging || isEditMode) {
            e.preventDefault()
            return
          }
          onNavigate?.()
        }}
        data-ristak-sidebar-nav-item
        data-active={isActive ? 'true' : undefined}
        className={getNavLinkClasses(isActive, isSortableDragging ? 'opacity-50' : undefined)}
      >
        {isEditMode && (
          <button
            type="button"
            className={cn(
              'cursor-grab active:cursor-grabbing p-0.5 rounded hover:bg-white/[0.1] transition-colors',
              'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
            )}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <Icon className="h-5 w-5 flex-shrink-0" />
        <span>{item.name}</span>
      </Link>
    </div>
  )
}

export const Sidebar: React.FC<SidebarProps> = ({
  collapsed = false,
  onCollapsedChange,
  onNavigate,
  onLogout
}) => {
  const location = useLocation()
  const {
    theme,
    toggleTheme,
    themeSource,
    resetToSystem,
    isSystemTheme,
    themeDir,
    setThemeDir,
    themeFamilies
  } = useTheme()
  const { user } = useAuth()
  const settingsDestination = useMemo(() => getFirstAllowedSettingsPath(user), [user])
  const canPreloadSites = hasModuleAccess(user, 'sites', 'read')

  useEffect(() => cancelAllSidebarRoutePrefetches, [])

  // Sites incluye un editor grande. Lo calentamos solamente después de que la
  // ruta actual quedó estable, con permiso real, red apropiada y tiempo ocioso.
  // Si el navegador no ofrece requestIdleCallback, no forzamos el parseo pesado.
  useEffect(() => {
    if (!canPreloadSites || location.pathname.startsWith('/sites')) return

    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string }
    }).connection
    const effectiveType = connection?.effectiveType?.toLowerCase()
    if (connection?.saveData || effectiveType === 'slow-2g' || effectiveType === '2g') return

    const idleWindow = window as typeof window & {
      requestIdleCallback?: (callback: () => void) => number
      cancelIdleCallback?: (handle: number) => void
    }
    if (!idleWindow.requestIdleCallback) return

    let idleHandle: number | undefined
    const stableTimer = window.setTimeout(() => {
      if (document.visibilityState !== 'visible') return
      idleHandle = idleWindow.requestIdleCallback?.(() => {
        if (document.visibilityState !== 'visible') return
        void prefetchRouteModule('/sites').catch(() => undefined)
      })
    }, SITES_IDLE_PREFETCH_STABLE_MS)

    return () => {
      window.clearTimeout(stableTimer)
      if (idleHandle !== undefined) idleWindow.cancelIdleCallback?.(idleHandle)
    }
  }, [canPreloadSites, location.pathname])

  const { isInitialized } = useInitialization()
  const [sidebarOrder, setSidebarOrder] = useAppConfig<string[]>('sidebar_navigation_order', [])
  const appVersion = useAppVersion()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const isPaymentsRoute = location.pathname.startsWith('/transactions')
  const [paymentsOpen, setPaymentsOpen] = useState(isPaymentsRoute)
  const mdpProgramMenuLabel = user?.licenseExternalModules?.mdp_program?.menuLabel || 'Magnetismo'

  // Sincronizar el estado de los grupos con la ruta actual
  useEffect(() => {
    setPaymentsOpen(isPaymentsRoute)
  }, [isPaymentsRoute])

  const visiblePaymentsNavigation = useMemo(
    () => PAYMENTS_NAV_ITEMS.filter((item) => !item.featureKeys || hasLicenseFeature(user, item.featureKeys)),
    [user]
  )
  useEffect(() => {
    if (!collapsed) return
    setIsEditMode(false)
  }, [collapsed])
  const longPressTimerRef = React.useRef<number | null>(null)
  const longPressStartPos = React.useRef<{ x: number; y: number } | null>(null)
  const userMenuRef = React.useRef<HTMLDivElement>(null)

  const accountMenuLabel = user?.businessName || user?.email || user?.name || user?.username || 'Usuario'
  const initials = getInitials(accountMenuLabel, user?.email)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8 // Requiere mover 8px para activar drag
      }
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates
    })
  )

  const startLongPress = (e: React.PointerEvent) => {
    if (collapsed) {
      return
    }
    if (isEditMode) {
      return
    }
    // Guardar posición inicial
    longPressStartPos.current = { x: e.clientX, y: e.clientY }

    longPressTimerRef.current = window.setTimeout(() => {
      setIsEditMode(true)
      longPressTimerRef.current = null
    }, 800) // 800ms para activar modo edición
  }

  const cancelLongPress = (e?: React.PointerEvent) => {
    // Si se movió más de 10px, cancelar
    if (e && longPressStartPos.current) {
      const deltaX = Math.abs(e.clientX - longPressStartPos.current.x)
      const deltaY = Math.abs(e.clientY - longPressStartPos.current.y)
      if (deltaX > 10 || deltaY > 10) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current)
          longPressTimerRef.current = null
        }
      }
    }

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartPos.current = null
  }

  // Limpiar timer cuando se desmonta
  React.useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (!showUserMenu) return

    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserMenu])

  const navigation = useMemo(() => {
    const items = getNavigationItems(user)
    return withInitializationNavigation(
      applyNavigationOrder(items, sidebarOrder),
      user,
      isInitialized
    )
  }, [sidebarOrder, isInitialized, user])

  const handleDragStart = (event: DragStartEvent) => {
    if (!isEditMode) {
      return
    }
    setActiveId(event.active.id as string)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    if (!isEditMode) {
      setActiveId(null)
      return
    }
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = navigation.findIndex(item => item.id === active.id)
      const newIndex = navigation.findIndex(item => item.id === over.id)

      if (oldIndex >= 0 && newIndex >= 0) {
        const newOrder = arrayMove(navigation, oldIndex, newIndex)
        void setSidebarOrder(newOrder.map(item => item.id))
      }
    }

    setActiveId(null)
    // Salir del modo edición después de arrastrar
    setIsEditMode(false)
  }

  const handleNavigate = () => {
    cancelLongPress()
    setIsEditMode(false)
    setShowUserMenu(false)
    onNavigate?.()
  }

  const handleRequestExpand = () => {
    onCollapsedChange?.(false)
  }

  const handleToggleCollapsed = () => {
    const nextCollapsed = !collapsed
    if (nextCollapsed) {
      setIsEditMode(false)
      setShowUserMenu(false)
    }
    onCollapsedChange?.(nextCollapsed)
  }

  const activeItem = activeId ? navigation.find(item => item.id === activeId) : null

  return (
    <div data-ristak-sidebar data-collapsed={collapsed ? 'true' : undefined} className="flex h-full flex-col">
      {/* Header con cuenta */}
      <div
        data-ristak-sidebar-header
        className="relative flex items-stretch border-b border-[var(--border)]"
        style={{ height: 'var(--header-height)' }}
      >
        <div ref={userMenuRef} className="relative flex min-w-0 flex-1 items-center">
          <button
            type="button"
            className={cn(
              'flex h-full min-w-0 flex-1 items-center text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
              collapsed ? 'justify-center px-0' : 'px-4'
            )}
            onClick={() => setShowUserMenu((current) => !current)}
            aria-label={collapsed ? `Abrir menú de ${accountMenuLabel}` : undefined}
            aria-expanded={showUserMenu}
            aria-haspopup="menu"
            title={collapsed ? accountMenuLabel : undefined}
          >
            <span className={cn(
              'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]',
              collapsed ? 'mx-0' : 'ml-1.5 mr-3'
            )}>
              {initials}
            </span>
            {!collapsed && (
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-[var(--text)]">
                  {accountMenuLabel}
                </span>
              </span>
            )}
            {!collapsed && (
              <ChevronDown
                className={cn(
                  'ml-3 h-3.5 w-3.5 flex-shrink-0 text-[var(--text-mute)] transition-transform',
                  showUserMenu && 'rotate-180'
                )}
              />
            )}
          </button>

          {showUserMenu && (
            <div
              data-ristak-user-menu
              className="absolute left-[calc(100%_+_0.5rem)] top-2 z-[var(--z-index-popover)] flex max-h-[calc(100vh_-_1rem)] w-[min(22rem,calc(100vw_-_100%_-_1rem))] flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-pop)]"
              role="menu"
            >
              <div className="border-b border-[var(--border)] p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-sm font-semibold text-[var(--accent)]">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--text)]">{accountMenuLabel}</p>
                  </div>
                </div>
              </div>

              <div className="min-h-0 overflow-y-auto py-2">
                <Link
                  to={settingsDestination}
                  {...routePrefetchIntentProps(settingsDestination)}
                  onClick={handleNavigate}
                  className="flex min-h-[40px] items-center gap-3 px-4 py-2.5 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
                  role="menuitem"
                >
                  <Settings className="h-4 w-4" />
                  Configuración
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false)
                    onLogout?.()
                  }}
                  className="flex min-h-[40px] w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-[var(--neg)] transition-colors hover:bg-[var(--neg-soft)]"
                  role="menuitem"
                >
                  <LogOut className="h-4 w-4" />
                  Cerrar sesión
                </button>

                <div className="mx-4 my-2 border-t border-[var(--border)]" />

                <div className="px-4 py-2">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-[var(--text-mute)]">
                    <Palette className="h-3.5 w-3.5" />
                    Diseño de app
                  </div>
                  <div className="space-y-2.5">
                    {themeFamilies.map((family) => (
                      <div key={family.id}>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-mute)]">
                          {family.label}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {family.variants.map((variant) => {
                            const isActive = variant.dir === themeDir
                            return (
                              <button
                                key={variant.dir}
                                type="button"
                                title={`${family.label} · ${variant.label}`}
                                onClick={() => setThemeDir(variant.dir)}
                                aria-pressed={isActive}
                                className={cn(
                                  'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                                  isActive
                                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]'
                                    : 'border-[var(--border)] text-[var(--text-dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]'
                                )}
                              >
                                {variant.label}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={toggleTheme}
                      className="flex min-h-[42px] items-center justify-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text)] transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                      {theme === 'light' ? 'Modo noche' : 'Modo claro'}
                    </button>
                    <button
                      type="button"
                      onClick={resetToSystem}
                      disabled={isSystemTheme}
                      className={cn(
                        'flex min-h-[42px] items-center justify-center gap-2 rounded-[var(--radius-ctl)] border border-[var(--border)] px-3 py-2 text-sm font-medium text-[var(--text)] transition-colors',
                        isSystemTheme ? 'opacity-70' : 'hover:bg-[var(--surface-hover)]'
                      )}
                    >
                      {isSystemTheme && <Check className="h-4 w-4 text-[var(--pos)]" />}
                      {themeSource === 'system' ? 'Automático' : 'Auto'}
                    </button>
                  </div>
                </div>

                {appVersion && (
                  <>
                    <div className="mx-4 my-2 border-t border-[var(--border)]" />
                    <p className="px-4 pb-1 pt-0.5 text-xs text-[var(--text-mute)]">
                      Versión {appVersion}
                    </p>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Navigation */}
      <nav className={cn(
        "flex-1 min-h-0 overflow-y-auto transition-all duration-200",
        collapsed ? 'p-3 pt-3' : 'p-4 pt-3',
        isEditMode && "mx-2 rounded-lg bg-[var(--surface-2)]"
      )}>
        {isEditMode && (
          <div className="mb-3 rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-xs text-[var(--text-mute)]">
            <span className="flex items-center gap-2">
              <span className="flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-[var(--accent)] opacity-75"></span>
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--accent)]"></span>
              </span>
              Modo edición - Arrastra para reordenar
            </span>
          </div>
        )}

        {isEditMode ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={navigation.map(item => item.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-1">
                {navigation.map((item) => {
                  const isActive = location.pathname.startsWith(item.href)
                  return (
                    <SortableItem
                      key={item.id}
                      item={item}
                      isActive={isActive}
                      isDragging={!!activeId}
                      isEditMode={isEditMode}
                      onNavigate={handleNavigate}
                    />
                  )
                })}
              </div>
            </SortableContext>

            {/* Drag Overlay - Item que se muestra mientras arrastras */}
            <DragOverlay>
              {activeItem ? (
                <div className="glass rounded-lg px-3 py-2.5 flex items-center gap-3 shadow-lg">
                  <GripVertical className="h-4 w-4 text-[var(--color-text-tertiary)]" />
                  <activeItem.icon className="h-5 w-5 flex-shrink-0" />
                  <span className="text-sm font-medium">{activeItem.name}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <div
            className="space-y-1"
            onPointerDown={startLongPress}
            onPointerMove={(e) => {
              if (longPressTimerRef.current && longPressStartPos.current) {
                const deltaX = Math.abs(e.clientX - longPressStartPos.current.x)
                const deltaY = Math.abs(e.clientY - longPressStartPos.current.y)
                if (deltaX > 10 || deltaY > 10) {
                  cancelLongPress(e)
                }
              }
            }}
            onPointerUp={(e) => cancelLongPress(e)}
            onPointerCancel={(e) => cancelLongPress(e)}
            onPointerLeave={(e) => cancelLongPress(e)}
          >
            {navigation.map((item, index) => {
              const isActive = location.pathname.startsWith(item.href)
              const nextItem = navigation[index + 1]
              return (
                item.id === 'transactions' ? (
                  <PaymentsNavGroup
                    key={item.id}
                    pathname={location.pathname}
                    open={paymentsOpen}
                    items={visiblePaymentsNavigation}
                    collapsed={collapsed}
                    onToggle={() => setPaymentsOpen((current) => !current)}
                    onRequestExpand={handleRequestExpand}
                    onNavigate={handleNavigate}
                  />
                ) : item.isMdpProgram ? (
                  <MdpProgramSidebarBlock
                    key={item.id}
                    pathname={location.pathname}
                    item={item}
                    title={mdpProgramMenuLabel}
                    collapsed={collapsed}
                    showSeparator={Boolean(nextItem && !nextItem.isDivider)}
                    onNavigate={handleNavigate}
                  />
                ) : (
                  <NavigationItem
                    key={item.id}
                    item={item}
                    isActive={isActive}
                    collapsed={collapsed}
                    onNavigate={handleNavigate}
                  />
                )
              )
            })}
          </div>
        )}
      </nav>

      <div data-ristak-sidebar-footer className="p-3">
        <button
          type="button"
          onClick={handleToggleCollapsed}
          aria-label={collapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
          title={collapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'}
          data-ristak-sidebar-nav-item
          className={cn(
            'flex min-h-[42px] w-full items-center rounded-lg text-sm font-medium text-[var(--text-mute)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
            collapsed ? 'justify-center px-0' : 'justify-between gap-3 px-3'
          )}
        >
          {collapsed ? (
            <ChevronRight className="h-5 w-5 flex-shrink-0" />
          ) : (
            <>
              <span className="flex min-w-0 items-center gap-3">
                <ChevronLeft className="h-5 w-5 flex-shrink-0" />
                <span className="truncate">Contraer menú</span>
              </span>
            </>
          )}
        </button>
        <div className="my-2 border-t border-[var(--border)]" />
        <SettingsNavLink
          pathname={location.pathname}
          destination={settingsDestination}
          collapsed={collapsed}
          onNavigate={handleNavigate}
        />
      </div>
    </div>
  )
}
