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
  Table
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

interface SubscriptionFormState {
  name: string
  description: string
  amount: string
  intervalType: SubscriptionInterval
  intervalCount: string
  startDate: string
  nextRunAt: string
  status: SubscriptionStatus
  paymentMethod: string
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

const PAYMENT_METHOD_OPTIONS: Array<{ value: string; label: string; provider: PaymentGatewayProvider }> = [
  { value: 'stripe_saved_card', label: 'Stripe - tarjeta guardada', provider: 'stripe' },
  { value: 'stripe_link', label: 'Stripe - enlace de pago', provider: 'stripe' },
  { value: 'conekta_subscription', label: 'Conekta - tarjeta guardada', provider: 'conekta' },
  { value: 'mercadopago_subscription', label: 'Mercado Pago - suscripción', provider: 'mercadopago' }
]

function toDateInputValue(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10)
  return date.toISOString().slice(0, 10)
}

function getTodayInputValue() {
  return new Date().toISOString().slice(0, 10)
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
    status: 'active',
    paymentMethod: 'stripe_saved_card',
    paymentProvider: 'stripe'
  }
}

function getPaymentMethodForProvider(provider: PaymentGatewayProvider) {
  if (provider === 'mercadopago') return 'mercadopago_subscription'
  if (provider === 'conekta') return 'conekta_subscription'
  return 'stripe_saved_card'
}

function resolvePaymentProvider(provider?: string | null): PaymentGatewayProvider {
  if (provider === 'mercadopago' || provider === 'conekta' || provider === 'stripe') return provider
  return 'stripe'
}

function getPaymentProviderFromMethod(paymentMethod: string, paymentProvider: PaymentGatewayProvider): PaymentGatewayProvider {
  if (paymentMethod === 'mercadopago_subscription') return 'mercadopago'
  if (paymentMethod === 'conekta_subscription') return 'conekta'
  return paymentProvider
}

