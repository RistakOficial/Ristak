import { useState, useMemo, useEffect } from 'react'
import { Modal, Icon, Badge, type BadgeVariant } from '@/components/common'
import { formatUrlParameter } from '@/utils/format'
import { CONTACT_STAGE_BADGE_VARIANTS, getContactStageBadge } from '@/utils/contactStageBadge'
import { buildSearchIndex, prepareSearchQuery, searchIndexIncludes } from '@/utils/searchText'
import { useLabels } from '@/contexts/LabelsContext'
import { useTimezone } from '@/contexts/TimezoneContext'
import styles from './VisitorDetailsModal.module.css'

interface VisitorDetail {
  visitorId: string
  sessionId?: string
  contact?: {
    id?: string | null
    name?: string | null
    email?: string | null
    phone?: string | null
    ltv?: number
    purchases?: number
    appointments?: any[]
    hasAttendedAppointment?: boolean
  } | null
  firstVisit?: string | null
  createdAt?: string | null
  landingUrl?: string | null
  referrerUrl?: string | null
  // UTM parameters
  utmSource?: string | null
  utmMedium?: string | null
  utmCampaign?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  // Click IDs
  gclid?: string | null
  fbclid?: string | null
  msclkid?: string | null
  ttclid?: string | null
  // Device info
  deviceType?: string | null
  browser?: string | null
  os?: string | null
  language?: string | null
  timezone?: string | null
  country?: string | null
  city?: string | null
  region?: string | null
  // Ad info
  adId?: string | null
  adsetId?: string | null
  campaignId?: string | null
  adName?: string | null
  campaignName?: string | null
  adsetName?: string | null
}

interface VisitorDetailsModalProps {
  isOpen: boolean
  onClose: () => void
  title: string
  subtitle?: string
  data: VisitorDetail[] | Record<string, VisitorDetail> | null | undefined
  loading: boolean
}

