import { getChangedContactCustomFieldReferences } from './contactCustomFields.js'

const cleanComparable = (value) => value === null || value === undefined
  ? ''
  : String(value).trim()

const numericComparable = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : 0
}

const parseTags = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const normalizedTags = (value) => [...new Set(
  parseTags(value).map(cleanComparable).filter(Boolean)
)].sort()

const tagsEqual = (left, right) => (
  JSON.stringify(normalizedTags(left)) === JSON.stringify(normalizedTags(right))
)

const FIELD_SPECS = [
  ['full_name', ['name', 'fullName', 'full_name']],
  ['first_name', ['firstName', 'first_name']],
  ['last_name', ['lastName', 'last_name']],
  ['phone', ['phone']],
  ['email', ['email']],
  ['source', ['source']],
  ['visitor_id', ['visitorId', 'visitor_id']],
  ['attribution_url', ['attributionUrl', 'attribution_url']],
  ['attribution_session_source', ['attributionSource', 'attribution_session_source']],
  ['attribution_medium', ['attributionMedium', 'attribution_medium']],
  ['attribution_ad_name', ['attributionAd', 'attribution_ad_name']],
  ['attribution_ad_id', ['attributionAd', 'attribution_ad_id']],
  ['attribution_ctwa_clid', ['attributionAd', 'attribution_ctwa_clid']],
  ['referred_by_contact_id', ['referredByContactId', 'referred_by_contact_id']],
  ['preferred_whatsapp_phone_number_id', ['preferredWhatsAppPhoneNumberId', 'preferred_whatsapp_phone_number_id']],
  ['assigned_user_id', ['assignedUser', 'assigned_user', 'assigned_user_id']],
  ['last_purchase_date', ['lastPurchaseDate', 'last_purchase_date']],
  ['appointment_date', ['appointmentDate', 'appointment_date']]
]

const NUMERIC_FIELD_SPECS = [
  ['total_paid', ['totalPaid', 'total_paid']],
  ['purchases_count', ['purchasesCount', 'purchases_count']]
]

/**
 * Compara dos snapshots persistidos de un contacto y devuelve únicamente los
 * campos observables cuyo valor cambió de verdad. IDs de proveedor, timestamps
 * y metadatos internos quedan fuera porque no representan una edición del CRM.
 */
export function getChangedContactFields(before = {}, after = {}, { includeTags = true } = {}) {
  const changed = new Set()

  for (const [column, aliases] of FIELD_SPECS) {
    if (cleanComparable(before?.[column]) !== cleanComparable(after?.[column])) {
      aliases.forEach(alias => changed.add(alias))
    }
  }

  for (const [column, aliases] of NUMERIC_FIELD_SPECS) {
    if (numericComparable(before?.[column]) !== numericComparable(after?.[column])) {
      aliases.forEach(alias => changed.add(alias))
    }
  }

  getChangedContactCustomFieldReferences(before?.custom_fields, after?.custom_fields)
    .forEach(alias => changed.add(alias))

  if (includeTags && !tagsEqual(before?.tags, after?.tags)) changed.add('tags')

  return [...changed]
}
