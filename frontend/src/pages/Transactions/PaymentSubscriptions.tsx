import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CalendarClock,
  CreditCard,
  Edit3,
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
  Table
} from '@/components/common'
import type { BadgeVariant, Column } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { useAccountCurrency } from '@/hooks'
import type { Contact } from '@/types'
import { formatCurrency, formatDate } from '@/utils/format'
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
  paymentProvider: string
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

const PAYMENT_METHOD_OPTIONS = [
  { value: 'stripe_saved_card', label: 'Stripe - tarjeta guardada' },
  { value: 'stripe_link', label: 'Stripe - enlace de pago' },
  { value: 'manual', label: 'Manual / offline' }
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
  if (normalized === 'manual') return 'Manual'
  return value || 'Sin método'
}

function getSourceLabel(subscription: PaymentSubscription) {
  if (subscription.stripeSubscriptionId || subscription.paymentProvider === 'stripe') return 'Stripe'
  if (subscription.source === 'ghl') return 'HighLevel'
  return 'Ristak'
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
  const [editingSubscription, setEditingSubscription] = useState<PaymentSubscription | null>(null)
  const [selectedContact, setSelectedContact] = useState<Contact | null>(null)
  const [form, setForm] = useState<SubscriptionFormState>(() => createEmptyForm())

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

  const filteredSubscriptions = useMemo(
    () => subscriptions.filter((subscription) => matchesStatusFilter(subscription, statusFilter)),
    [statusFilter, subscriptions]
  )

  const openCreateSubscription = () => {
    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyForm())
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
      startDate: toDateInputValue(subscription.startDate) || getTodayInputValue(),
      nextRunAt: toDateInputValue(subscription.nextRunAt) || getTodayInputValue(),
      status: (subscription.status as SubscriptionStatus) || 'active',
      paymentMethod: subscription.paymentMethod || 'stripe_saved_card',
      paymentProvider: subscription.paymentProvider || 'stripe'
    })
    setFormMode('edit')
  }

  const closeForm = () => {
    if (saving) return

    setFormMode(null)
    setEditingSubscription(null)
    setSelectedContact(null)
    setForm(createEmptyForm())
  }

  const patchForm = (field: keyof SubscriptionFormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
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

    return {
      contactId: selectedContact?.id || null,
      contactName: selectedContact?.name || editingSubscription?.contactName || null,
      contactEmail: selectedContact?.email || editingSubscription?.contactEmail || null,
      contactPhone: selectedContact?.phone || editingSubscription?.contactPhone || null,
      name,
      description: form.description.trim(),
      status: form.status,
      amount,
      currency: accountCurrency,
      intervalType: form.intervalType,
      intervalCount,
      startDate: form.startDate || null,
      nextRunAt: form.nextRunAt || null,
      paymentMethod: form.paymentMethod,
      paymentProvider: form.paymentProvider,
      source: editingSubscription?.source || 'ristak'
    }
  }

  const saveSubscription = async () => {
    const payload = buildPayload()
    if (!payload) return

    setSaving(true)
    try {
      if (formMode === 'edit' && editingSubscription) {
        await subscriptionsService.updateSubscription(editingSubscription.id, payload)
        showToast('success', 'Suscripción actualizada', `${payload.name} ya quedó lista.`)
      } else {
        await subscriptionsService.createSubscription(payload)
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

  const handleDelete = (subscription: PaymentSubscription) => {
    showConfirm(
      'Eliminar suscripción',
      `Se quitará "${subscription.name}" de la lista. Los pagos ya registrados no se borran.`,
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
      searchValue: (_value, item) => [item.name, item.description, item.stripeSubscriptionId],
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
      render: (_value, item) => (
        <div className={styles.methodStack}>
          <strong>{getPaymentMethodLabel(item.paymentMethod)}</strong>
          <span className={styles.secondaryLine}>{getSourceLabel(item)}</span>
        </div>
      ),
      searchValue: (_value, item) => [item.paymentMethod, item.paymentProvider, item.source, item.stripeCustomerId],
      sortable: true
    },
    {
      key: 'actions',
      header: 'Acciones',
      render: (_value, item) => {
        const busy = actingId === item.id
        const status = String(item.status || '').toLowerCase()
        const canPause = status === 'active' || status === 'trialing'
        const canActivate = status === 'paused' || status === 'draft' || status === 'past_due' || status === 'incomplete'
        const canCancel = status !== 'cancelled'

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
                variant="secondary"
                onClick={() => void loadSubscriptions({ refresh: true })}
                disabled={refreshing}
                leftIcon={<RefreshCw size={16} className={refreshing ? styles.spin : undefined} />}
              >
                {refreshing ? 'Actualizando...' : 'Actualizar'}
              </Button>
              <Button onClick={openCreateSubscription} leftIcon={<Plus size={16} />}>
                Nueva suscripción
              </Button>
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
          title={formMode === 'edit' ? 'Editar suscripción' : 'Nueva suscripción'}
          size="md"
          type="custom"
        >
          <form className={styles.form} onSubmit={(event) => {
            event.preventDefault()
            void saveSubscription()
          }}>
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
                />
              </div>

              <div className={styles.formGroup}>
                <label>Próximo cobro</label>
                <input
                  value={form.nextRunAt}
                  onChange={(event) => patchForm('nextRunAt', event.target.value)}
                  type="date"
                />
              </div>

              <div className={styles.formGroup}>
                <label>Método de cobro</label>
                <CustomSelect
                  value={form.paymentMethod}
                  onChange={(event) => {
                    patchForm('paymentMethod', event.target.value)
                    patchForm('paymentProvider', event.target.value === 'manual' ? 'manual' : 'stripe')
                  }}
                >
                  {PAYMENT_METHOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </CustomSelect>
              </div>

              <p className={`${styles.formHint} ${styles.fullWidth}`}>
                Para cobros automáticos con Stripe, el contacto debe tener una tarjeta guardada. Ristak usará la tarjeta predeterminada del contacto y guardará los datos técnicos por debajo.
              </p>
            </div>

            <div className={styles.footerActions}>
              <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>
                Cancelar
              </Button>
              <Button type="submit" loading={saving}>
                {formMode === 'edit' ? 'Guardar suscripción' : 'Crear suscripción'}
              </Button>
            </div>
          </form>
        </Modal>
      </div>
    </PageContainer>
  )
}
