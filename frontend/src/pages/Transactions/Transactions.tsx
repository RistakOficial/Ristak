import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { KpiCard, Card, Button, Table, TableSelectionToolbar, DateRangePicker, ContactSearchInput, PageContainer, PageHeader, TabList, TreeFilter, RecordPaymentModal, Badge, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, Loading, NumberInput, CustomSelect, Modal, PaymentPlatformLogo } from '@/components/common'
import type { Column, PaymentPlatformLogoId } from '@/components/common'
import { useNotification } from '@/contexts/NotificationContext'
import { Contact } from '@/types'
import {
  Plus,
  Edit,
  Trash2,
  CreditCard,
  RefreshCw,
  Banknote,
  DollarSign,
  CheckCircle,
  Receipt,
  RotateCcw,
  MoreVertical,
  Clock,
  Eye,
  Link2,
  Send,
  Mail,
  MessageCircle,
  Settings,
  PauseCircle,
  PlayCircle,
  Ban,
  X,
  Loader2,
  Copy,
  ExternalLink
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAccountCurrency, useHighLevelConnected, useUrlDateRangeSync, useUrlFilterState } from '@/hooks'
import { formatCurrency, formatDateToISO, formatEndDateToISO, formatNumber, parseLocalDateString, formatName } from '@/utils/format'
import { buildPaymentTimestamp } from '@/utils/paymentDate'
import { transactionsService, type Transaction, type TransactionSummary, type PaymentPlan } from '@/services/transactionsService'
import { highLevelService } from '@/services/highLevelService'
import { getIntegrationsStatus } from '@/services/integrationsService'
import {
  getTransactionStatusBadge,
  getPaymentPlanStatusBadge,
  TRANSACTION_STATUS_BADGES,
  PAYMENT_PLAN_STATUS_BADGES
} from '@/utils/statusBadges'
import type { BadgeVariant } from '@/components/common/Badge'
import styles from './Transactions.module.css'


interface ModalData {
  type: 'create' | 'edit' | null
  transaction?: Transaction
  selectedContact?: Contact | null
}

type PaymentsTableTab = 'transactions' | 'payment-plans'
type TransactionsViewMode = 'all' | 'by-date'
type StatusFilters = Record<string, string[]>
type PaymentPlanAction = 'activate' | 'pause' | 'cancel' | 'delete' | 'change_card'

interface PaymentPlanModalData {
  plan: PaymentPlan | null
  loading: boolean
  saving: boolean
}

interface StripeCardSetupLinkModalData {
  open: boolean
  link: string
  planName: string
  contactName: string
  amount: number
}

interface PaymentPlanCreateModalData {
  open: boolean
  selectedContact: Contact | null
  saving: boolean
  scheduleMode: 'recurring' | 'one_time'
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'
  endType: 'never' | 'count' | 'by'
  monthlyMode: 'dayOfMonth' | 'weekOfMonth'
}

interface StripePlanPaymentDraft {
  localId: string
  id?: string
  label: string
  amount: string
  dueDate: string
  method: string
  status: string
  paymentId?: string | null
  locked?: boolean
}

interface TransactionsRouteState {
  tab: PaymentsTableTab
  viewMode: TransactionsViewMode
  transactionId: string
  paymentPlanId: string
  createTransaction: boolean
  createPaymentPlan: boolean
}

const transactionViewModes: TransactionsViewMode[] = ['all', 'by-date']
const isTransactionsViewMode = (value?: string): value is TransactionsViewMode => transactionViewModes.includes(value as TransactionsViewMode)

const parseTransactionsRoute = (pathname: string): TransactionsRouteState => {
  const segments = pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
  const transactionsIndex = segments.indexOf('transactions')
  const routeSegments = transactionsIndex >= 0 ? segments.slice(transactionsIndex + 1) : []
  const first = routeSegments[0]

  if (first === 'payment-plans') {
    return {
      tab: 'payment-plans',
      viewMode: 'all',
      transactionId: '',
      paymentPlanId: routeSegments[1] && routeSegments[1] !== 'new' ? decodeURIComponent(routeSegments[1]) : '',
      createTransaction: false,
      createPaymentPlan: routeSegments[1] === 'new'
    }
  }

  if (first === 'new') {
    return {
      tab: 'transactions',
      viewMode: 'all',
      transactionId: '',
      paymentPlanId: '',
      createTransaction: true,
      createPaymentPlan: false
    }
  }

  const viewMode = isTransactionsViewMode(routeSegments[1]) ? routeSegments[1] : isTransactionsViewMode(first) ? first : 'all'
  const detailIndex = routeSegments[0] === 'transactions' ? 2 : 1
  const detail = routeSegments[detailIndex]

  return {
    tab: 'transactions',
    viewMode,
    transactionId: detail && detail !== 'new' ? decodeURIComponent(detail) : '',
    paymentPlanId: '',
    createTransaction: detail === 'new',
    createPaymentPlan: false
  }
}

const buildTransactionsPath = (viewMode: TransactionsViewMode) => `/transactions/transactions/${viewMode}`
const buildCreateTransactionPath = (viewMode: TransactionsViewMode) => `${buildTransactionsPath(viewMode)}/new`
const buildTransactionDetailPath = (viewMode: TransactionsViewMode, transactionId: string) =>
  `${buildTransactionsPath(viewMode)}/${encodeURIComponent(transactionId)}`
