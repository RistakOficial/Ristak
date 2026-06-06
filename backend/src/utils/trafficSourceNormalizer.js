/**
 * Sistema de Normalización de Fuentes de Tráfico
 *
 * Prioridad de detección:
 * 1. referrer_url
 * 2. site_source_name
 * 3. utm_source
 * 4. source_platform
 *
 * Normaliza todas las variaciones posibles a nombres legibles de plataforma
 */

// Mapeo completo de dominios de referrer
const REFERRER_DOMAIN_MAP = {
  // Google
  'google.com': 'Google',
  'google.com.mx': 'Google',
  'google.es': 'Google',
  'google.co.uk': 'Google',
  'google.ca': 'Google',
  'google.com.br': 'Google',
  'google.de': 'Google',
  'google.fr': 'Google',
  'google.it': 'Google',
  'google.co.jp': 'Google',
  'google.co.in': 'Google',
  'google.com.au': 'Google',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'm.youtube.com': 'YouTube',

  // Meta/Facebook
  'facebook.com': 'Facebook',
  'www.facebook.com': 'Facebook',
  'm.facebook.com': 'Facebook',
  'l.facebook.com': 'Facebook',
  'lm.facebook.com': 'Facebook',
  'fb.com': 'Facebook',
  'fb.me': 'Facebook',
  'instagram.com': 'Instagram',
  'www.instagram.com': 'Instagram',
  'l.instagram.com': 'Instagram',

  // TikTok
  'tiktok.com': 'TikTok',
  'www.tiktok.com': 'TikTok',
  'm.tiktok.com': 'TikTok',
  'vm.tiktok.com': 'TikTok',

  // Microsoft/Bing
  'bing.com': 'Bing',
  'www.bing.com': 'Bing',
  'msn.com': 'Bing',
  'www.msn.com': 'Bing',

  // Twitter/X
  'twitter.com': 'Twitter',
  'www.twitter.com': 'Twitter',
  'm.twitter.com': 'Twitter',
  't.co': 'Twitter',
  'x.com': 'Twitter',
  'www.x.com': 'Twitter',

  // LinkedIn
  'linkedin.com': 'LinkedIn',
  'www.linkedin.com': 'LinkedIn',
  'lnkd.in': 'LinkedIn',

  // Snapchat
  'snapchat.com': 'Snapchat',
  'www.snapchat.com': 'Snapchat',

  // Pinterest
  'pinterest.com': 'Pinterest',
  'www.pinterest.com': 'Pinterest',
  'pin.it': 'Pinterest',

  // Reddit
  'reddit.com': 'Reddit',
  'www.reddit.com': 'Reddit',
  'old.reddit.com': 'Reddit',
  'redd.it': 'Reddit',

  // WhatsApp
  'wa.me': 'WhatsApp',
  'whatsapp.com': 'WhatsApp',
  'web.whatsapp.com': 'WhatsApp',

  // Telegram
  'telegram.org': 'Telegram',
  't.me': 'Telegram',

  // Otros
  'yahoo.com': 'Yahoo',
  'duckduckgo.com': 'DuckDuckGo',
  'baidu.com': 'Baidu',
  'yandex.com': 'Yandex',
  'ask.com': 'Ask',
}

