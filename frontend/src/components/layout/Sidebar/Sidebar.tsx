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
import { checkTrackingStatus } from '@/services/analyticsService'

interface SidebarProps {
  onNavigate?: () => void
  locationName?: string
  locationLogo?: string | null
}

const baseNavigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Reportes', href: '/reports', icon: FileBarChart },
  { name: 'Publicidad', href: '/campaigns', icon: Megaphone },
  { name: 'Citas', href: '/appointments', icon: Calendar },
  { name: 'Pagos', href: '/transactions', icon: Banknote },
  { name: 'Contactos', href: '/contacts', icon: Users }
]

export const Sidebar: React.FC<SidebarProps> = ({ onNavigate, locationName, locationLogo }) => {
  const location = useLocation()
  const [mounted, setMounted] = useState(false)
  const [navigation, setNavigation] = useState(baseNavigation)

  useEffect(() => {
    setMounted(true)
  }, [])

  // Verificar preferencia de Analytics del usuario
  useEffect(() => {
    const checkTracking = async () => {
      try {
        const status = await checkTrackingStatus()
        // Mostrar Analytics solo si el usuario activó el switch
        if (status.showAnalytics) {
          setNavigation([
            ...baseNavigation,
            { name: 'Analíticas', href: '/analytics', icon: BarChart3 }
          ])
        } else {
          setNavigation(baseNavigation)
        }
      } catch (error) {
        // Si falla, solo mostrar el menú base
        setNavigation(baseNavigation)
      }
    }

    checkTracking()

    // Escuchar cambios en la preferencia de Analytics
    const handleAnalyticsChange = (event: CustomEvent) => {
      const { showAnalytics } = event.detail
      if (showAnalytics) {
        setNavigation([
          ...baseNavigation,
          { name: 'Analíticas', href: '/analytics', icon: BarChart3 }
        ])
      } else {
        setNavigation(baseNavigation)
      }
    }

    window.addEventListener('analytics-preference-changed', handleAnalyticsChange as EventListener)

    return () => {
      window.removeEventListener('analytics-preference-changed', handleAnalyticsChange as EventListener)
    }
  }, [])

  const handleNavigate = () => {
    onNavigate?.()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col items-center justify-center px-4 gap-2 border-b border-[rgba(148,163,184,0.12)]" style={{ height: 'var(--header-height)' }}>
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

      <nav className="flex-1 space-y-1 p-4 pt-3">
        {navigation.map((item) => {
          const Icon = item.icon
          const isActive = location.pathname.startsWith(item.href)

          return (
            <Link
              key={item.name}
              to={item.href}
              onClick={handleNavigate}
              className={cn(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'glass text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] glass-hover'
              )}
            >
              <Icon className="w-5 h-5" />
              {item.name}
            </Link>
          )
        })}
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