const buildPaymentPlansPath = () => '/transactions/payment-plans'
const buildPaymentPlanDetailPath = (planId: string) => `${buildPaymentPlansPath()}/${encodeURIComponent(planId)}`
const isStripePaymentPlan = (plan: PaymentPlan) => plan.source === 'stripe' || plan.raw?.provider === 'stripe'
const isConektaPaymentPlan = (plan: PaymentPlan) => plan.source === 'conekta' || plan.raw?.provider === 'conekta' || plan.raw?.schedule?.provider === 'conekta'
const isMercadoPagoPaymentPlan = (plan: PaymentPlan) => plan.source === 'mercadopago' || plan.raw?.provider === 'mercadopago' || plan.raw?.schedule?.provider === 'mercadopago'
const isLocalCheckoutPaymentPlan = (plan: PaymentPlan) => isStripePaymentPlan(plan) || isConektaPaymentPlan(plan) || isMercadoPagoPaymentPlan(plan)
type LocalCheckoutPlanProvider = 'stripe' | 'conekta' | 'mercadopago'
const getLocalCheckoutPlanProvider = (plan: PaymentPlan | null): LocalCheckoutPlanProvider => (
  plan && isMercadoPagoPaymentPlan(plan) ? 'mercadopago' : plan && isConektaPaymentPlan(plan) ? 'conekta' : 'stripe'
)
const getPaymentPlanProviderLabel = (plan: PaymentPlan) => {
  if (isMercadoPagoPaymentPlan(plan)) return 'Mercado Pago'
  if (isConektaPaymentPlan(plan)) return 'Conekta'
  if (isStripePaymentPlan(plan)) return 'Stripe'
  return 'HighLevel'
}
const STRIPE_PLAN_LOCKED_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'refunded', 'void', 'deleted', 'cancelled', 'canceled', 'registered'])
const STRIPE_PLAN_PAYMENT_METHOD_OPTIONS = [
  { value: 'stripe_auto', label: 'Tarjeta automática' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'deposit', label: 'Depósito' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' }
]
const MERCADOPAGO_PLAN_PAYMENT_METHOD_OPTIONS = [
  { value: 'mercadopago', label: 'Checkout Pro' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'deposit', label: 'Depósito' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' }
]
const CONEKTA_PLAN_PAYMENT_METHOD_OPTIONS = [
  { value: 'conekta_auto', label: 'Tarjeta automática' },
  { value: 'bank_transfer', label: 'Transferencia' },
  { value: 'cash', label: 'Efectivo' },
  { value: 'deposit', label: 'Depósito' },
  { value: 'check', label: 'Cheque' },
  { value: 'other', label: 'Otro' }
]
const OFFLINE_PLAN_PAYMENT_METHODS = new Set(['cash', 'bank_transfer', 'transfer', 'deposit', 'check', 'other', 'manual', 'offline'])
const STRIPE_PLAN_FREQUENCY_OPTIONS = [
  { value: 'custom', label: 'Personalizada' },
  { value: 'daily', label: 'Diaria' },
  { value: 'weekly', label: 'Semanal' },
  { value: 'monthly', label: 'Mensual' },
  { value: 'yearly', label: 'Anual' }
]

const toDateInputValue = (value?: string | null): string => {
  if (!value) return formatDateToISO(new Date())
  return String(value).split('T')[0]
}

const getTodayInputValue = () => formatDateToISO(new Date())

const isDateBeforeToday = (value?: string | null) => Boolean(value && value < getTodayInputValue())

const clampDateToToday = (value?: string | null) => {
  const today = getTodayInputValue()
  return value && value >= today ? value : today
}

const toDateTimeInputValue = (value?: string | null): string => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

const getPlanPayload = (plan: PaymentPlan): Record<string, any> => {
  return plan.raw && typeof plan.raw === 'object' ? plan.raw : { ...plan }
}

const getPlanTermsNotes = (plan: PaymentPlan | null): string => {
  const payload = plan ? getPlanPayload(plan) : {}
  return String(payload.termsNotes || payload.terms || payload.notes || '')
}

const getStripePlanSchedulePayload = (plan: PaymentPlan | null): Record<string, any> => {
  const raw = plan?.raw && typeof plan.raw === 'object' ? plan.raw : {}
  const schedule = raw.schedule && typeof raw.schedule === 'object' ? raw.schedule : {}
  return schedule
}

const getStripePlanCardSetupPaymentLink = (plan: PaymentPlan | null): string => {
  const raw = plan?.raw && typeof plan.raw === 'object' ? plan.raw : {}
  const schedule = getStripePlanSchedulePayload(plan)
  const paymentFlow = raw.paymentFlow && typeof raw.paymentFlow === 'object' ? raw.paymentFlow : {}
  const response = raw.response && typeof raw.response === 'object' ? raw.response : {}
  return String(schedule.cardSetupPaymentLink || paymentFlow.cardSetupPaymentLink || response.cardSetupLink || '').trim()
}

const getEditableStripeMethod = (method?: string | null) => {
  const normalized = String(method || '').toLowerCase()
  if (!normalized || normalized.startsWith('stripe') || ['card', 'payment_link', 'direct_card', 'saved_card'].includes(normalized)) {
    return 'stripe_auto'
  }
  if (normalized === 'transfer') return 'bank_transfer'
  return normalized
}

const getEditableMercadoPagoMethod = (method?: string | null) => {
  const normalized = String(method || '').toLowerCase()
  if (!normalized || normalized.startsWith('mercadopago') || ['card', 'payment_link', 'checkout', 'auto'].includes(normalized)) {
    return 'mercadopago'
  }
  if (normalized === 'transfer') return 'bank_transfer'
  return normalized
}

const getEditableConektaMethod = (method?: string | null) => {
  const normalized = String(method || '').toLowerCase()
  if (!normalized || normalized.startsWith('conekta') || ['card', 'payment_link', 'direct_card', 'saved_card'].includes(normalized)) {
    return 'conekta_auto'
  }
  if (normalized === 'transfer') return 'bank_transfer'
  return normalized
}

const getEditablePlanMethod = (method: string | null | undefined, provider: LocalCheckoutPlanProvider) => {
  if (provider === 'mercadopago') return getEditableMercadoPagoMethod(method)
  if (provider === 'conekta') return getEditableConektaMethod(method)
  return getEditableStripeMethod(method)
}

const getPlanMethodOptions = (provider: LocalCheckoutPlanProvider) => {
  if (provider === 'mercadopago') return MERCADOPAGO_PLAN_PAYMENT_METHOD_OPTIONS
  if (provider === 'conekta') return CONEKTA_PLAN_PAYMENT_METHOD_OPTIONS
  return STRIPE_PLAN_PAYMENT_METHOD_OPTIONS
}

const getDefaultPlanMethod = (provider: LocalCheckoutPlanProvider) => {
  if (provider === 'mercadopago') return 'mercadopago'
  if (provider === 'conekta') return 'conekta_auto'
  return 'stripe_auto'
}

const getStripePlanMethodLabel = (method?: string | null, provider: LocalCheckoutPlanProvider = 'stripe') => {
  const normalized = getEditablePlanMethod(method, provider)
  return getPlanMethodOptions(provider).find(option => option.value === normalized)?.label || normalized
}

const isOfflinePlanPaymentMethod = (method?: string | null) => OFFLINE_PLAN_PAYMENT_METHODS.has(String(method || '').toLowerCase())

const getEditablePlanDate = (value: string | null | undefined, method: string | null | undefined, locked?: boolean) => {
  const date = toDateInputValue(value)
  return locked || isOfflinePlanPaymentMethod(method) ? date : clampDateToToday(date)
}

const createStripePlanDraftId = () => `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const isStripePlanPaymentLocked = (status?: string | null) => STRIPE_PLAN_LOCKED_STATUSES.has(String(status || '').toLowerCase())

const getStripePlanPaymentStatusBadgeConfig = (status?: string | null): { label: string; variant: BadgeVariant } => {
  const normalized = String(status || '').toLowerCase()
  if (['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'registered', 'authorized', 'card_authorized'].includes(normalized)) {
    return { label: 'Pagado', variant: 'success' }
  }
  if (normalized === 'scheduled') return { label: 'Programado', variant: 'info' }
  if (['waiting_card_authorization', 'pending_card', 'pending_card_authorization', 'link_generated', 'sent'].includes(normalized)) {
    return { label: 'Pendiente de tarjeta', variant: 'warning' }
  }
  if (['pending', 'draft', 'sent'].includes(normalized)) return { label: 'Pendiente', variant: 'warning' }
  if (['failed', 'requires_action', 'overdue'].includes(normalized)) return { label: 'Revisar', variant: 'error' }
  if (['cancelled', 'canceled', 'void', 'deleted'].includes(normalized)) return { label: 'Cancelado', variant: 'neutral' }
  return { label: normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : 'Pendiente', variant: 'neutral' }
}

const getNextPlanDueDate = (installments: StripePlanPaymentDraft[], fallback?: string | null) => {
  const lastDate = [...installments].reverse().find(item => item.dueDate)?.dueDate || fallback || formatDateToISO(new Date())
  const date = parseLocalDateString(lastDate)
  date.setMonth(date.getMonth() + 1)
  return formatDateToISO(date)
}

const normalizeDraftAmount = (value?: number | string | null) => {
  const amount = Number(value || 0)
  return Number.isFinite(amount) && amount > 0 ? String(Math.round(amount * 100) / 100) : ''
}

const getDefaultScheduleTime = () => '09:00'

const normalizeScheduleTime = (value: string) => {
  const time = value || getDefaultScheduleTime()
  return time.length === 5 ? `${time}:00` : time
}

const WEEKDAY_OPTIONS = [
  { value: 'mo', label: 'Lunes' },
  { value: 'tu', label: 'Martes' },
  { value: 'we', label: 'Miércoles' },
  { value: 'th', label: 'Jueves' },
  { value: 'fr', label: 'Viernes' },
  { value: 'sa', label: 'Sábado' },
  { value: 'su', label: 'Domingo' }
]

const MONTH_OPTIONS = [
  { value: 'jan', label: 'Enero' },
  { value: 'feb', label: 'Febrero' },
  { value: 'mar', label: 'Marzo' },
  { value: 'apr', label: 'Abril' },
  { value: 'may', label: 'Mayo' },
  { value: 'jun', label: 'Junio' },
  { value: 'jul', label: 'Julio' },
  { value: 'aug', label: 'Agosto' },
  { value: 'sep', label: 'Septiembre' },
  { value: 'oct', label: 'Octubre' },
  { value: 'nov', label: 'Noviembre' },
  { value: 'dec', label: 'Diciembre' }
]

const TRANSACTION_STATUS_ORDER = [
  'draft',
  'sent',
  'pending',
  'paid',
  'partial',
  'overdue',
  'void',
  'refunded',
  'failed',
  'deleted'
]

const REFUNDABLE_TRANSACTION_STATUSES = ['paid']
const VOIDABLE_HIGHLEVEL_TRANSACTION_STATUSES = new Set(['draft', 'sent', 'pending', 'overdue', 'partial'])

const PAYMENT_PLAN_STATUS_ORDER = [
  'active',
  'scheduled',
  'pending',
  'sent',
  'draft',
  'paused',
  'cancelled',
  'completed',
  'failed',
  'deleted'
]

const PAYMENT_PLAN_PAID_STATUSES = new Set(['paid', 'succeeded', 'completed', 'complete', 'fulfilled', 'success', 'registered'])
const PAYMENT_PLAN_IGNORED_PAYMENT_STATUSES = new Set(['cancelled', 'canceled', 'deleted', 'void'])
const PAYMENT_PLAN_FINAL_STATUSES = new Set(['paid', 'completed', 'complete', 'finished', 'finalized', 'finalizado'])
const PAYMENT_PLAN_EMPTY_NEXT_DATE_STATUSES = new Set(['completed', 'cancelled', 'deleted', 'inactive'])

const isHighLevelTransaction = (transaction: Transaction) => {
  const provider = String(transaction.paymentProvider || '').toLowerCase()
  const method = String(transaction.method || '').toLowerCase()

  return Boolean(
    transaction.invoiceId ||
    provider === 'highlevel' ||
    provider === 'gohighlevel' ||
    provider === 'ghl' ||
    method.startsWith('highlevel') ||
    method.startsWith('ghl')
  )
}

const canVoidHighLevelTransaction = (transaction: Transaction) => (
  isHighLevelTransaction(transaction) &&
  VOIDABLE_HIGHLEVEL_TRANSACTION_STATUSES.has(String(transaction.status || '').toLowerCase())
)

const getDayOfWeekCode = (date: Date) => {
  const codes = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa']
  return codes[date.getDay()]
}

const getMonthOfYearCode = (date: Date) => {
  const codes = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  return codes[date.getMonth()]
}

const isLastDayOfMonth = (date: Date) => {
  return date.getDate() === new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

interface PaymentPlanProgress {
  known: boolean
  completed: number
  total: number
  remaining: number
}

const getObjectValue = (value: unknown): Record<string, any> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
)

const getFirstArray = (...values: unknown[]) => {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) return value
  }
  return []
}

const getPositiveNumber = (...values: unknown[]) => {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return 0
}

const getPaymentRowStatus = (row: Record<string, any>) => (
  String(row.status || row.paymentStatus || row.state || '').toLowerCase()
)

const getPaymentPlanProgress = (plan: PaymentPlan): PaymentPlanProgress => {
  const raw = getObjectValue(plan.raw)
  const schedule = getObjectValue(raw.schedule)
  const response = getObjectValue(raw.response)
  const firstPayment = getObjectValue(schedule.firstPayment || raw.firstPayment)
  const rows: Record<string, any>[] = []

  if (Object.keys(firstPayment).length > 0) {
    const firstPaymentAmount = getPositiveNumber(firstPayment.amount, firstPayment.total, firstPayment.value)
    if (firstPaymentAmount > 0 || firstPayment.status || firstPayment.paymentId) {
      rows.push(firstPayment)
    }
  }

  rows.push(...getFirstArray(
    schedule.installments,
    raw.installments,
    schedule.scheduledPayments,
    raw.scheduledPayments,
    response.scheduledPayments
  ).filter((row): row is Record<string, any> => Boolean(row && typeof row === 'object' && !Array.isArray(row))))

  const visibleRows = rows.filter((row) => !PAYMENT_PLAN_IGNORED_PAYMENT_STATUSES.has(getPaymentRowStatus(row)))

  if (visibleRows.length > 0) {
    const completed = visibleRows.filter((row) => PAYMENT_PLAN_PAID_STATUSES.has(getPaymentRowStatus(row))).length
    const total = visibleRows.length
    return {
      known: true,
      completed,
      total,
      remaining: Math.max(total - completed, 0)
    }
  }

  const recurrence = getObjectValue(schedule.rrule || schedule.recurrence || raw.rrule || raw.recurrence)
  const fallbackTotal = getPositiveNumber(recurrence.count, schedule.count, raw.count)
  if (fallbackTotal > 0) {
    const status = String(plan.status || '').toLowerCase()
    const completed = ['completed', 'complete'].includes(status) ? fallbackTotal : 0
    return {
      known: true,
      completed,
      total: fallbackTotal,
      remaining: Math.max(fallbackTotal - completed, 0)
    }
  }

  return { known: false, completed: 0, total: 0, remaining: 0 }
}

const renderDateHeader = (subtitle: string) => (
  <>
    <span>Fecha</span>
    <br />
    <small>{subtitle}</small>
  </>
)

interface PaymentPlanScheduleOptions {
  scheduleMode: 'recurring' | 'one_time'
  startDate: string
  startTime: string
  frequency: string
  interval: number
  endType: string
  count: number
  endDate: string
  endTime: string
  dayOfWeek: string
  dayOfMonth: string
  numOfWeek: string
  monthOfYear: string
  monthlyMode: string
  daysBefore: number
  useStartAsPrimaryUserAccepted: boolean
}

const buildPaymentPlanSchedule = ({
  scheduleMode,
  startDate,
  startTime,
  frequency,
  interval,
  endType,
  count,
  endDate,
  endTime,
  dayOfWeek,
  dayOfMonth,
  numOfWeek,
  monthOfYear,
  monthlyMode,
  daysBefore,
  useStartAsPrimaryUserAccepted
}: PaymentPlanScheduleOptions) => {
  const localStart = new Date(`${startDate}T${startTime || getDefaultScheduleTime()}`)
  const dateOnly = new Date(`${startDate}T00:00:00`)
  const normalizedInterval = Number.isFinite(interval) && interval > 0 ? interval : 1

  if (scheduleMode === 'one_time') {
    return {
      executeAt: localStart.toISOString()
    }
  }

  const rrule: Record<string, any> = {
    intervalType: frequency,
    interval: normalizedInterval,
    startDate,
    startTime: normalizeScheduleTime(startTime)
  }

  if (endType === 'count') {
    rrule.endType = 'count'
    rrule.count = count
  } else if (endType === 'by') {
    rrule.endType = 'by'
    rrule.endDate = endDate
    if (endTime) rrule.endTime = normalizeScheduleTime(endTime)
  }

  if (daysBefore > 0) {
    rrule.daysBefore = daysBefore
  }

  if (useStartAsPrimaryUserAccepted) {
    rrule.useStartAsPrimaryUserAccepted = true
  }

  if (frequency === 'weekly') {
    rrule.dayOfWeek = dayOfWeek || getDayOfWeekCode(dateOnly)
  }

  if (frequency === 'monthly' || frequency === 'yearly') {
    if (monthlyMode === 'weekOfMonth') {
      rrule.dayOfWeek = dayOfWeek || getDayOfWeekCode(dateOnly)
      rrule.numOfWeek = Number(numOfWeek || 1)
    } else if (dayOfMonth) {
      rrule.dayOfMonth = Number(dayOfMonth)
    } else if (isLastDayOfMonth(dateOnly)) {
      rrule.dayOfMonth = -1
    } else {
      rrule.dayOfMonth = Math.min(dateOnly.getDate(), 28)
    }
  }

  if (frequency === 'yearly') {
    rrule.monthOfYear = monthOfYear || getMonthOfYearCode(dateOnly)
  }

  return {
    executeAt: localStart.toISOString(),
    rrule
  }
}

export const Transactions: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const routeState = useMemo(() => parseTransactionsRoute(location.pathname), [location.pathname])
  const { formatLocalDateShort } = useTimezone()
  const { showConfirm, showToast } = useNotification()
  const [accountCurrency] = useAccountCurrency()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [paymentPlans, setPaymentPlans] = useState<PaymentPlan[]>([])
  const [summary, setSummary] = useState<TransactionSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [paymentPlansLoading, setPaymentPlansLoading] = useState(false)
  const [paymentPlanActionId, setPaymentPlanActionId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [modal, setModal] = useState<ModalData>({ type: null, selectedContact: null })
  const [paymentPlanModal, setPaymentPlanModal] = useState<PaymentPlanModalData>({
    plan: null,
    loading: false,
    saving: false
  })
  const [stripeCardSetupLinkModal, setStripeCardSetupLinkModal] = useState<StripeCardSetupLinkModalData>({
    open: false,
    link: '',
    planName: '',
    contactName: '',
    amount: 0
  })
  const [stripePlanFirstPaymentDraft, setStripePlanFirstPaymentDraft] = useState<StripePlanPaymentDraft | null>(null)
  const [stripePlanInstallmentDrafts, setStripePlanInstallmentDrafts] = useState<StripePlanPaymentDraft[]>([])
  const [paymentPlanCreateModal, setPaymentPlanCreateModal] = useState<PaymentPlanCreateModalData>({
    open: false,
    selectedContact: null,
    saving: false,
    scheduleMode: 'recurring',
    frequency: 'monthly',
    endType: 'never',
    monthlyMode: 'dayOfMonth'
  })
  const [paymentTableTab, setPaymentTableTab] = useState<PaymentsTableTab>(routeState.tab)
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<string[]>([])
  const [selectedPaymentPlanIds, setSelectedPaymentPlanIds] = useState<string[]>([])
  const [transactionsPendingDeletion, setTransactionsPendingDeletion] = useState<Transaction[]>([])
  const [paymentPlansPendingDeletion, setPaymentPlansPendingDeletion] = useState<PaymentPlan[]>([])
  const [deletingTransactions, setDeletingTransactions] = useState(false)
  const [deletingPaymentPlans, setDeletingPaymentPlans] = useState(false)

  // Los planes de pago pertenecen a Ristak y pueden programarse con Stripe, Conekta o HighLevel opcional.
  // Mercado Pago queda disponible para links y suscripciones, no parcialidades.
  // La lista histórica lee planes locales y espejos remotos cuando una integración opcional los sincroniza.
  const { connected: highLevelConnected, loading: highLevelLoading } = useHighLevelConnected()
  const [stripeConnected, setStripeConnected] = useState(false)
  const [conektaConnected, setConektaConnected] = useState(false)
  const [mercadoPagoConnected, setMercadoPagoConnected] = useState(false)
  const [stripeStatusLoading, setStripeStatusLoading] = useState(true)
  const [transactionStatusFilters, setTransactionStatusFilters] = useUrlFilterState('statusFilters')
  const [paymentPlanStatusFilters, setPaymentPlanStatusFilters] = useUrlFilterState('planFilters')
  const [viewMode, setViewMode] = useState<TransactionsViewMode>(routeState.viewMode)
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false)
  const [recordPaymentInitialMode, setRecordPaymentInitialMode] = useState<'single' | 'partial'>('single')
  const [isClient, setIsClient] = useState(false)
  const [hasLoadedTransactions, setHasLoadedTransactions] = useState(false)
  const [transactionSearchTerm, setTransactionSearchTerm] = useState('')
  const [debouncedTransactionSearch, setDebouncedTransactionSearch] = useState('')
  const handledOpenPaymentRef = useRef<string | null>(null)
  const handledOpenPaymentPlanRef = useRef<string | null>(null)
  const paymentPlansUnavailableRedirectedRef = useRef(false)

  const navigateTransactionsPath = useCallback((pathname: string, options?: { replace?: boolean }) => {
    navigate({ pathname, search: location.search }, options)
  }, [location.search, navigate])

  const hydrateStripePlanDraft = useCallback((plan: PaymentPlan | null) => {
    if (!plan || !isLocalCheckoutPaymentPlan(plan)) {
      setStripePlanFirstPaymentDraft(null)
      setStripePlanInstallmentDrafts([])
      return
    }

    const provider = getLocalCheckoutPlanProvider(plan)
    const schedule = getStripePlanSchedulePayload(plan)
    const firstPayment = schedule.firstPayment && typeof schedule.firstPayment === 'object'
      ? schedule.firstPayment
      : null
    const firstAmount = Number(firstPayment?.amount || 0)
    const firstStatus = String(firstPayment?.status || 'pending').toLowerCase()
    const firstMethod = getEditablePlanMethod(firstPayment?.method || firstPayment?.paymentMethod, provider)
    const firstLocked = isStripePlanPaymentLocked(firstStatus) || (provider === 'mercadopago' && Boolean(firstPayment?.paymentLink || firstPayment?.preferenceId))

    setStripePlanFirstPaymentDraft(firstAmount > 0 ? {
      localId: 'stripe_first_payment',
      id: 'stripe_first_payment',
      label: 'Primer pago',
      amount: normalizeDraftAmount(firstAmount),
      dueDate: getEditablePlanDate(firstPayment?.date || firstPayment?.dueDate || plan.startDate, firstMethod, firstLocked),
      method: firstMethod,
      status: firstStatus || 'pending',
      paymentId: firstPayment?.paymentId || null,
      locked: firstLocked
    } : null)

    const installments = Array.isArray(schedule.installments) ? schedule.installments : []
    setStripePlanInstallmentDrafts(installments.map((item: Record<string, any>, index: number) => {
      const status = String(item.status || 'pending').toLowerCase()
      const id = String(item.id || `stripe_installment_${index + 1}`)
      const method = getEditablePlanMethod(item.paymentMethod || item.method, provider)
      const locked = isStripePlanPaymentLocked(status) || (provider === 'mercadopago' && Boolean(item.preferenceId || item.paymentUrl))

      return {
        localId: id,
        id: item.id ? String(item.id) : undefined,
        label: `Pago ${Number(item.sequence || index + 1)}`,
        amount: normalizeDraftAmount(item.amount),
        dueDate: getEditablePlanDate(item.dueDate || item.date || item.scheduledAt || plan.nextRunAt, method, locked),
        method,
        status,
        paymentId: item.paymentId || null,
        locked
      }
    }))
  }, [])

  const stripePlanInstallmentsTotal = useMemo(() => (
    stripePlanInstallmentDrafts.reduce((total, installment) => total + (Number(installment.amount) || 0), 0)
  ), [stripePlanInstallmentDrafts])

  const stripePlanDraftTotal = useMemo(() => (
    stripePlanInstallmentsTotal + (Number(stripePlanFirstPaymentDraft?.amount) || 0)
  ), [stripePlanFirstPaymentDraft?.amount, stripePlanInstallmentsTotal])

  useUrlDateRangeSync({
    dateRange,
    setDateRange,
    enabled: paymentTableTab === 'transactions' && viewMode === 'by-date'
  })

  useEffect(() => {
    hydrateStripePlanDraft(paymentPlanModal.plan)
  }, [hydrateStripePlanDraft, paymentPlanModal.plan])

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
        if (!cancelled) setStripeStatusLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedTransactionSearch(transactionSearchTerm.trim())
    }, 300)
    return () => window.clearTimeout(handle)
  }, [transactionSearchTerm])

  useEffect(() => {
    if (paymentTableTab === 'transactions') {
      fetchData()
    }
  }, [dateRange, viewMode, paymentTableTab, debouncedTransactionSearch])

  useEffect(() => {
    if (paymentTableTab !== 'payment-plans') return

    fetchPaymentPlans()
  }, [conektaConnected, highLevelConnected, paymentTableTab, stripeConnected])

  useEffect(() => {
    setPaymentTableTab(current => current === routeState.tab ? current : routeState.tab)
    setViewMode(current => current === routeState.viewMode ? current : routeState.viewMode)
  }, [routeState.tab, routeState.viewMode])

  useEffect(() => {
    if (paymentTableTab !== 'payment-plans') {
      paymentPlansUnavailableRedirectedRef.current = false
      return
    }

    if (stripeStatusLoading || highLevelLoading) return

    if (stripeConnected || conektaConnected || highLevelConnected) {
      paymentPlansUnavailableRedirectedRef.current = false
      return
    }

    if (!paymentPlansUnavailableRedirectedRef.current) {
      showToast('warning', 'Planes no disponibles', 'Los planes de pago necesitan Stripe, Conekta o la integración opcional de HighLevel. Mercado Pago queda disponible para links y suscripciones.')
      paymentPlansUnavailableRedirectedRef.current = true
    }

    navigateTransactionsPath(buildTransactionsPath(viewMode), { replace: true })
  }, [
    highLevelConnected,
    highLevelLoading,
    conektaConnected,
    navigateTransactionsPath,
    paymentTableTab,
    showToast,
    stripeConnected,
    stripeStatusLoading,
    viewMode
  ])

  useEffect(() => {
    setIsClient(true)
  }, [])

  useEffect(() => {
    if (selectedTransactionIds.length === 0) return

    const availableIds = new Set(transactions.map(transaction => transaction.id))
    const nextSelectedIds = selectedTransactionIds.filter(id => availableIds.has(id))

    if (nextSelectedIds.length !== selectedTransactionIds.length) {
      setSelectedTransactionIds(nextSelectedIds)
    }
  }, [selectedTransactionIds, transactions])

  useEffect(() => {
    if (selectedPaymentPlanIds.length === 0) return

    const availableIds = new Set(paymentPlans.map(plan => plan.id))
    const nextSelectedIds = selectedPaymentPlanIds.filter(id => availableIds.has(id))

    if (nextSelectedIds.length !== selectedPaymentPlanIds.length) {
      setSelectedPaymentPlanIds(nextSelectedIds)
    }
  }, [paymentPlans, selectedPaymentPlanIds])

  useEffect(() => {
    if (paymentTableTab !== 'transactions' && selectedTransactionIds.length > 0) {
      setSelectedTransactionIds([])
    }
  }, [paymentTableTab, selectedTransactionIds.length])

  useEffect(() => {
    if (paymentTableTab !== 'payment-plans' && selectedPaymentPlanIds.length > 0) {
      setSelectedPaymentPlanIds([])
    }
  }, [paymentTableTab, selectedPaymentPlanIds.length])

  const fetchData = async (forceSync = false) => {
    setLoading(true)
    try {
      let startDate: string | undefined
      let endDate: string | undefined
      const search = debouncedTransactionSearch.trim()

      // Solo usar fechas si está en modo 'by-date'
      if (viewMode === 'by-date') {
        // Ensure dates are Date objects
        const start = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
        const end = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
        startDate = formatDateToISO(start)
        endDate = formatEndDateToISO(end) // Incluir día completo
      }
      // Si viewMode === 'all', no enviamos fechas para obtener TODOS los pagos

      const [transactionsData, summaryData] = await Promise.all([
        transactionsService.getTransactions(startDate, endDate, forceSync, search),
        transactionsService.getSummary(startDate, endDate)
      ])

      setTransactions(transactionsData)
      setSummary(summaryData)
    } catch (error) {
      // Error already shown to user via toast
      showToast('error', 'No se pudieron cargar los pagos', 'Hubo un problema al obtener la información de pagos. Intenta refrescar la página.')
    } finally {
      setLoading(false)
      setHasLoadedTransactions(true)
    }
  }

  const fetchPaymentPlans = async () => {
    setPaymentPlansLoading(true)
    try {
      const plans = await transactionsService.getPaymentPlans()
      setPaymentPlans(plans)
    } catch (error) {
      showToast('error', 'No se pudieron cargar los planes de pago', 'Ristak no pudo leer los planes guardados. Intenta actualizar de nuevo.')
    } finally {
      setPaymentPlansLoading(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      if (paymentTableTab === 'payment-plans') {
        if (!stripeConnected && !conektaConnected && !highLevelConnected && paymentPlans.length === 0) {
          showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o una integración compatible para consultar y programar planes de pago.')
          return
        }
        showToast('info', 'Actualizando planes de pago', 'Consultando planes guardados en Ristak y tus pasarelas conectadas...')
        await fetchPaymentPlans()
        showToast('success', 'Planes actualizados', 'La lista de planes de pago se actualizó correctamente.')
        return
      }

      showToast('info', 'Sincronizando pagos', 'Actualizando pagos desde las pasarelas conectadas...')

      let startDate: string | undefined
      let endDate: string | undefined

      if (viewMode === 'by-date') {
        const start = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
        const end = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
        startDate = formatDateToISO(start)
        endDate = formatEndDateToISO(end)
      }

      // Llamar al endpoint con sync=true para sincronización completa
      const [transactionsData, summaryData] = await Promise.all([
        transactionsService.getTransactions(startDate, endDate, true, debouncedTransactionSearch.trim()), // sync=true
        transactionsService.getSummary(startDate, endDate)
      ])

      setTransactions(transactionsData)
      setSummary(summaryData)
      showToast('success', 'Sincronización completa', 'Los pagos se actualizaron desde las pasarelas conectadas.')
    } catch (error) {
      showToast('error', 'Error en sincronización', 'No se pudo completar la sincronización. Intenta nuevamente.')
    } finally {
      setSyncing(false)
    }
  }

  const handleEdit = (transaction: Transaction) => {
    // Create a mock contact from transaction data for editing
    const mockContact: Contact = {
      id: transaction.contactId || `temp-${Date.now()}`,
      name: transaction.contactName,
      email: transaction.email,
      phone: transaction.phone || '',
      createdAt: '',
      ltv: 0,
      status: 'customer',
      purchases: 0
    }
    setModal({ type: 'edit', transaction, selectedContact: mockContact })
    navigateTransactionsPath(buildTransactionDetailPath(viewMode, transaction.id))
  }

  const closeTransactionModal = () => {
    setModal({ type: null, selectedContact: null })
    navigateTransactionsPath(buildTransactionsPath(viewMode), { replace: true })
  }

  const closePaymentPlanModal = () => {
    setPaymentPlanModal({
      plan: null,
      loading: false,
      saving: false
    })
    navigateTransactionsPath(buildPaymentPlansPath(), { replace: true })
  }

  const openPaymentPlanCreateModal = () => {
    if (stripeConnected || conektaConnected) {
      setPaymentTableTab('payment-plans')
      setRecordPaymentInitialMode('partial')
      setShowRecordPaymentModal(true)
      navigateTransactionsPath('/transactions/payment-plans/new')
      return
    }

    if (!highLevelConnected) {
      showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o una integración compatible para programar planes de pago.')
      return
    }

    setPaymentTableTab('payment-plans')
    setPaymentPlanCreateModal({
      open: true,
      selectedContact: null,
      saving: false,
      scheduleMode: 'recurring',
      frequency: 'monthly',
      endType: 'never',
      monthlyMode: 'dayOfMonth'
    })
    navigateTransactionsPath('/transactions/payment-plans/new')
  }

  const closePaymentPlanCreateModal = () => {
    setPaymentPlanCreateModal({
      open: false,
      selectedContact: null,
      saving: false,
      scheduleMode: 'recurring',
      frequency: 'monthly',
      endType: 'never',
      monthlyMode: 'dayOfMonth'
    })
    navigateTransactionsPath(buildPaymentPlansPath(), { replace: true })
  }

  const handleOpenPaymentPlan = async (plan: PaymentPlan) => {
    setPaymentTableTab('payment-plans')
    navigateTransactionsPath(buildPaymentPlanDetailPath(plan.id))
    setPaymentPlanModal({
      plan,
      loading: true,
      saving: false
    })

    try {
      const detailedPlan = await transactionsService.getPaymentPlan(plan.id)
      setPaymentPlanModal({
        plan: detailedPlan,
        loading: false,
        saving: false
      })
    } catch (error) {
      setPaymentPlanModal(prev => ({ ...prev, loading: false }))
      showToast('error', 'No se pudo cargar el detalle', 'Se abrió la información disponible de la tabla, pero no se pudo cargar el detalle completo.')
    }
  }

  const updateStripeFirstPaymentDraft = (updates: Partial<StripePlanPaymentDraft>) => {
    setStripePlanFirstPaymentDraft(prev => {
      if (!prev || prev.locked) return prev
      const next = { ...prev, ...updates }
      if (!isOfflinePlanPaymentMethod(next.method) && isDateBeforeToday(next.dueDate)) {
        next.dueDate = getTodayInputValue()
      }
      return next
    })
  }

  const removeStripeFirstPaymentDraft = () => {
    setStripePlanFirstPaymentDraft(prev => prev && !prev.locked ? null : prev)
  }

  const addStripeFirstPaymentDraft = () => {
    if (stripePlanFirstPaymentDraft) return
    const provider = getLocalCheckoutPlanProvider(paymentPlanModal.plan)

    setStripePlanFirstPaymentDraft({
      localId: 'stripe_first_payment',
      id: 'stripe_first_payment',
      label: 'Primer pago',
      amount: '',
      dueDate: clampDateToToday(toDateInputValue(paymentPlanModal.plan?.startDate || paymentPlanModal.plan?.nextRunAt)),
      method: getDefaultPlanMethod(provider),
      status: 'pending',
      paymentId: null,
      locked: false
    })
  }

  const updateStripeInstallmentDraft = (localId: string, updates: Partial<StripePlanPaymentDraft>) => {
    setStripePlanInstallmentDrafts(prev => prev.map(installment => (
      installment.localId === localId && !installment.locked
        ? (() => {
            const next = { ...installment, ...updates }
            if (!isOfflinePlanPaymentMethod(next.method) && isDateBeforeToday(next.dueDate)) {
              next.dueDate = getTodayInputValue()
            }
            return next
          })()
        : installment
    )))
  }

  const addStripeInstallmentDraft = () => {
    setStripePlanInstallmentDrafts(prev => {
      const provider = getLocalCheckoutPlanProvider(paymentPlanModal.plan)
      const nextIndex = prev.length + 1
      const nextDueDate = clampDateToToday(getNextPlanDueDate(prev, paymentPlanModal.plan?.nextRunAt || paymentPlanModal.plan?.startDate))

      return [
        ...prev,
        {
          localId: createStripePlanDraftId(),
          label: `Pago ${nextIndex}`,
          amount: '',
          dueDate: nextDueDate,
          method: getDefaultPlanMethod(provider),
          status: 'pending',
          paymentId: null,
          locked: false
        }
      ]
    })
  }

  const removeStripeInstallmentDraft = (localId: string) => {
    setStripePlanInstallmentDrafts(prev => prev.filter(installment => (
      installment.localId !== localId || installment.locked
    )))
  }

  const handleSavePaymentPlan = async (formData: FormData) => {
    if (!paymentPlanModal.plan) return
    if (isLocalCheckoutPaymentPlan(paymentPlanModal.plan)) {
      const plan = paymentPlanModal.plan
      const provider = getLocalCheckoutPlanProvider(plan)
      const providerLabel = getPaymentPlanProviderLabel(plan)
      const defaultMethod = getDefaultPlanMethod(provider)
      const schedule = getStripePlanSchedulePayload(plan)
      const name = String(formData.get('name') || plan.name || plan.title || 'Plan de pago').trim()
      const title = String(formData.get('title') || plan.title || name).trim()
      const termsNotes = String(formData.get('termsNotes') || '').trim()
      const remainingFrequency = String(formData.get('remainingFrequency') || schedule.remainingFrequency || 'custom').trim() || 'custom'

      const installments = stripePlanInstallmentDrafts.map((draft, index) => ({
        id: draft.id,
        amount: Number(draft.amount),
        dueDate: draft.dueDate,
        method: draft.method || defaultMethod,
        sequence: index + 1
      }))

      const invalidAmount = installments.find(installment => !Number.isFinite(installment.amount) || installment.amount <= 0)
      if (invalidAmount) {
        showToast('error', 'Monto inválido', 'Cada pago pendiente debe tener un monto mayor a cero.')
        return
      }

      const missingDate = installments.find(installment => !installment.dueDate)
      if (missingDate) {
        showToast('error', 'Fecha requerida', 'Cada pago pendiente necesita fecha de cobro.')
        return
      }

      const pastAutomaticDate = installments.find(installment => (
        !isOfflinePlanPaymentMethod(installment.method) && isDateBeforeToday(installment.dueDate)
      ))
      if (pastAutomaticDate) {
        showToast('error', 'Fecha inválida', 'Los cobros automáticos no pueden programarse en fechas pasadas.')
        return
      }

      const payload: Record<string, any> = {
        name,
        title,
        description: name,
        termsNotes: termsNotes || null,
        remainingFrequency,
        installments
      }

      if (stripePlanFirstPaymentDraft) {
        const firstPaymentAmount = Number(stripePlanFirstPaymentDraft.amount)
        if (!Number.isFinite(firstPaymentAmount) || firstPaymentAmount <= 0) {
          showToast('error', 'Monto inválido', 'El primer pago debe tener un monto mayor a cero o quitarse del plan.')
          return
        }

        const firstPaymentMethod = stripePlanFirstPaymentDraft.method || defaultMethod
        if (!isOfflinePlanPaymentMethod(firstPaymentMethod) && isDateBeforeToday(stripePlanFirstPaymentDraft.dueDate)) {
          showToast('error', 'Fecha inválida', 'El primer pago automático no puede programarse en una fecha pasada.')
          return
        }

        payload.firstPayment = {
          amount: firstPaymentAmount,
          dueDate: stripePlanFirstPaymentDraft.dueDate,
          method: firstPaymentMethod
        }
      } else if (Number(schedule.firstPayment?.amount || 0) > 0) {
        payload.firstPayment = null
      }

      setPaymentPlanModal(prev => ({ ...prev, saving: true }))

      try {
        const updatedPlan = await transactionsService.updatePaymentPlan(plan.id, payload)
        setPaymentPlans(prev => prev.map(item => item.id === updatedPlan.id ? updatedPlan : item))
        setPaymentPlanModal({
          plan: updatedPlan,
          loading: false,
          saving: false
        })
        showToast('success', 'Calendario actualizado', `El plan de ${providerLabel} quedó actualizado con los pagos configurados.`)
        fetchPaymentPlans()
      } catch (error: any) {
        setPaymentPlanModal(prev => ({ ...prev, saving: false }))
        showToast('error', 'No se pudo guardar el plan', error?.message || `${providerLabel} no pudo actualizar el calendario de pagos.`)
      }
      return
    }

    const payload: Record<string, any> = { ...getPlanPayload(paymentPlanModal.plan) }
    const name = String(formData.get('name') || '').trim()
    const title = String(formData.get('title') || '').trim()
    const amount = parseFloat(String(formData.get('total') || ''))
    const executeAt = String(formData.get('executeAt') || '').trim()
    const termsNotes = String(formData.get('termsNotes') || '').trim()

    if (name) payload.name = name
    if (title) payload.title = title
    if (Number.isFinite(amount) && amount > 0) payload.total = amount
    payload.termsNotes = termsNotes || null

    if (executeAt) {
      if (isDateBeforeToday(executeAt.slice(0, 10))) {
        showToast('error', 'Fecha inválida', 'El próximo cobro no puede programarse en una fecha pasada.')
        return
      }

      payload.schedule = payload.schedule && typeof payload.schedule === 'object'
        ? { ...payload.schedule }
        : {}
      payload.schedule.executeAt = new Date(executeAt).toISOString()
    }

    setPaymentPlanModal(prev => ({ ...prev, saving: true }))

    try {
      const updatedPlan = await transactionsService.updatePaymentPlan(paymentPlanModal.plan.id, payload)
      setPaymentPlans(prev => prev.map(plan => plan.id === updatedPlan.id ? updatedPlan : plan))
      closePaymentPlanModal()
      showToast('success', 'Plan de pago actualizado', 'El plan de pago se actualizó correctamente.')
      fetchPaymentPlans()
    } catch (error: any) {
      setPaymentPlanModal(prev => ({ ...prev, saving: false }))
      showToast('error', 'No se pudo guardar el plan', error?.message || 'La pasarela rechazó la actualización del plan de pago.')
    }
  }

  const updatePaymentPlanInState = (updatedPlan: PaymentPlan) => {
    setPaymentPlans(prev => prev.map(plan => plan.id === updatedPlan.id ? updatedPlan : plan))
    setPaymentPlanModal(prev => {
      if (!prev.plan || prev.plan.id !== updatedPlan.id) return prev

      return {
        ...prev,
        plan: updatedPlan
      }
    })
  }

  const removePaymentPlansFromState = (planIds: string[]) => {
    const deletedIds = new Set(planIds)
    setPaymentPlans(prev => prev.filter(plan => !deletedIds.has(plan.id)))
    setSelectedPaymentPlanIds(prev => prev.filter(id => !deletedIds.has(id)))
    setPaymentPlanModal(prev => {
      if (!prev.plan || !deletedIds.has(prev.plan.id)) return prev

      return {
        plan: null,
        loading: false,
        saving: false
      }
    })
  }

  const runPaymentPlanAction = async (
    plan: PaymentPlan,
    action: PaymentPlanAction,
    successTitle: string,
    successMessage: string
  ) => {
    const actionId = `${plan.id}:${action}`
    setPaymentPlanActionId(actionId)

    try {
      const updatedPlan = await transactionsService.actionPaymentPlan(plan.id, action)
      if (action === 'delete' || updatedPlan.deleted || isPlanDeleted(updatedPlan)) {
        removePaymentPlansFromState([plan.id])
      } else {
        updatePaymentPlanInState(updatedPlan)
      }
      if (action === 'change_card') {
        const cardSetupLink = getStripePlanCardSetupPaymentLink(updatedPlan)
        if (cardSetupLink) {
          const schedule = getStripePlanSchedulePayload(updatedPlan)
          setStripeCardSetupLinkModal({
            open: true,
            link: cardSetupLink,
            planName: updatedPlan.name || updatedPlan.title || 'Plan de pago',
            contactName: updatedPlan.contactName ? formatName(updatedPlan.contactName) : 'Sin contacto',
            amount: Number(schedule.cardSetupAmount || 0)
          })
          showToast('success', successTitle, successMessage)
        } else {
          showToast('warning', 'Enlace no disponible', 'Stripe generó la solicitud, pero Ristak no recibió la URL del enlace.')
        }
      } else {
        showToast('success', successTitle, successMessage)
      }
      fetchPaymentPlans()
    } catch (error: any) {
      showToast('error', 'No se pudo actualizar el plan', error?.message || 'No se pudo aplicar la acción para este plan de pago.')
    } finally {
      setPaymentPlanActionId(null)
    }
  }

  const handlePaymentPlanAction = (
    plan: PaymentPlan,
    action: Exclude<PaymentPlanAction, 'change_card'>
  ) => {
    const planName = plan.name || plan.title || 'este plan de pago'

    if (action === 'cancel') {
      const providerLabel = getPaymentPlanProviderLabel(plan)
      showConfirm(
        'Cancelar plan de pago',
        `¿Seguro que quieres cancelar ${planName}? ${providerLabel} dejará de cobrar este plan. Esta acción no se puede deshacer.`,
        () => runPaymentPlanAction(plan, action, 'Plan cancelado', 'El plan quedó cancelado y se actualizó la lista.'),
        'Cancelar plan',
        'Cancelar',
        undefined,
        { typeToConfirm: 'CANCELAR' }
      )
      return
    }

    if (action === 'delete') {
      const providerLabel = getPaymentPlanProviderLabel(plan)
      showConfirm(
        'Eliminar plan de pago',
        `¿Seguro que quieres eliminar ${planName}? Esta acción lo marca como eliminado en ${providerLabel} y en Ristak. Esta acción no se puede deshacer.`,
        () => runPaymentPlanAction(plan, action, 'Plan eliminado', 'El plan quedó eliminado y se actualizó la lista.'),
        'Eliminar plan',
        'Cancelar',
        undefined,
        { typeToConfirm: 'ELIMINAR' }
      )
      return
    }

    if (action === 'pause') {
      runPaymentPlanAction(plan, action, 'Plan pausado', 'El plan quedó pausado y se actualizó la lista.')
      return
    }

    runPaymentPlanAction(plan, action, 'Plan activado', 'El plan quedó activo/programado.')
  }

  const handleChangeStripePlanCard = (plan: PaymentPlan) => {
    showConfirm(
      'Cambiar tarjeta domiciliada',
      'Se creará un nuevo enlace de domiciliación. Cuando el cliente lo pague o autorice, esa tarjeta quedará como predeterminada para los próximos cobros.',
      () => runPaymentPlanAction(
        plan,
        'change_card',
        'Enlace de domiciliación listo',
        'Copia o abre el enlace para enviarlo al contacto.'
      )
    )
  }

  const handleCreatePaymentPlan = async (formData: FormData) => {
    const contact = paymentPlanCreateModal.selectedContact

    if (!contact) {
      showToast('error', 'Selecciona un contacto', 'Necesitas elegir a quién se le va a programar el plan de pago.')
      return
    }

    if (!contact.email && !contact.phone) {
      showToast('error', 'Contacto sin canal de envío', 'El contacto necesita email o teléfono para programar la factura recurrente.')
      return
    }

    const amount = parseFloat(String(formData.get('total') || '').replace(/[^0-9.-]/g, ''))
    const count = parseInt(String(formData.get('count') || ''), 10)
    const startDate = String(formData.get('startDate') || '').trim()
    const startTime = String(formData.get('startTime') || getDefaultScheduleTime()).trim()
    const scheduleMode = String(formData.get('scheduleMode') || 'recurring') as 'recurring' | 'one_time'
    const frequency = String(formData.get('frequency') || 'monthly')
    const interval = parseInt(String(formData.get('interval') || '1'), 10)
    const endType = String(formData.get('endType') || 'never')
    const endDate = String(formData.get('endDate') || '').trim()
    const endTime = String(formData.get('endTime') || '').trim()
    const dayOfWeek = String(formData.get('dayOfWeek') || '').trim()
    const dayOfMonth = String(formData.get('dayOfMonth') || '').trim()
    const numOfWeek = String(formData.get('numOfWeek') || '').trim()
    const monthOfYear = String(formData.get('monthOfYear') || '').trim()
    const monthlyMode = String(formData.get('monthlyMode') || 'dayOfMonth')
    const daysBefore = parseInt(String(formData.get('daysBefore') || '0'), 10)
    const useStartAsPrimaryUserAccepted = formData.get('useStartAsPrimaryUserAccepted') === 'on'
    const title = String(formData.get('title') || 'PLAN DE PAGO').trim()
    const rawName = String(formData.get('name') || '').trim()
    const description = String(formData.get('description') || '').trim()
    const termsNotes = String(formData.get('termsNotes') || '').trim()

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('error', 'Monto inválido', 'El monto por cobro debe ser mayor a cero.')
      return
    }

    if (scheduleMode === 'recurring' && endType === 'count' && (!Number.isFinite(count) || count < 1)) {
      showToast('error', 'Número de cobros inválido', 'Pon al menos un cobro para programar el plan.')
      return
    }

    if (scheduleMode === 'recurring' && (!Number.isFinite(interval) || interval < 1)) {
      showToast('error', 'Intervalo inválido', 'El intervalo de recurrencia debe ser mayor a cero.')
      return
    }

    if (scheduleMode === 'recurring' && endType === 'by' && !endDate) {
      showToast('error', 'Fecha final requerida', 'Elige la fecha final o cambia el plan a cobro indefinido.')
      return
    }

    if (!startDate) {
      showToast('error', 'Fecha requerida', 'Elige cuándo debe iniciar el plan de pago.')
      return
    }

    if (isDateBeforeToday(startDate)) {
      showToast('error', 'Fecha inválida', 'Los planes de pago no pueden iniciar en fechas pasadas.')
      return
    }

    if (scheduleMode === 'recurring' && endType === 'by' && endDate < startDate) {
      showToast('error', 'Fecha final inválida', 'La fecha final no puede ser anterior al inicio del plan.')
      return
    }

    const contactName = formatName(contact.name || contact.email || contact.phone || 'Cliente')
    const name = rawName || `${description || 'Plan de pago'} - ${contactName}`
    const schedule = buildPaymentPlanSchedule({
      scheduleMode,
      startDate,
      startTime,
      frequency,
      interval,
      endType,
      count,
      endDate,
      endTime,
      dayOfWeek,
      dayOfMonth,
      numOfWeek,
      monthOfYear,
      monthlyMode,
      daysBefore: Number.isFinite(daysBefore) ? daysBefore : 0,
      useStartAsPrimaryUserAccepted
    })
    const email = contact.email || ''
    const phone = contact.phone || ''

    const payload = {
      name,
      title,
      total: amount,
      amountDue: amount,
      amountPaid: 0,
      status: 'draft',
      issueDate: startDate,
      dueDate: startDate,
      termsNotes: termsNotes || null,
      contactDetails: {
        id: contact.id,
        name: contactName,
        email,
        phoneNo: phone
      },
      sentTo: {
        email: email ? [email] : [],
        phoneNo: phone ? [phone] : []
      },
      schedule,
      items: [
        {
          name: description || name,
          description: description || name,
          amount,
          qty: 1,
          type: 'one_time'
        }
      ],
      discount: {
        value: 0,
        type: 'percentage'
      },
      paymentMethods: {
        stripe: {
          enableBankDebitOnly: false
        }
      }
    }

    setPaymentPlanCreateModal(prev => ({ ...prev, saving: true }))

    try {
      const createdPlan = await transactionsService.createPaymentPlan(payload)
      setPaymentPlans(prev => [createdPlan, ...prev])
      closePaymentPlanCreateModal()
      showToast('success', 'Plan programado', 'El plan de pago quedó programado correctamente.')
      fetchPaymentPlans()
    } catch (error: any) {
      setPaymentPlanCreateModal(prev => ({ ...prev, saving: false }))
      showToast('error', 'No se pudo programar el plan', error?.message || 'La pasarela rechazó la creación del plan de pago.')
    }
  }

  useEffect(() => {
    const openType = searchParams.get('open')
    const legacyPaymentId = openType === 'payment' ? searchParams.get('id') : ''
    const paymentId = routeState.transactionId || legacyPaymentId

    if (!paymentId) {
      handledOpenPaymentRef.current = null
      return
    }

    if (handledOpenPaymentRef.current === paymentId) {
      return
    }

    handledOpenPaymentRef.current = paymentId
    let isMounted = true

    const clearOpenParams = () => {
      if (!legacyPaymentId) return
      const nextParams = new URLSearchParams(searchParams)
      nextParams.delete('open')
      nextParams.delete('id')
      setSearchParams(nextParams, { replace: true })
    }

    const openPaymentFromSearch = async () => {
      try {
        const transaction = transactions.find((item) => item.id === paymentId) ?? await transactionsService.getTransaction(paymentId)

        if (!isMounted) return

        handleEdit(transaction)
      } catch {
        if (isMounted) {
          showToast('error', 'No se pudo abrir el pago', 'El resultado existe, pero no se pudo cargar el detalle.')
        }
      } finally {
        if (isMounted) {
          clearOpenParams()
        }
      }
    }

    openPaymentFromSearch()

    return () => {
      isMounted = false
    }
  }, [routeState.transactionId, searchParams, setSearchParams, showToast, transactions])

  useEffect(() => {
    if (!routeState.createTransaction) return
    setPaymentTableTab('transactions')
    setRecordPaymentInitialMode('single')
    setShowRecordPaymentModal(true)
  }, [routeState.createTransaction])

  useEffect(() => {
    const paymentPlanLinkFlowOpen = routeState.createPaymentPlan && (stripeConnected || conektaConnected)
    if (!routeState.createTransaction && !paymentPlanLinkFlowOpen && showRecordPaymentModal) {
      setShowRecordPaymentModal(false)
    }
  }, [conektaConnected, routeState.createPaymentPlan, routeState.createTransaction, showRecordPaymentModal, stripeConnected])

  useEffect(() => {
    if (!routeState.createPaymentPlan) return
    setPaymentTableTab('payment-plans')

    if (stripeConnected || conektaConnected) {
      setRecordPaymentInitialMode('partial')
      setShowRecordPaymentModal(true)
      return
    }

    if (stripeStatusLoading || highLevelLoading) return

    if (!highLevelConnected) {
      showToast('warning', 'Pasarela no conectada', 'Conecta Stripe, Conekta o una integración compatible para programar planes de pago.')
      navigateTransactionsPath(buildPaymentPlansPath(), { replace: true })
      return
    }

    setPaymentPlanCreateModal({
      open: true,
      selectedContact: null,
      saving: false,
      scheduleMode: 'recurring',
      frequency: 'monthly',
      endType: 'never',
      monthlyMode: 'dayOfMonth'
    })
  }, [conektaConnected, highLevelConnected, highLevelLoading, navigateTransactionsPath, routeState.createPaymentPlan, showToast, stripeConnected, stripeStatusLoading])

  useEffect(() => {
    if (!routeState.createPaymentPlan && paymentPlanCreateModal.open) {
      setPaymentPlanCreateModal({
        open: false,
        selectedContact: null,
        saving: false,
        scheduleMode: 'recurring',
        frequency: 'monthly',
        endType: 'never',
        monthlyMode: 'dayOfMonth'
      })
    }
  }, [paymentPlanCreateModal.open, routeState.createPaymentPlan])

  useEffect(() => {
    const planId = routeState.paymentPlanId
    if (!planId) {
      handledOpenPaymentPlanRef.current = null
      return
    }

    if (handledOpenPaymentPlanRef.current === planId) return
    handledOpenPaymentPlanRef.current = planId
    setPaymentTableTab('payment-plans')

    setPaymentPlanModal({
      plan: { id: planId } as PaymentPlan,
      loading: true,
      saving: false
    })

    let isMounted = true
    transactionsService.getPaymentPlan(planId)
      .then(plan => {
        if (!isMounted) return
        setPaymentPlanModal({
          plan,
          loading: false,
          saving: false
        })
      })
      .catch(() => {
        if (!isMounted) return
        setPaymentPlanModal(prev => ({ ...prev, loading: false }))
        showToast('error', 'No se pudo abrir el plan', 'El resultado existe, pero no se pudo cargar el detalle.')
      })

    return () => {
      isMounted = false
    }
  }, [routeState.paymentPlanId, showToast])

  useEffect(() => {
    if (!routeState.transactionId && modal.type === 'edit') {
      setModal({ type: null, selectedContact: null })
    }
  }, [modal.type, routeState.transactionId])

  useEffect(() => {
    if (!routeState.paymentPlanId && paymentPlanModal.plan) {
      setPaymentPlanModal({
        plan: null,
        loading: false,
        saving: false
      })
    }
  }, [paymentPlanModal.plan, routeState.paymentPlanId])

  const openTransactionDeleteModal = (targetTransactions: Transaction[]) => {
    if (targetTransactions.length === 0) return

    setTransactionsPendingDeletion(targetTransactions)
  }

  const closeTransactionDeleteModal = () => {
    if (deletingTransactions) return

    setTransactionsPendingDeletion([])
  }

  const openPaymentPlanDeleteModal = (targetPlans: PaymentPlan[]) => {
    if (targetPlans.length === 0) return

    setPaymentPlansPendingDeletion(targetPlans)
  }

  const closePaymentPlanDeleteModal = () => {
    if (deletingPaymentPlans) return

    setPaymentPlansPendingDeletion([])
  }

  const handleConfirmDeleteTransactions = async () => {
    if (transactionsPendingDeletion.length === 0) return

    setDeletingTransactions(true)
    const deletingIds = transactionsPendingDeletion.map(transaction => transaction.id)
    const failedTransactions: Transaction[] = []

    for (const transaction of transactionsPendingDeletion) {
      try {
        await transactionsService.deleteTransaction(transaction.id)
      } catch {
        failedTransactions.push(transaction)
      }
    }

    const deletedIds = new Set(
      deletingIds.filter(id => !failedTransactions.some(transaction => transaction.id === id))
    )

    if (deletedIds.size > 0) {
      setTransactions(prev => prev.filter(transaction => !deletedIds.has(transaction.id)))
      setSelectedTransactionIds(prev => prev.filter(id => !deletedIds.has(id)))
    }

    setDeletingTransactions(false)
    setTransactionsPendingDeletion([])

    if (failedTransactions.length > 0) {
      showToast(
        'error',
        'No se pudieron eliminar todos',
        `Se eliminaron ${deletedIds.size} y fallaron ${failedTransactions.length}. Intenta otra vez con los pendientes.`
      )
    } else {
      showToast(
        'success',
        transactionsPendingDeletion.length === 1 ? 'Pago eliminado' : 'Pagos eliminados',
        transactionsPendingDeletion.length === 1
          ? 'El pago se eliminó correctamente.'
          : `Se eliminaron ${transactionsPendingDeletion.length} pagos correctamente.`
      )
    }

    fetchData()
  }

  const handleConfirmDeletePaymentPlans = async () => {
    if (paymentPlansPendingDeletion.length === 0) return

    setDeletingPaymentPlans(true)
    const deletingIds = paymentPlansPendingDeletion.map(plan => plan.id)
    const failedPlans: PaymentPlan[] = []

    for (const plan of paymentPlansPendingDeletion) {
      setPaymentPlanActionId(`${plan.id}:delete`)
      try {
        await transactionsService.actionPaymentPlan(plan.id, 'delete')
      } catch {
        failedPlans.push(plan)
      }
    }

    const deletedIds = new Set(
      deletingIds.filter(id => !failedPlans.some(plan => plan.id === id))
    )

    if (deletedIds.size > 0) {
      removePaymentPlansFromState(Array.from(deletedIds))
    }

    setPaymentPlanActionId(null)
    setDeletingPaymentPlans(false)
    setPaymentPlansPendingDeletion([])

    if (failedPlans.length > 0) {
      showToast(
        'error',
        'No se pudieron eliminar todos',
        `Se eliminaron ${deletedIds.size} y fallaron ${failedPlans.length}. Revisa los pendientes e intenta otra vez.`
      )
    } else {
      showToast(
        'success',
        paymentPlansPendingDeletion.length === 1 ? 'Plan eliminado' : 'Planes eliminados',
        paymentPlansPendingDeletion.length === 1
          ? 'El plan de pago se eliminó correctamente.'
          : `Se eliminaron ${paymentPlansPendingDeletion.length} planes de pago correctamente.`
      )
    }

    fetchPaymentPlans()
  }

  const handleDelete = (id: string) => {
    const transaction = transactions.find(item => item.id === id)
    if (!transaction) return

    openTransactionDeleteModal([transaction])
  }

  const handleVoidTransaction = async (id: string) => {
    showConfirm(
      'Anular pago',
      '¿Estás seguro de anular este pago? Esta acción no se puede deshacer.',
      async () => {
        try {
          await transactionsService.voidTransaction(id)
          showToast('success', 'Pago anulado correctamente', 'El pago ha sido anulado exitosamente')
          fetchData()
        } catch (error) {
          showToast('error', 'No se pudo anular el pago', 'Hubo un problema al intentar anular el pago. Intenta nuevamente.')
          return false
        }
      },
      'Anular pago',
      'Cancelar',
      undefined,
      { typeToConfirm: 'ANULAR' }
    )
  }

  const handleRefundTransaction = async (transaction: Transaction) => {
    showConfirm(
      'Reembolsar pago',
      `¿Confirmas el reembolso de ${formatCurrency(transaction.amount)}? El pago quedará como reembolsado y ya no contará al contacto como cliente.`,
      async () => {
        try {
          await transactionsService.refundTransaction(transaction.id)
          showToast('success', 'Pago reembolsado correctamente', 'El contacto se recalculó y este pago ya no cuenta como compra activa.')
          fetchData()
        } catch (error: any) {
          showToast('error', 'No se pudo reembolsar el pago', error?.message || 'Hubo un problema al marcar el pago como reembolsado.')
          return false
        }
      },
      'Reembolsar',
      'Cancelar',
      undefined,
      { typeToConfirm: 'REEMBOLSAR' }
    )
  }

  const handleMarkAsPaid = async (transaction: Transaction) => {
    showConfirm(
      'Marcar como pagado',
      `¿Confirmas que el pago de ${formatCurrency(transaction.amount)} fue recibido?`,
      async () => {
        try {
          await transactionsService.recordPayment(transaction.id, {
            amount: transaction.amount,
            paymentDate: new Date().toISOString(),
            paymentMethod: transaction.method,
          })
          showToast('success', 'Pago marcado como pagado', 'El pago ha sido registrado como completado')
          fetchData()
        } catch (error) {
          showToast('error', 'No se pudo marcar el pago', 'Hubo un problema al actualizar el estado del pago.')
        }
      }
    )
  }

  const handleCopyPaymentLink = async (transaction: Transaction) => {
    try {
      const link = transaction.paymentUrl || await transactionsService.getPaymentLink(transaction.id)
      await navigator.clipboard.writeText(link)
      showToast('success', '¡Enlace copiado!', 'El enlace de pago se copió al portapapeles')
    } catch (error) {
      showToast('error', 'Error al copiar enlace', 'No se pudo obtener el enlace de pago')
    }
  }

  const closeStripeCardSetupLinkModal = () => {
    setStripeCardSetupLinkModal({
      open: false,
      link: '',
      planName: '',
      contactName: '',
      amount: 0
    })
  }

  const handleCopyStripeCardSetupLink = async () => {
    if (!stripeCardSetupLinkModal.link) return

    try {
      await navigator.clipboard.writeText(stripeCardSetupLinkModal.link)
      showToast('success', 'Enlace copiado', 'El enlace de domiciliación quedó listo para enviarse.')
    } catch {
      showToast('error', 'No se pudo copiar', 'Copia el enlace manualmente desde la caja de texto.')
    }
  }

  const handleOpenStripeCardSetupLink = () => {
    if (!stripeCardSetupLinkModal.link) return
    window.open(stripeCardSetupLinkModal.link, '_blank', 'noopener,noreferrer')
  }

  const handleSendPayment = async (id: string, sendMethod: 'email' | 'sms' | 'both' = 'email') => {
    try {
      // Buscar el transaction para obtener el invoiceId
      const transaction = transactions.find(t => t.id === id)
      if (!transaction || !transaction.invoiceId) {
        showToast('error', 'Error', 'No se pudo encontrar el invoice para enviar')
        return
      }

      await highLevelService.sendInvoice(transaction.invoiceId, sendMethod)

      let successMessage = 'Pago enviado al cliente correctamente'
      if (sendMethod === 'email') {
        successMessage = 'Pago enviado por email correctamente'
      } else if (sendMethod === 'sms') {
        successMessage = 'Pago enviado por WhatsApp correctamente'
      } else if (sendMethod === 'both') {
        successMessage = 'Pago enviado por email y WhatsApp correctamente'
      }

      showToast('success', 'Éxito', successMessage)
      fetchData()
    } catch (error) {
      showToast('error', 'Error al enviar pago', 'No se pudo enviar el pago al cliente')
    }
  }

  const handleViewReceipt = (_transaction: Transaction) => {
    // TODO: Implement view receipt - open payment link in new tab
    showToast('info', 'Ver recibo', 'Abriendo recibo en nueva pestaña...')
  }

  const handleSaveTransaction = async (formData: FormData) => {
    const contactSnapshot = modal.type === 'edit' && modal.transaction
      ? {
          id: modal.transaction.contactId,
          name: modal.transaction.contactName || 'Sin nombre',
          email: modal.transaction.email || '',
          phone: modal.transaction.phone || ''
        }
      : modal.selectedContact

    if (!contactSnapshot) {
      showToast('error', 'Contacto no seleccionado', 'Necesitas buscar y seleccionar un contacto para asociar este pago')
      return
    }

    const transaction: Transaction = {
      id: modal.transaction?.id || '',
      date: formData.get('date') as string,
      contactId: contactSnapshot.id,
      contactName: contactSnapshot.name,
      email: contactSnapshot.email || '',
      phone: contactSnapshot.phone || '',
      amount: parseFloat(formData.get('amount') as string) || 0,
      currency: accountCurrency,
      method: formData.get('method') as any,
      status: formData.get('status') as any,
      reference: formData.get('reference') as string,
      title: formData.get('title') as string,
      description: formData.get('description') as string,
      dueDate: (formData.get('dueDate') as string) || undefined
    }

    try {
      if (modal.type === 'create') {
        // En alta capturamos el momento exacto (hoy -> ahora; otra fecha -> ese día),
        // para que el orden descendente refleje cuándo se registró el pago.
        const newTransaction = await transactionsService.createTransaction({
          ...transaction,
          date: buildPaymentTimestamp(transaction.date)
        })
        setTransactions(prev => [...prev, newTransaction])
        showToast('success', '¡Pago registrado exitosamente!', `Se registró el pago de ${formatCurrency(transaction.amount, accountCurrency)} para ${contactSnapshot.name}`)
      } else if (modal.type === 'edit') {
        const updatedTransaction = await transactionsService.updateTransaction(transaction.id, transaction)
        setTransactions(prev => prev.map(t => t.id === updatedTransaction.id ? updatedTransaction : t))
        showToast('success', 'Pago actualizado correctamente', `Se actualizó el registro de pago de ${formatCurrency(updatedTransaction.amount, accountCurrency)}`)
      }
      closeTransactionModal()
      fetchData()
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el pago', error?.message || 'Hubo un problema al guardar la información. Verifica los datos e intenta nuevamente.')
    }
  }

  const getPaymentProviderLogo = (transaction: Transaction): PaymentPlatformLogoId | null => {
    const provider = String(transaction.paymentProvider || '').toLowerCase()
    const method = String(transaction.method || '').toLowerCase()

    if (provider === 'mercadopago' || method.startsWith('mercadopago')) return 'mercadopago'
    if (provider === 'conekta' || method.startsWith('conekta')) return 'conekta'
    if (provider === 'stripe' || method.startsWith('stripe') || Boolean(transaction.stripePaymentIntentId)) return 'stripe'
    if (provider === 'gigstack' || method.startsWith('gigstack')) return 'gigstack'
    return null
  }

  const getMethodIcon = (method: string) => {
    const normalized = String(method || '').toLowerCase()

    switch(normalized) {
      case 'card': return <CreditCard size={16} />
      case 'mercadopago':
      case 'mercadopago_checkout': return <CreditCard size={16} />
      case 'bank_transfer':
      case 'transfer': return <RefreshCw size={16} />
      case 'cash': return <Banknote size={16} />
      case 'check': return <Receipt size={16} />
      case 'paypal': return <DollarSign size={16} />
      default: return <DollarSign size={16} />
    }
  }

  const getMethodLabel = (method: string) => {
    const normalized = String(method || '').toLowerCase()

    switch(normalized) {
      case 'card': return 'Tarjeta'
      case 'direct_card': return 'Tarjeta'
      case 'saved_card': return 'Tarjeta guardada'
      case 'payment_link': return 'Link de pago'
      case 'stripe': return 'Stripe'
      case 'stripe_saved_card': return 'Tarjeta guardada'
      case 'stripe_link':
      case 'stripe_payment_link': return 'Link de Stripe'
      case 'conekta': return 'Conekta'
      case 'conekta_saved_card': return 'Tarjeta Conekta'
      case 'conekta_subscription': return 'Conekta domiciliado'
      case 'mercadopago':
      case 'mercadopago_checkout': return 'Mercado Pago'
      case 'mercadopago_subscription': return 'Suscripción Mercado Pago'
      case 'bank_transfer':
      case 'transfer': return 'Transferencia'
      case 'cash': return 'Efectivo'
      case 'check': return 'Cheque'
      case 'paypal': return 'PayPal'
      case 'other': return 'Otro'
      default: return normalized
        ? normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase())
        : 'Sin método'
    }
  }

  const getStatusBadge = (status: string) => {
    const config = getTransactionStatusBadge(status)
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const isTestPayment = (transaction: Transaction) => transaction.paymentMode === 'test'

  const getStatusCell = (transaction: Transaction) => (
    <div className={styles.statusCell}>
      {getStatusBadge(transaction.status)}
      {isTestPayment(transaction) && (
        <Badge variant="warning" className={styles.testModeBadge}>Prueba</Badge>
      )}
    </div>
  )

  const columns: Column<Transaction>[] = [
    {
      key: 'date',
      header: 'Fecha',
      render: (value) => formatLocalDateShort(value),
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (_value, item) => getStatusCell(item),
      sortable: true
    },
    {
      key: 'amount',
      header: 'Monto',
      render: (value) => formatCurrency(value),
      sortable: true
    },
    {
      key: 'contactName',
      header: 'Contacto',
      render: (value) => formatName(value),
      sortable: true
    },
    {
      key: 'method',
      header: 'Método de pago',
      render: (value, item) => {
        const providerLogo = getPaymentProviderLogo(item)

        return (
          <div className={styles.methodCell}>
            {providerLogo ? <PaymentPlatformLogo platform={providerLogo} size="sm" decorative /> : getMethodIcon(value)}
            <span>{getMethodLabel(value)}</span>
          </div>
        )
      },
      sortable: true
    },
    {
      key: 'title',
      header: 'Título',
      sortable: false,
      visible: true,
      render: (value, item) => value || item.description || 'Pago'
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      visible: false
    },
    {
      key: 'id',
      header: 'Acciones',
      render: (_value, item) => {
        // Contar acciones disponibles según el estado
        const actions = []
        const method = String(item.method || '').toLowerCase()
        const provider = String(item.paymentProvider || '').toLowerCase()
        const isStripeTransaction = provider === 'stripe' || method.startsWith('stripe') || Boolean(item.publicPaymentId || item.paymentUrl || item.stripePaymentIntentId)
        const isMercadoPagoTransaction = provider === 'mercadopago' || method.startsWith('mercadopago')
        const isGatewayTransaction = isStripeTransaction || isMercadoPagoTransaction
        const canVoidPayment = canVoidHighLevelTransaction(item)
        const hasPaymentLink = Boolean(item.paymentUrl || item.publicPaymentId || item.invoiceId)

        // Copiar enlace - disponible para draft, sent, pending, overdue
        if (hasPaymentLink && ['draft', 'sent', 'pending', 'overdue', 'partial'].includes(item.status)) {
          actions.push('copy')
        }

        // Ver recibo - solo para pagados
        if (item.status === 'paid') {
          actions.push('view')
        }

        // Enviar - solo para draft y pending
        if (!isGatewayTransaction && item.invoiceId && ['draft', 'pending'].includes(item.status)) {
          actions.push('send')
        }

        // Editar - disponible para pagos visibles; backend valida qué puede sincronizar cada pasarela.
        if (item.status !== 'deleted') {
          actions.push('edit')
        }

        // Marcar como pagado - para draft, sent, pending, overdue, failed, partial
        if (['draft', 'sent', 'pending', 'overdue', 'failed', 'partial'].includes(item.status)) {
          actions.push('mark-paid')
        }

        // Reembolsar - para pagos completados locales; backend bloquea invoices remotos de HighLevel
        if (REFUNDABLE_TRANSACTION_STATUSES.includes(item.status)) {
          actions.push('refund')
        }

        // Anular solo aplica a invoices de GoHighLevel que todavía aceptan void.
        if (canVoidPayment) {
          actions.push('void')
        }

        if (!canVoidPayment) {
          actions.push('delete')
        }

        // Si solo hay una acción (eliminar), mostrar botón directo
        if (actions.length === 1 && actions[0] === 'delete') {
          return (
            <div className={styles.actions}>
              <button
                className={`${styles.actionButton} ${styles.deleteButton}`}
                onClick={() => handleDelete(item.id)}
                title="Eliminar pago"
              >
                <Trash2 size={16} />
              </button>
            </div>
          )
        }

        // Si hay múltiples acciones, mostrar dropdown
        return (
          <div className={styles.actions}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className={styles.actionButton} title="Más acciones">
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Copiar enlace de pago */}
                {actions.includes('copy') && (
                  <DropdownMenuItem onClick={() => handleCopyPaymentLink(item)}>
                    <Link2 size={16} />
                    <span style={{ marginLeft: '8px' }}>Copiar enlace de pago</span>
                  </DropdownMenuItem>
                )}

                {/* Ver recibo (solo para pagados) */}
                {actions.includes('view') && (
                  <DropdownMenuItem onClick={() => handleViewReceipt(item)}>
                    <Eye size={16} />
                    <span style={{ marginLeft: '8px' }}>Ver recibo</span>
                  </DropdownMenuItem>
                )}

                {/* Enviar pago */}
                {actions.includes('send') && (
                  <>
                    <DropdownMenuItem onClick={() => handleSendPayment(item.id, 'email')}>
                      <Mail size={16} />
                      <span style={{ marginLeft: '8px' }}>Enviar por Email</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleSendPayment(item.id, 'sms')}>
                      <MessageCircle size={16} />
                      <span style={{ marginLeft: '8px' }}>Enviar por WhatsApp</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleSendPayment(item.id, 'both')}>
                      <Send size={16} />
                      <span style={{ marginLeft: '8px' }}>Enviar por Ambos</span>
                    </DropdownMenuItem>
                  </>
                )}

                {/* Editar */}
                {actions.includes('edit') && (
                  <DropdownMenuItem onClick={() => handleEdit(item)}>
                    <Edit size={16} />
                    <span style={{ marginLeft: '8px' }}>Editar</span>
                  </DropdownMenuItem>
                )}

                {/* Marcar como pagado */}
                {actions.includes('mark-paid') && (
                  <DropdownMenuItem onClick={() => handleMarkAsPaid(item)}>
                    <CheckCircle size={16} />
                    <span style={{ marginLeft: '8px' }}>Marcar como pagado</span>
                  </DropdownMenuItem>
                )}

                {/* Separador antes de acciones destructivas */}
                {(actions.includes('refund') || actions.includes('void') || actions.includes('delete')) && (
                  <DropdownMenuSeparator />
                )}

                {/* Reembolsar pago */}
                {actions.includes('refund') && (
                  <DropdownMenuItem
                    onClick={() => handleRefundTransaction(item)}
                    className={styles.destructive}
                  >
                    <RotateCcw size={16} />
                    <span style={{ marginLeft: '8px' }}>Reembolsar pago</span>
                  </DropdownMenuItem>
                )}

                {/* Anular pago */}
                {actions.includes('void') && (
                  <DropdownMenuItem
                    onClick={() => handleVoidTransaction(item.id)}
                    className={styles.destructive}
                  >
                    <Trash2 size={16} />
                    <span style={{ marginLeft: '8px' }}>Anular pago</span>
                  </DropdownMenuItem>
                )}

                {/* Eliminar pago */}
                <DropdownMenuItem
                  onClick={() => handleDelete(item.id)}
                  className={styles.destructive}
                >
                  <Trash2 size={16} />
                  <span style={{ marginLeft: '8px' }}>Eliminar pago</span>
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

  const getPlanStatusBadge = (status?: string) => {
    const config = getPaymentPlanStatusBadge(status)
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const getNormalizedPlanStatus = (plan: PaymentPlan) => String(plan.status || 'active').toLowerCase()
  const normalizePaymentPlanStatusForDisplay = (status: string) => {
    if (status === 'canceled') return 'cancelled'
    if (PAYMENT_PLAN_FINAL_STATUSES.has(status)) return 'completed'
    return status
  }
  const isPaymentPlanFullyPaid = (plan: PaymentPlan) => {
    const progress = getPaymentPlanProgress(plan)
    return progress.known && progress.total > 0 && progress.remaining === 0
  }
  const getPlanFilterStatus = (plan: PaymentPlan) => {
    const status = normalizePaymentPlanStatusForDisplay(getNormalizedPlanStatus(plan))
    if (status !== 'completed' && isPaymentPlanFullyPaid(plan)) return 'completed'
    return status
  }
  const getPaymentPlanStartDate = (plan: PaymentPlan) => (
    plan.startDate || plan.sortDate || plan.nextRunAt || plan.updatedAt || plan.createdAt || ''
  )
  const getPaymentPlanNextDate = (plan: PaymentPlan) => {
    const status = getPlanFilterStatus(plan)
    if (PAYMENT_PLAN_EMPTY_NEXT_DATE_STATUSES.has(status)) return ''
    return plan.nextRunAt || ''
  }
  const isPlanDeleted = (plan: PaymentPlan) => getNormalizedPlanStatus(plan) === 'deleted'
  const canActivatePaymentPlan = (plan: PaymentPlan) => ['draft', 'paused', 'inactive', 'pending'].includes(getNormalizedPlanStatus(plan))
  const canPausePaymentPlan = (plan: PaymentPlan) => ['active', 'scheduled', 'pending', 'sent'].includes(getNormalizedPlanStatus(plan))
  const canCancelPaymentPlan = (plan: PaymentPlan) => !['cancelled', 'canceled', 'completed', 'complete', 'deleted'].includes(getNormalizedPlanStatus(plan))
  const canDeletePaymentPlan = (_plan: PaymentPlan) => true

  const transactionStatusFilterData = useMemo(() => {
    const counts = transactions.reduce<Record<string, number>>((acc, transaction) => {
      const status = String(transaction.status || '').toLowerCase()
      if (!status) return acc
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})

    const orderedStatuses = [
      ...TRANSACTION_STATUS_ORDER.filter(status => counts[status]),
      ...Object.keys(counts).filter(status => !TRANSACTION_STATUS_ORDER.includes(status)).sort()
    ]

    return {
      statuses: orderedStatuses.map(status => ({
        name: TRANSACTION_STATUS_BADGES[status]?.label || status,
        value: status,
        count: counts[status]
      }))
    }
  }, [transactions])

  const paymentPlanStatusFilterData = useMemo(() => {
    const counts = paymentPlans.reduce<Record<string, number>>((acc, plan) => {
      const status = getPlanFilterStatus(plan)
      if (!status) return acc
      acc[status] = (acc[status] || 0) + 1
      return acc
    }, {})

    const orderedStatuses = [
      ...PAYMENT_PLAN_STATUS_ORDER.filter(status => counts[status]),
      ...Object.keys(counts).filter(status => !PAYMENT_PLAN_STATUS_ORDER.includes(status)).sort()
    ]

    return {
      statuses: orderedStatuses.map(status => ({
        name: PAYMENT_PLAN_STATUS_BADGES[status]?.label || status,
        value: status,
        count: counts[status]
      }))
    }
  }, [paymentPlans])

  const filteredTransactions = useMemo(() => {
    const selectedStatuses = transactionStatusFilters.status || []
    if (!selectedStatuses.length) return transactions

    return transactions.filter(transaction =>
      selectedStatuses.includes(String(transaction.status || '').toLowerCase())
    )
  }, [transactionStatusFilters, transactions])

  const selectedTransactions = useMemo(() => {
    if (selectedTransactionIds.length === 0) return []

    const selectedIds = new Set(selectedTransactionIds)
    return transactions.filter(transaction => selectedIds.has(transaction.id))
  }, [selectedTransactionIds, transactions])

  const filteredPaymentPlans = useMemo(() => {
    const selectedStatuses = paymentPlanStatusFilters.status || []
    if (!selectedStatuses.length) return paymentPlans

    return paymentPlans.filter(plan => selectedStatuses.includes(getPlanFilterStatus(plan)))
  }, [paymentPlanStatusFilters, paymentPlans])

  const selectedPaymentPlans = useMemo(() => {
    if (selectedPaymentPlanIds.length === 0) return []

    const selectedIds = new Set(selectedPaymentPlanIds)
    return paymentPlans.filter(plan => selectedIds.has(plan.id) && canDeletePaymentPlan(plan))
  }, [paymentPlans, selectedPaymentPlanIds])

  const activeStatusFilters = paymentTableTab === 'payment-plans'
    ? paymentPlanStatusFilters
    : transactionStatusFilters
  const activeStatusFilterData = paymentTableTab === 'payment-plans'
    ? paymentPlanStatusFilterData
    : transactionStatusFilterData

  const handleStatusFilterChange = (filters: StatusFilters) => {
    if (paymentTableTab === 'payment-plans') {
      setPaymentPlanStatusFilters(filters)
      return
    }

    setTransactionStatusFilters(filters)
  }

  const statusFilterControl = (
    <TreeFilter
      availableData={activeStatusFilterData}
      selectedFilters={activeStatusFilters}
      onFilterChange={handleStatusFilterChange}
    />
  )

  const transactionSelectionToolbar = selectedTransactions.length > 0 ? (
    <TableSelectionToolbar
      count={selectedTransactions.length}
      onClearSelection={() => setSelectedTransactionIds([])}
    >
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => openTransactionDeleteModal(selectedTransactions)}
      >
        <Trash2 size={16} />
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null

  const paymentPlanSelectionToolbar = selectedPaymentPlans.length > 0 ? (
    <TableSelectionToolbar
      count={selectedPaymentPlans.length}
      onClearSelection={() => setSelectedPaymentPlanIds([])}
    >
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={deletingPaymentPlans}
        onClick={() => openPaymentPlanDeleteModal(selectedPaymentPlans)}
      >
        <Trash2 size={16} />
        Eliminar
      </Button>
    </TableSelectionToolbar>
  ) : null

  const renderStripePlanPaymentStatusBadge = (status?: string | null) => {
    const config = getStripePlanPaymentStatusBadgeConfig(status)
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const renderStripePaymentDraftRow = (
    draft: StripePlanPaymentDraft,
    _index: number,
    options: {
      provider: LocalCheckoutPlanProvider
      kind: 'first' | 'installment'
      onUpdate: (updates: Partial<StripePlanPaymentDraft>) => void
      onRemove?: () => void
    }
  ) => {
    const locked = Boolean(draft.locked)
    const methodLabel = getStripePlanMethodLabel(draft.method, options.provider)
    const methodOptions = getPlanMethodOptions(options.provider)
    const defaultMethod = getDefaultPlanMethod(options.provider)

    return (
      <div
        key={draft.localId}
        className={`${styles.stripePlanPaymentRow} ${locked ? styles.stripePlanPaymentLocked : ''}`}
      >
        <div className={styles.stripePlanPaymentMeta}>
          <strong>{draft.label}</strong>
        </div>

        <div className={styles.stripePlanPaymentFields}>
          <div className={styles.formGroup}>
            <label>Monto</label>
            {locked ? (
              <div className={styles.stripePlanReadonlyValue}>{formatCurrency(Number(draft.amount || 0))}</div>
            ) : (
              <div className={styles.inputWithIcon}>
                <span className={styles.inputIcon}>$</span>
                <NumberInput
                  min="0.01"
                  step="0.01"
                  value={draft.amount}
                  onChange={(event) => options.onUpdate({ amount: event.currentTarget.value })}
                  className={styles.amountInput}
                  required
                />
              </div>
            )}
          </div>

          <div className={styles.formGroup}>
            <label>Fecha</label>
            {locked ? (
              <div className={styles.stripePlanReadonlyValue}>{draft.dueDate ? formatLocalDateShort(draft.dueDate) : '-'}</div>
            ) : (
              <input
                type="date"
                value={draft.dueDate}
                onChange={(event) => options.onUpdate({ dueDate: event.currentTarget.value })}
                min={isOfflinePlanPaymentMethod(draft.method) ? undefined : getTodayInputValue()}
                required
              />
            )}
          </div>

          <div className={styles.formGroup}>
            <label>Forma de cobro</label>
            {locked ? (
              <div className={styles.stripePlanReadonlyValue}>{methodLabel}</div>
            ) : (
              <CustomSelect
                value={draft.method || defaultMethod}
                onChange={(event) => options.onUpdate({ method: event.target.value })}
              >
                {methodOptions.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </CustomSelect>
            )}
          </div>
        </div>

        <div className={styles.stripePlanPaymentActions}>
          {renderStripePlanPaymentStatusBadge(draft.status)}
          {options.onRemove && (
            <button
              type="button"
              className={styles.actionButton}
              onClick={options.onRemove}
              disabled={locked}
              title={locked ? 'No puedes eliminar un pago ya cobrado' : 'Quitar pago'}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>
    )
  }

  const renderStripePlanScheduleEditor = (plan: PaymentPlan) => {
    const provider = getLocalCheckoutPlanProvider(plan)
    const isCardSetupProvider = provider === 'stripe' || provider === 'conekta'
    const schedule = getStripePlanSchedulePayload(plan)
    const cardSetupRequired = Boolean(schedule.cardSetupRequired)
    const cardSetupAmount = Number(schedule.cardSetupAmount || 0)
    const cardSetupStatus = String(schedule.cardSetupStatus || '').toLowerCase()

    return (
      <section className={styles.stripePlanEditor} aria-label="Calendario del plan">
        <div className={styles.stripePlanControls}>
          <div className={styles.formGroup}>
            <label>Frecuencia base</label>
            <CustomSelect name="remainingFrequency" defaultValue={schedule.remainingFrequency || 'custom'}>
              {STRIPE_PLAN_FREQUENCY_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </CustomSelect>
          </div>
        </div>

        <div className={styles.stripePlanPaymentRows}>
          {isCardSetupProvider && cardSetupRequired && (
            <div className={styles.stripePlanPaymentRow}>
              <div className={styles.stripePlanPaymentMeta}>
                <strong>Domiciliación</strong>
              </div>
              <div className={`${styles.stripePlanPaymentFields} ${styles.stripePlanPaymentFieldsCompact}`}>
                <div className={styles.formGroup}>
                  <label>Monto</label>
                  <div className={styles.stripePlanReadonlyValue}>{cardSetupAmount > 0 ? formatCurrency(cardSetupAmount) : 'Autorización'}</div>
                </div>
                <div className={styles.formGroup}>
                  <label>Forma de cobro</label>
                  <div className={styles.stripePlanReadonlyValue}>Tarjeta / enlace</div>
                </div>
              </div>
              <div className={styles.stripePlanPaymentActions}>
                {renderStripePlanPaymentStatusBadge(cardSetupStatus || 'pending')}
              </div>
            </div>
          )}

          {stripePlanFirstPaymentDraft && renderStripePaymentDraftRow(stripePlanFirstPaymentDraft, 0, {
            provider,
            kind: 'first',
            onUpdate: updateStripeFirstPaymentDraft,
            onRemove: removeStripeFirstPaymentDraft
          })}

          {stripePlanInstallmentDrafts.map((draft, index) => renderStripePaymentDraftRow(draft, index, {
            provider,
            kind: 'installment',
            onUpdate: (updates) => updateStripeInstallmentDraft(draft.localId, updates),
            onRemove: () => removeStripeInstallmentDraft(draft.localId)
          }))}

          {stripePlanInstallmentDrafts.length === 0 && (
            <div className={styles.stripePlanEmpty}>Este plan todavía no tiene pagos restantes configurados.</div>
          )}
        </div>

        <div className={styles.stripePlanAddRow}>
          {!stripePlanFirstPaymentDraft && (
            <Button type="button" variant="secondary" size="sm" onClick={addStripeFirstPaymentDraft}>
              <Plus size={16} />
              Agregar primer pago
            </Button>
          )}
          <Button type="button" variant="secondary" size="sm" onClick={addStripeInstallmentDraft}>
            <Plus size={16} />
            Agregar pago
          </Button>
        </div>
      </section>
    )
  }

  const paymentPlanColumns: Column<PaymentPlan>[] = [
    {
      key: 'startDate',
      header: renderDateHeader('(de inicio)'),
      render: (_value, item) => formatLocalDateShort(getPaymentPlanStartDate(item)),
      searchValue: (_value, item) => getPaymentPlanStartDate(item),
      sortable: true
    },
    {
      key: 'nextRunAt',
      header: renderDateHeader('(próximo pago)'),
      render: (_value, item) => {
        const nextDate = getPaymentPlanNextDate(item)
        return nextDate ? formatLocalDateShort(nextDate) : '-'
      },
      searchValue: (_value, item) => getPaymentPlanNextDate(item) || '-',
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (_value, item) => getPlanStatusBadge(getPlanFilterStatus(item)),
      searchValue: (_value, item) => getPaymentPlanStatusBadge(getPlanFilterStatus(item)).label,
      sortable: true
    },
    {
      key: 'total',
      header: 'Monto',
      render: (value) => formatCurrency(Number(value || 0)),
      sortable: true
    },
    {
      key: 'name',
      header: 'Plan',
      render: (value, item) => (
        <button
          className={styles.nameButton}
          onClick={(event) => {
            event.stopPropagation()
            handleOpenPaymentPlan(item)
          }}
        >
          {value || item.title || 'Plan de pago'}
        </button>
      ),
      sortable: true
    },
    {
      key: 'contactName',
      header: 'Contacto',
      render: (value) => value ? formatName(value) : '-',
      sortable: true
    },
    {
      key: 'recurrenceLabel',
      header: 'Recurrencia',
      render: (value) => value || '-',
      sortable: true
    },
    {
      key: 'paymentProgress',
      header: 'Avance',
      render: (_value, item) => {
        const progress = getPaymentPlanProgress(item)

        if (!progress.known) {
          return (
            <div className={styles.planProgressCell}>
              <span className={styles.planProgressMuted}>Sin detalle</span>
            </div>
          )
        }

        return (
          <div className={styles.planProgressCell} title={`Faltan ${progress.remaining} pago${progress.remaining === 1 ? '' : 's'}`}>
            <span className={styles.planProgressLabel}>
              {progress.completed}/{progress.total} pagos
            </span>
            <progress
              className={styles.planProgressBar}
              value={progress.completed}
              max={progress.total}
              aria-label={`${progress.completed} de ${progress.total} pagos completados`}
            />
          </div>
        )
      },
      searchValue: (_value, item) => {
        const progress = getPaymentPlanProgress(item)
        return progress.known ? `${progress.completed}/${progress.total}` : 'sin detalle'
      },
      sortable: false
    },
    {
      key: 'description',
      header: 'Descripción',
      render: (value) => value || '-',
      sortable: false,
      visible: false
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      visible: false
    },
    {
      key: 'actions',
      header: 'Acciones',
      render: (_value, item) => {
        const status = getNormalizedPlanStatus(item)
        const actionInProgress = paymentPlanActionId?.startsWith(`${item.id}:`) || false
        const stripePlan = isStripePaymentPlan(item)
        const conektaPlan = isConektaPaymentPlan(item)
        const mercadoPagoPlan = isMercadoPagoPaymentPlan(item)
        const activationLabel = status === 'paused' ? 'Continuar plan' : 'Activar plan'

        return (
          <div className={styles.actions} onClick={(event) => event.stopPropagation()}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={styles.actionButton}
                  title="Acciones del plan"
                  disabled={actionInProgress}
                >
                  <MoreVertical size={16} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={actionInProgress} onClick={() => handleOpenPaymentPlan(item)}>
                  <Edit size={16} />
                  <span style={{ marginLeft: '8px' }}>{stripePlan ? 'Ver plan Stripe' : conektaPlan ? 'Ver plan Conekta' : mercadoPagoPlan ? 'Ver plan Mercado Pago' : 'Editar factura'}</span>
                </DropdownMenuItem>

                {canActivatePaymentPlan(item) && (
                  <DropdownMenuItem disabled={actionInProgress} onClick={() => handlePaymentPlanAction(item, 'activate')}>
                    <PlayCircle size={16} />
                    <span style={{ marginLeft: '8px' }}>{activationLabel}</span>
                  </DropdownMenuItem>
                )}

                {canPausePaymentPlan(item) && (
                  <DropdownMenuItem disabled={actionInProgress} onClick={() => handlePaymentPlanAction(item, 'pause')}>
                    <PauseCircle size={16} />
                    <span style={{ marginLeft: '8px' }}>Pausar plan</span>
                  </DropdownMenuItem>
                )}

                {(canCancelPaymentPlan(item) || canDeletePaymentPlan(item)) && (
                  <DropdownMenuSeparator />
                )}

                {canCancelPaymentPlan(item) && (
                  <DropdownMenuItem
                    disabled={actionInProgress}
                    onClick={() => handlePaymentPlanAction(item, 'cancel')}
                    className={styles.destructive}
                  >
                    <Ban size={16} />
                    <span style={{ marginLeft: '8px' }}>Cancelar plan</span>
                  </DropdownMenuItem>
                )}

                {canDeletePaymentPlan(item) && (
                  <DropdownMenuItem
                    disabled={actionInProgress}
                    onClick={() => handlePaymentPlanAction(item, 'delete')}
                    className={styles.destructive}
                  >
                    <Trash2 size={16} />
                    <span style={{ marginLeft: '8px' }}>Eliminar plan</span>
                  </DropdownMenuItem>
                )}
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

  const totals = {
    ingresos: summary?.totalRevenue || 0,
    completados: summary?.completedPayments || 0,
    ticketPromedio: summary?.averageTicket || 0,
    reembolsos: summary?.refunds || 0,
    ingresosChange: summary ? transactionsService.calculateDelta(summary.totalRevenue, summary.totalRevenuePrev) : 0,
    completadosChange: summary ? transactionsService.calculateDelta(summary.completedPayments, summary.completedPaymentsPrev) : 0,
    ticketChange: summary ? transactionsService.calculateDelta(summary.averageTicket, summary.averageTicketPrev) : 0,
    reembolsosChange: summary ? transactionsService.calculateDelta(summary.refunds, summary.refundsPrev) : 0
  }

  const transactionsRefreshing = paymentTableTab === 'transactions' && loading && hasLoadedTransactions
  const paymentPlanTotals = useMemo(() => {
    return paymentPlans.reduce((acc, plan) => {
      const status = getPlanFilterStatus(plan)
      acc.total += 1

      if (['active', 'scheduled', 'pending', 'sent'].includes(status)) {
        acc.active += 1
      }

      if (['paused', 'inactive', 'draft', 'cancelled', 'canceled', 'deleted'].includes(status)) {
        acc.inactive += 1
      }

      if (['completed', 'complete'].includes(status)) {
        acc.completed += 1
      }

      return acc
    }, {
      total: 0,
      active: 0,
      inactive: 0,
      completed: 0
    })
  }, [paymentPlans])

  if (paymentTableTab === 'transactions' && loading && !hasLoadedTransactions) {
    return <Loading message="Cargando pagos..." page="transactions" />
  }

  const lockedContactName = modal.transaction?.contactName || modal.selectedContact?.name || 'Sin nombre'
  const lockedContactDetail = modal.transaction?.email || modal.selectedContact?.email || modal.transaction?.phone || modal.selectedContact?.phone
  const isPaymentPlansPage = paymentTableTab === 'payment-plans'
  const selectedPaymentPlanIsStripe = paymentPlanModal.plan ? isStripePaymentPlan(paymentPlanModal.plan) : false
  const selectedPaymentPlanIsLocalCheckout = paymentPlanModal.plan ? isLocalCheckoutPaymentPlan(paymentPlanModal.plan) : false
  const selectedPaymentPlanHasDraftRows = Boolean(stripePlanFirstPaymentDraft) || stripePlanInstallmentDrafts.length > 0
  const selectedPaymentPlanDisplayTotal = selectedPaymentPlanIsLocalCheckout && selectedPaymentPlanHasDraftRows
    ? stripePlanDraftTotal
    : Number(paymentPlanModal.plan?.total || 0)
  const selectedPaymentPlanRemainingTotal = selectedPaymentPlanIsLocalCheckout
    ? stripePlanInstallmentsTotal
    : Number(paymentPlanModal.plan?.total || 0)
  const canProgramPaymentPlan = stripeConnected || conektaConnected || highLevelConnected
  const paymentPlanConnectionLoading = stripeStatusLoading || highLevelLoading
  const paymentsRefreshBusy = syncing || paymentPlansLoading
  const paymentsRefreshLabel = isPaymentPlansPage ? 'Actualizar planes de pago' : 'Actualizar transacciones'
  const pageTitle = isPaymentPlansPage ? 'Planes de pago' : 'Transacciones'
  const pageSubtitle = isPaymentPlansPage
    ? 'Administra facturas recurrentes, estados y próximas ejecuciones.'
    : 'Monitorea ingresos, reembolsos y tickets promedio de tus operaciones.'

  return (
    <PageContainer>
      <div className={styles.container}>
        <PageHeader
          title={pageTitle}
          subtitle={pageSubtitle}
          actions={(
            <Button
              type="button"
              variant="secondary"
              leftIcon={<Settings size={16} />}
              onClick={() => navigate('/settings/payments/gateways')}
            >
              Configurar pasarelas
            </Button>
          )}
        />

        <div className={styles.controlsRow}>
          {!isPaymentPlansPage ? (
            <div className={styles.dateFilters}>
              {statusFilterControl}
              <TabList
                tabs={[
                  {
                    value: 'all',
                    label: 'Todos',
                    description: 'Muestra todos los pagos, sin limitar por rango de fechas.'
                  },
                  {
                    value: 'by-date',
                    label: 'Por fecha',
                    description: 'Activa el calendario para revisar pagos de un periodo específico.'
                  }
                ]}
                activeTab={viewMode}
                onTabChange={(value) => {
                  if (isTransactionsViewMode(value)) {
                    setViewMode(value)
                    navigateTransactionsPath(buildTransactionsPath(value))
                  }
                }}
                variant="compact"
              />
              {viewMode === 'by-date' && (
                <DateRangePicker
                  startDate={formatDateToISO(dateRange.start)}
                  endDate={formatDateToISO(dateRange.end)}
                  onChange={(start, end) => setDateRange({
                    start: parseLocalDateString(start),
                    end: parseLocalDateString(end),
                    preset: 'custom'
                  })}
                />
              )}
            </div>
          ) : (
            <div className={styles.dateFilters}>
              {paymentPlans.length > 0 ? statusFilterControl : null}
            </div>
          )}
          <div className={styles.actions}>
            {paymentTableTab === 'transactions' && (
              <Button
                variant="secondary"
                onClick={() => {
                  setRecordPaymentInitialMode('single')
                  setShowRecordPaymentModal(true)
                  navigateTransactionsPath(buildCreateTransactionPath(viewMode))
                }}
              >
                <Plus size={16} />
                Registrar pago
              </Button>
            )}
            {isPaymentPlansPage && (
              <Button
                variant="secondary"
                onClick={openPaymentPlanCreateModal}
                disabled={paymentPlanConnectionLoading || !canProgramPaymentPlan}
                title={!canProgramPaymentPlan ? 'Conecta una pasarela compatible para programar planes' : undefined}
              >
                <Plus size={16} />
                Programar plan
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              iconOnly
              aria-label={paymentsRefreshLabel}
              title={paymentsRefreshLabel}
              onClick={handleSync}
              disabled={paymentsRefreshBusy}
              leftIcon={<RefreshCw size={16} className={paymentsRefreshBusy ? styles.spinning : ''} />}
            />
          </div>
        </div>

        {!isPaymentPlansPage && (
          <div className={styles.kpiRow}>
            <KpiCard
              title="Ingresos Netos"
              value={formatCurrency(totals.ingresos)}
              delta={totals.ingresosChange}
              deltaLabel="vs periodo anterior"
              loading={transactionsRefreshing}
              icon={<DollarSign className="text-[var(--color-text-tertiary)]" />}
            />
            <KpiCard
              title="Pagos Completados"
              value={formatNumber(totals.completados)}
              delta={totals.completadosChange}
              deltaLabel="vs periodo anterior"
              loading={transactionsRefreshing}
              icon={<CheckCircle className="text-[var(--color-text-tertiary)]" />}
            />
            <KpiCard
              title="Ticket Promedio"
              value={formatCurrency(totals.ticketPromedio)}
              delta={totals.ticketChange}
              deltaLabel="vs periodo anterior"
              loading={transactionsRefreshing}
              icon={<Receipt className="text-[var(--color-text-tertiary)]" />}
            />
            <KpiCard
              title="Reembolsos"
              value={formatNumber(totals.reembolsos)}
              delta={totals.reembolsosChange}
              deltaLabel="vs periodo anterior"
              loading={transactionsRefreshing}
              icon={<RotateCcw className="text-[var(--color-text-tertiary)]" />}
            />
          </div>
        )}

        {isPaymentPlansPage && (
          <div className={styles.kpiRow}>
            <KpiCard
              title="Planes activos"
              value={formatNumber(paymentPlanTotals.active)}
              loading={paymentPlansLoading}
              icon={<PlayCircle className="text-[var(--color-text-tertiary)]" />}
            />
            <KpiCard
              title="Planes inactivos"
              value={formatNumber(paymentPlanTotals.inactive)}
              loading={paymentPlansLoading}
              icon={<PauseCircle className="text-[var(--color-text-tertiary)]" />}
            />
            <KpiCard
              title="Completados"
              value={formatNumber(paymentPlanTotals.completed)}
              loading={paymentPlansLoading}
              icon={<CheckCircle className="text-[var(--color-text-tertiary)]" />}
            />
            <KpiCard
              title="No completados"
              value={formatNumber(Math.max(paymentPlanTotals.total - paymentPlanTotals.completed, 0))}
              loading={paymentPlansLoading}
              icon={<Clock className="text-[var(--color-text-tertiary)]" />}
            />
          </div>
        )}

      <Card padding="none">
        {!isPaymentPlansPage ? (
          <Table
            key="transactions_table"
            initialColumns={columns}
            data={filteredTransactions}
            keyExtractor={(item) => item.id}
            emptyMessage="No hay pagos disponibles"
            loading={transactionsRefreshing}
            searchable={true}
            searchPlaceholder="Buscar pagos..."
            serverSideSearch={true}
            searchTerm={transactionSearchTerm}
            onSearchTermChange={setTransactionSearchTerm}
            paginated={true}
            pageSize={20}
            searchPosition="left"
            tableId="transactions"
            initialSortBy="date"
            initialSortOrder="desc"
            selectionActions={transactionSelectionToolbar}
            rowSelection={{
              selectedKeys: selectedTransactionIds,
              onChange: setSelectedTransactionIds,
              getRowLabel: (item) => item.title || item.contactName || 'pago',
              selectVisibleLabel: 'Seleccionar pagos visibles'
            }}
          />
        ) : (
          <Table
            key="payment_plans_table"
            initialColumns={paymentPlanColumns}
            data={filteredPaymentPlans}
            keyExtractor={(item) => item.id}
            onRowClick={handleOpenPaymentPlan}
            emptyMessage={canProgramPaymentPlan ? 'No hay planes de pago' : 'Conecta una pasarela compatible para ver y programar planes de pago'}
            loading={paymentPlansLoading}
            searchable={true}
            searchPlaceholder="Buscar planes de pago..."
            paginated={true}
            pageSize={20}
            searchPosition="left"
            tableId="payment_plans"
            initialSortBy="startDate"
            initialSortOrder="desc"
            selectionActions={paymentPlanSelectionToolbar}
            rowSelection={{
              selectedKeys: selectedPaymentPlanIds,
              onChange: setSelectedPaymentPlanIds,
              getRowLabel: (item) => item.name || item.title || 'plan de pago',
              selectVisibleLabel: 'Seleccionar planes visibles'
            }}
          />
        )}
      </Card>

      <Modal
        isOpen={transactionsPendingDeletion.length > 0}
        onClose={closeTransactionDeleteModal}
        type="confirm"
        size="sm"
        title={`Eliminar pago${transactionsPendingDeletion.length === 1 ? '' : 's'}`}
        message={`Vas a eliminar ${transactionsPendingDeletion.length} pago${transactionsPendingDeletion.length === 1 ? '' : 's'}. Esta acción borra los registros seleccionados y no se puede deshacer.`}
        confirmText="Eliminar"
        cancelText="Cancelar"
        typeToConfirm="ELIMINAR"
        closeOnBackdropClick={false}
        closeOnEscape={false}
        onConfirm={handleConfirmDeleteTransactions}
      />

      <Modal
        isOpen={paymentPlansPendingDeletion.length > 0}
        onClose={closePaymentPlanDeleteModal}
        type="confirm"
        size="sm"
        title={`Eliminar plan${paymentPlansPendingDeletion.length === 1 ? '' : 'es'} de pago`}
        message={`Vas a eliminar ${paymentPlansPendingDeletion.length} plan${paymentPlansPendingDeletion.length === 1 ? '' : 'es'} de pago. Los planes de prueba se borran junto con sus pagos relacionados; los planes en vivo siguen protegidos si tienen historial real.`}
        confirmText="Eliminar"
        cancelText="Cancelar"
        typeToConfirm="ELIMINAR"
        closeOnBackdropClick={false}
        closeOnEscape={false}
        onConfirm={handleConfirmDeletePaymentPlans}
      />

      {isClient && modal.type && createPortal(
        <div className={styles.modalOverlay} data-overlay="">
          <div
            className={styles.modal}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="md"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <div>
                <h2>{modal.type === 'create' ? 'Nuevo Pago' : 'Editar Pago'}</h2>
              </div>
              <button
                className={styles.closeButton}
                type="button"
                onClick={closeTransactionModal}
                title="Cerrar"
                aria-label="Cerrar modal de pago"
              >
                <X size={20} />
              </button>
            </div>
            <form className={styles.form} data-modal-form="" onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              handleSaveTransaction(formData)
            }}>
              {modal.type === 'edit' ? (
                <div className={styles.formGroup}>
                  <label>Contacto</label>
                  <div className={styles.lockedContact}>
                    <span className={styles.lockedContactName}>{formatName(lockedContactName)}</span>
                    {lockedContactDetail && (
                      <span className={styles.lockedContactDetail}>{lockedContactDetail}</span>
                    )}
                  </div>
                </div>
              ) : (
                <div className={styles.formGroup}>
                  <ContactSearchInput
                    value={modal.selectedContact || null}
                    onChange={(contact) => setModal({ ...modal, selectedContact: contact })}
                    placeholder="Buscar contacto por nombre, email o teléfono"
                    required
                  />
                </div>
              )}
              <div className={styles.formGroup}>
                <label>Monto ({accountCurrency})</label>
                <div className={styles.inputWithIcon}>
                  <span className={styles.inputIcon}>$</span>
                  <input
                    name="amount"
                    type="text"
                    pattern="[0-9]*[.]?[0-9]+"
                    inputMode="decimal"
                    placeholder="0.00"
                    defaultValue={modal.transaction?.amount}
                    required
                    className={styles.amountInput}
                  />
                </div>
                <div className={styles.currencyNote}>
                  <span>Moneda de cuenta</span>
                  <strong>{accountCurrency}</strong>
                </div>
              </div>
              <div className={styles.formGroup}>
                <label>Método de pago</label>
                <CustomSelect name="method" defaultValue={modal.transaction?.method || 'card'}>
                  <option value="card">Tarjeta</option>
                  <option value="transfer">Transferencia</option>
                  <option value="cash">Efectivo</option>
                  <option value="paypal">PayPal</option>
                  <option value="other">Otro</option>
                </CustomSelect>
              </div>
              <div className={styles.formGroup}>
                <label>Estado</label>
                <CustomSelect name="status" defaultValue={modal.transaction?.status || 'draft'}>
                  <option value="draft">Borrador</option>
                  <option value="sent">Enviado</option>
                  <option value="pending">Pendiente</option>
                  <option value="paid">Pagado</option>
                  <option value="partial">Pago parcial</option>
                  <option value="overdue">Vencido</option>
                  <option value="void">Anulado</option>
                  <option value="refunded">Reembolsado</option>
                  <option value="failed">Fallido</option>
                </CustomSelect>
              </div>
              <div className={styles.formGroup}>
                <label>Fecha de pago / emisión</label>
                <input
                  name="date"
                  type="date"
                  defaultValue={toDateInputValue(modal.transaction?.date)}
                  required
                />
              </div>
              <div className={styles.formGroup}>
                <label>Fecha de vencimiento</label>
                <input
                  name="dueDate"
                  type="date"
                  defaultValue={modal.transaction?.dueDate ? toDateInputValue(modal.transaction.dueDate) : ''}
                />
              </div>
              <div className={styles.formGroup}>
                <label>Referencia</label>
                <input
                  name="reference"
                  type="text"
                  defaultValue={modal.transaction?.reference}
                />
              </div>
              <div className={styles.formGroup}>
                <label>Título de factura</label>
                <input
                  name="title"
                  type="text"
                  placeholder="Pago"
                  defaultValue={modal.transaction?.title || modal.transaction?.description || ''}
                />
              </div>
              <div className={styles.formGroup}>
                <label>Descripción del producto / detalle</label>
                <input
                  name="description"
                  type="text"
                  defaultValue={modal.transaction?.description}
                />
              </div>
              <div className={styles.formActions} data-modal-footer="">
                <Button type="button" variant="ghost" onClick={closeTransactionModal}>
                  Cancelar
                </Button>
                <Button type="submit">
                  {modal.type === 'create' ? 'Crear' : 'Guardar'}
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {isClient && paymentPlanCreateModal.open && createPortal(
        <div className={styles.modalOverlay} data-overlay="">
          <div
            className={`${styles.modal} ${styles.paymentPlanModal}`}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="lg"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <div>
                <h2>Programar plan de pago</h2>
                <p className={styles.modalSubtitle}>Crea un plan recurrente y déjalo programado en tu pasarela conectada.</p>
              </div>
              <button
                className={styles.closeButton}
                type="button"
                onClick={closePaymentPlanCreateModal}
                title="Cerrar"
              >
                <X size={20} />
              </button>
            </div>

            <form className={styles.form} data-modal-form="" onSubmit={(e) => {
              e.preventDefault()
              handleCreatePaymentPlan(new FormData(e.currentTarget))
            }}>
              <div className={styles.paymentPlanFormGrid}>
                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <ContactSearchInput
                    value={paymentPlanCreateModal.selectedContact}
                    onChange={(contact) => setPaymentPlanCreateModal(prev => ({ ...prev, selectedContact: contact }))}
                    placeholder="Buscar contacto por nombre, email o teléfono"
                    required
                  />
                </div>

                <div className={styles.formGroup}>
                  <label>Nombre del plan</label>
                  <input
                    name="name"
                    type="text"
                    placeholder="Plan mensual"
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Título de factura</label>
                  <input
                    name="title"
                    type="text"
                    defaultValue="PLAN DE PAGO"
                    required
                  />
                </div>

                <div className={styles.formGroup}>
                  <label>Monto por cobro</label>
                  <div className={styles.inputWithIcon}>
                    <span className={styles.inputIcon}>$</span>
                    <input
                      name="total"
                      type="text"
                      pattern="[0-9]*[.]?[0-9]+"
                      inputMode="decimal"
                      placeholder="0.00"
                      required
                      className={styles.amountInput}
                    />
                  </div>
                </div>
                <div className={styles.formGroup}>
                  <label>Recurrencia</label>
                  <CustomSelect
                    name="frequency"
                    value={paymentPlanCreateModal.frequency}
                    onChange={(event) => setPaymentPlanCreateModal(prev => ({
                      ...prev,
                      frequency: event.target.value as PaymentPlanCreateModalData['frequency']
                    }))}
                  >
                    <option value="daily">Diario</option>
                    <option value="weekly">Semanal</option>
                    <option value="monthly">Mensual</option>
                    <option value="yearly">Anual</option>
                  </CustomSelect>
                </div>
                <div className={styles.formGroup}>
                  <label>Intervalo</label>
                  <NumberInput
                    name="interval"
                    min="1"
                    defaultValue="1"
                    required
                  />
                </div>

                <div className={styles.formGroup}>
                  <label>Termina</label>
                  <CustomSelect
                    name="endType"
                    value={paymentPlanCreateModal.endType}
                    onChange={(event) => setPaymentPlanCreateModal(prev => ({
                      ...prev,
                      endType: event.target.value as PaymentPlanCreateModalData['endType']
                    }))}
                  >
                    <option value="never">Nunca</option>
                    <option value="count">Después de N cobros</option>
                    <option value="by">En una fecha</option>
                  </CustomSelect>
                </div>
                {paymentPlanCreateModal.endType === 'count' && (
                  <div className={styles.formGroup}>
                    <label>Número de cobros</label>
                    <NumberInput
                      name="count"
                      min="1"
                      max="9999"
                      defaultValue="12"
                      required
                    />
                  </div>
                )}
                {paymentPlanCreateModal.endType === 'by' && (
                  <>
                    <div className={styles.formGroup}>
                      <label>Fecha final</label>
                      <input
                        name="endDate"
                        type="date"
                        min={getTodayInputValue()}
                        required
                      />
                    </div>
                    <div className={styles.formGroup}>
                      <label>Hora final</label>
                      <input
                        name="endTime"
                        type="time"
                      />
                    </div>
                  </>
                )}
                <div className={styles.formGroup}>
                  <label>Enviar factura días antes del cobro</label>
                  <NumberInput
                    name="daysBefore"
                    min="0"
                    defaultValue="0"
                  />
                </div>

                {paymentPlanCreateModal.frequency === 'weekly' && (
                  <div className={styles.formGroup}>
                    <label>Día de la semana</label>
                    <CustomSelect name="dayOfWeek" defaultValue="mo">
                      {WEEKDAY_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </CustomSelect>
                  </div>
                )}

                {(paymentPlanCreateModal.frequency === 'monthly' || paymentPlanCreateModal.frequency === 'yearly') && (
                  <>
                    <div className={styles.formGroup}>
                      <label>Regla mensual</label>
                      <CustomSelect
                        name="monthlyMode"
                        value={paymentPlanCreateModal.monthlyMode}
                        onChange={(event) => setPaymentPlanCreateModal(prev => ({
                          ...prev,
                          monthlyMode: event.target.value as PaymentPlanCreateModalData['monthlyMode']
                        }))}
                      >
                        <option value="dayOfMonth">Día del mes</option>
                        <option value="weekOfMonth">Semana del mes</option>
                      </CustomSelect>
                    </div>
                    {paymentPlanCreateModal.frequency === 'yearly' && (
                      <div className={styles.formGroup}>
                        <label>Mes del año</label>
                        <CustomSelect name="monthOfYear" defaultValue="jan">
                          {MONTH_OPTIONS.map(option => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </CustomSelect>
                      </div>
                    )}

                    {paymentPlanCreateModal.monthlyMode === 'dayOfMonth' ? (
                      <div className={styles.formGroup}>
                        <label>Día del mes</label>
                        <CustomSelect name="dayOfMonth" defaultValue="1">
                          <option value="-1">Último día del mes</option>
                          {Array.from({ length: 28 }).map((_, index) => (
                            <option key={index + 1} value={index + 1}>{index + 1}</option>
                          ))}
                        </CustomSelect>
                      </div>
                    ) : (
                      <>
                        <div className={styles.formGroup}>
                          <label>Semana del mes</label>
                          <CustomSelect name="numOfWeek" defaultValue="1">
                            <option value="1">Primera</option>
                            <option value="2">Segunda</option>
                            <option value="3">Tercera</option>
                            <option value="4">Cuarta</option>
                            <option value="-1">Última</option>
                          </CustomSelect>
                        </div>
                        <div className={styles.formGroup}>
                          <label>Día de la semana</label>
                          <CustomSelect name="dayOfWeek" defaultValue="mo">
                            {WEEKDAY_OPTIONS.map(option => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                          </CustomSelect>
                        </div>
                      </>
                    )}
                  </>
                )}

                <label className={`${styles.checkboxRow} ${styles.fullWidth}`}>
                  <input name="useStartAsPrimaryUserAccepted" type="checkbox" />
                  <span>Usar fecha de inicio como fecha aceptada por el usuario principal</span>
                </label>

                <div className={styles.formGroup}>
                  <label>Fecha de inicio</label>
                  <input
                    name="startDate"
                    type="date"
                    defaultValue={formatDateToISO(new Date())}
                    min={getTodayInputValue()}
                    required
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Hora de cobro / envío</label>
                  <input
                    name="startTime"
                    type="time"
                    defaultValue={getDefaultScheduleTime()}
                    required
                  />
                </div>

                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label>Concepto / descripción</label>
                  <input
                    name="description"
                    type="text"
                    placeholder="Mensualidad, asesoría, mantenimiento..."
                    required
                  />
                </div>

                <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                  <label>Términos / notas</label>
                  <textarea
                    name="termsNotes"
                    rows={4}
                    placeholder="Notas que irán en la factura recurrente"
                  />
                </div>
              </div>

              <div className={styles.formActions} data-modal-footer="">
                <Button type="button" variant="ghost" onClick={closePaymentPlanCreateModal}>
                  Cancelar
                </Button>
                <Button type="submit" loading={paymentPlanCreateModal.saving}>
                  Crear y programar
                </Button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {isClient && paymentPlanModal.plan && createPortal(
        <div className={styles.modalOverlay} data-overlay="">
          <div
            className={`${styles.modal} ${styles.paymentPlanModal}`}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="lg"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <div className={styles.paymentPlanModalTitle}>
                <div className={styles.paymentPlanModalTitleRow}>
                  <h2>Plan de pago</h2>
                  {getPlanStatusBadge(paymentPlanModal.plan.status)}
                </div>
                <p className={styles.modalSubtitle}>{paymentPlanModal.plan.id}</p>
              </div>
              <button
                className={styles.closeButton}
                type="button"
                onClick={closePaymentPlanModal}
                title="Cerrar"
              >
                <X size={20} />
              </button>
            </div>

            {paymentPlanModal.loading ? (
              <div className={styles.modalLoading} role="status" aria-live="polite" aria-label="Cargando detalle del plan">
                <Loader2 size={22} className={styles.spinning} aria-hidden="true" />
              </div>
            ) : (
              <form className={styles.form} data-modal-form="" onSubmit={(e) => {
                e.preventDefault()
                handleSavePaymentPlan(new FormData(e.currentTarget))
              }}>
                <div className={styles.planSummaryGrid}>
                  <div className={styles.planSummaryItem}>
                    <span>Total del plan</span>
                    <strong>{formatCurrency(selectedPaymentPlanDisplayTotal)}</strong>
                  </div>
                  <div className={styles.planSummaryItem}>
                    <span>Pagos restantes</span>
                    <strong>{formatCurrency(selectedPaymentPlanRemainingTotal)}</strong>
                  </div>
                  <div className={styles.planSummaryItem}>
                    <span>Contacto</span>
                    <strong>{paymentPlanModal.plan.contactName ? formatName(paymentPlanModal.plan.contactName) : 'Sin contacto'}</strong>
                  </div>
                  <div className={styles.planSummaryItem}>
                    <span>Recurrencia</span>
                    <strong>{paymentPlanModal.plan.recurrenceLabel || 'Sin recurrencia'}</strong>
                  </div>
                </div>

                <div className={styles.paymentPlanFormGrid}>
                  <div className={styles.formGroup}>
                    <label>Nombre del plan</label>
                    <input
                      name="name"
                      type="text"
                      defaultValue={paymentPlanModal.plan.name || paymentPlanModal.plan.title || ''}
                    />
                  </div>
                  <div className={styles.formGroup}>
                    <label>Título de factura</label>
                    <input
                      name="title"
                      type="text"
                      defaultValue={paymentPlanModal.plan.title || paymentPlanModal.plan.name || ''}
                    />
                  </div>
                  {!selectedPaymentPlanIsLocalCheckout && (
                    <>
                      <div className={styles.formGroup}>
                        <label>Monto</label>
                        <div className={styles.inputWithIcon}>
                          <span className={styles.inputIcon}>$</span>
                          <input
                            name="total"
                            type="text"
                            pattern="[0-9]*[.]?[0-9]+"
                            inputMode="decimal"
                            defaultValue={paymentPlanModal.plan.total}
                            className={styles.amountInput}
                          />
                        </div>
                      </div>
                      <div className={styles.formGroup}>
                        <label>Próximo cobro / ejecución</label>
                        <input
                          name="executeAt"
                          type="datetime-local"
                          min={`${getTodayInputValue()}T00:00`}
                          defaultValue={toDateTimeInputValue(paymentPlanModal.plan.nextRunAt || paymentPlanModal.plan.startDate)}
                        />
                      </div>
                    </>
                  )}
                  <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                    <label>Términos / notas</label>
                    <textarea
                      name="termsNotes"
                      rows={2}
                      defaultValue={getPlanTermsNotes(paymentPlanModal.plan)}
                    />
                  </div>
                </div>
                {selectedPaymentPlanIsLocalCheckout && renderStripePlanScheduleEditor(paymentPlanModal.plan)}
                <div className={`${styles.formActions} ${styles.paymentPlanFormActions}`} data-modal-footer="">
                  <div className={styles.paymentPlanSecondaryActions}>
                    {selectedPaymentPlanIsStripe && (
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={() => handleChangeStripePlanCard(paymentPlanModal.plan!)}
                        loading={paymentPlanActionId === `${paymentPlanModal.plan.id}:change_card`}
                      >
                        <CreditCard size={16} />
                        Cambiar tarjeta domiciliada
                      </Button>
                    )}
                  </div>
                  <div className={styles.paymentPlanPrimaryActions}>
                    <Button type="button" variant="ghost" onClick={closePaymentPlanModal}>
                      Cancelar
                    </Button>
                    <Button type="submit" loading={paymentPlanModal.saving}>
                      Guardar plan
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </div>
        </div>,
        document.body
      )}

      {isClient && stripeCardSetupLinkModal.open && createPortal(
        <div className={styles.modalOverlay} data-overlay="">
          <div
            className={`${styles.modal} ${styles.cardSetupLinkModal}`}
            data-modal=""
            data-modal-shell="legacy"
            data-modal-size="sm"
            data-modal-type="custom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.modalHeader} data-modal-header="">
              <div>
                <h2>Enlace de domiciliación listo</h2>
                <p className={styles.modalSubtitle}>{stripeCardSetupLinkModal.planName}</p>
              </div>
              <button
                className={styles.closeButton}
                type="button"
                onClick={closeStripeCardSetupLinkModal}
                title="Cerrar"
              >
                <X size={20} />
              </button>
            </div>

            <div className={styles.cardSetupLinkBody}>
              <div className={styles.cardSetupLinkSummary}>
                <span>Contacto</span>
                <strong>{stripeCardSetupLinkModal.contactName}</strong>
              </div>
              {stripeCardSetupLinkModal.amount > 0 && (
                <div className={styles.cardSetupLinkSummary}>
                  <span>Domiciliación</span>
                  <strong>{formatCurrency(stripeCardSetupLinkModal.amount)}</strong>
                </div>
              )}
              <div className={styles.cardSetupLinkBox}>
                {stripeCardSetupLinkModal.link}
              </div>
            </div>

            <div className={styles.formActions} data-modal-footer="">
              <Button type="button" variant="ghost" onClick={closeStripeCardSetupLinkModal}>
                Listo
              </Button>
              <Button type="button" variant="secondary" onClick={handleOpenStripeCardSetupLink}>
                <ExternalLink size={16} />
                Abrir
              </Button>
              <Button type="button" onClick={handleCopyStripeCardSetupLink}>
                <Copy size={16} />
                Copiar enlace
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      <RecordPaymentModal
        isOpen={showRecordPaymentModal}
        initialPaymentMode={recordPaymentInitialMode}
        lockPaymentMode
        onClose={() => {
          const targetPath = recordPaymentInitialMode === 'partial'
            ? buildPaymentPlansPath()
            : buildTransactionsPath(viewMode)
          setShowRecordPaymentModal(false)
          navigateTransactionsPath(targetPath, { replace: true })
        }}
        onSuccess={(context) => {
          if (context?.keepOpen) {
            fetchData()
            if (recordPaymentInitialMode === 'partial') {
              fetchPaymentPlans()
            }
            return
          }

          const targetPath = recordPaymentInitialMode === 'partial'
            ? buildPaymentPlansPath()
            : buildTransactionsPath(viewMode)
          setShowRecordPaymentModal(false)
          navigateTransactionsPath(targetPath, { replace: true })
          // El modal ya guardó el cobro o plan específico.
          // Solo recargar desde BD local (sin sync completo).
          fetchData()
          if (recordPaymentInitialMode === 'partial') {
            fetchPaymentPlans()
          }
        }}
      />
      </div>
    </PageContainer>
  )
}
