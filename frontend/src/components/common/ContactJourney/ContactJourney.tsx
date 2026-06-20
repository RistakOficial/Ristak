import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@/components/common'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { getFloatingLayerZIndex } from '@/utils/layering'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import { useTimezone } from '@/contexts/TimezoneContext'
import styles from './ContactJourney.module.css'

interface ContactJourneyProps {
  contactId: string
}

const GENERIC_TRAFFIC_SOURCES = new Set(['directo', 'desconocido', 'otro'])
const OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS = new Set([
  'outbound',
  'outgoing',
  'sent',
  'business',
  'api',
  'app',
  'business_echo',
  'smb_echo',
  'echo',
  'message_echo'
])
const MESSAGE_JOURNEY_EVENT_TYPES = new Set(['whatsapp_message', 'meta_message'])
const WEB_JOURNEY_SOURCE_PATTERN = /(ristak_site|native_site|site|website|web|form|landing|pagina|página)/i
const WHATSAPP_JOURNEY_SOURCE_PATTERN = /(whatsapp|waapi|ycloud|click_to_whatsapp|ctwa)/i

const getEventData = (event?: JourneyEvent | null): Record<string, any> =>
  event && event.data && typeof event.data === 'object' ? event.data : {}

const getNumberValue = (value: unknown): number => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const getVideoEngagements = (event?: JourneyEvent | null): Record<string, any>[] => {
  const data = getEventData(event)
  if (event?.type === 'video_playback') return [data]
  return Array.isArray(data.video_engagements)
    ? data.video_engagements.filter((item): item is Record<string, any> => Boolean(item && typeof item === 'object'))
    : []
}

const formatVideoTimestamp = (seconds: unknown): string => {
  const totalSeconds = Math.max(0, Math.floor(getNumberValue(seconds)))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}

const getVideoEndPosition = (video: Record<string, any>): number => {
  const duration = getNumberValue(video.duration_seconds)
  const end = Math.max(
    getNumberValue(video.end_position_seconds),
    getNumberValue(video.max_position_seconds),
    getNumberValue(video.last_position_seconds)
  )

  if (video.ended && duration > 0) return duration
  return end
}

const getVideoDisplayTitle = (video: Record<string, any>): string =>
  String(
    video.video_title ||
    video.block_label ||
    video.public_page_title ||
    video.media_asset_id ||
    video.stream_video_id ||
    'Video'
  )

const formatVideoProgressSummary = (video: Record<string, any>): string => {
  const duration = getNumberValue(video.duration_seconds)
  const endPosition = getVideoEndPosition(video)
  const rawProgress = getNumberValue(video.max_progress_percent)
  const computedProgress = duration > 0 ? (endPosition / duration) * 100 : 0
  const progress = Math.min(100, Math.max(rawProgress, computedProgress))
  const parts: string[] = []

  if (progress > 0) {
    parts.push(`${Math.round(progress)}%`)
  }

  if (endPosition > 0 || duration > 0) {
    parts.push(duration > 0
      ? `${formatVideoTimestamp(endPosition)} de ${formatVideoTimestamp(duration)}`
      : `${formatVideoTimestamp(endPosition)} vistos`
    )
  } else if (getNumberValue(video.watched_seconds) > 0) {
    parts.push(`${formatVideoTimestamp(video.watched_seconds)} vistos`)
  }

  return parts.length ? parts.join(' · ') : 'Reproducción detectada'
}

const formatVideoPositionRange = (video: Record<string, any>): string => {
  const start = getNumberValue(video.start_position_seconds)
  const end = Math.max(start, getVideoEndPosition(video))
  return `${formatVideoTimestamp(start)} - ${formatVideoTimestamp(end)}`
}

const formatVideoTimeRange = (video: Record<string, any>, timezone?: string): string => {
  const options: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    ...(timezone ? { timeZone: timezone } : {})
  }
  const formatter = new Intl.DateTimeFormat('es-MX', options)
  const first = video.first_event_at ? new Date(video.first_event_at) : null
  const last = video.last_event_at ? new Date(video.last_event_at) : null
  const firstValid = first && Number.isFinite(first.getTime())
  const lastValid = last && Number.isFinite(last.getTime())

  if (firstValid && lastValid && first!.getTime() !== last!.getTime()) {
    return `${formatter.format(first!)} - ${formatter.format(last!)}`
  }

  if (firstValid) return formatter.format(first!)
  if (lastValid) return formatter.format(last!)
  return ''
}

