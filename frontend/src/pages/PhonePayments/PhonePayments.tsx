import React, { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, CreditCard, Loader2, MonitorX } from 'lucide-react'
import { RecordPaymentModal } from '@/components/common'
import { PhoneEcosystemNav } from '@/components/phone/PhoneEcosystemNav'
import { transactionsService, type Transaction } from '@/services/transactionsService'
import styles from './PhonePayments.module.css'

const PORTABLE_WIDTH_QUERY = '(max-width: 1366px)'
const PHONE_WIDTH_QUERY = '(max-width: 900px)'
const COARSE_POINTER_QUERY = '(pointer: coarse)'
const MOBILE_OR_TABLET_USER_AGENT_PATTERN = /Android|iPad|iPhone|iPod|IEMobile|Opera Mini|Mobile|Tablet/i
const SCROLLABLE_PHONE_SELECTOR = '[data-phone-scrollable="true"], textarea'

type AccessState = 'checking' | 'allowed' | 'blocked'
type PaymentView = 'select' | 'single' | 'partial'
type RecentPaymentsPeriod = 'today' | '7d' | '30d' | '90d'

const SUCCESS_PAYMENT_STATUSES = new Set(['paid', 'partial'])

const RECENT_PAYMENT_PERIODS: Array<{ id: RecentPaymentsPeriod; label: string; days: number }> = [
  { id: 'today', label: 'Hoy', days: 0 },
  { id: '7d', label: '7 días', days: 7 },
  { id: '30d', label: '30 días', days: 30 },
  { id: '90d', label: '90 días', days: 90 }
]

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

function formatISODate(date: Date) {
  return date.toISOString().slice(0, 10)
}

function getRecentPaymentRange(period: RecentPaymentsPeriod) {
  const end = new Date()
  const start = new Date()
  const selectedPeriod = RECENT_PAYMENT_PERIODS.find((option) => option.id === period) || RECENT_PAYMENT_PERIODS[2]

  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)

  if (selectedPeriod.days > 0) {
    start.setDate(start.getDate() - (selectedPeriod.days - 1))
  }

  return {
    startDate: formatISODate(start),
    endDate: formatISODate(end)
  }
}

function formatCurrency(value: number, currency = 'MXN') {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2
  }).format(value || 0)
}

function formatPaymentDate(value?: string | null) {
  if (!value) return 'Sin fecha'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Sin fecha'

  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date)
}

function getPaymentMethodLabel(method?: string | null) {
  const normalizedMethod = String(method || '').toLowerCase()
  if (normalizedMethod === 'card') return 'Tarjeta'
  if (normalizedMethod === 'transfer' || normalizedMethod === 'bank_transfer') return 'Transferencia'
  if (normalizedMethod === 'cash') return 'Efectivo'
  if (normalizedMethod === 'check') return 'Cheque'
  if (normalizedMethod === 'paypal') return 'PayPal'
  return 'Otro'
}

function getPaymentStatusLabel(status?: string | null) {
  const normalizedStatus = String(status || '').toLowerCase()
  if (normalizedStatus === 'paid') return 'Pagado'
  if (normalizedStatus === 'partial') return 'Parcial'
  if (normalizedStatus === 'refunded') return 'Reembolsado'
  if (normalizedStatus === 'failed') return 'Fallido'
  if (normalizedStatus === 'pending') return 'Pendiente'
  return status || 'Sin estado'
}

function getContactLabel(transaction: Transaction) {
  return transaction.contactName || transaction.email || transaction.phone || 'Cliente sin nombre'
}

