import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, ChevronRight, CreditCard, MonitorX, X } from 'lucide-react'
import { RecordPaymentModal } from '@/components/common'
import styles from './PhonePayments.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_PHONE_SELECTOR = '[data-phone-scrollable="true"], textarea'

type AccessState = 'checking' | 'allowed' | 'blocked'
type PaymentView = 'select' | 'single' | 'partial'

function hasPortableAccess() {
  if (typeof window === 'undefined') return false

  const portableViewport = window.matchMedia(PORTABLE_WIDTH_QUERY).matches
  const phoneViewport = window.matchMedia(PHONE_WIDTH_QUERY).matches
  const coarsePointer = window.matchMedia(COARSE_POINTER_QUERY).matches
  const userAgent = navigator.userAgent || ''
  const mobileOrTabletUserAgent = MOBILE_OR_TABLET_USER_AGENT_PATTERN.test(userAgent)
  const iPadDesktopMode = /Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1

  return phoneViewport || (portableViewport && (mobileOrTabletUserAgent || iPadDesktopMode || coarsePointer))
}

function getAccessState(): AccessState {
  if (typeof window === 'undefined') return 'checking'
  return hasPortableAccess() ? 'allowed' : 'blocked'
}

function getInitialView(mode: string | null): PaymentView {
  if (mode === 'single' || mode === 'partial') return mode
  return 'select'
}

export const PhonePayments: React.FC = () => {
  const [searchParams] = useSearchParams()
  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  const [view, setView] = useState<PaymentView>(() => getInitialView(searchParams.get('mode')))

  useEffect(() => {
    document.title = 'Registrar pagos móvil | Ristak'
  }, [])

  useEffect(() => {
    const updateAccess = () => setAccessState(getAccessState())
    const portableMedia = window.matchMedia(PORTABLE_WIDTH_QUERY)
    const phoneMedia = window.matchMedia(PHONE_WIDTH_QUERY)
    const pointerMedia = window.matchMedia(COARSE_POINTER_QUERY)

    updateAccess()
    portableMedia.addEventListener('change', updateAccess)
    phoneMedia.addEventListener('change', updateAccess)
    pointerMedia.addEventListener('change', updateAccess)
    window.addEventListener('resize', updateAccess)
    window.addEventListener('orientationchange', updateAccess)
    window.visualViewport?.addEventListener('resize', updateAccess)

    return () => {
      portableMedia.removeEventListener('change', updateAccess)
      phoneMedia.removeEventListener('change', updateAccess)
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
    const previousHtmlBackground = html.style.background
    const previousBodyOverflow = body.style.overflow
    const previousBodyHeight = body.style.height
    const previousBodyOverscroll = body.style.overscrollBehavior
    const previousBodyBackground = body.style.background
    const phoneHeaderBackground = 'color-mix(in srgb, var(--color-background-secondary) 96%, var(--color-background-primary) 4%)'
    let startY = 0

    if (viewportMeta && !previousViewportContent.includes('viewport-fit=cover')) {
      viewportMeta.setAttribute('content', `${previousViewportContent}, viewport-fit=cover`)
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    html.style.background = phoneHeaderBackground
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'
    body.style.background = phoneHeaderBackground

    const getScrollableElement = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null
      const scrollable = target.closest(SCROLLABLE_PHONE_SELECTOR)
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
      html.style.background = previousHtmlBackground
      body.style.overflow = previousBodyOverflow
      body.style.height = previousBodyHeight
      body.style.overscrollBehavior = previousBodyOverscroll
      body.style.background = previousBodyBackground
    }
  }, [accessState])

  if (accessState === 'checking') {
    return (
      <main className={styles.loadingPage}>
        <span className={styles.loadingDot} />
      </main>
    )
  }

  if (accessState === 'blocked') {
    return (
      <main className={styles.blockedPage}>
        <section className={styles.blockedPanel} aria-labelledby="phone-payments-blocked-title">
          <div className={styles.blockedIcon} aria-hidden="true">
            <MonitorX size={28} />
          </div>
          <div className={styles.blockedCopy}>
            <p className={styles.eyebrow}>Ruta phone</p>
            <h1 id="phone-payments-blocked-title">Solo en móvil o tablet</h1>
            <p>
              Esta vista para registrar pagos está optimizada para teléfono o tablet. Ábrela desde un dispositivo portátil para cobrar a tus clientes.
            </p>
          </div>
          <Link className={styles.dashboardLink} to="/transactions">
            Ir a pagos
          </Link>
        </section>
      </main>
    )
  }

  const isForm = view !== 'select'
  const formMode = view === 'partial' ? 'partial' : 'single'
  const formTitle = view === 'partial' ? 'Plan de pagos' : 'Registrar pago'

  return (
    <main className={styles.phonePage} aria-label="Registrar pagos móvil de Ristak">
      <div className={styles.phoneFrame}>
        <header className={styles.header}>
          {isForm ? (
            <button
              type="button"
              className={styles.backButton}
              onClick={() => setView('select')}
            >
              <ArrowLeft size={18} />
              <span>Volver</span>
            </button>
          ) : (
            <div className={styles.headerMain}>
              <span className={styles.brandMark}>R</span>
              <div>
                <p className={styles.eyebrow}>Ristak Phone</p>
                <h1>Pagos</h1>
              </div>
            </div>
          )}

          {isForm ? (
            <h2 className={styles.headerFormTitle}>{formTitle}</h2>
          ) : (
            <Link className={styles.iconButton} to="/phone/transactions" aria-label="Volver a la app" title="Volver a la app">
              <X size={18} />
            </Link>
          )}
        </header>

        {isForm ? (
          <div className={styles.formHost}>
            <RecordPaymentModal
              key={formMode}
              variant="embedded"
              isOpen
              initialPaymentMode={formMode}
              onClose={() => setView('select')}
              onSuccess={() => setView('select')}
            />
          </div>
        ) : (
          <section className={styles.selectStack} aria-label="Elige el tipo de cobro">
            <button
              type="button"
              className={`${styles.choiceCard} ${styles.choiceTop}`}
              onClick={() => setView('single')}
            >
              <span className={`${styles.choiceIcon} ${styles.choiceIconGreen}`}>
                <CreditCard size={26} />
              </span>
              <span className={styles.choiceText}>
                <strong>Registrar pago</strong>
                <small>Cobro único: envía un link de pago o registra el pago manual.</small>
              </span>
              <ChevronRight size={20} className={styles.choiceChevron} aria-hidden="true" />
            </button>

            <div className={styles.selectHint} aria-hidden="true">
              <span>Elige cómo quieres cobrar</span>
            </div>

            <button
              type="button"
              className={`${styles.choiceCard} ${styles.choiceBottom}`}
              onClick={() => setView('partial')}
            >
              <span className={`${styles.choiceIcon} ${styles.choiceIconBlue}`}>
                <CalendarDays size={26} />
              </span>
              <span className={styles.choiceText}>
                <strong>Planes de pago</strong>
                <small>Parcialidades automáticas con enganche y cobros recurrentes.</small>
              </span>
              <ChevronRight size={20} className={styles.choiceChevron} aria-hidden="true" />
            </button>
          </section>
        )}
      </div>
    </main>
  )
}
