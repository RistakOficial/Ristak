import React, { useEffect, useMemo, useState } from 'react'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe, type StripeElementsOptions } from '@stripe/stripe-js'
import { AlertCircle, CheckCircle2, CreditCard, Loader2, ShieldCheck } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import {
  stripePaymentsService,
  type PublicStripePayment,
  type StripePaymentIntentResponse
} from '@/services/stripePaymentsService'
import { formatCurrency } from '@/utils/format'
import styles from './PublicPayment.module.css'

type StripePromise = ReturnType<typeof loadStripe>

function formatDate(value?: string | null) {
  if (!value) return 'Sin vencimiento'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).split('T')[0]
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date)
}

function getStatusCopy(status: string) {
  const normalized = status.toLowerCase()
  if (['paid', 'succeeded', 'completed'].includes(normalized)) {
    return { label: 'Pagado', className: styles.statusPaid }
  }
  if (['failed', 'void', 'refunded'].includes(normalized)) {
    return { label: normalized === 'refunded' ? 'Reembolsado' : 'No disponible', className: styles.statusFailed }
  }
  return { label: 'Pendiente', className: '' }
}

function readToken(name: string) {
  if (typeof window === 'undefined') return ''
  const value = getComputedStyle(document.body).getPropertyValue(name).trim()
  return value || ''
}

function buildStripeAppearance() {
  return {
    theme: 'stripe' as const,
    variables: {
      colorPrimary: readToken('--accent'),
      colorText: readToken('--text'),
      colorTextSecondary: readToken('--text-dim'),
      colorBackground: readToken('--surface-solid') || readToken('--surface'),
      colorDanger: readToken('--neg'),
      fontFamily: readToken('--font-body'),
      borderRadius: '10px'
    }
  }
}

