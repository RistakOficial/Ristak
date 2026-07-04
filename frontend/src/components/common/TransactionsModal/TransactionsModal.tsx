import React from 'react'
import { Modal } from '../Modal'
import { useTimezone } from '@/contexts/TimezoneContext'
import { useAccountCurrency } from '@/hooks'
import { formatCurrency } from '@/utils/format'
import styles from './TransactionsModal.module.css'

interface Transaction {
  id: string
  contact_id: string
  contact_name: string
  contact_email: string
  contact_phone: string
  amount: number
  currency?: string
  status: string
  date: string
  payment_method?: string
  payment_method_category?: string
  payment_type?: string
  payment_channel?: string
  description?: string
}

interface TransactionsModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  subtitle?: string
  transactions: Transaction[]
  loading?: boolean
}

export const TransactionsModal: React.FC<TransactionsModalProps> = ({
  isOpen,
  onClose,
  title = 'Transacciones',
  subtitle,
  transactions,
  loading = false
}) => {
  const { formatLocalDateShort } = useTimezone()
  const [accountCurrency] = useAccountCurrency()

  if (!isOpen) return null

  const totalAmount = transactions.reduce((sum, t) => sum + (t.amount || 0), 0)

  const getStatusColor = (status: string) => {
    const lowerStatus = status?.toLowerCase()
    if (['succeeded', 'paid', 'completed', 'success'].includes(lowerStatus)) return styles.statusSuccess
    if (['refunded', 'cancelled', 'void'].includes(lowerStatus)) return styles.statusRefunded
    if (['pending', 'processing'].includes(lowerStatus)) return styles.statusPending
    return styles.statusDefault
  }

  const getStatusLabel = (status: string) => {
    const statusMap: { [key: string]: string } = {
      'succeeded': 'Completado',
      'paid': 'Pagado',
      'completed': 'Completado',
      'success': 'Exitoso',
      'refunded': 'Reembolsado',
      'cancelled': 'Cancelado',
      'void': 'Anulado',
      'pending': 'Pendiente',
      'processing': 'Procesando',
      'failed': 'Fallido'
    }
    return statusMap[status?.toLowerCase()] || status
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="md"
      type="custom"
      flushContent
    >
      <div className={styles.container} data-modal-panel="">
        {loading ? (
          <div className={styles.loading} role="status" aria-live="polite" aria-label="Cargando transacciones">
            <div className={styles.spinner} aria-hidden="true"></div>
          </div>
        ) : transactions.length === 0 ? (
          <div className={styles.empty}>
            <p>No se encontraron transacciones para este período</p>
          </div>
        ) : (
          <>
            {subtitle && <div className={styles.subtitle}>{subtitle}</div>}

            <div className={styles.summary}>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Transacciones</span>
                <span className={styles.summaryValue}>{transactions.length}</span>
              </div>
              <div className={styles.summaryItem}>
                <span className={styles.summaryLabel}>Monto Total</span>
                <span className={styles.summaryValue}>
                  {formatCurrency(totalAmount, accountCurrency)}
                </span>
              </div>
            </div>

            <div className={styles.listContainer}>
              {transactions.map((transaction) => (
                <div key={transaction.id} className={styles.transactionCard}>
                  <div className={styles.transactionHeader}>
                    <div>
                      <h4 className={styles.contactName}>{transaction.contact_name || 'Sin nombre'}</h4>
                      <div className={styles.contactInfo}>
                        {transaction.contact_email && (
                          <span className={styles.contactEmail}>{transaction.contact_email}</span>
                        )}
                        {transaction.contact_phone && (
                          <span className={styles.contactPhone}>{transaction.contact_phone}</span>
                        )}
                      </div>
                    </div>
                    <div className={styles.amountSection}>
                      <span className={styles.amount}>{formatCurrency(transaction.amount, transaction.currency || accountCurrency)}</span>
                      <span className={`${styles.status} ${getStatusColor(transaction.status)}`}>
                        {getStatusLabel(transaction.status)}
                      </span>
                    </div>
                  </div>

                  <div className={styles.transactionDetails}>
                    <div className={styles.detailItem}>
                      <span className={styles.detailLabel}>Fecha</span>
                      <span className={styles.detailValue}>
                        {formatLocalDateShort(transaction.date)}
                      </span>
                    </div>
                    {(transaction.payment_method_category || transaction.payment_method) && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Método</span>
                        <span className={styles.detailValue}>{transaction.payment_method_category || transaction.payment_method}</span>
                      </div>
                    )}
                    {transaction.payment_type && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Tipo</span>
                        <span className={styles.detailValue}>{transaction.payment_type}</span>
                      </div>
                    )}
                    {transaction.payment_channel && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Canal</span>
                        <span className={styles.detailValue}>{transaction.payment_channel}</span>
                      </div>
                    )}
                    {transaction.description && (
                      <div className={styles.detailItem}>
                        <span className={styles.detailLabel}>Descripción</span>
                        <span className={styles.detailValue}>{transaction.description}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
