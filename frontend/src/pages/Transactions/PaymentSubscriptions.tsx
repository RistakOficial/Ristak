import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  CalendarClock,
  Check,
  ChevronRight,
  Copy,
  CreditCard,
  Edit3,
  ExternalLink,
  Link as LinkIcon,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  XCircle
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  ContactSearchInput,
  CustomSelect,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  KpiCard,
  Modal,
  NumberInput,
  PageContainer,
  PageHeader,
  PaymentLinkReadyPanel,
  PaymentPlatformLogo,
  Table,
  TableSelectionToolbar
} from '@/components/common'
import type { BadgeVariant, Column, PaymentLinkReadyData, PaymentPlatformLogoId } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAccountCurrency } from '@/hooks'
import type { Contact } from '@/types'
import { formatCurrency } from '@/utils/format'
import { toDateTimeLocalInputValue, todayDateOnlyInTimezone } from '@/utils/timezone'
import { getIntegrationsStatus } from '@/services/integrationsService'
import { conektaPaymentsService, type ConektaSavedPaymentSource } from '@/services/conektaPaymentsService'
import { stripePaymentsService, type StripeSavedPaymentMethod } from '@/services/stripePaymentsService'
import {
  subscriptionsService,
  type PaymentSubscription,
  type SubscriptionInterval,
  type SubscriptionPayload,
  type SubscriptionStatus,
  type SubscriptionSummary
} from '@/services/subscriptionsService'
import styles from './PaymentSubscriptions.module.css'

type SubscriptionFormMode = 'create' | 'edit' | null
type SubscriptionFormStep = 'details' | 'start_method' | 'gateway' | 'saved_card'
type SubscriptionStartMode = 'link' | 'saved_card' | ''
type SubscriptionBulkAction = 'activate' | 'pause' | 'cancel'
type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago' | 'clip'
type SubscriptionPaymentMethod = 'stripe_saved_card' | 'stripe_link' | 'conekta_subscription' | 'conekta_link' | 'mercadopago_checkout' | 'mercadopago_subscription' | 'clip_link'
type SubscriptionDurationType = 'continuous' | 'until_date'

interface SubscriptionFormState {
  name: string
  description: string
  amount: string
  intervalType: SubscriptionInterval
  intervalCount: string
  startDate: string
  nextRunAt: string
  cancelAt: string
  durationType: SubscriptionDurationType
  status: SubscriptionStatus
  startMode: SubscriptionStartMode
  paymentMethod: SubscriptionPaymentMethod
  paymentProvider: PaymentGatewayProvider
}

const EMPTY_SUMMARY: SubscriptionSummary = {
  total: 0,
  active: 0,
  paused: 0,
  pastDue: 0,
  monthlyRevenue: 0,
  nextRunAt: null
}

const STATUS_FILTERS = [
  { label: 'Todas', value: 'all' },
  { label: 'Activas', value: 'active' },
  { label: 'Pausadas', value: 'paused' },
  { label: 'Vencidas', value: 'past_due' },
  { label: 'Canceladas', value: 'cancelled' }
]

const INTERVAL_OPTIONS: Array<{ value: SubscriptionInterval; label: string }> = [
  { value: 'daily', label: 'Diaria' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'yearly', label: 'Anual' }
]

const STATUS_OPTIONS: Array<{ value: SubscriptionStatus; label: string }> = [
  { value: 'active', label: 'Activa' },
  { value: 'draft', label: 'Borrador' },
  { value: 'trialing', label: 'Prueba' },
  { value: 'paused', label: 'Pausada' },
  { value: 'past_due', label: 'Vencida' },
  { value: 'incomplete', label: 'Incompleta' },
  { value: 'cancelled', label: 'Cancelada' }
]

const PAYMENT_METHOD_OPTIONS: Array<{
  value: SubscriptionPaymentMethod
  label: string
  provider: PaymentGatewayProvider
  modeLabel: string
  description: string
  requirement: string
  result: string
}> = [
  {
    value: 'stripe_saved_card',
    label: 'Stripe - tarjeta guardada',
    provider: 'stripe',
    modeLabel: 'Tarjeta guardada',
    description: 'Activa la suscripción usando la tarjeta guardada del contacto.',
    requirement: 'Requiere un contacto con tarjeta guardada en Stripe.',
    result: 'Se crea como suscripción en Stripe.'
  },
  {
    value: 'stripe_link',
    label: 'Stripe - link de suscripción',
    provider: 'stripe',
    modeLabel: 'Link de suscripción',
    description: 'Genera un Checkout de Stripe para que el cliente autorice la suscripción.',
    requirement: 'Requiere un contacto con email.',
    result: 'Al autorizarse, Stripe activa la suscripción.'
  },
  {
    value: 'conekta_subscription',
    label: 'Conekta - tarjeta guardada',
    provider: 'conekta',
    modeLabel: 'Tarjeta guardada',
    description: 'Activa la domiciliación con la tarjeta guardada del contacto.',
    requirement: 'Requiere un contacto con tarjeta guardada de Conekta.',
    result: 'Se crea como suscripción domiciliada.'
  },
  {
    value: 'conekta_link',
    label: 'Conekta - link de suscripción',
    provider: 'conekta',
    modeLabel: 'Link de suscripción',
    description: 'Genera un link hospedado de Conekta para que el cliente autorice la suscripción.',
    requirement: 'Requiere un contacto con email.',
    result: 'Al autorizarse, Conekta activa la suscripción.'
  },
  {
    value: 'mercadopago_subscription',
    label: 'Mercado Pago - suscripción Mercado Pago',
    provider: 'mercadopago',
    modeLabel: 'Link de suscripción',
    description: 'Crea un plan de suscripción en Mercado Pago y entrega su link de autorización.',
    requirement: 'El cliente captura o confirma sus datos al autorizar el link en Mercado Pago.',
    result: 'Mercado Pago activa la suscripción cuando el cliente autoriza el link.'
  }
]

const DURATION_OPTIONS: Array<{ value: SubscriptionDurationType; label: string }> = [
  { value: 'continuous', label: 'Continua, sin fecha final' },
  { value: 'until_date', label: 'Hasta una fecha específica' }
]

const LINK_PAYMENT_METHODS = new Set<string>([
  'stripe_link',
  'stripe_payment_link',
  'conekta_link',
  'conekta_payment_link',
  'mercadopago_subscription'
])
const SAVED_CARD_PAYMENT_METHODS = new Set<SubscriptionPaymentMethod>(['stripe_saved_card', 'conekta_subscription'])

function isLinkPaymentMethod(value?: string | null) {
  return LINK_PAYMENT_METHODS.has(String(value || '').toLowerCase())
}

function getStartModeForPaymentMethod(value?: string | null): SubscriptionStartMode {
  if (isLinkPaymentMethod(value)) return 'link'
  if (value && SAVED_CARD_PAYMENT_METHODS.has(value as SubscriptionPaymentMethod)) return 'saved_card'
  return ''
}

function toDateInputValue(value?: string | null, timezone?: string) {
  if (!value) return ''

  const raw = String(value).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  if (timezone) {
    const zonedValue = toDateTimeLocalInputValue(raw, timezone)
    if (zonedValue) return zonedValue.slice(0, 10)
  }

  const dateOnly = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  return dateOnly?.[1] || raw.slice(0, 10)
}

function getTodayInputValue(timezone: string) {
  return todayDateOnlyInTimezone(timezone)
}

function isDateBeforeToday(value?: string | null, timezone?: string) {
  return Boolean(value && timezone && value < getTodayInputValue(timezone))
}

function clampDateToToday(value: string | null | undefined, timezone: string) {
  const today = getTodayInputValue(timezone)
  return value && value >= today ? value : today
}

function createEmptyForm(timezone: string): SubscriptionFormState {
  const today = getTodayInputValue(timezone)

  return {
    name: '',
    description: '',
    amount: '',
    intervalType: 'monthly',
    intervalCount: '1',
    startDate: today,
    nextRunAt: today,
    cancelAt: '',
    durationType: 'continuous',
    status: 'active',
    startMode: '',
    paymentMethod: 'stripe_saved_card',
    paymentProvider: 'stripe'
  }
}

function resolvePaymentProvider(provider?: string | null): PaymentGatewayProvider {
  if (provider === 'clip' || provider === 'mercadopago' || provider === 'conekta' || provider === 'stripe') return provider
  return 'stripe'
}

function getPaymentProviderFromMethod(paymentMethod: string, paymentProvider: PaymentGatewayProvider): PaymentGatewayProvider {
  if (paymentMethod === 'mercadopago_subscription' || paymentMethod === 'mercadopago_checkout') return 'mercadopago'
  if (paymentMethod === 'conekta_subscription' || paymentMethod === 'conekta_link') return 'conekta'
  if (paymentMethod === 'clip_link') return 'clip'
  if (paymentMethod === 'stripe_saved_card' || paymentMethod === 'stripe_link') return 'stripe'
  return paymentProvider
}

function getPaymentProviderName(provider: PaymentGatewayProvider) {
  if (provider === 'mercadopago') return 'Mercado Pago'
  if (provider === 'conekta') return 'Conekta'
  if (provider === 'clip') return 'CLIP'
  return 'Stripe'
}

function getPaymentProviderList(options: Array<{ provider: PaymentGatewayProvider }>) {
  return Array.from(new Set(options.map((option) => getPaymentProviderName(option.provider)))).join(', ')
}