function createEmptyFormForProvider(provider: PaymentGatewayProvider | null): SubscriptionFormState {
  const form = createEmptyForm()
  if (provider === 'conekta') {
    return {
      ...form,
      paymentMethod: getPaymentMethodForProvider(provider),
      paymentProvider: 'conekta'
    }
  }
  if (provider === 'mercadopago') {
    return {
      ...form,
      status: 'incomplete',
      paymentMethod: getPaymentMethodForProvider(provider),
      paymentProvider: 'mercadopago'
    }
  }
  return form
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
  const { showToast, showConfirm } = useNotification()
  const [accountCurrency] = useAccountCurrency()
  const [subscriptions, setSubscriptions] = useState<PaymentSubscription[]>([])
  const [summary, setSummary] = useState<SubscriptionSummary>(EMPTY_SUMMARY)
  const [statusFilter, setStatusFilter] = useState('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
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

  const gatewayOptions = useMemo(() => (
    ([
      { provider: 'stripe' as const, connected: stripeConnected },
      { provider: 'conekta' as const, connected: conektaConnected },
      { provider: 'mercadopago' as const, connected: mercadoPagoConnected }
    ]).filter((option) => option.connected)
  ), [conektaConnected, mercadoPagoConnected, stripeConnected])

  const defaultProvider = stripeConnected ? 'stripe' : conektaConnected ? 'conekta' : mercadoPagoConnected ? 'mercadopago' : null
  const hasSubscriptionGateway = Boolean(defaultProvider)
  const showGatewayStep = formMode === 'create' && formStep === 'gateway'
  const isMercadoPagoSelected = (formMode === 'edit' || showGatewayStep) && (form.paymentProvider === 'mercadopago' || form.paymentMethod === 'mercadopago_subscription')
  const isConektaSelected = (formMode === 'edit' || showGatewayStep) && (form.paymentProvider === 'conekta' || form.paymentMethod === 'conekta_subscription')

  useEffect(() => {
    if (integrationsLoading || hasSubscriptionGateway) return

    showToast('warning', 'Suscripciones no disponibles', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones automáticas.')
    navigate('/transactions', { replace: true })
  }, [hasSubscriptionGateway, integrationsLoading, navigate, showToast])

  const filteredSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => matchesStatusFilter(subscription, statusFilter)),
    [statusFilter, subscriptions]
  )

  const openCreateSubscription = () => {
    if (!hasSubscriptionGateway) {
      showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o Mercado Pago para crear suscripciones automáticas.')
      return
    }

    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyForm())
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
      status: (subscription.status as SubscriptionStatus) || 'active',
      paymentMethod: subscription.paymentMethod || 'stripe_saved_card',
      paymentProvider: resolvePaymentProvider(subscription.paymentProvider)
    })
    setFormStep('details')
    setFormMode('edit')
  }

  useEffect(() => {
    if (formMode !== 'create') return
    if (formStep !== 'gateway') return
    if (!availablePaymentMethodOptions.length) return
    if (availablePaymentMethodOptions.some((option) => option.value === form.paymentMethod)) return

    const fallback = availablePaymentMethodOptions[0]
    setForm((current) => ({
      ...current,
      paymentMethod: fallback.value,
      paymentProvider: fallback.provider,
      status: fallback.provider === 'mercadopago' ? 'incomplete' : current.status
    }))
  }, [availablePaymentMethodOptions, form.paymentMethod, formMode, formStep])

  const closeForm = () => {
    if (saving) return

    setFormMode(null)
    setFormStep('details')
    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyForm())
  }

  const patchForm = (field: keyof SubscriptionFormState, value: string) => {
    setForm((current) => ({
      ...current,
      [field]: field === 'startDate' || field === 'nextRunAt'
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

    return true
  }

  const buildPayload = (providerOverride?: PaymentGatewayProvider): SubscriptionPayload | null => {
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

    const provider = providerOverride ?? getPaymentProviderFromMethod(form.paymentMethod, form.paymentProvider)
    const paymentMethod = formMode === 'edit'
      ? form.paymentMethod
      : getPaymentMethodForProvider(provider)
    const contactEmail = selectedContact?.email || editingSubscription?.contactEmail || null
    const contactId = selectedContact?.id || editingSubscription?.contactId || null

    if (provider === 'mercadopago' && !contactEmail) {
      showToast('warning', 'Falta el email', 'Mercado Pago necesita email para que el cliente autorice la suscripción.')
      return null
    }

    if ((provider === 'stripe' || provider === 'conekta') && !contactId) {
      showToast('warning', 'Falta el contacto', `${provider === 'conekta' ? 'Conekta' : 'Stripe'} necesita un contacto con tarjeta guardada para activar la suscripción.`)
      return null
    }

    if (provider === 'conekta' && form.intervalType === 'daily') {
      showToast('warning', 'Frecuencia no soportada', 'Conekta no acepta suscripciones diarias. Usa semanal, mensual o anual.')
      return null
    }

    if (isDateBeforeToday(form.startDate) || (provider !== 'mercadopago' && isDateBeforeToday(form.nextRunAt))) {
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
      status: provider === 'mercadopago' && formMode !== 'edit' ? 'incomplete' : form.status,
      amount,
      currency: accountCurrency,
      intervalType: form.intervalType,
      intervalCount,
      startDate: form.startDate || null,
      nextRunAt: provider === 'mercadopago' ? null : form.nextRunAt || null,
      paymentMethod,
      paymentProvider: provider,
      conektaPaymentSourceId: provider === 'conekta' ? editingSubscription?.conektaPaymentSourceId || null : undefined,
      source: editingSubscription?.source || 'ristak'
    }
  }

  const saveSubscription = async () => {
    if (formMode === 'create' && formStep === 'details' && gatewayOptions.length > 1) {
      if (!validateSubscriptionDetails()) return
      const nextForm = createEmptyFormForProvider(defaultProvider)
      setForm({
        ...nextForm,
        name: form.name,
        description: form.description,
        amount: form.amount,
        intervalType: form.intervalType,
        intervalCount: form.intervalCount,
        startDate: form.startDate,
        nextRunAt: form.nextRunAt,
        status: form.status
      })
      setFormStep('gateway')
      return
    }

    const provider = formMode === 'create'
      ? (formStep === 'gateway' ? form.paymentProvider : defaultProvider || undefined)
      : undefined
    const payload = buildPayload(provider)
    if (!payload) return

    setSaving(true)
    try {
      if (formMode === 'edit' && editingSubscription) {
        await subscriptionsService.updateSubscription(editingSubscription.id, payload)
        showToast('success', 'Suscripción actualizada', `${payload.name} ya quedó lista.`)
      } else {
        const created = await subscriptionsService.createSubscription(payload)
        if (created.paymentProvider === 'mercadopago' && getMercadoPagoSubscriptionLink(created)) {
          showToast('success', 'Autorización Mercado Pago lista', `Copia el link de ${payload.name} para que el cliente active la suscripción.`)
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

  const handleDelete = (subscription: PaymentSubscription) => {
    showConfirm(
      'Eliminar suscripción',
      // (PAY-001) Eliminar ahora CANCELA el cobro recurrente en la pasarela (Stripe/
      // MercadoPago/Conekta): el mensaje debe dejarlo claro para no sorprender al usuario.
      `Se cancelará el cobro recurrente de "${subscription.name}" en la pasarela de pago y el cliente dejará de ser cobrado. Los pagos ya registrados se conservan. Esta acción no se puede deshacer.`,
      async () => {
        setActingId(subscription.id)
        try {
          await subscriptionsService.deleteSubscription(subscription.id)
          setSubscriptions((current) => current.filter((item) => item.id !== subscription.id))
          showToast('success', 'Suscripción eliminada', `${subscription.name} ya no aparece en la lista.`)
        } catch (error) {
          showToast('error', 'No se eliminó la suscripción', error instanceof Error ? error.message : 'Intenta otra vez.')
          return false
        } finally {
          setActingId(null)
        }
      },
      'Eliminar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ELIMINAR' }
    )
  }

  const copyMercadoPagoAuthorizationLink = async (subscription: PaymentSubscription) => {
    const link = getMercadoPagoSubscriptionLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'Mercado Pago todavía no devolvió un link de autorización para esta suscripción.')
      return
    }

    await navigator.clipboard.writeText(link)
    showToast('success', 'Link copiado', 'Ya puedes enviarlo al cliente para autorizar la suscripción.')
  }

  const openMercadoPagoAuthorizationLink = (subscription: PaymentSubscription) => {
    const link = getMercadoPagoSubscriptionLink(subscription)
    if (!link) {
      showToast('warning', 'Link no disponible', 'Mercado Pago todavía no devolvió un link de autorización para esta suscripción.')
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
        const canPause = status === 'active' || status === 'trialing'
        const canActivate = (status === 'paused' || status === 'draft' || status === 'past_due' || status === 'incomplete') && !(isMercadoPago && status === 'incomplete')
        const canCancel = status !== 'cancelled'
        const mercadoPagoAuthorizationLink = getMercadoPagoSubscriptionLink(item)

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
                {mercadoPagoAuthorizationLink && (
                  <>
                    <DropdownMenuItem disabled={busy} onClick={() => void copyMercadoPagoAuthorizationLink(item)}>
                      <Copy size={16} />
                      <span>Copiar autorización</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={busy} onClick={() => openMercadoPagoAuthorizationLink(item)}>
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
          />
        </Card>

        <Modal
          isOpen={formMode !== null}
          onClose={closeForm}
          title={formMode === 'edit' ? 'Editar suscripción' : showGatewayStep ? 'Elige pasarela' : 'Nueva suscripción'}
          size="md"
          type="custom"
        >
          <form className={styles.form} onSubmit={(event) => {
            event.preventDefault()
            void saveSubscription()
          }}>
            {showGatewayStep ? (
              <div className={styles.gatewayPicker}>
                {gatewayOptions.map((option) => {
                  const active = form.paymentProvider === option.provider
                  return (
                    <button
                      key={option.provider}
                      type="button"
                      className={`${styles.gatewayOption} ${active ? styles.gatewayOptionActive : ''}`}
                      onClick={() => {
                        setForm((current) => ({
                          ...current,
                          paymentMethod: getPaymentMethodForProvider(option.provider),
                          paymentProvider: option.provider,
                          status: option.provider === 'mercadopago' ? 'incomplete' : current.status === 'incomplete' ? 'active' : current.status
                        }))
                      }}
                    >
                      <span className={styles.gatewayOptionLogo}>
                        <PaymentPlatformLogo platform={option.provider} size="md" decorative />
                      </span>
                      <span>
                        <strong>{option.provider === 'mercadopago' ? 'Mercado Pago' : option.provider === 'conekta' ? 'Conekta' : 'Stripe'}</strong>
                        <small>
                          {option.provider === 'mercadopago'
                            ? 'Crea un enlace de autorización para activar la suscripción.'
                            : option.provider === 'conekta'
                              ? 'Usa domiciliación con la tarjeta guardada del contacto.'
                              : 'Usa la tarjeta guardada del contacto para activar cobros recurrentes.'}
                        </small>
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

              <div className={styles.formGroup}>
                <label>Nombre</label>
                <input
                  value={form.name}
                  onChange={(event) => patchForm('name', event.target.value)}
                  placeholder="Mensualidad, membresía, soporte..."
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label>Estado</label>
                <CustomSelect
                  value={form.status}
                  onChange={(event) => patchForm('status', event.target.value)}
                  disabled={isMercadoPagoSelected && formMode === 'create'}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>

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
                <div className={styles.currencyNote}>
                  <span>Moneda de cuenta</span>
                  <strong>{accountCurrency}</strong>
                </div>
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
                <label>Cada</label>
                <NumberInput
                  value={form.intervalCount}
                  onChange={(event) => patchForm('intervalCount', event.target.value)}
                  min="1"
                  step="1"
                  required
                />
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
                      paymentMethod: event.target.value,
                      paymentProvider: option?.provider || 'stripe',
                      status: current.status
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
                  : 'Para cobros automáticos con Stripe, el contacto debe tener una tarjeta guardada. Ristak usará la tarjeta predeterminada del contacto y guardará los datos técnicos por debajo.'}
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
                {formMode === 'edit' ? 'Guardar suscripción' : 'Crear enlace de pago'}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </PageContainer>
  )
}