// Mapeo de códigos cortos y variaciones a plataformas
const SOURCE_CODE_MAP = {
  // Facebook/Meta - TODAS las variaciones
  'fb': 'Facebook',
  'facebook': 'Facebook',
  'meta': 'Facebook',
  'fb_ad': 'Facebook',
  'fb_ads': 'Facebook',
  'fbad': 'Facebook',
  'fbads': 'Facebook',
  'facebook_ad': 'Facebook',
  'facebook_ads': 'Facebook',
  'facebook_paid': 'Facebook',
  'fb_paid': 'Facebook',
  'meta_paid': 'Facebook',
  'meta_ad': 'Facebook',
  'meta_ads': 'Facebook',
  'facebook.com': 'Facebook',
  'fb.com': 'Facebook',

  // Instagram - TODAS las variaciones
  'ig': 'Instagram',
  'instagram': 'Instagram',
  'ig_ad': 'Instagram',
  'ig_ads': 'Instagram',
  'igad': 'Instagram',
  'igads': 'Instagram',
  'instagram_ad': 'Instagram',
  'instagram_ads': 'Instagram',
  'instagram_paid': 'Instagram',
  'ig_paid': 'Instagram',
  'instagram.com': 'Instagram',

  // Google - TODAS las variaciones
  'google': 'Google',
  'ggl': 'Google',
  'adwords': 'Google',
  'google_ads': 'Google',
  'google_ad': 'Google',
  'googleads': 'Google',
  'googlead': 'Google',
  'google_paid': 'Google',
  'ggl_paid': 'Google',
  'google.com': 'Google',
  'cpc': 'Google',
  'ppc': 'Google',
  'sem': 'Google',

  // YouTube
  'youtube': 'YouTube',
  'yt': 'YouTube',
  'youtube_ad': 'YouTube',
  'youtube_ads': 'YouTube',
  'youtube_paid': 'YouTube',
  'yt_ad': 'YouTube',
  'yt_ads': 'YouTube',
  'youtube.com': 'YouTube',

  // TikTok - TODAS las variaciones
  'tiktok': 'TikTok',
  'tt': 'TikTok',
  'ttclid': 'TikTok',
  'tiktok_ad': 'TikTok',
  'tiktok_ads': 'TikTok',
  'tiktokad': 'TikTok',
  'tiktokads': 'TikTok',
  'tt_ad': 'TikTok',
  'tt_ads': 'TikTok',
  'tiktok_paid': 'TikTok',
  'tt_paid': 'TikTok',
  'tiktok.com': 'TikTok',

  // Microsoft/Bing - TODAS las variaciones
  'bing': 'Bing',
  'msn': 'Bing',
  'microsoft': 'Bing',
  'ms': 'Bing',
  'msclkid': 'Bing',
  'bing_ad': 'Bing',
  'bing_ads': 'Bing',
  'microsoft_ads': 'Bing',
  'microsoft_ad': 'Bing',
  'bing_paid': 'Bing',
  'ms_paid': 'Bing',
  'bing.com': 'Bing',

  // Twitter/X - TODAS las variaciones
  'twitter': 'Twitter',
  'x': 'Twitter',
  'twclid': 'Twitter',
  'twitter_ad': 'Twitter',
  'twitter_ads': 'Twitter',
  'x_ad': 'Twitter',
  'x_ads': 'Twitter',
  'twitter_paid': 'Twitter',
  'x_paid': 'Twitter',
  'twitter.com': 'Twitter',
  'x.com': 'Twitter',

  // LinkedIn - TODAS las variaciones
  'linkedin': 'LinkedIn',
  'li': 'LinkedIn',
  'linkedin_ad': 'LinkedIn',
  'linkedin_ads': 'LinkedIn',
  'li_ad': 'LinkedIn',
  'li_ads': 'LinkedIn',
  'linkedin_paid': 'LinkedIn',
  'li_paid': 'LinkedIn',
  'linkedin.com': 'LinkedIn',

  // Snapchat - TODAS las variaciones
  'snapchat': 'Snapchat',
  'snap': 'Snapchat',
  'sc': 'Snapchat',
  'snapchat_ad': 'Snapchat',
  'snapchat_ads': 'Snapchat',
  'snap_ad': 'Snapchat',
  'snap_ads': 'Snapchat',
  'snapchat_paid': 'Snapchat',
  'snap_paid': 'Snapchat',
  'snapchat.com': 'Snapchat',

  // Pinterest - TODAS las variaciones
  'pinterest': 'Pinterest',
  'pin': 'Pinterest',
  'pinterest_ad': 'Pinterest',
  'pinterest_ads': 'Pinterest',
  'pin_ad': 'Pinterest',
  'pin_ads': 'Pinterest',
  'pinterest_paid': 'Pinterest',
  'pin_paid': 'Pinterest',
  'pinterest.com': 'Pinterest',

  // Reddit - TODAS las variaciones
  'reddit': 'Reddit',
  'reddit_ad': 'Reddit',
  'reddit_ads': 'Reddit',
  'reddit_paid': 'Reddit',
  'reddit.com': 'Reddit',

  // WhatsApp - TODAS las variaciones
  'whatsapp': 'WhatsApp',
  'wa': 'WhatsApp',
  'waapi': 'WhatsApp',
  'ycloud': 'WhatsApp',
  'whatsapp_api': 'WhatsApp',
  'whatsapp_business': 'WhatsApp',
  'whatsapp_business_api': 'WhatsApp',
  'whatsapp business': 'WhatsApp',
  'whatsapp api': 'WhatsApp',
  'click_to_whatsapp': 'WhatsApp',
  'ctwa': 'WhatsApp',
  'whatsapp_ad': 'WhatsApp',
  'whatsapp_ads': 'WhatsApp',
  'whatsapp.com': 'WhatsApp',

  // Telegram - TODAS las variaciones
  'telegram': 'Telegram',
  'tg': 'Telegram',
  'telegram_ad': 'Telegram',
  'telegram.org': 'Telegram',

  // Email
  'email': 'Email',
  'mail': 'Email',
  'newsletter': 'Email',
  'campaign': 'Email',

  // Direct
  'direct': 'Directo',
  'none': 'Directo',
  '(direct)': 'Directo',
  '(none)': 'Directo',

  // Organic
  'organic': 'Orgánico',
  'seo': 'Orgánico',

  // Referral
  'referral': 'Referencia',
  'ref': 'Referencia',

  // Otros buscadores
  'yahoo': 'Yahoo',
  'duckduckgo': 'DuckDuckGo',
  'ddg': 'DuckDuckGo',
  'baidu': 'Baidu',
  'yandex': 'Yandex',
  'ask': 'Ask',
}

