const WAMID_PREFIX = 'wamid.'
const MAX_WAMID_LENGTH = 1024
const WHATSAPP_CLIENT_KEY_PATTERN = /[A-F0-9]{16,64}/g
const RAW_CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{12,128}$/

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function decodeWamid(value = '') {
  const wamid = cleanString(value)
  if (!wamid.startsWith(WAMID_PREFIX) || wamid.length > MAX_WAMID_LENGTH) return null

  const encoded = wamid.slice(WAMID_PREFIX.length)
  if (!encoded || !/^[A-Za-z0-9_-]+={0,2}$/.test(encoded)) return null

  try {
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    const decoded = Buffer.from(padded, 'base64')
    return decoded.length ? decoded : null
  } catch {
    return null
  }
}

export function normalizeWhatsAppClientMessageKey(value = '') {
  const key = cleanString(value)
  if (!key || key.startsWith(WAMID_PREFIX) || !RAW_CLIENT_KEY_PATTERN.test(key)) return ''
  return key
}

// En Coexistence, el WAMID que entrega Meta/YCloud incluye el ID que usa el
// cliente de WhatsApp (el mismo `key.id` que observa Baileys). Esa identidad de
// protocolo permite reconciliar ambos eventos sin comparar texto, hora o media.
export function extractWhatsAppClientMessageKeyFromWamid(value = '') {
  const decoded = decodeWamid(value)
  if (!decoded) return ''

  const printable = decoded.toString('latin1')
  const matches = printable.match(WHATSAPP_CLIENT_KEY_PATTERN) || []
  return matches
    .filter(candidate => /[A-F]/.test(candidate))
    .at(-1) || ''
}

export function resolveWhatsAppProtocolMessageKey({ transport = 'api', wamid = '' } = {}) {
  return cleanString(transport).toLowerCase() === 'qr'
    ? normalizeWhatsAppClientMessageKey(wamid)
    : extractWhatsAppClientMessageKeyFromWamid(wamid)
}

export function wamidContainsWhatsAppClientMessageKey(wamid = '', key = '') {
  const decoded = decodeWamid(wamid)
  const normalizedKey = normalizeWhatsAppClientMessageKey(key)
  if (!decoded || !normalizedKey) return false
  return decoded.includes(Buffer.from(normalizedKey, 'utf8'))
}
