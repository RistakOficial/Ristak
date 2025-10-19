import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/common'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { formatCurrency, formatDate } from '@/utils/format'
import styles from './ContactJourney.module.css'

interface ContactJourneyProps {
  contactId: string
}

const getEventIcon = (type: JourneyEvent['type']) => {
  switch (type) {
    case 'first_visit':
      return 'mouse-pointer-click'
    case 'whatsapp_message':
      return 'message-circle'
    case 'contact_created':
      return 'user-plus'
    case 'first_appointment':
      return 'calendar'
    case 'first_payment':
      return 'circle-dollar-sign'
    default:
      return 'mouse-pointer-click'
  }
}

const getEventTitle = (type: JourneyEvent['type']) => {
  switch (type) {
    case 'first_visit':
      return 'Primera visita'
    case 'whatsapp_message':
      return 'WhatsApp'
    case 'contact_created':
      return 'Contacto'
    case 'first_appointment':
      return 'Primera cita'
    case 'first_payment':
      return 'Primera compra'
    default:
      return 'Evento'
  }
}

const getEventColor = (type: JourneyEvent['type']) => {
  switch (type) {
    case 'first_visit':
      return 'blue'
    case 'whatsapp_message':
      return 'green'
    case 'contact_created':
      return 'purple'
    case 'first_appointment':
      return 'orange'
    case 'first_payment':
      return 'success'
    default:
      return 'gray'
  }
}

const getEventDescription = (event: JourneyEvent): string => {
  const { type, data } = event

  if (type === 'first_visit') {
    if (data.campaign_name || data.utm_campaign) {
      return data.campaign_name || data.utm_campaign
    }
    if (data.ad_name || data.utm_content) {
      return data.ad_name || data.utm_content
    }
    if (data.source_platform || data.site_source_name) {
      return data.source_platform || data.site_source_name
    }
    return 'Visitó el sitio'
  }

  if (type === 'whatsapp_message') {
    return data.referral_headline || 'Mensaje de WhatsApp'
  }

  if (type === 'contact_created') {
    return data.source || 'Se registró'
  }

  if (type === 'first_appointment') {
    return data.title || 'Agendó cita'
  }

  if (type === 'first_payment') {
    return data.amount ? formatCurrency(data.amount) : 'Realizó compra'
  }

  return ''
}

const getTooltipContent = (event: JourneyEvent) => {
  const { type, data } = event

  const items: { label: string; value: string }[] = []

  if (type === 'first_visit') {
    if (data.site_source_name || data.source_platform) {
      items.push({ label: 'Fuente', value: data.site_source_name || data.source_platform })
    }
    if (data.campaign_name || data.utm_campaign) {
      items.push({ label: 'Campaña', value: data.campaign_name || data.utm_campaign })
    }
    if (data.ad_name || data.utm_content) {
      items.push({ label: 'Anuncio', value: data.ad_name || data.utm_content })
    }
    if (data.ad_id) {
      items.push({ label: 'ID Anuncio', value: data.ad_id })
    }
    if (data.landing_page) {
      items.push({ label: 'Página', value: data.landing_page })
    }
  }

  if (type === 'whatsapp_message') {
    if (data.referral_headline) {
      items.push({ label: 'Mensaje', value: data.referral_headline })
    }
    if (data.referral_body) {
      items.push({ label: 'Contenido', value: data.referral_body })
    }
  }

  if (type === 'contact_created') {
    if (data.source) {
      items.push({ label: 'Fuente', value: data.source })
    }
  }

  if (type === 'first_appointment') {
    if (data.title) {
      items.push({ label: 'Título', value: data.title })
    }
    if (data.calendar_name) {
      items.push({ label: 'Calendario', value: data.calendar_name })
    }
    if (data.status) {
      items.push({ label: 'Estado', value: data.status })
    }
  }

  if (type === 'first_payment') {
    if (data.amount) {
      items.push({ label: 'Monto', value: formatCurrency(data.amount) })
    }
    if (data.type) {
      items.push({ label: 'Tipo', value: data.type })
    }
  }

  return items
}

export const ContactJourney = ({ contactId }: ContactJourneyProps) => {
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
          const iconName = getEventIcon(event.type)
          const color = getEventColor(event.type)
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
                    top: rect.top - 10,
                    left: rect.left + rect.width / 2
                  })
                }}
                onMouseLeave={() => {
                  setHoveredEventIndex(null)
                  setTooltipPosition(null)
                }}
              >
                <div className={`${styles.eventDot} ${styles[color]}`}>
                  <Icon name={iconName as any} size={20} />
                </div>
                <div className={styles.eventContent}>
                  <span className={styles.eventTitle}>{getEventTitle(event.type)}</span>
                  <span className={styles.eventDescription}>{getEventDescription(event)}</span>
                  <span className={styles.eventDate}>{formatDate(event.date, 'short')}</span>
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
                  <div className={styles.tooltipTitle}>{getEventTitle(event.type)}</div>
                  <div className={styles.tooltipDate}>{formatDate(event.date, 'long')}</div>
                  {tooltipItems.map((item, idx) => (
                    <div key={idx} className={styles.tooltipItem}>
                      <span className={styles.tooltipLabel}>{item.label}:</span>
                      <span className={styles.tooltipValue}>{item.value}</span>
                    </div>
                  ))}
                </div>,
                document.body
              )}

              {!isLast && <div className={styles.connector} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
