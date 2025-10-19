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
  GripVertical
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { Logo } from '@/components/common'
import { useAppConfig } from '@/hooks'
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

const getNavigationItems = (showAnalytics: boolean): NavItem[] => {
  if (!showAnalytics) return baseNavigation

  return [
    baseNavigation[0],
    baseNavigation[1],
    analyticsNavigation,
    ...baseNavigation.slice(2)
  ]
}

interface SortableItemProps {
  item: NavItem
  isActive: boolean
  isDragging: boolean
  isEditMode: boolean
  onNavigate?: () => void
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
        className={cn(
          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200',
          isSortableDragging && 'opacity-50',
          isActive
            ? 'glass text-[var(--color-text-primary)]'
            : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] glass-hover'
        )}
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

export const Sidebar: React.FC<SidebarProps> = ({ onNavigate, locationName, locationLogo }) => {
  const location = useLocation()
  const [mounted, setMounted] = useState(false)
  const [analyticsEnabled] = useAppConfig<boolean>('show_analytics', false)
  const [sidebarOrder, setSidebarOrder] = useAppConfig<string[]>('sidebar_navigation_order', [])
  const [navigation, setNavigation] = useState<NavItem[]>(() => getNavigationItems(false))
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isEditMode, setIsEditMode] = useState(false)
  const longPressTimerRef = React.useRef<number | null>(null)
  const longPressStartPos = React.useRef<{ x: number; y: number } | null>(null)

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

    return orderedItems
  }

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const showAnalytics = Boolean(analyticsEnabled)
    const items = getNavigationItems(showAnalytics)
    setNavigation(applyOrder(items, sidebarOrder))
  }, [analyticsEnabled, sidebarOrder])

  useEffect(() => {
    const handleAnalyticsChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ showAnalytics?: boolean }>
      if (typeof customEvent.detail?.showAnalytics === 'boolean') {
        const showAnalytics = customEvent.detail.showAnalytics
        const items = getNavigationItems(showAnalytics)
        setNavigation(applyOrder(items, sidebarOrder))
      }
    }

    window.addEventListener('analytics-preference-changed', handleAnalyticsChange)

    return () => {
      window.removeEventListener('analytics-preference-changed', handleAnalyticsChange)
    }
  }, [sidebarOrder])

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  const handleDragEnd = (event: DragEndEvent) => {
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
    onNavigate?.()
  }

  const activeItem = activeId ? navigation.find(item => item.id === activeId) : null

  return (
    <div className="flex flex-col h-full">
      {/* Header con logo */}
      <div className="flex items-center justify-center px-4 gap-2 border-b border-[rgba(148,163,184,0.12)]" style={{ height: 'var(--header-height)' }}>
        {mounted && locationLogo ? (
          <div className="w-24 h-10 flex items-center justify-center">
            <img
              src={locationLogo}
              alt={locationName || 'Logo'}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : mounted && locationName && locationName !== 'Ristak' ? (
          <div className="w-full flex items-center justify-center px-2">
            <span className="text-lg font-bold text-[var(--color-text-primary)] truncate max-w-[180px] text-center">
              {locationName}
            </span>
          </div>
        ) : (
          <Logo size="2xl" />
        )}
      </div>

      {/* Navigation */}
      <nav className={cn(
        "flex-1 p-4 pt-3 transition-all duration-200",
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
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={navigation.map(item => item.id)} strategy={verticalListSortingStrategy}>
            <div
              className="space-y-1"
              onPointerDown={startLongPress}
              onPointerMove={(e) => {
                // Cancelar si se mueve durante el long press
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
      </nav>

      {/* Settings */}
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
