import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { formatContactName } from '../utils/contactNameFormatter.js'
import {
  findContactByPhoneCandidates,
  generateContactId,
  recordContactPhoneNumber
} from './contactIdentityService.js'

const cleanString = (value, maxLength = 300) => String(value ?? '').trim().slice(0, maxLength)

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function getPath(source, path) {
  if (!source || typeof source !== 'object') return ''
  const parts = String(path || '').split('.').filter(Boolean)
  let current = source
  for (const part of parts) {
    if (current == null) return ''
    if (Array.isArray(current)) {
      const index = Number(part)
      current = Number.isInteger(index) ? current[index] : undefined
    } else {
      current = current[part]
    }
  }
  return current
}

function firstText(source, paths = [], maxLength = 300) {
  for (const path of paths) {
    const value = getPath(source, path)
    if (value == null || typeof value === 'object') continue
    const clean = cleanString(value, maxLength)
    if (clean) return clean
  }
  return ''
}

function firstEmail(source, paths = []) {
  const value = firstText(source, paths, 180).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : ''
}

function buildNameFromParts(...parts) {
  return parts.map(part => cleanString(part, 80)).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}

function phoneFromObject(value) {
  if (!value || typeof value !== 'object') return ''
  const direct = firstText(value, [
    'phone',
    'phoneNumber',
    'phone_number',
    'mobile',
    'mobilePhone',
    'mobile_phone'
  ], 80)
  if (direct) return direct

  const country = firstText(value, ['countryCode', 'country_code', 'dialCode', 'dial_code'], 10).replace(/[^\d+]/g, '')
  const area = firstText(value, ['areaCode', 'area_code', 'area'], 10).replace(/\D/g, '')
  const number = firstText(value, ['number'], 40).replace(/\D/g, '')
  return cleanString(`${country}${area}${number}`, 80)
}

function firstPhone(source, paths = []) {
  for (const path of paths) {
    const value = getPath(source, path)
    const raw = value && typeof value === 'object'
      ? phoneFromObject(value)
      : cleanString(value, 80)
    const digits = raw.replace(/\D/g, '')
    if (digits.length >= 7) return normalizePhoneForStorage(raw) || raw
  }
  return ''
}

function extractName(source) {
  const direct = firstText(source, [
    'row.contact_name',
    'row.contactName',
    'row.full_name',
    'row.name',
    'metadata.contactName',
    'metadata.contact_name',
    'metadata.customerName',
    'metadata.customer_name',
    'metadata.fullName',
    'metadata.full_name',
    'payload.customer.fullName',
    'payload.customer.full_name',
    'payload.customer.name',
    'payload.customer_info.name',
    'payload.payer.name',
    'payload.billing_details.name',
    'payload.payment_method.billing_details.name',
    'payload.charges.data.0.billing_details.name',
    'payload.card.name',
    'payload.card.cardholder_name',
    'payload.card.cardholderName',
    'payload.prefilledFields.customer.fullName',
    'payload.prefilled_fields.customer.fullName',
    'payload.paymentLink.prefilledFields.customer.fullName',
    'payload.payment_link.prefilledFields.customer.fullName',
    'payload.payment_link.prefilled_fields.customer.fullName'
  ], 180)
  if (direct) return direct

  return buildNameFromParts(
    firstText(source, ['payload.customer.firstName', 'payload.customer.first_name', 'payload.payer.first_name'], 80),
    firstText(source, ['payload.customer.lastName', 'payload.customer.last_name', 'payload.payer.last_name'], 80)
  )
}

