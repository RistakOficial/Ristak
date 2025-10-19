import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  GripVertical
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { Logo } from '@/components/common'
import { useAppConfig } from '@/hooks'

interface SidebarProps {
  onNavigate?: () => void
  locationName?: string
  locationLogo?: string | null
}

type IconType = React.ComponentType<React.SVGProps<SVGSVGElement>>

interface NavItem {
  id: string
  name: string
  href: string
  icon: IconType
}

const LONG_PRESS_DELAY = 1000
const SIDEBAR_ORDER_CONFIG_KEY = 'sidebar_navigation_order'

const baseNavigation: NavItem[] = [
  { id: 'dashboard', name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { id: 'reports', name: 'Reportes', href: '/reports', icon: FileBarChart },
  { id: 'campaigns', name: 'Publicidad', href: '/campaigns', icon: Megaphone },
  { id: 'appointments', name: 'Citas', href: '/appointments', icon: Calendar },
  { id: 'transactions', name: 'Pagos', href: '/transactions', icon: Banknote },
  { id: 'contacts', name: 'Contactos', href: '/contacts', icon: Users }
]

const analyticsNavigation: NavItem = {
  id: 'analytics',
  name: 'Analíticas',
  href: '/analytics',
  icon: BarChart3
}

const SHOW_ANALYTICS_STORAGE_KEY = 'showAnalyticsPreference'

const getStoredAnalyticsPreference = () => {
  if (typeof window === 'undefined') return null
  const stored = window.localStorage.getItem(SHOW_ANALYTICS_STORAGE_KEY)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return null
}

const getNavigationItems = (showAnalytics: boolean): NavItem[] => {
  if (!showAnalytics) return baseNavigation

  return [
    baseNavigation[0],
    baseNavigation[1],
    analyticsNavigation,
    ...baseNavigation.slice(2)
  ]
}

const applyOrder = (items: NavItem[], order: string[]): NavItem[] => {
  if (!order.length) return items

  const itemsById = new Map(items.map(item => [item.id, item]))
  const orderedItems: NavItem[] = []

  order.forEach(id => {
    const item = itemsById.get(id)
    if (item) {
      orderedItems.push(item)
      itemsById.delete(id)
    }
  })

  // Append any items that were not in the stored order (new entries, disabled analytics, etc.)
  itemsById.forEach(item => {
    orderedItems.push(item)
  })

  return orderedItems
}

const areOrdersEqual = (a: NavItem[] | null, b: NavItem[] | null) => {
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((item, index) => item.id === b[index]?.id)
}

const reorderNavigationItems = (list: NavItem[], movingId: string, targetId: string) => {
  if (movingId === targetId) return list

  const sourceIndex = list.findIndex(item => item.id === movingId)
  const targetIndex = list.findIndex(item => item.id === targetId)

  if (sourceIndex === -1 || targetIndex === -1) return list

  const result = [...list]
  const [removed] = result.splice(sourceIndex, 1)

  // Insertar en la posición correcta
  const newTargetIndex = result.findIndex(item => item.id === targetId)
  if (sourceIndex < targetIndex) {
    // Moviendo hacia abajo - insertar después del target
    result.splice(newTargetIndex + 1, 0, removed)
  } else {
    // Moviendo hacia arriba - insertar antes del target
    result.splice(newTargetIndex, 0, removed)
  }

  return result
}

const moveItemToEnd = (list: NavItem[], movingId: string) => {
  const sourceIndex = list.findIndex(item => item.id === movingId)
  if (sourceIndex === -1 || sourceIndex === list.length - 1) return list

  const next = [...list]
  const [movingItem] = next.splice(sourceIndex, 1)
  next.push(movingItem)
  return next
}

export const Sidebar: React.FC<SidebarProps> = ({ onNavigate, locationName, locationLogo }) => {
  const location = useLocation()
  const [mounted, setMounted] = useState(false)
  const storedAnalyticsPreference = getStoredAnalyticsPreference()
  const [sidebarOrder, setSidebarOrder] = useAppConfig<string[]>(SIDEBAR_ORDER_CONFIG_KEY, [])
  const [analyticsEnabled] = useAppConfig<boolean>('show_analytics', false)
  const [navigation, setNavigation] = useState<NavItem[]>(() => {
    const initialShowAnalytics = storedAnalyticsPreference ?? false
    return applyOrder(getNavigationItems(initialShowAnalytics), sidebarOrder)
  })
  const [longPressId, setLongPressId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const navItemRefs = useRef<Map<string, HTMLAnchorElement>>(new Map())
  const longPressTimeoutRef = useRef<number | null>(null)
  const dragStartOrderRef = useRef<NavItem[] | null>(null)
  const dropCompletedRef = useRef(false)


  const persistPreference = useCallback((show: boolean) => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(SHOW_ANALYTICS_STORAGE_KEY, String(show))
  }, [])

  const buildNavigationWithPreferences = useCallback((showAnalytics: boolean) => {
    return applyOrder(getNavigationItems(showAnalytics), sidebarOrder)
  }, [sidebarOrder])

  const persistOrder = useCallback(async (items: NavItem[]) => {
    const newOrder = items.map(item => item.id)

    if (JSON.stringify(newOrder) === JSON.stringify(sidebarOrder)) {
      return
    }

    try {
      await setSidebarOrder(newOrder)
    } catch (error) {
      console.error('Error guardando el orden del menú:', error)
    }
  }, [setSidebarOrder, sidebarOrder])

  const clearLongPressTimeout = useCallback(() => {
    if (longPressTimeoutRef.current) {
      window.clearTimeout(longPressTimeoutRef.current)
      longPressTimeoutRef.current = null
    }
  }, [])

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const showAnalytics = Boolean(analyticsEnabled)
    setNavigation(buildNavigationWithPreferences(showAnalytics))
    persistPreference(showAnalytics)
    clearLongPressTimeout()
    setLongPressId(null)
    setDraggingId(null)
    setDropTargetId(null)
    setIsEditing(false)
    dragStartOrderRef.current = null
    dropCompletedRef.current = false
  }, [analyticsEnabled, buildNavigationWithPreferences, persistPreference, clearLongPressTimeout])

  useEffect(() => {
    const handleAnalyticsChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ showAnalytics?: boolean }>
      if (typeof customEvent.detail?.showAnalytics === 'boolean') {
        const showAnalytics = customEvent.detail.showAnalytics
        setNavigation(buildNavigationWithPreferences(showAnalytics))
        persistPreference(showAnalytics)
      }
    }

    window.addEventListener('analytics-preference-changed', handleAnalyticsChange)

    return () => {
      window.removeEventListener('analytics-preference-changed', handleAnalyticsChange)
    }
  }, [buildNavigationWithPreferences, persistPreference])

  useEffect(() => {
    return () => {
      clearLongPressTimeout()
    }
  }, [clearLongPressTimeout])

  const handleNavigate = () => {
    onNavigate?.()
  }

  const handlePointerDown = (id: string) => (_event: React.PointerEvent<HTMLAnchorElement>) => {
    if (draggingId) return

    clearLongPressTimeout()
    if (isEditing) {
      setLongPressId(id)
      return
    }

    longPressTimeoutRef.current = window.setTimeout(() => {
      setLongPressId(id)
      setIsEditing(true)
    }, LONG_PRESS_DELAY)
  }

  const handlePointerUp = (id: string) => (event: React.PointerEvent<HTMLAnchorElement>) => {
    if (draggingId) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    const longPressActive = longPressId === id
    clearLongPressTimeout()

    if (longPressActive) {
      event.preventDefault()
      event.stopPropagation()
    }

    setLongPressId(null)
  }

  const handlePointerCancel = () => {
    clearLongPressTimeout()
    setLongPressId(null)
  }

  const handlePointerLeave = () => {
    if (draggingId) return
    clearLongPressTimeout()
    setLongPressId(null)
  }

  const handleDragStart = (id: string) => (event: React.DragEvent<HTMLAnchorElement>) => {
    if (!isEditing && longPressId !== id) {
      event.preventDefault()
      return
    }

    dragStartOrderRef.current = navigation.slice()
    dropCompletedRef.current = false
    setIsEditing(true)
    setDraggingId(id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)

    // Usar una imagen de drag más simple
    const dragImage = new Image()
    dragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs='
    event.dataTransfer.setDragImage(dragImage, 0, 0)
  }

  const handleDragEnd = () => {
    clearLongPressTimeout()

    if (!dropCompletedRef.current && dragStartOrderRef.current) {
      setNavigation(dragStartOrderRef.current)
    }

    dragStartOrderRef.current = null
    dropCompletedRef.current = false
    setDraggingId(null)
    setDropTargetId(null)
    setLongPressId(null)
    setIsEditing(false)
  }

  const handleDragOver = (id: string) => (event: React.DragEvent<HTMLAnchorElement>) => {
    if (!draggingId || draggingId === id) return
    event.preventDefault()

    // Solo actualizar si cambia el target
    if (dropTargetId !== id) {
      setDropTargetId(id)
      setNavigation(current => reorderNavigationItems(current, draggingId, id))
    }
  }

  const handleDragEnter = (id: string) => (event: React.DragEvent<HTMLAnchorElement>) => {
    if (!draggingId || draggingId === id) return
    event.preventDefault()
    setDropTargetId(id)
  }

  const handleDragLeave = (id: string) => () => {
    if (dropTargetId === id) {
      setDropTargetId(null)
    }
  }

  const handleDrop = (targetId: string) => async (event: React.DragEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()

    if (!draggingId) {
      setIsEditing(false)
      return
    }

    // Aplicar el orden final
    const finalOrder = reorderNavigationItems(navigation, draggingId, targetId)
    setNavigation(finalOrder)

    // Persistir si hubo cambios
    if (!areOrdersEqual(finalOrder, dragStartOrderRef.current)) {
      dropCompletedRef.current = true
      await persistOrder(finalOrder)
    }

    handleDragEnd()
  }

  const handleContainerDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    if (!draggingId) {
      setIsEditing(false)
      return
    }

    // Mover al final
    const finalOrder = moveItemToEnd(navigation, draggingId)
    setNavigation(finalOrder)

    // Persistir si hubo cambios
    if (!areOrdersEqual(finalOrder, dragStartOrderRef.current)) {
      dropCompletedRef.current = true
      await persistOrder(finalOrder)
    }

    handleDragEnd()
  }

  const handleItemClick = (id: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (draggingId || longPressId === id) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    handleNavigate()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-center px-4 gap-2 border-b border-[rgba(148,163,184,0.12)]" style={{ height: 'var(--header-height)' }}>
        {mounted && locationLogo ? (
          // Si hay logo de HighLevel, mostrarlo
          <div className="w-24 h-10 flex items-center justify-center">
            <img
              src={locationLogo}
              alt={locationName || 'Logo'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : mounted && locationName && locationName !== 'Ristak' ? (
          // Si no hay logo pero sí nombre de HighLevel (no es "Ristak"), mostrar el nombre
          <div className="w-full flex items-center justify-center px-2">
            <span className="text-lg font-bold text-[var(--color-text-primary)] truncate max-w-[180px] text-center">
              {locationName}
            </span>
          </div>
        ) : (
          // Si no hay HighLevel o es el nombre por defecto, mostrar logo de Ristak
          <Logo size="2xl" />
        )}
      </div>

      <nav
        className={cn(
          'relative flex-1 p-4 pt-3 transition-all duration-200',
          isEditing
            ? 'bg-white/[0.04] rounded-xl ring-1 ring-[rgba(148,163,184,0.35)] shadow-[0_12px_30px_-12px_rgba(15,23,42,0.45)]'
            : ''
        )}
        onDragOver={(event) => {
          if (!draggingId) return
          event.preventDefault()
        }}
        onDrop={handleContainerDrop}
      >
        {isEditing && (
          <div className="pointer-events-none absolute inset-x-4 bottom-4 z-10 flex items-center justify-between gap-3 rounded-lg border border-dashed border-[rgba(148,163,184,0.28)] bg-white/[0.08] px-3 py-2 text-[10px] font-semibold tracking-[0.28em] text-[var(--color-text-tertiary)] uppercase">
            <span className="flex items-center gap-2 text-[var(--color-text-secondary)]">
              <span className="flex h-2 w-2 items-center justify-center">
                <span className="h-2 w-2 rounded-full bg-[var(--color-text-secondary)] animate-ping" />
              </span>
              Modo edición activo
            </span>
            <span className="hidden text-[var(--color-text-tertiary)] sm:inline">
              Arrastra y suelta para reordenar
            </span>
          </div>
        )}

        <div className="space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon
            const isActive = location.pathname.startsWith(item.href)
            const isPreparing = longPressId === item.id && !draggingId
            const isDragging = draggingId === item.id
            const isDropTarget = dropTargetId === item.id && draggingId !== item.id
            const isDimmed = Boolean(draggingId) && draggingId !== item.id

            return (
              <Link
                key={item.id}
                to={item.href}
                draggable={isPreparing || isDragging}
                onClick={handleItemClick(item.id)}
                onPointerDown={handlePointerDown(item.id)}
                onPointerUp={handlePointerUp(item.id)}
                onPointerLeave={handlePointerLeave}
                onPointerCancel={handlePointerCancel}
                onDragStart={handleDragStart(item.id)}
                onDragEnd={handleDragEnd}
                onDragOver={handleDragOver(item.id)}
                onDragEnter={handleDragEnter(item.id)}
                onDragLeave={handleDragLeave(item.id)}
                onDrop={handleDrop(item.id)}
                ref={(node) => {
                  if (node) {
                    navItemRefs.current.set(item.id, node)
                  } else {
                    navItemRefs.current.delete(item.id)
                  }
                }}
                className={cn(
                  'group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium select-none',
                  'transition-[transform,opacity,background-color] duration-200 ease-out',
                  isDragging
                    ? 'z-10 cursor-grabbing opacity-90 scale-[1.02] bg-white/[0.1] shadow-lg'
                    : isPreparing
                      ? 'cursor-grab bg-white/[0.05]'
                      : 'cursor-pointer',
                  isDropTarget && !isDragging
                    ? 'bg-white/[0.06] scale-[0.98]'
                    : '',
                  isDimmed ? 'opacity-40' : '',
                  isActive
                    ? 'glass text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] glass-hover'
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none absolute left-3 top-1/2 flex h-5 w-5 -translate-x-full -translate-y-1/2 items-center justify-center rounded-md border border-dashed border-transparent transition-all duration-200',
                    isEditing
                      ? 'border-[rgba(148,163,184,0.35)] bg-white/[0.08] opacity-100'
                      : 'opacity-0'
                  )}
                  aria-hidden="true"
                >
                  <GripVertical className="h-3 w-3 text-[var(--color-text-secondary)]" />
                </span>
                <Icon className="h-5 w-5 flex-shrink-0" />
                <span>{item.name}</span>
                {isDragging && (
                  <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold tracking-[0.2em] text-[var(--color-text-secondary)]">
                    MOVIENDO
                    <span className="flex items-center gap-[2px]">
                      <span className="h-1 w-1 rounded-full bg-[var(--color-text-secondary)] animate-pulse" />
                      <span className="h-1 w-1 rounded-full bg-[var(--color-text-secondary)] animate-pulse [animation-delay:120ms]" />
                      <span className="h-1 w-1 rounded-full bg-[var(--color-text-secondary)] animate-pulse [animation-delay:240ms]" />
                    </span>
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      </nav>

      <div className="mt-auto p-4 border-t border-[rgba(148,163,184,0.12)]">
        <Link
          to="/settings"
          onClick={handleNavigate}
          className={cn(
            'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
            location.pathname.startsWith('/settings')
              ? 'glass text-[var(--color-text-primary)]'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] glass-hover'
          )}
        >
          <Settings className="w-5 h-5" />
          Configuración
        </Link>
      </div>
    </div>
  )
}
