import { normalizePhoneDigits } from './phoneUtils.js'
import { formatContactName } from './contactNameFormatter.js'

export const GENERIC_WHATSAPP_API_CONTACT_NAME = 'Contacto WhatsApp_API'

const GENERIC_WHATSAPP_API_NAME_KEYS = new Set([
  'contactowhatsappapi',
  'contactowhatsapp',
  'contactowhatsapi',
  'whatsappapi'
])

export function cleanWhatsAppContactName(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!text || text === 'null' || text === 'undefined') return ''
  return text
}

function normalizeWhatsAppContactNameKey(value) {
  return cleanWhatsAppContactName(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

export function isPhoneLikeContactName(value, phone = '') {
  const text = cleanWhatsAppContactName(value)
  if (!text) return false

  const hasLetters = /\p{L}/u.test(text)
  const digits = normalizePhoneDigits(text)
  const phoneDigits = normalizePhoneDigits(phone)

  return !hasLetters && digits.length >= 7 && (!phoneDigits || digits.endsWith(phoneDigits) || phoneDigits.endsWith(digits))
}

export function isGenericWhatsAppApiContactName(value, phone = '') {
  const key = normalizeWhatsAppContactNameKey(value)
  if (!key) return true
  if (GENERIC_WHATSAPP_API_NAME_KEYS.has(key)) return true
  return isPhoneLikeContactName(value, phone)
}

export function normalizeWhatsAppProfileName(value, phone = '') {
  const name = cleanWhatsAppContactName(value)
  return name && !isGenericWhatsAppApiContactName(name, phone) ? formatContactName(name) : ''
}

export function shouldReplaceWhatsAppApiContactName(currentName, phone = '') {
  return isGenericWhatsAppApiContactName(currentName, phone)
}

function parseJsonLike(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (!text || !/^[{[]/.test(text)) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function pickProfileName(candidates = [], phone = '') {
  for (const candidate of candidates) {
    const name = normalizeWhatsAppProfileName(candidate, phone)
    if (name) return name
  }
  return ''
}

export function extractWhatsAppProfileName(value, phone = '') {
  const data = parseJsonLike(value)
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ''

  return pickProfileName([
    data.customerProfile?.name,
    data.customer_profile?.name,
    data.whatsAppProfile?.name,
    data.whatsappProfile?.name,
    data.whatsapp_profile?.name,
    data.contactProfile?.name,
    data.contact_profile?.name,
    data.contact?.customerProfile?.name,
    data.contact?.profile?.name,
    data.contact?.name,
    data.profile?.name,
    data.displayName,
    data.display_name,
    data.pushName,
    data.push_name,
    data.verifiedName,
    data.verified_name,
    data.profileName,
    data.profile_name,
    data.customerName,
    data.customer_name,
    data.contactName,
    data.contact_name,
    data.fullName,
    data.full_name,
    data.nickname,
    data.name
  ], phone)
}
