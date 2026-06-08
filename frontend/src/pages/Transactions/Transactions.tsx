import React, { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { KpiCard, Card, Button, Table, DateRangePicker, ContactSearchInput, PageContainer, TabList, TreeFilter, RecordPaymentModal, Badge, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, Loading, NumberInput, CustomSelect } from '@/components/common'
import type { Column, BadgeVariant } from '@/components/common'
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
  Eye,
  Link2,
  Send,
  Mail,
  MessageCircle,
  PauseCircle,
  PlayCircle,
  Ban,
  X
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAppConfig, useHighLevelConnected } from '@/hooks'
import { formatCurrency, formatDateToISO, formatEndDateToISO, formatNumber, parseLocalDateString, formatName } from '@/utils/format'
import { ACCOUNT_CURRENCY_CONFIG_KEY, CURRENCY_OPTIONS, getDetectedAccountLocaleDefaults } from '@/utils/accountLocale'
import { transactionsService, type Transaction, type TransactionSummary, type PaymentPlan } from '@/services/transactionsService'
import { highLevelService } from '@/services/highLevelService'
import styles from './Transactions.module.css'


interface ModalData {
  type: 'create' | 'edit' | null
  transaction?: Transaction
  selectedContact?: Contact | null
}

type PaymentsTableTab = 'transactions' | 'payment-plans'
type TransactionsViewMode = 'all' | 'by-date'
type StatusFilters = Record<string, string[]>

interface PaymentPlanModalData {
  plan: PaymentPlan | null
  loading: boolean
  saving: boolean
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

const toDateInputValue = (value?: string | null): string => {
  if (!value) return formatDateToISO(new Date())
  return String(value).split('T')[0]
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

const DELETE_CONFIRMATION_WORD = 'ELIMINAR'

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
  const detectedLocaleDefaults = useMemo(getDetectedAccountLocaleDefaults, [])
  const [defaultCurrency] = useAppConfig<string>(ACCOUNT_CURRENCY_CONFIG_KEY, detectedLocaleDefaults.currency)
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
  const [transactionsPendingDeletion, setTransactionsPendingDeletion] = useState<Transaction[]>([])
  const [transactionDeleteConfirmation, setTransactionDeleteConfirmation] = useState('')
  const [deletingTransactions, setDeletingTransactions] = useState(false)

  // Los planes de pago dependen de una integración de terceros (HighLevel).
  // Sin ella, Ristak solo registra transacciones locales: no hay tab de planes.
  const { connected: highLevelConnected } = useHighLevelConnected()
  const [transactionStatusFilters, setTransactionStatusFilters] = useState<StatusFilters>({})
  const [paymentPlanStatusFilters, setPaymentPlanStatusFilters] = useState<StatusFilters>({})
  const [viewMode, setViewMode] = useState<TransactionsViewMode>(routeState.viewMode)
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false)
  const [isClient, setIsClient] = useState(false)
  const [hasLoadedTransactions, setHasLoadedTransactions] = useState(false)
  const handledOpenPaymentRef = useRef<string | null>(null)
  const handledOpenPaymentPlanRef = useRef<string | null>(null)

  const navigatePaymentsTable = (nextTab: PaymentsTableTab, nextViewMode = viewMode) => {
    navigate(nextTab === 'payment-plans' ? buildPaymentPlansPath() : buildTransactionsPath(nextViewMode))
  }

  useEffect(() => {
    if (paymentTableTab === 'transactions') {
      fetchData()
    }
  }, [dateRange, viewMode, paymentTableTab])

  useEffect(() => {
    if (paymentTableTab === 'payment-plans') {
      fetchPaymentPlans()
    }
  }, [paymentTableTab])

  // Si la integración se desconecta, regresar a transacciones: sin HighLevel no
  // existen planes de pago que mostrar.
  useEffect(() => {
    if (!highLevelConnected && paymentTableTab === 'payment-plans') {
      setPaymentTableTab('transactions')
      navigate(buildTransactionsPath(viewMode), { replace: true })
    }
  }, [highLevelConnected, navigate, paymentTableTab, viewMode])