const appendVideoTooltipItems = (
  items: { label: string; value: string }[],
  videos: Record<string, any>[],
  timezone?: string,
  includePage = false
) => {
  videos.slice(0, 3).forEach((video, index) => {
    const suffix = videos.length > 1 ? ` ${index + 1}` : ''
    items.push({ label: `Video${suffix}`, value: getVideoDisplayTitle(video) })
    items.push({ label: `Visto${suffix}`, value: formatVideoProgressSummary(video) })
    items.push({ label: `Tramo${suffix}`, value: formatVideoPositionRange(video) })

    const timeRange = formatVideoTimeRange(video, timezone)
    if (timeRange) {
      items.push({ label: `Horario${suffix}`, value: timeRange })
    }

    const page = video.public_page_title || video.page_url
    if (includePage && page) {
      items.push({ label: `Página${suffix}`, value: String(page) })
    }
  })

  if (videos.length > 3) {
    items.push({ label: 'Videos extra', value: `${videos.length - 3} más` })
  }
}

const CLICK_ID_TOOLTIP_FIELDS: Array<[string, string]> = [
  ['gclid', 'GCLID'],
  ['wbraid', 'WBRAID'],
  ['gbraid', 'GBRAID'],
  ['msclkid', 'MSCLKID'],
  ['ttclid', 'TTCLID'],
  ['fbclid', 'FBCLID'],
  ['fbc', 'FBC'],
  ['fbp', 'FBP']
]

const MATCH_METHOD_LABELS: Record<string, string> = {
  direct_contact_id: 'Contacto directo',
  visitor_id: 'Mismo visitante',
  visitor_id_linked: 'Visitante enlazado',
  related_identity_source: 'Misma identidad y fuente',
  probabilistic_device_network: 'Probable por dispositivo y fuente',
  probabilistic_device_network_candidate: 'Candidato probable',
  ambiguous_identity_hash: 'Identidad ambigua',
  anonymous: 'Anónimo'
}

const appendTooltipItem = (
  items: { label: string; value: string }[],
  label: string,
  value: unknown,
  formatter?: (value: string) => string
) => {
  if (!hasMeaningfulValue(value)) return
  const text = String(value).trim()
  items.push({ label, value: formatter ? formatter(text) : text })
}

