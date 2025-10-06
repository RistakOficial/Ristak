import React, { useState, useEffect } from 'react'
import { KpiCard, Card, Button, Table, DateRangePicker, ContactSearchInput, PageContainer, TabList } from '@/components/common'
import type { Column } from '@/components/common'
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
  RotateCcw
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { formatCurrency, formatDate, formatDateToISO, formatNumber } from '@/utils/format'
import { transactionsService, type Transaction, type TransactionSummary } from '@/services/transactionsService'
import styles from './Transactions.module.css'


interface ModalData {
  type: 'create' | 'edit' | null
  transaction?: Transaction
  selectedContact?: Contact | null
}

export const Transactions: React.FC = () => {
  const { dateRange, setDateRange } = useDateRange()
  const { showConfirm, showToast } = useNotification()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [summary, setSummary] = useState<TransactionSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [modal, setModal] = useState<ModalData>({ type: null, selectedContact: null })
  const [viewMode, setViewMode] = useState<'all' | 'by-date'>('all') // Por defecto 'all' (Todos)

  const rangeStart = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
  const rangeEnd = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  const spansMultipleYears = rangeStart.getFullYear() !== rangeEnd.getFullYear()
  const tableDateOptions = { includeYear: spansMultipleYears, referenceDate: rangeEnd }

  useEffect(() => {
    fetchData()
  }, [dateRange, viewMode])

  const fetchData = async () => {
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
        endDate = formatDateToISO(end)
      }
      // Si viewMode === 'all', no enviamos fechas para obtener TODOS los pagos

      const [transactionsData, summaryData] = await Promise.all([
        transactionsService.getTransactions(startDate, endDate),
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

  const handleCreate = () => {
    setModal({ type: 'create', selectedContact: null })
  }

  const handleEdit = (transaction: Transaction) => {
    // Create a mock contact from transaction data for editing
    const mockContact: Contact = {
      id: transaction.contactId || `temp-${Date.now()}`,
      name: transaction.contactName,
      email: transaction.email,
      phone: '',
      createdAt: '',
      ltv: 0,
      status: 'customer',
      purchases: 0
    }
    setModal({ type: 'edit', transaction, selectedContact: mockContact })
  }

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

  const handleSaveTransaction = async (formData: FormData) => {
    if (!modal.selectedContact) {
      showToast('error', 'Contacto no seleccionado', 'Necesitas buscar y seleccionar un contacto para asociar este pago')
      return
    }

    const transaction: Transaction = {
      id: modal.transaction?.id || '',
      date: formData.get('date') as string,
      contactId: modal.selectedContact.id,
      contactName: modal.selectedContact.name,
      email: modal.selectedContact.email || '',
      amount: parseFloat(formData.get('amount') as string) || 0,
      method: formData.get('method') as any,
      status: formData.get('status') as any,
      description: formData.get('description') as string
    }

    try {
      if (modal.type === 'create') {
        const newTransaction = await transactionsService.createTransaction(transaction)
        setTransactions(prev => [...prev, newTransaction])
        showToast('success', '¡Pago registrado exitosamente!', `Se registró el pago de ${formatCurrency(transaction.amount)} para ${modal.selectedContact.name}`)
      } else if (modal.type === 'edit') {
        const updatedTransaction = await transactionsService.updateTransaction(transaction.id, transaction)
        setTransactions(prev => prev.map(t => t.id === updatedTransaction.id ? updatedTransaction : t))
        showToast('success', 'Pago actualizado correctamente', `Se actualizó el registro de pago de ${formatCurrency(transaction.amount)}`)
      }
      setModal({ type: null, selectedContact: null })
      fetchData()
    } catch (error) {
      // Error already shown to user via toast
      showToast('error', 'No se pudo guardar el pago', 'Hubo un problema al guardar la información. Verifica los datos e intenta nuevamente.')
    }
  }

  const getMethodIcon = (method: string) => {
    switch(method) {
      case 'card': return <CreditCard size={16} />
      case 'transfer': return <RefreshCw size={16} />
      case 'cash': return <Banknote size={16} />
      case 'paypal': return <DollarSign size={16} />
      default: return <DollarSign size={16} />
    }
  }

  const getStatusBadge = (status: string) => {
    const statusClass = styles[status]
    const statusText = {
      paid: 'Pagado',
      pending: 'Pendiente',
      failed: 'Fallido',
      refunded: 'Reembolsado'
    }[status]

    return (
      <span className={`${styles.statusBadge} ${statusClass}`}>
        {statusText}
      </span>
    )
  }

  const columns: Column<Transaction>[] = [
    {
      key: 'date',
      header: 'Fecha',
      render: (value) => formatDate(value, tableDateOptions),
      sortable: true
    },
    {
      key: 'contactName',
      header: 'Contacto',
      sortable: true
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      visible: false
    },
    {
      key: 'amount',
      header: 'Monto',
      render: (value) => formatCurrency(value),
      sortable: true
    },
    {
      key: 'method',
      header: 'Método de pago',
      render: (value) => (
        <div className={styles.methodCell}>
          {getMethodIcon(value)}
          <span>{value.charAt(0).toUpperCase() + value.slice(1)}</span>
        </div>
      ),
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => getStatusBadge(value),
      sortable: true
    },
    {
      key: 'description',
      header: 'Descripción',
      sortable: false
    },
    {
      key: 'id',
      header: 'Acciones',
      render: (value, item) => (
        <div className={styles.actions}>
          <button
            className={styles.actionButton}
            onClick={() => handleEdit(item)}
            title="Editar"
          >
            <Edit size={16} />
          </button>
          <button
            className={styles.actionButton}
            onClick={() => handleDelete(value)}
            title="Eliminar"
          >
            <Trash2 size={16} />
          </button>
        </div>
      ),
      sortable: false
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

  return (
    <PageContainer>
      <div className={styles.container}>
        <div className={styles.pageHeader}>
          <h1 className={styles.pageTitle}>Pagos</h1>
          {viewMode === 'by-date' && (
            <div className={styles.datePickerInline}>
              <DateRangePicker
                startDate={formatDateToISO(dateRange.start)}
                endDate={formatDateToISO(dateRange.end)}
                onChange={(start, end) => setDateRange({
                  start: new Date(start),
                  end: new Date(end),
                  preset: 'custom'
                })}
              />
            </div>
          )}
        </div>

        <div className={styles.controlsRow}>
          <TabList
            tabs={[
              { value: 'all', label: 'Todos' },
              { value: 'by-date', label: 'Por fecha' }
            ]}
            activeTab={viewMode}
            onTabChange={(value) => setViewMode(value as 'all' | 'by-date')}
            variant="compact"
          />
          {/* Botón de crear pago oculto - solo editar/eliminar permitido */}
          {/* <Button variant="secondary" onClick={handleCreate}>
            <Plus size={16} />
            Registrar pago
          </Button> */}
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
            value={formatCurrency(totals.reembolsos)}
            delta={totals.reembolsosChange}
            deltaLabel="vs periodo anterior"
            icon={<RotateCcw className="text-[var(--color-text-tertiary)]" />}
          />
        </div>

      <Card padding="none">
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
          exportable={true}
          onExport={() => {/* TODO: Implement export functionality */}}
          tableId="transactions"
        />
      </Card>

      {modal.type && (
        <div className={styles.modalOverlay} onClick={() => setModal({ type: null, selectedContact: null })}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2>{modal.type === 'create' ? 'Nuevo Pago' : 'Editar Pago'}</h2>
            <form className={styles.form} onSubmit={(e) => {
              e.preventDefault()
              const formData = new FormData(e.currentTarget)
              handleSaveTransaction(formData)
            }}>
              <div className={styles.formGroup}>
                <ContactSearchInput
                  value={modal.selectedContact || null}
                  onChange={(contact) => setModal({ ...modal, selectedContact: contact })}
                  placeholder="Buscar contacto por nombre, email o teléfono"
                  required
                />
              </div>
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
                <select name="status" defaultValue={modal.transaction?.status || 'paid'}>
                  <option value="paid">Pagado</option>
                  <option value="pending">Pendiente</option>
                  <option value="failed">Fallido</option>
                  <option value="refunded">Reembolsado</option>
                </select>
              </div>
              <div className={styles.formGroup}>
                <label>Fecha</label>
                <input
                  name="date"
                  type="date"
                  defaultValue={modal.transaction?.date || formatDateToISO(new Date())}
                  required
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
        </div>
      )}
      </div>
    </PageContainer>
  )
}