export const PhonePayments: React.FC = () => {
  const [searchParams] = useSearchParams()
  const [accessState, setAccessState] = useState<AccessState>(getAccessState)
  const [view, setView] = useState<PaymentView>(() => getInitialView(searchParams.get('mode')))
  const [recentPaymentsOpen, setRecentPaymentsOpen] = useState(false)
  const [recentPaymentsPeriod, setRecentPaymentsPeriod] = useState<RecentPaymentsPeriod>('30d')
  const [recentPayments, setRecentPayments] = useState<Transaction[]>([])
  const [recentPaymentsLoading, setRecentPaymentsLoading] = useState(false)
  const [selectedRecentPaymentId, setSelectedRecentPaymentId] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Pagos móviles | Ristak'
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
    const phoneFrameBackground = 'color-mix(in srgb, var(--color-background-primary) 92%, #ffffff 8%)'
    let startY = 0

    if (viewportMeta && !previousViewportContent.includes('viewport-fit=cover')) {
      viewportMeta.setAttribute('content', `${previousViewportContent}, viewport-fit=cover`)
    }

    html.style.overflow = 'hidden'
    html.style.height = '100%'
    html.style.overscrollBehavior = 'none'
    html.style.background = phoneFrameBackground
    body.style.overflow = 'hidden'
    body.style.height = '100%'
    body.style.overscrollBehavior = 'none'
    body.style.background = phoneFrameBackground

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

  useEffect(() => {
    if (accessState !== 'allowed' || !recentPaymentsOpen) return

    let cancelled = false
    const loadRecentPayments = async () => {
      setRecentPaymentsLoading(true)
      const { startDate, endDate } = getRecentPaymentRange(recentPaymentsPeriod)
      const transactions = await transactionsService.getTransactions(startDate, endDate)

      if (cancelled) return

      const receivedPayments = transactions
        .filter((transaction) => transaction.amount > 0 && SUCCESS_PAYMENT_STATUSES.has(String(transaction.status || '').toLowerCase()))
        .sort((left, right) => Date.parse(right.date || right.createdAt || '') - Date.parse(left.date || left.createdAt || ''))

      setRecentPayments(receivedPayments)
      setSelectedRecentPaymentId((current) => (
        current && receivedPayments.some((payment) => payment.id === current) ? current : null
      ))
      setRecentPaymentsLoading(false)
    }

    loadRecentPayments()

    return () => {
      cancelled = true
    }
  }, [accessState, recentPaymentsOpen, recentPaymentsPeriod])

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
            <p className={styles.eyebrow}>Ruta móvil</p>
            <h1 id="phone-payments-blocked-title">Solo celular o tablet</h1>
            <p>
              Esta pantalla está hecha para cobrar desde celular o tablet. Ábrela desde un dispositivo portátil para cobrarle a tus clientes.
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
  const formTitle = view === 'partial' ? 'Plan de pago' : 'Registrar pago'
  const selectedRecentPeriod = RECENT_PAYMENT_PERIODS.find((period) => period.id === recentPaymentsPeriod) || RECENT_PAYMENT_PERIODS[2]
  const selectedRecentPayment = recentPayments.find((payment) => payment.id === selectedRecentPaymentId) || null

  return (
    <main className={styles.phonePage} aria-label="Pagos móviles de Ristak">
      <div className={styles.phoneFrame}>
        {isForm && (
          <header className={styles.header}>
            <button
              type="button"
              className={styles.backButton}
              onClick={() => setView('select')}
            >
              <ArrowLeft size={18} />
              <span>Atrás</span>
            </button>
            <h2 className={styles.headerFormTitle}>{formTitle}</h2>
          </header>
        )}

        {isForm ? (
          <div className={styles.formHost} data-phone-scrollable="true">
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
          <section className={styles.selectStack} aria-label="Elige el tipo de pago" data-phone-scrollable="true">
            <h1 className={styles.selectTitle}>Elige cómo quieres pagar</h1>

            <button
              type="button"
              className={styles.choiceCard}
              onClick={() => setView('single')}
            >
              <span className={`${styles.choiceIcon} ${styles.choiceIconGreen}`}>
                <CreditCard size={26} />
              </span>
              <span className={styles.choiceText}>
                <strong>Registrar pago</strong>
                <small>Cobro único: envía una liga de pago o registra un pago manual.</small>
              </span>
              <ChevronRight size={20} className={styles.choiceChevron} aria-hidden="true" />
            </button>

            <button
              type="button"
              className={styles.choiceCard}
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

            <section className={styles.recentPaymentsSection} aria-label="Últimos pagos recibidos">
              <button
                type="button"
                className={styles.recentPaymentsToggle}
                onClick={() => setRecentPaymentsOpen((open) => !open)}
                aria-expanded={recentPaymentsOpen}
              >
                <span>
                  <strong>{recentPaymentsOpen ? 'Ocultar últimos pagos' : 'Mostrar últimos pagos'}</strong>
                  <small>
                    {selectedRecentPayment
                      ? `${formatCurrency(selectedRecentPayment.amount, selectedRecentPayment.currency || 'MXN')} seleccionado`
                      : `${selectedRecentPeriod.label} recientes`}
                  </small>
                </span>
                <ChevronDown className={recentPaymentsOpen ? styles.recentPaymentsChevronOpen : ''} size={22} />
              </button>

              {recentPaymentsOpen && (
                <div className={styles.recentPaymentsPanel}>
                  <div className={styles.recentPeriodPicker} role="group" aria-label="Periodo de últimos pagos">
                    {RECENT_PAYMENT_PERIODS.map((period) => (
                      <button
                        key={period.id}
                        type="button"
                        className={period.id === recentPaymentsPeriod ? styles.recentPeriodActive : ''}
                        onClick={() => setRecentPaymentsPeriod(period.id)}
                      >
                        {period.label}
                      </button>
                    ))}
                  </div>

                  {recentPaymentsLoading ? (
                    <div className={styles.recentPaymentsState}>
                      <Loader2 size={18} className={styles.spinIcon} />
                      Cargando pagos...
                    </div>
                  ) : recentPayments.length === 0 ? (
                    <div className={styles.recentPaymentsState}>
                      No hay pagos recibidos en este periodo.
                    </div>
                  ) : (
                    <div className={styles.recentPaymentsList}>
                      {recentPayments.slice(0, 24).map((payment) => {
                        const selected = selectedRecentPaymentId === payment.id
                        return (
                          <button
                            key={payment.id}
                            type="button"
                            className={`${styles.recentPaymentItem} ${selected ? styles.recentPaymentItemSelected : ''}`}
                            onClick={() => setSelectedRecentPaymentId(selected ? null : payment.id)}
                          >
                            <span className={styles.recentPaymentMain}>
                              <strong>{formatCurrency(payment.amount, payment.currency || 'MXN')}</strong>
                              <small>{getContactLabel(payment)}</small>
                            </span>
                            <span className={styles.recentPaymentMeta}>
                              <span>{formatPaymentDate(payment.date || payment.createdAt)}</span>
                              <small>{getPaymentMethodLabel(payment.method)} · {getPaymentStatusLabel(payment.status)}</small>
                            </span>
                            {selected && <Check size={18} className={styles.recentPaymentCheck} aria-hidden="true" />}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </section>
          </section>
        )}
      </div>
      <PhoneEcosystemNav active="payments" />
    </main>
  )
}
