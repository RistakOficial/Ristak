import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { KpiCard, Card, Button, Table, DateRangePicker, ContactSearchInput, PageContainer, TabList, RecordPaymentModal, Badge, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, Loading } from '@/components/common'
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
  X
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import { formatCurrency, formatDateToISO, formatEndDateToISO, formatNumber, parseLocalDateString, formatName } from '@/utils/format'
import { transactionsService, type Transaction, type TransactionSummary, type PaymentPlan } from '@/services/transactionsService'
import { highLevelService } from '@/services/highLevelService'
import styles from './Transactions.module.css'


interface ModalData {
  type: 'create' | 'edit' | null
  transaction?: Transaction
  selectedContact?: Contact | null
}

type PaymentsTableTab = 'transactions' | 'payment-plans'

interface PaymentPlanModalData {
  plan: PaymentPlan | null
  loading: boolean
  saving: boolean
  rawJson: string
}

interface PaymentPlanCreateModalData {
  open: boolean
  selectedContact: Contact | null
  saving: boolean
}

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

const buildPaymentPlanSchedule = (startDate: string, startTime: string, frequency: string, count: number) => {
  const localStart = new Date(`${startDate}T${startTime || getDefaultScheduleTime()}`)
  const dateOnly = new Date(`${startDate}T00:00:00`)
  const normalizedFrequency = frequency === 'biweekly' ? 'weekly' : frequency
  const interval = frequency === 'biweekly' ? 2 : 1
  const rrule: Record<string, any> = {
    intervalType: normalizedFrequency,
    interval,
    startDate,
    startTime: normalizeScheduleTime(startTime),
    endType: 'count',
    count
  }

  if (normalizedFrequency === 'weekly') {
    rrule.dayOfWeek = getDayOfWeekCode(dateOnly)
  }

  if (normalizedFrequency === 'monthly' || normalizedFrequency === 'yearly') {
    if (isLastDayOfMonth(dateOnly)) {
      rrule.dayOfMonth = -1
    } else if (dateOnly.getDate() <= 28) {
      rrule.dayOfMonth = dateOnly.getDate()
    }
  }

  if (normalizedFrequency === 'yearly') {
    rrule.monthOfYear = getMonthOfYearCode(dateOnly)
  }

  return {
    executeAt: localStart.toISOString(),
    rrule
  }
}

