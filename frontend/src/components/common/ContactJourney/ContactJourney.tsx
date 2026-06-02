import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/common'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import { useTimezone } from '@/contexts/TimezoneContext'
import styles from './ContactJourney.module.css'

interface ContactJourneyProps {
  contactId: string
}

const isWhatsAppJourneyEvent = (event?: JourneyEvent | null) => {
  if (!event) return false
  const data = (event.data && typeof event.data === 'object') ? event.data : {}
  const source = String(data.source || data.referral_source_app || data.referral_entry_point || '').toLowerCase()

  return event.type === 'whatsapp_message' || source.includes('whatsapp')
}

const getEventIcon = (event: JourneyEvent) => {
  if (isWhatsAppJourneyEvent(event)) {
    return 'whatsapp'
  }

  switch (event.type) {
    case 'page_visit':
      return 'mouse-pointer-click'
    case 'contact_created':
      return 'user-plus'
    case 'appointment':
      return 'calendar'
    case 'payment':
      return 'circle-dollar-sign'
    default:
      return 'mouse-pointer-click'
  }
}

const getEventTitle = (event: JourneyEvent) => {
  if (isWhatsAppJourneyEvent(event)) {
    return 'WhatsApp'
  }

  switch (event.type) {
    case 'page_visit':
      return 'Visita'
    case 'contact_created':
      return 'Contacto'
    case 'appointment':
      return 'Cita'
    case 'payment':
      return 'Compra'
    default:
      return 'Evento'
  }
}

const getEventColor = (event: JourneyEvent) => {
  if (isWhatsAppJourneyEvent(event)) {
    return 'green'
  }

  switch (event.type) {
    case 'page_visit':
      return 'blue'
    case 'contact_created':
      return 'purple'
    case 'appointment':
      return 'orange'
    case 'payment':
      return 'success'
    default:
      return 'gray'
  }
}

const getEventDescription = (event?: JourneyEvent | null): string => {
  if (!event) {
    return ''
  }

  const { type } = event
  const data = (event.data && typeof event.data === 'object') ? event.data : {}

  if (type === 'page_visit') {
    // Usar normalizador con prioridad: referrer_url → site_source_name → utm_source → source_platform
    return normalizeTrafficSource(data)
  }

  if (type === 'whatsapp_message') {
    return 'WhatsApp'
  }

  if (type === 'contact_created') {
    if (isWhatsAppJourneyEvent(event)) {
      return 'Contacto creado'
    }
    // Solo mostrar la fuente si es corta
    const source = data.source || 'Registro'
    return source.length > 15 ? 'Se registró' : source
  }

  if (type === 'appointment') {
    // NO mostrar el título largo, solo "Cita"
    return 'Agendada'
  }

  if (type === 'payment') {
    // Solo mostrar el monto
    return data.amount ? formatCurrency(data.amount) : 'Compra'
  }

  return ''
}

