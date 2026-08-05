import { useEffect, useMemo, useState } from 'react'
import { Check, CreditCard, Link as LinkIcon } from 'lucide-react'
import { useAccountCurrency } from '@/hooks/useAccountCurrency'
import type { PaymentGatewayProvider } from '@/hooks/usePaymentGatewayCapabilities'
import { useLabels } from '@/contexts/LabelsContext'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { conektaPaymentsService, type ConektaSavedPaymentSource } from '@/services/conektaPaymentsService'
import { stripePaymentsService, type StripeSavedPaymentMethod } from '@/services/stripePaymentsService'
import {
  subscriptionsService,
  type PaymentSubscription,
  type SubscriptionInterval,
  type SubscriptionPayload
} from '@/services/subscriptionsService'
import { DEFAULT_CRM_LABELS, formatCrmLabelLower } from '@/utils/crmLabels'
import { formatCurrency } from '@/utils/format'
import { todayDateOnlyInTimezone } from '@/utils/timezone'
import { Button } from '../Button'
import { ContactSearchInput, type ContactSearchInputContact } from '../ContactSearchInput/ContactSearchInput'
import { CustomSelect } from '../CustomSelect'
import { DatePicker } from '../DatePicker'
import { Modal } from '../Modal'
import { NumberInput } from '../NumberInput'
import { PaymentLinkReadyPanel, type PaymentLinkReadyData } from '../PaymentLinkReadyPanel'
import { PaymentPlatformLogo, type PaymentPlatformLogoId } from '../PaymentPlatformLogo'
import styles from './CreateSubscriptionModal.module.css'

type SubscriptionProvider = Exclude<PaymentGatewayProvider, 'clip'>
type SubscriptionStep = 'details' | 'start_method' | 'gateway' | 'saved_card'
type SubscriptionStartMode = 'link' | 'saved_card' | ''
type SubscriptionPaymentMethod =
  | 'stripe_saved_card'
  | 'stripe_link'
  | 'conekta_subscription'
  | 'conekta_link'
  | 'mercadopago_subscription'
  | 'rebill_subscription'
type SubscriptionDurationType = 'continuous' | 'until_date'

interface SubscriptionDraft {
  name: string
  description: string
  amount: string
  intervalType: SubscriptionInterval
  intervalCount: string
  startDate: string
  cancelAt: string
  durationType: SubscriptionDurationType
  startMode: SubscriptionStartMode
  paymentMethod: SubscriptionPaymentMethod
  paymentProvider: SubscriptionProvider
}

export interface CreateSubscriptionModalProps {
  isOpen: boolean
  onClose: () => void
  providers: PaymentGatewayProvider[]
  initialContact?: Partial<ContactSearchInputContact> | null
  lockInitialContact?: boolean
  onSaved?: (subscription: PaymentSubscription) => void | Promise<void>
}

interface PaymentMethodOption {
  value: SubscriptionPaymentMethod
  provider: SubscriptionProvider
  label: string
  description: string
}

const INTERVAL_OPTIONS: Array<{ value: SubscriptionInterval; label: string }> = [
  { value: 'daily', label: 'Diaria' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'yearly', label: 'Anual' }
]

const DURATION_OPTIONS: Array<{ value: SubscriptionDurationType; label: string }> = [
  { value: 'continuous', label: 'Continua, sin fecha final' },
  { value: 'until_date', label: 'Hasta una fecha específica' }
]

const PAYMENT_METHOD_OPTIONS: PaymentMethodOption[] = [
  {
    value: 'stripe_link',
    provider: 'stripe',
    label: 'Stripe',
    description: 'Checkout seguro para autorizar la suscripción.'
  },
  {
    value: 'conekta_link',
    provider: 'conekta',
    label: 'Conekta',
    description: 'Link hospedado para autorizar la domiciliación.'
  },
  {
    value: 'mercadopago_subscription',
    provider: 'mercadopago',
    label: 'Mercado Pago',
    description: 'Link de autorización de Mercado Pago.'
  },
  {
    value: 'rebill_subscription',
    provider: 'rebill',
    label: 'Rebill',
    description: 'Checkout hospedado para autorizar la suscripción.'
  }
]