const PublicPaymentForm: React.FC<{
  payment: PublicStripePayment
  onPaid: () => Promise<void>
}> = ({ payment, onPaid }) => {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [success, setSuccess] = useState(false)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!stripe || !elements || submitting) return

    setSubmitting(true)
    setMessage('')

    const result = await stripe.confirmPayment({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/pay/${payment.publicPaymentId}?payment=return`
      },
      redirect: 'if_required'
    })

    if (result.error) {
      setMessage(result.error.message || 'No se pudo completar el pago. Revisa los datos e intenta otra vez.')
      setSubmitting(false)
      return
    }

    if (result.paymentIntent?.status === 'succeeded') {
      setSuccess(true)
      setMessage('Pago recibido. Gracias.')
      await onPaid()
    } else if (result.paymentIntent?.status === 'processing') {
      setMessage('Stripe está procesando el pago. Esta página se actualizará cuando se confirme.')
      await onPaid()
    } else {
      setMessage('Stripe necesita una acción adicional. Sigue las instrucciones del banco.')
    }

    setSubmitting(false)
  }

  return (
    <form className={styles.stripeBox} onSubmit={handleSubmit}>
      <div className={styles.stripeElementShell}>
        <PaymentElement />
      </div>

      {message && (
        <p className={`${styles.message} ${success ? styles.messageSuccess : styles.messageError}`}>
          {success ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          <span>{message}</span>
        </p>
      )}

      {payment.contact?.id && (
        <p className={styles.cardAuthorizationNotice}>
          <ShieldCheck size={16} />
          <span>
            Al pagar este invoice autorizas que esta tarjeta quede resguardada en Stripe para futuros cargos acordados con este negocio.
          </span>
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="submit"
          className={`${styles.button} ${styles.buttonPrimary}`}
          disabled={!stripe || !elements || submitting}
        >
          {submitting ? (
            <>
              <Loader2 size={16} className={styles.spin} />
              Procesando
            </>
          ) : (
            <>
              <CreditCard size={16} />
              Pagar {formatCurrency(payment.amount, payment.currency)}
            </>
          )}
        </button>
      </div>
    </form>
  )
}

export const PublicPayment: React.FC = () => {
  const { publicPaymentId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const [payment, setPayment] = useState<PublicStripePayment | null>(null)
  const [intent, setIntent] = useState<StripePaymentIntentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [startingPayment, setStartingPayment] = useState(false)
  const [error, setError] = useState('')

  const status = getStatusCopy(payment?.status || '')
  const isPaid = Boolean(payment && ['paid', 'succeeded', 'completed'].includes(payment.status.toLowerCase()))
  const isClosed = Boolean(payment && ['void', 'refunded', 'deleted'].includes(payment.status.toLowerCase()))
  const shouldSavePaymentMethod = Boolean(payment?.contact?.id)

  const stripePromise = useMemo<StripePromise | null>(() => {
    const key = intent?.publishableKey || payment?.publishableKey
    return key ? loadStripe(key) : null
  }, [intent?.publishableKey, payment?.publishableKey])

  const elementsOptions = useMemo<StripeElementsOptions | null>(() => {
    if (!intent?.clientSecret) return null
    return {
      clientSecret: intent.clientSecret,
      appearance: buildStripeAppearance()
    }
  }, [intent?.clientSecret])

  const loadPayment = async (sync = false) => {
    if (!publicPaymentId) return
    const data = await stripePaymentsService.getPublicPayment(publicPaymentId, sync)
    setPayment(data)
  }

  useEffect(() => {
    let mounted = true

    async function run() {
      setLoading(true)
      setError('')
      try {
        const sync = searchParams.get('payment') === 'return'
        const data = await stripePaymentsService.getPublicPayment(publicPaymentId, sync)
        if (mounted) setPayment(data)
      } catch (loadError: any) {
        if (mounted) setError(loadError.message || 'No pudimos cargar este pago.')
      } finally {
        if (mounted) setLoading(false)
      }
    }

    run()

    return () => {
      mounted = false
    }
  }, [publicPaymentId, searchParams])

  const startPayment = async () => {
    if (!payment || startingPayment) return

    setStartingPayment(true)
    setError('')
    try {
      const nextIntent = await stripePaymentsService.createPublicPaymentIntent(payment.publicPaymentId, {
        savePaymentMethod: shouldSavePaymentMethod
      })
      setIntent(nextIntent)
    } catch (intentError: any) {
      setError(intentError.message || 'No se pudo iniciar el cobro.')
    } finally {
      setStartingPayment(false)
    }
  }

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.statePanel}>
            <Loader2 size={34} className={styles.spin} />
            <h1>Cargando pago</h1>
            <p>Estamos preparando la información de tu invoice.</p>
          </section>
        </div>
      </main>
    )
  }

  if (error && !payment) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.statePanel}>
            <AlertCircle size={34} />
            <h1>No se pudo abrir este pago</h1>
            <p>{error}</p>
          </section>
        </div>
      </main>
    )
  }

  if (!payment) return null

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.eyebrow}>Ristak Payments</span>
            <h1 className={styles.title}>{payment.title || 'Pago pendiente'}</h1>
            <p className={styles.subtitle}>
              Revisa los datos del cobro y paga de forma segura con Stripe. Ristak no ve ni guarda el número de tu tarjeta.
            </p>
          </div>
          <span className={`${styles.statusBadge} ${status.className}`}>
            {isPaid ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />}
            {status.label}
          </span>
        </header>

        <section className={styles.grid}>
          <aside className={styles.invoicePanel} aria-label="Resumen del invoice">
            <div className={styles.invoiceTop}>
              <div>
                <p className={styles.invoiceLabel}>Concepto</p>
                <h2 className={styles.invoiceTitle}>{payment.title || 'Pago'}</h2>
                {payment.description && (
                  <p className={styles.invoiceDescription}>{payment.description}</p>
                )}
              </div>
              <div className={styles.amountBlock}>
                <span className={styles.amountLabel}>Total</span>
                <strong className={styles.amount}>{formatCurrency(payment.amount, payment.currency)}</strong>
              </div>
            </div>

            <div className={styles.detailList}>
              <div className={styles.detailRow}>
                <span>Cliente</span>
                <strong>{payment.contact?.name || 'Cliente'}</strong>
              </div>
              {payment.contact?.email && (
                <div className={styles.detailRow}>
                  <span>Email</span>
                  <strong>{payment.contact.email}</strong>
                </div>
              )}
              <div className={styles.detailRow}>
                <span>Vencimiento</span>
                <strong>{formatDate(payment.dueDate)}</strong>
              </div>
              <div className={styles.detailRow}>
                <span>Referencia</span>
                <strong>{payment.publicPaymentId}</strong>
              </div>
            </div>
          </aside>

          <section className={styles.payPanel} aria-label="Formulario de pago">
            <div className={styles.payHeader}>
              <h2>{isPaid ? 'Pago confirmado' : 'Pagar con tarjeta'}</h2>
              <p>
                {isPaid
                  ? 'Este invoice ya aparece como pagado en Ristak.'
                  : 'Los datos se capturan en el formulario seguro de Stripe.'}
              </p>
            </div>

            {error && (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>{error}</span>
              </p>
            )}

            {isPaid ? (
              <p className={`${styles.message} ${styles.messageSuccess}`}>
                <CheckCircle2 size={16} />
                <span>Listo. El pago fue recibido y el invoice quedó marcado como pagado.</span>
              </p>
            ) : isClosed ? (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>Este link ya no está disponible para cobrar.</span>
              </p>
            ) : stripePromise && elementsOptions ? (
              <Elements stripe={stripePromise} options={elementsOptions}>
                <PublicPaymentForm payment={payment} onPaid={() => loadPayment(true)} />
              </Elements>
            ) : (
              <div className={styles.stripeBox}>
                <p className={styles.message}>
                  <ShieldCheck size={16} />
                  <span>Stripe abrirá el campo seguro de tarjeta cuando inicies el pago.</span>
                </p>
                {shouldSavePaymentMethod && (
                  <p className={styles.cardAuthorizationNotice}>
                    <ShieldCheck size={16} />
                    <span>
                      Al iniciar y completar este pago, Stripe guardará la tarjeta para que el negocio pueda cobrar futuros pagos que acuerdes.
                    </span>
                  </p>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    onClick={startPayment}
                    disabled={startingPayment || !payment.publishableKey}
                  >
                    {startingPayment ? (
                      <>
                        <Loader2 size={16} className={styles.spin} />
                        Preparando
                      </>
                    ) : (
                      <>
                        <CreditCard size={16} />
                        Iniciar pago
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </section>
        </section>
      </div>
    </main>
  )
}
