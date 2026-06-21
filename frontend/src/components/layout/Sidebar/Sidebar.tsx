import React, { useEffect, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  FileBarChart,
  Megaphone,
  Banknote,
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
  MessageCircle,
  Moon,
  Palette,
  Rocket,
  Sun,
  BotMessageSquare
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAppConfig, useAppVersion } from '@/hooks'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { useInitialization } from '@/contexts/InitializationContext'
import {
  AI_AGENT_NAV_ITEMS,
  hasModuleAccess,
  hasLicenseFeature,
  type AccessControlledUser,
  type AIAgentNavItem,
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
import automationsService from '@/services/automationsService'
import { getIntegrationsStatus } from '@/services/integrationsService'

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
  action?: () => void
}

interface SidebarNavChild {
  to: string
  label: string
  exact?: boolean
}

const PAYMENTS_NAV_ITEMS: SidebarNavChild[] = [
  { to: '/transactions', label: 'Transacciones', exact: true },
  { to: '/transactions/payment-plans', label: 'Planes de pago' },
  { to: '/transactions/subscriptions', label: 'Suscripciones' },
  { to: '/transactions/products', label: 'Productos' }
]

const baseNavigation: NavItem[] = [
  { id: 'dashboard', name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { id: 'chat', name: 'Chat', href: '/chat', icon: MessageCircle },
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

const navPermissionById: Partial<Record<string, PermissionKey>> = {
  dashboard: 'dashboard',
  chat: 'chat',
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

const getNavigationItems = (user?: AccessControlledUser | null): NavItem[] => {
  return cleanNavigationDividers(baseNavigation.filter((item) => {
    if (item.isDivider) return true
    const permissionKey = navPermissionById[item.id]
    return !permissionKey || hasModuleAccess(user, permissionKey, 'read')
  }))
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

interface SettingsNavLinkProps {
  pathname: string
  collapsed?: boolean
  onNavigate?: () => void
}

const SettingsNavLink: React.FC<SettingsNavLinkProps> = ({ pathname, collapsed = false, onNavigate }) => {
  const isSettingsRoute = pathname.startsWith('/settings')

  return (
    <Link
      to="/settings"
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

interface AIAgentNavGroupProps {
  pathname: string
  open: boolean
  items: ReadonlyArray<AIAgentNavItem>
  collapsed?: boolean
  onToggle: () => void
  onRequestExpand?: () => void
  onNavigate?: () => void
}

const AIAgentNavGroup: React.FC<AIAgentNavGroupProps> = ({
  pathname,
  open,
  items,
  collapsed = false,
  onToggle,
  onRequestExpand,
  onNavigate
}) => {
  const isAIAgentRoute = pathname.startsWith('/ai-agent')

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => {
          if (!open) onToggle()
          onRequestExpand?.()
        }}
        aria-label="Agente AI"
        title="Agente AI"
        data-ristak-sidebar-nav-item
        data-active={isAIAgentRoute ? 'true' : undefined}
        className={cn(getNavLinkClasses(isAIAgentRoute, 'w-full', true))}
      >
        <BotMessageSquare className="h-5 w-5 flex-shrink-0" />
        <span className="sr-only">Agente AI</span>
      </button>
    )
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-ristak-sidebar-nav-item
        data-active={isAIAgentRoute && !open ? 'true' : undefined}
        className={cn(getNavLinkClasses(isAIAgentRoute && !open, 'w-full'))}
      >
        <BotMessageSquare className="h-5 w-5 flex-shrink-0" />
        <span className="flex-1 text-left">Agente AI</span>
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
  // Precalienta la librería de automatizaciones (abre sin parpadeo)
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      void automationsService.getOverview().catch(() => undefined)
    }, 2500)
    return () => window.clearTimeout(timer)
  }, [])

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
  const { isInitialized } = useInitialization()
  const [sidebarOrder, setSidebarOrder] = useAppConfig<string[]>('sidebar_navigation_order', [])
  const appVersion = useAppVersion()
  const [navigation, setNavigation] = useState<NavItem[]>(() => [])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const isAIAgentRoute = location.pathname.startsWith('/ai-agent')
  const isPaymentsRoute = location.pathname.startsWith('/transactions')
  const [aiAgentOpen, setAiAgentOpen] = useState(isAIAgentRoute)
  const [paymentsOpen, setPaymentsOpen] = useState(isPaymentsRoute)
  const [paymentCapabilities, setPaymentCapabilities] = useState({
    paymentPlans: false,
    subscriptions: false
  })

  // Sincronizar el estado de los grupos con la ruta actual
  useEffect(() => {
    setAiAgentOpen(isAIAgentRoute)
  }, [isAIAgentRoute])

  useEffect(() => {
    setPaymentsOpen(isPaymentsRoute)
  }, [isPaymentsRoute])

  useEffect(() => {
    let cancelled = false

    getIntegrationsStatus()
      .then((status) => {
        if (cancelled) return
        const stripe = Boolean(status?.stripe?.connected)
        const mercadoPago = Boolean(status?.mercadopago?.connected)
        const highlevel = Boolean(status?.highlevel?.connected)
        setPaymentCapabilities({
          paymentPlans: stripe || mercadoPago || highlevel,
          subscriptions: stripe || mercadoPago
        })
      })
      .catch(() => {
        if (!cancelled) {
          setPaymentCapabilities({
            paymentPlans: false,
            subscriptions: false
          })
        }
      })

    return () => {
      cancelled = true
    }
  }, [location.pathname])

  const visiblePaymentsNavigation = useMemo(() => (
    PAYMENTS_NAV_ITEMS.filter((item) => {
      if (item.to === '/transactions/payment-plans') return paymentCapabilities.paymentPlans
      if (item.to === '/transactions/subscriptions') return paymentCapabilities.subscriptions
      return true
    })
  ), [paymentCapabilities.paymentPlans, paymentCapabilities.subscriptions])

  useEffect(() => {
    if (!collapsed) return
    setIsEditMode(false)
  }, [collapsed])
  const longPressTimerRef = React.useRef<number | null>(null)
  const longPressStartPos = React.useRef<{ x: number; y: number } | null>(null)
  const userMenuRef = React.useRef<HTMLDivElement>(null)

  const accountMenuLabel = user?.businessName || user?.email || user?.name || user?.username || 'Usuario'
  const initials = getInitials(accountMenuLabel, user?.email)
  const canUseAIAgent = hasModuleAccess(user, 'ai_agent', 'read')
  const visibleAIAgentNavigation = useMemo(
    () => AI_AGENT_NAV_ITEMS.filter((item) => hasLicenseFeature(user, item.featureKeys)),
    [user]
  )

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

  // Aplicar orden guardado a los items
  const applyOrder = (items: NavItem[], order: string[]): NavItem[] => {
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

    // Items nuevos no presentes en el orden guardado van al final
    itemsById.forEach(item => {
      orderedItems.push(item)
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

  // Prepone Inicialización (siempre primero) cuando el onboarding no está completo.
  const withInitialization = (items: NavItem[]): NavItem[] =>
    isInitialized || user?.role !== 'admin' ? items : [initializationNavigation, ...items]

  useEffect(() => {
    const items = getNavigationItems(user)
    setNavigation(withInitialization(applyOrder(items, sidebarOrder)))
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
      setNavigation((items) => {
        const oldIndex = items.findIndex(item => item.id === active.id)
        const newIndex = items.findIndex(item => item.id === over.id)

        const newOrder = arrayMove(items, oldIndex, newIndex)

        // Guardar orden en la base de datos
        setSidebarOrder(newOrder.map(item => item.id))

        return newOrder
      })
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
              className="absolute left-2 top-[calc(100%-0.5rem)] z-[var(--z-index-popover)] w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-[rgba(148,163,184,0.18)] bg-[var(--color-background-secondary)] shadow-xl"
              role="menu"
            >
              <div className="border-b border-[rgba(148,163,184,0.1)] p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--accent-soft)] text-sm font-semibold text-[var(--accent)]">
                    {initials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{accountMenuLabel}</p>
                  </div>
                </div>
              </div>

              <div className="py-2">
                <div className="px-4 py-2">
                  <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-[var(--color-text-tertiary)]">
                    <Palette className="h-3.5 w-3.5" />
                    Diseño de app
                  </div>
                  <div className="space-y-2.5">
                    {themeFamilies.map((family) => (
                      <div key={family.id}>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
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
                                    ? 'border-[var(--color-primary)] bg-[rgba(var(--color-primary-rgb),0.14)] text-[var(--color-text-primary)]'
                                    : 'border-[rgba(148,163,184,0.18)] text-[var(--color-text-secondary)] hover:bg-[rgba(148,163,184,0.12)]'
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

                <div className="mx-4 my-2 border-t border-[rgba(148,163,184,0.12)]" />

                <Link
                  to="/settings"
                  onClick={handleNavigate}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm text-[var(--color-text-primary)] transition-colors hover:glass-hover"
                  role="menuitem"
                >
                  <Settings className="h-4 w-4" />
                  Configuración
                </Link>
                <div className="mx-4 my-2 border-t border-[rgba(148,163,184,0.12)]" />
                <button
                  type="button"
                  onClick={() => {
                    setShowUserMenu(false)
                    onLogout?.()
                  }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-[var(--neg)] transition-colors hover:glass-hover"
                  role="menuitem"
                >
                  <LogOut className="h-4 w-4" />
                  Cerrar sesión
                </button>

                {appVersion && (
                  <>
                    <div className="mx-4 my-2 border-t border-[rgba(148,163,184,0.12)]" />
                    <p className="px-4 pb-1 pt-0.5 text-xs text-[var(--color-text-tertiary)]">
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

            {canUseAIAgent && visibleAIAgentNavigation.length > 0 && (
              <AIAgentNavGroup
                pathname={location.pathname}
                open={aiAgentOpen}
                items={visibleAIAgentNavigation}
                onToggle={() => setAiAgentOpen((current) => !current)}
                onRequestExpand={handleRequestExpand}
                onNavigate={handleNavigate}
              />
            )}
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
            {navigation.map((item) => {
              const isActive = location.pathname.startsWith(item.href)
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

            {canUseAIAgent && visibleAIAgentNavigation.length > 0 && (
              <AIAgentNavGroup
                pathname={location.pathname}
                open={aiAgentOpen}
                items={visibleAIAgentNavigation}
                collapsed={collapsed}
                onToggle={() => setAiAgentOpen((current) => !current)}
                onRequestExpand={handleRequestExpand}
                onNavigate={handleNavigate}
              />
            )}
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
          collapsed={collapsed}
          onNavigate={handleNavigate}
        />
      </div>
    </div>
  )
}
