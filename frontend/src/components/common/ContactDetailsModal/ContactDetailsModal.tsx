import { useState, useMemo, useEffect } from 'react'
import { Modal } from '../Modal'
import { Icon } from '../Icon'
import { formatDate } from '@/utils/format'
import styles from './ContactDetailsModal.module.css'

interface ContactPaymentDetail {
  id: string
  amount: number
  status?: string
  date: string
}

interface ContactAppointmentDetail {
  id: string
  title?: string | null
  status?: string | null
  start_time: string
}

interface ContactDetail {
  id: string
  name?: string
  email?: string
  phone?: string
  created_at: string | Date
  ltv?: number
  purchases?: number
  payments?: ContactPaymentDetail[]
  appointments?: ContactAppointmentDetail[]
  source?: string
  ad_name?: string
  ad_id?: string
}

interface ContactDetailsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  data: ContactDetail[]
  loading: boolean
  type?: 'interesados' | 'sales' | 'appointments' | null
}

export function ContactDetailsModal({
  isOpen,
  onClose,
  title,
  subtitle,
  data,
  loading,
  type
}: ContactDetailsModalProps) {
  const [selectedContact, setSelectedContact] = useState<ContactDetail | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [paymentsExpanded, setPaymentsExpanded] = useState(false)
  const [refundsExpanded, setRefundsExpanded] = useState(false)
  const [appointmentsExpanded, setAppointmentsExpanded] = useState(false)

  // Seleccionar automáticamente el primer contacto cuando se abre el modal
  useEffect(() => {
    if (isOpen && data.length > 0) {
      setSelectedContact(data[0])
    } else if (!isOpen) {
      setSelectedContact(null)
      setSearchQuery('')
      setPaymentsExpanded(false)
      setRefundsExpanded(false)
      setAppointmentsExpanded(false)
    }
  }, [isOpen, data])

  useEffect(() => {
    setPaymentsExpanded(false)
    setRefundsExpanded(false)
    setAppointmentsExpanded(false)
  }, [selectedContact?.id])

  // Filtrar contactos según búsqueda
  const filteredData = useMemo(() => {
    if (!searchQuery) return data

    const query = searchQuery.toLowerCase()
    return data.filter(contact =>
      contact.name?.toLowerCase().includes(query) ||
      contact.email?.toLowerCase().includes(query) ||
      contact.phone?.toLowerCase().includes(query) ||
      contact.id?.toLowerCase().includes(query)
    )
  }, [data, searchQuery])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: 'MXN'
    }).format(value)
  }

  const getStatusLabel = (status?: string): { text: string; className: string } => {
    if (!status) return { text: '', className: '' }
    const statusLower = status.toLowerCase()

    if (['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'].includes(statusLower)) {
      return { text: 'PAGADO', className: 'paid' }
    }
    if (['refunded', 'refund'].includes(statusLower)) {
      return { text: 'REEMBOLSADO', className: 'refunded' }
    }
    if (['pending', 'processing'].includes(statusLower)) {
      return { text: 'PENDIENTE', className: 'pending' }
    }
    if (['failed', 'canceled', 'cancelled'].includes(statusLower)) {
      return { text: 'FALLIDO', className: 'failed' }
    }
    if (['booked', 'confirmed', 'scheduled'].includes(statusLower)) {
      return { text: 'RESERVADO', className: 'booked' }
    }

    return { text: status.toUpperCase(), className: '' }
  }

  const getAppointmentStatusLabel = (status?: string | null): { text: string; className: string } => {
    if (!status) return { text: 'RESERVADO', className: 'booked' }
    const statusLower = status.toLowerCase()

    if (['confirmed', 'booked', 'scheduled'].includes(statusLower)) {
      return { text: 'RESERVADO', className: 'booked' }
    }
    if (['completed', 'showed', 'attended'].includes(statusLower)) {
      return { text: 'ASISTIÓ', className: 'paid' }
    }
    if (['cancelled', 'canceled', 'no_show', 'noshow'].includes(statusLower)) {
      return { text: 'CANCELADO', className: 'failed' }
    }
    if (['pending', 'unconfirmed'].includes(statusLower)) {
      return { text: 'PENDIENTE', className: 'pending' }
    }

    return { text: status.toUpperCase(), className: 'booked' }
  }

  // Separar pagos de reembolsos
  const payments = useMemo(() => {
    return selectedContact?.payments?.filter(p => p.amount > 0) || []
  }, [selectedContact])

  const refunds = useMemo(() => {
    return selectedContact?.payments?.filter(p => p.amount < 0) || []
  }, [selectedContact])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title=""
      size="xl"
      showCloseButton={false}
    >
      <div className={styles.modalContainer}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerContent}>
            <div>
              <h3 className={styles.title}>{title}</h3>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            <button onClick={onClose} className={styles.closeButton}>
              <Icon name="x" size={16} />
            </button>
          </div>

          {/* Stats */}
          <div className={styles.stats}>
            <span className={styles.statItem}>
              {data.length} {data.length === 1 ? 'elemento' : 'elementos'}
            </span>
            {type === 'sales' && data.some(d => (d.ltv || 0) > 0) && (
              <span className={styles.statValue}>
                Total: {formatCurrency(data.reduce((sum, d) => sum + (d.ltv || 0), 0))}
              </span>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className={styles.mainContent}>
          {/* Left panel - Lista de contactos */}
          <div className={selectedContact ? styles.leftPanel : styles.leftPanelFull}>
            {/* Search bar */}
            <div className={styles.searchContainer}>
              <div className={styles.searchInputWrapper}>
                <Icon name="search" size={16} className={styles.searchIcon} />
                <input
                  type="text"
                  placeholder="Buscar..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={styles.searchInput}
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className={styles.clearButton}
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Contact list */}
            <div className={styles.contactList}>
              {loading ? (
                <div className={styles.emptyState}>
                  <Icon name="refresh" size={24} className={styles.spinIcon} />
                  <p>Cargando elementos...</p>
                </div>
              ) : filteredData.length === 0 ? (
                <div className={styles.emptyState}>
                  <Icon name="users" size={24} />
                  <p>{searchQuery ? 'No se encontraron resultados' : 'No hay elementos para mostrar'}</p>
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className={styles.clearSearchButton}
                    >
                      Limpiar búsqueda
                    </button>
                  )}
                </div>
              ) : (
                <>
                  {filteredData.map((contact) => (
                    <div
                      key={contact.id}
                      onClick={() => setSelectedContact(contact)}
                      className={`${styles.contactItem} ${selectedContact?.id === contact.id ? styles.contactItemSelected : ''}`}
                    >
                      <div className={styles.contactAvatar}>
                        <Icon name="user" size={16} />
                      </div>

                      <div className={styles.contactInfo}>
                        <p className={styles.contactName}>
                          {contact.name || '—'}
                        </p>
                        {(contact.email || contact.phone) && (
                          <p className={styles.contactDetail}>
                            {contact.email || contact.phone}
                          </p>
                        )}
                      </div>

                      <div className={styles.contactIndicators}>
                        {type === 'sales' && contact.ltv && (
                          <span className={styles.ltvValue}>
                            {formatCurrency(contact.ltv)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Footer */}
            {data.length > 0 && (
              <div className={styles.footer}>
                <span>
                  Mostrando {filteredData.length} de {data.length}
                </span>
              </div>
            )}
          </div>

          {/* Right panel - Detalles del contacto */}
          {selectedContact && (
            <div className={styles.rightPanel}>
              {/* Contact header */}
              <div className={styles.contactHeader}>
                <div className={styles.contactHeaderAvatar}>
                  <Icon name="user" size={20} />
                </div>
                <div className={styles.contactHeaderInfo}>
                  <h4 className={styles.contactHeaderName}>
                    {selectedContact.name || '—'}
                  </h4>
                  {selectedContact.email && (
                    <p className={styles.contactHeaderEmail}>
                      {selectedContact.email}
                    </p>
                  )}
                  {selectedContact.phone && (
                    <p className={styles.contactHeaderPhone}>
                      {selectedContact.phone}
                    </p>
                  )}
                </div>
              </div>

              {/* Contact details */}
              <div className={styles.contactDetails}>
                {/* Información básica */}
                <div className={styles.detailSection}>
                  <h5 className={styles.detailSectionTitle}>
                    Información de Contacto
                  </h5>
                  <div className={styles.detailSectionContent}>
                    {selectedContact.email && (
                      <div className={styles.detailItem}>
                        <Icon name="mail" size={16} />
                        <span>{selectedContact.email}</span>
                      </div>
                    )}
                    {selectedContact.phone && (
                      <div className={styles.detailItem}>
                        <Icon name="phone" size={16} />
                        <span>{selectedContact.phone}</span>
                      </div>
                    )}
                    <div className={styles.detailItem}>
                      <Icon name="calendar" size={16} />
                      <span>{formatDate(selectedContact.created_at)}</span>
                    </div>
                  </div>
                </div>

                {/* Atribución */}
                {(selectedContact.source || selectedContact.ad_name || selectedContact.ad_id) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      De dónde llegó el contacto:
                    </h5>
                    <div className={styles.detailSectionContent}>
                      {selectedContact.source && (
                        <div className={styles.detailItem}>
                          <Icon name="tag" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Fuente:</span>
                            <span> {selectedContact.source}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.ad_name && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {selectedContact.ad_name}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.ad_id && (
                        <div className={styles.detailItem}>
                          <Icon name="hash" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>ID del Anuncio:</span>
                            <span> {selectedContact.ad_id}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Métricas */}
                {(selectedContact.ltv || 0) > 0 && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>Métricas</h5>
                    <div className={styles.metricsGrid}>
                      <div className={styles.metricCard}>
                        <p className={styles.metricLabel}>Valor</p>
                        <p className={styles.metricValue}>
                          {formatCurrency(selectedContact.ltv || 0)}
                        </p>
                      </div>
                      {payments.length > 0 && (
                        <div className={styles.metricCard}>
                          <p className={styles.metricLabel}>Pagos</p>
                          <p className={styles.metricValue}>
                            {payments.length}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Pagos */}
                {payments.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={styles.toggleButton}
                      onClick={() => setPaymentsExpanded(prev => !prev)}
                    >
                      <div className={styles.toggleLabel}>
                        <Icon name={paymentsExpanded ? 'chevron-down' : 'chevron-right'} size={16} />
                        <span>Pagos ({payments.length})</span>
                      </div>
                      <span className={styles.toggleValue}>
                        {formatCurrency(payments.reduce((sum, payment) => sum + payment.amount, 0))}
                      </span>
                    </button>

                    {paymentsExpanded && (
                      <ul className={styles.paymentList}>
                        {payments.map(payment => {
                          const statusInfo = getStatusLabel(payment.status)
                          return (
                            <li key={payment.id} className={styles.paymentItem}>
                              <div>
                                <p className={styles.paymentAmount}>{formatCurrency(payment.amount)}</p>
                                {payment.status && statusInfo.text && (
                                  <span className={`${styles.paymentStatus} ${statusInfo.className ? styles[statusInfo.className] : ''}`}>
                                    {statusInfo.text}
                                  </span>
                                )}
                              </div>
                              <span className={styles.paymentDate}>{formatDate(payment.date)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* Reembolsos */}
                {refunds.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={styles.toggleButton}
                      onClick={() => setRefundsExpanded(prev => !prev)}
                    >
                      <div className={styles.toggleLabel}>
                        <Icon name={refundsExpanded ? 'chevron-down' : 'chevron-right'} size={16} />
                        <span>Reembolsos ({refunds.length})</span>
                      </div>
                      <span className={styles.toggleValue}>
                        {formatCurrency(refunds.reduce((sum, refund) => sum + Math.abs(refund.amount), 0))}
                      </span>
                    </button>

                    {refundsExpanded && (
                      <ul className={styles.paymentList}>
                        {refunds.map(refund => {
                          const statusInfo = getStatusLabel(refund.status)
                          return (
                            <li key={refund.id} className={styles.paymentItem}>
                              <div>
                                <p className={styles.paymentAmount}>{formatCurrency(Math.abs(refund.amount))}</p>
                                {refund.status && statusInfo.text && (
                                  <span className={`${styles.paymentStatus} ${statusInfo.className ? styles[statusInfo.className] : ''}`}>
                                    {statusInfo.text}
                                  </span>
                                )}
                              </div>
                              <span className={styles.paymentDate}>{formatDate(refund.date)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* Citas */}
                {selectedContact.appointments && selectedContact.appointments.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={styles.toggleButton}
                      onClick={() => setAppointmentsExpanded(prev => !prev)}
                    >
                      <div className={styles.toggleLabel}>
                        <Icon name={appointmentsExpanded ? 'chevron-down' : 'chevron-right'} size={16} />
                        <span>Citas ({selectedContact.appointments.length})</span>
                      </div>
                    </button>

                    {appointmentsExpanded && (
                      <ul className={styles.paymentList}>
                        {selectedContact.appointments.map(appointment => {
                          const statusInfo = getAppointmentStatusLabel(appointment.status)
                          return (
                            <li key={appointment.id} className={styles.paymentItem}>
                              <div>
                                <p className={styles.paymentAmount}>{appointment.title || 'Cita'}</p>
                                <span className={`${styles.paymentStatus} ${statusInfo.className ? styles[statusInfo.className] : ''}`}>
                                  {statusInfo.text}
                                </span>
                              </div>
                              <span className={styles.paymentDate}>{formatDate(appointment.start_time)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
