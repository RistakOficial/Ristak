import { useEffect, useMemo, useState } from 'react'
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

const isDailyContactJourneyEvent = (event?: JourneyEvent | null) =>
  Boolean(event && (event.type === 'contact_created' || isWhatsAppJourneyEvent(event)))

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

const getAdPlatformIcon = (platform?: string | null) => {
  const normalized = String(platform || '').toLowerCase()

  if (normalized.includes('instagram')) {
    return 'instagram'
  }

  if (normalized.includes('facebook')) {
    return 'facebook'
  }

  if (normalized.includes('tiktok')) {
    return 'tiktok'
  }

  if (normalized.includes('google')) {
    return 'google'
  }

  if (normalized.includes('youtube')) {
    return 'youtube'
  }

  if (normalized.includes('linkedin')) {
    return 'linkedin'
  }

  if (normalized.includes('twitter') || normalized === 'x') {
    return 'twitter'
  }

  if (normalized.includes('bing')) {
    return 'bing'
  }

  return 'meta-ads'
}

const getAdPlatformBadgeClass = (platform?: string | null) => {
  const icon = getAdPlatformIcon(platform)
  const platformClassMap: Record<string, string | undefined> = {
    instagram: styles.adBadgeInstagram,
    facebook: styles.adBadgeFacebook,
    tiktok: styles.adBadgeTikTok,
    google: styles.adBadgeGoogle,
    youtube: styles.adBadgeYouTube,
    linkedin: styles.adBadgeLinkedIn,
    twitter: styles.adBadgeTwitter,
    bing: styles.adBadgeBing,
    'meta-ads': styles.adBadgeMeta
  }

  return [styles.adBadge, platformClassMap[icon]].filter(Boolean).join(' ')
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
    if (data.is_ad_attributed) {
      return data.ad_platform ? `Anuncio ${data.ad_platform}` : 'Anuncio'
    }
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

const getTooltipContent = (event?: JourneyEvent | null, timezone?: string) => {
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
    if (data.is_ad_attributed) {
      items.push({ label: 'Origen', value: data.ad_platform || 'Anuncio' })
    }
    if (data.campaign_name) {
      items.push({ label: 'Campaña', value: formatUrlParameter(data.campaign_name) })
    }
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: formatUrlParameter(data.adset_name) })
    }
    if (data.referral_source_app) {
      items.push({ label: 'App origen', value: data.referral_source_app })
    }
    if (data.referral_entry_point) {
      items.push({ label: 'Entrada', value: data.referral_entry_point })
    }
    if (data.referral_source_type) {
      items.push({ label: 'Tipo origen', value: data.referral_source_type })
    }
    if (data.referral_source_url) {
      items.push({ label: 'URL origen', value: data.referral_source_url })
    }
    if (data.message_text) {
      items.push({ label: 'Mensaje', value: data.message_text })
    }
    {
      const adName = data.attribution_ad_name || data.referral_headline
      if (adName) {
        items.push({ label: 'Anuncio', value: formatUrlParameter(adName) })
      }
    }
    if (data.referral_body) {
      items.push({ label: 'Detalle anuncio', value: data.referral_body })
    }
    if (data.referral_image_url) {
      items.push({ label: 'Imagen anuncio', value: data.referral_image_url })
    }
    if (data.referral_video_url) {
      items.push({ label: 'Video anuncio', value: data.referral_video_url })
    }
    if (data.referral_thumbnail_url) {
      items.push({ label: 'Miniatura anuncio', value: data.referral_thumbnail_url })
    }
    if (data.phone) {
      items.push({ label: 'Teléfono', value: data.phone })
    }
    {
      const adId = data.attribution_ad_id || data.referral_source_id
      if (adId) {
        items.push({ label: 'ID anuncio', value: adId })
      }
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
      const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}) }
      const start = new Date(data.start_time).toLocaleTimeString('es-MX', timeOpts)
      const end = new Date(data.end_time).toLocaleTimeString('es-MX', timeOpts)
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

const hasMeaningfulValue = (value: unknown): boolean => {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 && trimmed !== 'null' && trimmed !== 'undefined'
  }
  return true
}

const isAdAttributedEvent = (event: JourneyEvent): boolean => {
  const data = (event.data && typeof event.data === 'object') ? event.data : {}
  return Boolean(
    data.is_ad_attributed ||
    data.attribution_ad_id ||
    data.referral_source_id ||
    data.referral_ctwa_clid ||
    data.campaign_name ||
    data.adset_name
  )
}