function isSubscriptionProvider(provider: PaymentGatewayProvider): provider is SubscriptionProvider {
  return provider !== 'clip'
}

function createDraft(timezone: string, providers: SubscriptionProvider[]): SubscriptionDraft {
  const today = todayDateOnlyInTimezone(timezone)
  const provider = providers[0] || 'stripe'
  const paymentMethod = PAYMENT_METHOD_OPTIONS.find((option) => option.provider === provider)?.value || 'stripe_link'

  return {
    name: '',
    description: '',
    amount: '',
    intervalType: 'monthly',
    intervalCount: '1',
    startDate: today,
    cancelAt: '',
    durationType: 'continuous',
    startMode: '',
    paymentMethod,
    paymentProvider: provider
  }
}

function normalizeContact(contact?: Partial<ContactSearchInputContact> | null): ContactSearchInputContact | null {
  if (!contact?.id) return null
  return {
    id: contact.id,
    name: contact.name || '',
    email: contact.email || '',
    phone: contact.phone || '',
    firstName: contact.firstName || '',
    lastName: contact.lastName || ''
  }
}

function getStripePaymentMethodId(method?: StripeSavedPaymentMethod | null) {
  return method?.stripePaymentMethodId || method?.id || ''
}

function getStripeCardLabel(method?: StripeSavedPaymentMethod | null) {
  if (!method) return 'Tarjeta guardada'
  const brand = method.brand ? method.brand.toUpperCase() : 'Tarjeta'
  const label = `${brand} •••• ${method.last4 || '----'}`
  return method.expiresLabel ? `${label} · vence ${method.expiresLabel}` : label
}

function getConektaPaymentSourceId(source?: ConektaSavedPaymentSource | null) {
  return source?.conektaPaymentSourceId || source?.id || ''
}

function getConektaCardLabel(source?: ConektaSavedPaymentSource | null) {
  if (!source) return 'Tarjeta guardada'
  const brand = source.brand ? source.brand.toUpperCase() : 'Tarjeta'
  const label = `${brand} •••• ${source.last4 || '----'}`
  return source.expiresLabel ? `${label} · vence ${source.expiresLabel}` : label
}

function getSubscriptionStartUrl(subscription: PaymentSubscription) {
  if (subscription.paymentMethod === 'mercadopago_subscription') {
    const mercadoPagoUrl = subscription.paymentMode === 'test'
      ? subscription.mercadoPagoSandboxInitPoint || subscription.mercadoPagoInitPoint
      : subscription.mercadoPagoInitPoint || subscription.mercadoPagoSandboxInitPoint
    if (mercadoPagoUrl) return mercadoPagoUrl
  }

  const directUrl = subscription.rebillPaymentLinkUrl ||
    subscription.rebillCheckoutUrl ||
    subscription.subscriptionStartUrl ||
    subscription.stripeCheckoutUrl ||
    subscription.conektaCheckoutUrl ||
    ''
  if (directUrl) return directUrl

  const publicPaymentId = String(subscription.subscriptionStartPublicPaymentId || '').trim()
  if (!publicPaymentId) return ''
  const path = `/pay/${encodeURIComponent(publicPaymentId)}`
  return typeof window === 'undefined' ? path : `${window.location.origin.replace(/\/+$/, '')}${path}`
}

