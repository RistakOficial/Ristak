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

  const next = [...list]
  const [movingItem] = next.splice(sourceIndex, 1)

  let insertionIndex = next.findIndex(item => item.id === targetId)
  if (insertionIndex === -1) return list

  if (sourceIndex < targetIndex) {
    insertionIndex += 1
  }

  next.splice(insertionIndex, 0, movingItem)

  if (areOrdersEqual(next, list)) {
    return list
  }

  return next
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

  const setNavigationAnimated = useCallback((updater: (current: NavItem[]) => NavItem[]) => {
    const resultRef: { value: NavItem[] | null } = { value: null }

    setNavigation(current => {
      const previousOrder = current
      const previousRects = new Map<string, DOMRect>()

      previousOrder.forEach(item => {
        const node = navItemRefs.current.get(item.id)
        if (node) {
          previousRects.set(item.id, node.getBoundingClientRect())
        }
      })

      const next = updater(current)
      resultRef.value = next

      if (areOrdersEqual(previousOrder, next)) {
        resultRef.value = previousOrder
        return previousOrder
      }

      requestAnimationFrame(() => {
        next.forEach(item => {
          const node = navItemRefs.current.get(item.id)
          const previousRect = previousRects.get(item.id)
          if (!node || !previousRect) return

          const nextRect = node.getBoundingClientRect()
          const deltaX = previousRect.left - nextRect.left
          const deltaY = previousRect.top - nextRect.top

          if (deltaX === 0 && deltaY === 0) {
            return
          }

          node.style.transition = 'none'
          node.style.transform = `translate(${deltaX}px, ${deltaY}px)`

          requestAnimationFrame(() => {
            node.style.transition = 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 180ms ease, background 180ms ease'
            node.style.transform = ''
          })
        })
      })

      return next
    })

    return resultRef.value ?? []
  }, [])

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

    const node = navItemRefs.current.get(id)
    if (node) {
      const rect = node.getBoundingClientRect()
      const dragImage = node.cloneNode(true) as HTMLElement
      dragImage.style.width = `${rect.width}px`
      dragImage.style.height = `${rect.height}px`
      dragImage.style.position = 'absolute'
      dragImage.style.top = '-9999px'
      dragImage.style.left = '-9999px'
      dragImage.style.pointerEvents = 'none'
      dragImage.style.boxShadow = '0 12px 24px -12px rgba(15, 23, 42, 0.45)'
      dragImage.style.opacity = '0.95'
      document.body.appendChild(dragImage)

      const offsetX = event.clientX - rect.left
      const offsetY = event.clientY - rect.top
      event.dataTransfer.setDragImage(dragImage, offsetX, offsetY)

      requestAnimationFrame(() => {
        document.body.removeChild(dragImage)
      })
    }
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
    setDropTargetId(id)
    setNavigationAnimated(current => reorderNavigationItems(current, draggingId, id))
  }

  const handleDragEnter = (id: string) => (event: React.DragEvent<HTMLAnchorElement>) => {
    if (!draggingId || draggingId === id) return
    event.preventDefault()
    setDropTargetId(id)
    setNavigationAnimated(current => reorderNavigationItems(current, draggingId, id))
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
      dropCompletedRef.current = false
      setIsEditing(false)
      return
    }

    const finalNavigation = setNavigationAnimated(current => reorderNavigationItems(current, draggingId, targetId))

    const orderToPersist =
      finalNavigation &&
      dragStartOrderRef.current &&
      !areOrdersEqual(finalNavigation, dragStartOrderRef.current)
        ? finalNavigation
        : null

    try {
      if (orderToPersist) {
        dropCompletedRef.current = true
        await persistOrder(orderToPersist)
      } else {
        dropCompletedRef.current = false
      }
    } finally {
      handleDragEnd()
    }
  }

  const handleContainerDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.stopPropagation()

    if (!draggingId) {
      dropCompletedRef.current = false
      setIsEditing(false)
      return
    }

    const finalNavigation = setNavigationAnimated(current => moveItemToEnd(current, draggingId))

    const orderToPersist =
      finalNavigation &&
      dragStartOrderRef.current &&
      !areOrdersEqual(finalNavigation, dragStartOrderRef.current)
        ? finalNavigation
        : null

    try {
      if (orderToPersist) {
        dropCompletedRef.current = true
        await persistOrder(orderToPersist)
      } else {
        dropCompletedRef.current = false
      }
    } finally {
      handleDragEnd()
    }
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
      <div className="flex items-center px-6 py-4 border-b border-[rgba(148,163,184,0.12)]">
        {mounted && locationLogo ? (
          // Si hay logo de HighLevel, mostrarlo
          <div className="w-28 h-12 flex items-center">
            <img
              src={locationLogo}
              alt={locationName || 'Logo'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : mounted && locationName && locationName !== 'Ristak' ? (
          // Si no hay logo pero sí nombre de HighLevel (no es "Ristak"), mostrar el nombre
          <div className="flex items-center">
            <span className="text-xl font-bold text-[var(--color-text-primary)] truncate">
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
          'relative flex-1 px-3 py-4 transition-all duration-200',
          isEditing
            ? 'bg-white/[0.02] mx-2 rounded-lg ring-1 ring-[rgba(148,163,184,0.15)] shadow-sm'
            : ''
        )}
        onDragOver={(event) => {
          if (!draggingId) return
          event.preventDefault()
        }}
        onDrop={handleContainerDrop}
      >
        {isEditing && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex items-center justify-between gap-2 rounded-md border border-dashed border-[rgba(148,163,184,0.2)] bg-white/[0.04] px-3 py-1.5 text-[9px] font-medium tracking-wider text-[var(--color-text-tertiary)] uppercase">
            <span className="flex items-center gap-1.5 text-[var(--color-text-secondary)]">
              <span className="flex h-1.5 w-1.5 items-center justify-center">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-accent-green)] animate-ping" />
              </span>
              Editando
            </span>
            <span className="hidden text-[var(--color-text-tertiary)] sm:inline">
              Arrastra para reordenar
            </span>
          </div>
        )}

        <div className="space-y-0.5">
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
                  'group relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 select-none',
                  isDragging
                    ? 'z-10 cursor-grabbing scale-[1.02] bg-white/[0.06] shadow-lg'
                    : isPreparing
                      ? 'cursor-grab bg-white/[0.04] shadow-md'
                      : 'cursor-pointer',
                  isDropTarget
                    ? 'ring-1 ring-[rgba(148,163,184,0.4)] bg-white/[0.05]'
                    : '',
                  isDimmed ? 'opacity-50' : '',
                  isActive
                    ? 'bg-white/[0.08] text-[var(--color-text-primary)] shadow-sm'
                    : 'text-[var(--color-text-tertiary)] hover:bg-white/[0.04] hover:text-[var(--color-text-secondary)]'
                )}
              >
                {/* Grip handle para modo edición */}
                <span
                  className={cn(
                    'pointer-events-none absolute -left-1 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded transition-all duration-200',
                    isEditing
                      ? 'opacity-40'
                      : 'opacity-0'
                  )}
                  aria-hidden="true"
                >
                  <GripVertical className="h-3.5 w-3.5 text-[var(--color-text-tertiary)]" />
                </span>

                {/* Icono y texto */}
                <Icon className={cn(
                  "h-5 w-5 flex-shrink-0 transition-colors",
                  isActive ? "text-[var(--color-text-primary)]" : "",
                  isEditing ? "ml-4" : ""
                )} />
                <span className="flex-1">{item.name}</span>

                {/* Indicador activo */}
                {isActive && !isEditing && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--color-accent-blue)] rounded-r" />
                )}

                {/* Estado arrastrando */}
                {isDragging && (
                  <span className="ml-auto flex items-center gap-1">
                    <span className="flex items-center gap-0.5">
                      <span className="h-1 w-1 rounded-full bg-[var(--color-text-tertiary)] animate-pulse" />
                      <span className="h-1 w-1 rounded-full bg-[var(--color-text-tertiary)] animate-pulse [animation-delay:100ms]" />
                      <span className="h-1 w-1 rounded-full bg-[var(--color-text-tertiary)] animate-pulse [animation-delay:200ms]" />
                    </span>
                  </span>
                )}
              </Link>
            )
          })}
        </div>
      </nav>

      <div className="mt-auto px-3 py-4 border-t border-[rgba(148,163,184,0.12)]">
        <Link
          to="/settings"
          onClick={handleNavigate}
          className={cn(
            'relative flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-all duration-150',
            location.pathname.startsWith('/settings')
              ? 'bg-white/[0.08] text-[var(--color-text-primary)] shadow-sm'
              : 'text-[var(--color-text-tertiary)] hover:bg-white/[0.04] hover:text-[var(--color-text-secondary)]'
          )}
        >
          <Settings className="w-5 h-5 flex-shrink-0" />
          <span className="flex-1">Configuración</span>
          {location.pathname.startsWith('/settings') && (
            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-[var(--color-accent-blue)] rounded-r" />
          )}
        </Link>
      </div>
    </div>
  )
}