export function extractPaymentContactIdentity({ row = {}, providerPayload = {}, provider = '' } = {}) {
  const metadata = parseJson(row?.metadata_json, {})
  const payloadMetadata = providerPayload?.metadata && typeof providerPayload.metadata === 'object'
    ? providerPayload.metadata
    : {}
  const source = {
    row: row || {},
    metadata: {
      ...metadata,
      ...payloadMetadata
    },
    payload: providerPayload || {}
  }

  const contactId = firstText(source, [
    'row.contact_id',
    'row.contactId',
    'metadata.contactId',
    'metadata.contact_id',
    'metadata.ristakContactId',
    'metadata.ristak_contact_id'
  ], 180)
  const email = firstEmail(source, [
    'row.contact_email',
    'row.email',
    'metadata.contactEmail',
    'metadata.contact_email',
    'metadata.customerEmail',
    'metadata.customer_email',
    'metadata.email',
    'payload.receipt_email',
    'payload.customer.email',
    'payload.customer.emailAddress',
    'payload.customer.email_address',
    'payload.customer_info.email',
    'payload.payer.email',
    'payload.billing_details.email',
    'payload.payment_method.billing_details.email',
    'payload.charges.data.0.billing_details.email',
    'payload.additional_info.payer.email',
    'payload.prefilledFields.customer.email',
    'payload.prefilled_fields.customer.email',
    'payload.paymentLink.prefilledFields.customer.email',
    'payload.payment_link.prefilledFields.customer.email',
    'payload.payment_link.prefilled_fields.customer.email'
  ])
  const phone = firstPhone(source, [
    'row.contact_phone',
    'row.phone',
    'metadata.contactPhone',
    'metadata.contact_phone',
    'metadata.customerPhone',
    'metadata.customer_phone',
    'metadata.phone',
    'payload.customer.phone',
    'payload.customer.phoneNumber',
    'payload.customer.phone_number',
    'payload.customer.mobile',
    'payload.customer_info.phone',
    'payload.payer.phone',
    'payload.payer.phone.number',
    'payload.billing_details.phone',
    'payload.payment_method.billing_details.phone',
    'payload.charges.data.0.billing_details.phone',
    'payload.additional_info.payer.phone',
    'payload.prefilledFields.customer.phoneNumber',
    'payload.prefilledFields.customer.phone_number',
    'payload.prefilledFields.customer.phone',
    'payload.prefilled_fields.customer.phoneNumber',
    'payload.prefilled_fields.customer.phone_number',
    'payload.prefilled_fields.customer.phone',
    'payload.paymentLink.prefilledFields.customer.phoneNumber',
    'payload.payment_link.prefilledFields.customer.phoneNumber',
    'payload.payment_link.prefilled_fields.customer.phoneNumber'
  ])
  const fullName = formatContactName(extractName(source))

  return {
    contactId,
    email,
    phone,
    fullName,
    provider: cleanString(provider, 40)
  }
}

async function findContactByEmail(email) {
  const cleanEmail = cleanString(email, 180).toLowerCase()
  if (!cleanEmail) return null
  return db.get(
    `SELECT *
       FROM contacts
      WHERE email IS NOT NULL
        AND email != ''
        AND LOWER(email) = LOWER(?)
        AND deleted_at IS NULL
      LIMIT 1`,
    [cleanEmail]
  )
}

