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
  PaymentPlatformLogo,
  Table,
  TableSelectionToolbar
} from '@/components/common'
import type { BadgeVariant, Column, PaymentPlatformLogoId } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency } from '@/hooks'
import type { Contact } from '@/types'
import { formatCurrency, formatDate } from '@/utils/format'
import { getIntegrationsStatus } from '@/services/integrationsService'
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
type SubscriptionFormStep = 'details' | 'gateway'
type PaymentGatewayProvider = 'stripe' | 'conekta' | 'mercadopago'
type SubscriptionPaymentMethod = 'stripe_saved_card' | 'stripe_link' | 'conekta_subscription' | 'mercadopago_subscription'
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
    label: 'Stripe - link de autorización',
    provider: 'stripe',
    modeLabel: 'Enviar link',
    description: 'Genera un Checkout de suscripción para que el cliente autorice el pago.',
    requirement: 'Requiere un contacto con email.',
    result: 'Queda incompleta hasta que el cliente complete el link.'
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
    value: 'mercadopago_subscription',
    label: 'Mercado Pago - link de autorización',
    provider: 'mercadopago',
    modeLabel: 'Enviar link',
    description: 'Genera el link de autorización de Mercado Pago para iniciar la suscripción.',
    requirement: 'Requiere un contacto con email.',
    result: 'Queda incompleta hasta que el cliente autorice el cobro.'
  }
]

const DURATION_OPTIONS: Array<{ value: SubscriptionDurationType; label: string }> = [
  { value: 'continuous', label: 'Continua, sin fecha final' },
  { value: 'until_date', label: 'Hasta una fecha específica' }
]

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
    paymentMethod: 'stripe_saved_card',
    paymentProvider: 'stripe'
  }
}

function resolvePaymentProvider(provider?: string | null): PaymentGatewayProvider {
  if (provider === 'mercadopago' || provider === 'conekta' || provider === 'stripe') return provider
  return 'stripe'
}

function getPaymentProviderFromMethod(paymentMethod: string, paymentProvider: PaymentGatewayProvider): PaymentGatewayProvider {
  if (paymentMethod === 'mercadopago_subscription') return 'mercadopago'
  if (paymentMethod === 'conekta_subscription') return 'conekta'
  if (paymentMethod === 'stripe_saved_card' || paymentMethod === 'stripe_link') return 'stripe'
  return paymentProvider
}