/**
 * Extrae el dominio de una URL de referrer
 * @param {string} referrerUrl
 * @returns {string|null}
 */
function extractDomain(referrerUrl) {
  if (!referrerUrl) return null

  try {
    const url = new URL(referrerUrl)
    let domain = url.hostname.toLowerCase()

    // Remover www. si existe
    if (domain.startsWith('www.')) {
      domain = domain.substring(4)
    }

    return domain
  } catch (e) {
    // Si no es URL válida, intentar extraer dominio manualmente
    const match = referrerUrl.toLowerCase().match(/(?:https?:\/\/)?(?:www\.)?([^\/]+)/)
    return match ? match[1].replace(/^www\./, '') : null
  }
}

function lookupReferrerDomain(domain) {
  if (!domain) return null

  const normalized = String(domain).toLowerCase().replace(/^www\./, '')
  if (REFERRER_DOMAIN_MAP[normalized]) {
    return REFERRER_DOMAIN_MAP[normalized]
  }

  const mappedDomain = Object.keys(REFERRER_DOMAIN_MAP)
    .sort((a, b) => b.length - a.length)
    .find(mapped => normalized === mapped || normalized.endsWith(`.${mapped}`))

  return mappedDomain ? REFERRER_DOMAIN_MAP[mappedDomain] : null
}

const PLATFORM_PATTERNS = [
  { platform: 'Instagram', patterns: ['instagram', 'ig_', 'ig-', 'ig ', 'ig.com'] },
  { platform: 'Facebook', patterns: ['facebook', 'fb_', 'fb-', 'fb ', 'fb.com', 'm.me', 'messenger'] },
  { platform: 'TikTok', patterns: ['tiktok', 'tt_', 'tt-', 'ttclid'] },
  { platform: 'YouTube', patterns: ['youtube', 'youtu.be', 'yt_', 'yt-'] },
  { platform: 'Google', patterns: ['google', 'adwords', 'gclid', 'gbraid', 'wbraid'] },
  { platform: 'Bing', patterns: ['bing', 'microsoft', 'msclkid'] },
  { platform: 'LinkedIn', patterns: ['linkedin', 'lnkd', 'li_'] },
  { platform: 'Snapchat', patterns: ['snapchat', 'snap_', 'snap-', 'sc_'] },
  { platform: 'Pinterest', patterns: ['pinterest', 'pin.it', 'pin_'] },
  { platform: 'Reddit', patterns: ['reddit', 'redd.it'] },
  { platform: 'Twitter', patterns: ['twitter', 'x.com', 'twclid'] },
  { platform: 'WhatsApp', patterns: ['whatsapp', 'wa.me', 'waapi', 'ycloud', 'click_to_whatsapp'] },
  { platform: 'Telegram', patterns: ['telegram', 't.me'] },
  { platform: 'Email', patterns: ['email', 'newsletter'] }
]

