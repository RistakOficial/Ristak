import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarClock,
  Check,
  Copy,
  CreditCard,
  Edit3,
  ExternalLink,
  MoreVertical,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Repeat2,
  Send,
  Settings,
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
import { useAccountCurrency } from '@/hooks'
import type { Contact } from '@/types'
import { formatCurrency, formatDate } from '@/utils/format'
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
type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago'
type SubscriptionPaymentMethod = 'stripe_saved_card' | 'stripe_link' | 'conekta_subscription' | 'conekta_link' | 'mercadopago_checkout' | 'mercadopago_subscription'
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
    result: 'Se crea activa o en prueba según la fecha de inicio.'
  },
  {
    value: 'stripe_link',
    label: 'Stripe - link de pago',
    provider: 'stripe',
    modeLabel: 'Link de pago',
    description: 'Genera un link público de Ristak para cobrar el primer pago.',
    requirement: 'Requiere un contacto con email.',
    result: 'Al pagarse, Ristak guarda la tarjeta e inicia la suscripción.'
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
    label: 'Conekta - link de pago',
    provider: 'conekta',
    modeLabel: 'Link de pago',
    description: 'Genera un link público de Ristak para cobrar el primer pago con Conekta.',
    requirement: 'Requiere un contacto con email.',
    result: 'Al pagarse, Ristak guarda la tarjeta e inicia la suscripción.'
  },
  {
    value: 'mercadopago_checkout',
    label: 'Mercado Pago - link de pago',
    provider: 'mercadopago',
    modeLabel: 'Link de pago',
    description: 'Genera un link público de Ristak para cobrar el primer pago con Mercado Pago.',
    requirement: 'Requiere un contacto con email.',
    result: 'El cliente paga desde la página pública y Ristak registra ese arranque.'
  },
  {
    value: 'mercadopago_subscription',
    label: 'Mercado Pago - suscripción Mercado Pago',
    provider: 'mercadopago',
    modeLabel: 'Sistema Mercado Pago',
    description: 'Usa el sistema de suscripción de Mercado Pago para cobros recurrentes.',
    requirement: 'Requiere un contacto con email.',
    result: 'Queda pendiente hasta que Mercado Pago active la suscripción.'
  }
]

const DURATION_OPTIONS: Array<{ value: SubscriptionDurationType; label: string }> = [
  { value: 'continuous', label: 'Continua, sin fecha final' },
  { value: 'until_date', label: 'Hasta una fecha específica' }
]

const LINK_PAYMENT_METHODS = new Set<SubscriptionPaymentMethod>(['stripe_link', 'conekta_link', 'mercadopago_checkout'])
const SAVED_CARD_PAYMENT_METHODS = new Set<SubscriptionPaymentMethod>(['stripe_saved_card', 'conekta_subscription'])

function isLinkPaymentMethod(value: SubscriptionPaymentMethod) {
  return LINK_PAYMENT_METHODS.has(value)
}

function getStartModeForPaymentMethod(value?: string | null): SubscriptionStartMode {
  if (value && LINK_PAYMENT_METHODS.has(value as SubscriptionPaymentMethod)) return 'link'
  if (value && SAVED_CARD_PAYMENT_METHODS.has(value as SubscriptionPaymentMethod)) return 'saved_card'
  return ''
}