function getSavedStripeCardDescription(method?: StripeSavedPaymentMethod | null) {
  if (!method) return 'Tarjeta guardada'
  const brand = method.brand ? method.brand.toUpperCase() : 'Tarjeta'
  const label = `${brand} •••• ${method.last4 || '----'}`
  return method.expiresLabel ? `${label} · vence ${method.expiresLabel}` : label
}

function getSavedStripePaymentMethodId(method?: StripeSavedPaymentMethod | null) {
  return method?.stripePaymentMethodId || method?.id || ''
}

function getSavedConektaCardDescription(source?: ConektaSavedPaymentSource | null) {
  if (!source) return 'Tarjeta guardada'
  const brand = source.brand ? source.brand.toUpperCase() : 'Tarjeta'
  const label = `${brand} •••• ${source.last4 || '----'}`
  return source.expiresLabel ? `${label} · vence ${source.expiresLabel}` : label
}

function getSavedConektaPaymentSourceId(source?: ConektaSavedPaymentSource | null) {
  return source?.conektaPaymentSourceId || source?.id || ''
}

function getSubscriptionStatusLabel(status?: string | null) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'active') return 'Activa'
  if (normalized === 'trialing') return 'Prueba'
  if (normalized === 'past_due') return 'Vencida'
  if (normalized === 'paused') return 'Pausada'
  if (normalized === 'cancelled') return 'Cancelada'
  if (normalized === 'incomplete') return 'Incompleta'
  if (normalized === 'draft') return 'Borrador'
  return status || 'Sin estado'
}

function getSubscriptionStatusVariant(status?: string | null): BadgeVariant {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'active' || normalized === 'trialing') return 'success'
  if (normalized === 'paused' || normalized === 'draft') return 'warning'
  if (normalized === 'past_due' || normalized === 'incomplete') return 'error'
  if (normalized === 'cancelled') return 'neutral'
  return 'neutral'
}

function getIntervalLabel(intervalType?: string | null, intervalCount = 1) {
  const count = Number(intervalCount) || 1
  const normalized = String(intervalType || 'monthly').toLowerCase()

  const singular: Record<string, string> = {
    daily: 'día',
    weekly: 'semana',
    monthly: 'mes',
    yearly: 'año'
  }
  const plural: Record<string, string> = {
    daily: 'días',
    weekly: 'semanas',
    monthly: 'meses',
    yearly: 'años'
  }

  if (count <= 1) {
    if (normalized === 'daily') return 'Diaria'
    if (normalized === 'weekly') return 'Semanal'
    if (normalized === 'yearly') return 'Anual'
    return 'Mensual'
  }

  return `Cada ${count} ${plural[normalized] || singular[normalized] || 'periodos'}`
}

function getBillingCadenceHelp(intervalType: SubscriptionInterval, intervalCountValue: string) {
  const count = Number.parseInt(intervalCountValue, 10) || 1
  const normalized = String(intervalType || 'monthly').toLowerCase()
  const singular: Record<string, string> = {
    daily: 'día',
    weekly: 'semana',
    monthly: 'mes',
    yearly: 'año'
  }
  const plural: Record<string, string> = {
    daily: 'días',
    weekly: 'semanas',
    monthly: 'meses',
    yearly: 'años'
  }
  const unit = count === 1 ? singular[normalized] || 'periodo' : plural[normalized] || 'periodos'

  return count === 1 ? `Se cobrará cada ${unit}.` : `Se cobrará cada ${count} ${unit}.`
}

function getPaymentMethodLabel(value?: string | null) {
  const normalized = String(value || '').toLowerCase()
  if (normalized === 'stripe_saved_card') return 'Tarjeta guardada'
  if (normalized === 'stripe_link') return 'Link de suscripción Stripe'
  if (normalized === 'conekta_subscription') return 'Conekta domiciliado'
  if (normalized === 'conekta_link') return 'Link de suscripción Conekta'
  if (normalized === 'mercadopago_checkout') return 'Link de pago Mercado Pago'
  if (normalized === 'mercadopago_subscription') return 'Suscripción Mercado Pago'
  if (normalized === 'clip_link') return 'Pago único CLIP vinculado'
  if (normalized === 'manual') return 'Manual'
  return value || 'Sin método'
}

function getSourceLabel(subscription: PaymentSubscription) {
  if (subscription.paymentProvider === 'clip') return 'CLIP'
  if (subscription.mercadoPagoPreapprovalId || subscription.paymentProvider === 'mercadopago') return 'Mercado Pago'
  if (subscription.conektaSubscriptionId || subscription.paymentProvider === 'conekta') return 'Conekta'
  if (subscription.stripeSubscriptionId || subscription.paymentProvider === 'stripe') return 'Stripe'
  if (subscription.source === 'ghl') return 'HighLevel'
  return 'Ristak'
}

function getSubscriptionProviderLogo(subscription: PaymentSubscription): PaymentPlatformLogoId | null {
  if (subscription.paymentProvider === 'clip') return 'clip'
  if (subscription.mercadoPagoPreapprovalId || subscription.paymentProvider === 'mercadopago') return 'mercadopago'
  if (subscription.conektaSubscriptionId || subscription.paymentProvider === 'conekta') return 'conekta'
  if (subscription.stripeSubscriptionId || subscription.paymentProvider === 'stripe') return 'stripe'
  return null
}

function buildPublicPaymentUrl(publicPaymentId?: string | null) {
  const cleanId = String(publicPaymentId || '').trim()
  if (!cleanId) return ''

  const path = `/pay/${encodeURIComponent(cleanId)}`
  if (typeof window === 'undefined') return path

  return `${window.location.origin.replace(/\/+$/, '')}${path}`
}

function getMercadoPagoSubscriptionUrl(subscription: PaymentSubscription) {
  if (subscription.paymentMethod !== 'mercadopago_subscription') return ''
  if (subscription.paymentMode === 'test') {
    return subscription.mercadoPagoSandboxInitPoint || subscription.mercadoPagoInitPoint || ''
  }
  return subscription.mercadoPagoInitPoint || subscription.mercadoPagoSandboxInitPoint || ''
}

function getSubscriptionStartLink(subscription: PaymentSubscription) {
  const mercadoPagoUrl = getMercadoPagoSubscriptionUrl(subscription)
  if (mercadoPagoUrl) return mercadoPagoUrl

  return subscription.subscriptionStartUrl ||
    subscription.stripeCheckoutUrl ||
    subscription.conektaCheckoutUrl ||
    buildPublicPaymentUrl(subscription.subscriptionStartPublicPaymentId)
}

function getSubscriptionActionAvailability(subscription: PaymentSubscription) {
  const status = String(subscription.status || '').toLowerCase()
  const isMercadoPago = subscription.paymentProvider === 'mercadopago' || Boolean(subscription.mercadoPagoPreapprovalId)
  const startLink = getSubscriptionStartLink(subscription)
  const isPaymentLinkPending = Boolean(startLink) && status === 'incomplete'

  return {
    startLink,
    canPause: status === 'active' || status === 'trialing',
    canActivate: (status === 'paused' || status === 'draft' || status === 'past_due' || status === 'incomplete') &&
      !(isMercadoPago && status === 'incomplete') &&
      !isPaymentLinkPending,
    canCancel: status !== 'cancelled' && status !== 'deleted'
  }
}

