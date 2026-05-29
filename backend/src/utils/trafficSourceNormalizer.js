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
  'whatsapp_ad': 'WhatsApp',
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
    return match ? match[1] : null
  }
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
    data.site_source_name,
    data.utm_source,
    data.source_platform
  ].some(value => (typeof value === 'string' ? value.trim().length > 0 : Boolean(value)))

  if (!hasSourceSignal) return 'Directo'

  // Prioridad 1: referrer_url
  if (data.referrer_url) {
    const domain = extractDomain(data.referrer_url)
    if (domain && REFERRER_DOMAIN_MAP[domain]) {
      return REFERRER_DOMAIN_MAP[domain]
    }
  }

  // Prioridad 2: site_source_name
  if (data.site_source_name) {
    const normalized = data.site_source_name.toLowerCase().trim()
    if (SOURCE_CODE_MAP[normalized]) {
      return SOURCE_CODE_MAP[normalized]
    }
  }

  // Prioridad 3: utm_source
  if (data.utm_source) {
    const normalized = data.utm_source.toLowerCase().trim()
    if (SOURCE_CODE_MAP[normalized]) {
      return SOURCE_CODE_MAP[normalized]
    }
  }

  // Prioridad 4: source_platform
  if (data.source_platform) {
    const normalized = data.source_platform.toLowerCase().trim()
    if (SOURCE_CODE_MAP[normalized]) {
      return SOURCE_CODE_MAP[normalized]
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

  const normalized = source.toLowerCase().trim()

  // Verificar si es dominio
  if (REFERRER_DOMAIN_MAP[normalized]) {
    return REFERRER_DOMAIN_MAP[normalized]
  }

  // Verificar si es código
  if (SOURCE_CODE_MAP[normalized]) {
    return SOURCE_CODE_MAP[normalized]
  }

  // Capitalizar primera letra si no encontró match
  return source.charAt(0).toUpperCase() + source.slice(1)
}
