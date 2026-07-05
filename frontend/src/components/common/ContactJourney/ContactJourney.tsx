import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon, MessageCircle } from 'lucide-react'
import { FaFacebookMessenger, FaInstagram } from 'react-icons/fa'
import { Icon } from '@/components/common'
import { contactsService, type JourneyEvent } from '@/services/contactsService'
import { formatCurrency, formatUrlParameter } from '@/utils/format'
import { parseSortableDateValue } from '@/utils/dateSort'
import { getFloatingLayerZIndex } from '@/utils/layering'
import { normalizeTrafficSource } from '@/utils/trafficSourceNormalizer'
import { useTimezone } from '@/contexts/TimezoneContext'
import styles from './ContactJourney.module.css'

interface ContactJourneyProps {
  contactId: string
  layout?: 'default' | 'snake'
}

type TooltipSection =
  | 'Resumen'
  | 'Ruta'
  | 'Origen'
  | 'Anuncio'
  | 'Tracking'
  | 'Dispositivo'
  | 'Identidad'
  | 'Video'
  | 'Mensaje'
  | 'Cita'
  | 'Pago'
  | 'Detalles'

type TooltipItemKind = 'text' | 'metric' | 'url' | 'id'

interface TooltipItem {
  label: string
  value: string
  detail?: string
  section?: TooltipSection
  kind?: TooltipItemKind
}