const formatMinutesBeforeContact = (minutesValue: unknown): string => {
  const minutes = Math.max(0, Math.round(getNumberValue(minutesValue)))
  if (minutes <= 0) return ''
  if (minutes < 60) return `${minutes} min antes`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours} h ${remainingMinutes} min antes` : `${hours} h antes`
  }

  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours > 0 ? `${days} d ${remainingHours} h antes` : `${days} d antes`
}

const formatMatchMethod = (value: unknown): string => {
  const method = String(value || '').trim()
  if (!method) return ''
  if (method.startsWith('exact_')) {
    return `ID exacto: ${method.replace(/^exact_/, '').toUpperCase()}`
  }
  return MATCH_METHOD_LABELS[method] || formatUrlParameter(method.replace(/_/g, ' '))
}

const formatMatchConfidence = (value: unknown): string => {
  const confidence = Math.round(getNumberValue(value))
  if (confidence <= 0) return ''
  return `${confidence}%`
}

const getIdentityEvidenceSummary = (evidence: unknown): string => {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return ''
  const data = evidence as Record<string, any>
  const parts: string[] = []
  const deviceSignals = getNumberValue(data.deviceSignals)
  const sourceKeys = Array.isArray(data.sourceKeys) ? data.sourceKeys.length : 0
  const clickIdKeys = Array.isArray(data.clickIdKeys)
    ? data.clickIdKeys.map((item: unknown) => String(item).toUpperCase()).filter(Boolean)
    : []

  if (deviceSignals > 0) parts.push(`${deviceSignals} señales de dispositivo`)
  if (data.hasNetwork) parts.push('red detectada')
  if (sourceKeys > 0) parts.push(`${sourceKeys} señales de origen`)
  if (clickIdKeys.length > 0) parts.push(`IDs: ${clickIdKeys.slice(0, 3).join(', ')}`)

  return parts.join(' · ')
}

const appendPreRegistrationTooltipItems = (items: { label: string; value: string }[], data: Record<string, any>) => {
  if (!data.is_pre_registration) return
  const summary = formatMinutesBeforeContact(data.minutes_before_contact)
  appendTooltipItem(items, 'Antes del registro', summary || 'Sí')
}

const appendMatchTooltipItems = (items: { label: string; value: string }[], data: Record<string, any>) => {
  const method = formatMatchMethod(data.match_method)
  if (method) appendTooltipItem(items, 'Match', method)

  const confidence = formatMatchConfidence(data.match_confidence)
  if (confidence) appendTooltipItem(items, 'Confianza', confidence)

  const evidence = getIdentityEvidenceSummary(data.identity_evidence)
  if (evidence) appendTooltipItem(items, 'Evidencia', evidence)
}

const appendClickIdTooltipItems = (items: { label: string; value: string }[], data: Record<string, any>) => {
  CLICK_ID_TOOLTIP_FIELDS.forEach(([field, label]) => {
    appendTooltipItem(items, label, data[field])
  })
}

const sourceLooksWhatsApp = (source?: string | null) =>
  WHATSAPP_JOURNEY_SOURCE_PATTERN.test(String(source || '').trim().toLowerCase())

const isOutboundJourneyMessage = (event?: JourneyEvent | null) => {
  const direction = String(getEventData(event).direction || '').trim().toLowerCase()
  return OUTBOUND_JOURNEY_MESSAGE_DIRECTIONS.has(direction)
}

const isBusinessAuthoredJourneyMessage = (event?: JourneyEvent | null) =>
  Boolean(event && MESSAGE_JOURNEY_EVENT_TYPES.has(event.type) && isOutboundJourneyMessage(event))

const isWhatsAppJourneyEvent = (event?: JourneyEvent | null) => {
  if (!event) return false
  const data = getEventData(event)
  const conversionChannel = String(data.conversion_channel || '').toLowerCase()

  if (event.type === 'whatsapp_message') return !isOutboundJourneyMessage(event)
  if (event.type !== 'contact_created') return false
  if (isWebContactJourneyEvent(event)) return false
  if (conversionChannel === 'web') return false
  if (conversionChannel === 'whatsapp') return true

  const source = String(data.source || data.referral_source_app || data.referral_entry_point || '').toLowerCase()

  return source.includes('whatsapp')
}

const isWebContactJourneyEvent = (event?: JourneyEvent | null) => {
  if (event?.type !== 'contact_created') return false
  const data = getEventData(event)
  const conversionChannel = String(data.conversion_channel || '').trim().toLowerCase()
  const eventName = String(data.event_name || '').toLowerCase()
  const conversionType = String(data.conversion_type || '').toLowerCase()
  const source = String(data.source || '').toLowerCase()
  const sourceLabel = getEventSourceLabel(event)

  if (conversionChannel === 'web') return true
  if (data.submission_id || data.form_site_id || data.form_site_name) return true
  if (String(data.tracking_source || '').toLowerCase() === 'native_site' || data.site_id || data.public_page_id) return true
  if (eventName.includes('form') || eventName.includes('conversion')) return true
  if (conversionType.includes('form') || conversionType.includes('conversion')) return true
  if (WEB_JOURNEY_SOURCE_PATTERN.test(source)) return true

  return Boolean(sourceLabel && !sourceLooksWhatsApp(sourceLabel))
}

const isDailyContactJourneyEvent = (event?: JourneyEvent | null) =>
  Boolean(event && (event.type === 'contact_created' || isWhatsAppJourneyEvent(event)))

const getKnownPlatformIcon = (platform?: string | null) => {
  const normalized = String(platform || '').toLowerCase()

  if (GENERIC_TRAFFIC_SOURCES.has(normalized)) return null
  if (normalized.includes('instagram')) return 'instagram'
  if (normalized.includes('facebook')) return 'facebook'
  if (normalized.includes('tiktok')) return 'tiktok'
  if (normalized.includes('google')) return 'google'
  if (normalized.includes('youtube')) return 'youtube'
  if (normalized.includes('linkedin')) return 'linkedin'
  if (normalized.includes('twitter') || normalized === 'x') return 'twitter'
  if (normalized.includes('bing')) return 'bing'
  if (normalized.includes('whatsapp')) return 'whatsapp'
  if (normalized.includes('meta')) return 'meta-ads'

  return null
}

const getEventSourceLabel = (event?: JourneyEvent | null) => {
  const data = getEventData(event)
  const explicitSource = String(data.conversion_source || '').trim()
  if (explicitSource && !GENERIC_TRAFFIC_SOURCES.has(explicitSource.toLowerCase())) {
    return explicitSource
  }

  const normalized = normalizeTrafficSource({
    referrer_url: data.referrer_url || data.referral_source_url || data.source_url,
    referral_source_url: data.referral_source_url,
    site_source_name: data.site_source_name || data.referral_source_app,
    utm_source: data.utm_source || data.referral_source_type,
    source_platform: data.source_platform || data.ad_platform,
    referral_source_app: data.referral_source_app,
    referral_entry_point: data.referral_entry_point,
    source: data.source
  })

  return normalized && !GENERIC_TRAFFIC_SOURCES.has(normalized.toLowerCase()) ? normalized : ''
}

const getEventSourceIcon = (event: JourneyEvent) => getKnownPlatformIcon(getEventSourceLabel(event))

const getPlatformColor = (platform?: string | null) => {
  const icon = getKnownPlatformIcon(platform)
  if (icon && ['facebook', 'instagram', 'tiktok', 'google', 'youtube', 'linkedin', 'twitter', 'bing', 'whatsapp', 'meta-ads'].includes(icon)) {
    return icon
  }
  return ''
}

const getEventIcon = (event: JourneyEvent) => {
  if (event.type === 'video_playback') {
    return 'circle-play'
  }

  if (event.type === 'page_visit' || isWebContactJourneyEvent(event)) {
    return getEventSourceIcon(event) || 'mouse-pointer-click'
  }

  if (isWhatsAppJourneyEvent(event)) {
    return 'whatsapp'
  }

  switch (event.type) {
    case 'contact_created':
      return 'user-plus'
    case 'appointment':
    case 'appointment_confirmation':
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
    case 'video_playback':
      return 'Video'
    case 'contact_created':
      return 'Contacto'
    case 'appointment':
      return 'Cita'
    case 'appointment_confirmation':
      return 'Confirmación'
    case 'payment':
      return 'Compra'
    default:
      return 'Evento'
  }
}

const getEventColor = (event: JourneyEvent) => {
  if (event.type === 'video_playback') {
    return 'video'
  }

  if (event.type === 'page_visit' || isWebContactJourneyEvent(event)) {
    return getPlatformColor(getEventSourceLabel(event)) || 'blue'
  }

  if (isWhatsAppJourneyEvent(event)) {
    return 'green'
  }

  switch (event.type) {
    case 'contact_created':
      return 'purple'
    case 'appointment':
    case 'appointment_confirmation':
      return 'orange'
    case 'payment':
      return 'success'
    default:
      return 'gray'
  }
}

const getAdPlatformIcon = (platform?: string | null) => {
  return getKnownPlatformIcon(platform) || 'meta-ads'
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
  const data = getEventData(event)

  if (type === 'page_visit') {
    return getEventSourceLabel(event) || 'Sitio web'
  }

  if (type === 'video_playback') {
    const [video] = getVideoEngagements(event)
    return video ? getVideoDisplayTitle(video) : 'Video visto'
  }

  if (type === 'whatsapp_message') {
    if (data.is_ad_attributed) {
      const platform = data.ad_platform || getEventSourceLabel(event)
      return platform ? `Anuncio ${platform}` : 'Anuncio'
    }
    return 'WhatsApp'
  }

  if (type === 'contact_created') {
    if (isWhatsAppJourneyEvent(event)) {
      return 'Contacto creado'
    }
    if (isWebContactJourneyEvent(event)) {
      return getEventSourceLabel(event) || 'Sitio web'
    }
    // Solo mostrar la fuente si es corta
    const source = data.source || 'Registro'
    return source.length > 15 ? 'Se registró' : source
  }

  if (type === 'appointment') {
    // NO mostrar el título largo, solo "Cita"
    return 'Agendada'
  }

  if (type === 'appointment_confirmation') {
    return 'Confirmada por IA'
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
  const data = getEventData(event)

  const items: { label: string; value: string }[] = []

  if (type === 'page_visit') {
    appendPreRegistrationTooltipItems(items, data)
    appendTooltipItem(items, 'Página', data.public_page_title || data.landing_page || data.page_url)
    appendTooltipItem(items, 'URL', data.page_url)
    appendTooltipItem(items, 'Formulario', data.form_site_name)
    appendTooltipItem(items, 'Sitio', data.site_name)
    const source = getEventSourceLabel(event)
    if (source) {
      items.push({ label: 'Fuente', value: source })
    }
    appendTooltipItem(items, 'Referrer', data.referrer_url)
    appendTooltipItem(items, 'Canal', data.channel)
    appendTooltipItem(items, 'UTM source', data.utm_source, formatUrlParameter)
    appendTooltipItem(items, 'UTM medium', data.utm_medium, formatUrlParameter)
    if (data.campaign_name || data.utm_campaign) {
      items.push({ label: 'Campaña', value: formatUrlParameter(data.campaign_name || data.utm_campaign) })
    }
    appendTooltipItem(items, 'Campaña ID', data.campaign_id)
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: data.adset_name })
    }
    appendTooltipItem(items, 'Conjunto ID', data.adset_id)
    appendTooltipItem(items, 'Grupo anuncio', data.ad_group_name)
    appendTooltipItem(items, 'Grupo ID', data.ad_group_id)
    if (data.ad_name || data.utm_content) {
      items.push({ label: 'Anuncio', value: formatUrlParameter(data.ad_name || data.utm_content) })
    }
    if (data.ad_id) {
      items.push({ label: 'ID Anuncio', value: data.ad_id })
    }
    appendTooltipItem(items, 'Creativo', data.creative_id)
    appendTooltipItem(items, 'Placement', data.placement)
    appendTooltipItem(items, 'Red', data.network)
    appendTooltipItem(items, 'Match Ads', data.match_type)
    appendTooltipItem(items, 'Keyword', data.keyword)
    appendTooltipItem(items, 'Búsqueda', data.search_query)
    appendTooltipItem(items, 'Posición', data.ad_position)
    appendClickIdTooltipItems(items, data)
    if (data.device_type) {
      items.push({ label: 'Dispositivo', value: data.device_type })
    }
    if (data.browser) {
      const browser = [data.browser, data.browser_version].filter(Boolean).join(' ')
      items.push({ label: 'Navegador', value: browser })
    }
    appendTooltipItem(items, 'Sistema', data.os)
    appendTooltipItem(items, 'Idioma', data.language)
    appendTooltipItem(items, 'Zona horaria', data.timezone)
    if (data.geo_city || data.geo_region || data.geo_country) {
      const location = [data.geo_city, data.geo_region, data.geo_country].filter(Boolean).join(', ')
      items.push({ label: 'Ubicación', value: location })
    }
    appendMatchTooltipItems(items, data)
    appendVideoTooltipItems(items, getVideoEngagements(event), timezone)
  }

  if (type === 'video_playback') {
    appendPreRegistrationTooltipItems(items, data)
    appendVideoTooltipItems(items, getVideoEngagements(event), timezone, true)
    appendMatchTooltipItems(items, data)
  }

  if (type === 'whatsapp_message') {
    if (data.is_ad_attributed) {
      items.push({ label: 'Origen', value: data.ad_platform || getEventSourceLabel(event) || 'Anuncio' })
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
    const source = getEventSourceLabel(event) || data.source
    if (source) {
      items.push({ label: 'Fuente', value: source })
    }
    if (data.conversion_channel === 'web') {
      items.push({ label: 'Canal', value: 'Sitio web' })
    }
    if (data.campaign_name) {
      items.push({ label: 'Campaña', value: data.campaign_name })
    }
    appendTooltipItem(items, 'Campaña ID', data.campaign_id)
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: data.adset_name })
    }
    appendTooltipItem(items, 'Conjunto ID', data.adset_id)
    appendTooltipItem(items, 'Grupo anuncio', data.ad_group_name)
    appendTooltipItem(items, 'Grupo ID', data.ad_group_id)
    if (data.attribution_ad_name) {
      items.push({ label: 'Anuncio', value: formatUrlParameter(data.attribution_ad_name) })
    }
    if (data.attribution_ad_id) {
      items.push({ label: 'ID Anuncio', value: data.attribution_ad_id })
    }
    appendTooltipItem(items, 'Página', data.public_page_title || data.landing_page || data.page_url)
    appendTooltipItem(items, 'Formulario', data.form_site_name)
    appendTooltipItem(items, 'Sitio', data.site_name)
    appendTooltipItem(items, 'Referrer', data.referrer_url)
    appendTooltipItem(items, 'UTM source', data.utm_source, formatUrlParameter)
    appendTooltipItem(items, 'UTM medium', data.utm_medium, formatUrlParameter)
    appendTooltipItem(items, 'UTM term', data.utm_term, formatUrlParameter)
    appendTooltipItem(items, 'UTM content', data.utm_content, formatUrlParameter)
    appendTooltipItem(items, 'Placement', data.placement)
    appendTooltipItem(items, 'Keyword', data.keyword)
    appendTooltipItem(items, 'Búsqueda', data.search_query)
    appendClickIdTooltipItems(items, data)
    appendMatchTooltipItems(items, data)
  }

  if (type === 'appointment' || type === 'appointment_confirmation') {
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
  const data = getEventData(event)
  if (event.type === 'whatsapp_message' && isOutboundJourneyMessage(event)) return false
  return Boolean(
    data.is_ad_attributed ||
    data.attribution_ad_id ||
    data.referral_source_id ||
    data.referral_ctwa_clid
  )
}

// Puntaje para elegir el evento de WhatsApp "representativo" del día: gana el que tenga
// atribución de anuncio y más datos. El bump por tipo asegura que, a igualdad de datos,
// el marcador final se renderice como mensaje de WhatsApp (con tooltip enriquecido) y no
// como "Contacto creado".
const whatsAppEventScore = (event: JourneyEvent): number => {
  const data = getEventData(event)
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
  [
    getLocalDayKey(event.date, timezone),
    isWhatsAppJourneyEvent(event)
      ? `whatsapp:${isAdAttributedEvent(event) ? 'ad' : 'direct'}`
      : isWebContactJourneyEvent(event)
        ? 'contact:web'
        : 'contact'
  ].join(':')

// Colapsa los eventos de contacto/WhatsApp por día local. Si el mismo día hay varios,
// gana el que trae metadata de anuncio (source_id, CTWA, campaña o anuncio resuelto).
const buildDisplayJourney = (events: JourneyEvent[], timezone: string): JourneyEvent[] => {
  const dailyContactEvents: JourneyEvent[] = []
  const otherEvents: JourneyEvent[] = []

  events.forEach(event => {
    if (!event || isBusinessAuthoredJourneyMessage(event)) {
      return
    }

    if (isDailyContactJourneyEvent(event)) {
      dailyContactEvents.push(event)
    } else {
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
    const isWhatsAppAdAttributed = dayEvents.some(event => isWhatsAppJourneyEvent(event) && isAdAttributedEvent(event))

    const mergedData: Record<string, any> = {}
    sorted.forEach(event => {
      const data = getEventData(event)
      Object.entries(data).forEach(([key, value]) => {
        if (!hasMeaningfulValue(mergedData[key]) && hasMeaningfulValue(value)) {
          mergedData[key] = value
        }
      })
    })
    if (hasWhatsAppEvent) {
      mergedData.is_ad_attributed = isWhatsAppAdAttributed
    }

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
  const journeyRef = useRef<HTMLDivElement>(null)
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
      <div className={styles.loading} role="status" aria-live="polite" aria-label="Cargando viaje">
        <div className={styles.spinner} aria-hidden="true" />
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
    <div className={styles.journey} ref={journeyRef}>
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
          const hasAttachedVideo = event.type !== 'video_playback' && getVideoEngagements(event).length > 0

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
                  {hasAttachedVideo && (
                    <span className={styles.videoBadge} title="Vio video" aria-label="Vio video">
                      <Icon name="circle-play" size={11} />
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
                    zIndex: getFloatingLayerZIndex(journeyRef.current, 'tooltip')
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
