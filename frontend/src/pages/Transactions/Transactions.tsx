import React, { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { KpiCard, Card, Button, Table, DateRangePicker, ContactSearchInput, PageContainer, TabList, RecordPaymentModal, Badge, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/components/common'
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
  Download,
  Link2,
  Send
} from 'lucide-react'
import { useDateRange } from '@/contexts/DateRangeContext'
import { formatCurrency, formatDate, formatDateToISO, formatNumber, parseLocalDateString } from '@/utils/format'
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
  const [showRecordPaymentModal, setShowRecordPaymentModal] = useState(false)
  const [isClient, setIsClient] = useState(false)

  const rangeStart = dateRange.start instanceof Date ? dateRange.start : new Date(dateRange.start)
  const rangeEnd = dateRange.end instanceof Date ? dateRange.end : new Date(dateRange.end)
  const spansMultipleYears = rangeStart.getFullYear() !== rangeEnd.getFullYear()
  const tableDateOptions = { includeYear: spansMultipleYears, referenceDate: rangeEnd }

  useEffect(() => {
    fetchData()
  }, [dateRange, viewMode])

  useEffect(() => {
    setIsClient(true)
  }, [])

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

  const handleSendPayment = async (id: string) => {
    try {
      await transactionsService.sendTransaction(id)
      showToast('success', 'Pago enviado', 'Se envió el pago al cliente correctamente')
      fetchData()
    } catch (error) {
      showToast('error', 'Error al enviar pago', 'No se pudo enviar el pago al cliente')
    }
  }

  const handleViewReceipt = (transaction: Transaction) => {
    // TODO: Implement view receipt - open payment link in new tab
    showToast('info', 'Ver recibo', 'Abriendo recibo en nueva pestaña...')
  }

  const handleDownloadPDF = (transaction: Transaction) => {
    // TODO: Implement PDF download
    showToast('info', 'Descargar PDF', 'Descargando comprobante...')
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
          <span>{getMethodLabel(value)}</span>
        </div>
      ),
      sortable: true
    },
    {
      key: 'status',
      header: 'Estado',
      render: (value) => getStatusBadge(value as Transaction['status']),
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

        // Editar - solo para draft
        if (item.status === 'draft') {
          actions.push('edit')
        }

        // Marcar como pagado - para draft, sent, pending, overdue, failed, partial
        if (['draft', 'sent', 'pending', 'overdue', 'failed', 'partial'].includes(item.status)) {
          actions.push('mark-paid')
        }

        // Descargar PDF - solo para pagados
        if (item.status === 'paid') {
          actions.push('download')
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
                  <DropdownMenuItem onClick={() => handleSendPayment(item.id)}>
                    <Send size={16} />
                    <span style={{ marginLeft: '8px' }}>Enviar pago</span>
                  </DropdownMenuItem>
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

                {/* Descargar PDF */}
                {actions.includes('download') && (
                  <DropdownMenuItem onClick={() => handleDownloadPDF(item)}>
                    <Download size={16} />
                    <span style={{ marginLeft: '8px' }}>Descargar PDF</span>
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
          <p className={styles.pageSubtitle}>Monitorea ingresos, reembolsos y tickets promedio de tus operaciones.</p>
        </div>

        <div className={styles.controlsRow}>
          <div className={styles.dateFilters}>
            <TabList
              tabs={[
                { value: 'all', label: 'Todos' },
                { value: 'by-date', label: 'Por fecha' }
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
          <Button
            variant="secondary"
            onClick={() => setShowRecordPaymentModal(true)}
          >
            <Plus size={16} />
            Registrar pago
          </Button>
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
        />
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
        </div>,
        document.body
      )}

      <RecordPaymentModal
        isOpen={showRecordPaymentModal}
        onClose={() => setShowRecordPaymentModal(false)}
        onSuccess={() => {
          setShowRecordPaymentModal(false)
          fetchData()
        }}
      />
      </div>
    </PageContainer>
  )
}
