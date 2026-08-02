import React, { useEffect, useState } from 'react'
import { MessageCircle, Smartphone } from 'lucide-react'
import { cn } from '@/utils/cn'
import { useLocation, useNavigate } from 'react-router-dom'
import { useScrollDirection } from '@/hooks/useScrollDirection'
import { Button, NotificationCenter } from '@/components/common'
import { GlobalSearch } from '@/components/common/GlobalSearch/GlobalSearch'
import {
  PHONE_APP_HOME_PATH,
  TABLET_VIEW_PREFERENCE_EVENT,
  isTabletDevice,
  writeTabletViewPreference
} from '@/utils/phoneAccess'

interface HeaderProps {
  sitesEditorActive?: boolean
}

export const Header: React.FC<HeaderProps> = ({ sitesEditorActive = false }) => {
  const navigate = useNavigate()
  const location = useLocation()
  const [showTabletSwitcher, setShowTabletSwitcher] = useState(false)
  const scrollDirection = useScrollDirection()
  const [scrollY, setScrollY] = useState(0)

  // Track scroll position
  useEffect(() => {
    const handleScroll = () => {
      setScrollY(window.scrollY)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  useEffect(() => {
    const pointerMedia = window.matchMedia?.('(pointer: coarse)')
    const updateTabletSwitcher = () => setShowTabletSwitcher(isTabletDevice())

    updateTabletSwitcher()
    pointerMedia?.addEventListener('change', updateTabletSwitcher)
    window.addEventListener('resize', updateTabletSwitcher)
    window.addEventListener('orientationchange', updateTabletSwitcher)
    window.visualViewport?.addEventListener('resize', updateTabletSwitcher)
    window.addEventListener(TABLET_VIEW_PREFERENCE_EVENT, updateTabletSwitcher)

    return () => {
      pointerMedia?.removeEventListener('change', updateTabletSwitcher)
      window.removeEventListener('resize', updateTabletSwitcher)
      window.removeEventListener('orientationchange', updateTabletSwitcher)
      window.visualViewport?.removeEventListener('resize', updateTabletSwitcher)
      window.removeEventListener(TABLET_VIEW_PREFERENCE_EVENT, updateTabletSwitcher)
    }
  }, [])

  const handleSwitchToTabletMode = () => {
    writeTabletViewPreference('tablet')
    navigate(PHONE_APP_HOME_PATH)
  }

  const handleOpenSimpleChatView = () => {
    if (typeof window === 'undefined') return
    navigate(PHONE_APP_HOME_PATH, { state: { chatViewTransition: 'to-simple' } })
  }

  const showSimpleChatButton = location.pathname === '/chat' || location.pathname.startsWith('/chat/')

  // Determinar si el header debe estar oculto
  const shouldHide = !sitesEditorActive && scrollDirection === 'down' && scrollY > 50

  return (
    <header
      data-ristak-header
      className={cn(
        "glass border-b border-[rgba(148,163,184,0.12)] px-4 sm:px-6 flex items-center justify-between sticky top-0",
        "transition-transform duration-300 ease-in-out",
        shouldHide ? '-translate-y-full' : 'translate-y-0'
      )}
      style={{ height: 'var(--header-height)', zIndex: 'var(--z-index-header)' }}
    >
      <div className="flex items-center gap-2 sm:gap-3 flex-1 max-w-3xl ml-12 lg:ml-0">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <GlobalSearch />
        </div>
        {showSimpleChatButton && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="hidden lg:inline-flex shrink-0 whitespace-nowrap"
            leftIcon={<MessageCircle size={16} aria-hidden="true" />}
            onClick={handleOpenSimpleChatView}
            aria-label="Abrir vista sencilla del chat"
            title="Abrir vista sencilla del chat"
          >
            Vista sencilla del chat
          </Button>
        )}
      </div>

      <div className="flex items-center gap-1 sm:gap-3">
        {showTabletSwitcher && (
          <button
            type="button"
            className="hidden sm:inline-flex min-h-[38px] items-center gap-2 whitespace-nowrap rounded-xl border border-[rgba(var(--color-primary-rgb),0.24)] bg-[rgba(var(--color-primary-rgb),0.08)] px-3 text-xs font-bold text-[var(--color-primary)] transition-colors hover:bg-[rgba(var(--color-primary-rgb),0.14)]"
            onClick={handleSwitchToTabletMode}
          >
            <Smartphone className="h-4 w-4" />
            Cambiar a modo tableta
          </button>
        )}
        <NotificationCenter />
      </div>
    </header>
  )
}
