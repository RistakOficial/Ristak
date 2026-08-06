function cleanString(value) {
  return String(value ?? '').trim()
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function joinReadableLines(lines = []) {
  return lines.map(cleanString).filter(Boolean).join('\n')
}

function formatContactName(contact = {}) {
  const profile = isPlainObject(contact.profile) ? contact.profile : {}
  const explicitName = cleanString(
    profile.formatted_name ||
    profile.formattedName ||
    profile.name ||
    contact.name
  )
  if (explicitName) return explicitName

  return [profile.first_name, profile.middle_name, profile.last_name]
    .map(cleanString)
    .filter(Boolean)
    .join(' ')
}

function formatContactPhones(contact = {}) {
  const phones = Array.isArray(contact.phones) ? contact.phones : []
  return [...new Set(phones
    .map(phone => cleanString(phone?.phone || phone?.wa_id || phone?.waId || phone))
    .filter(Boolean))]
}

function formatSharedContacts(contacts = []) {
  if (!Array.isArray(contacts) || contacts.length === 0) return ''

  return joinReadableLines(contacts.map(contact => {
    const name = formatContactName(contact) || 'Sin nombre'
    const phones = formatContactPhones(contact)
    return `Contacto compartido: ${name}${phones.length > 0 ? ` · ${phones.join(', ')}` : ''}`
  }))
}

function formatSharedOrder(order = {}) {
  if (!isPlainObject(order)) return ''
  const text = cleanString(order.text || order.body)
  const products = Array.isArray(order.product_items)
    ? order.product_items
    : (Array.isArray(order.productItems) ? order.productItems : [])
  const itemCount = products.reduce((total, product) => {
    const quantity = Number(product?.quantity)
    return total + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1)
  }, 0)
  const summary = itemCount === 1 ? 'Pedido compartido · 1 producto' : `Pedido compartido · ${itemCount} productos`
  return joinReadableLines([text, itemCount > 0 ? summary : 'Pedido compartido'])
}

function extractSimpleMessageText(message = {}, depth = 0) {
  if (!isPlainObject(message) || depth > 2) return ''

  const directText = cleanString(
    message.text?.body ||
    message.button?.text ||
    message.interactive?.button_reply?.title ||
    message.interactive?.list_reply?.title ||
    message.interactive?.nfm_reply?.body ||
    message.image?.caption ||
    message.video?.caption ||
    message.document?.caption ||
    message.location?.name ||
    message.location?.address ||
    message.system?.body ||
    message.system?.text
  )
  if (directText) return directText

  const contactsText = formatSharedContacts(message.contacts)
  if (contactsText) return contactsText

  const orderText = formatSharedOrder(message.order)
  if (orderText) return orderText

  const editedMessage = message.edit?.message || message.edited_message || message.editedMessage
  if (isPlainObject(editedMessage)) return extractSimpleMessageText(editedMessage, depth + 1)

  return ''
}

/**
 * Extracts formats that the main WhatsApp parser historically did not cover.
 * Kept pure so it can also repair the visible text of already stored payloads.
 */
export function extractSupplementalWhatsAppMessageText(message = {}) {
  if (!isPlainObject(message)) return ''
  const type = cleanString(message.type).toLowerCase()

  if (type === 'contacts' || type === 'contact' || Array.isArray(message.contacts)) {
    return formatSharedContacts(message.contacts)
  }
  if (type === 'order' || isPlainObject(message.order)) {
    return formatSharedOrder(message.order)
  }
  if (type === 'system' || isPlainObject(message.system)) {
    return cleanString(message.system?.body || message.system?.text) || 'Actualización del sistema de WhatsApp'
  }
  if (type === 'edit' || isPlainObject(message.edit) || isPlainObject(message.edited_message) || isPlainObject(message.editedMessage)) {
    const editedMessage = message.edit?.message || message.edited_message || message.editedMessage
    return extractSimpleMessageText(editedMessage)
  }

  return ''
}

export function isWhatsAppProviderContentUnavailable({ messageType, errorCode, errorMessage } = {}) {
  const type = cleanString(messageType).toLowerCase()
  const code = cleanString(errorCode)
  const reason = cleanString(errorMessage).toLowerCase()

  if (['131051', '131060'].includes(code)) return true
  if (['unsupported', 'unknown', 'unavailable'].includes(type)) return true
  return /message type.*not supported|message is unavailable|message type unknown|currently not supported/.test(reason)
}

export function shouldTriggerWhatsAppInboundSideEffects({ messageType, contentUnavailable } = {}) {
  const type = cleanString(messageType).toLowerCase()
  if (contentUnavailable === true) return false
  return !['edit', 'status', 'system'].includes(type)
}
