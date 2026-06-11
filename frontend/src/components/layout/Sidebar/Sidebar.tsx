import React, { useEffect, useState } from 'react'
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
  LogOut,
  Moon,
  Palette,
  Sun
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { useAppConfig, useAppVersion, useIsRenderDomain } from '@/hooks'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { settingsNavigation } from '@/pages/Settings/settingsNav'
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

interface SidebarProps {
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
}

const baseNavigation: NavItem[] = [
  { id: 'dashboard', name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { id: 'appointments', name: 'Citas', href: '/appointments', icon: Calendar },
  { id: 'transactions', name: 'Pagos', href: '/transactions', icon: Banknote },
  { id: 'contacts', name: 'Contactos', href: '/contacts', icon: Users },
  { id: 'divider-1', name: '', href: '#', icon: LayoutDashboard, isDivider: true }, // Divisor visual
  { id: 'campaigns', name: 'Publicidad', href: '/campaigns/classic', icon: Megaphone },
  { id: 'sites', name: 'Sitios', href: '/sites', icon: PanelTop },
  { id: 'automations', name: 'Automatizaciones', href: '/automations', icon: Workflow },
  { id: 'reports', name: 'Reportes', href: '/reports/table/month/cashflow', icon: FileBarChart }
]

const analyticsNavigation: NavItem = {
  id: 'analytics',
  name: 'Analíticas',
  href: '/analytics',
  icon: BarChart3
}

const getNavigationItems = (_showAnalytics: boolean, _isRenderDomain: boolean): NavItem[] => {
  return [...baseNavigation, analyticsNavigation]
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
  onNavigate?: () => void
}

interface SortableItemProps {
  item: NavItem
  isActive: boolean
  isDragging: boolean
  isEditMode: boolean
  onNavigate?: () => void
}

const getNavLinkClasses = (isActive: boolean, extraClasses?: string) => cn(
  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
  isActive
    ? 'bg-[rgba(148,163,184,0.16)] text-[var(--color-text-primary)] dark:shadow-[0_10px_20px_-16px_rgba(15,23,42,0.45)]'
    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[rgba(148,163,184,0.12)]',
  extraClasses
)

interface SettingsNavGroupProps {
  pathname: string
  open: boolean
  onToggle: () => void
  onNavigate?: () => void
}

// Grupo expandible de Configuración (estilo Cloudflare): el padre vive en la
// misma lista del sidebar y al expandirse muestra las secciones anidadas con
// una guía vertical. El estado activo reutiliza la misma receta visual que el
// resto de los items del panel.
const SettingsNavGroup: React.FC<SettingsNavGroupProps> = ({ pathname, open, onToggle, onNavigate }) => {
  const isSettingsRoute = pathname.startsWith('/settings')

  return (
    <div className="pt-2">
      <div className="mb-2 border-t border-[rgba(148,163,184,0.12)]" />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-ristak-sidebar-nav-item
        data-active={isSettingsRoute && !open ? 'true' : undefined}
        className={cn(getNavLinkClasses(isSettingsRoute && !open, 'w-full'))}
      >
        <Settings className="h-5 w-5 flex-shrink-0" />
        <span className="flex-1 text-left">Configuración</span>
        <ChevronDown
          className={cn(
            'h-4 w-4 flex-shrink-0 text-[var(--color-text-tertiary)] transition-transform',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div className="ml-[1.55rem] mt-1 space-y-0.5 border-l border-[rgba(148,163,184,0.16)] pl-2.5">
          {settingsNavigation.map((item) => {
            const isActive = pathname.startsWith(item.to)
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onNavigate}
                data-ristak-sidebar-nav-item
                data-active={isActive ? 'true' : undefined}
                className={cn(
                  'block rounded-md px-2.5 py-[7px] text-[13px] font-medium transition-colors',
                  isActive
                    ? 'bg-[rgba(148,163,184,0.16)] text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-tertiary)] hover:bg-[rgba(148,163,184,0.1)] hover:text-[var(--color-text-primary)]'
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

const NavigationItem: React.FC<NavigationItemProps> = ({ item, isActive, onNavigate }) => {
  const Icon = item.icon

  // Si es un divisor, renderizar una línea horizontal
  if (item.isDivider) {
    return (
      <div className="py-2">
        <div className="border-t border-[rgba(148,163,184,0.12)]" />
      </div>
    )
  }

  return (
    <Link
      to={item.href}
      onClick={() => {
        onNavigate?.()
      }}
      data-ristak-sidebar-nav-item
      data-active={isActive ? 'true' : undefined}
      className={getNavLinkClasses(isActive)}
    >
      <Icon className="h-5 w-5 flex-shrink-0" />
      <span>{item.name}</span>
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

  // Si es un divisor, renderizar una línea horizontal
  if (item.isDivider) {
    return (
      <div ref={setNodeRef} style={style} className="relative py-2">
        <div className="border-t border-[rgba(148,163,184,0.12)]" />
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

export const Sidebar: React.FC<SidebarProps> = ({ onNavigate, onLogout }) => {
  const location = useLocation()
  const {
    theme,
    toggleTheme,
    themeSource,
    resetToSystem,
    isSystemTheme,
    designPreset,
    setDesignPreset,
    designPresets
  } = useTheme()
  const { user } = useAuth()
  const [analyticsEnabled] = useAppConfig<boolean>('show_analytics', false)
  const [sidebarOrder, setSidebarOrder] = useAppConfig<string[]>('sidebar_navigation_order', [])
  const isRenderDomain = useIsRenderDomain() // Detectar si es dominio .onrender.com
  const appVersion = useAppVersion() // Versión instalada (se muestra al pie del menú de usuario)
  const [navigation, setNavigation] = useState<NavItem[]>(() => getNavigationItems(false, isRenderDomain))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const [showUserMenu, setShowUserMenu] = useState(false)
  const isSettingsRoute = location.pathname.startsWith('/settings')
  const [settingsOpen, setSettingsOpen] = useState(isSettingsRoute)

  // Mantener el grupo abierto mientras se navega dentro de Configuración
  useEffect(() => {
    if (isSettingsRoute) setSettingsOpen(true)
  }, [isSettingsRoute])
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
    const placeSitesAfterCampaigns = (orderedItems: NavItem[]) => {
      const sitesIndex = orderedItems.findIndex(item => item.id === 'sites')
      const campaignsIndex = orderedItems.findIndex(item => item.id === 'campaigns')

      if (sitesIndex === -1 || campaignsIndex === -1 || sitesIndex === campaignsIndex + 1) {
        return orderedItems
      }

      const nextItems = [...orderedItems]
      const [sitesItem] = nextItems.splice(sitesIndex, 1)
      const nextCampaignsIndex = nextItems.findIndex(item => item.id === 'campaigns')
      nextItems.splice(nextCampaignsIndex + 1, 0, sitesItem)
      return nextItems
    }

    if (!order.length) return placeSitesAfterCampaigns(items)

    const itemsById = new Map(items.map(item => [item.id, item]))
    const orderedItems: NavItem[] = []

    // Agregar items en el orden guardado
    order.forEach(id => {
      const item = itemsById.get(id)
      if (item) {
        orderedItems.push(item)
        itemsById.delete(id)
      }
    })

    // Agregar items nuevos que no están en el orden guardado
    itemsById.forEach(item => {
      orderedItems.push(item)
    })

    return placeSitesAfterCampaigns(orderedItems)
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

  useEffect(() => {
    const showAnalytics = Boolean(analyticsEnabled)
    const items = getNavigationItems(showAnalytics, isRenderDomain)
    setNavigation(applyOrder(items, sidebarOrder))
  }, [analyticsEnabled, sidebarOrder, isRenderDomain])

  useEffect(() => {
    const handleAnalyticsChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ showAnalytics?: boolean }>
      if (typeof customEvent.detail?.showAnalytics === 'boolean') {
        const showAnalytics = customEvent.detail.showAnalytics
        const items = getNavigationItems(showAnalytics, isRenderDomain)
        setNavigation(applyOrder(items, sidebarOrder))
      }
    }

    window.addEventListener('analytics-preference-changed', handleAnalyticsChange)

    return () => {
      window.removeEventListener('analytics-preference-changed', handleAnalyticsChange)
    }
  }, [sidebarOrder, isRenderDomain])

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

  const activeItem = activeId ? navigation.find(item => item.id === activeId) : null

  return (
    <div data-ristak-sidebar className="flex flex-col h-full">
      {/* Header con cuenta */}
      <div
        data-ristak-sidebar-header
        className="relative flex items-stretch border-b border-[rgba(148,163,184,0.12)]"
        style={{ height: 'var(--header-height)' }}
      >
        <div ref={userMenuRef} className="relative flex min-w-0 flex-1 items-center">
          <button
            type="button"
            className="flex h-full min-w-0 flex-1 items-center px-4 text-left transition-colors hover:bg-[rgba(148,163,184,0.08)] focus:outline-none"
            onClick={() => setShowUserMenu((current) => !current)}
            aria-expanded={showUserMenu}
            aria-haspopup="menu"
          >
            <span className="ml-1.5 mr-3 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(255,238,219,0.92)] text-xs font-semibold text-[#2f251b]">
              {initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-[var(--color-text-primary)]">
                {accountMenuLabel}
              </span>
            </span>
            <ChevronDown
              className={cn(
                'ml-3 h-3.5 w-3.5 flex-shrink-0 text-[var(--color-text-tertiary)] transition-transform',
                showUserMenu && 'rotate-180'
              )}
            />
          </button>

          {showUserMenu && (
            <div
              data-ristak-user-menu
              className="absolute left-2 top-[calc(100%-0.5rem)] z-50 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-[rgba(148,163,184,0.18)] bg-[var(--color-background-secondary)] shadow-xl"
              role="menu"
            >
              <div className="border-b border-[rgba(148,163,184,0.1)] p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[rgba(255,238,219,0.92)] text-sm font-semibold text-[#2f251b]">
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
                            isActive && 'border-[rgba(var(--color-primary-rgb),0.28)] bg-[rgba(var(--color-primary-rgb),0.12)]'
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
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-red-500 transition-colors hover:glass-hover"
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
        "flex-1 min-h-0 overflow-y-auto p-4 pt-3 transition-all duration-200",
        isEditMode && "bg-white/[0.02] mx-2 rounded-lg"
      )}>
        {isEditMode && (
          <div className="mb-3 px-2 py-1.5 text-xs text-[var(--color-text-tertiary)] bg-white/[0.05] rounded-md border border-dashed border-[rgba(148,163,184,0.2)]">
            <span className="flex items-center gap-2">
              <span className="flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-1.5 w-1.5 rounded-full bg-[var(--color-accent-blue)] opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-[var(--color-accent-blue)]"></span>
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

            <SettingsNavGroup
              pathname={location.pathname}
              open={settingsOpen}
              onToggle={() => setSettingsOpen((current) => !current)}
              onNavigate={handleNavigate}
            />
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
                <NavigationItem
                  key={item.id}
                  item={item}
                  isActive={isActive}
                  onNavigate={handleNavigate}
                />
              )
            })}

            <SettingsNavGroup
              pathname={location.pathname}
              open={settingsOpen}
              onToggle={() => setSettingsOpen((current) => !current)}
              onNavigate={handleNavigate}
            />
          </div>
        )}
      </nav>
    </div>
  )
}