function formatLocalDateInput(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function toDateInputValue(value?: string | null) {
  if (!value) return ''
  const dateOnly = String(value).match(/^(\d{4}-\d{2}-\d{2})/)
  if (dateOnly) return dateOnly[1]
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return formatLocalDateInput(date)
}

function getTodayInputValue() {
  return formatLocalDateInput(new Date())
}

function isDateBeforeToday(value?: string | null) {
  return Boolean(value && value < getTodayInputValue())
}

function clampDateToToday(value?: string | null) {
  const today = getTodayInputValue()
  return value && value >= today ? value : today
}

function createEmptyForm(): SubscriptionFormState {
  const today = getTodayInputValue()

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
  if (provider === 'mercadopago' || provider === 'conekta' || provider === 'stripe') return provider
  return 'stripe'
}

function getPaymentProviderFromMethod(paymentMethod: string, paymentProvider: PaymentGatewayProvider): PaymentGatewayProvider {
  if (paymentMethod === 'mercadopago_subscription' || paymentMethod === 'mercadopago_checkout') return 'mercadopago'
  if (paymentMethod === 'conekta_subscription' || paymentMethod === 'conekta_link') return 'conekta'
  if (paymentMethod === 'stripe_saved_card' || paymentMethod === 'stripe_link') return 'stripe'
  return paymentProvider
}

function getSavedStripeCardDescription(method?: StripeSavedPaymentMethod | null) {
  if (!method) return 'Tarjeta guardada'
  const brand = method.brand ? method.brand.toUpperCase() : 'Tarjeta'
  const label = `${brand} •••• ${method.last4 || '----'}`
  return method.expiresLabel ? `${label} · vence ${method.expiresLabel}` : label
}

function getSavedConektaCardDescription(source?: ConektaSavedPaymentSource | null) {
  if (!source) return 'Tarjeta guardada'
  const brand = source.brand ? source.brand.toUpperCase() : 'Tarjeta'
  const label = `${brand} •••• ${source.last4 || '----'}`
  return source.expiresLabel ? `${label} · vence ${source.expiresLabel}` : label
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
  if (normalized === 'stripe_link') return 'Link de pago Stripe'
  if (normalized === 'conekta_subscription') return 'Conekta domiciliado'
  if (normalized === 'conekta_link') return 'Link de pago Conekta'
  if (normalized === 'mercadopago_checkout') return 'Link de pago Mercado Pago'
  if (normalized === 'mercadopago_subscription') return 'Suscripción Mercado Pago'
  if (normalized === 'manual') return 'Manual'
  return value || 'Sin método'
}

function getSourceLabel(subscription: PaymentSubscription) {
  if (subscription.mercadoPagoPreapprovalId || subscription.paymentProvider === 'mercadopago') return 'Mercado Pago'
  if (subscription.conektaSubscriptionId || subscription.paymentProvider === 'conekta') return 'Conekta'
  if (subscription.stripeSubscriptionId || subscription.paymentProvider === 'stripe') return 'Stripe'
  if (subscription.source === 'ghl') return 'HighLevel'
  return 'Ristak'
}

function getSubscriptionProviderLogo(subscription: PaymentSubscription): PaymentPlatformLogoId | null {
  if (subscription.mercadoPagoPreapprovalId || subscription.paymentProvider === 'mercadopago') return 'mercadopago'
  if (subscription.conektaSubscriptionId || subscription.paymentProvider === 'conekta') return 'conekta'
  if (subscription.stripeSubscriptionId || subscription.paymentProvider === 'stripe') return 'stripe'
  return null
}

function getSubscriptionStartLink(subscription: PaymentSubscription) {
  return subscription.subscriptionStartUrl || ''
}

function getSubscriptionContactDisplayName(contact?: PaymentLinkReadyData['contact'] | null) {
  return contact?.name ||
    `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() ||
    contact?.email ||
    contact?.phone ||
    'cliente'
}

function buildSubscriptionPaymentLinkPanel(subscription: PaymentSubscription): PaymentLinkReadyData | null {
  const paymentMethod = (subscription.paymentMethod || '') as SubscriptionPaymentMethod
  if (!isLinkPaymentMethod(paymentMethod)) return null

  const paymentUrl = subscription.subscriptionStartUrl || ''
  if (!paymentUrl || !subscription.contactId) return null

  const provider = (subscription.subscriptionStartPaymentProvider || getSubscriptionProviderLogo(subscription) || resolvePaymentProvider(subscription.paymentProvider)) as PaymentPlatformLogoId

  return {
    kind: 'subscription_start',
    title: 'Link de pago listo',
    description: 'Comparte este enlace público de Ristak para que el cliente realice el primer pago de la suscripción.',
    provider,
    paymentUrl,
    amount: Number(subscription.amount || 0),
    currency: subscription.currency || 'MXN',
    contact: {
      id: subscription.contactId,
      name: subscription.contactName || 'Contacto',
      email: subscription.contactEmail || '',
      phone: subscription.contactPhone || ''
    },
    paymentId: subscription.subscriptionStartPaymentId || null,
    publicPaymentId: subscription.subscriptionStartPublicPaymentId || null
  }
}

function getSubscriptionPaymentLinkShareText(link: PaymentLinkReadyData) {
  const contactName = getSubscriptionContactDisplayName(link.contact)
  const amountText = link.amount > 0 ? ` por ${formatCurrency(link.amount, link.currency)}` : ''
  const activationText = link.provider === 'stripe' || link.provider === 'conekta'
    ? 'Al pagarlo se guarda tu tarjeta para activar los siguientes cobros de la suscripción.'
    : 'Al pagarlo registramos el inicio de tu suscripción.'

  return `Hola ${contactName}, te comparto el enlace del primer pago de tu suscripción${amountText}. ${activationText}\n${link.paymentUrl}`
}

function getSubscriptionPaymentLinkEmailSubject() {
  return 'Primer pago de suscripción'
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
  const { showToast } = useNotification()
  const [accountCurrency] = useAccountCurrency()
  const [subscriptions, setSubscriptions] = useState<PaymentSubscription[]>([])
  const [summary, setSummary] = useState<SubscriptionSummary>(EMPTY_SUMMARY)
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [selectedSubscriptionIds, setSelectedSubscriptionIds] = useState<string[]>([])
  const [subscriptionsPendingDeletion, setSubscriptionsPendingDeletion] = useState<PaymentSubscription[]>([])
  const [deletingSubscriptions, setDeletingSubscriptions] = useState(false)
  const [createdSubscriptionLink, setCreatedSubscriptionLink] = useState<PaymentLinkReadyData | null>(null)
  const [formMode, setFormMode] = useState<SubscriptionFormMode>(null)
  const [formStep, setFormStep] = useState<SubscriptionFormStep>('details')
  const [editingSubscription, setEditingSubscription] = useState<PaymentSubscription | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [form, setForm] = useState<SubscriptionFormState>(() => createEmptyForm())
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
      const data = await subscriptionsService.listSubscriptions()
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
          const stillExists = stripeMethods.some((method) => method.stripePaymentMethodId === current || method.id === current)
          if (stillExists) return current
          const preferred = stripeMethods.find((method) => method.isDefault) || stripeMethods[0]
          return preferred?.stripePaymentMethodId || ''
        })
        setSelectedConektaPaymentSourceId((current) => {
          const stillExists = conektaSources.some((source) => source.conektaPaymentSourceId === current || source.id === current)
          if (stillExists) return current
          const preferred = conektaSources.find((source) => source.isDefault) || conektaSources[0]
          return preferred?.conektaPaymentSourceId || ''
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
      option.provider === 'stripe' ? stripeConnected : option.provider === 'conekta' ? conektaConnected : mercadoPagoConnected
    ))
  ), [conektaConnected, mercadoPagoConnected, stripeConnected])
  const availableLinkPaymentMethodOptions = useMemo(() => (
    availablePaymentMethodOptions.filter((option) => isLinkPaymentMethod(option.value))
  ), [availablePaymentMethodOptions])
  const hasSavedCardGateway = stripeConnected || conektaConnected

  const hasSubscriptionGateway = availablePaymentMethodOptions.length > 0
  const showGatewayStep = formMode === 'create' && formStep === 'gateway'
  const showStartMethodStep = formMode === 'create' && formStep === 'start_method'
  const showSavedCardStep = formMode === 'create' && formStep === 'saved_card'
  const isMercadoPagoSelected = (formMode === 'edit' || showGatewayStep) && ['mercadopago_subscription', 'mercadopago_checkout'].includes(form.paymentMethod)
  const isConektaSelected = (formMode === 'edit' || showGatewayStep || showSavedCardStep) && ['conekta_subscription', 'conekta_link'].includes(form.paymentMethod)
  const startsByLink = isLinkPaymentMethod(form.paymentMethod)
  const hasStripeSavedCards = stripeConnected && savedPaymentMethods.length > 0
  const hasConektaSavedCards = conektaConnected && savedConektaPaymentSources.length > 0
  const hasSavedCardOptions = hasStripeSavedCards || hasConektaSavedCards
  const selectedStripePaymentMethod = savedPaymentMethods.find((method) => (
    method.stripePaymentMethodId === selectedStripePaymentMethodId || method.id === selectedStripePaymentMethodId
  )) || null
  const selectedConektaPaymentSource = savedConektaPaymentSources.find((source) => (
    source.conektaPaymentSourceId === selectedConektaPaymentSourceId || source.id === selectedConektaPaymentSourceId
  )) || null
  const selectedSavedCardReady = form.paymentMethod === 'stripe_saved_card'
    ? Boolean(selectedStripePaymentMethod)
    : form.paymentMethod === 'conekta_subscription'
      ? Boolean(selectedConektaPaymentSource)
      : false
  const submitDisabled = saving || (showSavedCardStep && (loadingSavedCards || !selectedSavedCardReady))

  useEffect(() => {
    if (integrationsLoading || hasSubscriptionGateway) return

    showToast('warning', 'Suscripciones no disponibles', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones automáticas.')
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
    setForm(createEmptyForm())
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
      startDate: clampDateToToday(toDateInputValue(subscription.startDate)),
      nextRunAt: clampDateToToday(toDateInputValue(subscription.nextRunAt)),
      cancelAt: toDateInputValue(subscription.cancelAt),
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
    setForm(createEmptyForm())
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
        ? clampDateToToday(value)
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
        showToast('warning', 'No hay pasarela de link', 'Conecta Stripe, Conekta o Mercado Pago para generar un link de pago.')
        return
      }

      applyPaymentMethod(fallback)
      setFormStep('gateway')
      return
    }

    if (!hasSavedCardGateway) {
      showToast('warning', 'No hay pasarela con tarjeta guardada', 'Conecta Stripe o Conekta para cobrar una tarjeta guardada.')
      return
    }

    if (hasStripeSavedCards) {
      applyPaymentMethod({ value: 'stripe_saved_card', provider: 'stripe' })
    } else if (hasConektaSavedCards) {
      applyPaymentMethod({ value: 'conekta_subscription', provider: 'conekta' })
    } else {
      setForm((current) => ({
        ...current,
        startMode: 'saved_card',
        paymentMethod: stripeConnected ? 'stripe_saved_card' : 'conekta_subscription',
        paymentProvider: stripeConnected ? 'stripe' : 'conekta',
        status: current.status === 'incomplete' ? 'active' : current.status
      }))
    }
    setFormStep('saved_card')
  }

  const chooseStripeSavedCard = (method: StripeSavedPaymentMethod) => {
    setSelectedStripePaymentMethodId(method.stripePaymentMethodId || method.id || '')
    applyPaymentMethod({ value: 'stripe_saved_card', provider: 'stripe' })
  }

  const chooseConektaSavedCard = (source: ConektaSavedPaymentSource) => {
    setSelectedConektaPaymentSourceId(source.conektaPaymentSourceId || source.id || '')
    applyPaymentMethod({ value: 'conekta_subscription', provider: 'conekta' })
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

      if (isDateBeforeToday(form.cancelAt) || form.cancelAt <= form.startDate) {
        showToast('warning', 'Duración inválida', 'La fecha final debe ser posterior al inicio de la suscripción.')
        return false
      }
    }

    return true
  }

  const buildPayload = (): SubscriptionPayload | null => {
    const name = form.name.trim()
    const amount = Number(form.amount)
    const intervalCount = Number.parseInt(form.intervalCount, 10)

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

    if (form.durationType === 'until_date') {
      if (!form.cancelAt) {
        showToast('warning', 'Falta la duración', 'Elige hasta qué fecha debe cobrarse esta suscripción.')
        return null
      }

      if (isDateBeforeToday(form.cancelAt) || form.cancelAt <= form.startDate) {
        showToast('warning', 'Duración inválida', 'La fecha final debe ser posterior al inicio de la suscripción.')
        return null
      }
    }

    const paymentMethod = form.paymentMethod
    const provider = getPaymentProviderFromMethod(paymentMethod, form.paymentProvider)
    const contactEmail = selectedContact?.email || editingSubscription?.contactEmail || null
    const contactId = selectedContact?.id || editingSubscription?.contactId || null
    const startByLink = isLinkPaymentMethod(paymentMethod)

    if (!contactId) {
      showToast('warning', 'Falta el contacto', 'Selecciona el contacto que va a tener esta suscripción.')
      return null
    }

    if (startByLink && !contactEmail) {
      showToast('warning', 'Falta el email', `${provider === 'mercadopago' ? 'Mercado Pago' : provider === 'conekta' ? 'Conekta' : 'Stripe'} necesita email para crear el link de pago.`)
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

    if (provider === 'conekta' && form.intervalType === 'daily') {
      showToast('warning', 'Frecuencia no soportada', 'Conekta no acepta suscripciones diarias. Usa semanal, mensual o anual.')
      return null
    }

    if (isDateBeforeToday(form.startDate) || (!startByLink && isDateBeforeToday(form.nextRunAt))) {
      showToast('warning', 'Fecha inválida', 'Las suscripciones automáticas no pueden iniciar ni cobrarse en fechas pasadas.')
      return null
    }

    return {
      contactId,
      contactName: selectedContact?.name || editingSubscription?.contactName || null,
      contactEmail,
      contactPhone: selectedContact?.phone || editingSubscription?.contactPhone || null,
      name,
      description: form.description.trim(),
      status: formMode === 'edit' ? form.status : startByLink ? 'incomplete' : 'active',
      amount,
      currency: accountCurrency,
      intervalType: form.intervalType,
      intervalCount,
      startDate: form.startDate || null,
      nextRunAt: startByLink ? null : form.nextRunAt || null,
      cancelAt: form.durationType === 'until_date' ? form.cancelAt || null : null,
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
    if (formMode === 'create' && formStep === 'details') {
      if (!validateSubscriptionDetails()) return
      setFormStep('start_method')
      return
    }

    if (formMode === 'create' && formStep === 'start_method') {
      if (form.startMode === 'link' || form.startMode === 'saved_card') {
        chooseStartMode(form.startMode)
        return
      }

      showToast('warning', 'Elige cómo iniciar', 'Selecciona si vas a enviar link de pago o usar una tarjeta guardada.')
      return
    }

    if (formMode === 'create' && formStep === 'gateway' && !availableLinkPaymentMethodOptions.some((option) => option.value === form.paymentMethod)) {
      const fallback = availableLinkPaymentMethodOptions[0]
      if (!fallback) {
        showToast('warning', 'No hay pasarela de link', 'Conecta Stripe, Conekta o Mercado Pago para crear un link de pago.')
        return
      }
      applyPaymentMethod(fallback)
      return
    }

    if (formMode === 'create' && formStep === 'saved_card' && !selectedSavedCardReady) {
      showToast('warning', 'Selecciona una tarjeta', 'Elige una tarjeta guardada de Stripe o Conekta para continuar.')
      return
    }

    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (formMode === 'edit' && editingSubscription) {
        await subscriptionsService.updateSubscription(editingSubscription.id, payload)
        showToast('success', 'Suscripción actualizada', `${payload.name} ya quedó lista.`)
      } else {
        const created = await subscriptionsService.createSubscription(payload)
        const readyLink = buildSubscriptionPaymentLinkPanel(created)
        if (readyLink) {
          setCreatedSubscriptionLink(readyLink)
          showToast('success', 'Link de pago listo', `El link de ${payload.name} ya está listo para copiar o enviar.`)
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
      showToast('warning', 'Link no disponible', 'Todavía no hay un link de pago público para esta suscripción.')
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
      showToast('warning', 'Link no disponible', 'Todavía no hay un link de pago público para esta suscripción.')
      return
    }

    await navigator.clipboard.writeText(link)
    showToast('success', 'Link copiado', 'Ya puedes enviarlo al cliente para realizar el primer pago.')
  }

  const openSubscriptionStartLink = (subscription: PaymentSubscription) => {
    const link = getSubscriptionStartLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'Todavía no hay un link de pago público para esta suscripción.')
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
      render: (value) => value ? formatDate(value, { includeYear: true }) : <span className={styles.mutedCell}>Sin fecha</span>,
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
        const status = String(item.status || '').toLowerCase()
        const isMercadoPago = item.paymentProvider === 'mercadopago' || Boolean(item.mercadoPagoPreapprovalId)
        const startLink = getSubscriptionStartLink(item)
        const isPaymentLinkPending = Boolean(startLink) && status === 'incomplete'
        const canPause = status === 'active' || status === 'trialing'
        const canActivate = (status === 'paused' || status === 'draft' || status === 'past_due' || status === 'incomplete') && !(isMercadoPago && status === 'incomplete') && !isPaymentLinkPending
        const canCancel = status !== 'cancelled' && status !== 'deleted'

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
                      <span>Enviar link de pago</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => void copySubscriptionStartLink(item)}>
                      <Copy size={16} />
                      <span>Copiar link de pago</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => openSubscriptionStartLink(item)}>
                      <ExternalLink size={16} />
                      <span>Abrir link de pago</span>
                    </DropdownMenuItem>
                  </>
                )}
                {canActivate && (
                  <DropdownMenuItem disabled={busy} onClick={() => void runAction(item, 'activate')}>
                    <Play size={16} />
                    <span>Activar</span>
                  </DropdownMenuItem>
                )}
                {canPause && (
                  <DropdownMenuItem disabled={busy} onClick={() => void runAction(item, 'pause')}>
                    <Pause size={16} />
                    <span>Pausar</span>
                  </DropdownMenuItem>
                )}
                {canCancel && (
                  <DropdownMenuItem disabled={busy} onClick={() => void runAction(item, 'cancel')}>
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
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={deletingSubscriptions}
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
      ? 'Link de pago listo'
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
          <KpiCard title="Próximo cobro" value={summary.nextRunAt ? formatDate(summary.nextRunAt, { includeYear: true }) : 'Sin fecha'} icon={CalendarClock} loading={loading} />
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
              selectVisibleLabel: 'Seleccionar suscripciones visibles'
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
              <div className={styles.gatewayPicker}>
                {availableLinkPaymentMethodOptions.length > 0 && (
                  <button
                    type="button"
                    className={`${styles.gatewayOption} ${form.startMode === 'link' ? styles.gatewayOptionActive : ''}`}
                    onClick={() => chooseStartMode('link')}
                  >
                    <span className={styles.gatewayOptionLogo}>
                      <ExternalLink size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>Enviar link de pago</strong>
                      <small>El cliente realiza el primer pago desde la página pública de Ristak.</small>
                      <small>Después eliges si el link sale por Stripe, Conekta o Mercado Pago.</small>
                    </span>
                    <ExternalLink size={18} className={styles.gatewayOptionCheck} aria-hidden="true" />
                  </button>
                )}

                {hasSavedCardGateway && (
                  <button
                    type="button"
                    className={`${styles.gatewayOption} ${form.startMode === 'saved_card' ? styles.gatewayOptionActive : ''}`}
                    onClick={() => chooseStartMode('saved_card')}
                  >
                    <span className={styles.gatewayOptionLogo}>
                      <CreditCard size={18} aria-hidden="true" />
                    </span>
                    <span>
                      <strong>Usar tarjeta guardada</strong>
                      <small>Ristak inicia la suscripción con una tarjeta guardada del contacto.</small>
                      <small>Después eliges la tarjeta disponible en Stripe o Conekta.</small>
                    </span>
                    <CreditCard size={18} className={styles.gatewayOptionCheck} aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : showGatewayStep ? (
              <div className={styles.gatewayPicker}>
                {availableLinkPaymentMethodOptions.map((option) => {
                  const active = form.paymentMethod === option.value
                  const providerName = option.provider === 'mercadopago' ? 'Mercado Pago' : option.provider === 'conekta' ? 'Conekta' : 'Stripe'
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.gatewayOption} ${active ? styles.gatewayOptionActive : ''}`}
                      onClick={() => applyPaymentMethod(option)}
                    >
                      <span className={styles.gatewayOptionLogo}>
                        <PaymentPlatformLogo platform={option.provider} size="md" decorative />
                      </span>
                      <span>
                        <strong>{providerName} · {option.modeLabel}</strong>
                        <small>{option.description}</small>
                        <small>{option.requirement} {option.result}</small>
                      </span>
                      {active && <Check size={18} className={styles.gatewayOptionCheck} aria-hidden="true" />}
                    </button>
                  )
                })}
              </div>
            ) : showSavedCardStep ? (
              <div className={styles.gatewayPicker}>
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
                  <div className={styles.optionGroup}>
                    <div className={styles.optionGroupHeader}>
                      <PaymentPlatformLogo platform="stripe" size="sm" decorative />
                      <span>Stripe</span>
                    </div>
                    {savedPaymentMethods.map((method) => {
                      const active = form.paymentMethod === 'stripe_saved_card' && (
                        selectedStripePaymentMethodId === method.stripePaymentMethodId ||
                        selectedStripePaymentMethodId === method.id
                      )

                      return (
                        <button
                          key={method.stripePaymentMethodId || method.id}
                          type="button"
                          className={`${styles.gatewayOption} ${active ? styles.gatewayOptionActive : ''}`}
                          onClick={() => chooseStripeSavedCard(method)}
                        >
                          <span className={styles.gatewayOptionLogo}>
                            <PaymentPlatformLogo platform="stripe" size="md" decorative />
                          </span>
                          <span>
                            <strong>{getSavedStripeCardDescription(method)}</strong>
                            <small>Iniciará la suscripción con esta tarjeta guardada en Stripe.</small>
                          </span>
                          {active && <Check size={18} className={styles.gatewayOptionCheck} aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )}

                {!loadingSavedCards && hasConektaSavedCards && (
                  <div className={styles.optionGroup}>
                    <div className={styles.optionGroupHeader}>
                      <PaymentPlatformLogo platform="conekta" size="sm" decorative />
                      <span>Conekta</span>
                    </div>
                    {savedConektaPaymentSources.map((source) => {
                      const active = form.paymentMethod === 'conekta_subscription' && (
                        selectedConektaPaymentSourceId === source.conektaPaymentSourceId ||
                        selectedConektaPaymentSourceId === source.id
                      )

                      return (
                        <button
                          key={source.conektaPaymentSourceId || source.id}
                          type="button"
                          className={`${styles.gatewayOption} ${active ? styles.gatewayOptionActive : ''}`}
                          onClick={() => chooseConektaSavedCard(source)}
                        >
                          <span className={styles.gatewayOptionLogo}>
                            <PaymentPlatformLogo platform="conekta" size="md" decorative />
                          </span>
                          <span>
                            <strong>{getSavedConektaCardDescription(source)}</strong>
                            <small>Iniciará la suscripción con esta tarjeta guardada en Conekta.</small>
                          </span>
                          {active && <Check size={18} className={styles.gatewayOptionCheck} aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            ) : (
            <div className={styles.formGrid}>
              <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                <ContactSearchInput
                  value={selectedContact}
                  onChange={setSelectedContact}
                  placeholder="Buscar contacto para la suscripción..."
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
                  min={getTodayInputValue()}
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
                    min={form.startDate || getTodayInputValue()}
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
                    min={getTodayInputValue()}
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
                <PaymentPlatformLogo platform={isMercadoPagoSelected ? 'mercadopago' : isConektaSelected ? 'conekta' : 'stripe'} size="sm" decorative />
                <p className={styles.formHint}>
                  {isMercadoPagoSelected
                    ? form.paymentMethod === 'mercadopago_checkout'
                      ? 'Mercado Pago usará el link público de Ristak para cobrar el primer pago de la suscripción.'
                      : 'Mercado Pago manejará esta suscripción desde su propio sistema.'
                    : isConektaSelected
                      ? form.paymentMethod === 'conekta_link'
                        ? 'Conekta usará el link público de Ristak para cobrar el primer pago y guardar la tarjeta.'
                        : 'Para cobros automáticos con Conekta, el contacto debe tener una tarjeta guardada. Ristak usará la tarjeta predeterminada del contacto.'
                      : form.paymentMethod === 'stripe_link'
                        ? 'Stripe usará el link público de Ristak para cobrar el primer pago y guardar la tarjeta.'
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
                    ? startsByLink ? 'Crear link de pago' : 'Crear suscripción'
                    : showSavedCardStep
                      ? 'Crear suscripción'
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
