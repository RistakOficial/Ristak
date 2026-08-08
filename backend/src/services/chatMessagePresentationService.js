const PRESENTATION_KINDS = new Set([
  'template',
  'interactive',
  'interactive_reply',
  'contacts',
  'order',
  'product',
  'poll',
  'event',
  'payment',
  'system',
  'unsupported'
])
const HEADER_KINDS = new Set(['text', 'image', 'video', 'document', 'location'])
const ITEM_KINDS = new Set(['contact', 'phone', 'email', 'address', 'product', 'option', 'amount', 'calendar', 'link', 'info'])

function cleanString(value, maxLength = 50_000) {
  if (value === null || value === undefined) return ''
  if (!['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return ''
  return String(value).trim().slice(0, maxLength)
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseJsonObject(value) {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function firstString(...values) {
  for (const value of values) {
    const clean = cleanString(value)
    if (clean) return clean
  }
  return ''
}

function firstObject(...values) {
  return values.find(isPlainObject) || {}
}

function titleFromKey(value) {
  const clean = cleanString(value, 120)
    .replace(/[_-]+/g, ' ')
    .replace(/([a-záéíóúñ])([A-ZÁÉÍÓÚÑ])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : ''
}

function normalizeItem(kind, label, value = '') {
  const cleanLabel = cleanString(label, 500)
  const cleanValue = cleanString(value, 2_000)
  if (!cleanLabel && !cleanValue) return null
  return {
    kind: ITEM_KINDS.has(kind) ? kind : 'info',
    label: cleanLabel || cleanValue,
    ...(cleanLabel && cleanValue && cleanValue !== cleanLabel ? { value: cleanValue } : {})
  }
}

function normalizeSection(title, items) {
  const cleanTitle = cleanString(title, 240)
  const cleanItems = asArray(items).filter(Boolean).slice(0, 30)
  if (!cleanItems.length) return null
  return {
    ...(cleanTitle ? { title: cleanTitle } : {}),
    items: cleanItems
  }
}

function unwrapBaileysContent(value, depth = 0) {
  if (!isPlainObject(value) || depth > 5) return {}
  const wrapper = value.ephemeralMessage?.message ||
    value.viewOnceMessage?.message ||
    value.viewOnceMessageV2?.message ||
    value.viewOnceMessageV2Extension?.message ||
    value.documentWithCaptionMessage?.message ||
    value.editedMessage?.message
  return isPlainObject(wrapper) ? unwrapBaileysContent(wrapper, depth + 1) : value
}

function getQrContent(rawMessage) {
  return unwrapBaileysContent(firstObject(
    rawMessage?.qrRaw?.message,
    rawMessage?.raw?.message,
    rawMessage?.message
  ))
}

function parseVcardLines(vcard, field) {
  const expression = new RegExp(`(?:^|\\r?\\n)${field}(?:;[^:]*)?:(.+)(?:\\r?\\n|$)`, 'gi')
  return [...cleanString(vcard).matchAll(expression)]
    .map(match => cleanString(match[1], 500))
    .filter(Boolean)
}

function contactDisplayName(contact) {
  const name = firstObject(contact?.name)
  const profile = firstObject(contact?.profile)
  const explicit = cleanString(
    name.formatted_name || name.formattedName ||
    profile.formatted_name || profile.formattedName || profile.name ||
    contact?.displayName || contact?.display_name || contact?.name,
    300
  )
  if (explicit) return explicit
  const composed = [
    name.first_name || name.firstName || profile.first_name || profile.firstName,
    name.middle_name || name.middleName || profile.middle_name || profile.middleName,
    name.last_name || name.lastName || profile.last_name || profile.lastName
  ].map(value => cleanString(value, 100)).filter(Boolean).join(' ')
  return composed || parseVcardLines(contact?.vcard, 'FN')[0] || 'Contacto sin nombre'
}

function uniqueStrings(values) {
  return [...new Set(values.map(value => cleanString(value, 500)).filter(Boolean))]
}

function uniquePhones(values) {
  const seen = new Set()
  return values
    .map(value => cleanString(value, 500))
    .filter(value => {
      if (!value) return false
      const identity = value.replace(/\D/g, '') || value.toLowerCase()
      if (seen.has(identity)) return false
      seen.add(identity)
      return true
    })
}

function formatExternalAmount(value, currency, divisor = 1) {
  const numeric = Number(value)
  const code = cleanString(currency, 10).toUpperCase()
  if (!Number.isFinite(numeric)) return ''
  const amount = numeric / divisor
  // El proveedor manda dinero externo: sin código ISO explícito no debemos
  // inventar la moneda de la cuenta, del navegador ni del país.
  if (!/^[A-Z]{3}$/.test(code)) return ''
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency: code }).format(amount)
  } catch {
    return `${amount} ${code}`
  }
}

function componentType(component) {
  return cleanString(component?.type, 40).toLowerCase()
}

function findComponent(components, type) {
  const target = cleanString(type, 40).toLowerCase()
  return asArray(components).find(component => componentType(component) === target)
}

function getParameterText(parameter) {
  if (!isPlainObject(parameter)) return cleanString(parameter)
  return firstString(
    parameter.text,
    parameter.payload,
    parameter.value,
    parameter.code,
    parameter.couponCode,
    parameter.coupon_code
  )
}

function getComponentParameterValues(components, type) {
  return asArray(findComponent(components, type)?.parameters).map(getParameterText)
}

function renderIndexedVariables(text, values = []) {
  return cleanString(text).replace(/\{\{\s*(\d+)\s*\}\}/g, (match, rawIndex) => {
    const value = values[Number(rawIndex) - 1]
    return value === undefined || value === null || value === '' ? match : cleanString(value)
  })
}

function getMediaParameter(parameter, headerKind) {
  if (!isPlainObject(parameter)) return null
  const media = parameter[headerKind]
  if (!isPlainObject(media)) return null
  const url = cleanString(media.link || media.url, 4096)
  if (!/^https?:\/\//i.test(url)) return null
  const fileName = cleanString(media.filename || media.file_name, 500)
  return {
    mediaUrl: url,
    ...(fileName ? { fileName } : {})
  }
}

function normalizeHeaderKind(value) {
  const kind = cleanString(value, 40).toLowerCase()
  return HEADER_KINDS.has(kind) ? kind : 'text'
}

function buildTemplateHeader(sourceComponents, requestComponents) {
  const sourceHeader = findComponent(sourceComponents, 'header')
  if (!sourceHeader) return undefined

  const kind = normalizeHeaderKind(sourceHeader.format || sourceHeader.type)
  if (kind === 'text') {
    const text = renderIndexedVariables(
      sourceHeader.text,
      getComponentParameterValues(requestComponents, 'header')
    )
    return text ? { kind, text } : undefined
  }

  const requestHeader = findComponent(requestComponents, 'header')
  const media = asArray(requestHeader?.parameters)
    .map(parameter => getMediaParameter(parameter, kind))
    .find(Boolean)

  return {
    kind,
    ...(media || {})
  }
}

function normalizeButtonType(value) {
  const type = cleanString(value, 40).toLowerCase()
  if (type === 'quick_reply' || type === 'reply' || type === 'button') return 'quick_reply'
  if (type === 'url' || type === 'website' || type === 'cta_url') return 'url'
  if (type === 'phone_number' || type === 'phone' || type === 'call') return 'phone'
  if (type === 'copy_code' || type === 'copy') return 'copy_code'
  if (type === 'voice_call' || type === 'whatsapp_call') return 'voice_call'
  if (type === 'flow' || type === 'cta_flow') return 'flow'
  if (type === 'catalog' || type === 'catalog_message') return 'catalog'
  if (type === 'payment' || type === 'payment_info') return 'payment'
  if (type === 'otp' || type === 'one_tap') return 'otp'
  return 'unknown'
}

function getButtonLabel(button) {
  const params = parseJsonObject(
    button?.paramsJson ??
    button?.buttonParamsJson ??
    button?.button_params_json
  )
  return firstString(
    button?.text,
    button?.title,
    button?.label,
    button?.displayText,
    button?.display_text,
    button?.reply?.title,
    button?.reply?.text,
    params.display_text,
    params.displayText,
    params.cta_display_name,
    params.title,
    params.text
  ).slice(0, 120)
}

function normalizeButtons(buttons) {
  return asArray(buttons)
    .map(button => {
      const label = getButtonLabel(button)
      if (!label) return null
      return {
        type: normalizeButtonType(
          button?.type ??
          button?.sub_type ??
          button?.name ??
          button?.reply?.type
        ),
        label
      }
    })
    .filter(Boolean)
    .slice(0, 10)
}

function stripFlattenedButtonLabels(text, buttons) {
  let result = cleanString(text)
  const labels = asArray(buttons).map(button => cleanString(button?.label)).filter(Boolean)
  if (!result || !labels.length) return result

  const actionBlock = labels.map(label => `- ${label}`).join('\n')
  if (result.endsWith(`\n\n${actionBlock}`)) {
    result = result.slice(0, -(actionBlock.length + 2)).trim()
  }
  return result
}

function buildTemplatePresentation({ rawMessage, templateSend, messageText }) {
  const requestTemplate = parseJsonObject(
    templateSend?.request?.template || rawMessage?.template
  )
  const snapshotTemplate = parseJsonObject(templateSend?.template)
  const sourceComponents = asArray(snapshotTemplate.components).length
    ? asArray(snapshotTemplate.components)
    : asArray(requestTemplate.components).filter(component => (
        Boolean(cleanString(component?.text)) || componentType(component) === 'buttons'
      ))
  const requestComponents = asArray(requestTemplate.components)
  const fallbackVariables = asArray(templateSend?.variables).map(getParameterText)
  const sourceBody = findComponent(sourceComponents, 'body')
  const sourceFooter = findComponent(sourceComponents, 'footer')
  const sourceButtons = findComponent(sourceComponents, 'buttons')
  const buttons = normalizeButtons(sourceButtons?.buttons)
  const bodyValues = getComponentParameterValues(requestComponents, 'body')
  const body = sourceBody?.text
    ? renderIndexedVariables(sourceBody.text, bodyValues.length ? bodyValues : fallbackVariables)
    : stripFlattenedButtonLabels(messageText || snapshotTemplate.renderedText, buttons)
  const footer = renderIndexedVariables(sourceFooter?.text, [])
  const header = buildTemplateHeader(sourceComponents, requestComponents)

  if (!body && !footer && !header && !buttons.length) return null
  return {
    kind: 'template',
    ...(header ? { header } : {}),
    body,
    ...(footer ? { footer } : {}),
    buttons
  }
}

function readInteractiveText(value, keys = []) {
  if (!isPlainObject(value)) return ''
  for (const key of keys) {
    const text = cleanString(value[key])
    if (text) return text
  }
  return ''
}

function buildInteractiveHeader(interactive) {
  const header = parseJsonObject(interactive?.header)
  if (!Object.keys(header).length) return undefined
  const kind = normalizeHeaderKind(header.type || header.format)
  const text = readInteractiveText(header, ['text', 'title', 'subtitle'])
  const media = getMediaParameter(header, kind) || getMediaParameter({ [kind]: header }, kind)
  return {
    kind,
    ...(text ? { text } : {}),
    ...(media || {})
  }
}

function buildInteractivePresentation(rawMessage) {
  const qrContent = getQrContent(rawMessage)
  const interactive = firstObject(
    rawMessage?.interactive,
    qrContent.interactiveMessage,
    qrContent.buttonsMessage,
    qrContent.listMessage,
    qrContent.templateMessage?.hydratedTemplate
  )
  if (!Object.keys(interactive).length) return null
  const buttons = normalizeButtons([
    ...asArray(interactive.action?.buttons),
    ...asArray(interactive.nativeFlowMessage?.buttons),
    ...asArray(interactive.buttons),
    ...asArray(interactive.hydratedButtons),
    ...(interactive.action?.button ? [{ type: 'button', text: interactive.action.button }] : [])
  ])
  const body = readInteractiveText(interactive.body, ['text', 'body']) || firstString(
    interactive.contentText,
    interactive.description,
    interactive.text
  )
  const footer = readInteractiveText(interactive.footer, ['text', 'footer']) || firstString(interactive.footerText)
  const header = buildInteractiveHeader(interactive)
  const rawSections = [
    ...asArray(interactive.action?.sections),
    ...asArray(interactive.sections)
  ]
  const sections = rawSections.map(section => normalizeSection(
    section?.title,
    [
      ...asArray(section?.rows).map(row => normalizeItem('option', firstString(row?.title, row?.name), row?.description)),
      ...asArray(section?.product_items || section?.productItems).map((product, index) => normalizeItem(
        'product',
        firstString(product?.title, product?.name, product?.product_retailer_id, product?.productRetailerId, `Producto ${index + 1}`),
        product?.description
      ))
    ]
  )).filter(Boolean).slice(0, 10)

  if (!body && !footer && !header && !buttons.length && !sections.length) return null
  return {
    kind: 'interactive',
    ...(header ? { header } : {}),
    body,
    ...(footer ? { footer } : {}),
    buttons,
    ...(sections.length ? { sections } : {})
  }
}

function buildContactsPresentation(rawMessage, normalizedType) {
  const qrContent = getQrContent(rawMessage)
  const qrContacts = [
    ...(qrContent.contactMessage ? [qrContent.contactMessage] : []),
    ...asArray(qrContent.contactsArrayMessage?.contacts)
  ]
  const contacts = asArray(rawMessage?.contacts).length ? asArray(rawMessage.contacts) : qrContacts
  if (!contacts.length && !['contact', 'contacts'].includes(normalizedType)) return null

  const sections = contacts.map(contact => {
    const phones = uniquePhones([
      ...asArray(contact?.phones).flatMap(phone => [phone?.phone, phone?.wa_id, phone?.waId, phone]),
      contact?.phone,
      contact?.wa_id,
      contact?.waId,
      ...parseVcardLines(contact?.vcard, 'TEL')
    ])
    const emails = uniqueStrings([
      ...asArray(contact?.emails).flatMap(email => [email?.email, email]),
      ...parseVcardLines(contact?.vcard, 'EMAIL')
    ])
    const addresses = uniqueStrings([
      ...asArray(contact?.addresses).flatMap(address => [
        address?.formatted_address,
        address?.formattedAddress,
        address?.street,
        address?.city
      ]),
      ...parseVcardLines(contact?.vcard, 'ADR')
    ])
    const organizations = uniqueStrings(asArray(contact?.org).flatMap(org => [org?.company, org?.department, org?.title]))
    return normalizeSection(contactDisplayName(contact), [
      ...phones.map(phone => normalizeItem('phone', phone)),
      ...emails.map(email => normalizeItem('email', email)),
      ...addresses.map(address => normalizeItem('address', address)),
      ...organizations.map(org => normalizeItem('info', org))
    ]) || normalizeSection(contactDisplayName(contact), [normalizeItem('contact', 'Tarjeta de contacto')])
  }).filter(Boolean).slice(0, 20)

  if (!sections.length) return null
  return {
    kind: 'contacts',
    header: { kind: 'text', text: contacts.length === 1 ? 'Contacto compartido' : `${contacts.length} contactos compartidos` },
    body: '',
    buttons: [],
    sections
  }
}

function buildOrderPresentation(rawMessage, normalizedType) {
  const qrOrder = getQrContent(rawMessage).orderMessage
  const order = firstObject(rawMessage?.order, qrOrder)
  if (!Object.keys(order).length && normalizedType !== 'order') return null
  const currency = firstString(order.currency, order.totalCurrencyCode, order.currencyCode)
  const products = asArray(order.product_items).length
    ? asArray(order.product_items)
    : asArray(order.productItems)
  const items = products.map((product, index) => {
    const quantity = Number(product?.quantity)
    const count = Number.isFinite(quantity) && quantity > 0 ? quantity : 1
    const amount = formatExternalAmount(product?.item_price ?? product?.itemPrice, product?.currency || currency)
    const value = [count > 1 ? `${count} piezas` : '', amount].filter(Boolean).join(' · ')
    return normalizeItem(
      'product',
      firstString(product?.name, product?.title, product?.product_retailer_id, product?.productRetailerId, `Producto ${index + 1}`),
      value
    )
  })
  const qrCount = Number(order.itemCount)
  if (!items.length && Number.isFinite(qrCount) && qrCount > 0) {
    items.push(normalizeItem('product', qrCount === 1 ? '1 producto' : `${qrCount} productos`))
  }
  const total = formatExternalAmount(order.totalAmount1000, currency, 1000) ||
    formatExternalAmount(order.total_amount, currency) ||
    formatExternalAmount(order.total, currency)
  if (total) items.push(normalizeItem('amount', 'Total', total))
  const sections = [normalizeSection('Detalle del pedido', items)].filter(Boolean)
  return {
    kind: 'order',
    header: { kind: 'text', text: firstString(order.orderTitle, order.title, 'Pedido compartido') },
    body: firstString(order.text, order.body, order.message),
    buttons: [],
    ...(sections.length ? { sections } : {})
  }
}

function flattenSafeResponseFields(value, prefix = '', depth = 0) {
  if (!isPlainObject(value) || depth > 2) return []
  const items = []
  for (const [key, rawValue] of Object.entries(value)) {
    if (/token|signature|nonce|screen|version|(^|_)id$/i.test(key)) continue
    const label = [prefix, titleFromKey(key)].filter(Boolean).join(' · ')
    if (isPlainObject(rawValue)) {
      items.push(...flattenSafeResponseFields(rawValue, label, depth + 1))
      continue
    }
    const visibleValue = Array.isArray(rawValue)
      ? rawValue.map(entry => cleanString(entry, 300)).filter(Boolean).join(', ')
      : cleanString(rawValue, 1_000)
    if (visibleValue) items.push(normalizeItem('info', label, visibleValue))
  }
  return items.filter(Boolean).slice(0, 20)
}

function buildInteractiveReplyPresentation(rawMessage, normalizedType) {
  const qrContent = getQrContent(rawMessage)
  const interactive = firstObject(rawMessage?.interactive)
  const button = firstObject(rawMessage?.button)
  const reply = firstObject(
    interactive.button_reply,
    interactive.list_reply,
    interactive.nfm_reply,
    qrContent.templateButtonReplyMessage,
    qrContent.buttonsResponseMessage,
    qrContent.listResponseMessage,
    qrContent.interactiveResponseMessage
  )
  if (!Object.keys(reply).length && !Object.keys(button).length && !['button', 'button_reply', 'list_reply', 'interactive_reply'].includes(normalizedType)) {
    return null
  }
  const nfmResponse = parseJsonObject(reply.response_json || reply.responseJson || reply.nativeFlowResponseMessage?.paramsJson)
  const responseItems = flattenSafeResponseFields(nfmResponse)
  const isList = Boolean(interactive.list_reply || qrContent.listResponseMessage)
  const isFlow = Boolean(interactive.nfm_reply || qrContent.interactiveResponseMessage)
  return {
    kind: 'interactive_reply',
    header: {
      kind: 'text',
      text: isFlow ? 'Formulario enviado' : isList ? 'Opción seleccionada' : 'Respuesta de botón'
    },
    body: firstString(
      reply.title,
      reply.body,
      reply.selectedDisplayText,
      reply.selected_display_text,
      button.text,
      button.title
    ),
    footer: firstString(reply.description),
    buttons: [],
    ...(responseItems.length ? { sections: [normalizeSection('Respuestas', responseItems)] } : {})
  }
}

function buildPollPresentation(rawMessage, normalizedType) {
  const qrContent = getQrContent(rawMessage)
  const poll = firstObject(
    rawMessage?.poll,
    qrContent.pollCreationMessage,
    qrContent.pollCreationMessageV2,
    qrContent.pollCreationMessageV3,
    qrContent.pollCreationMessageV4,
    qrContent.pollResultSnapshotMessage
  )
  if (!Object.keys(poll).length && !normalizedType.includes('poll')) return null
  const options = asArray(poll.options).map((option, index) => normalizeItem(
    'option',
    firstString(option?.optionName, option?.name, option?.title, `Opción ${index + 1}`)
  ))
  const results = asArray(poll.pollVotes).map((vote, index) => normalizeItem(
    'option',
    firstString(vote?.optionName, `Opción ${index + 1}`),
    vote?.optionVoteCount === undefined ? '' : `${vote.optionVoteCount} votos`
  ))
  const items = results.length ? results : options
  return {
    kind: 'poll',
    header: { kind: 'text', text: results.length ? 'Resultados de encuesta' : 'Encuesta' },
    body: firstString(poll.name, poll.question, poll.title),
    buttons: [],
    ...(items.length ? { sections: [normalizeSection('Opciones', items)] } : {})
  }
}

function buildProductPresentation(rawMessage, normalizedType) {
  const qrContent = getQrContent(rawMessage)
  const productMessage = firstObject(rawMessage?.product, qrContent.productMessage)
  const product = firstObject(productMessage.product, productMessage.productSnapshot, productMessage)
  if (!Object.keys(product).length && normalizedType !== 'product') return null
  const currency = firstString(product.currencyCode, product.currency)
  const price = formatExternalAmount(product.priceAmount1000, currency, 1000) || formatExternalAmount(product.price, currency)
  const details = [
    price ? normalizeItem('amount', 'Precio', price) : null,
    normalizeItem('info', firstString(product.retailerId, product.productRetailerId, product.product_retailer_id))
  ].filter(Boolean)
  return {
    kind: 'product',
    header: { kind: 'text', text: 'Producto compartido' },
    body: firstString(product.title, product.name, productMessage.body?.text, productMessage.body),
    footer: firstString(product.description, productMessage.footer?.text, productMessage.footer),
    buttons: [],
    ...(details.length ? { sections: [normalizeSection('Producto', details)] } : {})
  }
}

function buildEventPresentation(rawMessage, normalizedType) {
  const qrContent = getQrContent(rawMessage)
  const event = firstObject(rawMessage?.event, qrContent.eventMessage, qrContent.scheduledCallCreationMessage)
  if (!Object.keys(event).length && normalizedType !== 'event') return null
  const location = firstObject(event.location)
  const items = [
    normalizeItem('address', firstString(location.name, location.address)),
    normalizeItem('link', firstString(event.joinLink, event.join_link))
  ].filter(Boolean)
  return {
    kind: 'event',
    header: { kind: 'text', text: 'Evento compartido' },
    body: firstString(event.name, event.title),
    footer: firstString(event.description),
    buttons: [],
    ...(items.length ? { sections: [normalizeSection('Detalles', items)] } : {})
  }
}

function buildPaymentPresentation(rawMessage, normalizedType) {
  const qrContent = getQrContent(rawMessage)
  const payment = firstObject(
    rawMessage?.payment,
    qrContent.requestPaymentMessage,
    qrContent.sendPaymentMessage,
    qrContent.paymentInviteMessage
  )
  if (!Object.keys(payment).length && !normalizedType.includes('payment')) return null
  const amount = formatExternalAmount(
    payment.amount1000 ?? payment.amount,
    payment.currencyCodeIso4217 || payment.currencyCode || payment.currency,
    payment.amount1000 !== undefined ? 1000 : 1
  )
  return {
    kind: 'payment',
    header: { kind: 'text', text: normalizedType.includes('request') ? 'Solicitud de pago' : 'Pago compartido' },
    body: firstString(payment.note, payment.description, payment.memo),
    buttons: [],
    ...(amount ? { sections: [normalizeSection('Importe', [normalizeItem('amount', 'Total', amount)])] } : {})
  }
}

function buildSystemPresentation(rawMessage, normalizedType, messageText) {
  const supportedSystemTypes = ['system', 'unsupported', 'unknown', 'unavailable', 'group_invite', 'contact_request', 'sticker_pack']
  if (!supportedSystemTypes.includes(normalizedType)) return null
  const unavailable = ['unsupported', 'unknown', 'unavailable'].includes(normalizedType)
  const labels = {
    group_invite: 'Invitación a grupo',
    contact_request: 'Solicitud de contacto',
    sticker_pack: 'Paquete de stickers'
  }
  const buttons = normalizedType === 'contact_request'
    ? [{ type: 'phone', label: 'Compartir número de teléfono' }]
    : []
  return {
    kind: unavailable ? 'unsupported' : 'system',
    header: { kind: 'text', text: unavailable ? 'Mensaje no compatible' : (labels[normalizedType] || 'Aviso de WhatsApp') },
    body: firstString(rawMessage?.system?.body, rawMessage?.system?.text, messageText),
    buttons
  }
}

export function buildWhatsAppMessagePresentation({
  messageRawPayload,
  templateSendRawPayload,
  messageText = '',
  messageType = ''
} = {}) {
  const rawMessage = parseJsonObject(messageRawPayload)
  const templateSend = parseJsonObject(templateSendRawPayload)
  const normalizedType = cleanString(messageType, 40).toLowerCase()

  const semanticBuilders = [
    buildContactsPresentation,
    buildOrderPresentation,
    buildInteractiveReplyPresentation,
    buildPollPresentation,
    buildProductPresentation,
    buildEventPresentation,
    buildPaymentPresentation
  ]
  for (const builder of semanticBuilders) {
    const presentation = builder(rawMessage, normalizedType)
    if (presentation && PRESENTATION_KINDS.has(presentation.kind)) return presentation
  }

  const interactive = buildInteractivePresentation(rawMessage)
  if (interactive) return interactive

  const hasTemplateEvidence = normalizedType === 'template' ||
    Object.keys(parseJsonObject(rawMessage.template)).length > 0 ||
    Object.keys(parseJsonObject(templateSend.template)).length > 0
  if (!hasTemplateEvidence) return buildSystemPresentation(rawMessage, normalizedType, messageText)

  const presentation = buildTemplatePresentation({ rawMessage, templateSend, messageText })
  return presentation && PRESENTATION_KINDS.has(presentation.kind) ? presentation : null
}
