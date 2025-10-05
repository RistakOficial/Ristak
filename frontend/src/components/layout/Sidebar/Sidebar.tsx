import React, { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  FileBarChart,
  Megaphone,
  Banknote,
  Users,
  Settings
} from 'lucide-react'
import { cn } from '@/utils/cn'
import { Logo } from '@/components/common'

interface SidebarProps {
  onNavigate?: () => void
  locationName?: string
}

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'Reportes', href: '/reports', icon: FileBarChart },
  { name: 'Publicidad', href: '/campaigns', icon: Megaphone },
  { name: 'Pagos', href: '/transactions', icon: Banknote },
  { name: 'Contactos', href: '/contacts', icon: Users }
]

export const Sidebar: React.FC<SidebarProps> = ({ onNavigate, locationName }) => {
  const location = useLocation()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const handleNavigate = () => {
    onNavigate?.()
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-col items-center justify-center px-4 gap-2 border-b border-[rgba(148,163,184,0.12)]" style={{ height: 'var(--header-height)' }}>
        <Logo size="2xl" />
        {mounted && locationName && (
          <span className="text-xs text-[var(--color-text-tertiary)] font-medium truncate max-w-[180px] text-center">
            {locationName}
          </span>
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