function getSubscriptionContactDisplayName(contact?: PaymentLinkReadyData['contact'] | null) {
  return contact?.name ||
    `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() ||
    contact?.email ||
    contact?.phone ||
    'cliente'
}

interface SubscriptionPaymentLinkPanelFallback {
  payload?: SubscriptionPayload | null
  contact?: Contact | null
}

function buildSubscriptionPaymentLinkPanel(
  subscription: PaymentSubscription,
  fallback: SubscriptionPaymentLinkPanelFallback = {}
): PaymentLinkReadyData | null {
  const paymentMethod = subscription.paymentMethod || fallback.payload?.paymentMethod || ''
  if (!isLinkPaymentMethod(paymentMethod)) return null

  const paymentUrl = getSubscriptionStartLink(subscription)
  if (!paymentUrl) return null
  const isMercadoPagoSubscription = paymentMethod === 'mercadopago_subscription'
  const isClipSubscription = paymentMethod === 'clip_link' || subscription.paymentProvider === 'clip'
  if (isClipSubscription) return null

  const contactId = subscription.contactId || fallback.contact?.id || fallback.payload?.contactId || ''
  const contactName = subscription.contactName || fallback.contact?.name || fallback.payload?.contactName || 'Contacto'
  const contactEmail = subscription.contactEmail || fallback.contact?.email || fallback.payload?.contactEmail || ''
  const contactPhone = subscription.contactPhone || fallback.contact?.phone || fallback.payload?.contactPhone || ''

  const provider = (
    subscription.subscriptionStartPaymentProvider ||
    getSubscriptionProviderLogo(subscription) ||
    resolvePaymentProvider(subscription.paymentProvider || fallback.payload?.paymentProvider)
  ) as PaymentPlatformLogoId

  return {
    kind: 'subscription_start',
    title: 'Link de suscripción listo',
    description: isMercadoPagoSubscription
      ? 'Comparte este enlace de Mercado Pago para que el cliente autorice la suscripción.'
      : 'Comparte este enlace de la pasarela para que el cliente autorice la suscripción.',
    linkLabel: isMercadoPagoSubscription ? 'Enlace de suscripción Mercado Pago' : 'Enlace de suscripción',
    provider,
    paymentUrl,
    amount: Number(subscription.amount || fallback.payload?.amount || 0),
    currency: subscription.currency || fallback.payload?.currency || 'MXN',
    contact: {
      id: contactId,
      name: contactName,
      email: contactEmail,
      phone: contactPhone
    },
    paymentId: subscription.subscriptionStartPaymentId || null,
    publicPaymentId: subscription.subscriptionStartPublicPaymentId || null
  }
}

function getSubscriptionPaymentLinkShareText(link: PaymentLinkReadyData) {
  const contactName = getSubscriptionContactDisplayName(link.contact)
  const amountText = link.amount > 0 ? ` por ${formatCurrency(link.amount, link.currency)}` : ''
  const activationText = link.provider === 'mercadopago'
    ? 'Al autorizarlo, Mercado Pago activará tu suscripción.'
    : 'Al autorizarlo, la pasarela activará los cobros recurrentes de tu suscripción.'

  return `Hola ${contactName}, te comparto el enlace para autorizar tu suscripción${amountText}. ${activationText}\n${link.paymentUrl}`
}

function getSubscriptionPaymentLinkEmailSubject() {
  return 'Autoriza tu suscripción'
}

function matchesStatusFilter(subscription: PaymentSubscription, filter: string) {
  if (filter === 'all') return true
  const status = String(subscription.status || '').toLowerCase()
  if (filter === 'active') return status === 'active' || status === 'trialing'
  if (filter === 'past_due') return status === 'past_due' || status === 'incomplete'
  return status === filter
}

function buildContactFromSubscription(subscription: PaymentSubscription): Contact | null {
  if (!subscription.contactId) return null

  return {
    id: subscription.contactId,
    createdAt: subscription.createdAt || new Date().toISOString(),
    name: subscription.contactName || 'Contacto',
    email: subscription.contactEmail || undefined,
    phone: subscription.contactPhone || undefined,
    ltv: 0,
    status: 'customer',
    purchases: 0
  }
}

export const PaymentSubscriptions: React.FC = () => {
  const navigate = useNavigate()
  const location = useLocation()
  const { showConfirm, showToast } = useNotification()
  const { formatLocalDateShort, timezone } = useTimezone()
  const [accountCurrency] = useAccountCurrency()
  const [subscriptions, setSubscriptions] = useState<PaymentSubscription[]>([])
  const [summary, setSummary] = useState<SubscriptionSummary>(EMPTY_SUMMARY)
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [bulkSubscriptionAction, setBulkSubscriptionAction] = useState<SubscriptionBulkAction | null>(null)
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>([])
  const [subscriptionsPendingDeletion, setSubscriptionsPendingDeletion] = useState<PaymentSubscription[]>([])
  const [deletingSubscriptions, setDeletingSubscriptions] = useState(false)
  const [createdSubscriptionLink, setCreatedSubscriptionLink] = useState<PaymentLinkReadyData | null>(null)
  const [formMode, setFormMode] = useState<SubscriptionFormMode>(null)
  const [formStep, setFormStep] = useState<SubscriptionFormStep>('details')
  const [editingSubscription, setEditingSubscription] = useState<PaymentSubscription | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [form, setForm] = useState<SubscriptionFormState>(() => createEmptyForm(timezone))
  const [stripeConnected, setStripeConnected] = useState(false)
  const [conektaConnected, setConektaConnected] = useState(false)
  const [mercadoPagoConnected, setMercadoPagoConnected] = useState(false)
  const [integrationsLoading, setIntegrationsLoading] = useState(true)
  const [savedPaymentMethods, setSavedPaymentMethods] = useState<StripeSavedPaymentMethod[]>([])
  const [savedConektaPaymentSources, setSavedConektaPaymentSources] = useState<ConektaSavedPaymentSource[]>([])
  const [loadingSavedCards, setLoadingSavedCards] = useState(false)
  const [selectedStripePaymentMethodId, setSelectedStripePaymentMethodId] = useState('')
  const [selectedConektaPaymentSourceId, setSelectedConektaPaymentSourceId] = useState('')

  const loadSubscriptions = async ({ refresh = false } = {}) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)

    try {
      const data = await subscriptionsService.listSubscriptions({ refresh })
      setSubscriptions(data.subscriptions)
      setSummary(data.summary)
    } catch (error) {
      showToast('error', 'No se pudieron cargar las suscripciones', error instanceof Error ? error.message : 'Intenta actualizar otra vez.')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => {
    void loadSubscriptions()
  }, [])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('mercadopago') !== 'return') return

    void (async () => {
      try {
        await loadSubscriptions({ refresh: true })
        showToast('success', 'Mercado Pago sincronizado', 'Ristak revisó las suscripciones pendientes y registró los cobros aprobados.')
      } catch {
        // loadSubscriptions already shows the detailed error toast.
      } finally {
        navigate('/transactions/subscriptions', { replace: true })
      }
    })()
  }, [location.search, navigate, showToast])

  useEffect(() => {
    let cancelled = false

    getIntegrationsStatus()
      .then((data) => {
        if (cancelled) return
        setStripeConnected(Boolean(data?.stripe?.connected))
        setConektaConnected(Boolean(data?.conekta?.connected))
        setMercadoPagoConnected(Boolean(data?.mercadopago?.connected))
      })
      .catch(() => {
        if (cancelled) return
        setStripeConnected(false)
        setConektaConnected(false)
        setMercadoPagoConnected(false)
      })
      .finally(() => {
        if (!cancelled) setIntegrationsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    if (!formMode || !selectedContact?.id || (!stripeConnected && !conektaConnected)) {
      setSavedPaymentMethods([])
      setSavedConektaPaymentSources([])
      setSelectedStripePaymentMethodId('')
      setSelectedConektaPaymentSourceId('')
      setLoadingSavedCards(false)
      return () => {
        cancelled = true
      }
    }

    setLoadingSavedCards(true)
    Promise.all([
      stripeConnected
        ? stripePaymentsService.getSavedPaymentMethods(selectedContact.id).catch(() => [])
        : Promise.resolve([]),
      conektaConnected
        ? conektaPaymentsService.getSavedPaymentSources(selectedContact.id).catch(() => [])
        : Promise.resolve([])
    ])
      .then(([stripeMethods, conektaSources]) => {
        if (cancelled) return

        setSavedPaymentMethods(stripeMethods)
        setSavedConektaPaymentSources(conektaSources)
        setSelectedStripePaymentMethodId((current) => {
          const stillExists = stripeMethods.some((method) => getSavedStripePaymentMethodId(method) === current)
          if (stillExists) return current
          const preferred = stripeMethods.find((method) => method.isDefault) || stripeMethods[0]
          return getSavedStripePaymentMethodId(preferred)
        })
        setSelectedConektaPaymentSourceId((current) => {
          const stillExists = conektaSources.some((source) => getSavedConektaPaymentSourceId(source) === current)
          if (stillExists) return current
          const preferred = conektaSources.find((source) => source.isDefault) || conektaSources[0]
          return getSavedConektaPaymentSourceId(preferred)
        })
      })
      .finally(() => {
        if (!cancelled) setLoadingSavedCards(false)
      })

    return () => {
      cancelled = true
    }
  }, [conektaConnected, formMode, selectedContact?.id, stripeConnected])

  const availablePaymentMethodOptions = useMemo(() => (
    PAYMENT_METHOD_OPTIONS.filter((option) => (
      option.provider === 'stripe'
        ? stripeConnected
        : option.provider === 'conekta'
          ? conektaConnected
          : mercadoPagoConnected
    ))
  ), [conektaConnected, mercadoPagoConnected, stripeConnected])
  const availableLinkPaymentMethodOptions = useMemo(() => (
    availablePaymentMethodOptions.filter((option) => isLinkPaymentMethod(option.value))
  ), [availablePaymentMethodOptions])
  const hasMultipleLinkPaymentGateways = availableLinkPaymentMethodOptions.length > 1

  const hasSubscriptionGateway = availablePaymentMethodOptions.length > 0
  const showGatewayStep = formMode === 'create' && formStep === 'gateway'
  const showStartMethodStep = formMode === 'create' && formStep === 'start_method'
  const showSavedCardStep = formMode === 'create' && formStep === 'saved_card'
  const isMercadoPagoSelected = (formMode === 'edit' || showGatewayStep) && ['mercadopago_subscription', 'mercadopago_checkout'].includes(form.paymentMethod)
  const isConektaSelected = (formMode === 'edit' || showGatewayStep || showSavedCardStep) && ['conekta_subscription', 'conekta_link'].includes(form.paymentMethod)
  const isClipSelected = (formMode === 'edit' || showGatewayStep) && form.paymentMethod === 'clip_link'
  const startsByLink = isLinkPaymentMethod(form.paymentMethod)
  const hasStripeSavedCards = stripeConnected && savedPaymentMethods.length > 0
  const hasConektaSavedCards = conektaConnected && savedConektaPaymentSources.length > 0
  const hasSavedCardOptions = hasStripeSavedCards || hasConektaSavedCards
  const selectedStripePaymentMethod = savedPaymentMethods.find((method) => (
    getSavedStripePaymentMethodId(method) === selectedStripePaymentMethodId
  )) || null
  const selectedConektaPaymentSource = savedConektaPaymentSources.find((source) => (
    getSavedConektaPaymentSourceId(source) === selectedConektaPaymentSourceId
  )) || null
  const savedPaymentMethodOptions = useMemo(() => (
    savedPaymentMethods.flatMap((method) => {
      const value = getSavedStripePaymentMethodId(method)
      return value ? [{ value, label: getSavedStripeCardDescription(method) }] : []
    })
  ), [savedPaymentMethods])
  const savedConektaPaymentSourceOptions = useMemo(() => (
    savedConektaPaymentSources.flatMap((source) => {
      const value = getSavedConektaPaymentSourceId(source)
      return value ? [{ value, label: getSavedConektaCardDescription(source) }] : []
    })
  ), [savedConektaPaymentSources])
  const savedCardGatewayLabels = [
    hasStripeSavedCards ? 'Stripe' : null,
    hasConektaSavedCards ? 'Conekta' : null
  ].filter(Boolean) as string[]
  const savedCardActionDescription = savedCardGatewayLabels.length > 1
    ? `Elige la tarjeta guardada en ${savedCardGatewayLabels.join(' o ')}.`
    : savedCardGatewayLabels.length === 1
      ? `Elige la tarjeta guardada de ${savedCardGatewayLabels[0]}.`
      : 'Este contacto todavía no tiene tarjetas guardadas.'
  const paymentLinkActionDescription = availableLinkPaymentMethodOptions.length > 1
    ? `Después eliges pasarela: ${getPaymentProviderList(availableLinkPaymentMethodOptions)}.`
    : availableLinkPaymentMethodOptions.length === 1
      ? `Usa ${getPaymentProviderName(availableLinkPaymentMethodOptions[0].provider)} para generar el enlace de pago.`
      : 'Conecta una pasarela para enviar el enlace de pago.'
  const selectedSavedCardReady = form.paymentMethod === 'stripe_saved_card'
    ? Boolean(selectedStripePaymentMethod)
    : form.paymentMethod === 'conekta_subscription'
      ? Boolean(selectedConektaPaymentSource)
      : false
  const submitDisabled = saving || (showSavedCardStep && (loadingSavedCards || !selectedSavedCardReady))

  useEffect(() => {
    if (formMode) return
    setForm(createEmptyForm(timezone))
  }, [formMode, timezone])

  useEffect(() => {
    if (integrationsLoading || hasSubscriptionGateway) return

    showToast('warning', 'Suscripciones no disponibles', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones.')
    navigate('/transactions', { replace: true })
  }, [hasSubscriptionGateway, integrationsLoading, navigate, showToast])

  const filteredSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => matchesStatusFilter(subscription, statusFilter)),
    [statusFilter, subscriptions]
  )
  const canDeleteSubscription = (_subscription: PaymentSubscription) => true
  const selectedSubscriptions = useMemo(() => {
    if (selectedSubscriptionIds.length === 0) return []

    const selectedIds = new Set(selectedSubscriptionIds)
    return subscriptions.filter((subscription) => selectedIds.has(subscription.id) && canDeleteSubscription(subscription))
  }, [selectedSubscriptionIds, subscriptions])
  const selectedSubscriptionsToActivate = useMemo(
    () => selectedSubscriptions.filter((subscription) => getSubscriptionActionAvailability(subscription).canActivate),
    [selectedSubscriptions]
  )
  const selectedSubscriptionsToPause = useMemo(
    () => selectedSubscriptions.filter((subscription) => getSubscriptionActionAvailability(subscription).canPause),
    [selectedSubscriptions]
  )
  const selectedSubscriptionsToCancel = useMemo(
    () => selectedSubscriptions.filter((subscription) => getSubscriptionActionAvailability(subscription).canCancel),
    [selectedSubscriptions]
  )

  useEffect(() => {
    if (selectedSubscriptionIds.length === 0) return

    const availableIds = new Set(subscriptions.map(subscription => subscription.id))
    const nextSelectedIds = selectedSubscriptionIds.filter(id => availableIds.has(id))

    if (nextSelectedIds.length !== selectedSubscriptionIds.length) {
      setSelectedSubscriptionIds(nextSelectedIds)
    }
  }, [selectedSubscriptionIds, subscriptions])

  const openCreateSubscription = () => {
    if (!hasSubscriptionGateway) {
      showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones automáticas.')
      return
    }

    setCreatedSubscriptionLink(null)
    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyForm(timezone))
    setFormStep('details')
    setFormMode('create')
  }

  const openEditSubscription = (subscription: PaymentSubscription) => {
    setCreatedSubscriptionLink(null)
    setEditingSubscription(subscription)
    setSelectedContact(buildContactFromSubscription(subscription))
    setForm({
      name: subscription.name || '',
      description: subscription.description || '',
      amount: subscription.amount ? String(subscription.amount) : '',
      intervalType: (subscription.intervalType as SubscriptionInterval) || 'monthly',
      intervalCount: String(subscription.intervalCount || 1),
      startDate: clampDateToToday(toDateInputValue(subscription.startDate, timezone), timezone),
      nextRunAt: clampDateToToday(toDateInputValue(subscription.nextRunAt, timezone), timezone),
      cancelAt: toDateInputValue(subscription.cancelAt, timezone),
      durationType: subscription.cancelAt ? 'until_date' : 'continuous',
      status: (subscription.status as SubscriptionStatus) || 'active',
      startMode: getStartModeForPaymentMethod(subscription.paymentMethod),
      paymentMethod: (subscription.paymentMethod as SubscriptionPaymentMethod) || 'stripe_saved_card',
      paymentProvider: resolvePaymentProvider(subscription.paymentProvider)
    })
    setFormStep('details')
    setFormMode('edit')
  }

  useEffect(() => {
    if (formMode !== 'create') return
    if (!availablePaymentMethodOptions.length) return
    if (availablePaymentMethodOptions.some((option) => option.value === form.paymentMethod)) return

    const fallback = availablePaymentMethodOptions[0]
    setForm((current) => ({
      ...current,
      paymentMethod: fallback.value,
      paymentProvider: fallback.provider,
      startMode: getStartModeForPaymentMethod(fallback.value),
      status: isLinkPaymentMethod(fallback.value) ? 'incomplete' : 'active'
    }))
  }, [availablePaymentMethodOptions, form.paymentMethod, formMode])

  const closeForm = () => {
    if (saving) return

    setCreatedSubscriptionLink(null)
    setFormMode(null)
    setFormStep('details')
    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyForm(timezone))
  }

  const patchForm = (field: keyof SubscriptionFormState, value: string) => {
    if (field === 'durationType' && value === 'continuous') {
      setForm((current) => ({
        ...current,
        durationType: 'continuous',
        cancelAt: ''
      }))
      return
    }

    setForm((current) => ({
      ...current,
      [field]: field === 'startDate' || field === 'nextRunAt' || field === 'cancelAt'
        ? clampDateToToday(value, timezone)
        : value
      }))
  }

  const applyPaymentMethod = (option: { value: SubscriptionPaymentMethod; provider: PaymentGatewayProvider }) => {
    setForm((current) => ({
      ...current,
      startMode: getStartModeForPaymentMethod(option.value),
      paymentMethod: option.value,
      paymentProvider: option.provider,
      status: isLinkPaymentMethod(option.value) ? 'incomplete' : current.status === 'incomplete' ? 'active' : current.status
    }))
  }

  const chooseStartMode = (mode: Exclude<SubscriptionStartMode, ''>) => {
    if (mode === 'link') {
      const fallback = availableLinkPaymentMethodOptions[0]
      if (!fallback) {
        showToast('warning', 'No hay pasarela de link', 'Conecta Stripe, Conekta o Mercado Pago para generar un link de suscripción.')
        return
      }

      applyPaymentMethod(fallback)
      setFormStep(hasMultipleLinkPaymentGateways ? 'gateway' : 'start_method')
      return
    }

    if (loadingSavedCards) {
      showToast('warning', 'Buscando tarjetas', 'Espera un momento mientras cargamos las tarjetas guardadas del contacto.')
      return
    }

    if (!hasSavedCardOptions) {
      showToast('warning', 'No hay tarjetas guardadas', 'Este contacto todavía no tiene tarjetas guardadas en Stripe o Conekta.')
      return
    }

    if (hasStripeSavedCards) {
      applyPaymentMethod({ value: 'stripe_saved_card', provider: 'stripe' })
    } else if (hasConektaSavedCards) {
      applyPaymentMethod({ value: 'conekta_subscription', provider: 'conekta' })
    }
    setFormStep('saved_card')
  }

  const goBackFormStep = () => {
    if (showGatewayStep || showSavedCardStep) {
      setFormStep('start_method')
      return
    }

    if (showStartMethodStep) {
      setFormStep('details')
      return
    }

    closeForm()
  }

  const renderSavedCardGatewayRow = ({
    platform,
    label,
    description,
    value,
    options,
    active,
    onSelect
  }: {
    platform: 'stripe' | 'conekta'
    label: string
    description: string
    value: string
    options: Array<{ value: string; label: string }>
    active: boolean
    onSelect: (value: string) => void
  }) => {
    const selectedValue = value || options[0]?.value || ''
    const selectCurrentCard = () => {
      if (selectedValue) {
        onSelect(selectedValue)
      }
    }

    return (
      <div
        className={styles.savedCardGatewayRow}
        data-active={active ? 'true' : undefined}
      >
        <button
          type="button"
          className={styles.savedCardGatewayMain}
          onClick={selectCurrentCard}
        >
          <div className={styles.optionInfo}>
            <div className={styles.optionIcon}>
              <PaymentPlatformLogo platform={platform} size="md" decorative />
            </div>
            <div>
              <p>{label}</p>
              <span>{description}</span>
            </div>
          </div>
        </button>
        <div className={styles.savedCardSelector} onClick={(event) => event.stopPropagation()}>
          <CustomSelect
            value={selectedValue}
            onValueChange={onSelect}
            options={options}
            placeholder={`Tarjeta de ${label}`}
            aria-label={`Tarjeta guardada de ${label}`}
            portal
          />
        </div>
        {active && <Check size={18} className={styles.optionCheck} aria-hidden="true" />}
      </div>
    )
  }

  const validateSubscriptionDetails = () => {
    const name = form.name.trim()
    const amount = Number(form.amount)
    const intervalCount = Number.parseInt(form.intervalCount, 10)

    if (!selectedContact?.id) {
      showToast('warning', 'Falta el contacto', 'Selecciona el contacto que va a tener esta suscripción.')
      return false
    }

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama la suscripción.')
      return false
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('warning', 'Falta el monto', 'Escribe un monto válido para la suscripción.')
      return false
    }

    if (!Number.isFinite(intervalCount) || intervalCount <= 0) {
      showToast('warning', 'Frecuencia inválida', 'La frecuencia debe ser de al menos 1 periodo.')
      return false
    }

    if (form.durationType === 'until_date') {
      if (!form.cancelAt) {
        showToast('warning', 'Falta la duración', 'Elige hasta qué fecha debe cobrarse esta suscripción.')
        return false
      }

      if (isDateBeforeToday(form.cancelAt, timezone) || form.cancelAt <= form.startDate) {
        showToast('warning', 'Duración inválida', 'La fecha final debe ser posterior al inicio de la suscripción.')
        return false
      }
    }

    return true
  }

  const buildPayload = (currentForm: SubscriptionFormState = form): SubscriptionPayload | null => {
    const name = currentForm.name.trim()
    const amount = Number(currentForm.amount)
    const intervalCount = Number.parseInt(currentForm.intervalCount, 10)

    if (!name) {
      showToast('warning', 'Falta el nombre', 'Escribe cómo se llama la suscripción.')
      return null
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('warning', 'Falta el monto', 'Escribe un monto válido para la suscripción.')
      return null
    }

    if (!Number.isFinite(intervalCount) || intervalCount <= 0) {
      showToast('warning', 'Frecuencia inválida', 'La frecuencia debe ser de al menos 1 periodo.')
      return null
    }

    if (currentForm.durationType === 'until_date') {
      if (!currentForm.cancelAt) {
        showToast('warning', 'Falta la duración', 'Elige hasta qué fecha debe cobrarse esta suscripción.')
        return null
      }

      if (isDateBeforeToday(currentForm.cancelAt, timezone) || currentForm.cancelAt <= currentForm.startDate) {
        showToast('warning', 'Duración inválida', 'La fecha final debe ser posterior al inicio de la suscripción.')
        return null
      }
    }

    const paymentMethod = currentForm.paymentMethod
    const provider = getPaymentProviderFromMethod(paymentMethod, currentForm.paymentProvider)
    const contactEmail = selectedContact?.email || editingSubscription?.contactEmail || null
    const contactPhone = selectedContact?.phone || editingSubscription?.contactPhone || null
    const contactId = selectedContact?.id || editingSubscription?.contactId || null
    const startByLink = isLinkPaymentMethod(paymentMethod)

    if (!contactId) {
      showToast('warning', 'Falta el contacto', 'Selecciona el contacto que va a tener esta suscripción.')
      return null
    }

    if (startByLink && provider !== 'mercadopago' && !contactEmail) {
      showToast('warning', 'Falta el email', `${getPaymentProviderName(provider)} necesita email para crear el link de suscripción.`)
      return null
    }

    const stripeSavedCardId = selectedStripePaymentMethod?.stripePaymentMethodId || selectedStripePaymentMethodId || editingSubscription?.stripePaymentMethodId || null
    const conektaSavedCardId = selectedConektaPaymentSource?.conektaPaymentSourceId || selectedConektaPaymentSourceId || editingSubscription?.conektaPaymentSourceId || null

    if (paymentMethod === 'stripe_saved_card' && !stripeSavedCardId) {
      showToast('warning', 'Falta la tarjeta', 'Selecciona la tarjeta guardada de Stripe que debe iniciar esta suscripción.')
      return null
    }

    if (paymentMethod === 'conekta_subscription' && !conektaSavedCardId) {
      showToast('warning', 'Falta la tarjeta', 'Selecciona la tarjeta guardada de Conekta que debe iniciar esta suscripción.')
      return null
    }

    if (provider === 'conekta' && currentForm.intervalType === 'daily') {
      showToast('warning', 'Frecuencia no soportada', 'Conekta no acepta suscripciones diarias. Usa semanal, mensual o anual.')
      return null
    }

    if (isDateBeforeToday(currentForm.startDate, timezone) || (!startByLink && isDateBeforeToday(currentForm.nextRunAt, timezone))) {
      showToast('warning', 'Fecha inválida', 'Las suscripciones automáticas no pueden iniciar ni cobrarse en fechas pasadas.')
      return null
    }

    return {
      contactId,
      contactName: selectedContact?.name || editingSubscription?.contactName || null,
      contactEmail,
      contactPhone,
      name,
      description: currentForm.description.trim(),
      status: formMode === 'edit' ? currentForm.status : startByLink ? 'incomplete' : 'active',
      amount,
      currency: accountCurrency,
      intervalType: currentForm.intervalType,
      intervalCount,
      startDate: currentForm.startDate || null,
      nextRunAt: startByLink ? null : currentForm.nextRunAt || null,
      cancelAt: currentForm.durationType === 'until_date' ? currentForm.cancelAt || null : null,
      paymentMethod,
      paymentProvider: provider,
      stripePaymentMethodId: paymentMethod === 'stripe_saved_card'
        ? stripeSavedCardId
        : undefined,
      conektaPaymentSourceId: paymentMethod === 'conekta_subscription'
        ? conektaSavedCardId
        : undefined,
      source: editingSubscription?.source || 'ristak'
    }
  }

  const saveSubscription = async () => {
    let payloadForm = form

    if (formMode === 'create' && formStep === 'details') {
      if (!validateSubscriptionDetails()) return
      setFormStep('start_method')
      return
    }

    if (formMode === 'create' && formStep === 'start_method') {
      if (form.startMode === 'link') {
        const fallback = availableLinkPaymentMethodOptions[0]
        if (!fallback) {
          showToast('warning', 'No hay pasarela de link', 'Conecta Stripe, Conekta o Mercado Pago para generar un link de suscripción.')
          return
        }

        if (hasMultipleLinkPaymentGateways) {
          chooseStartMode('link')
          return
        }

        payloadForm = {
          ...form,
          startMode: 'link',
          paymentMethod: fallback.value,
          paymentProvider: fallback.provider,
          status: 'incomplete'
        }
        setForm(payloadForm)
      } else if (form.startMode === 'saved_card') {
        chooseStartMode(form.startMode)
        return
      } else {
        showToast('warning', 'Elige cómo iniciar', 'Selecciona si vas a enviar link de suscripción o usar una tarjeta guardada.')
        return
      }
    }

    if (formMode === 'create' && formStep === 'gateway' && !availableLinkPaymentMethodOptions.some((option) => option.value === form.paymentMethod)) {
      const fallback = availableLinkPaymentMethodOptions[0]
      if (!fallback) {
        showToast('warning', 'No hay pasarela de link', 'Conecta Stripe, Conekta o Mercado Pago para crear un link de suscripción.')
        return
      }
      applyPaymentMethod(fallback)
      return
    }

    if (formMode === 'create' && formStep === 'saved_card' && !selectedSavedCardReady) {
      showToast('warning', 'Selecciona una tarjeta', 'Elige una tarjeta guardada de Stripe o Conekta para continuar.')
      return
    }

    const payload = buildPayload(payloadForm)
    if (!payload) return

    setSaving(true)
    try {
      if (formMode === 'edit' && editingSubscription) {
        await subscriptionsService.updateSubscription(editingSubscription.id, payload)
        showToast('success', 'Suscripción actualizada', `${payload.name} ya quedó lista.`)
      } else {
        const created = await subscriptionsService.createSubscription(payload)
        const readyLink = buildSubscriptionPaymentLinkPanel(created, {
          payload,
          contact: selectedContact
        })
        if (readyLink) {
          setCreatedSubscriptionLink(readyLink)
          showToast('success', 'Link de suscripción listo', `El link de ${payload.name} ya está listo para copiar o enviar.`)
          await loadSubscriptions({ refresh: true })
          return
        }

        showToast('success', 'Suscripción creada', `${payload.name} ya aparece en la lista.`)
      }

      closeForm()
      await loadSubscriptions({ refresh: true })
    } catch (error) {
      showToast('error', 'No se guardó la suscripción', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setSaving(false)
    }
  }

  const runAction = async (subscription: PaymentSubscription, action: 'pause' | 'activate' | 'cancel') => {
    setActingId(subscription.id)
    try {
      await subscriptionsService.actionSubscription(subscription.id, action)
      await loadSubscriptions({ refresh: true })
      const label = action === 'pause' ? 'pausada' : action === 'cancel' ? 'cancelada' : 'activada'
      showToast('success', 'Suscripción actualizada', `${subscription.name} quedó ${label}.`)
    } catch (error) {
      showToast('error', 'No se actualizó la suscripción', error instanceof Error ? error.message : 'Intenta otra vez.')
    } finally {
      setActingId(null)
    }
  }

  const handleSubscriptionAction = (subscription: PaymentSubscription, action: SubscriptionBulkAction) => {
    if (action === 'cancel') {
      showConfirm(
        'Cancelar suscripción',
        `Vas a cancelar ${subscription.name || 'esta suscripción'}. La pasarela dejará de cobrarla y esta acción no se puede deshacer.`,
        () => runAction(subscription, action),
        'Cancelar suscripción',
        'Cancelar',
        undefined,
        { typeToConfirm: 'CANCELAR' }
      )
      return
    }

    void runAction(subscription, action)
  }

  const runBulkSubscriptionAction = async (action: SubscriptionBulkAction, targetSubscriptions: PaymentSubscription[]) => {
    if (targetSubscriptions.length === 0) return

    setBulkSubscriptionAction(action)
    const failedSubscriptions: PaymentSubscription[] = []

    for (const subscription of targetSubscriptions) {
      setActingId(subscription.id)
      try {
        await subscriptionsService.actionSubscription(subscription.id, action)
      } catch {
        failedSubscriptions.push(subscription)
      }
    }

    const failedIds = new Set(failedSubscriptions.map(subscription => subscription.id))
    const updatedCount = targetSubscriptions.length - failedSubscriptions.length

    setSelectedSubscriptionIds(current => current.filter(id => failedIds.has(id)))
    setActingId(null)
    setBulkSubscriptionAction(null)

    if (failedSubscriptions.length > 0) {
      showToast(
        'error',
        'No se actualizaron todas',
        `Se actualizaron ${updatedCount} y fallaron ${failedSubscriptions.length}. Revisa las pendientes e intenta otra vez.`
      )
    } else {
      const title = action === 'pause'
        ? 'Suscripciones pausadas'
        : action === 'cancel'
          ? 'Suscripciones canceladas'
          : 'Suscripciones activadas'
      const message = action === 'pause'
        ? `${updatedCount} suscripci${updatedCount === 1 ? 'ón quedó pausada' : 'ones quedaron pausadas'}.`
        : action === 'cancel'
          ? `${updatedCount} suscripci${updatedCount === 1 ? 'ón quedó cancelada' : 'ones quedaron canceladas'}.`
          : `${updatedCount} suscripci${updatedCount === 1 ? 'ón quedó activa' : 'ones quedaron activas'}.`
      showToast('success', title, message)
    }

    await loadSubscriptions({ refresh: true })
  }

  const handleBulkSubscriptionAction = (action: SubscriptionBulkAction, targetSubscriptions: PaymentSubscription[]) => {
    if (targetSubscriptions.length === 0) return

    if (action === 'cancel') {
      showConfirm(
        'Cancelar suscripciones',
        `Vas a cancelar ${targetSubscriptions.length} suscripci${targetSubscriptions.length === 1 ? 'ón' : 'ones'}. La pasarela dejará de cobrarlas y esta acción no se puede deshacer.`,
        () => runBulkSubscriptionAction(action, targetSubscriptions),
        'Cancelar suscripciones',
        'Cancelar',
        undefined,
        { typeToConfirm: 'CANCELAR' }
      )
      return
    }

    void runBulkSubscriptionAction(action, targetSubscriptions)
  }

  const openSubscriptionDeleteModal = (targetSubscriptions: PaymentSubscription[]) => {
    if (targetSubscriptions.length === 0) return

    setSubscriptionsPendingDeletion(targetSubscriptions)
  }

  const closeSubscriptionDeleteModal = () => {
    if (deletingSubscriptions) return

    setSubscriptionsPendingDeletion([])
  }

  const removeSubscriptionsFromState = (subscriptionIds: string[]) => {
    const deletedIds = new Set(subscriptionIds)
    setSubscriptions((current) => current.filter((item) => !deletedIds.has(item.id)))
    setSelectedSubscriptionIds((current) => current.filter((id) => !deletedIds.has(id)))
  }

  const handleConfirmDeleteSubscriptions = async () => {
    if (subscriptionsPendingDeletion.length === 0) return

    setDeletingSubscriptions(true)
    const deletingIds = subscriptionsPendingDeletion.map((subscription) => subscription.id)
    const failedSubscriptions: PaymentSubscription[] = []

    for (const subscription of subscriptionsPendingDeletion) {
      setActingId(subscription.id)
      try {
        await subscriptionsService.deleteSubscription(subscription.id)
      } catch {
        failedSubscriptions.push(subscription)
      }
    }

    const deletedIds = new Set(
      deletingIds.filter(id => !failedSubscriptions.some(subscription => subscription.id === id))
    )

    if (deletedIds.size > 0) {
      removeSubscriptionsFromState(Array.from(deletedIds))
    }

    setActingId(null)
    setDeletingSubscriptions(false)
    setSubscriptionsPendingDeletion([])

    if (failedSubscriptions.length > 0) {
      showToast(
        'error',
        'No se pudieron eliminar todas',
        `Se eliminaron ${deletedIds.size} y fallaron ${failedSubscriptions.length}. Revisa las pendientes e intenta otra vez.`
      )
    } else {
      showToast(
        'success',
        subscriptionsPendingDeletion.length === 1 ? 'Suscripción eliminada' : 'Suscripciones eliminadas',
        subscriptionsPendingDeletion.length === 1
          ? 'La suscripción ya no aparece en la lista.'
          : `Se eliminaron ${subscriptionsPendingDeletion.length} suscripciones correctamente.`
      )
    }

    await loadSubscriptions({ refresh: true })
  }

  const handleDelete = (subscription: PaymentSubscription) => {
    openSubscriptionDeleteModal([subscription])
  }

  const openSubscriptionStartLinkPanel = (subscription: PaymentSubscription) => {
    const readyLink = buildSubscriptionPaymentLinkPanel(subscription)
    if (!readyLink) {
      showToast('warning', 'Link no disponible', 'Todavía no hay un link de suscripción para esta suscripción.')
      return
    }

    setCreatedSubscriptionLink(readyLink)
    setEditingSubscription(null)
    setSelectedContact(buildContactFromSubscription(subscription))
    setFormMode('create')
  }

  const copySubscriptionStartLink = async (subscription: PaymentSubscription) => {
    const link = getSubscriptionStartLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'Todavía no hay un link de suscripción para esta suscripción.')
      return
    }

    await navigator.clipboard.writeText(link)
    showToast('success', 'Link copiado', 'Ya puedes enviarlo al cliente para autorizar la suscripción.')
  }

  const openSubscriptionStartLink = (subscription: PaymentSubscription) => {
    const link = getSubscriptionStartLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'Todavía no hay un link de suscripción para esta suscripción.')
      return
    }

    window.open(link, '_blank', 'noopener,noreferrer')
  }

  const columns: Column<PaymentSubscription>[] = [
    {
      key: 'name',
      header: 'Suscripción',
      render: (_value, item) => (
        <button
          type="button"
          className={styles.nameButton}
          onClick={(event) => {
            event.stopPropagation()
            openEditSubscription(item)
          }}
        >
          <span>{item.name || 'Suscripción sin nombre'}</span>
          {item.description && <small>{item.description}</small>}
        </button>
      ),
      searchValue: (_value, item) => [item.name, item.description, item.stripeSubscriptionId, item.conektaSubscriptionId, item.mercadoPagoPreapprovalId],
      sortable: true
    },
    {
      key: 'contactName',
      header: 'Contacto',
      render: (_value, item) => (
        <div className={styles.identityCell}>
          <strong>{item.contactName || 'Sin contacto'}</strong>
          {(item.contactEmail || item.contactPhone) && (
            <span className={styles.secondaryLine}>{item.contactEmail || item.contactPhone}</span>
          )}
        </div>
      ),
      searchValue: (_value, item) => [item.contactName, item.contactEmail, item.contactPhone],
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => (
        <div className={styles.statusStack}>
          <Badge variant={getSubscriptionStatusVariant(value)}>
            {getSubscriptionStatusLabel(value)}
          </Badge>
        </div>
      ),
      sortable: true
    },
    {
      key: 'amount',
      header: 'Monto',
      render: (_value, item) => (
        <span className={styles.amountCell}>{formatCurrency(item.amount || 0, item.currency || accountCurrency)}</span>
      ),
      searchValue: (_value, item) => [item.amount, item.currency],
      sortable: true
    },
    {
      key: 'intervalType',
      header: 'Recurrencia',
      render: (_value, item) => getIntervalLabel(item.intervalType, item.intervalCount),
      searchValue: (_value, item) => getIntervalLabel(item.intervalType, item.intervalCount),
      sortable: true
    },
    {
      key: 'nextRunAt',
      header: 'Próximo cobro',
      render: (value) => value ? formatLocalDateShort(value) : <span className={styles.mutedCell}>Sin fecha</span>,
      sortable: true
    },
    {
      key: 'paymentMethod',
      header: 'Método',
      render: (_value, item) => {
        const providerLogo = getSubscriptionProviderLogo(item)

        return (
          <div className={styles.methodStack}>
            <div className={styles.methodMain}>
              {providerLogo && <PaymentPlatformLogo platform={providerLogo} size="sm" decorative />}
              <strong>{getPaymentMethodLabel(item.paymentMethod)}</strong>
            </div>
            <span className={styles.secondaryLine}>{getSourceLabel(item)}</span>
          </div>
        )
      },
      searchValue: (_value, item) => [item.paymentMethod, item.paymentProvider, item.source, item.stripeCustomerId, item.conektaCustomerId, item.mercadoPagoPreapprovalId],
      sortable: true
    },
    {
      key: 'actions',
      header: 'Acciones',
      render: (_value, item) => {
        const busy = actingId === item.id
        const { startLink, canPause, canActivate, canCancel } = getSubscriptionActionAvailability(item)

        return (
          <div className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={styles.iconButton}
                  title="Acciones de la suscripción"
                  disabled={busy}
                >
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy} onClick={() => openEditSubscription(item)}>
                  <Edit3 size={16} />
                  <span>Ver / editar</span>
                </DropdownMenuItem>
                {startLink && (
                  <>
                    <DropdownMenuItem disabled={busy} onClick={() => openSubscriptionStartLinkPanel(item)}>
                      <Send size={16} />
                      <span>Enviar link de suscripción</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => void copySubscriptionStartLink(item)}>
                      <Copy size={16} />
                      <span>Copiar link de suscripción</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => openSubscriptionStartLink(item)}>
                      <ExternalLink size={16} />
                      <span>Abrir link de suscripción</span>
                    </DropdownMenuItem>
                  </>
                )}
                {canActivate && (
                  <DropdownMenuItem disabled={busy} onClick={() => handleSubscriptionAction(item, 'activate')}>
                    <Play size={16} />
                    <span>Activar</span>
                  </DropdownMenuItem>
                )}
                {canPause && (
                  <DropdownMenuItem disabled={busy} onClick={() => handleSubscriptionAction(item, 'pause')}>
                    <Pause size={16} />
                    <span>Pausar</span>
                  </DropdownMenuItem>
                )}
                {canCancel && (
                  <DropdownMenuItem disabled={busy} onClick={() => handleSubscriptionAction(item, 'cancel')}>
                    <XCircle size={16} />
                    <span>Cancelar</span>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={busy}
                  onClick={() => handleDelete(item)}
                  className={styles.destructive}
                >
                  <Trash2 size={16} />
                  <span>Eliminar</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
      sortable: false,
      fixed: true,
      width: '88px'
    }
  ]

  const subscriptionSelectionToolbar = selectedSubscriptions.length > 0 ? (
    <TableSelectionToolbar
      count={selectedSubscriptions.length}
      singularLabel="seleccionada"
      pluralLabel="seleccionadas"
      onClearSelection={() => setSelectedSubscriptionIds([])}
    >
      {selectedSubscriptionsToActivate.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={bulkSubscriptionAction === 'activate'}
          disabled={Boolean(bulkSubscriptionAction) || deletingSubscriptions}
          onClick={() => handleBulkSubscriptionAction('activate', selectedSubscriptionsToActivate)}
        >
          <Play size={16} />
          Continuar
        </Button>
      )}
      {selectedSubscriptionsToPause.length > 0 && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={bulkSubscriptionAction === 'pause'}
          disabled={Boolean(bulkSubscriptionAction) || deletingSubscriptions}
          onClick={() => handleBulkSubscriptionAction('pause', selectedSubscriptionsToPause)}
        >
          <Pause size={16} />
          Pausar
        </Button>
      )}
      {selectedSubscriptionsToCancel.length > 0 && (
        <Button
          type="button"
          variant="danger"
          size="sm"
          loading={bulkSubscriptionAction === 'cancel'}
          disabled={Boolean(bulkSubscriptionAction) || deletingSubscriptions}
          onClick={() => handleBulkSubscriptionAction('cancel', selectedSubscriptionsToCancel)}
        >
          <XCircle size={16} />
          Cancelar
        </Button>
      )}
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={deletingSubscriptions}
        disabled={Boolean(bulkSubscriptionAction)}
        onClick={() => openSubscriptionDeleteModal(selectedSubscriptions)}
      >
        <Trash2 size={16} />
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null
  const formModalTitle = formMode === 'edit'
    ? 'Editar suscripción'
    : createdSubscriptionLink
      ? 'Link de suscripción listo'
    : showStartMethodStep
      ? 'Elige cómo iniciar'
      : showGatewayStep
        ? 'Elige pasarela'
        : showSavedCardStep
          ? 'Elige tarjeta guardada'
          : 'Nueva suscripción'

  return (
    <PageContainer>
      <div className={styles.page}>
        <PageHeader
          title="Suscripciones"
          subtitle="Administra cobros recurrentes, tarjetas guardadas y próximos ciclos de pago."
          actions={
            <>
              <Button
                type="button"
                variant="secondary"
                onClick={() => navigate('/settings/payments/gateways')}
                leftIcon={<Settings size={16} />}
              >
                Configurar pasarelas
              </Button>
              <Button
                onClick={openCreateSubscription}
                leftIcon={<Plus size={16} />}
                disabled={integrationsLoading || !hasSubscriptionGateway}
                title={!hasSubscriptionGateway ? 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones' : undefined}
              >
                Nueva suscripción
              </Button>
              <Button
                type="button"
                variant="secondary"
                iconOnly
                aria-label="Actualizar suscripciones"
                title="Actualizar suscripciones"
                onClick={() => void loadSubscriptions({ refresh: true })}
                disabled={refreshing}
                leftIcon={<RefreshCw size={16} className={refreshing ? styles.spin : undefined} />}
              />
            </>
          }
        />

        <div className={styles.metricsGrid}>
          <KpiCard title="Activas" value={summary.active} icon={Repeat2} loading={loading} />
          <KpiCard title="Ingreso mensual" value={formatCurrency(summary.monthlyRevenue, accountCurrency)} icon={CreditCard} loading={loading} />
          <KpiCard title="Próximo cobro" value={summary.nextRunAt ? formatLocalDateShort(summary.nextRunAt) : 'Sin fecha'} icon={CalendarClock} loading={loading} />
          <KpiCard title="Vencidas / pausadas" value={`${summary.pastDue} / ${summary.paused}`} icon={Pause} loading={loading} />
        </div>

        <Card padding="none">
          <Table
            key="payment_subscriptions_table"
            initialColumns={columns}
            data={filteredSubscriptions}
            keyExtractor={(item) => item.id}
            onRowClick={openEditSubscription}
            emptyMessage="No hay suscripciones guardadas"
            loading={loading}
            searchable={true}
            searchPlaceholder="Buscar suscripciones..."
            paginated={true}
            pageSize={20}
            filters={STATUS_FILTERS}
            activeFilter={statusFilter}
            onFilterChange={setStatusFilter}
            searchPosition="left"
            tableId="payment_subscriptions"
            initialSortBy="nextRunAt"
            initialSortOrder="asc"
            selectionActions={subscriptionSelectionToolbar}
            rowSelection={{
              selectedKeys: selectedSubscriptionIds,
              onChange: setSelectedSubscriptionIds,
              getRowLabel: (item) => item.name || 'suscripción',
              selectAllLabel: 'Seleccionar todas las suscripciones'
            }}
          />
        </Card>

        <Modal
          isOpen={subscriptionsPendingDeletion.length > 0}
          onClose={closeSubscriptionDeleteModal}
          type="confirm"
          size="sm"
          title={`Eliminar suscripci${subscriptionsPendingDeletion.length === 1 ? 'ón' : 'ones'}`}
          message={`Vas a eliminar ${subscriptionsPendingDeletion.length} suscripci${subscriptionsPendingDeletion.length === 1 ? 'ón' : 'ones'}. Las suscripciones de prueba se borran junto con sus cobros relacionados; las suscripciones en vivo siguen protegidas si tienen historial real.`}
          confirmText="Eliminar"
          cancelText="Cancelar"
          typeToConfirm="ELIMINAR"
          closeOnBackdropClick={false}
          closeOnEscape={false}
          onConfirm={handleConfirmDeleteSubscriptions}
        />

        <Modal
          isOpen={formMode !== null}
          onClose={closeForm}
          title={formModalTitle}
          size="md"
          type="custom"
          closeOnBackdropClick={formMode === 'edit' && !createdSubscriptionLink}
          closeOnEscape={formMode === 'edit' && !createdSubscriptionLink}
        >
          {createdSubscriptionLink ? (
            <div className={styles.form}>
              <PaymentLinkReadyPanel
                link={createdSubscriptionLink}
                getShareText={getSubscriptionPaymentLinkShareText}
                getEmailSubject={getSubscriptionPaymentLinkEmailSubject}
              />
              <div className={styles.footerActions}>
                <Button type="button" onClick={closeForm}>
                  Listo
                </Button>
              </div>
            </div>
          ) : (
            <form className={styles.form} onSubmit={(event) => {
              event.preventDefault()
              void saveSubscription()
            }}>
            {showStartMethodStep ? (
              <div className={styles.paymentOptions}>
                {hasSavedCardOptions && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${form.startMode === 'saved_card' ? styles.optionButtonActive : ''}`}
                    onClick={() => chooseStartMode('saved_card')}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <ShieldCheck size={18} aria-hidden="true" />
                      </div>
                      <div>
                        <p>Cobrar tarjeta guardada</p>
                        <span>{savedCardActionDescription}</span>
                      </div>
                    </div>
                    <ChevronRight size={18} className={styles.optionCheck} aria-hidden="true" />
                  </button>
                )}

                {availableLinkPaymentMethodOptions.length > 0 && (
                  <button
                    type="button"
                    className={`${styles.optionButton} ${form.startMode === 'link' ? styles.optionButtonActive : ''}`}
                    onClick={() => chooseStartMode('link')}
                  >
                    <div className={styles.optionInfo}>
                      <div className={styles.optionIcon}>
                        <LinkIcon size={18} aria-hidden="true" />
                      </div>
                      <div>
                        <p>Enviar enlace de pago</p>
                        <span>{paymentLinkActionDescription}</span>
                      </div>
                    </div>
                    {hasMultipleLinkPaymentGateways ? (
                      <ChevronRight size={18} className={styles.optionCheck} aria-hidden="true" />
                    ) : (
                      form.startMode === 'link' && <Check size={18} className={styles.optionCheck} aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            ) : showGatewayStep ? (
              <div className={styles.paymentOptions}>
                {availableLinkPaymentMethodOptions.map((option) => {
                  const active = form.paymentMethod === option.value
                  const providerName = getPaymentProviderName(option.provider)
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.optionButton} ${active ? styles.optionButtonActive : ''}`}
                      onClick={() => applyPaymentMethod(option)}
                    >
                      <div className={styles.optionInfo}>
                        <div className={styles.optionIcon}>
                          <PaymentPlatformLogo platform={option.provider} size="md" decorative />
                        </div>
                        <div>
                          <p>{providerName}</p>
                          <span>{option.description}</span>
                        </div>
                      </div>
                      {active && <Check size={18} className={styles.optionCheck} aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
            ) : showSavedCardStep ? (
              <div className={styles.paymentOptions}>
                {loadingSavedCards && (
                  <div className={styles.emptyState}>
                    <span>Buscando tarjetas guardadas del contacto...</span>
                  </div>
                )}

                {!loadingSavedCards && !hasSavedCardOptions && (
                  <div className={styles.emptyState}>
                    <strong>Este contacto no tiene tarjetas guardadas.</strong>
                    <span>Guarda una tarjeta en Stripe o Conekta antes de iniciar la suscripción con tarjeta guardada.</span>
                  </div>
                )}

                {!loadingSavedCards && hasStripeSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'stripe',
                    label: 'Stripe',
                    description: 'Iniciará la suscripción con Stripe.',
                    value: selectedStripePaymentMethodId,
                    options: savedPaymentMethodOptions,
                    active: form.paymentMethod === 'stripe_saved_card',
                    onSelect: (value) => {
                      setSelectedStripePaymentMethodId(value)
                      applyPaymentMethod({ value: 'stripe_saved_card', provider: 'stripe' })
                    }
                  })
                )}

                {!loadingSavedCards && hasConektaSavedCards && (
                  renderSavedCardGatewayRow({
                    platform: 'conekta',
                    label: 'Conekta',
                    description: 'Iniciará la suscripción con Conekta.',
                    value: selectedConektaPaymentSourceId,
                    options: savedConektaPaymentSourceOptions,
                    active: form.paymentMethod === 'conekta_subscription',
                    onSelect: (value) => {
                      setSelectedConektaPaymentSourceId(value)
                      applyPaymentMethod({ value: 'conekta_subscription', provider: 'conekta' })
                    }
                  })
                )}
              </div>
            ) : (
            <div className={styles.formGrid}>
              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <ContactSearchInput
                  label="Cliente"
                  value={selectedContact}
                  onChange={(contact) => setSelectedContact(contact as Contact | null)}
                  placeholder="Buscar cliente por nombre, email o teléfono"
                  required
                />
              </div>

              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label>Nombre</label>
                <input
                  value={form.name}
                  onChange={(event) => patchForm('name', event.target.value)}
                  placeholder="Mensualidad, membresía, soporte..."
                  required
                />
              </div>

              {formMode === 'edit' && (
                <div className={styles.formGroup}>
                  <label>Estado</label>
                  <CustomSelect
                    value={form.status}
                    onChange={(event) => patchForm('status', event.target.value)}
                  >
                    {STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </CustomSelect>
                </div>
              )}

              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <label>Descripción</label>
                <textarea
                  rows={3}
                  value={form.description}
                  onChange={(event) => patchForm('description', event.target.value)}
                  placeholder="Notas internas de esta suscripción."
                />
              </div>

              <div className={styles.formGroup}>
                <label>Monto ({accountCurrency})</label>
                <NumberInput
                  value={form.amount}
                  onChange={(event) => patchForm('amount', event.target.value)}
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label>Frecuencia</label>
                <CustomSelect
                  value={form.intervalType}
                  onChange={(event) => patchForm('intervalType', event.target.value)}
                >
                  {INTERVAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>

              <div className={styles.formGroup}>
                <label>Cobrar cada</label>
                <NumberInput
                  value={form.intervalCount}
                  onChange={(event) => patchForm('intervalCount', event.target.value)}
                  min="1"
                  step="1"
                  required
                />
                <p className={styles.formHint}>{getBillingCadenceHelp(form.intervalType, form.intervalCount)}</p>
              </div>

              <div className={styles.formGroup}>
                <label>Inicio</label>
                <input
                  value={form.startDate}
                  onChange={(event) => patchForm('startDate', event.target.value)}
                  type="date"
                  min={getTodayInputValue(timezone)}
                />
              </div>

              <div className={styles.formGroup}>
                <label>Duración del plan</label>
                <CustomSelect
                  value={form.durationType}
                  onChange={(event) => patchForm('durationType', event.target.value)}
                >
                  {DURATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>

              {form.durationType === 'until_date' && (
                <div className={styles.formGroup}>
                  <label>Termina el</label>
                  <input
                    value={form.cancelAt}
                    onChange={(event) => patchForm('cancelAt', event.target.value)}
                    type="date"
                    min={form.startDate || getTodayInputValue(timezone)}
                    required
                  />
                </div>
              )}

              {formMode === 'edit' && !isMercadoPagoSelected && (
                <div className={styles.formGroup}>
                  <label>Próximo cobro</label>
                  <input
                    value={form.nextRunAt}
                    onChange={(event) => patchForm('nextRunAt', event.target.value)}
                    type="date"
                    min={getTodayInputValue(timezone)}
                  />
                </div>
              )}

              {formMode === 'edit' && (
              <div className={styles.formGroup}>
                <label>Método de cobro</label>
                <CustomSelect
                  value={form.paymentMethod}
                  onChange={(event) => {
                    const option = availablePaymentMethodOptions.find((item) => item.value === event.target.value)
                    setForm((current) => ({
                      ...current,
                      paymentMethod: (option?.value || 'stripe_saved_card') as SubscriptionPaymentMethod,
                      paymentProvider: option?.provider || 'stripe',
                      status: option?.value && isLinkPaymentMethod(option.value) ? 'incomplete' : current.status
                    }))
                  }}
                >
                  {availablePaymentMethodOptions.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>
              )}

              {formMode === 'edit' && (
              <div className={`${styles.providerHint} ${styles.fullWidth}`}>
                <PaymentPlatformLogo platform={isMercadoPagoSelected ? 'mercadopago' : isConektaSelected ? 'conekta' : isClipSelected ? 'clip' : 'stripe'} size="sm" decorative />
                <p className={styles.formHint}>
                  {isMercadoPagoSelected
                    ? form.paymentMethod === 'mercadopago_checkout'
                      ? 'Mercado Pago creará la suscripción en su sistema y entregará su link de autorización.'
                      : 'Mercado Pago manejará esta suscripción desde su propio sistema y entregará su link de autorización.'
                    : isConektaSelected
                      ? form.paymentMethod === 'conekta_link'
                        ? 'Conekta generará su link hospedado para autorizar la tarjeta y crear la suscripción.'
                        : 'Para cobros automáticos con Conekta, el contacto debe tener una tarjeta guardada. Ristak usará la tarjeta predeterminada del contacto.'
                      : isClipSelected
                        ? 'CLIP ya no está disponible para suscripciones. Este registro se conserva solo como historial; usa Stripe, Conekta o Mercado Pago para nuevos cobros recurrentes.'
                      : form.paymentMethod === 'stripe_link'
                        ? 'Stripe abrirá Checkout para que el cliente autorice y active la suscripción.'
                        : 'Para cobros automáticos con Stripe, el contacto debe tener una tarjeta guardada. Ristak usará la tarjeta predeterminada del contacto.'}
                </p>
              </div>
              )}
            </div>
            )}

            <div className={styles.footerActions}>
              <Button
                type="button"
                variant="ghost"
                onClick={goBackFormStep}
                disabled={saving}
              >
                {showStartMethodStep || showGatewayStep || showSavedCardStep ? 'Atrás' : 'Cancelar'}
              </Button>
              <Button type="submit" loading={saving} disabled={submitDisabled}>
                {formMode === 'edit'
                  ? 'Guardar suscripción'
                  : showGatewayStep
                    ? startsByLink ? 'Crear link de suscripción' : 'Crear suscripción'
                    : showSavedCardStep
                      ? 'Crear suscripción'
                    : showStartMethodStep && form.startMode === 'link' && !hasMultipleLinkPaymentGateways && availableLinkPaymentMethodOptions.length === 1
                      ? 'Crear link de suscripción'
                    : showStartMethodStep
                      ? 'Continuar'
                    : 'Continuar'}
              </Button>
            </div>
            </form>
          )}
        </Modal>
      </div>
    </PageContainer>
  )
}
