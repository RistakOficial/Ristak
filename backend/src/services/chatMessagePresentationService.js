const PRESENTATION_KINDS = new Set(['template', 'interactive'])
const HEADER_KINDS = new Set(['text', 'image', 'video', 'document', 'location'])

function cleanString(value, maxLength = 50_000) {
  if (value === null || value === undefined) return ''
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

function componentType(component) {
  return cleanString(component?.type, 40).toLowerCase()
}

function findComponent(components, type) {
  const target = cleanString(type, 40).toLowerCase()
  return asArray(components).find(component => componentType(component) === target)
}

function getParameterText(parameter) {
  if (!isPlainObject(parameter)) return cleanString(parameter)
  return cleanString(
    parameter.text ??
    parameter.payload ??
    parameter.value ??
    parameter.code ??
    parameter.couponCode ??
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
  return 'unknown'
}

function getButtonLabel(button) {
  const params = parseJsonObject(
    button?.paramsJson ??
    button?.buttonParamsJson ??
    button?.button_params_json
  )
  return cleanString(
    button?.text ??
    button?.title ??
    button?.label ??
    button?.displayText ??
    button?.display_text ??
    button?.reply?.title ??
    button?.reply?.text ??
    params.display_text ??
    params.displayText ??
    params.cta_display_name ??
    params.title ??
    params.text,
    120
  )
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
  const interactive = parseJsonObject(rawMessage?.interactive)
  if (!Object.keys(interactive).length) return null
  const buttons = normalizeButtons([
    ...asArray(interactive.action?.buttons),
    ...asArray(interactive.nativeFlowMessage?.buttons),
    ...(interactive.action?.button ? [{ type: 'button', text: interactive.action.button }] : [])
  ])
  const body = readInteractiveText(interactive.body, ['text', 'body'])
  const footer = readInteractiveText(interactive.footer, ['text', 'footer'])
  const header = buildInteractiveHeader(interactive)

  if (!body && !footer && !header && !buttons.length) return null
  return {
    kind: 'interactive',
    ...(header ? { header } : {}),
    body,
    ...(footer ? { footer } : {}),
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

  const interactive = buildInteractivePresentation(rawMessage)
  if (interactive) return interactive

  const hasTemplateEvidence = normalizedType === 'template' ||
    Object.keys(parseJsonObject(rawMessage.template)).length > 0 ||
    Object.keys(parseJsonObject(templateSend.template)).length > 0
  if (!hasTemplateEvidence) return null

  const presentation = buildTemplatePresentation({ rawMessage, templateSend, messageText })
  return presentation && PRESENTATION_KINDS.has(presentation.kind) ? presentation : null
}