function lookupSourceValue(value) {
  if (!value) return null

  const raw = String(value).trim()
  if (!raw) return null

  const normalized = raw.toLowerCase().replace(/\s+/g, ' ')
  const domain = extractDomain(raw)
  const domainPlatform = lookupReferrerDomain(domain)
  if (domainPlatform) return domainPlatform

  if (REFERRER_DOMAIN_MAP[normalized]) {
    return REFERRER_DOMAIN_MAP[normalized]
  }

  if (SOURCE_CODE_MAP[normalized]) {
    return SOURCE_CODE_MAP[normalized]
  }

  const compact = normalized.replace(/[\s-]+/g, '_')
  if (SOURCE_CODE_MAP[compact]) {
    return SOURCE_CODE_MAP[compact]
  }

  const platformMatch = PLATFORM_PATTERNS.find(({ patterns }) =>
    patterns.some(pattern => normalized.includes(pattern))
  )

  return platformMatch?.platform || null
}

function hasSourceSignalValue(value) {
  return typeof value === 'string' ? value.trim().length > 0 : Boolean(value)
}

/**
 * Normaliza una fuente de tráfico usando prioridad 1-4
 * @param {Object} data - Objeto con campos referrer_url, site_source_name, utm_source, source_platform
 * @returns {string} - Nombre normalizado de la plataforma
 */
export function normalizeTrafficSource(data) {
  if (!data) return 'Desconocido'

  const hasSourceSignal = [
    data.referrer_url,
    data.referral_source_url,
    data.source_url,
    data.attribution_url,
    data.site_source_name,
    data.utm_source,
    data.source_platform,
    data.referral_source_app,
    data.referral_entry_point,
    data.source
  ].some(hasSourceSignalValue)

  if (!hasSourceSignal) return 'Directo'

  // Prioridad 1: referrer_url
  for (const urlValue of [data.referrer_url, data.referral_source_url, data.source_url, data.attribution_url]) {
    const platform = lookupSourceValue(urlValue)
    if (platform) {
      return platform
    }
  }

  // Prioridad 2: site_source_name
  for (const sourceValue of [data.site_source_name, data.referral_source_app, data.referral_entry_point]) {
    const platform = lookupSourceValue(sourceValue)
    if (platform) {
      return platform
    }
  }

  // Prioridad 3: utm_source
  if (data.utm_source) {
    const platform = lookupSourceValue(data.utm_source)
    if (platform) {
      return platform
    }
  }

  // Prioridad 4: source_platform
  for (const sourceValue of [data.source_platform, data.source]) {
    const platform = lookupSourceValue(sourceValue)
    if (platform) {
      return platform
    }
  }

  // Fallback
  return 'Otro'
}

/**
 * Normaliza un código/nombre de fuente directamente (para retrocompatibilidad)
 * @param {string} source
 * @returns {string}
 */
export function normalizeSourceCode(source) {
  if (!source) return 'Desconocido'

  const normalized = String(source).toLowerCase().trim()
  const platform = lookupSourceValue(normalized)
  if (platform) return platform

  // Capitalizar primera letra si no encontró match
  return String(source).charAt(0).toUpperCase() + String(source).slice(1)
}

export function normalizeWhatsAppAttributionPlatform(data = {}) {
  const platform = normalizeTrafficSource({
    referrer_url: data.referral_source_url || data.source_url || data.attribution_url,
    referral_source_url: data.referral_source_url,
    site_source_name: data.referral_source_app || data.source_app,
    utm_source: data.referral_source_type || data.source_type,
    source_platform: data.ad_platform || data.source_platform,
    referral_source_app: data.referral_source_app || data.source_app,
    referral_entry_point: data.referral_entry_point || data.entry_point,
    source: data.source
  })

  if (['Directo', 'Desconocido', 'Otro', 'WhatsApp'].includes(platform)) {
    if (
      data.referral_source_id ||
      data.source_id ||
      data.referral_ctwa_clid ||
      data.ctwa_clid ||
      data.ad_id
    ) {
      return 'Meta Ads'
    }
  }

  return platform
}
