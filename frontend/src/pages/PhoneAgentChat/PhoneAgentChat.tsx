import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MonitorX } from 'lucide-react'
import { AIAgentPanel } from '@/components/ai'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { PhoneStartupLoader } from '@/components/phone/PhoneStartupLoader'
import { isLocalPhonePreviewHost } from '@/utils/phoneAccess'
import styles from './PhoneAgentChat.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_CHAT_SELECTOR = '[data-ai-agent-scrollable="true"], textarea'

type AccessState = 'checking' | 'allowed' | 'blocked'

function hasPortableAccess() {
  if (typeof window === 'undefined') return false
  if (isLocalPhonePreviewHost()) return true

  const portableViewport = window.matchMedia(PORTABLE_WIDTH_QUERY).matches
  const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches
  const userAgent = navigator.userAgent || ''
  const mobileOrTabletUserAgent = MOBILE_OR_TABLET_USER_AGENT_PATTERN.test(userAgent)
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return portableViewport && (mobileOrTabletUserAgent || iPadDesktopMode || coarsePointer)
}

function getAccessState(): AccessState {
  if (typeof window === 'undefined') return 'checking'
  return hasPortableAccess() ? 'allowed' : 'blocked'
}

export const PhoneAgentChat: React.FC = () => {
  const [accessState, setAccessState] = useState<AccessState>(getAccessState)

  useEffect(() => {
    document.title = 'Agente AI móvil y tablet | Ristak'

    const updateAccess = () => setAccessState(getAccessState())
    const portableMedia = window.matchMedia(PORTABLE_WIDTH_QUERY)
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    portableMedia.addEventListener('change', updateAccess)
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
      portableMedia.removeEventListener('change', updateAccess)
      pointerMedia.removeEventListener('change', updateAccess)
      window.removeEventListener('resize', updateAccess)
      window.removeEventListener('orientationchange', updateAccess)
      window.visualViewport?.removeEventListener('resize', updateAccess)
    }
  }, [])

  useEffect(() => {
    if (accessState !== 'allowed') return

    const html = document.documentElement
    const body = document.body
    const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
    const previousViewportContent = viewportMeta?.getAttribute('content') || ''
    const previousHtmlOverflow = html.style.overflow
    const previousHtmlHeight = html.style.height
    const previousHtmlOverscroll = html.style.overscrollBehavior
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    let startY = 0

    if (viewportMeta && !previousViewportContent.includes('viewport-fit=cover')) {
      viewportMeta.setAttribute('content', `${previousViewportContent}, viewport-fit=cover`)
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'

    const getScrollableElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_CHAT_SELECTOR)
      return scrollable instanceof HTMLElement ? scrollable : null
    }

    const handleTouchStart = (event: TouchEvent) => {
      startY = event.touches[0]?.clientY || 0
    }

    const handleTouchMove = (event: TouchEvent) => {
      const scrollable = getScrollableElement(event.target)

      if (!scrollable) {
        event.preventDefault()
        return
      }

      const currentY = event.touches[0]?.clientY || startY
      const deltaY = currentY - startY
      const canScroll = scrollable.scrollHeight > scrollable.clientHeight + 1
      const atTop = scrollable.scrollTop <= 0
      const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1

      if (!canScroll || (atTop && deltaY > 0) || (atBottom && deltaY < 0)) {
        event.preventDefault()
      }
    }

    window.addEventListener('touchstart', handleTouchStart, { passive: false })
    window.addEventListener('touchmove', handleTouchMove, { passive: false })

    return () => {
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchmove', handleTouchMove)

      if (viewportMeta) {
        viewportMeta.setAttribute('content', previousViewportContent)
      }

      html.style.overflow = previousHtmlOverflow
      html.style.height = previousHtmlHeight
      html.style.overscrollBehavior = previousHtmlOverscroll
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
    }
  }, [accessState])

  if (accessState === 'checking') {
    return <PhoneStartupLoader />
  }

  if (accessState === 'blocked') {
    return (
      <main className={styles.blockedPage}>
        <section className={styles.blockedPanel} aria-labelledby="phone-agent-blocked-title">
          <div className={styles.blockedIcon} aria-hidden="true">
            <MonitorX size={28} />
          </div>
          <div className={styles.blockedCopy}>
            <p className={styles.eyebrow}>Ruta bloqueada</p>
            <h1 id="phone-agent-blocked-title">Solo en móvil o tablet</h1>
            <p>
              Esta pantalla del agente AI está cerrada para computadora. Ábrela desde un teléfono o una tablet para usar el chat en modo portátil.
            </p>
          </div>
          <Link className={styles.dashboardLink} to="/dashboard">
            Volver al dashboard
          </Link>
        </section>
      </main>
    )
  }

  return (
    <main className={styles.mobilePage} aria-label="Chat móvil y tablet del agente AI">
      <section className={styles.agentPanelHost}>
        <AIAgentPanel variant="embedded" />
      </section>
      <PhoneEcosystemNav active="chat" />
    </main>
  )
}
