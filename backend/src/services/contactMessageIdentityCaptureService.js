import { db } from '../config/database.js'
import { getAccountLocaleSettings } from '../utils/accountLocale.js'
import { composePhoneWithDialCode, normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { logger } from '../utils/logger.js'
import {
  findContactByPhoneCandidates,
  listContactPhoneNumbers,
  recordContactPhoneNumber
} from './contactIdentityService.js'

const EMAIL_PATTERN = /^[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[^\s@<>()[\],;:"']{2,}$/i
const EMAIL_SCAN_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE_SCAN_PATTERN = /(?:^|[^\w+])(\+?\s*(?:\(\s*\d{1,4}\s*\)|\d{1,4})[\d\s().-]{6,}\d)(?=$|[^\w])/g
const TRAILING_EMAIL_PUNCTUATION = /[.,;:!?)}\]]+$/g

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeEmailCandidate(value = '') {
  const email = cleanString(value).replace(TRAILING_EMAIL_PUNCTUATION, '').toLowerCase()
  return EMAIL_PATTERN.test(email) ? email : ''
}

export function extractEmailCandidatesFromText(text = '') {
  const matches = String(text || '').match(EMAIL_SCAN_PATTERN) || []
  const seen = new Set()
  const emails = []

  for (const match of matches) {
    const email = normalizeEmailCandidate(match)
    if (!email || seen.has(email)) continue
    seen.add(email)
    emails.push(email)
  }

  return emails
}

function stripEmailAndUrlNoise(text = '') {
  return String(text || '')
    .replace(EMAIL_SCAN_PATTERN, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
}

function hasExplicitInternationalPrefix(value = '') {
  const raw = cleanString(value)
  return raw.startsWith('+') || raw.startsWith('00')
}

function normalizePhoneCandidate(value = '', { dialCode = '52' } = {}) {
  const raw = cleanString(value)
  if (!raw) return ''

  const digits = raw.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) return ''

  const normalized = hasExplicitInternationalPrefix(raw)
    ? normalizePhoneForStorage(raw, { defaultCountryCode: dialCode })
    : composePhoneWithDialCode(raw, dialCode)
  const normalizedDigits = normalized.replace(/\D/g, '')

  if (normalizedDigits.length < 10 || normalizedDigits.length > 15) return ''
  return normalized
}

export function extractPhoneCandidatesFromText(text = '', { dialCode = '52' } = {}) {
  const searchable = stripEmailAndUrlNoise(text)
  const seen = new Set()
  const phones = []

  for (const match of searchable.matchAll(PHONE_SCAN_PATTERN)) {
    const phone = normalizePhoneCandidate(match[1], { dialCode })
    if (!phone || seen.has(phone)) continue
    seen.add(phone)
    phones.push(phone)
  }

  return phones
}

export function extractContactIdentityCandidatesFromText(text = '', {
  allowEmail = true,
  allowPhone = true,
  dialCode = '52'
} = {}) {
  return {
    emails: allowEmail ? extractEmailCandidatesFromText(text) : [],
    phones: allowPhone ? extractPhoneCandidatesFromText(text, { dialCode }) : []
  }
}

async function contactHasAnyPhone(contactId, primaryPhone = '') {
  if (cleanString(primaryPhone)) return true
  const phoneRows = await listContactPhoneNumbers(contactId).catch(() => [])
  return phoneRows.some(row => cleanString(row?.phone))
}

async function findEmailOwner(email, excludeId) {
  const cleanEmail = normalizeEmailCandidate(email)
  const cleanExcludeId = cleanString(excludeId)
  if (!cleanEmail) return null

  return db.get(
    `SELECT id
     FROM contacts
     WHERE email IS NOT NULL
       AND email != ''
       AND LOWER(TRIM(email)) = ?
       AND id != ?
     LIMIT 1`,
    [cleanEmail, cleanExcludeId]
  ).catch(() => null)
}

async function saveDetectedEmail({ contactId, email }) {
  const cleanEmail = normalizeEmailCandidate(email)
  if (!contactId || !cleanEmail) return null

  const owner = await findEmailOwner(cleanEmail, contactId)
  if (owner?.id) return null

  await db.run(
    `UPDATE contacts
     SET email = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (email IS NULL OR TRIM(email) = '')`,
    [cleanEmail, contactId]
  )

  return cleanEmail
}

async function saveDetectedPhone({ contactId, phone, source }) {
  const cleanPhone = cleanString(phone)
  if (!contactId || !cleanPhone) return null

  const owner = await findContactByPhoneCandidates(cleanPhone, { excludeId: contactId })
  if (owner?.id) return null

  await db.run(
    `UPDATE contacts
     SET phone = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
       AND (phone IS NULL OR TRIM(phone) = '')`,
    [cleanPhone, contactId]
  )

  await recordContactPhoneNumber({
    contactId,
    phone: cleanPhone,
    label: 'Principal',
    isPrimary: true,
    source,
    mergeConflicts: false
  })

  return cleanPhone
}

export async function captureContactIdentityFromMessage({
  contactId,
  text,
  source = 'message_identity_capture',
  allowEmail = true,
  allowPhone = true
} = {}) {
  const cleanContactId = cleanString(contactId)
  const body = cleanString(text)
  const result = { email: null, phone: null, updatedFields: [] }

  if (!cleanContactId || !body || (!allowEmail && !allowPhone)) return result

  try {
    const contact = await db.get(
      'SELECT id, email, phone FROM contacts WHERE id = ? LIMIT 1',
      [cleanContactId]
    )
    if (!contact?.id) return result

    const [{ dialCode }, hasAnyPhone] = await Promise.all([
      getAccountLocaleSettings().catch(() => ({ dialCode: '52' })),
      allowPhone ? contactHasAnyPhone(cleanContactId, contact.phone) : Promise.resolve(true)
    ])

    const candidates = extractContactIdentityCandidatesFromText(body, {
      allowEmail: allowEmail && !cleanString(contact.email),
      allowPhone: allowPhone && !hasAnyPhone,
      dialCode
    })

    if (!cleanString(contact.email) && candidates.emails[0]) {
      const savedEmail = await saveDetectedEmail({
        contactId: cleanContactId,
        email: candidates.emails[0]
      }).catch(error => {
        logger.warn(`[Contact Identity] No se pudo guardar correo detectado para ${cleanContactId}: ${error.message}`)
        return null
      })
      if (savedEmail) {
        result.email = savedEmail
        result.updatedFields.push('email')
      }
    }

    if (!hasAnyPhone && candidates.phones[0]) {
      const savedPhone = await saveDetectedPhone({
        contactId: cleanContactId,
        phone: candidates.phones[0],
        source: cleanString(source) || 'message_identity_capture'
      }).catch(error => {
        logger.warn(`[Contact Identity] No se pudo guardar teléfono detectado para ${cleanContactId}: ${error.message}`)
        return null
      })
      if (savedPhone) {
        result.phone = savedPhone
        result.updatedFields.push('phone')
      }
    }

    return result
  } catch (error) {
    logger.warn(`[Contact Identity] Captura automática omitida para ${cleanContactId}: ${error.message}`)
    return result
  }
}