interface TooltipPosition {
  top: number
  left: number
  placement: 'top' | 'bottom'
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
const MESSAGE_JOURNEY_EVENT_TYPES = new Set(['whatsapp_message', 'meta_message', 'email_message'])
const WEB_JOURNEY_SOURCE_PATTERN = /(ristak_site|native_site|site|website|web|form|landing|pagina|página)/i
const WHATSAPP_JOURNEY_SOURCE_PATTERN = /(whatsapp|waapi|ycloud|click_to_whatsapp|ctwa)/i
const INSTAGRAM_META_MESSAGE_PATTERN = /(instagram|ig)/i
const MESSENGER_META_MESSAGE_PATTERN = /(messenger|facebook|fb)/i
const META_COMMENT_MESSAGE_TYPES = new Set(['comment', 'comment_reply_public', 'comment_reply_private'])

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
  items: TooltipItem[],
  videos: Record<string, any>[],
  timezone?: string,
  includePage = false
) => {
  videos.slice(0, 3).forEach((video, index) => {
    const suffix = videos.length > 1 ? ` ${index + 1}` : ''
    items.push({ label: `Video${suffix}`, value: getVideoDisplayTitle(video), section: 'Video' })
    items.push({ label: `Visto${suffix}`, value: formatVideoProgressSummary(video), section: 'Video', kind: 'metric' })
    items.push({ label: `Tramo${suffix}`, value: formatVideoPositionRange(video), section: 'Video', kind: 'metric' })

    const timeRange = formatVideoTimeRange(video, timezone)
    if (timeRange) {
      items.push({ label: `Horario${suffix}`, value: timeRange, section: 'Video' })
    }

    const page = video.public_page_title || video.page_url
    if (includePage && page) {
      appendTooltipItem(items, `Página${suffix}`, page, undefined, {
        section: 'Ruta',
        kind: video.public_page_title ? 'text' : 'url'
      })
    }
  })

  if (videos.length > 3) {
    items.push({ label: 'Videos extra', value: `${videos.length - 3} más`, section: 'Video', kind: 'metric' })
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

const formatTooltipUrl = (value: string): { value: string; detail?: string } => {
  const trimmed = value.trim()
  if (!trimmed) return { value: '' }
  const urlCandidate = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed

  try {
    const parsed = new URL(urlCandidate, urlCandidate.startsWith('/') ? 'https://ristak.local' : undefined)
    const host = parsed.hostname === 'ristak.local' ? '' : parsed.hostname.replace(/^www\./, '')
    const pathname = decodeURIComponent(parsed.pathname || '/').replace(/\/+$/, '') || '/'
    const shortPath = pathname.length > 62 ? `${pathname.slice(0, 34)}...${pathname.slice(-20)}` : pathname
    const label = [host, shortPath === '/' && host ? '' : shortPath].filter(Boolean).join('')
    const params = Array.from(parsed.searchParams.entries())
    const trackedParams = params
      .map(([key]) => key)
      .filter(key => /^utm_|^(fbclid|gclid|ttclid|msclkid|wbraid|gbraid)$/i.test(key))
      .slice(0, 4)
    const detail = [
      params.length > 0 ? `${params.length} parámetros` : '',
      trackedParams.length > 0 ? trackedParams.join(', ') : ''
    ].filter(Boolean).join(' · ')

    return { value: label || trimmed, detail: detail || undefined }
  } catch {
    return { value: trimmed }
  }
}

const formatTooltipIdentifier = (value: string): { value: string; detail?: string } => {
  const trimmed = value.trim()
  if (trimmed.length <= 52) return { value: trimmed }
  return {
    value: `${trimmed.slice(0, 20)}...${trimmed.slice(-14)}`,
    detail: `${trimmed.length} caracteres`
  }
}

const appendTooltipItem = (
  items: TooltipItem[],
  label: string,
  value: unknown,
  formatter?: (value: string) => string,
  options: { section?: TooltipSection; kind?: TooltipItemKind } = {}
) => {
  if (!hasMeaningfulValue(value)) return
  const text = String(value).trim()
  if (options.kind === 'url') {
    items.push({ label, ...formatTooltipUrl(text), section: options.section, kind: 'url' })
    return
  }
  if (options.kind === 'id') {
    items.push({ label, ...formatTooltipIdentifier(text), section: options.section, kind: 'id' })
    return
  }
  items.push({ label, value: formatter ? formatter(text) : text, section: options.section, kind: options.kind })
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

const formatCountLabel = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

const formatSessionDuration = (secondsValue: unknown): string => {
  const seconds = Math.max(0, Math.round(getNumberValue(secondsValue)))
  if (seconds <= 0) return ''
  if (seconds < 60) return `${seconds} s`

  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes} min ${remainingSeconds} s` : `${minutes} min`
  }

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes > 0 ? `${hours} h ${remainingMinutes} min` : `${hours} h`
}

const formatSessionSummary = (data: Record<string, any>): string => {
  const pagesVisited = Math.round(getNumberValue(data.pages_visited))
  const events = Math.round(getNumberValue(data.session_event_count))
  const conversions = Math.round(getNumberValue(data.session_conversion_count))
  const parts: string[] = []

  if (pagesVisited > 0) {
    parts.push(formatCountLabel(pagesVisited, 'página', 'páginas'))
  }
  if (events > 1) {
    parts.push(formatCountLabel(events, 'evento', 'eventos'))
  }
  if (conversions > 0) {
    parts.push(formatCountLabel(conversions, 'conversión', 'conversiones'))
  }

  return parts.join(' · ')
}

const appendMetricTooltipItem = (items: TooltipItem[], label: string, value: unknown, section: TooltipSection = 'Resumen') => {
  appendTooltipItem(items, label, value, undefined, { section, kind: 'metric' })
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

const appendPreRegistrationTooltipItems = (items: TooltipItem[], data: Record<string, any>) => {
  if (!data.is_pre_registration) return
  const summary = formatMinutesBeforeContact(data.minutes_before_contact)
  appendMetricTooltipItem(items, 'Antes del registro', summary || 'Sí')
}

const appendMatchTooltipItems = (items: TooltipItem[], data: Record<string, any>) => {
  const method = formatMatchMethod(data.match_method)
  if (method) appendTooltipItem(items, 'Match', method, undefined, { section: 'Identidad' })

  const confidence = formatMatchConfidence(data.match_confidence)
  if (confidence) appendMetricTooltipItem(items, 'Confianza', confidence, 'Identidad')

  const evidence = getIdentityEvidenceSummary(data.identity_evidence)
  if (evidence) appendTooltipItem(items, 'Evidencia', evidence, undefined, { section: 'Identidad' })
}

const appendClickIdTooltipItems = (items: TooltipItem[], data: Record<string, any>) => {
  CLICK_ID_TOOLTIP_FIELDS.forEach(([field, label]) => {
    appendTooltipItem(items, label, data[field], undefined, { section: 'Tracking', kind: 'id' })
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
  Boolean(event && (event.type === 'contact_created' || isWhatsAppJourneyEvent(event) || isMetaMessageJourneyEvent(event)))

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

const getMetaMessagePlatformText = (event?: JourneyEvent | null): string => {
  const data = getEventData(event)
  return [
    data.source,
    data.social_platform,
    data.transport
  ].filter(Boolean).join(' ')
}

const getMetaMessagePlatformKey = (event?: JourneyEvent | null): string => {
  const platformText = getMetaMessagePlatformText(event)
  if (INSTAGRAM_META_MESSAGE_PATTERN.test(platformText)) return 'instagram'
  if (MESSENGER_META_MESSAGE_PATTERN.test(platformText)) return 'messenger'
  return 'meta'
}

const isMetaMessageJourneyEvent = (event?: JourneyEvent | null) =>
  Boolean(event?.type === 'meta_message' && !isOutboundJourneyMessage(event))

const getMetaMessageType = (event?: JourneyEvent | null): string =>
  String(getEventData(event).message_type || '').trim().toLowerCase()

const isMetaCommentJourneyEvent = (event?: JourneyEvent | null): boolean => {
  const data = getEventData(event)
  return Boolean(data.comment_id || META_COMMENT_MESSAGE_TYPES.has(getMetaMessageType(event)))
}

const hasMetaMessageMedia = (event?: JourneyEvent | null): boolean => {
  const data = getEventData(event)
  return Boolean(data.media_url || data.post_image_url || data.media_id)
}

const getMetaMessageDailyKind = (event?: JourneyEvent | null): 'comment' | 'message' =>
  isMetaCommentJourneyEvent(event) ? 'comment' : 'message'

const getMetaMessageTitle = (event?: JourneyEvent | null): string => {
  const platform = getMetaMessagePlatformKey(event)
  if (platform === 'instagram') return 'Instagram'
  if (platform === 'messenger') return 'Messenger'
  return 'Meta'
}

const getMetaMessageSurfaceLabel = (event?: JourneyEvent | null): string => {
  const data = getEventData(event)
  if (isMetaCommentJourneyEvent(event)) {
    const platform = getMetaMessagePlatformKey(event)
    if (platform === 'instagram') return 'Comentario de Instagram'
    if (platform === 'messenger') return 'Comentario de Messenger'
    return 'Comentario social'
  }

  const source = String(data.source || '').trim()
  const title = getMetaMessageTitle(event)
  if (source) {
    const normalizedSource = source.toLowerCase()
    if (title !== 'Meta' && (normalizedSource === 'messenger' || normalizedSource === 'instagram')) {
      return `Mensaje privado de ${title}`
    }
    return source
  }

  return title === 'Meta' ? 'Mensaje social' : `Mensaje privado de ${title}`
}

const getMetaMessageSubtypeLabel = (event?: JourneyEvent | null): string => {
  const data = getEventData(event)
  if (isMetaCommentJourneyEvent(event)) return 'Comentario'
  if (String(data.source || '').toLowerCase().includes('dm')) return 'DM'
  if (data.media_url) return 'Multimedia'
  if (data.postback_payload) return 'Respuesta'
  return 'Privado'
}

const getMetaMessageIcon = (event: JourneyEvent) => {
  const platform = getMetaMessagePlatformKey(event)
  if (platform === 'instagram') return 'instagram'
  if (platform === 'messenger') return 'message-circle'
  return 'message-square'
}

const getMetaMessageColor = (event: JourneyEvent) => {
  const platform = getMetaMessagePlatformKey(event)
  if (platform === 'instagram') return 'instagram'
  if (platform === 'messenger') return 'facebook'
  return 'blue'
}

const renderMetaMessageIcon = (event: JourneyEvent) => {
  const platform = getMetaMessagePlatformKey(event)
  const isComment = isMetaCommentJourneyEvent(event)
  const mainIconLabel = isComment
    ? `${getMetaMessageSurfaceLabel(event)} en publicación`
    : hasMetaMessageMedia(event)
      ? `${getMetaMessageTitle(event)} con multimedia`
      : `${getMetaMessageTitle(event)} privado`
  const BrandIcon = platform === 'instagram'
    ? FaInstagram
    : platform === 'messenger'
      ? FaFacebookMessenger
      : null

  return (
    <span
      className={styles.metaJourneyGlyph}
      data-meta-action={isComment ? 'comment' : hasMetaMessageMedia(event) ? 'media' : 'message'}
      aria-label={mainIconLabel}
      role="img"
    >
      {isComment || hasMetaMessageMedia(event)
        ? <ImageIcon className={styles.metaJourneyGlyphPrimary} size={18} strokeWidth={1.8} aria-hidden="true" />
        : <MessageCircle className={styles.metaJourneyGlyphPrimary} size={18} strokeWidth={1.8} aria-hidden="true" />}
      {isComment && (
        <MessageCircle className={styles.metaJourneyGlyphAction} size={10} strokeWidth={2} aria-hidden="true" />
      )}
      <span className={styles.metaJourneyGlyphBrand} data-platform={platform} aria-hidden="true">
        {BrandIcon
          ? <BrandIcon />
          : <Icon name="meta" size={10} color="currentColor" aria-hidden="true" focusable="false" />}
      </span>
    </span>
  )
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
    case 'meta_message':
      return getMetaMessageIcon(event)
    case 'email_message':
      return 'mail'
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
    case 'meta_message':
      return getMetaMessageTitle(event)
    case 'email_message':
      return 'Correo'
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
    case 'meta_message':
      return getMetaMessageColor(event)
    case 'email_message':
      return 'blue'
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

  if (type === 'meta_message') {
    return getMetaMessageSubtypeLabel(event)
  }

  if (type === 'email_message') {
    const subject = String(data.subject || '').trim()
    return subject.length > 18 ? 'Mensaje' : subject || 'Mensaje'
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

const getTooltipContent = (event?: JourneyEvent | null, timezone?: string): TooltipItem[] => {
  if (!event) {
    return []
  }

  const { type } = event
  const data = getEventData(event)

  const items: TooltipItem[] = []

  if (type === 'page_visit') {
    appendPreRegistrationTooltipItems(items, data)
    appendMetricTooltipItem(items, 'Sesión', formatSessionSummary(data))
    appendMetricTooltipItem(items, 'Duración', formatSessionDuration(data.session_duration_seconds))
    {
      const visibleSessionCount = Math.round(getNumberValue(data.visible_session_count))
      if (visibleSessionCount > 1) {
        appendMetricTooltipItem(items, 'Visitas visibles', visibleSessionCount)
      }
    }
    appendTooltipItem(items, 'Página', data.public_page_title || data.landing_page || data.page_url, undefined, {
      section: 'Ruta',
      kind: data.public_page_title ? 'text' : 'url'
    })
    if (data.first_page_url && data.last_page_url && String(data.first_page_url) !== String(data.last_page_url)) {
      appendTooltipItem(items, 'Primera página', data.first_page_url, undefined, { section: 'Ruta', kind: 'url' })
      appendTooltipItem(items, 'Última página', data.last_page_url, undefined, { section: 'Ruta', kind: 'url' })
    }
    appendTooltipItem(items, 'URL', data.page_url, undefined, { section: 'Ruta', kind: 'url' })
    appendTooltipItem(items, 'Formulario', data.form_site_name, undefined, { section: 'Ruta' })
    appendTooltipItem(items, 'Sitio', data.site_name, undefined, { section: 'Ruta' })
    const source = getEventSourceLabel(event)
    if (source) {
      items.push({ label: 'Fuente', value: source, section: 'Origen' })
    }
    appendTooltipItem(items, 'Referrer', data.referrer_url, undefined, { section: 'Origen', kind: 'url' })
    appendTooltipItem(items, 'Canal', data.channel, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'UTM source', data.utm_source, formatUrlParameter, { section: 'Origen' })
    appendTooltipItem(items, 'UTM medium', data.utm_medium, formatUrlParameter, { section: 'Origen' })
    if (data.campaign_name || data.utm_campaign) {
      items.push({ label: 'Campaña', value: formatUrlParameter(data.campaign_name || data.utm_campaign), section: 'Anuncio' })
    }
    appendTooltipItem(items, 'Campaña ID', data.campaign_id, undefined, { section: 'Anuncio', kind: 'id' })
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: data.adset_name, section: 'Anuncio' })
    }
    appendTooltipItem(items, 'Conjunto ID', data.adset_id, undefined, { section: 'Anuncio', kind: 'id' })
    appendTooltipItem(items, 'Grupo anuncio', data.ad_group_name, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Grupo ID', data.ad_group_id, undefined, { section: 'Anuncio', kind: 'id' })
    if (data.ad_name || data.utm_content) {
      items.push({ label: 'Anuncio', value: formatUrlParameter(data.ad_name || data.utm_content), section: 'Anuncio' })
    }
    if (data.ad_id) {
      appendTooltipItem(items, 'ID Anuncio', data.ad_id, undefined, { section: 'Anuncio', kind: 'id' })
    }
    appendTooltipItem(items, 'Creativo', data.creative_id, undefined, { section: 'Anuncio', kind: 'id' })
    appendTooltipItem(items, 'Placement', data.placement, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Red', data.network, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Match Ads', data.match_type, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Keyword', data.keyword, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Búsqueda', data.search_query, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Posición', data.ad_position, undefined, { section: 'Anuncio' })
    appendClickIdTooltipItems(items, data)
    if (data.device_type) {
      items.push({ label: 'Dispositivo', value: data.device_type, section: 'Dispositivo' })
    }
    if (data.browser) {
      const browser = [data.browser, data.browser_version].filter(Boolean).join(' ')
      items.push({ label: 'Navegador', value: browser, section: 'Dispositivo' })
    }
    appendTooltipItem(items, 'Sistema', data.os, undefined, { section: 'Dispositivo' })
    appendTooltipItem(items, 'Idioma', data.language, undefined, { section: 'Dispositivo' })
    appendTooltipItem(items, 'Zona horaria', data.timezone, undefined, { section: 'Dispositivo' })
    if (data.geo_city || data.geo_region || data.geo_country) {
      const location = [data.geo_city, data.geo_region, data.geo_country].filter(Boolean).join(', ')
      items.push({ label: 'Ubicación', value: location, section: 'Dispositivo' })
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
      items.push({ label: 'Origen', value: data.ad_platform || getEventSourceLabel(event) || 'Anuncio', section: 'Origen' })
    }
    if (data.campaign_name) {
      items.push({ label: 'Campaña', value: formatUrlParameter(data.campaign_name), section: 'Anuncio' })
    }
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: formatUrlParameter(data.adset_name), section: 'Anuncio' })
    }
    appendTooltipItem(items, 'App origen', data.referral_source_app, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Entrada', data.referral_entry_point, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Tipo origen', data.referral_source_type, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'URL origen', data.referral_source_url, undefined, { section: 'Origen', kind: 'url' })
    appendTooltipItem(items, 'Mensaje', data.message_text, undefined, { section: 'Mensaje' })
    {
      const adName = data.attribution_ad_name || data.referral_headline
      if (adName) {
        items.push({ label: 'Anuncio', value: formatUrlParameter(adName), section: 'Anuncio' })
      }
    }
    appendTooltipItem(items, 'Detalle anuncio', data.referral_body, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Imagen anuncio', data.referral_image_url, undefined, { section: 'Anuncio', kind: 'url' })
    appendTooltipItem(items, 'Video anuncio', data.referral_video_url, undefined, { section: 'Anuncio', kind: 'url' })
    appendTooltipItem(items, 'Miniatura anuncio', data.referral_thumbnail_url, undefined, { section: 'Anuncio', kind: 'url' })
    appendTooltipItem(items, 'Teléfono', data.phone, undefined, { section: 'Mensaje' })
    {
      const adId = data.attribution_ad_id || data.referral_source_id
      if (adId) {
        appendTooltipItem(items, 'ID anuncio', adId, undefined, { section: 'Anuncio', kind: 'id' })
      }
    }
    appendTooltipItem(items, 'CTWA CLID', data.referral_ctwa_clid, undefined, { section: 'Tracking', kind: 'id' })
  }

  if (type === 'meta_message') {
    items.push({ label: 'Canal', value: getMetaMessageSurfaceLabel(event), section: 'Origen' })
    appendTooltipItem(items, 'Perfil', data.profile_name, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Usuario', data.username ? `@${String(data.username).replace(/^@+/, '')}` : '', undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Mensaje', data.message_text, undefined, { section: 'Mensaje' })
    items.push({ label: 'Tipo', value: getMetaMessageSubtypeLabel(event), section: 'Mensaje' })
    appendTooltipItem(items, 'Tipo interno', data.message_type, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Medio', data.media_url, undefined, { section: 'Mensaje', kind: 'url' })
    appendTooltipItem(items, 'Respuesta', data.postback_payload, undefined, { section: 'Mensaje' })
    appendTooltipItem(items, 'Dirección', data.direction, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Estado', data.status, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Publicación', data.post_message, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Link publicación', data.post_permalink || data.permalink, undefined, { section: 'Detalles', kind: 'url' })
    appendTooltipItem(items, 'Comentario ID', data.comment_id, undefined, { section: 'Detalles', kind: 'id' })
    appendTooltipItem(items, 'Mensaje ID', data.meta_message_id || data.meta_social_message_id, undefined, { section: 'Tracking', kind: 'id' })
  }

  if (type === 'email_message') {
    items.push({ label: 'Canal', value: 'Correo', section: 'Origen' })
    appendTooltipItem(items, 'Asunto', data.subject, undefined, { section: 'Mensaje' })
    appendTooltipItem(items, 'Mensaje', data.message_text || data.html_body, undefined, { section: 'Mensaje' })
    appendTooltipItem(items, 'De', data.from_email, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Para', data.to_email, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Responder a', data.reply_to, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Dirección', data.direction, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Estado', data.status, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Error', data.error_message, undefined, { section: 'Detalles' })
    appendTooltipItem(items, 'Mensaje ID', data.smtp_message_id || data.email_message_id, undefined, { section: 'Tracking', kind: 'id' })
  }

  if (type === 'contact_created') {
    const source = getEventSourceLabel(event) || data.source
    if (source) {
      items.push({ label: 'Fuente', value: source, section: 'Origen' })
    }
    if (data.conversion_channel === 'web') {
      items.push({ label: 'Canal', value: 'Sitio web', section: 'Origen' })
    }
    if (data.campaign_name) {
      items.push({ label: 'Campaña', value: data.campaign_name, section: 'Anuncio' })
    }
    appendTooltipItem(items, 'Campaña ID', data.campaign_id, undefined, { section: 'Anuncio', kind: 'id' })
    if (data.adset_name) {
      items.push({ label: 'Conjunto de anuncios', value: data.adset_name, section: 'Anuncio' })
    }
    appendTooltipItem(items, 'Conjunto ID', data.adset_id, undefined, { section: 'Anuncio', kind: 'id' })
    appendTooltipItem(items, 'Grupo anuncio', data.ad_group_name, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Grupo ID', data.ad_group_id, undefined, { section: 'Anuncio', kind: 'id' })
    if (data.attribution_ad_name) {
      items.push({ label: 'Anuncio', value: formatUrlParameter(data.attribution_ad_name), section: 'Anuncio' })
    }
    if (data.attribution_ad_id) {
      appendTooltipItem(items, 'ID Anuncio', data.attribution_ad_id, undefined, { section: 'Anuncio', kind: 'id' })
    }
    appendTooltipItem(items, 'Página', data.public_page_title || data.landing_page || data.page_url, undefined, {
      section: 'Ruta',
      kind: data.public_page_title ? 'text' : 'url'
    })
    appendTooltipItem(items, 'Formulario', data.form_site_name, undefined, { section: 'Ruta' })
    appendTooltipItem(items, 'Sitio', data.site_name, undefined, { section: 'Ruta' })
    appendTooltipItem(items, 'Referrer', data.referrer_url, undefined, { section: 'Origen', kind: 'url' })
    appendTooltipItem(items, 'UTM source', data.utm_source, formatUrlParameter, { section: 'Origen' })
    appendTooltipItem(items, 'UTM medium', data.utm_medium, formatUrlParameter, { section: 'Origen' })
    appendTooltipItem(items, 'UTM term', data.utm_term, formatUrlParameter, { section: 'Origen' })
    appendTooltipItem(items, 'UTM content', data.utm_content, formatUrlParameter, { section: 'Origen' })
    appendTooltipItem(items, 'Placement', data.placement, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Keyword', data.keyword, undefined, { section: 'Anuncio' })
    appendTooltipItem(items, 'Búsqueda', data.search_query, undefined, { section: 'Anuncio' })
    appendClickIdTooltipItems(items, data)
    appendMatchTooltipItems(items, data)
  }

  if (type === 'appointment' || type === 'appointment_confirmation') {
    appendTooltipItem(items, 'Título', data.title, undefined, { section: 'Cita' })
    appendTooltipItem(items, 'Estado', data.status, undefined, { section: 'Cita' })
    if (data.start_time && data.end_time) {
      const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', ...(timezone ? { timeZone: timezone } : {}) }
      const start = new Date(data.start_time).toLocaleTimeString('es-MX', timeOpts)
      const end = new Date(data.end_time).toLocaleTimeString('es-MX', timeOpts)
      items.push({ label: 'Horario', value: `${start} - ${end}`, section: 'Cita', kind: 'metric' })
    }
    appendTooltipItem(items, 'Ubicación', data.address, undefined, { section: 'Cita' })
    appendTooltipItem(items, 'Notas', data.notes, undefined, { section: 'Cita' })
  }

  if (type === 'payment') {
    if (data.amount) {
      items.push({ label: 'Monto', value: formatCurrency(data.amount), section: 'Pago', kind: 'metric' })
    }
    appendTooltipItem(items, 'Concepto', data.title, undefined, { section: 'Pago' })
    appendTooltipItem(items, 'Tipo', data.type, undefined, { section: 'Pago' })
    appendTooltipItem(items, 'Proveedor', data.payment_provider, undefined, { section: 'Pago' })
  }

  if (items.length === 0) {
    items.push({ label: 'Tipo de evento', value: type, section: 'Detalles' })
    appendTooltipItem(items, 'Fuente', data.source, undefined, { section: 'Origen' })
    appendTooltipItem(items, 'Mensaje', data.message_text, undefined, { section: 'Mensaje' })
    appendTooltipItem(items, 'Estado', data.status, undefined, { section: 'Detalles' })
  }

  return items
}

const TOOLTIP_SECTION_ORDER: TooltipSection[] = [
  'Resumen',
  'Ruta',
  'Origen',
  'Anuncio',
  'Tracking',
  'Dispositivo',
  'Identidad',
  'Video',
  'Mensaje',
  'Cita',
  'Pago',
  'Detalles'
]

const groupTooltipItems = (items: TooltipItem[]): Array<{ title: TooltipSection; items: TooltipItem[] }> => {
  const grouped = new Map<TooltipSection, TooltipItem[]>()
  items.forEach(item => {
    const section = item.section || 'Detalles'
    const sectionItems = grouped.get(section)
    if (sectionItems) {
      sectionItems.push(item)
    } else {
      grouped.set(section, [item])
    }
  })

  return TOOLTIP_SECTION_ORDER
    .map(section => ({ title: section, items: grouped.get(section) || [] }))
    .filter(section => section.items.length > 0)
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

const metaMessageEventScore = (event: JourneyEvent): number => {
  const data = getEventData(event)
  const completenessFields = [
    'message_text', 'message_type', 'profile_name', 'username', 'media_url',
    'postback_payload', 'comment_id', 'post_message', 'post_permalink',
    'post_image_url', 'post_type', 'media_id', 'parent_comment_id',
    'permalink', 'meta_message_id', 'meta_social_message_id', 'status'
  ]
  const completeness = completenessFields.reduce(
    (score, field) => score + (hasMeaningfulValue(data[field]) ? 1 : 0),
    0
  )
  return 10 + completeness
}

const dailyJourneyEventScore = (event: JourneyEvent): number => {
  if (isMetaMessageJourneyEvent(event)) return metaMessageEventScore(event)
  return whatsAppEventScore(event)
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
      : isMetaMessageJourneyEvent(event)
        ? `meta:${getMetaMessagePlatformKey(event)}:${getMetaMessageDailyKind(event)}`
      : isWebContactJourneyEvent(event)
        ? 'contact:web'
        : 'contact'
  ].join(':')

// Colapsa los eventos de contacto/mensajería por día local. Si el mismo día hay varios,
// gana el que trae más metadata útil para explicar el origen o mensaje.
const buildDisplayJourney = (events: JourneyEvent[], timezone: string): JourneyEvent[] => {
  const dailyJourneyEvents: JourneyEvent[] = []
  const otherEvents: JourneyEvent[] = []

  events.forEach(event => {
    if (!event || isBusinessAuthoredJourneyMessage(event)) {
      return
    }

    if (isDailyContactJourneyEvent(event)) {
      dailyJourneyEvents.push(event)
    } else {
      otherEvents.push(event)
    }
  })

  const byGroup = new Map<string, JourneyEvent[]>()
  dailyJourneyEvents.forEach(event => {
    const key = getDailyContactJourneyGroupKey(event, timezone)
    const bucket = byGroup.get(key)
    if (bucket) {
      bucket.push(event)
    } else {
      byGroup.set(key, [event])
    }
  })

  const mergedDailyJourneyEvents: JourneyEvent[] = []
  byGroup.forEach(dayEvents => {
    const sorted = [...dayEvents].sort((a, b) => dailyJourneyEventScore(b) - dailyJourneyEventScore(a))
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

    mergedDailyJourneyEvents.push({
      ...primary,
      type: hasWhatsAppEvent ? 'whatsapp_message' : primary.type,
      data: mergedData
    })
  })

  return [...otherEvents, ...mergedDailyJourneyEvents].sort(
    (a, b) => parseSortableDateValue(a.date) - parseSortableDateValue(b.date)
  )
}

const getTooltipPositionFromRect = (rect: DOMRect): TooltipPosition => {
  const margin = 16
  const halfTooltipWidth = 220
  const estimatedHeight = 360
  const spaceAbove = rect.top
  const spaceBelow = window.innerHeight - rect.bottom
  const placement: TooltipPosition['placement'] = spaceAbove > estimatedHeight || spaceAbove > spaceBelow ? 'top' : 'bottom'
  const left = Math.min(
    Math.max(rect.left + rect.width / 2, halfTooltipWidth + margin),
    window.innerWidth - halfTooltipWidth - margin
  )
  const top = placement === 'top'
    ? Math.max(margin, rect.top - 12)
    : Math.min(window.innerHeight - margin, rect.bottom + 12)

  return { top, left, placement }
}

const getTooltipTransform = (placement: TooltipPosition['placement']): string =>
  placement === 'top' ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'

const SNAKE_ROW_SIZE = 4

const chunkJourneyRows = (events: JourneyEvent[], rowSize = SNAKE_ROW_SIZE): JourneyEvent[][] => {
  const rows: JourneyEvent[][] = []
  for (let index = 0; index < events.length; index += rowSize) {
    rows.push(events.slice(index, index + rowSize))
  }
  return rows
}

export const ContactJourney = ({ contactId, layout = 'default' }: ContactJourneyProps) => {
  const { timezone, formatLocalDateShort, formatLocalDateTime } = useTimezone()
  const journeyRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [journey, setJourney] = useState<JourneyEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [activeEventIndex, setActiveEventIndex] = useState<number | null>(null)
  const [hoveredEventIndex, setHoveredEventIndex] = useState<number | null>(null)
  const [tooltipPosition, setTooltipPosition] = useState<TooltipPosition | null>(null)

  useEffect(() => {
    const loadJourney = async () => {
      setLoading(true)
      const data = await contactsService.getContactJourney(contactId)
      setJourney(data)
      setLoading(false)
    }

    loadJourney()
  }, [contactId])

  useEffect(() => {
    setActiveEventIndex(null)
    setHoveredEventIndex(null)
    setTooltipPosition(null)
  }, [contactId])

  useEffect(() => {
    if (activeEventIndex === null) return

    const closeTooltip = () => {
      setActiveEventIndex(null)
      setHoveredEventIndex(null)
      setTooltipPosition(null)
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (tooltipRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('[data-contact-journey-event]')) return
      closeTooltip()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeTooltip()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeEventIndex])

  // Agrupa contacto y mensajes sociales por día local antes de pintar.
  const displayJourney = useMemo(() => buildDisplayJourney(journey, timezone), [journey, timezone])
  const displayRows = useMemo(() => chunkJourneyRows(displayJourney), [displayJourney])
  const visibleTooltipIndex = activeEventIndex ?? hoveredEventIndex

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

  const renderJourneyEvent = (
    event: JourneyEvent,
    index: number,
    options: {
      showDefaultConnector?: boolean
      slot?: number
    } = {}
  ) => {
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
    const tooltipSections = groupTooltipItems(tooltipItems)
    const isTooltipPinned = activeEventIndex === index
    const isTooltipVisible = visibleTooltipIndex === index && tooltipItems.length > 0

    return (
      <div
        key={index}
        className={styles.eventWrapper}
        data-snake-slot={typeof options.slot === 'number' ? options.slot : undefined}
      >
        <div
          className={styles.event}
          role="button"
          tabIndex={0}
          aria-expanded={isTooltipPinned}
          data-active={isTooltipPinned ? 'true' : undefined}
          data-contact-journey-event
          onMouseEnter={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setHoveredEventIndex(index)
            if (activeEventIndex === null) {
              setTooltipPosition(getTooltipPositionFromRect(rect))
            }
          }}
          onMouseLeave={() => {
            setHoveredEventIndex(null)
            if (activeEventIndex === null) {
              setTooltipPosition(null)
            }
          }}
          onClick={(e) => {
            setTooltipPosition(getTooltipPositionFromRect(e.currentTarget.getBoundingClientRect()))
            setHoveredEventIndex(index)
            setActiveEventIndex(index)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return
            e.preventDefault()
            setTooltipPosition(getTooltipPositionFromRect(e.currentTarget.getBoundingClientRect()))
            setHoveredEventIndex(index)
            setActiveEventIndex(index)
          }}
        >
          <div className={`${styles.eventDot} ${styles[color]}`}>
            {event.type === 'meta_message'
              ? renderMetaMessageIcon(event)
              : <Icon name={iconName as any} size={18} />}
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
        {isTooltipVisible && tooltipPosition && createPortal(
          <div
            ref={tooltipRef}
            className={[styles.eventTooltip, isTooltipPinned ? styles.eventTooltipPinned : ''].filter(Boolean).join(' ')}
            style={{
              top: `${tooltipPosition.top}px`,
              left: `${tooltipPosition.left}px`,
              position: 'fixed',
              transform: getTooltipTransform(tooltipPosition.placement),
              zIndex: getFloatingLayerZIndex(journeyRef.current, 'tooltip')
            }}
          >
            <div className={styles.tooltipHeader}>
              <div className={styles.tooltipTitle}>{getEventTitle(event)}</div>
              <div className={styles.tooltipDate}>{formatLocalDateTime(event.date)}</div>
            </div>
            <div className={styles.tooltipSections}>
              {tooltipSections.map(section => (
                <section key={section.title} className={styles.tooltipSection}>
                  <div className={styles.tooltipSectionTitle}>{section.title}</div>
                  <div className={styles.tooltipList}>
                    {section.items.map((item, idx) => (
                      <div key={`${item.label}-${idx}`} className={styles.tooltipItem} data-kind={item.kind || 'text'}>
                        <span className={styles.tooltipLabel}>{item.label}</span>
                        <span className={styles.tooltipValue}>
                          <span className={styles.tooltipValueText}>{item.value}</span>
                          {item.detail && <span className={styles.tooltipDetail}>{item.detail}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>,
          document.body
        )}

        {options.showDefaultConnector && !isLast && (
          <div className={styles.connector}>
            <Icon name="arrow-right" size={16} />
          </div>
        )}
      </div>
    )
  }

  const timelineContent = layout === 'snake' ? (
    <div className={styles.snakeTimeline}>
      {displayRows.map((row, rowIndex) => {
        const isReverseRow = rowIndex % 2 === 1
        const rowStartIndex = rowIndex * SNAKE_ROW_SIZE
        const rowDirection = isReverseRow ? 'reverse' : 'forward'

        return (
          <div key={rowStartIndex} className={styles.snakeRow} data-direction={rowDirection}>
            {row.map((event, rowItemIndex) => {
              const index = rowStartIndex + rowItemIndex
              const slot = isReverseRow
                ? SNAKE_ROW_SIZE - rowItemIndex - 1
                : rowItemIndex

              return renderJourneyEvent(event, index, { slot })
            })}

            {row.map((_, rowItemIndex) => {
              if (rowItemIndex >= row.length - 1) return null

              const currentSlot = isReverseRow
                ? SNAKE_ROW_SIZE - rowItemIndex - 1
                : rowItemIndex
              const nextSlot = isReverseRow
                ? SNAKE_ROW_SIZE - rowItemIndex - 2
                : rowItemIndex + 1
              const connectorSlot = Math.min(currentSlot, nextSlot)

              return (
                <div
                  key={`connector-${rowStartIndex}-${rowItemIndex}`}
                  className={styles.snakeConnector}
                  data-snake-connector-slot={connectorSlot}
                >
                  <Icon name={isReverseRow ? 'arrow-left' : 'arrow-right'} size={16} />
                </div>
              )
            })}

            {rowStartIndex + row.length < displayJourney.length && (
              <div
                className={styles.snakeDropConnector}
                data-snake-slot={isReverseRow ? 0 : row.length - 1}
                aria-hidden="true"
              >
                <Icon name="arrow-down" size={16} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  ) : (
    <div className={styles.timeline}>
      {displayJourney.map((event, index) => renderJourneyEvent(event, index, { showDefaultConnector: true }))}
    </div>
  )

  return (
    <div className={styles.journey} data-layout={layout} ref={journeyRef}>
      <h4 className={styles.title}>Viaje del Cliente</h4>
      {timelineContent}
    </div>
  )
}
