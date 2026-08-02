export type WhatsAppPhoneMetricSource = {
  provider?: string | null
  status?: string | null
  quality_rating?: string | null
  messaging_limit?: string | null
}

const QUALITY_LABELS: Record<string, string> = {
  GREEN: 'Alta',
  YELLOW: 'Media',
  RED: 'Baja',
  NA: 'Aún sin calificación',
  UNKNOWN: 'Aún sin calificación'
}

const MESSAGING_LIMIT_LABELS: Record<string, string> = {
  TIER_50: '50 clientes / 24 h',
  TIER_250: '250 clientes / 24 h',
  TIER_1K: '1,000 clientes / 24 h',
  TIER_2K: '2,000 clientes / 24 h',
  TIER_10K: '10,000 clientes / 24 h',
  TIER_100K: '100,000 clientes / 24 h',
  TIER_UNLIMITED: 'Ilimitado',
  UNLIMITED: 'Ilimitado',
  UNTIERED: 'Sin nivel asignado'
}

function isQrOnlyPhone(phone?: WhatsAppPhoneMetricSource | null) {
  const provider = String(phone?.provider || '').trim().toLowerCase()
  const status = String(phone?.status || '').trim().toUpperCase()
  return provider === 'qr' || status === 'QR_ONLY'
}

export function getWhatsAppQualityLabel(phone?: WhatsAppPhoneMetricSource | null) {
  if (isQrOnlyPhone(phone)) return 'No aplica'

  const quality = String(phone?.quality_rating || '').trim().toUpperCase()
  if (!quality) return 'No disponible'
  return QUALITY_LABELS[quality] || quality.replace(/_/g, ' ')
}

export function getWhatsAppMessagingLimitLabel(phone?: WhatsAppPhoneMetricSource | null) {
  if (isQrOnlyPhone(phone)) return 'No aplica'

  const limit = String(phone?.messaging_limit || '').trim().toUpperCase()
  if (!limit) return 'No disponible'
  return MESSAGING_LIMIT_LABELS[limit] || limit.replace(/_/g, ' ')
}
