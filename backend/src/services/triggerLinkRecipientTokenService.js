import {
  openSealedPublicContextClaims,
  sealPublicContextClaims
} from './publicContextTokenService.js'

const TRIGGER_LINK_RECIPIENT_PURPOSE = 'trigger_link.recipient'
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/

function cleanString(value, maxLength = 500) {
  const text = String(value ?? '').trim()
  return text ? text.slice(0, maxLength) : ''
}

function normalizeBaseUrl(value = '') {
  return cleanString(value, 2048).replace(/\/+$/, '')
}

function normalizePublicId(value) {
  const publicId = cleanString(value, 80)
  return PUBLIC_ID_PATTERN.test(publicId) ? publicId : ''
}

function normalizeContactId(value) {
  const contactId = cleanString(value, 180)
  if (!contactId || /[\u0000-\u001f\u007f\s/?#]/.test(contactId)) return ''
  return contactId
}

function normalizeAppointmentId(value) {
  const appointmentId = cleanString(value, 180)
  if (!appointmentId || /[\u0000-\u001f\u007f\s/?#]/.test(appointmentId)) return ''
  return appointmentId
}

export async function createTriggerLinkRecipientToken({ publicId, contactId, appointmentId = '' } = {}) {
  const link = normalizePublicId(publicId)
  const contact = normalizeContactId(contactId)
  const appointment = normalizeAppointmentId(appointmentId)
  if (!link || !contact) return ''

  return sealPublicContextClaims({
    purpose: TRIGGER_LINK_RECIPIENT_PURPOSE,
    claims: { l: link, c: contact, ...(appointment ? { a: appointment } : {}) }
  })
}

export async function readTriggerLinkRecipientToken(token) {
  const decoded = await openSealedPublicContextClaims(token, {
    purpose: TRIGGER_LINK_RECIPIENT_PURPOSE
  })
  const publicId = normalizePublicId(decoded.claims?.l)
  const contactId = normalizeContactId(decoded.claims?.c)
  const appointmentId = normalizeAppointmentId(decoded.claims?.a)
  if (!publicId || !contactId) throw new Error('Token de enlace de disparo incompleto')
  return { publicId, contactId, ...(appointmentId ? { appointmentId } : {}) }
}

export async function buildTriggerLinkRecipientUrl({
  publicId,
  contactId,
  appointmentId = '',
  baseUrl = ''
} = {}) {
  const token = await createTriggerLinkRecipientToken({ publicId, contactId, appointmentId })
  if (!token) return ''
  const path = `/${encodeURIComponent(token)}`
  const base = normalizeBaseUrl(
    baseUrl || process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL
  )
  return base ? `${base}${path}` : path
}