export const Transactions: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const [searchParams, setSearchParams] = useSearchParams()
  const { formatLocalDateShort } = useTimezone()
  const { showConfirm, showToast } = useNotification()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [paymentPlans, setPaymentPlans] = useState<PaymentPlan[]>([])
  const [summary, setSummary] = useState<TransactionSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [paymentPlansLoading, setPaymentPlansLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [modal, setModal] = useState<ModalData>({ type: null, selectedContact: null })
  const [paymentPlanModal, setPaymentPlanModal] = useState<PaymentPlanModalData>({
    plan: null,
    loading: false,
    saving: false,
    rawJson: ''
  })
  const [paymentPlanCreateModal, setPaymentPlanCreateModal] = useState<PaymentPlanCreateModalData>({
    open: false,
    selectedContact: null,
    saving: false
  })
  const [paymentTableTab, setPaymentTableTab] = useState<PaymentsTableTab>('transactions')
  const [viewMode, setViewMode] = useState<'all' | 'by-date'>('all') // Por defecto 'all' (Todos)
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false)
  const [isClient, setIsClient] = useState(false)
  const handledOpenPaymentRef = useRef<string | null>(null)

  const rangeStart = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
  const rangeEnd = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  const spansMultipleYears = rangeStart.getFullYear() !== rangeEnd.getFullYear()
  const tableDateOptions = { includeYear: spansMultipleYears, referenceDate: rangeEnd }

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

  useEffect(() => {
    setIsClient(true)
  }, [])

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
    setPaymentTableTab(value as PaymentsTableTab)
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

  const handleCreate = () => {
    setModal({ type: 'create', selectedContact: null })
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
  }

  const closePaymentPlanModal = () => {
    setPaymentPlanModal({
      plan: null,
      loading: false,
      saving: false,
      rawJson: ''
    })
  }

  const openPaymentPlanCreateModal = () => {
    setPaymentPlanCreateModal({
      open: true,
      selectedContact: null,
      saving: false
    })
  }

  const closePaymentPlanCreateModal = () => {
    setPaymentPlanCreateModal({
      open: false,
      selectedContact: null,
      saving: false
    })
  }

  const handleOpenPaymentPlan = async (plan: PaymentPlan) => {
    setPaymentPlanModal({
      plan,
      loading: true,
      saving: false,
      rawJson: JSON.stringify(getPlanPayload(plan), null, 2)
    })

    try {
      const detailedPlan = await transactionsService.getPaymentPlan(plan.id)
      setPaymentPlanModal({
        plan: detailedPlan,
        loading: false,
        saving: false,
        rawJson: JSON.stringify(getPlanPayload(detailedPlan), null, 2)
      })
    } catch (error) {
      setPaymentPlanModal(prev => ({ ...prev, loading: false }))
      showToast('error', 'No se pudo cargar el detalle', 'Se abrió la información disponible de la tabla, pero HighLevel no devolvió el detalle completo.')
    }
  }

  const handleSavePaymentPlan = async (formData: FormData) => {
    if (!paymentPlanModal.plan) return

    let payload: Record<string, any>
    try {
      payload = JSON.parse(paymentPlanModal.rawJson || '{}')
    } catch {
      showToast('error', 'JSON inválido', 'Revisa el bloque de datos avanzados del plan antes de guardar.')
      return
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      showToast('error', 'Datos inválidos', 'La plantilla del plan debe ser un objeto JSON.')
      return
    }

    const name = String(formData.get('name') || '').trim()
    const title = String(formData.get('title') || '').trim()
    const currency = String(formData.get('currency') || '').trim().toUpperCase()
    const amount = parseFloat(String(formData.get('total') || ''))
    const executeAt = String(formData.get('executeAt') || '').trim()
    const termsNotes = String(formData.get('termsNotes') || '').trim()

    if (name) payload.name = name
    if (title) payload.title = title
    if (currency) payload.currency = currency
    if (Number.isFinite(amount) && amount > 0) payload.total = amount
    payload.termsNotes = termsNotes || null

    if (executeAt) {
      payload.schedule = payload.schedule && typeof payload.schedule === 'object'
        ? payload.schedule
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
    const frequency = String(formData.get('frequency') || 'monthly')
    const currency = String(formData.get('currency') || 'MXN').trim().toUpperCase()
    const title = String(formData.get('title') || 'PLAN DE PAGO').trim()
    const rawName = String(formData.get('name') || '').trim()
    const description = String(formData.get('description') || '').trim()
    const termsNotes = String(formData.get('termsNotes') || '').trim()

    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('error', 'Monto inválido', 'El monto por cobro debe ser mayor a cero.')
      return
    }

    if (!Number.isFinite(count) || count < 1) {
      showToast('error', 'Número de cobros inválido', 'Pon al menos un cobro para programar el plan.')
      return
    }

    if (!startDate) {
      showToast('error', 'Fecha requerida', 'Elige cuándo debe iniciar el plan de pago.')
      return
    }

    const contactName = formatName(contact.name || contact.email || contact.phone || 'Cliente')
    const name = rawName || `${description || 'Plan de pago'} - ${contactName}`
    const schedule = buildPaymentPlanSchedule(startDate, startTime, frequency, count)
    const email = contact.email || ''
    const phone = contact.phone || ''

    const payload = {
      name,
      title,
      currency,
      total: amount,
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
          currency,
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
    const paymentId = searchParams.get('id')

    if (openType !== 'payment' || !paymentId) {
      handledOpenPaymentRef.current = null
      return
    }

    if (handledOpenPaymentRef.current === paymentId) {
      return
    }

    handledOpenPaymentRef.current = paymentId
    let isMounted = true

    const clearOpenParams = () => {
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
  }, [searchParams, setSearchParams, showToast, transactions])

  const handleDelete = async (id: string) => {
    showConfirm(
      'Eliminar pago',
      '¿Estás seguro de eliminar este pago? Esta acción no se puede deshacer.',
      async () => {
        try {
          await transactionsService.deleteTransaction(id)
          setTransactions(prev => prev.filter(t => t.id !== id))
          showToast('success', 'Pago eliminado correctamente', 'El registro de pago se eliminó de forma permanente del sistema')
          fetchData()
        } catch (error) {
          // Error already shown to user via toast
          showToast('error', 'No se pudo eliminar el pago', 'Hubo un problema al intentar eliminar el registro. Intenta nuevamente.')
        }
      }
    )
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

  const handleViewReceipt = (transaction: Transaction) => {
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
      currency: (formData.get('currency') as string) || modal.transaction?.currency || 'MXN',
      method: formData.get('method') as any,
      status: formData.get('status') as any,
      reference: formData.get('reference') as string,
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
      setModal({ type: null, selectedContact: null })
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
      key: 'description',
      header: 'Descripción',
      sortable: false,
      visible: true
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
      render: (value, item) => {
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
                {(actions.includes('void') || actions.includes('delete')) && (
                  <DropdownMenuSeparator />
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
      sortable: false
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
    failed: { label: 'Fallido', variant: 'error' }
  }

  const getPlanStatusBadge = (status?: string) => {
    const normalized = String(status || 'active').toLowerCase()
    const config = planStatusBadges[normalized] ?? { label: normalized, variant: 'neutral' as BadgeVariant }
    return <Badge variant={config.variant}>{config.label}</Badge>
  }

  const paymentTableTabs = [
    { label: 'Transacciones', value: 'transactions' },
    { label: 'Planes de pago', value: 'payment-plans' }
  ]

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

  if (paymentTableTab === 'transactions' && loading && transactions.length === 0) {
    return <Loading message="Cargando pagos..." kpiCount={4} />
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
                onTabChange={(value) => setViewMode(value as 'all' | 'by-date')}
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
            <div className={styles.dateFilters} />
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
                onClick={() => setShowRecordPaymentModal(true)}
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
            icon={<DollarSign className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Pagos Completados"
            value={formatNumber(totals.completados)}
            delta={totals.completadosChange}
            deltaLabel="vs periodo anterior"
            icon={<CheckCircle className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Ticket Promedio"
            value={formatCurrency(totals.ticketPromedio)}
            delta={totals.ticketChange}
            deltaLabel="vs periodo anterior"
            icon={<Receipt className="text-[var(--color-text-tertiary)]" />}
          />
          <KpiCard
            title="Reembolsos"
            value={formatNumber(totals.reembolsos)}
            delta={totals.reembolsosChange}
            deltaLabel="vs periodo anterior"
            icon={<RotateCcw className="text-[var(--color-text-tertiary)]" />}
          />
        </div>

      <Card padding="none">
        {paymentTableTab === 'transactions' ? (
          <Table
            key="transactions_table"
            initialColumns={columns}
            data={transactions}
            keyExtractor={(item) => item.id}
            emptyMessage="No hay pagos disponibles"
            loading={loading}
            searchable={true}
            searchPlaceholder="Buscar pagos..."
            paginated={true}
            pageSize={20}
            filters={paymentTableTabs}
            activeFilter={paymentTableTab}
            onFilterChange={handlePaymentTableTabChange}
            tableId="transactions"
            initialSortBy="date"
            initialSortOrder="desc"
          />
        ) : (
          <Table
            key="payment_plans_table"
            initialColumns={paymentPlanColumns}
            data={paymentPlans}
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
            tableId="payment_plans"
            initialSortBy="sortDate"
            initialSortOrder="desc"
          />
        )}
      </Card>

      {isClient && modal.type && createPortal(
        <div className={styles.modalOverlay} onClick={() => setModal({ type: null, selectedContact: null })}>
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
                <select name="currency" defaultValue={modal.transaction?.currency || 'MXN'}>
                  <option value="MXN">MXN</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div className={styles.formGroup}>
                <label>Método de pago</label>
                <select name="method" defaultValue={modal.transaction?.method || 'card'}>
                  <option value="card">Tarjeta</option>
                  <option value="transfer">Transferencia</option>
                  <option value="cash">Efectivo</option>
                  <option value="paypal">PayPal</option>
                  <option value="stripe">Stripe</option>
                  <option value="other">Otro</option>
                </select>
              </div>
              <div className={styles.formGroup}>
                <label>Estado</label>
                <select name="status" defaultValue={modal.transaction?.status || 'draft'}>
                  <option value="draft">Borrador</option>
                  <option value="sent">Enviado</option>
                  <option value="pending">Pendiente</option>
                  <option value="paid">Pagado</option>
                  <option value="partial">Pago parcial</option>
                  <option value="overdue">Vencido</option>
                  <option value="void">Anulado</option>
                  <option value="refunded">Reembolsado</option>
                  <option value="failed">Fallido</option>
                </select>
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
                <label>Descripción</label>
                <input
                  name="description"
                  type="text"
                  defaultValue={modal.transaction?.description}
                />
              </div>
              <div className={styles.formActions}>
                <Button type="button" variant="ghost" onClick={() => setModal({ type: null, selectedContact: null })}>
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
              <div className={styles.formGroup}>
                <ContactSearchInput
                  value={paymentPlanCreateModal.selectedContact}
                  onChange={(contact) => setPaymentPlanCreateModal(prev => ({ ...prev, selectedContact: contact }))}
                  placeholder="Buscar contacto por nombre, email o teléfono"
                  required
                />
              </div>

              <div className={styles.formGrid}>
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
              </div>

              <div className={styles.formGrid}>
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
                  <label>Moneda</label>
                  <select name="currency" defaultValue="MXN">
                    <option value="MXN">MXN</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>

              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label>Recurrencia</label>
                  <select name="frequency" defaultValue="monthly">
                    <option value="weekly">Semanal</option>
                    <option value="biweekly">Quincenal</option>
                    <option value="monthly">Mensual</option>
                    <option value="yearly">Anual</option>
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label>Número de cobros</label>
                  <input
                    name="count"
                    type="number"
                    min="1"
                    max="240"
                    defaultValue="12"
                    required
                  />
                </div>
              </div>

              <div className={styles.formGrid}>
                <div className={styles.formGroup}>
                  <label>Fecha de inicio</label>
                  <input
                    name="startDate"
                    type="date"
                    defaultValue={formatDateToISO(new Date())}
                    required
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Hora de envío</label>
                  <input
                    name="startTime"
                    type="time"
                    defaultValue={getDefaultScheduleTime()}
                    required
                  />
                </div>
              </div>

              <div className={styles.formGroup}>
                <label>Concepto / descripción</label>
                <input
                  name="description"
                  type="text"
                  placeholder="Mensualidad, asesoría, mantenimiento..."
                  required
                />
              </div>

              <div className={styles.formGroup}>
                <label>Términos / notas</label>
                <textarea
                  name="termsNotes"
                  rows={4}
                  placeholder="Notas que irán en la factura recurrente"
                />
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
                  <label>Moneda</label>
                  <select name="currency" defaultValue={paymentPlanModal.plan.currency || 'MXN'}>
                    <option value="MXN">MXN</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
                <div className={styles.formGroup}>
                  <label>Próximo cobro / ejecución</label>
                  <input
                    name="executeAt"
                    type="datetime-local"
                    defaultValue={toDateTimeInputValue(paymentPlanModal.plan.nextRunAt || paymentPlanModal.plan.startDate)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Términos / notas</label>
                  <textarea
                    name="termsNotes"
                    rows={4}
                    defaultValue={getPlanTermsNotes(paymentPlanModal.plan)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label>Datos avanzados de la plantilla</label>
                  <textarea
                    className={styles.rawJsonTextarea}
                    value={paymentPlanModal.rawJson}
                    onChange={(event) => setPaymentPlanModal(prev => ({ ...prev, rawJson: event.target.value }))}
                    spellCheck={false}
                  />
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
        onClose={() => setShowRecordPaymentModal(false)}
        onSuccess={() => {
          setShowRecordPaymentModal(false)
          // El modal ya sincronizó el invoice específico desde GHL.
          // Solo recargar desde BD local (sin sync completo).
          fetchData()
        }}
      />
      </div>
    </PageContainer>
  )
}