function buildReadyLink(
  subscription: PaymentSubscription,
  payload: SubscriptionPayload,
  contact: ContactSearchInputContact,
  customerLowerLabel: string
): PaymentLinkReadyData | null {
  const paymentUrl = getSubscriptionStartUrl(subscription)
  if (!paymentUrl) return null

  const provider = (subscription.subscriptionStartPaymentProvider || subscription.paymentProvider || payload.paymentProvider) as PaymentPlatformLogoId
  return {
    kind: 'subscription_start',
    title: 'Link de suscripción listo',
    description: `Compártelo para que el ${customerLowerLabel} autorice los cobros recurrentes.`,
    linkLabel: 'Enlace de suscripción',
    provider,
    paymentUrl,
    amount: Number(subscription.amount || payload.amount || 0),
    currency: subscription.currency || payload.currency,
    contact: {
      id: subscription.contactId || contact.id,
      name: subscription.contactName || contact.name,
      email: subscription.contactEmail || contact.email,
      phone: subscription.contactPhone || contact.phone
    },
    paymentId: subscription.subscriptionStartPaymentId || null,
    publicPaymentId: subscription.subscriptionStartPublicPaymentId || null
  }
}

export function CreateSubscriptionModal({
  isOpen,
  onClose,
  providers,
  initialContact = null,
  lockInitialContact = false,
  onSaved
}: CreateSubscriptionModalProps) {
  const { timezone } = useTimezone()
  const { labels } = useLabels()
  const { showToast } = useNotification()
  const [accountCurrency] = useAccountCurrency()
  const customerLabel = labels.customer?.trim() || DEFAULT_CRM_LABELS.customer
  const customerLowerLabel = formatCrmLabelLower(customerLabel, DEFAULT_CRM_LABELS.customer)
  const subscriptionProviders = useMemo(
    () => providers.filter(isSubscriptionProvider),
    [providers]
  )
  const providerKey = subscriptionProviders.join('|')
  const linkOptions = useMemo(
    () => PAYMENT_METHOD_OPTIONS.filter((option) => subscriptionProviders.includes(option.provider)),
    [subscriptionProviders]
  )

  const [step, setStep] = useState<SubscriptionStep>('details')
  const [selectedContact, setSelectedContact] = useState<ContactSearchInputContact | null>(null)
  const [draft, setDraft] = useState<SubscriptionDraft>(() => createDraft(timezone, subscriptionProviders))
  const [saving, setSaving] = useState(false)
  const [loadingSavedCards, setLoadingSavedCards] = useState(false)
  const [stripeCards, setStripeCards] = useState<StripeSavedPaymentMethod[]>([])
  const [conektaCards, setConektaCards] = useState<ConektaSavedPaymentSource[]>([])
  const [selectedStripeCardId, setSelectedStripeCardId] = useState('')
  const [selectedConektaCardId, setSelectedConektaCardId] = useState('')
  const [readyLink, setReadyLink] = useState<PaymentLinkReadyData | null>(null)

  const resolvedContact = lockInitialContact ? normalizeContact(initialContact) : selectedContact
  const hasStripeCards = subscriptionProviders.includes('stripe') && stripeCards.length > 0
  const hasConektaCards = subscriptionProviders.includes('conekta') && conektaCards.length > 0
  const hasSavedCards = hasStripeCards || hasConektaCards
  const selectedStripeCard = stripeCards.find((method) => getStripePaymentMethodId(method) === selectedStripeCardId) || null
  const selectedConektaCard = conektaCards.find((source) => getConektaPaymentSourceId(source) === selectedConektaCardId) || null
  const selectedSavedCardReady = draft.paymentMethod === 'stripe_saved_card'
    ? Boolean(selectedStripeCard)
    : draft.paymentMethod === 'conekta_subscription'
      ? Boolean(selectedConektaCard)
      : false
  const amount = Number(String(draft.amount || '').replace(',', '.')) || 0
  const today = todayDateOnlyInTimezone(timezone)

  useEffect(() => {
    if (!isOpen) return

    setStep('details')
    setSelectedContact(lockInitialContact ? null : normalizeContact(initialContact))
    setDraft(createDraft(timezone, subscriptionProviders))
    setSaving(false)
    setReadyLink(null)
    setStripeCards([])
    setConektaCards([])
    setSelectedStripeCardId('')
    setSelectedConektaCardId('')
  }, [initialContact?.id, isOpen, lockInitialContact, providerKey, timezone])

  useEffect(() => {
    if (!isOpen || !resolvedContact?.id || (!subscriptionProviders.includes('stripe') && !subscriptionProviders.includes('conekta'))) {
      setStripeCards([])
      setConektaCards([])
      setSelectedStripeCardId('')
      setSelectedConektaCardId('')
      setLoadingSavedCards(false)
      return
    }

    let cancelled = false
    setLoadingSavedCards(true)
    Promise.all([
      subscriptionProviders.includes('stripe')
        ? stripePaymentsService.getSavedPaymentMethods(resolvedContact.id).catch(() => [])
        : Promise.resolve([]),
      subscriptionProviders.includes('conekta')
        ? conektaPaymentsService.getSavedPaymentSources(resolvedContact.id).catch(() => [])
        : Promise.resolve([])
    ]).then(([stripeMethods, conektaSources]) => {
      if (cancelled) return
      setStripeCards(stripeMethods)
      setConektaCards(conektaSources)
      const defaultStripe = stripeMethods.find((method) => method.isDefault) || stripeMethods[0]
      const defaultConekta = conektaSources.find((source) => source.isDefault) || conektaSources[0]
      setSelectedStripeCardId(getStripePaymentMethodId(defaultStripe))
      setSelectedConektaCardId(getConektaPaymentSourceId(defaultConekta))
    }).finally(() => {
      if (!cancelled) setLoadingSavedCards(false)
    })

    return () => {
      cancelled = true
    }
  }, [isOpen, providerKey, resolvedContact?.id])

  const patchDraft = <K extends keyof SubscriptionDraft>(field: K, value: SubscriptionDraft[K]) => {
    setDraft((current) => {
      if (field === 'durationType' && value === 'continuous') {
        return { ...current, durationType: 'continuous', cancelAt: '' }
      }
      return { ...current, [field]: value }
    })
  }

  const validateDetails = () => {
    const intervalCount = Number.parseInt(draft.intervalCount, 10)
    if (!resolvedContact?.id) {
      showToast('warning', 'Falta el contacto', 'Selecciona el contacto que tendrá esta suscripción.')
      return false
    }
    if (!draft.name.trim()) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama la suscripción.')
      return false
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('warning', 'Falta el monto', 'Escribe un monto válido para la suscripción.')
      return false
    }
    if (!Number.isFinite(intervalCount) || intervalCount <= 0) {
      showToast('warning', 'Frecuencia inválida', 'La frecuencia debe ser de al menos un periodo.')
      return false
    }
    if (!draft.startDate || draft.startDate < today) {
      showToast('warning', 'Fecha inválida', 'La suscripción no puede iniciar en una fecha pasada.')
      return false
    }
    if (draft.durationType === 'until_date' && (!draft.cancelAt || draft.cancelAt <= draft.startDate)) {
      showToast('warning', 'Duración inválida', 'La fecha final debe ser posterior al inicio de la suscripción.')
      return false
    }
    return true
  }

  const chooseStartMode = (mode: Exclude<SubscriptionStartMode, ''>) => {
    if (mode === 'saved_card' && !hasSavedCards) {
      showToast('warning', 'No hay tarjetas guardadas', `Este ${customerLowerLabel} todavía no tiene tarjetas guardadas en Stripe o Conekta.`)
      return
    }

    const fallback = mode === 'link'
      ? linkOptions[0]
      : hasStripeCards
        ? { value: 'stripe_saved_card' as const, provider: 'stripe' as const }
        : { value: 'conekta_subscription' as const, provider: 'conekta' as const }
    if (!fallback) return

    setDraft((current) => ({
      ...current,
      startMode: mode,
      paymentMethod: fallback.value,
      paymentProvider: fallback.provider
    }))
  }

  const chooseLinkGateway = (option: PaymentMethodOption) => {
    setDraft((current) => ({
      ...current,
      startMode: 'link',
      paymentMethod: option.value,
      paymentProvider: option.provider
    }))
  }

  const chooseSavedCardGateway = (provider: 'stripe' | 'conekta') => {
    setDraft((current) => ({
      ...current,
      startMode: 'saved_card',
      paymentMethod: provider === 'stripe' ? 'stripe_saved_card' : 'conekta_subscription',
      paymentProvider: provider
    }))
  }

  const buildPayload = (): SubscriptionPayload | null => {
    if (!resolvedContact || !validateDetails()) return null

    const intervalCount = Number.parseInt(draft.intervalCount, 10)
    const startsByLink = draft.startMode === 'link'
    if (startsByLink && draft.paymentProvider !== 'mercadopago' && !resolvedContact.email) {
      showToast('warning', 'Falta el email', `${draft.paymentProvider === 'rebill' ? 'Rebill' : draft.paymentProvider === 'conekta' ? 'Conekta' : 'Stripe'} necesita email para crear el link de suscripción.`)
      return null
    }
    if (draft.paymentProvider === 'conekta' && draft.intervalType === 'daily') {
      showToast('warning', 'Frecuencia no soportada', 'Conekta no acepta suscripciones diarias.')
      return null
    }
    if (draft.paymentProvider === 'rebill' && !['monthly', 'yearly'].includes(draft.intervalType)) {
      showToast('warning', 'Frecuencia no soportada', 'Rebill sólo acepta suscripciones mensuales o anuales.')
      return null
    }
    if (!startsByLink && !selectedSavedCardReady) {
      showToast('warning', 'Selecciona una tarjeta', 'Elige la tarjeta guardada que iniciará la suscripción.')
      return null
    }

    return {
      contactId: resolvedContact.id,
      contactName: resolvedContact.name || null,
      contactEmail: resolvedContact.email || null,
      contactPhone: resolvedContact.phone || null,
      name: draft.name.trim(),
      description: draft.description.trim(),
      status: startsByLink ? 'incomplete' : 'active',
      amount,
      currency: accountCurrency,
      intervalType: draft.intervalType,
      intervalCount,
      startDate: draft.startDate,
      nextRunAt: startsByLink ? null : draft.startDate,
      cancelAt: draft.durationType === 'until_date' ? draft.cancelAt : null,
      paymentMethod: draft.paymentMethod,
      paymentProvider: draft.paymentProvider,
      stripePaymentMethodId: draft.paymentMethod === 'stripe_saved_card'
        ? getStripePaymentMethodId(selectedStripeCard)
        : undefined,
      conektaPaymentSourceId: draft.paymentMethod === 'conekta_subscription'
        ? getConektaPaymentSourceId(selectedConektaCard)
        : undefined,
      source: 'ristak'
    }
  }

  const saveSubscription = async () => {
    const payload = buildPayload()
    if (!payload || !resolvedContact) return

    setSaving(true)
    try {
      const created = await subscriptionsService.createSubscription(payload)
      await onSaved?.(created)
      const link = buildReadyLink(created, payload, resolvedContact, customerLowerLabel)
      if (link) {
        setReadyLink(link)
        showToast('success', 'Link de suscripción listo', 'Ya puedes copiarlo o enviarlo desde aquí.')
        return
      }

      showToast('success', 'Suscripción creada', `${payload.name} ya quedó activa.`)
      onClose()
    } catch (error) {
      showToast('error', 'No se guardó la suscripción', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const continueFlow = () => {
    if (step === 'details') {
      if (!validateDetails()) return
      if (subscriptionProviders.length === 0) {
        showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta, Mercado Pago o Rebill para crear suscripciones.')
        return
      }
      setStep('start_method')
      return
    }
    if (step === 'start_method') {
      if (!draft.startMode) {
        showToast('warning', 'Elige cómo iniciar', 'Selecciona un link o una tarjeta guardada.')
        return
      }
      if (draft.startMode === 'saved_card') {
        setStep('saved_card')
        return
      }
      if (linkOptions.length > 1) {
        setStep('gateway')
        return
      }
      void saveSubscription()
      return
    }
    void saveSubscription()
  }

  const goBack = () => {
    if (saving) return
    if (step === 'gateway' || step === 'saved_card') {
      setStep('start_method')
      return
    }
    if (step === 'start_method') {
      setStep('details')
      return
    }
    onClose()
  }

  const requestClose = () => {
    if (saving) return
    onClose()
  }

  const title = readyLink
    ? 'Link de suscripción listo'
    : step === 'start_method'
      ? 'Elige cómo iniciar'
      : step === 'gateway'
        ? 'Elige pasarela'
        : step === 'saved_card'
          ? 'Elige tarjeta guardada'
          : 'Nueva suscripción'

  const actionText = step === 'details'
    ? 'Continuar'
    : step === 'start_method'
      ? 'Continuar'
      : draft.startMode === 'link'
        ? 'Crear link de suscripción'
        : 'Crear suscripción'

  return (
    <Modal
      isOpen={isOpen}
      onClose={requestClose}
      title={title}
      type="custom"
      size="md"
      closeOnBackdropClick={!saving && !readyLink}
      closeOnEscape={!saving && !readyLink}
    >
      {readyLink ? (
        <div className={styles.form}>
          <PaymentLinkReadyPanel link={readyLink} />
          <div className={styles.footerActions}>
            <Button type="button" onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault()
            continueFlow()
          }}
        >
          {step === 'details' ? (
            <div className={styles.formGrid}>
              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <ContactSearchInput
                  label={customerLabel}
                  value={resolvedContact}
                  onChange={setSelectedContact}
                  placeholder={`Buscar ${customerLowerLabel} por nombre, email o teléfono`}
                  required
                  disabled={lockInitialContact}
                />
              </div>

              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label htmlFor="subscription-name">Nombre</label>
                <input
                  id="subscription-name"
                  value={draft.name}
                  onChange={(event) => patchDraft('name', event.target.value)}
                  placeholder="Mensualidad, membresía, soporte..."
                  required
                />
              </div>

              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label htmlFor="subscription-description">Descripción</label>
                <textarea
                  id="subscription-description"
                  rows={3}
                  value={draft.description}
                  onChange={(event) => patchDraft('description', event.target.value)}
                  placeholder="Notas internas de esta suscripción."
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="subscription-amount">Monto ({accountCurrency})</label>
                <NumberInput
                  id="subscription-amount"
                  value={draft.amount}
                  onChange={(event) => patchDraft('amount', event.target.value)}
                  min="0"
                  step="0.01"
                  maxFractionDigits={2}
                  placeholder="0.00"
                  required
                />
                <p className={styles.formHint}>{formatCurrency(amount, accountCurrency)}</p>
              </div>

              <div className={styles.formGroup}>
                <label>Frecuencia</label>
                <CustomSelect
                  value={draft.intervalType}
                  onValueChange={(value) => patchDraft('intervalType', value as SubscriptionInterval)}
                  options={INTERVAL_OPTIONS}
                  portal
                />
              </div>

              <div className={styles.formGroup}>
                <label htmlFor="subscription-interval-count">Cobrar cada</label>
                <NumberInput
                  id="subscription-interval-count"
                  value={draft.intervalCount}
                  onChange={(event) => patchDraft('intervalCount', event.target.value)}
                  min="1"
                  step="1"
                  maxFractionDigits={0}
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label>Inicio</label>
                <DatePicker
                  value={draft.startDate}
                  onChange={(value) => patchDraft('startDate', value)}
                  min={today}
                  today={today}
                  ariaLabel="Fecha de inicio de la suscripción"
                />
              </div>

              <div className={styles.formGroup}>
                <label>Duración</label>
                <CustomSelect
                  value={draft.durationType}
                  onValueChange={(value) => patchDraft('durationType', value as SubscriptionDurationType)}
                  options={DURATION_OPTIONS}
                  portal
                />
              </div>

              {draft.durationType === 'until_date' ? (
                <div className={styles.formGroup}>
                  <label>Termina el</label>
                  <DatePicker
                    value={draft.cancelAt}
                    onChange={(value) => patchDraft('cancelAt', value)}
                    min={draft.startDate || today}
                    today={today}
                    ariaLabel="Fecha final de la suscripción"
                  />
                </div>
              ) : null}
            </div>
          ) : step === 'start_method' ? (
            <div className={styles.paymentOptions}>
              {loadingSavedCards ? (
                <p className={styles.emptyState}>Buscando tarjetas guardadas del contacto…</p>
              ) : hasSavedCards ? (
                <button
                  type="button"
                  className={styles.optionButton}
                  data-active={draft.startMode === 'saved_card' ? 'true' : undefined}
                  onClick={() => chooseStartMode('saved_card')}
                >
                  <span className={styles.optionInfo}>
                    <span className={styles.optionIcon}><CreditCard size={18} aria-hidden="true" /></span>
                    <span><strong>Cobrar tarjeta guardada</strong><small>Activa la suscripción con Stripe o Conekta.</small></span>
                  </span>
                  {draft.startMode === 'saved_card' ? <Check size={18} aria-hidden="true" /> : null}
                </button>
              ) : null}

              <button
                type="button"
                className={styles.optionButton}
                data-active={draft.startMode === 'link' ? 'true' : undefined}
                onClick={() => chooseStartMode('link')}
              >
                <span className={styles.optionInfo}>
                  <span className={styles.optionIcon}><LinkIcon size={18} aria-hidden="true" /></span>
                  <span><strong>Enviar link de suscripción</strong><small>El contacto autoriza los cobros desde la pasarela.</small></span>
                </span>
                {draft.startMode === 'link' ? <Check size={18} aria-hidden="true" /> : null}
              </button>
            </div>
          ) : step === 'gateway' ? (
            <div className={styles.paymentOptions}>
              {linkOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.optionButton}
                  data-active={draft.paymentMethod === option.value ? 'true' : undefined}
                  onClick={() => chooseLinkGateway(option)}
                >
                  <span className={styles.optionInfo}>
                    <span className={styles.optionIcon}>
                      <PaymentPlatformLogo platform={option.provider} size="md" decorative />
                    </span>
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </span>
                  {draft.paymentMethod === option.value ? <Check size={18} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>
          ) : (
            <div className={styles.paymentOptions}>
              {hasStripeCards ? (
                <div className={styles.savedCardRow} data-active={draft.paymentProvider === 'stripe' ? 'true' : undefined}>
                  <button type="button" onClick={() => chooseSavedCardGateway('stripe')}>
                    <PaymentPlatformLogo platform="stripe" size="md" decorative />
                    <span><strong>Stripe</strong><small>Iniciará la suscripción con Stripe.</small></span>
                  </button>
                  <CustomSelect
                    value={selectedStripeCardId}
                    onValueChange={(value) => {
                      setSelectedStripeCardId(value)
                      chooseSavedCardGateway('stripe')
                    }}
                    options={stripeCards.map((method) => ({
                      value: getStripePaymentMethodId(method),
                      label: getStripeCardLabel(method)
                    }))}
                    portal
                  />
                </div>
              ) : null}

              {hasConektaCards ? (
                <div className={styles.savedCardRow} data-active={draft.paymentProvider === 'conekta' ? 'true' : undefined}>
                  <button type="button" onClick={() => chooseSavedCardGateway('conekta')}>
                    <PaymentPlatformLogo platform="conekta" size="md" decorative />
                    <span><strong>Conekta</strong><small>Iniciará la domiciliación con Conekta.</small></span>
                  </button>
                  <CustomSelect
                    value={selectedConektaCardId}
                    onValueChange={(value) => {
                      setSelectedConektaCardId(value)
                      chooseSavedCardGateway('conekta')
                    }}
                    options={conektaCards.map((source) => ({
                      value: getConektaPaymentSourceId(source),
                      label: getConektaCardLabel(source)
                    }))}
                    portal
                  />
                </div>
              ) : null}
            </div>
          )}

          <div className={styles.footerActions}>
            <Button type="button" variant="ghost" onClick={goBack} disabled={saving}>
              {step === 'details' ? 'Cancelar' : 'Atrás'}
            </Button>
            <Button type="submit" loading={saving} disabled={step === 'saved_card' && !selectedSavedCardReady}>
              {actionText}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
