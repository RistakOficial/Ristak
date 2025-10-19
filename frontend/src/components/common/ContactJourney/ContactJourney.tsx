import { useEffect, useState } from 'react'
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

export const ContactJourney = ({ contactId }: ContactJourneyProps) => {
  const [journey, setJourney] = useState<JourneyEvent[]>([])
  const [loading, setLoading] = useState(true)

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

          return (
            <div key={index} className={styles.eventWrapper}>
              <div className={styles.event}>
                <div className={`${styles.eventDot} ${styles[color]}`}>
                  <Icon name={iconName as any} size={20} />
                </div>
                <div className={styles.eventContent}>
                  <span className={styles.eventTitle}>{getEventTitle(event.type)}</span>
                  <span className={styles.eventDescription}>{getEventDescription(event)}</span>
                  <span className={styles.eventDate}>{formatDate(event.date, 'short')}</span>
                </div>
              </div>
              {!isLast && <div className={styles.connector} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
