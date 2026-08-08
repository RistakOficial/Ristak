function cleanString(value) {
  if (value === null || value === undefined) return ''
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return ''
  return String(value).trim()
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function joinReadableLines(lines = []) {
  return lines.map(cleanString).filter(Boolean).join('\n')
}

function formatContactName(contact = {}) {
  const profile = isPlainObject(contact.profile) ? contact.profile : {}
  const name = isPlainObject(contact.name) ? contact.name : {}
  const explicitName = cleanString(
    profile.formatted_name ||
    profile.formattedName ||
    profile.name ||
    name.formatted_name ||
    name.formattedName ||
    contact.displayName ||
    contact.display_name ||
    contact.name
  )
  if (explicitName) return explicitName

  const composedName = [
    profile.first_name || name.first_name || name.firstName,
    profile.middle_name || name.middle_name || name.middleName,
    profile.last_name || name.last_name || name.lastName
  ]
    .map(cleanString)
    .filter(Boolean)
    .join(' ')
  if (composedName) return composedName

  return cleanString(contact.vcard).match(/(?:^|\r?\n)FN(?:;[^:]*)?:(.+)(?:\r?\n|$)/i)?.[1]?.trim() || ''
}

function formatContactPhones(contact = {}) {
  const phones = Array.isArray(contact.phones) ? contact.phones : []
  const vcardPhones = [...cleanString(contact.vcard).matchAll(/(?:^|\r?\n)TEL(?:;[^:]*)?:(.+)(?:\r?\n|$)/gi)]
    .map(match => cleanString(match[1]))
  const seen = new Set()
  return [
    ...phones,
    contact.phone,
    contact.wa_id,
    contact.waId,
    ...vcardPhones
  ]
    .map(phone => cleanString(phone?.phone || phone?.wa_id || phone?.waId || phone))
    .filter(phone => {
      if (!phone) return false
      const identity = phone.replace(/\D/g, '') || phone.toLowerCase()
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
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

function formatPoll(poll = {}) {
  if (!isPlainObject(poll)) return ''
  const name = cleanString(poll.name || poll.question || poll.title)
  return name ? `Encuesta: ${name}` : 'Encuesta compartida'
}

function formatProduct(product = {}) {
  if (!isPlainObject(product)) return ''
  const snapshot = isPlainObject(product.productImage) ? product : (product.product || product.productSnapshot || product)
  const name = cleanString(snapshot.name || snapshot.title || snapshot.productName)
  return name ? `Producto compartido: ${name}` : 'Producto compartido'
}

function formatEvent(event = {}) {
  if (!isPlainObject(event)) return ''
  const name = cleanString(event.name || event.title)
  return name ? `Evento compartido: ${name}` : 'Evento compartido'
}

function formatPayment(payment = {}) {
  if (!isPlainObject(payment)) return ''
  const note = cleanString(payment.note || payment.description || payment.memo)
  return note ? `Solicitud de pago: ${note}` : 'Solicitud de pago'
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

  const pollText = formatPoll(message.poll || message.pollCreationMessage || message.pollResultSnapshotMessage)
  if (pollText) return pollText

  const productText = formatProduct(message.product || message.productMessage)
  if (productText) return productText

  const eventText = formatEvent(message.event || message.eventMessage)
  if (eventText) return eventText

  const paymentText = formatPayment(message.payment || message.requestPaymentMessage)
  if (paymentText) return paymentText

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
  if (type.includes('poll') || isPlainObject(message.poll)) {
    return formatPoll(message.poll || message.pollCreationMessage || message.pollResultSnapshotMessage)
  }
  if (type === 'product' || isPlainObject(message.product)) {
    return formatProduct(message.product || message.productMessage)
  }
  if (type === 'event' || isPlainObject(message.event)) {
    return formatEvent(message.event || message.eventMessage)
  }
  if (type.includes('payment') || isPlainObject(message.payment)) {
    return formatPayment(message.payment || message.requestPaymentMessage)
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