function createEmptyFormForPaymentMethod(option?: { value: SubscriptionPaymentMethod; provider: PaymentGatewayProvider } | null): SubscriptionFormState {
  const form = createEmptyForm()
  if (!option) return form

  if (option.provider === 'mercadopago' || option.value === 'stripe_link') {
    return {
      ...form,
      status: 'incomplete',
      paymentMethod: option.value,
      paymentProvider: option.provider
    }
  }

  return {
    ...form,
    paymentMethod: option.value,
    paymentProvider: option.provider
  }
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
  if (normalized === 'stripe_link') return 'Link de Stripe'
  if (normalized === 'conekta_subscription') return 'Conekta domiciliado'
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

function getMercadoPagoSubscriptionLink(subscription: PaymentSubscription) {
  if (subscription.paymentMode === 'test') {
    return subscription.mercadoPagoSandboxInitPoint || subscription.mercadoPagoInitPoint || ''
  }
  return subscription.mercadoPagoInitPoint || subscription.mercadoPagoSandboxInitPoint || ''
}

function getSubscriptionStartLink(subscription: PaymentSubscription) {
  return subscription.subscriptionStartUrl || subscription.stripeCheckoutUrl || getMercadoPagoSubscriptionLink(subscription)
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
  const [formMode, setFormMode] = useState<SubscriptionFormMode>(null)
  const [formStep, setFormStep] = useState<SubscriptionFormStep>('details')
  const [editingSubscription, setEditingSubscription] = useState<PaymentSubscription | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [form, setForm] = useState<SubscriptionFormState>(() => createEmptyForm())
  const [stripeConnected, setStripeConnected] = useState(false)
  const [conektaConnected, setConektaConnected] = useState(false)
  const [mercadoPagoConnected, setMercadoPagoConnected] = useState(false)
  const [integrationsLoading, setIntegrationsLoading] = useState(true)

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

  const availablePaymentMethodOptions = useMemo(() => (
    PAYMENT_METHOD_OPTIONS.filter((option) => (
      option.provider === 'stripe' ? stripeConnected : option.provider === 'conekta' ? conektaConnected : mercadoPagoConnected
    ))
  ), [conektaConnected, mercadoPagoConnected, stripeConnected])

  const defaultPaymentMethodOption = availablePaymentMethodOptions[0] || null
  const selectedPaymentMethodOption = availablePaymentMethodOptions.find((option) => option.value === form.paymentMethod) || null
  const hasSubscriptionGateway = availablePaymentMethodOptions.length > 0
  const showGatewayStep = formMode === 'create' && formStep === 'gateway'
  const isMercadoPagoSelected = (formMode === 'edit' || showGatewayStep) && form.paymentMethod === 'mercadopago_subscription'
  const isConektaSelected = (formMode === 'edit' || showGatewayStep) && form.paymentMethod === 'conekta_subscription'
  const startsByLink = form.paymentMethod === 'stripe_link' || form.paymentMethod === 'mercadopago_subscription'

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

    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyFormForPaymentMethod(defaultPaymentMethodOption))
    setFormStep('details')
    setFormMode('create')
  }

  const openEditSubscription = (subscription: PaymentSubscription) => {
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
      status: fallback.value === 'stripe_link' || fallback.value === 'mercadopago_subscription' ? 'incomplete' : 'active'
    }))
  }, [availablePaymentMethodOptions, form.paymentMethod, formMode])

  const closeForm = () => {
    if (saving) return

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

  const validateSubscriptionDetails = () => {
    const name = form.name.trim()
    const amount = Number(form.amount)
    const intervalCount = Number.parseInt(form.intervalCount, 10)

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
    const startByLink = paymentMethod === 'stripe_link' || paymentMethod === 'mercadopago_subscription'

    if (!contactId) {
      showToast('warning', 'Falta el contacto', 'Selecciona el contacto que va a tener esta suscripción.')
      return null
    }

    if (startByLink && !contactEmail) {
      showToast('warning', 'Falta el email', `${provider === 'mercadopago' ? 'Mercado Pago' : 'Stripe'} necesita email para que el cliente autorice la suscripción.`)
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
      conektaPaymentSourceId: provider === 'conekta' ? editingSubscription?.conektaPaymentSourceId || null : undefined,
      source: editingSubscription?.source || 'ristak'
    }
  }

  const saveSubscription = async () => {
    if (formMode === 'create' && formStep === 'details' && availablePaymentMethodOptions.length > 1) {
      if (!validateSubscriptionDetails()) return
      const nextForm = createEmptyFormForPaymentMethod(selectedPaymentMethodOption || defaultPaymentMethodOption)
      setForm({
        ...nextForm,
        name: form.name,
        description: form.description,
        amount: form.amount,
        intervalType: form.intervalType,
        intervalCount: form.intervalCount,
        startDate: form.startDate,
        nextRunAt: form.nextRunAt,
        cancelAt: form.cancelAt,
        durationType: form.durationType,
        status: form.status
      })
      setFormStep('gateway')
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
        const startLink = getSubscriptionStartLink(created)
        if (startLink && (created.paymentMethod === 'stripe_link' || created.paymentProvider === 'mercadopago')) {
          showToast('success', 'Link de autorización listo', `Copia el link de ${payload.name} para que el cliente active la suscripción.`)
        } else {
          showToast('success', 'Suscripción creada', `${payload.name} ya aparece en la lista.`)
        }
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

  const copySubscriptionStartLink = async (subscription: PaymentSubscription) => {
    const link = getSubscriptionStartLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'La pasarela todavía no devolvió un link de autorización para esta suscripción.')
      return
    }

    await navigator.clipboard.writeText(link)
    showToast('success', 'Link copiado', 'Ya puedes enviarlo al cliente para autorizar la suscripción.')
  }

  const openSubscriptionStartLink = (subscription: PaymentSubscription) => {
    const link = getSubscriptionStartLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'La pasarela todavía no devolvió un link de autorización para esta suscripción.')
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
        const isAuthorizationPending = Boolean(startLink) && status === 'incomplete'
        const canPause = status === 'active' || status === 'trialing'
        const canActivate = (status === 'paused' || status === 'draft' || status === 'past_due' || status === 'incomplete') && !(isMercadoPago && status === 'incomplete') && !isAuthorizationPending
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
                    <DropdownMenuItem disabled={busy} onClick={() => void copySubscriptionStartLink(item)}>
                      <Copy size={16} />
                      <span>Copiar autorización</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => openSubscriptionStartLink(item)}>
                      <ExternalLink size={16} />
                      <span>Abrir autorización</span>
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
          title={formMode === 'edit' ? 'Editar suscripción' : showGatewayStep ? 'Elige cómo iniciar' : 'Nueva suscripción'}
          size="md"
          type="custom"
          closeOnBackdropClick={false}
          closeOnEscape={false}
        >
          <form className={styles.form} onSubmit={(event) => {
            event.preventDefault()
            void saveSubscription()
          }}>
            {showGatewayStep ? (
              <div className={styles.gatewayPicker}>
                {availablePaymentMethodOptions.map((option) => {
                  const active = form.paymentMethod === option.value
                  const providerName = option.provider === 'mercadopago' ? 'Mercado Pago' : option.provider === 'conekta' ? 'Conekta' : 'Stripe'
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`${styles.gatewayOption} ${active ? styles.gatewayOptionActive : ''}`}
                      onClick={() => {
                        setForm((current) => ({
                          ...current,
                          paymentMethod: option.value,
                          paymentProvider: option.provider,
                          status: option.value === 'stripe_link' || option.value === 'mercadopago_subscription' ? 'incomplete' : current.status === 'incomplete' ? 'active' : current.status
                        }))
                      }}
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
                      status: option?.value === 'stripe_link' || option?.value === 'mercadopago_subscription' ? 'incomplete' : current.status
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
                    ? 'Mercado Pago creará una autorización de suscripción. Copia el link y envíalo al cliente; los cobros se activan cuando acepte el método de pago.'
                    : isConektaSelected
                      ? 'Para cobros automáticos con Conekta, el contacto debe tener una tarjeta guardada. Ristak usará la tarjeta predeterminada del contacto.'
                      : form.paymentMethod === 'stripe_link'
                        ? 'Stripe generará un Checkout de suscripción. Copia el link y envíalo al cliente; Ristak la activará cuando Stripe confirme la autorización.'
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
                onClick={() => {
                  if (showGatewayStep) {
                    setFormStep('details')
                    return
                  }
                  closeForm()
                }}
                disabled={saving}
              >
                {showGatewayStep ? 'Atrás' : 'Cancelar'}
              </Button>
              <Button type="submit" loading={saving}>
                {formMode === 'edit'
                  ? 'Guardar suscripción'
                  : showGatewayStep
                    ? startsByLink ? 'Crear link de autorización' : 'Crear suscripción'
                    : availablePaymentMethodOptions.length > 1
                      ? 'Continuar'
                      : startsByLink ? 'Crear link de autorización' : 'Crear suscripción'}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </PageContainer>
  )
}
