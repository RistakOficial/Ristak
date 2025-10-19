/**
 * Normaliza nombres de plataformas publicitarias
 * Convierte abreviaciones y variantes a nombres consistentes
 * Ejemplo: "fb" → "Facebook", "ig" → "Instagram"
 */

export function normalizePlatformName(rawName) {
  if (!rawName) return 'Directo'

  // Limpiar el nombre: lowercase, sin espacios extra, sin guiones/underscores
  const name = rawName.toLowerCase().trim().replace(/[-_]/g, '')

  // Mapeo exhaustivo de variantes de plataformas
  const platformMap = {
    // Facebook variantes
    'fb': 'Facebook',
    'facebook': 'Facebook',
    'face book': 'Facebook',
    'facebook.com': 'Facebook',
    'fbig': 'Facebook',

    // Instagram variantes
    'ig': 'Instagram',
    'instagram': 'Instagram',
    'insta': 'Instagram',
    'instagram.com': 'Instagram',

    // Google variantes
    'google': 'Google',
    'google.com': 'Google',
    'google ads': 'Google',
    'googleads': 'Google',
    'adwords': 'Google',
    'gdn': 'Google',
    'search': 'Google',

    // TikTok variantes
    'tiktok': 'TikTok',
    'tik tok': 'TikTok',
    'tt': 'TikTok',
    'tiktok.com': 'TikTok',

    // Twitter/X variantes
    'twitter': 'Twitter',
    'x.com': 'Twitter',
    'x': 'Twitter',
    'twitter.com': 'Twitter',

    // LinkedIn variantes
    'linkedin': 'LinkedIn',
    'linked in': 'LinkedIn',
    'linkedin.com': 'LinkedIn',
    'li': 'LinkedIn',

    // Microsoft/Bing variantes
    'microsoft': 'Microsoft',
    'bing': 'Microsoft',
    'bing.com': 'Microsoft',
    'msn': 'Microsoft',

    // YouTube variantes
    'youtube': 'YouTube',
    'you tube': 'YouTube',
    'youtube.com': 'YouTube',
    'yt': 'YouTube',

    // Messenger variantes
    'messenger': 'Messenger',
    'fb messenger': 'Messenger',
    'facebook messenger': 'Messenger',
    'm.me': 'Messenger',

    // WhatsApp variantes
    'whatsapp': 'WhatsApp',
    'whats app': 'WhatsApp',
    'wa': 'WhatsApp',
    'whatsapp.com': 'WhatsApp',

    // Snapchat variantes
    'snapchat': 'Snapchat',
    'snap': 'Snapchat',
    'snapchat.com': 'Snapchat',

    // Pinterest variantes
    'pinterest': 'Pinterest',
    'pin': 'Pinterest',
    'pinterest.com': 'Pinterest',

    // Reddit variantes
    'reddit': 'Reddit',
    'reddit.com': 'Reddit',

    // Email variantes
    'email': 'Email',
    'correo': 'Email',
    'newsletter': 'Email',

    // Directo/Orgánico
    'direct': 'Directo',
    'directo': 'Directo',
    'organic': 'Orgánico',
    'organico': 'Orgánico',
    '(none)': 'Directo',
    'none': 'Directo'
  }

  // Buscar coincidencia exacta
  if (platformMap[name]) {
    return platformMap[name]
  }

  // Buscar si contiene alguna palabra clave
  for (const [key, value] of Object.entries(platformMap)) {
    if (name.includes(key)) {
      return value
    }
  }

  // Si no hay match, capitalizar primera letra y limpiar
  const cleaned = rawName.trim().replace(/[-_]/g, ' ')
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}