// Puntaje para elegir el evento de WhatsApp "representativo" del día: gana el que tenga
// atribución de anuncio y más datos. El bump por tipo asegura que, a igualdad de datos,
// el marcador final se renderice como mensaje de WhatsApp (con tooltip enriquecido) y no
// como "Contacto creado".
const whatsAppEventScore = (event: JourneyEvent): number => {
  const data = (event.data && typeof event.data === 'object') ? event.data : {}
  const completenessFields = [
    'referral_source_url', 'referral_source_type', 'referral_source_id', 'referral_ctwa_clid',
    'referral_headline', 'referral_body', 'campaign_name', 'adset_name',
    'attribution_ad_name', 'attribution_ad_id', 'ad_platform', 'message_text'
  ]
  const completeness = completenessFields.reduce(
    (score, field) => score + (hasMeaningfulValue(data[field]) ? 1 : 0),
    0
  )
  return (isAdAttributedEvent(event) ? 1000 : 0) + (event.type === 'whatsapp_message' ? 10 : 0) + completeness
}

// Clave de día en la MISMA zona horaria con la que la UI muestra las fechas, para que el
// "uno por día" coincida con lo que ve el usuario (evita duplicados al cruzar la medianoche
// UTC, p. ej. mensajes a las 5:55 PM y 6:04 PM en México).
const localDayFormatters = new Map<string, Intl.DateTimeFormat>()
const getLocalDayKey = (date: string, timezone: string): string => {
  const parsed = new Date(date)
  if (Number.isNaN(parsed.getTime())) return String(date || '')
  let formatter = localDayFormatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    })
    localDayFormatters.set(timezone, formatter)
  }
  return formatter.format(parsed)
}

const getDailyContactJourneyGroupKey = (event: JourneyEvent, timezone: string): string =>
  getLocalDayKey(event.date, timezone)

// Colapsa los eventos de contacto/WhatsApp por día local. Si el mismo día hay varios,
// gana el que trae metadata de anuncio (source_id, CTWA, campaña o anuncio resuelto).
const buildDisplayJourney = (events: JourneyEvent[], timezone: string): JourneyEvent[] => {
  const dailyContactEvents: JourneyEvent[] = []
  const otherEvents: JourneyEvent[] = []

  events.forEach(event => {
    if (event && isDailyContactJourneyEvent(event)) {
      dailyContactEvents.push(event)
    } else if (event) {
      otherEvents.push(event)
    }
  })

  const byGroup = new Map<string, JourneyEvent[]>()
  dailyContactEvents.forEach(event => {
    const key = getDailyContactJourneyGroupKey(event, timezone)
    const bucket = byGroup.get(key)
    if (bucket) {
      bucket.push(event)
    } else {
      byGroup.set(key, [event])
    }
  })

  const mergedDailyContactEvents: JourneyEvent[] = []
  byGroup.forEach(dayEvents => {
    const sorted = [...dayEvents].sort((a, b) => whatsAppEventScore(b) - whatsAppEventScore(a))
    const primary = sorted[0]
    const hasWhatsAppEvent = dayEvents.some(isWhatsAppJourneyEvent)

    const mergedData: Record<string, any> = {}
    sorted.forEach(event => {
      const data = (event.data && typeof event.data === 'object') ? event.data : {}
      Object.entries(data).forEach(([key, value]) => {
        if (!hasMeaningfulValue(mergedData[key]) && hasMeaningfulValue(value)) {
          mergedData[key] = value
        }
      })
    })
    mergedData.is_ad_attributed = dayEvents.some(isAdAttributedEvent)

    mergedDailyContactEvents.push({
      ...primary,
      type: hasWhatsAppEvent ? 'whatsapp_message' : primary.type,
      data: mergedData
    })
  })

  return [...otherEvents, ...mergedDailyContactEvents].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  )
}

export const ContactJourney = ({ contactId }: ContactJourneyProps) => {
  const { timezone, formatLocalDateShort, formatLocalDateTime } = useTimezone()
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

  // Agrupa contacto/WhatsApp a un solo evento por día local antes de pintar.
  const displayJourney = useMemo(() => buildDisplayJourney(journey, timezone), [journey, timezone])

  if (loading) {
    return (
      <div className={styles.loading}>
        <div className={styles.spinner} />
        <span>Cargando viaje...</span>
      </div>
    )
  }

  if (displayJourney.length === 0) {
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
        {displayJourney.map((event, index) => {
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
          const isLast = index === displayJourney.length - 1
          const isAdAttributed = Boolean(event.data?.is_ad_attributed)
          const adPlatformIcon = getAdPlatformIcon(event.data?.ad_platform)

          const tooltipItems = getTooltipContent(event, timezone)

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
                  {isAdAttributed && (
                    <span className={getAdPlatformBadgeClass(event.data?.ad_platform)} title={event.data?.ad_platform || 'Anuncio'}>
                      <Icon name={adPlatformIcon as any} size={11} />
                    </span>
                  )}
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
