import React, { useEffect, useRef, useState } from 'react'
import { Send, Moon, Sun, ChevronDown, Settings as SettingsIcon, LogOut } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useTheme } from '@/contexts/ThemeContext'
import { useAuth } from '@/contexts/AuthContext'
import { Link } from 'react-router-dom'

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

export const Header: React.FC<HeaderProps> = ({ onLogout }) => {
  const { theme, toggleTheme, themeSource } = useTheme()
  const { user } = useAuth()
  const [showUserMenu, setShowUserMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false)
      }
    }

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showUserMenu])

  const initials = getInitials(user?.name, user?.email)

  return (
    <header className="glass border-b border-[rgba(148,163,184,0.12)] px-4 sm:px-6 flex items-center justify-between sticky top-0 z-20" style={{ height: 'var(--header-height)' }}>
      <div className="flex items-center gap-2 sm:gap-4 flex-1 max-w-xl ml-12 lg:ml-0">
        <div className="flex items-center gap-2 flex-1">
          <input
            type="text"
            placeholder="Buscar"
            className="flex-1 px-3 sm:px-4 py-2 rounded-xl glass border border-[rgba(148,163,184,0.18)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-tertiary)] bg-transparent focus:outline-none text-sm sm:text-base"
          />
          <button
            className="p-2 rounded-xl glass border border-[rgba(148,163,184,0.18)] text-[var(--color-text-primary)] hover:glass-hover transition-colors"
            title="Enviar"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 sm:gap-3">
        <button
          className="relative p-1.5 sm:p-2 rounded-xl glass border border-[rgba(148,163,184,0.18)] text-[var(--color-text-primary)] hover:glass-hover transition-colors"
          onClick={toggleTheme}
          title={themeSource === 'system' ? 'Tema automático (click para cambiar)' : 'Tema manual (click para cambiar)'}
        >
          {theme === 'light' ? <Moon className="w-4 h-4 sm:w-5 sm:h-5" /> : <Sun className="w-4 h-4 sm:w-5 sm:h-5" />}
          {themeSource === 'system' && (
            <span className="absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 bg-green-500 rounded-full" />
          )}
        </button>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
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
            <div className="absolute right-0 mt-2 w-64 glass rounded-xl border border-[rgba(148,163,184,0.18)] shadow-xl z-50 overflow-hidden">
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
