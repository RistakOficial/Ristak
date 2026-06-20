import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe, type StripeElementsOptions } from '@stripe/stripe-js'
import { AlertCircle, CheckCircle2, CreditCard, Download, ExternalLink, Loader2, ShieldCheck, WalletCards } from 'lucide-react'
import { useParams, useSearchParams } from 'react-router-dom'
import { mercadoPagoPaymentsService, type PublicMercadoPagoPayment } from '@/services/mercadoPagoPaymentsService'
import {
  stripePaymentsService,
  type PublicStripePayment,
  type StripePaymentIntentResponse
} from '@/services/stripePaymentsService'
import { formatCurrency } from '@/utils/format'
import {
  buildInvoiceStyleVars,
  resolveInvoiceDesign,
  type PaymentInvoiceTemplateId
} from '@/utils/paymentInvoiceDesign'
import styles from './PublicPayment.module.css'

type StripePromise = ReturnType<typeof loadStripe>
type PublicPaymentData = PublicStripePayment | PublicMercadoPagoPayment

const printTemplateClassById: Record<PaymentInvoiceTemplateId, string> = {
  classic: 'printThemeClassic',
  executive: 'printThemeExecutive',
  accent: 'printThemeAccent',
  ledger: 'printThemeLedger'
}

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
              {payment.settings?.checkout?.buttonLabel || 'Pagar'} {formatCurrency(payment.amount, payment.currency)}
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
  const autoReceiptPrintRef = useRef('')
  const [payment, setPayment] = useState<PublicPaymentData | null>(null)
  const [intent, setIntent] = useState<StripePaymentIntentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [startingPayment, setStartingPayment] = useState(false)
  const [error, setError] = useState('')

  const status = getStatusCopy(payment?.status || '')
  const isPaid = Boolean(payment && ['paid', 'succeeded', 'completed'].includes(payment.status.toLowerCase()))
  const isClosed = Boolean(payment && ['void', 'refunded', 'deleted'].includes(payment.status.toLowerCase()))
  const receiptDownloadRequested = searchParams.get('receipt') === '1'
  const isStripePayment = payment?.provider === 'stripe'
  const isMercadoPagoPayment = payment?.provider === 'mercadopago'
  const shouldSavePaymentMethod = Boolean(isStripePayment && payment?.contact?.id)
  const providerLabel = isMercadoPagoPayment ? 'Mercado Pago' : 'Stripe'

  const stripePromise = useMemo<StripePromise | null>(() => {
    if (!payment || payment.provider !== 'stripe') return null
    const key = intent?.publishableKey || payment?.publishableKey
    const stripeAccount = intent?.stripeAccountId || payment?.stripeAccountId
    return key ? loadStripe(key, stripeAccount ? { stripeAccount } : undefined) : null
  }, [intent?.publishableKey, intent?.stripeAccountId, payment])

  const elementsOptions = useMemo<StripeElementsOptions | null>(() => {
    if (!intent?.clientSecret) return null
    return {
      clientSecret: intent.clientSecret,
      appearance: buildStripeAppearance()
    }
  }, [intent?.clientSecret])

  const loadPayment = async (sync = false) => {
    if (!publicPaymentId) return
    const data = await loadPublicPayment(publicPaymentId, sync)
    setPayment(data)
  }

  const loadPublicPayment = async (id: string, sync = false): Promise<PublicPaymentData> => {
    try {
      return await stripePaymentsService.getPublicPayment(id, sync)
    } catch (stripeError: any) {
      try {
        return await mercadoPagoPaymentsService.getPublicPayment(id)
      } catch {
        throw stripeError
      }
    }
  }

  useEffect(() => {
    let mounted = true

    async function run() {
      setLoading(true)
      setError('')
      try {
        const sync = searchParams.get('payment') === 'return'
        const data = await loadPublicPayment(publicPaymentId, sync)
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
      if (payment.provider === 'mercadopago') {
        const nextPreference = await mercadoPagoPaymentsService.ensurePublicPreference(payment.publicPaymentId)
        const paymentUrl = nextPreference.paymentUrl || payment.paymentUrl
        if (!paymentUrl) {
          throw new Error('Mercado Pago no devolvió un link de pago.')
        }
        window.location.assign(paymentUrl)
        return
      }

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

  const handleDownloadPdf = () => {
    if (!payment || typeof window === 'undefined') return
    const previousTitle = document.title
    document.title = `comprobante-${payment.publicPaymentId}`
    window.requestAnimationFrame(() => {
      window.print()
      window.setTimeout(() => {
        document.title = previousTitle
      }, 500)
    })
  }

  useEffect(() => {
    if (!payment || !isPaid || !receiptDownloadRequested || typeof window === 'undefined') return
    if (autoReceiptPrintRef.current === payment.publicPaymentId) return

    autoReceiptPrintRef.current = payment.publicPaymentId
    const timer = window.setTimeout(() => {
      handleDownloadPdf()
    }, 350)

    return () => window.clearTimeout(timer)
  }, [payment, isPaid, receiptDownloadRequested])

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.shell}>
          <section className={styles.statePanel}>
            <Loader2 size={34} className={styles.spin} />
            <h1>Cargando pago</h1>
            <p>Estamos preparando la información de tu pago.</p>
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

  const checkoutSettings = payment.settings?.checkout
  const receiptSettings = payment.settings?.receipt
  const taxDetails = payment.tax
  const logoUrl = checkoutSettings?.logoUrl || receiptSettings?.logoUrl || ''
  const invoiceLogoUrl = receiptSettings?.logoUrl || logoUrl
  const showBusinessInfo = receiptSettings?.showBusinessInfo !== false
  const showCustomerInfo = receiptSettings?.showCustomerInfo !== false
  const showTerms = receiptSettings?.showTerms !== false
  const supportItems = [
    checkoutSettings?.supportEmail,
    checkoutSettings?.supportPhone
  ].filter(Boolean)
  const taxLabel = taxDetails?.enabled
    ? `${taxDetails.taxName || 'Impuesto'} ${taxDetails.rateType === 'percentage' ? `${taxDetails.rateValue}%` : formatCurrency(taxDetails.rateValue || 0, payment.currency)}`
    : ''
  const hasTaxBreakdown = Boolean(taxDetails?.enabled && taxDetails.taxAmount > 0)
  const subtotalAmount = hasTaxBreakdown ? taxDetails?.subtotalAmount || 0 : payment.amount
  const taxAmount = hasTaxBreakdown ? taxDetails?.taxAmount || 0 : 0
  const totalAmount = hasTaxBreakdown ? taxDetails?.totalAmount || payment.amount : payment.amount
  const invoiceDesign = resolveInvoiceDesign(receiptSettings)
  const invoiceStyleVars = buildInvoiceStyleVars(receiptSettings)
  const printSheetClassName = [
    styles.printSheet,
    styles[printTemplateClassById[invoiceDesign.template.id]]
  ].filter(Boolean).join(' ')
  const paymentModeLabel = payment.paymentMode === 'live' ? 'Producción' : 'Prueba'

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            {logoUrl && (
              <img className={styles.brandLogo} src={logoUrl} alt="" />
            )}
            <span className={styles.eyebrow}>Ristak Payments</span>
            <h1 className={styles.title}>
              {isPaid
                ? 'Pago confirmado'
                : checkoutSettings?.headline || payment.title || 'Pago pendiente'}
            </h1>
            <p className={styles.subtitle}>
              {isPaid
                ? 'Tu pago fue recibido correctamente. Puedes descargar tu comprobante en PDF cuando lo necesites.'
                : checkoutSettings?.description || `Revisa los datos del cobro y paga de forma segura con ${providerLabel}. Ristak no ve ni guarda el número de tu tarjeta.`}
            </p>
          </div>
          <span className={`${styles.statusBadge} ${status.className}`}>
            {isPaid ? <CheckCircle2 size={15} /> : <ShieldCheck size={15} />}
            {status.label}
          </span>
        </header>

        <section className={styles.grid}>
          <aside className={styles.invoicePanel} aria-label="Resumen del pago">
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
              {hasTaxBreakdown && (
                <div className={styles.detailRow}>
                  <span>Subtotal</span>
                  <strong>{formatCurrency(taxDetails?.subtotalAmount || 0, payment.currency)}</strong>
                </div>
              )}
              {hasTaxBreakdown && (
                <div className={styles.detailRow}>
                  <span>{taxDetails?.calculationMode === 'inclusive' ? 'Impuesto incluido' : 'Impuesto'}</span>
                  <strong>{taxLabel} · {formatCurrency(taxDetails?.taxAmount || 0, payment.currency)}</strong>
                </div>
              )}
              <div className={styles.detailRow}>
                <span>Referencia</span>
                <strong>{payment.publicPaymentId}</strong>
              </div>
            </div>

            {checkoutSettings?.showSecureBadge && !isPaid && (
              <p className={styles.secureNotice}>
                <ShieldCheck size={16} />
                <span>Pago procesado de forma segura.</span>
              </p>
            )}
          </aside>

          <section className={styles.payPanel} aria-label="Formulario de pago">
            <div className={styles.payHeader}>
              <h2>{isPaid ? 'Pago confirmado' : isMercadoPagoPayment ? 'Pagar con Mercado Pago' : 'Pagar con tarjeta'}</h2>
              <p>
                {isPaid
                  ? 'Este pago ya aparece como pagado en Ristak.'
                  : isMercadoPagoPayment
                    ? 'Mercado Pago abrirá su checkout seguro para completar el cobro.'
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
              <div className={styles.receiptBox}>
                <p className={`${styles.message} ${styles.messageSuccess}`}>
                  <CheckCircle2 size={16} />
                  <span>Listo. El pago fue recibido y el invoice quedó marcado como pagado.</span>
                </p>
                <div className={styles.receiptRows}>
                  {showBusinessInfo && (
                    <div>
                      <span>Negocio</span>
                      <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                    </div>
                  )}
                  {showCustomerInfo && (
                    <div>
                      <span>Cliente</span>
                      <strong>{payment.contact?.name || 'Cliente'}</strong>
                    </div>
                  )}
                  <div>
                    <span>Total pagado</span>
                    <strong>{formatCurrency(totalAmount, payment.currency)}</strong>
                  </div>
                  <div>
                    <span>Fecha de pago</span>
                    <strong>{formatDate(payment.paidAt || new Date().toISOString())}</strong>
                  </div>
                  <div>
                    <span>Vencimiento</span>
                    <strong>{formatDate(payment.dueDate)}</strong>
                  </div>
                  {hasTaxBreakdown && (
                    <div>
                      <span>Impuesto</span>
                      <strong>{formatCurrency(taxAmount, payment.currency)}</strong>
                    </div>
                  )}
                  <div>
                    <span>Pasarela</span>
                    <strong>{providerLabel} · {paymentModeLabel}</strong>
                  </div>
                  <div>
                    <span>Referencia</span>
                    <strong>{payment.publicPaymentId}</strong>
                  </div>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={handleDownloadPdf}
                  >
                    <Download size={16} />
                    Descargar PDF
                  </button>
                </div>
                {showBusinessInfo && receiptSettings && (
                  <div className={styles.businessInfo}>
                    {receiptSettings.businessEmail && <span>{receiptSettings.businessEmail}</span>}
                    {receiptSettings.businessPhone && <span>{receiptSettings.businessPhone}</span>}
                    {receiptSettings.businessAddress && <span>{receiptSettings.businessAddress}</span>}
                    {receiptSettings.businessWebsite && <span>{receiptSettings.businessWebsite}</span>}
                  </div>
                )}
              </div>
            ) : isClosed ? (
              <p className={`${styles.message} ${styles.messageError}`}>
                <AlertCircle size={16} />
                <span>Este link ya no está disponible para cobrar.</span>
              </p>
            ) : isMercadoPagoPayment ? (
              <div className={styles.stripeBox}>
                <p className={styles.message}>
                  <WalletCards size={16} />
                  <span>Mercado Pago abrirá Checkout Pro para que puedas pagar con los métodos disponibles de tu cuenta.</span>
                </p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={`${styles.button} ${styles.buttonPrimary}`}
                    onClick={startPayment}
                    disabled={startingPayment}
                  >
                    {startingPayment ? (
                      <>
                        <Loader2 size={16} className={styles.spin} />
                        Abriendo
                      </>
                    ) : (
                      <>
                        <ExternalLink size={16} />
                        {checkoutSettings?.buttonLabel || 'Pagar con Mercado Pago'}
                      </>
                    )}
                  </button>
                </div>
              </div>
            ) : isStripePayment && stripePromise && elementsOptions ? (
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
                    disabled={startingPayment || !isStripePayment || !payment.publishableKey}
                  >
                    {startingPayment ? (
                      <>
                        <Loader2 size={16} className={styles.spin} />
                        Preparando
                      </>
                    ) : (
                      <>
                        <CreditCard size={16} />
                        {checkoutSettings?.buttonLabel || 'Iniciar pago'}
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </section>
        </section>

        {supportItems.length > 0 && !isPaid && (
          <p className={styles.supportLine}>
            ¿Necesitas ayuda con tu pago? {supportItems.join(' · ')}
          </p>
        )}
      </div>

      {isPaid && (
        <article className={styles.printDocument} aria-label="Comprobante de pago para PDF">
          <section className={printSheetClassName} style={invoiceStyleVars}>
            <header className={styles.printHeader}>
              <div className={styles.printIdentity}>
                {invoiceLogoUrl && <img src={invoiceLogoUrl} alt="" />}
                <div>
                  <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                  {(receiptSettings?.businessWebsite || receiptSettings?.businessEmail) && (
                    <p>{receiptSettings?.businessWebsite || receiptSettings?.businessEmail}</p>
                  )}
                </div>
              </div>
              <div className={styles.printMeta}>
                <h1>{receiptSettings?.title || 'Comprobante de pago'}</h1>
                <span>Referencia {payment.publicPaymentId}</span>
                <span>Fecha de pago {formatDate(payment.paidAt || new Date().toISOString())}</span>
              </div>
            </header>

            {receiptSettings?.intro && <p className={styles.printIntro}>{receiptSettings.intro}</p>}

            <section className={styles.printPaymentMeta}>
              <div>
                <span>Estado</span>
                <strong>Pagado</strong>
              </div>
              <div>
                <span>Fecha de pago</span>
                <strong>{formatDate(payment.paidAt || new Date().toISOString())}</strong>
              </div>
              <div>
                <span>Vencimiento</span>
                <strong>{formatDate(payment.dueDate)}</strong>
              </div>
              <div>
                <span>Pasarela</span>
                <strong>{providerLabel} · {paymentModeLabel}</strong>
              </div>
            </section>

            <section className={styles.printParties}>
              {showBusinessInfo && (
                <div>
                  <span>Emitido por</span>
                  <strong>{receiptSettings?.businessName || 'Negocio'}</strong>
                  {receiptSettings?.businessEmail && <p>{receiptSettings.businessEmail}</p>}
                  {receiptSettings?.businessPhone && <p>{receiptSettings.businessPhone}</p>}
                  {receiptSettings?.businessAddress && <p>{receiptSettings.businessAddress}</p>}
                </div>
              )}
              {showCustomerInfo && (
                <div>
                  <span>Cliente</span>
                  <strong>{payment.contact?.name || 'Cliente'}</strong>
                  {payment.contact?.email && <p>{payment.contact.email}</p>}
                  {payment.contact?.phone && <p>{payment.contact.phone}</p>}
                  <p>Referencia {payment.publicPaymentId}</p>
                </div>
              )}
            </section>

            <section className={styles.printLines}>
              <div className={styles.printLineHeader}>
                <span>Concepto</span>
                <span>Cant.</span>
                <span>Importe</span>
              </div>
              <div className={styles.printLineItem}>
                <strong>{payment.title || 'Pago'}</strong>
                <span>1</span>
                <span>{formatCurrency(subtotalAmount, payment.currency)}</span>
              </div>
              {payment.description && <p className={styles.printDescription}>{payment.description}</p>}
            </section>

            <section className={styles.printTotals}>
              <div>
                <span>Subtotal</span>
                <strong>{formatCurrency(subtotalAmount, payment.currency)}</strong>
              </div>
              {hasTaxBreakdown && (
                <div>
                  <span>{taxDetails?.calculationMode === 'inclusive' ? `${taxDetails?.taxName || 'Impuesto'} incluido` : taxDetails?.taxName || 'Impuesto'}</span>
                  <strong>{formatCurrency(taxAmount, payment.currency)}</strong>
                </div>
              )}
              <div>
                <span>Total pagado</span>
                <strong>{formatCurrency(totalAmount, payment.currency)}</strong>
              </div>
            </section>

            {showTerms && receiptSettings?.terms && (
              <section className={styles.printTerms}>
                <strong>Términos y condiciones</strong>
                <p>{receiptSettings.terms}</p>
              </section>
            )}

            {receiptSettings?.footer && <p className={styles.printFooter}>{receiptSettings.footer}</p>}
          </section>
        </article>
      )}
    </main>
  )
}
