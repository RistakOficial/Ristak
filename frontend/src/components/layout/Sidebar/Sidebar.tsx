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
  BarChart3
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

export const Sidebar: React.FC<SidebarProps> = ({ onNavigate, locationName, locationLogo }) => {
  const location = useLocation()
  const [mounted, setMounted] = useState(false)
  const [analyticsEnabled] = useAppConfig<boolean>('show_analytics', false)
  const [navigation, setNavigation] = useState<NavItem[]>(() => getNavigationItems(false))

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    const showAnalytics = Boolean(analyticsEnabled)
    setNavigation(getNavigationItems(showAnalytics))
  }, [analyticsEnabled])

  useEffect(() => {
    const handleAnalyticsChange = (event: Event) => {
      const customEvent = event as CustomEvent<{ showAnalytics?: boolean }>
      if (typeof customEvent.detail?.showAnalytics === 'boolean') {
        const showAnalytics = customEvent.detail.showAnalytics
        setNavigation(getNavigationItems(showAnalytics))
      }
    }

    window.addEventListener('analytics-preference-changed', handleAnalyticsChange)

    return () => {
      window.removeEventListener('analytics-preference-changed', handleAnalyticsChange)
    }
  }, [])

  const handleNavigate = () => {
    onNavigate?.()
  }

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
      <nav className="flex-1 p-4 pt-3">
        <div className="space-y-1">
          {navigation.map((item) => {
            const Icon = item.icon
            const isActive = location.pathname.startsWith(item.href)

            return (
              <Link
                key={item.id}
                to={item.href}
                onClick={handleNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'glass text-[var(--color-text-primary)]'
                    : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] glass-hover'
                )}
              >
                <Icon className="h-5 w-5 flex-shrink-0" />
                <span>{item.name}</span>
              </Link>
            )
          })}
        </div>
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
