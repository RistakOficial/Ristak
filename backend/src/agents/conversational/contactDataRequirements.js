import { normalizePhoneForStorage } from '../../utils/phoneUtils.js'
import {
  mergeContactCustomFields,
  parseContactCustomFields,
  serializeContactCustomFieldsForDb
} from '../../utils/contactCustomFields.js'
import {
  isGenericWhatsAppApiContactLabel
} from '../../utils/whatsappContactProfile.js'

function cleanRequiredContactText(value, maxLength = 1000) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function normalizeRequiredContactDataKey(value = '') {
  return cleanRequiredContactText(value, 120)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function normalizeSyntheticNameText(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isEmailDerivedRistakContactName(
  normalizedName = '',
  contactContext = {}
) {
  const nameParts = String(normalizedName || '').split(/\s+/).filter(Boolean)
  if (nameParts.length < 2 || nameParts.at(-1) !== 'ristak') return false
  // paymentContactLink sólo rellena full_name. Partes estructuradas prueban que
  // puede ser un apellido real y evitan clasificarlo por coincidencia de correo.
  if (
    cleanRequiredContactText(contactContext?.first_name, 120) ||
    cleanRequiredContactText(contactContext?.last_name, 120)
  ) {
    return false
  }

  const rawLocalPart = String(contactContext?.email || '').trim().split('@')[0]
  const normalizedLocalPart = normalizeSyntheticNameText(rawLocalPart)
  const rebillLocalPart = normalizeSyntheticNameText(
    rawLocalPart
      .replace(/\d+/g, ' ')
      .replace(/[._-]+/g, ' ')
  )
  const nameBeforeRistak = normalizeSyntheticNameText(
    nameParts.slice(0, -1).join(' ')
  )
  return Boolean(
    nameBeforeRistak &&
    (
      nameBeforeRistak === normalizedLocalPart ||
      nameBeforeRistak === rebillLocalPart
    )
  )
}

export function isPlaceholderConversationalContactName(
  value = '',
  contactContext = {}
) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
  if (!normalized) return true
  if (
    /[^\s@]+@[^\s@]+\.[^\s@]+/.test(normalized) ||
    /\b(?:https?:\/\/|www\.)\S+/i.test(normalized) ||
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:[/?#]\S*)?$/i.test(normalized)
  ) {
    return true
  }
  if (
    /^@[a-z0-9._-]+$/i.test(normalized) ||
    /^(?:whatsapp(?: api)?|instagram(?: dm)?|facebook(?: messenger)?|messenger)(?:\s+(?=[a-z0-9._:-]*\d)[a-z0-9][a-z0-9._:-]{3,})?$/i.test(normalized) ||
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(normalized) ||
    /^[a-f0-9]{16,64}$/i.test(normalized) ||
    /^(?:id|uid|user|usr|usuario|contact|contacto|lead|wa|waid|whatsapp|profile|customer|cliente|prospecto|ghl|cus)(?:[_:.-][a-z0-9_-]{2,}|\d{3,})$/i.test(normalized) ||
    /^rstk(?:[_:.-][a-z0-9_-]{2,})+$/i.test(normalized) ||
    /^(?:waapi|meta_social|manual|site)_contact(?:[_:.-][a-z0-9_-]{2,})+$/i.test(normalized) ||
    /^psid(?:\s+|[_:.-]+)[a-z0-9_-]{3,}$/i.test(normalized)
  ) {
    return true
  }
  if (
    isEmailDerivedRistakContactName(
      normalized,
      contactContext
    )
  ) {
    return true
  }
  if (isGenericWhatsAppApiContactLabel(normalized)) return true
  if (/^(contacto(?: (?:sin nombre|manual|ristak|de prueba))?|cliente(?: ristak)?|prospecto|lead(?: de site)?|user|usuario|guest|invitado(?: de google)?|anonymous|anonim[oa]|email|sin nombre|unknown|desconocid[oa]|null|undefined|n\/a)(\s+\d+)?$/.test(normalized)) {
    return true
  }
  if (/^(?:usuario(?: de)? (?:whatsapp|instagram|facebook|messenger)|(?:whatsapp|instagram|facebook|messenger) (?:user|usuario))$/.test(normalized)) {
    return true
  }
  if (
    /\p{Extended_Pictographic}/u.test(normalized) ||
    !/\p{L}/u.test(normalized)
  ) {
    return true
  }
  const phoneLike = normalized
    .replace(/(?:ext\.?|extension|x)\s*\d+$/i, '')
    .trim()
  return /\d/.test(phoneLike) && /^[+\d().\s-]+$/.test(phoneLike)
}

export function mergeConversationalRequiredContactData(
  contact = {},
  actionScoped = {}
) {
  const scoped = (
    actionScoped &&
    typeof actionScoped === 'object' &&
    !Array.isArray(actionScoped)
  )
    ? actionScoped
    : {}
  return {
    ...(contact || {}),
    ...scoped,
    custom_fields: serializeContactCustomFieldsForDb(
      mergeContactCustomFields(
        parseContactCustomFields(contact?.custom_fields),
        parseContactCustomFields(scoped.custom_fields)
      )
    )
  }
}

/**
 * Validador canónico de datos obligatorios. Toda decisión previa a ejecutar
 * una tool y todo fence final deben pasar por esta misma función; así un valor
 * nunca puede ser "faltante" para la tool y "completo" para la entrega.
 */
export function requiredConversationalContactFieldValue(
  contact = {},
  requirement = {}
) {
  const field = String(requirement?.field || '').trim()
  const fullName = cleanRequiredContactText(contact.full_name, 240)
  if (field === 'first_name') {
    const storedFirstName = cleanRequiredContactText(contact.first_name, 120)
    const fullNameIsValid = Boolean(
      fullName && !isPlaceholderConversationalContactName(fullName, contact)
    )
    const derivedFirstName = fullNameIsValid
      ? cleanRequiredContactText(fullName.split(/\s+/)[0], 120)
      : ''
    if (
      storedFirstName &&
      !isPlaceholderConversationalContactName(storedFirstName)
    ) {
      return storedFirstName
    }
    return (
      derivedFirstName &&
      !isPlaceholderConversationalContactName(derivedFirstName)
    )
      ? derivedFirstName
      : ''
  }
  if (field === 'full_name') {
    return (
      fullName &&
      !isPlaceholderConversationalContactName(fullName, contact) &&
      fullName.split(/\s+/).filter(Boolean).length >= 2
    )
      ? fullName
      : ''
  }
  if (field === 'phone' || field === 'alternate_phone') {
    let rawPhone = contact.phone || ''
    if (field === 'alternate_phone') {
      const customFields = parseContactCustomFields(contact.custom_fields)
      const match = customFields.find((item) => (
        [
          item.key,
          item.fieldKey,
          item.id,
          item.label,
          item.name
        ]
          .map(normalizeRequiredContactDataKey)
          .includes('alternate_phone')
      ))
      rawPhone = match?.value || ''
    }
    const phone = normalizePhoneForStorage(rawPhone)
    const digits = phone.replace(/\D/g, '')
    return digits.length >= 7 && digits.length <= 15 ? phone : ''
  }
  if (field === 'email') {
    const email = cleanRequiredContactText(contact.email, 240).toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
  }

  const customFields = parseContactCustomFields(contact.custom_fields)
  const expectedKeys = field === 'address'
    ? ['address', 'address_1']
    : field === 'custom'
      ? [requirement.label]
      : [field]
  const expected = new Set(
    expectedKeys.map(normalizeRequiredContactDataKey).filter(Boolean)
  )
  const match = customFields.find((item) => {
    const identities = [
      item.key,
      item.fieldKey,
      item.id,
      item.label,
      item.name
    ]
      .map(normalizeRequiredContactDataKey)
      .filter(Boolean)
    return (
      identities.some((identity) => expected.has(identity)) &&
      cleanRequiredContactText(item.value, 1000)
    )
  })
  return match ? cleanRequiredContactText(match.value, 1000) : ''
}