const getTooltipContent = (event?: JourneyEvent | null) => {
  if (!event) {
    return []
  }

  const { type } = event
  const data = (event.data && typeof event.data === 'object') ? event.data : {}

  const items: { label: string; value: string }[] = []

  if (type === 'page_visit') {
    if (data.landing_page) {
      items.push({ label: 'Página', value: data.landing_page })
    }
    // Usar normalizador para mostrar fuente consistente
    const source = normalizeTrafficSource(data)
    if (source && source !== 'Desconocido') {
      items.push({ label: 'Fuente', value: source })
    }
    if (data.campaign_name || data.utm_campaign) {
      items.push({ label: 'Campaña', value: formatUrlParameter(data.campaign_name || data.utm_campaign) })
    }
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: data.adset_name })
    }
    if (data.ad_name || data.utm_content) {
      items.push({ label: 'Anuncio', value: formatUrlParameter(data.ad_name || data.utm_content) })
    }
    if (data.ad_id) {
      items.push({ label: 'ID Anuncio', value: data.ad_id })
    }
    if (data.device_type) {
      items.push({ label: 'Dispositivo', value: data.device_type })
    }
    if (data.browser) {
      items.push({ label: 'Navegador', value: data.browser })
    }
    if (data.geo_city || data.geo_region || data.geo_country) {
      const location = [data.geo_city, data.geo_region, data.geo_country].filter(Boolean).join(', ')
      items.push({ label: 'Ubicación', value: location })
    }
  }

  if (type === 'whatsapp_message') {
    if (data.message_text) {
      items.push({ label: 'Mensaje', value: data.message_text })
    }
    if (data.referral_headline) {
      items.push({ label: 'Mensaje', value: data.referral_headline })
    }
    if (data.referral_body) {
      items.push({ label: 'Contenido', value: data.referral_body })
    }
    if (data.phone) {
      items.push({ label: 'Teléfono', value: data.phone })
    }
    if (data.referral_source_id) {
      items.push({ label: 'ID anuncio', value: data.referral_source_id })
    }
    if (data.referral_ctwa_clid) {
      items.push({ label: 'CTWA CLID', value: data.referral_ctwa_clid })
    }
  }

  if (type === 'contact_created') {
    if (data.source) {
      items.push({ label: 'Fuente', value: data.source })
    }
    if (data.campaign_name) {
      items.push({ label: 'Campaña', value: data.campaign_name })
    }
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: data.adset_name })
    }
    if (data.attribution_ad_name) {
      items.push({ label: 'Anuncio', value: formatUrlParameter(data.attribution_ad_name) })
    }
    if (data.attribution_ad_id) {
      items.push({ label: 'ID Anuncio', value: data.attribution_ad_id })
    }
  }

  if (type === 'appointment') {
    if (data.title) {
      items.push({ label: 'Título', value: data.title })
    }
    if (data.status) {
      items.push({ label: 'Estado', value: data.status })
    }
    if (data.start_time && data.end_time) {
      const start = new Date(data.start_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
      const end = new Date(data.end_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
      items.push({ label: 'Horario', value: `${start} - ${end}` })
    }
    if (data.address) {
      items.push({ label: 'Ubicación', value: data.address })
    }
    if (data.notes) {
      items.push({ label: 'Notas', value: data.notes })
    }
  }

  if (type === 'payment') {
    if (data.amount) {
      items.push({ label: 'Monto', value: formatCurrency(data.amount) })
    }
    if (data.title) {
      items.push({ label: 'Concepto', value: data.title })
    }
    if (data.type) {
      items.push({ label: 'Tipo', value: data.type })
    }
    if (data.payment_provider) {
      items.push({ label: 'Proveedor', value: data.payment_provider })
    }
  }

  return items
}

export const ContactJourney = ({ contactId }: ContactJourneyProps) => {
  const { formatLocalDateShort, formatLocalDateTime } = useTimezone()
  const [journey, setJourney] = useState<JourneyEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [hoveredEventIndex, setHoveredEventIndex] = useState<number | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    const loadJourney = async () => {
      setLoading(true)
      const data = await contactsService.getContactJourney(contactId)
      setJourney(data)
      setLoading(false)
    }

    loadJourney()
  }, [contactId])

  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <span>Cargando viaje...</span>
      </div>
    )
  }

  if (journey.length === 0) {
    return (
      <div className={styles.empty}>
        <Icon name="mouse-pointer-click" size={20} />
        <p>No hay eventos registrados</p>
      </div>
    )
  }

  return (
    <div className={styles.journey}>
      <h4 className={styles.title}>Viaje del Cliente</h4>
      <div className={styles.timeline}>
        {journey.map((event, index) => {
          if (
            !event ||
            typeof event !== 'object' ||
            !('type' in event) ||
            typeof event.type !== 'string'
          ) {
            return null
          }

          const iconName = getEventIcon(event)
          const color = getEventColor(event)
          const isLast = index === journey.length - 1

          const tooltipItems = getTooltipContent(event)

          return (
            <div key={index} className={styles.eventWrapper}>
              <div
                className={styles.event}
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setHoveredEventIndex(index)
                  setTooltipPosition({
                    top: rect.top - 20,
                    left: rect.left + rect.width / 2
                  })
                }}
                onMouseLeave={() => {
                  setHoveredEventIndex(null)
                  setTooltipPosition(null)
                }}
              >
                <div className={`${styles.eventDot} ${styles[color]}`}>
                  <Icon name={iconName as any} size={18} />
                </div>
                <div className={styles.eventContent}>
                  <span className={styles.eventTitle}>{getEventTitle(event)}</span>
                  <span className={styles.eventDescription}>{getEventDescription(event)}</span>
                  <span className={styles.eventDate}>{formatLocalDateShort(event.date)}</span>
                </div>
              </div>

              {/* Tooltip */}
              {hoveredEventIndex === index && tooltipPosition && tooltipItems.length > 0 && createPortal(
                <div
                  className={styles.eventTooltip}
                  style={{
                    top: `${tooltipPosition.top}px`,
                    left: `${tooltipPosition.left}px`,
                    position: 'fixed',
                    transform: 'translate(-50%, -100%)',
                    zIndex: 2147483647
                  }}
                >
                  <div className={styles.tooltipTitle}>{getEventTitle(event)}</div>
                  <div className={styles.tooltipDate}>{formatLocalDateTime(event.date)}</div>
                  {tooltipItems.map((item, idx) => (
                    <div key={idx} className={styles.tooltipItem}>
                      <span className={styles.tooltipLabel}>{item.label}:</span>
                      <span className={styles.tooltipValue}>{item.value}</span>
                    </div>
                  ))}
                </div>,
                document.body
              )}

              {!isLast && (
                <div className={styles.connector}>
                  <Icon name="arrow-right" size={16} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