export function VisitorDetailsModal({
  isOpen,
  onClose,
  title,
  subtitle,
  data,
  loading
}: VisitorDetailsModalProps) {
  const [selectedVisitor, setSelectedVisitor] = useState<VisitorDetail | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [appointmentsExpanded, setAppointmentsExpanded] = useState(false)
  const { labels } = useLabels()
  const { formatLocalDateTime } = useTimezone()

  // Helper para formatear texto de estado
  const formatStatusText = (text: string): string => {
    return text
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  }

  // Función para obtener el label del estado de una cita
  const getAppointmentStatusLabel = (status?: string | null): { text: string; variant: BadgeVariant } => {
    if (!status) return { text: 'Reservado', variant: 'warning' }
    const statusLower = status.toLowerCase()

    if (['confirmed', 'booked', 'scheduled'].includes(statusLower)) {
      return { text: 'Reservado', variant: 'warning' }
    }
    if (['completed', 'showed', 'attended'].includes(statusLower)) {
      return { text: 'Asistió', variant: CONTACT_STAGE_BADGE_VARIANTS.attended }
    }
    if (['cancelled', 'canceled', 'no_show', 'noshow'].includes(statusLower)) {
      return { text: 'Cancelado', variant: 'error' }
    }
    if (['pending', 'unconfirmed'].includes(statusLower)) {
      return { text: 'Pendiente', variant: 'warning' }
    }

    return { text: formatStatusText(statusLower), variant: 'neutral' }
  }

  // Función para determinar el badge de prioridad del contacto
  const getContactBadge = (visitor: VisitorDetail) =>
    getContactStageBadge(visitor.contact, labels)

  const normalizedData = useMemo<VisitorDetail[]>(() => {
    if (Array.isArray(data)) {
      return data
    }

    if (data && typeof data === 'object') {
      return Object.values(data).filter(Boolean) as VisitorDetail[]
    }

    return []
  }, [data])

  // Seleccionar automáticamente el primer visitante cuando se abre el modal
  useEffect(() => {
    if (isOpen && normalizedData.length > 0) {
      setSelectedVisitor(normalizedData[0])
    } else if (!isOpen) {
      setSelectedVisitor(null)
      setSearchQuery('')
    }
  }, [isOpen, normalizedData])

  const preparedVisitorSearch = useMemo(() => prepareSearchQuery(searchQuery), [searchQuery])
  const visitorSearchIndexes = useMemo(() => {
    return normalizedData.map(visitor => buildSearchIndex([
      visitor.contact?.name,
      visitor.contact?.email,
      visitor.contact?.phone,
      visitor.visitorId,
      visitor.utmSource,
      visitor.utmCampaign
    ]))
  }, [normalizedData])

  // Filtrar visitantes según búsqueda
  const filteredData = useMemo(() => {
    if (!preparedVisitorSearch.normalized) return normalizedData

    return normalizedData.filter((visitor, index) =>
      searchIndexIncludes(
        visitorSearchIndexes[index] ?? buildSearchIndex([
          visitor.contact?.name,
          visitor.contact?.email,
          visitor.contact?.phone,
          visitor.visitorId,
          visitor.utmSource,
          visitor.utmCampaign
        ]),
        preparedVisitorSearch
      )
    )
  }, [normalizedData, preparedVisitorSearch, visitorSearchIndexes])

  const getDeviceIcon = (deviceType?: string) => {
    if (!deviceType) return 'monitor'
    const type = deviceType.toLowerCase()
    if (type.includes('mobile') || type.includes('phone')) return 'smartphone'
    if (type.includes('tablet') || type.includes('ipad')) return 'tablet'
    return 'monitor'
  }

  const getSourceBadgeVariant = (source?: string): BadgeVariant => {
    if (!source) return 'neutral'
    const sourceLower = source.toLowerCase()
    if (sourceLower.includes('google')) return 'success'
    if (sourceLower.includes('facebook') || sourceLower.includes('meta')) return 'info'
    if (sourceLower.includes('direct')) return 'neutral'
    if (sourceLower.includes('instagram')) return 'purple'
    if (sourceLower.includes('tiktok')) return 'error'
    return 'purple'
  }

  const getVisitorIdSuffix = (visitorId?: string) => {
    if (!visitorId) return 'sin-id'
    return visitorId.slice(-8)
  }

  const getVisitorName = (visitor: VisitorDetail) => {
    if (visitor.contact?.name) return visitor.contact.name
    if (visitor.contact?.email) return visitor.contact.email
    if (visitor.contact?.phone) return visitor.contact.phone
    return `Visitante ${getVisitorIdSuffix(visitor.visitorId)}`
  }

  const getVisitorDescription = (visitor: VisitorDetail) => {
    if (visitor.contact?.email) return visitor.contact.email
    if (visitor.contact?.phone) return visitor.contact.phone
    if (visitor.utmCampaign) return formatUrlParameter(visitor.utmCampaign)
    if (visitor.utmSource) return `Desde ${formatUrlParameter(visitor.utmSource)}`
    return 'Visitante anónimo'
  }

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
            <div className={styles.headerTitleGroup}>
              <div className={styles.titleRow}>
                <h3 className={styles.title}>{title}</h3>
                <div className={styles.stats}>
                  <span className={styles.statItem}>
                    {normalizedData.length} {normalizedData.length === 1 ? 'visitante' : 'visitantes'}
                  </span>
                  <span className={styles.statValue}>
                    {normalizedData.filter(d => d.contact?.id).length} identificados
                  </span>
                </div>
              </div>
              {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
            </div>
            <button onClick={onClose} className={styles.closeButton}>
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Main content */}
        <div className={styles.mainContent}>
          {/* Left panel - Lista de visitantes */}
          <div className={selectedVisitor ? styles.leftPanel : styles.leftPanelFull}>
            {/* Search bar */}
            <div className={styles.searchContainer}>
              <div className={styles.searchInputWrapper}>
                <Icon name="search" size={16} className={styles.searchIcon} />
                <input
                  type="text"
                  placeholder="Buscar visitantes..."
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

            {/* Visitor list */}
            <div className={styles.visitorList}>
              {loading ? (
                <div className={styles.emptyState}>
                  <Icon name="refresh" size={24} className={styles.spinIcon} />
                  <p>Cargando visitantes...</p>
                </div>
              ) : filteredData.length === 0 ? (
                <div className={styles.emptyState}>
                  <Icon name="users" size={24} />
                  <p>{searchQuery ? 'No se encontraron resultados' : 'No hay visitantes para mostrar'}</p>
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
                  {filteredData.map((visitor) => (
                    <div
                      key={visitor.visitorId}
                      onClick={() => setSelectedVisitor(visitor)}
                      className={`${styles.visitorItem} ${selectedVisitor?.visitorId === visitor.visitorId ? styles.visitorItemSelected : ''}`}
                    >
                      <div className={styles.visitorAvatar}>
                        <Icon name="user" size={16} />
                      </div>

                      <div className={styles.visitorInfo}>
                        <p className={styles.visitorName}>
                          {getVisitorName(visitor)}
                        </p>
                        <p className={styles.visitorDetail}>
                          {getVisitorDescription(visitor)}
                        </p>
                      </div>

                      <div className={styles.visitorIndicators}>
                        {(() => {
                          const badge = getContactBadge(visitor)
                          return badge ? (
                            <Badge variant={badge.variant}>{badge.text}</Badge>
                          ) : null
                        })()}
                        {visitor.deviceType && (
                          <Icon name={getDeviceIcon(visitor.deviceType)} size={14} className={styles.deviceIcon} />
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>

            {/* Footer */}
            {normalizedData.length > 0 && (
              <div className={styles.footer}>
                <span>
                  Mostrando {filteredData.length} de {normalizedData.length}
                </span>
              </div>
            )}
          </div>

          {/* Right panel - Detalles del visitante */}
          {selectedVisitor && (
            <div className={styles.rightPanel}>
              {/* Visitor header */}
              <div className={styles.visitorHeader}>
                <div className={styles.visitorHeaderAvatar}>
                  <Icon name="user" size={20} />
                </div>
                <div className={styles.visitorHeaderInfo}>
                  <h4 className={styles.visitorHeaderName}>
                    {getVisitorName(selectedVisitor)}
                  </h4>
                  {(selectedVisitor.contact?.email || selectedVisitor.contact?.phone) && (
                    <div className={styles.visitorHeaderMeta}>
                      {selectedVisitor.contact?.email && (
                        <span>{selectedVisitor.contact.email}</span>
                      )}
                      {selectedVisitor.contact?.email && selectedVisitor.contact?.phone && (
                        <span className={styles.metaSeparator}>/</span>
                      )}
                      {selectedVisitor.contact?.phone && (
                        <span>{selectedVisitor.contact.phone}</span>
                      )}
                    </div>
                  )}
                  {!selectedVisitor.contact?.id && (
                    <p className={styles.visitorHeaderAnonymous}>
                      Visitante anónimo - ID: {getVisitorIdSuffix(selectedVisitor.visitorId)}
                    </p>
                  )}
                </div>
              </div>

              {/* Visitor details */}
              <div className={styles.visitorDetails}>
                {/* Información de contacto (si está identificado) */}
                {selectedVisitor.contact?.id && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Información de Contacto
                    </h5>
                    <div className={styles.detailSectionContent}>
                      {selectedVisitor.contact.email && (
                        <div className={styles.detailItem}>
                          <Icon name="mail" size={16} />
                          <span>{selectedVisitor.contact.email}</span>
                        </div>
                      )}
                      {selectedVisitor.contact.phone && (
                        <div className={styles.detailItem}>
                          <Icon name="phone" size={16} />
                          <span>{selectedVisitor.contact.phone}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Citas */}
                {selectedVisitor.contact?.appointments && selectedVisitor.contact.appointments.length > 0 && (
                  <div className={styles.detailSection}>
                    <button
                      type="button"
                      className={styles.toggleButton}
                      onClick={() => setAppointmentsExpanded(prev => !prev)}
                    >
                      <div className={styles.toggleLabel}>
                        <Icon name={appointmentsExpanded ? 'chevron-down' : 'chevron-right'} size={16} />
                        <span>Citas ({selectedVisitor.contact.appointments.length})</span>
                      </div>
                    </button>

                    {appointmentsExpanded && (
                      <ul className={styles.paymentList}>
                        {selectedVisitor.contact.appointments
                          .filter((appointment: any) => appointment && appointment.id && appointment.start_time)
                          .map((appointment: any) => {
                            const statusInfo = getAppointmentStatusLabel(appointment?.status)
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

                {/* Información de la visita */}
                <div className={styles.detailSection}>
                  <h5 className={styles.detailSectionTitle}>
                    Información de la Visita
                  </h5>
                  <div className={styles.detailSectionContent}>
                    <div className={styles.detailItem}>
                      <Icon name="calendar" size={16} />
                      <span>Primera visita: {formatLocalDateTime(selectedVisitor.firstVisit || selectedVisitor.createdAt || '')}</span>
                    </div>
                    {selectedVisitor.landingUrl && (
                      <div className={styles.detailItem}>
                        <Icon name="link" size={16} />
                        <div className={styles.urlWrapper}>
                          <span className={styles.detailItemLabel}>Página de entrada:</span>
                          <span className={styles.urlText}>{selectedVisitor.landingUrl}</span>
                        </div>
                      </div>
                    )}
                    {selectedVisitor.referrerUrl && selectedVisitor.referrerUrl !== 'direct' && (
                      <div className={styles.detailItem}>
                        <Icon name="arrow-left" size={16} />
                        <div className={styles.urlWrapper}>
                          <span className={styles.detailItemLabel}>Referido desde:</span>
                          <span className={styles.urlText}>{selectedVisitor.referrerUrl}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Atribución / UTM */}
                {(selectedVisitor.utmSource || selectedVisitor.utmCampaign || selectedVisitor.campaignName || selectedVisitor.adsetName || selectedVisitor.adName) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Origen del Tráfico
                    </h5>
                    <div className={styles.detailSectionContent}>
                      {selectedVisitor.utmSource && (
                        <div className={styles.detailItem}>
                          <Icon name="tag" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Fuente:</span>
                            <Badge variant={getSourceBadgeVariant(selectedVisitor.utmSource)} className={styles.sourceBadge}>
                              {formatUrlParameter(selectedVisitor.utmSource)}
                            </Badge>
                          </div>
                        </div>
                      )}
                      {(selectedVisitor.campaignName || selectedVisitor.utmCampaign) && (
                        <div className={styles.detailItem}>
                          <Icon name="megaphone" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Campaña:</span>
                            <span> {selectedVisitor.campaignName || formatUrlParameter(selectedVisitor.utmCampaign || '')}</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.adsetName && (
                        <div className={styles.detailItem}>
                          <Icon name="layers" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Conjunto de anuncios:</span>
                            <span> {selectedVisitor.adsetName}</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.adName && (
                        <div className={styles.detailItem}>
                          <Icon name="file-text" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Anuncio:</span>
                            <span> {formatUrlParameter(selectedVisitor.adName)}</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.utmMedium && (
                        <div className={styles.detailItem}>
                          <Icon name="share-2" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Medio:</span>
                            <span> {formatUrlParameter(selectedVisitor.utmMedium)}</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.adId && (
                        <div className={styles.detailItem}>
                          <Icon name="hash" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>ID del Anuncio:</span>
                            <span className={styles.idText}> {selectedVisitor.adId}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Click IDs */}
                {(selectedVisitor.gclid || selectedVisitor.fbclid || selectedVisitor.msclkid || selectedVisitor.ttclid) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Identificadores de Click
                    </h5>
                    <div className={styles.detailSectionContent}>
                      {selectedVisitor.gclid && (
                        <div className={styles.detailItem}>
                          <Icon name="link-2" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Google Click ID:</span>
                            <span className={styles.idText}> {selectedVisitor.gclid.slice(0, 20)}...</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.fbclid && (
                        <div className={styles.detailItem}>
                          <Icon name="link-2" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Facebook Click ID:</span>
                            <span className={styles.idText}> {selectedVisitor.fbclid.slice(0, 20)}...</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.msclkid && (
                        <div className={styles.detailItem}>
                          <Icon name="link-2" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>Microsoft Click ID:</span>
                            <span className={styles.idText}> {selectedVisitor.msclkid.slice(0, 20)}...</span>
                          </div>
                        </div>
                      )}
                      {selectedVisitor.ttclid && (
                        <div className={styles.detailItem}>
                          <Icon name="link-2" size={16} />
                          <div>
                            <span className={styles.detailItemLabel}>TikTok Click ID:</span>
                            <span className={styles.idText}> {selectedVisitor.ttclid.slice(0, 20)}...</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Dispositivo e información técnica */}
                <div className={styles.detailSection}>
                  <h5 className={styles.detailSectionTitle}>
                    Información del Dispositivo
                  </h5>
                  <div className={styles.detailSectionContent}>
                    <div className={styles.deviceGrid}>
                      {selectedVisitor.deviceType && (
                        <div className={styles.deviceItem}>
                          <Icon name={getDeviceIcon(selectedVisitor.deviceType)} size={16} />
                          <span>{selectedVisitor.deviceType}</span>
                        </div>
                      )}
                      {selectedVisitor.browser && (
                        <div className={styles.deviceItem}>
                          <Icon name="globe" size={16} />
                          <span>{selectedVisitor.browser}</span>
                        </div>
                      )}
                      {selectedVisitor.os && (
                        <div className={styles.deviceItem}>
                          <Icon name="monitor" size={16} />
                          <span>{selectedVisitor.os}</span>
                        </div>
                      )}
                      {selectedVisitor.language && (
                        <div className={styles.deviceItem}>
                          <Icon name="message-circle" size={16} />
                          <span>{selectedVisitor.language}</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Ubicación */}
                {(selectedVisitor.country || selectedVisitor.city || selectedVisitor.region) && (
                  <div className={styles.detailSection}>
                    <h5 className={styles.detailSectionTitle}>
                      Ubicación
                    </h5>
                    <div className={styles.detailSectionContent}>
                      <div className={styles.detailItem}>
                        <Icon name="map-pin" size={16} />
                        <span>
                          {[selectedVisitor.city, selectedVisitor.region, selectedVisitor.country]
                            .filter(Boolean)
                            .join(', ')}
                        </span>
                      </div>
                      {selectedVisitor.timezone && (
                        <div className={styles.detailItem}>
                          <Icon name="clock" size={16} />
                          <span>Zona horaria: {selectedVisitor.timezone}</span>
                        </div>
                      )}
                    </div>
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