  useEffect(() => {
    if (!highLevelConnected && routeState.tab === 'payment-plans') {
      return
    }
    setPaymentTableTab(current => current === routeState.tab ? current : routeState.tab)
    setViewMode(current => current === routeState.viewMode ? current : routeState.viewMode)
  }, [highLevelConnected, routeState.tab, routeState.viewMode])

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
    if (paymentTableTab !== 'transactions' && selectedTransactionIds.length > 0) {
      setSelectedTransactionIds([])
    }
  }, [paymentTableTab, selectedTransactionIds.length])

  const fetchData = async (forceSync = false) => {
    setLoading(true)
    try {
      let startDate: string | undefined
      let endDate: string | undefined

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
        transactionsService.getTransactions(startDate, endDate, forceSync),
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
      showToast('error', 'No se pudieron cargar los planes de pago', 'HighLevel no devolvió la lista de facturas recurrentes. Intenta actualizar de nuevo.')
    } finally {
      setPaymentPlansLoading(false)
    }
  }

  const handlePaymentTableTabChange = (value: string) => {
    if (value !== 'transactions' && value !== 'payment-plans') return
    setPaymentTableTab(value)
    navigatePaymentsTable(value)
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      if (paymentTableTab === 'payment-plans') {
        showToast('info', 'Actualizando planes de pago', 'Consultando facturas recurrentes en HighLevel...')
        await fetchPaymentPlans()
        showToast('success', 'Planes actualizados', 'La lista de planes de pago se actualizó desde HighLevel')
        return
      }

      showToast('info', 'Sincronizando pagos', 'Obteniendo TODOS los pagos desde HighLevel...')

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
        transactionsService.getTransactions(startDate, endDate, true), // sync=true
        transactionsService.getSummary(startDate, endDate)
      ])

      setTransactions(transactionsData)
      setSummary(summaryData)
      showToast('success', 'Sincronización completa', 'Todos los pagos se han actualizado desde HighLevel')
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
    navigate(buildTransactionDetailPath(viewMode, transaction.id))
  }

  const closeTransactionModal = () => {
    setModal({ type: null, selectedContact: null })
    navigate(buildTransactionsPath(viewMode), { replace: true })
  }

  const closePaymentPlanModal = () => {
    setPaymentPlanModal({
      plan: null,
      loading: false,
      saving: false
    })
    navigate(buildPaymentPlansPath(), { replace: true })
  }

  const openPaymentPlanCreateModal = () => {
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
    navigate('/transactions/payment-plans/new')
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
    navigate(buildPaymentPlansPath(), { replace: true })
  }

  const handleOpenPaymentPlan = async (plan: PaymentPlan) => {
    setPaymentTableTab('payment-plans')
    navigate(buildPaymentPlanDetailPath(plan.id))
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
      showToast('error', 'No se pudo cargar el detalle', 'Se abrió la información disponible de la tabla, pero HighLevel no devolvió el detalle completo.')
    }
  }

  const handleSavePaymentPlan = async (formData: FormData) => {
    if (!paymentPlanModal.plan) return

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
      showToast('success', 'Plan de pago actualizado', 'La factura recurrente se actualizó en HighLevel.')
      fetchPaymentPlans()
    } catch (error: any) {
      setPaymentPlanModal(prev => ({ ...prev, saving: false }))
      showToast('error', 'No se pudo guardar el plan', error?.message || 'HighLevel rechazó la actualización del plan de pago.')
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

  const runPaymentPlanAction = async (
    plan: PaymentPlan,
    action: 'activate' | 'pause' | 'cancel' | 'delete',
    successTitle: string,
    successMessage: string
  ) => {
    const actionId = `${plan.id}:${action}`
    setPaymentPlanActionId(actionId)

    try {
      const updatedPlan = await transactionsService.actionPaymentPlan(plan.id, action)
      updatePaymentPlanInState(updatedPlan)
      showToast('success', successTitle, successMessage)
      fetchPaymentPlans()
    } catch (error: any) {
      showToast('error', 'No se pudo actualizar el plan', error?.message || 'HighLevel rechazó la acción para esta factura recurrente.')
    } finally {
      setPaymentPlanActionId(null)
    }
  }

  const handlePaymentPlanAction = (
    plan: PaymentPlan,
    action: 'activate' | 'pause' | 'cancel' | 'delete'
  ) => {
    const planName = plan.name || plan.title || 'este plan de pago'

    if (action === 'cancel') {
      showConfirm(
        'Cancelar plan de pago',
        `¿Seguro que quieres cancelar ${planName}? HighLevel dejará de generar esta factura recurrente.`,
        () => runPaymentPlanAction(plan, action, 'Plan cancelado', 'La factura recurrente quedó cancelada en HighLevel y se actualizó localmente.')
      )
      return
    }

    if (action === 'delete') {
      showConfirm(
        'Eliminar plan de pago',
        `¿Seguro que quieres eliminar ${planName}? Esta acción borra el schedule en HighLevel y lo marca como eliminado en la base local.`,
        () => runPaymentPlanAction(plan, action, 'Plan eliminado', 'La factura recurrente se eliminó en HighLevel y quedó marcada como eliminada localmente.')
      )
      return
    }

    if (action === 'pause') {
      runPaymentPlanAction(plan, action, 'Plan pausado', 'La factura recurrente quedó pausada y el registro local fue actualizado.')
      return
    }

    runPaymentPlanAction(plan, action, 'Plan activado', 'La factura recurrente quedó activa/programada en HighLevel.')
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
      showToast('success', 'Plan programado', 'El plan de pago quedó programado en HighLevel.')
      fetchPaymentPlans()
    } catch (error: any) {
      setPaymentPlanCreateModal(prev => ({ ...prev, saving: false }))
      showToast('error', 'No se pudo programar el plan', error?.message || 'HighLevel rechazó la creación del plan de pago.')
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
    setShowRecordPaymentModal(true)
  }, [routeState.createTransaction])

  useEffect(() => {
    if (!routeState.createTransaction && showRecordPaymentModal) {
      setShowRecordPaymentModal(false)
    }
  }, [routeState.createTransaction, showRecordPaymentModal])

  useEffect(() => {
    if (!routeState.createPaymentPlan) return
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
  }, [routeState.createPaymentPlan])

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
    setTransactionDeleteConfirmation('')
  }

  const closeTransactionDeleteModal = () => {
    if (deletingTransactions) return

    setTransactionsPendingDeletion([])
    setTransactionDeleteConfirmation('')
  }

  const handleConfirmDeleteTransactions = async () => {
    if (transactionsPendingDeletion.length === 0) return
    if (transactionDeleteConfirmation.trim().toUpperCase() !== DELETE_CONFIRMATION_WORD) return

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
    setTransactionDeleteConfirmation('')

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
        }
      }
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
        }
      }
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
      const link = await transactionsService.getPaymentLink(transaction.id)
      await navigator.clipboard.writeText(link)
      showToast('success', '¡Enlace copiado!', 'El enlace de pago se copió al portapapeles')
    } catch (error) {
      showToast('error', 'Error al copiar enlace', 'No se pudo obtener el enlace de pago')
    }
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
      currency: (formData.get('currency') as string) || modal.transaction?.currency || defaultCurrency || 'MXN',
      method: formData.get('method') as any,
      status: formData.get('status') as any,
      reference: formData.get('reference') as string,
      title: formData.get('title') as string,
      description: formData.get('description') as string,
      dueDate: (formData.get('dueDate') as string) || undefined
    }

    try {
      if (modal.type === 'create') {
        const newTransaction = await transactionsService.createTransaction(transaction)
        setTransactions(prev => [...prev, newTransaction])
        showToast('success', '¡Pago registrado exitosamente!', `Se registró el pago de ${formatCurrency(transaction.amount)} para ${contactSnapshot.name}`)
      } else if (modal.type === 'edit') {
        const updatedTransaction = await transactionsService.updateTransaction(transaction.id, transaction)
        setTransactions(prev => prev.map(t => t.id === updatedTransaction.id ? updatedTransaction : t))
        showToast('success', 'Pago actualizado correctamente', `Se actualizó el registro de pago de ${formatCurrency(updatedTransaction.amount)}`)
      }
      closeTransactionModal()
      fetchData()
    } catch (error: any) {
      showToast('error', 'No se pudo guardar el pago', error?.message || 'Hubo un problema al guardar la información. Verifica los datos e intenta nuevamente.')
    }
  }

  const getMethodIcon = (method: string) => {
    switch(method) {
      case 'card': return <CreditCard size={16} />
      case 'bank_transfer':
      case 'transfer': return <RefreshCw size={16} />
      case 'cash': return <Banknote size={16} />
      case 'check': return <Receipt size={16} />
      case 'paypal': return <DollarSign size={16} />
      default: return <DollarSign size={16} />
    }
  }

  const getMethodLabel = (method: string) => {
    switch(method) {
      case 'card': return 'Tarjeta'
      case 'bank_transfer':
      case 'transfer': return 'Transferencia'
      case 'cash': return 'Efectivo'
      case 'check': return 'Cheque'
      case 'paypal': return 'PayPal'
      case 'other': return 'Otro'
      default: return method.charAt(0).toUpperCase() + method.slice(1)
    }
  }

  const STATUS_BADGES: Record<string, { label: string; variant: BadgeVariant }> = {
    draft: { label: 'Borrador', variant: 'neutral' },
    sent: { label: 'Enviado', variant: 'info' },
    paid: { label: 'Pagado', variant: 'success' },
    pending: { label: 'Pendiente', variant: 'warning' },
    overdue: { label: 'Vencido', variant: 'error' },
    partial: { label: 'Pago parcial', variant: 'warning' },
    void: { label: 'Anulado', variant: 'error' },
    refunded: { label: 'Reembolsado', variant: 'error' },
    failed: { label: 'Fallido', variant: 'error' },
    deleted: { label: 'Eliminado', variant: 'neutral' }
  }

  const getStatusBadge = (status: string) => {
    const config = STATUS_BADGES[status] ?? { label: status, variant: 'neutral' as BadgeVariant }
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
      render: (value) => (
        <div className={styles.methodCell}>
          {getMethodIcon(value)}
          <span>{getMethodLabel(value)}</span>
        </div>
      ),
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

        // Copiar enlace - disponible para draft, sent, pending, overdue
        if (['draft', 'sent', 'pending', 'overdue', 'partial'].includes(item.status)) {
          actions.push('copy')
        }

        // Ver recibo - solo para pagados
        if (item.status === 'paid') {
          actions.push('view')
        }

        // Enviar - solo para draft y pending
        if (['draft', 'pending'].includes(item.status)) {
          actions.push('send')
        }

        // Editar - disponible para pagos visibles; backend valida qué puede sincronizar HighLevel
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

        // Anular - para draft, sent, pending, overdue (no para paid, void, refunded)
        if (['draft', 'sent', 'pending', 'overdue', 'partial'].includes(item.status)) {
          actions.push('void')
        }

        // Eliminar siempre disponible
        actions.push('delete')

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

  const planStatusBadges: Record<string, { label: string; variant: BadgeVariant }> = {
    active: { label: 'Activo', variant: 'info' },
    scheduled: { label: 'Programado', variant: 'warning' },
    pending: { label: 'Pendiente', variant: 'warning' },
    sent: { label: 'Enviado', variant: 'info' },
    draft: { label: 'Borrador', variant: 'neutral' },
    paused: { label: 'Pausado', variant: 'warning' },
    cancelled: { label: 'Cancelado', variant: 'error' },
    canceled: { label: 'Cancelado', variant: 'error' },
    completed: { label: 'Completado', variant: 'success' },
    failed: { label: 'Fallido', variant: 'error' },
    inactive: { label: 'Inactivo', variant: 'neutral' },
    deleted: { label: 'Eliminado', variant: 'neutral' }
  }

  const getPlanStatusBadge = (status?: string) => {
    const normalized = String(status || 'active').toLowerCase()
    const config = planStatusBadges[normalized] ?? { label: normalized, variant: 'neutral' as BadgeVariant }
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const getNormalizedPlanStatus = (plan: PaymentPlan) => String(plan.status || 'active').toLowerCase()
  const getPlanFilterStatus = (plan: PaymentPlan) => {
    const status = getNormalizedPlanStatus(plan)
    if (status === 'canceled') return 'cancelled'
    if (status === 'complete') return 'completed'
    return status
  }
  const isPlanDeleted = (plan: PaymentPlan) => getNormalizedPlanStatus(plan) === 'deleted'
  const canActivatePaymentPlan = (plan: PaymentPlan) => ['draft', 'paused', 'inactive', 'pending'].includes(getNormalizedPlanStatus(plan))
  const canPausePaymentPlan = (plan: PaymentPlan) => ['active', 'scheduled', 'pending', 'sent'].includes(getNormalizedPlanStatus(plan))
  const canCancelPaymentPlan = (plan: PaymentPlan) => !['cancelled', 'canceled', 'completed', 'complete', 'deleted'].includes(getNormalizedPlanStatus(plan))
  const canDeletePaymentPlan = (plan: PaymentPlan) => !isPlanDeleted(plan)

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
        name: STATUS_BADGES[status]?.label || status,
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
        name: planStatusBadges[status]?.label || status,
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

  // Solo se ofrece el selector Transacciones/Planes de pago cuando hay una
  // integración de terceros conectada. Sin ella se omite (undefined) y la tabla
  // no renderiza ninguna pestaña.
  const paymentTableTabs = highLevelConnected
    ? [
        { label: 'Transacciones', value: 'transactions' },
        { label: 'Planes de pago', value: 'payment-plans' }
      ]
    : undefined

  const statusFilterControl = (
    <TreeFilter
      availableData={activeStatusFilterData}
      selectedFilters={activeStatusFilters}
      onFilterChange={handleStatusFilterChange}
    />
  )

  const transactionSelectionToolbar = selectedTransactions.length > 0 ? (
    <div className={styles.selectionToolbar}>
      <span>{selectedTransactions.length} seleccionado{selectedTransactions.length === 1 ? '' : 's'}</span>
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => openTransactionDeleteModal(selectedTransactions)}
      >
        <Trash2 size={16} />
        Eliminar
      </Button>
    </div>
  ) : null

  const paymentPlanColumns: Column<PaymentPlan>[] = [
    {
      key: 'sortDate',
      header: 'Fecha',
      render: (_value, item) => formatLocalDateShort(item.sortDate || item.nextRunAt || item.updatedAt || item.createdAt || ''),
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => getPlanStatusBadge(value),
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
        const activationLabel = status === 'paused' ? 'Continuar plan' : 'Activar plan'

        if (isPlanDeleted(item)) {
          return <span className={styles.mutedAction}>-</span>
        }

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
                  <span style={{ marginLeft: '8px' }}>Editar factura</span>
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

  if (paymentTableTab === 'transactions' && loading && !hasLoadedTransactions) {
    return <Loading message="Cargando pagos..." page="transactions" />
  }

  const lockedContactName = modal.transaction?.contactName || modal.selectedContact?.name || 'Sin nombre'
  const lockedContactDetail = modal.transaction?.email || modal.selectedContact?.email || modal.transaction?.phone || modal.selectedContact?.phone

  return (
    <PageContainer>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Pagos</h1>
          <p className={styles.pageSubtitle}>Monitorea ingresos, reembolsos y tickets promedio de tus operaciones.</p>
        </div>

        <div className={styles.controlsRow}>
          {paymentTableTab === 'transactions' ? (
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
                    navigate(buildTransactionsPath(value))
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
              {statusFilterControl}
            </div>
          )}
          <div className={styles.actions}>
            <Button
              variant="secondary"
              onClick={handleSync}
              disabled={syncing || paymentPlansLoading}
            >
              <RefreshCw size={16} className={syncing || paymentPlansLoading ? styles.spinning : ''} />
              {syncing || paymentPlansLoading ? 'Actualizando...' : 'Actualizar'}
            </Button>
            {paymentTableTab === 'transactions' && (
              <Button
                variant="secondary"
                onClick={() => {
                  setShowRecordPaymentModal(true)
                  navigate(buildCreateTransactionPath(viewMode))
                }}
              >
                <Plus size={16} />
                Registrar pago
              </Button>
            )}
            {paymentTableTab === 'payment-plans' && (
              <Button
                variant="secondary"
                onClick={openPaymentPlanCreateModal}
              >
                <Plus size={16} />
                Programar plan
              </Button>
            )}
          </div>
        </div>

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

      <Card padding="none">
        {paymentTableTab === 'transactions' ? (
          <Table
            key="transactions_table"
            initialColumns={columns}
            data={filteredTransactions}
            keyExtractor={(item) => item.id}
            emptyMessage="No hay pagos disponibles"
            loading={loading && !hasLoadedTransactions}
            searchable={true}
            searchPlaceholder="Buscar pagos..."
            paginated={true}
            pageSize={20}
            filters={paymentTableTabs}
            activeFilter={paymentTableTab}
            onFilterChange={handlePaymentTableTabChange}
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
            emptyMessage="No hay planes de pago"
            loading={paymentPlansLoading}
            searchable={true}
            searchPlaceholder="Buscar planes de pago..."
            paginated={true}
            pageSize={20}
            filters={paymentTableTabs}
            activeFilter={paymentTableTab}
            onFilterChange={handlePaymentTableTabChange}
            searchPosition="left"
            tableId="payment_plans"
            initialSortBy="sortDate"
            initialSortOrder="desc"
          />
        )}
      </Card>

      {isClient && transactionsPendingDeletion.length > 0 && createPortal(
        <div className={styles.modalOverlay} onClick={closeTransactionDeleteModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h2>Eliminar pago{transactionsPendingDeletion.length === 1 ? '' : 's'}</h2>
                <p className={styles.modalSubtitle}>Esta acción borra los registros seleccionados y no se puede deshacer.</p>
              </div>
              <button
                className={styles.closeButton}
                onClick={closeTransactionDeleteModal}
                disabled={deletingTransactions}
                type="button"
              >
                <X size={20} />
              </button>
            </div>
            <p>
              Vas a eliminar <strong>{transactionsPendingDeletion.length}</strong> pago{transactionsPendingDeletion.length === 1 ? '' : 's'}.
              Para confirmar, escribe <strong>{DELETE_CONFIRMATION_WORD}</strong> en la caja de abajo.
            </p>
            <div className={styles.formGroup}>
              <label>Palabra de confirmación</label>
              <input
                value={transactionDeleteConfirmation}
                onChange={(event) => setTransactionDeleteConfirmation(event.target.value)}
                placeholder={DELETE_CONFIRMATION_WORD}
                disabled={deletingTransactions}
                autoFocus
              />
            </div>
            <div className={styles.formActions}>
              <Button type="button" variant="ghost" onClick={closeTransactionDeleteModal} disabled={deletingTransactions}>
                Cancelar
              </Button>
              <Button
                variant="danger"
                onClick={handleConfirmDeleteTransactions}
                loading={deletingTransactions}
                disabled={transactionDeleteConfirmation.trim().toUpperCase() !== DELETE_CONFIRMATION_WORD || deletingTransactions}
              >
                Sí, eliminar
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {isClient && modal.type && createPortal(
        <div className={styles.modalOverlay} onClick={closeTransactionModal}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2>{modal.type === 'create' ? 'Nuevo Pago' : 'Editar Pago'}</h2>
            <form className={styles.form} onSubmit={(e) => {
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
                <label>Monto</label>
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
              </div>
              <div className={styles.formGroup}>
                <label>Moneda</label>
                <CustomSelect name="currency" defaultValue={modal.transaction?.currency || defaultCurrency || 'MXN'}>
                  {CURRENCY_OPTIONS.map((currencyOption) => (
                    <option key={currencyOption.value} value={currencyOption.value}>{currencyOption.value}</option>
                  ))}
                </CustomSelect>
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
              <div className={styles.formActions}>
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
        <div className={styles.modalOverlay} onClick={closePaymentPlanCreateModal}>
          <div className={`${styles.modal} ${styles.paymentPlanModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h2>Programar plan de pago</h2>
                <p className={styles.modalSubtitle}>Crea una factura recurrente y déjala programada en HighLevel.</p>
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

            <form className={styles.form} onSubmit={(e) => {
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
                  <label>Tipo de programación</label>
                  <CustomSelect
                    name="scheduleMode"
                    value={paymentPlanCreateModal.scheduleMode}
                    onChange={(event) => setPaymentPlanCreateModal(prev => ({
                      ...prev,
                      scheduleMode: event.target.value as PaymentPlanCreateModalData['scheduleMode']
                    }))}
                  >
                    <option value="recurring">Recurrente</option>
                    <option value="one_time">Fecha específica</option>
                  </CustomSelect>
                </div>

                {paymentPlanCreateModal.scheduleMode === 'recurring' && (
                  <>
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
                  </>
                )}

                <div className={styles.formGroup}>
                  <label>{paymentPlanCreateModal.scheduleMode === 'one_time' ? 'Fecha específica' : 'Fecha de inicio'}</label>
                  <input
                    name="startDate"
                    type="date"
                    defaultValue={formatDateToISO(new Date())}
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

              <div className={styles.formActions}>
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
        <div className={styles.modalOverlay} onClick={closePaymentPlanModal}>
          <div className={`${styles.modal} ${styles.paymentPlanModal}`} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h2>Plan de pago</h2>
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
              <div className={styles.modalLoading}>Cargando detalle del plan...</div>
            ) : (
              <form className={styles.form} onSubmit={(e) => {
                e.preventDefault()
                handleSavePaymentPlan(new FormData(e.currentTarget))
              }}>
                <div className={styles.planSummaryGrid}>
                  <div className={styles.planSummaryItem}>
                    <span>Estado</span>
                    <strong>{getPlanStatusBadge(paymentPlanModal.plan.status)}</strong>
                  </div>
                  <div className={styles.planSummaryItem}>
                    <span>Monto</span>
                    <strong>{formatCurrency(Number(paymentPlanModal.plan.total || 0))}</strong>
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
                      defaultValue={toDateTimeInputValue(paymentPlanModal.plan.nextRunAt || paymentPlanModal.plan.startDate)}
                    />
                  </div>
                  <div className={`${styles.formGroup} ${styles.fullWidth}`}>
                    <label>Términos / notas</label>
                    <textarea
                      name="termsNotes"
                      rows={4}
                      defaultValue={getPlanTermsNotes(paymentPlanModal.plan)}
                    />
                  </div>
                </div>
                <div className={styles.formActions}>
                  <Button type="button" variant="ghost" onClick={closePaymentPlanModal}>
                    Cancelar
                  </Button>
                  <Button type="submit" loading={paymentPlanModal.saving}>
                    Guardar plan
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>,
        document.body
      )}

      <RecordPaymentModal
        isOpen={showRecordPaymentModal}
        onClose={() => {
          setShowRecordPaymentModal(false)
          navigate(buildTransactionsPath(viewMode), { replace: true })
        }}
        onSuccess={() => {
          setShowRecordPaymentModal(false)
          navigate(buildTransactionsPath(viewMode), { replace: true })
          // El modal ya sincronizó el invoice específico desde GHL.
          // Solo recargar desde BD local (sin sync completo).
          fetchData()
        }}
      />
      </div>
    </PageContainer>
  )
}
