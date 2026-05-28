import { useState, useMemo, useEffect, useCallback } from 'react'
import { Modal, Icon, Badge, type BadgeVariant } from '@/components/common'
import { ContactJourney } from '@/components/common/ContactJourney'
import { formatDate } from '@/utils/format'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
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

interface ContactFirstSession {
  started_at: string
  page_url?: string
  landing_page?: string
  referrer_url?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  utm_content?: string
  utm_term?: string
  source_platform?: string
  site_source_name?: string
  campaign_name?: string
  ad_name?: string
  ad_id?: string
  device_type?: string
  browser?: string
  geo_city?: string
  geo_region?: string
  geo_country?: string
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
  firstAppointmentDate?: string | null
  nextAppointmentDate?: string | null
  source?: string
  ad_name?: string
  ad_id?: string
  campaign_id?: string | null
  campaign_name?: string | null
  adset_id?: string | null
  adset_name?: string | null
  lifetimeLtv?: number
  lifetimePurchases?: number
  isCustomer?: boolean
  hasAppointments?: boolean
  hasShowedAppointment?: boolean
  hasAttendedAppointment?: boolean
  is_sale?: boolean
  firstSession?: ContactFirstSession | null
}

interface ContactDetailsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  data: ContactDetail[]
  loading: boolean
  type?: 'interesados' | 'sales' | 'appointments' | 'attendances' | null
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
  const { labels } = useLabels()
  const { formatLocalDateShort, formatLocalDateTime } = useTimezone()

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

  const formatStatusText = (value: string) =>
    value
      .toLowerCase()
      .split(/[\s_]+/)
      .filter(Boolean)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')

  const getStatusLabel = (status?: string): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: '', variant: 'neutral' }
    const statusLower = status.toLowerCase()

    if (['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success'].includes(statusLower)) {
      return { text: 'Pagado', variant: 'success' }
    }
    if (['refunded', 'refund'].includes(statusLower)) {
      return { text: 'Reembolsado', variant: 'error' }
    }
    if (['pending', 'processing'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }
    if (['failed', 'canceled', 'cancelled'].includes(statusLower)) {
      return { text: 'Fallido', variant: 'error' }
    }
    if (['booked', 'confirmed', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  const getAppointmentStatusLabel = (status?: string | null): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: 'Reservado', variant: 'warning' }
    const statusLower = status.toLowerCase()

    if (['confirmed', 'booked', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }
    if (['completed', 'showed', 'attended'].includes(statusLower)) {
      return { text: 'Asistió', variant: 'success' }
    }
    if (['cancelled', 'canceled', 'no_show', 'noshow'].includes(statusLower)) {
      return { text: 'Cancelado', variant: 'error' }
    }
    if (['pending', 'unconfirmed'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  const resolveContactBadge = useCallback(
    (contact?: ContactDetail | null): { text: string; variant: BadgeVariant } | null => {
      if (!contact) return null

      const lifetimePurchases = contact.lifetimePurchases ?? (contact as any).purchasesLifetime ?? (contact as any).purchases_count ?? 0
      const lifetimeLtv = contact.lifetimeLtv ?? (contact as any).totalPaid ?? (contact as any).total_paid ?? 0
      const isCustomerFlag = contact.isCustomer ?? (contact as any).isCustomer ?? (contact as any).is_customer ?? contact.is_sale ?? (contact as any).isSale ?? false
      const rawStatus = (contact as any).status ?? (contact as any).customerStatus ?? (contact as any).stage ?? (contact as any).lifecycleStage ?? ''
      const normalizedStatus = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : ''
      const tagsRaw = (contact as any).tags ?? (contact as any).labels ?? (contact as any).tagList ?? (contact as any).contactTags
      const normalizedTags: string[] = Array.isArray(tagsRaw)
        ? (tagsRaw as unknown[]).filter((tag): tag is string => typeof tag === 'string')
        : typeof tagsRaw === 'string'
          ? tagsRaw.split(',').map(tag => tag.trim())
          : []
      const normalizeTag = (tag: string) => tag.toLowerCase()
      const CUSTOMER_KEYWORDS = ['customer', 'cliente', 'sale', 'ventas', 'sold', 'converted', 'paid', 'pagó', 'compró', 'closed-won', 'won', 'compra', 'pago']
      const APPOINTMENT_KEYWORDS = ['appointment', 'cita', 'agend', 'booked', 'scheduled', 'confirmado', 'reserva', 'reservo', 'calendar']
      const ATTENDANCE_KEYWORDS = ['asist', 'showed', 'attended', 'completed']
      const statusMatches = (keywords: string[]) => keywords.some(keyword => normalizedStatus.includes(keyword))
      const tagsMatch = (keywords: string[]) =>
        normalizedTags.some(tag => keywords.some(keyword => normalizeTag(tag).includes(keyword)))

      const hasPurchases =
        isCustomerFlag ||
        (contact.purchases ?? 0) > 0 ||
        lifetimePurchases > 0 ||
        (contact.ltv ?? 0) > 0 ||
        lifetimeLtv > 0 ||
        (contact.payments ?? []).some(payment => payment.amount > 0) ||
        statusMatches(CUSTOMER_KEYWORDS) ||
        tagsMatch(CUSTOMER_KEYWORDS)

      const hasAppointments =
        contact.hasAppointments ||
        (contact.appointments?.length ?? 0) > 0 ||
        Boolean(contact.nextAppointmentDate) ||
        Boolean(contact.firstAppointmentDate) ||
        statusMatches(APPOINTMENT_KEYWORDS) ||
        tagsMatch(APPOINTMENT_KEYWORDS)

      const hasAttendedAppointment =
        Boolean((contact as any).hasShowedAppointment || (contact as any).hasAttendedAppointment) ||
        (contact.appointments ?? []).some(appointment => {
          const rawAppointmentStatus = (appointment as any).appointmentStatus ?? (appointment as any).appointment_status ?? appointment.status
          const status = String(rawAppointmentStatus || '').trim().toLowerCase()
          return ['completed', 'showed', 'attended'].includes(status)
        }) ||
        statusMatches(ATTENDANCE_KEYWORDS) ||
        tagsMatch(ATTENDANCE_KEYWORDS)

      if (hasPurchases) {
        return { text: labels.customer, variant: 'success' }
      }

      if (hasAttendedAppointment) {
        return { text: 'Asistió a Cita', variant: 'success' }
      }

      if (hasAppointments) {
        return { text: 'Agendó cita', variant: 'purple' }
      }

      return { text: labels.lead, variant: 'default' }
    },
    [labels]
  )

  // Separar pagos exitosos de reembolsos/cancelados
  // CRÍTICO: Solo pagos con status exitoso, NO incluir refunded/cancelled
  const validPaymentStatuses = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success']
  const payments = useMemo(() => {
    return selectedContact?.payments?.filter(p =>
      p.amount > 0 && validPaymentStatuses.includes(p.status?.toLowerCase() || '')
    ) || []
  }, [selectedContact])

  const refunds = useMemo(() => {
    return selectedContact?.payments?.filter(p =>
      p.amount < 0 || p.status?.toLowerCase() === 'refunded' || p.status?.toLowerCase() === 'cancelled'
    ) || []
  }, [selectedContact])

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title=""
      size="lg"
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
                        {(() => {
                          const badge = resolveContactBadge(contact)
                          return badge ? (
                            <Badge variant={badge.variant} className={styles.contactBadge}>
                              {badge.text}
                            </Badge>
                          ) : null
                        })()}
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
                  <div className={styles.contactHeaderNameRow}>
                    <h4 className={styles.contactHeaderName}>
                      {selectedContact.name || '—'}
                    </h4>
                    {(() => {
                      const badge = resolveContactBadge(selectedContact)
                      return badge ? (
                        <Badge variant={badge.variant} className={styles.contactHeaderBadge}>
                          {badge.text}
                        </Badge>
                      ) : null
                    })()}
                  </div>
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
                      <span>{formatLocalDateShort(selectedContact.created_at)}</span>
                    </div>
                  </div>
                </div>

                {/* Primera Atribución (Primer Toque) */}
                {selectedContact.firstSession && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Primera Atribución (Primer Toque)
                    </h5>
                    <div className={styles.detailSectionContent}>
                      <div className={styles.detailItem}>
                        <Icon name="calendar" size={16} />
                        <div>
                          <span className={styles.detailItemLabel}>Primera visita:</span>
                          <span> {formatLocalDateTime(selectedContact.firstSession.started_at)}</span>
                        </div>
                      </div>

                      {(() => {
                        const source = normalizeTrafficSource({
                          site_source_name: selectedContact.firstSession.site_source_name,
                          source_platform: selectedContact.firstSession.source_platform,
                          utm_source: selectedContact.firstSession.utm_source,
                          referrer_url: selectedContact.firstSession.referrer_url
                        })
                        return source && source !== 'Desconocido' ? (
                          <div className={styles.detailItem}>
                            <Icon name="globe" size={16} />
                            <div>
                              <span className={styles.detailItemLabel}>Fuente:</span>
                              <span> {source}</span>
                            </div>
                          </div>
                        ) : null
                      })()}

                      {(selectedContact.firstSession.campaign_name || selectedContact.firstSession.utm_campaign) && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {selectedContact.firstSession.campaign_name || selectedContact.firstSession.utm_campaign}</span>
                          </div>
                        </div>
                      )}

                      {(selectedContact.firstSession.ad_name || selectedContact.firstSession.utm_content) && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {selectedContact.firstSession.ad_name || selectedContact.firstSession.utm_content}</span>
                          </div>
                        </div>
                      )}

                      {selectedContact.firstSession.device_type && (
                        <div className={styles.detailItem}>
                          <Icon name="smartphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Dispositivo:</span>
                            <span> {selectedContact.firstSession.device_type}{selectedContact.firstSession.browser && ` · ${selectedContact.firstSession.browser}`}</span>
                          </div>
                        </div>
                      )}

                      {(selectedContact.firstSession.geo_city || selectedContact.firstSession.geo_country) && (
                        <div className={styles.detailItem}>
                          <Icon name="map-pin" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Ubicación:</span>
                            <span> {[selectedContact.firstSession.geo_city, selectedContact.firstSession.geo_country].filter(Boolean).join(', ')}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Atribución (solo si NO hay firstSession) */}
                {!selectedContact.firstSession && (selectedContact.source || selectedContact.campaign_name || selectedContact.adset_name || selectedContact.ad_name || selectedContact.ad_id) && (
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
                      {selectedContact.campaign_name && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {selectedContact.campaign_name}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.adset_name && (
                        <div className={styles.detailItem}>
                          <Icon name="layers" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Conjunto de anuncios:</span>
                            <span> {selectedContact.adset_name}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.ad_name && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {selectedContact.ad_name}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Información de Citas */}
                {(selectedContact.firstAppointmentDate || selectedContact.nextAppointmentDate) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>Información de Citas</h5>
                    <div className={styles.detailSectionContent}>
                      {selectedContact.firstAppointmentDate && (
                        <div className={styles.detailItem}>
                          <Icon name="calendar" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Primera cita:</span>
                            <span>{formatLocalDateTime(selectedContact.firstAppointmentDate)}</span>
                          </div>
                        </div>
                      )}
                      {selectedContact.nextAppointmentDate && (
                        <div className={styles.detailItem}>
                          <Icon name="clock" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Próxima cita:</span>
                            <span>{formatLocalDateTime(selectedContact.nextAppointmentDate)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Grid de 2 columnas: Citas y Pagos */}
                <div className={styles.twoColumnGrid}>
                  {/* COLUMNA IZQUIERDA: Citas */}
                  {selectedContact.appointments && selectedContact.appointments.length > 0 && (
                    <div className={styles.detailSection}>
                      <button
                        type="button"
                        className={styles.summaryCardButton}
                        onClick={() => setAppointmentsExpanded(prev => !prev)}
                      >
                        <div className={styles.summaryCardContent}>
                          <div>
                            <h5 className={styles.summaryTitle}>Citas</h5>
                            <p className={styles.summaryCount}>{selectedContact.appointments.length}</p>
                          </div>
                          <Icon
                            name={appointmentsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={20}
                            className={styles.summaryCardChevron}
                          />
                        </div>
                      </button>

                      {appointmentsExpanded && (
                        <ul className={styles.paymentList}>
                          {selectedContact.appointments.map(appointment => {
                            const statusInfo = getAppointmentStatusLabel(appointment.status)
                            const appointmentDate = new Date(appointment.start_time)
                            const timeStr = appointmentDate.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: true })

                            return (
                              <li key={appointment.id} className={styles.paymentItem}>
                                <div className={styles.paymentItemContent}>
                                  <div className={styles.paymentItemHeader}>
                                    <p className={styles.paymentAmount}>{appointment.title || 'Cita'}</p>
                                    <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                      {statusInfo.text}
                                    </Badge>
                                  </div>
                                  <div className={styles.paymentItemDetails}>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="calendar" size={12} />
                                      {formatLocalDateTime(appointment.start_time)}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="clock" size={12} />
                                      {timeStr}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="hash" size={12} />
                                      ID: {appointment.id.substring(0, 8)}...
                                    </span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* COLUMNA DERECHA: Pagos */}
                  {payments.length > 0 && (
                    <div className={styles.detailSection}>
                      <button
                        type="button"
                        className={styles.summaryCardButton}
                        onClick={() => setPaymentsExpanded(prev => !prev)}
                      >
                        <div className={styles.summaryCardContent}>
                          <div>
                            <h5 className={styles.summaryTitle}>Pagos</h5>
                            <p className={styles.summaryAmount}>{formatCurrency(payments.reduce((sum, payment) => sum + payment.amount, 0))}</p>
                          </div>
                          <Icon
                            name={paymentsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={20}
                            className={styles.summaryCardChevron}
                          />
                        </div>
                      </button>

                      {paymentsExpanded && (
                        <ul className={styles.paymentList}>
                          {payments.map(payment => {
                            const statusInfo = getStatusLabel(payment.status)
                            return (
                              <li key={payment.id} className={styles.paymentItem}>
                                <div className={styles.paymentItemContent}>
                                  <div className={styles.paymentItemHeader}>
                                    <p className={styles.paymentAmount}>{formatCurrency(payment.amount)}</p>
                                    {payment.status && statusInfo.text && (
                                      <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                        {statusInfo.text}
                                      </Badge>
                                    )}
                                  </div>
                                  <div className={styles.paymentItemDetails}>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="calendar" size={12} />
                                      {formatLocalDateShort(payment.date)}
                                    </span>
                                    <span className={styles.paymentDetailItem}>
                                      <Icon name="hash" size={12} />
                                      ID: {payment.id.substring(0, 8)}...
                                    </span>
                                  </div>
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

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
                                  <Badge variant={statusInfo.variant} className={styles.paymentStatus}>
                                    {statusInfo.text}
                                  </Badge>
                                )}
                              </div>
                              <span className={styles.paymentDate}>{formatLocalDateShort(refund.date)}</span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* Viaje del Cliente */}
                <div className={styles.detailSection}>
                  <ContactJourney contactId={selectedContact.id} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