async function findContactById(contactId) {
  const id = cleanString(contactId, 180)
  if (!id) return null
  return db.get('SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id])
}

async function enrichContact(contactId, identity = {}) {
  const id = cleanString(contactId, 180)
  if (!id) return null

  const existing = await findContactById(id)
  if (!existing) return null

  const email = cleanString(identity.email, 180).toLowerCase()
  const fullName = formatContactName(cleanString(identity.fullName, 180))
  const phone = cleanString(identity.phone, 80)
  const canonicalPhone = normalizePhoneForStorage(phone) || phone || ''
  const updates = []
  const params = []

  if (email && !cleanString(existing.email)) {
    const emailOwner = await findContactByEmail(email)
    if (!emailOwner || emailOwner.id === id) {
      updates.push('email = ?')
      params.push(email)
    }
  }
  if (fullName && !cleanString(existing.full_name)) {
    updates.push('full_name = ?')
    params.push(fullName)
  }
  if (canonicalPhone && !cleanString(existing.phone)) {
    const phoneOwner = await findContactByPhoneCandidates(canonicalPhone, { excludeId: id }).catch(() => null)
    if (!phoneOwner) {
      updates.push('phone = ?')
      params.push(canonicalPhone)
    }
  }

  if (updates.length) {
    await db.run(
      `UPDATE contacts SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [...params, id]
    )
  }

  if (canonicalPhone) {
    await recordContactPhoneNumber({
      contactId: id,
      phone: canonicalPhone,
      label: 'Principal',
      isPrimary: !cleanString(existing.phone),
      source: 'payment',
      mergeConflicts: false
    }).catch((error) => {
      logger.warn(`No se pudo registrar telefono de contacto ${id} desde pago: ${error.message}`)
    })
  }

  return id
}

async function resolveOrCreatePaymentContact(identity = {}) {
  const explicit = await findContactById(identity.contactId)
  if (explicit?.id) {
    await enrichContact(explicit.id, identity)
    return { contactId: explicit.id, matchedBy: 'contact_id', created: false }
  }

  const byPhone = await findContactByPhoneCandidates(identity.phone).catch(() => null)
  if (byPhone?.id) {
    await enrichContact(byPhone.id, identity)
    return { contactId: byPhone.id, matchedBy: 'phone', created: false }
  }

  const byEmail = await findContactByEmail(identity.email)
  if (byEmail?.id) {
    await enrichContact(byEmail.id, identity)
    return { contactId: byEmail.id, matchedBy: 'email', created: false }
  }

  const email = cleanString(identity.email, 180).toLowerCase()
  const phone = cleanString(identity.phone, 80)
  const canonicalPhone = normalizePhoneForStorage(phone) || phone || ''
  const fullName = formatContactName(cleanString(identity.fullName, 180))
  if (!email && !canonicalPhone) return { contactId: '', matchedBy: '', created: false }

  const contactId = generateContactId()
  await db.run(
    `INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      contactId,
      canonicalPhone || null,
      email || null,
      fullName || null,
      'payment_checkout'
    ]
  )

  if (canonicalPhone) {
    await recordContactPhoneNumber({
      contactId,
      phone: canonicalPhone,
      label: 'Principal',
      isPrimary: true,
      source: 'payment',
      mergeConflicts: false
    }).catch((error) => {
      logger.warn(`No se pudo registrar telefono de contacto ${contactId} desde pago: ${error.message}`)
    })
  }

  return { contactId, matchedBy: email ? 'email' : 'phone', created: true }
}

export async function resolvePaymentContactForGatewayPayment(row = {}, options = {}) {
  if (!row?.id) return ''

  try {
    const storedMetadata = parseJson(row.metadata_json, {})
    const conversationalTestMarker = storedMetadata?.conversationalAgentTest &&
      typeof storedMetadata.conversationalAgentTest === 'object'
      ? storedMetadata.conversationalAgentTest
      : {}
    const isConversationalAgentTestPayment = Boolean(
      cleanString(row.conversational_test_effect_id, 180) ||
      cleanString(conversationalTestMarker.testEffectId, 180)
    )

    // El webhook sandbox confirma el efecto del tester, pero nunca puede usar
    // datos del checkout para enriquecer, crear o fusionar contactos reales.
    // La identidad autorizada es exclusivamente el contacto que ya quedó
    // sellado al crear el efecto de prueba.
    if (isConversationalAgentTestPayment) {
      return cleanString(row.contact_id, 180)
    }

    const identity = extractPaymentContactIdentity({
      row,
      providerPayload: options.providerPayload || options.payload || {},
      provider: options.provider || row.payment_provider || ''
    })
    if (!identity.contactId && !identity.email && !identity.phone) return cleanString(row.contact_id, 180)

    const result = await resolveOrCreatePaymentContact({
      ...identity,
      contactId: identity.contactId || row.contact_id
    })
    const contactId = cleanString(result.contactId, 180)
    if (!contactId) return cleanString(row.contact_id, 180)

    const metadata = storedMetadata
    const nextMetadata = {
      ...metadata,
      contactId: metadata.contactId || contactId,
      contactName: metadata.contactName || identity.fullName || '',
      contactEmail: metadata.contactEmail || identity.email || '',
      contactPhone: metadata.contactPhone || identity.phone || '',
      paymentContactResolution: {
        contactId,
        provider: cleanString(options.provider || row.payment_provider || identity.provider, 40),
        matchedBy: result.matchedBy || (row.contact_id ? 'existing_payment_contact' : ''),
        created: Boolean(result.created),
        resolvedAt: new Date().toISOString()
      }
    }

    await db.run(
      `UPDATE payments
       SET contact_id = COALESCE(contact_id, ?),
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [contactId, JSON.stringify(nextMetadata), row.id]
    )

    return contactId
  } catch (error) {
    logger.warn(`No se pudo enlazar contacto al pago ${row.id}: ${error.message}`)
    return cleanString(row.contact_id, 180)
  }
}
