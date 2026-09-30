const BILLING_ERROR_CODES = new Set(['131042', 'BALANCE_INSUFFICIENT'])
const HTTP_ERROR_CODES = new Set(['400', '401', '403', '404', '408', '409', '413', '415', '422', '429', '500', '502', '503', '504'])
const LEGACY_EXPERIMENT_QR_REASON =
  'WhatsApp no entregó la plantilla porque el destinatario está incluido en el experimento 130472; Ristak la envió como texto por el respaldo QR.'

export const WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON =
  'Ristak envió el mensaje como texto por el respaldo QR. Meta no entregó la plantilla por el experimento 130472 del destinatario; este rechazo no depende del método de pago.'

function clean(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : ''
}

function first(...values) {
  return values.map(clean).find(Boolean) || ''
}

function parsePayload(value) {
  if (value && typeof value === 'object') return value
  try {
    return JSON.parse(value) || {}
  } catch {
    return {}
  }
}

/** Keep provider codes and actionable details separate from HTTP status. */
export function extractWhatsAppProviderError(value = {}) {
  const error = (Array.isArray(value?.errors) ? value.errors[0] : null) ||
    value?.error || value?.ycloud?.error || {}
  const metaError = value?.whatsappApiError || error?.whatsappApiError ||
    value?.ycloud?.error?.whatsappApiError || {}
  const baseMessage = first(value instanceof Error ? value.message : '',
    metaError.message, metaError.title, error.message, error.title,
    value?.errorMessage, value?.message, value?.graphMessage, value)
  const details = first(metaError.error_data?.details, metaError.error_data?.message,
    error.error_data?.details, error.error_data?.message, value?.graphDetails)
  const embeddedCode = baseMessage.match(/\(#(\d+)\)/)?.[1] ||
    baseMessage.match(/^(13\d{4})\b/)?.[1] || ''
  const providerCode = first(metaError.code, value?.graphCode, error.code, value?.errorCode, value?.code)
  const code = embeddedCode && (!providerCode || HTTP_ERROR_CODES.has(providerCode))
    ? embeddedCode
    : first(providerCode, embeddedCode, value?.statusCode)
  const message = details && !baseMessage.toLowerCase().includes(details.toLowerCase())
    ? [baseMessage, details].filter(Boolean).join(': ')
    : baseMessage
  return { code, message, details }
}

export function isWhatsAppBillingError(value) {
  return BILLING_ERROR_CODES.has(extractWhatsAppProviderError(value).code)
}

export function formatWhatsAppProviderError(value) {
  const { code, message } = extractWhatsAppProviderError(value)
  if (code === '131042') {
    const missingPaymentMethod = /no payment method (?:is )?(?:set up|configured)|payment account (?:is )?not attached/i.test(message)
    const reason = missingPaymentMethod
      ? 'Meta rechazó el envío porque en ese momento la cuenta de WhatsApp no tenía un método de pago configurado (131042).'
      : 'Meta rechazó el envío por un problema de facturación en la cuenta de WhatsApp (131042).'
    return `${reason} Revisa Facturación y pagos de esa cuenta de WhatsApp: método de pago, cargos pendientes y límites. Una tarjeta guardada para anuncios no habilita automáticamente los pagos de WhatsApp.`
  }
  if (code === '130472') {
    return 'Meta no entregó esta plantilla porque el destinatario está incluido en el experimento 130472. Este rechazo no depende del método de pago.'
  }
  if (code === '131049') {
    return 'Meta no entregó esta plantilla por sus límites de mensajes de marketing para el destinatario (131049). Evita reintentarlo de inmediato.'
  }
  return message
}

/** Enrich old failures at read time; never revive an API error cleared by QR. */
export function resolveStoredWhatsAppProviderError({ errorCode, errorMessage, rawPayload, transport } = {}) {
  if (!clean(errorCode) && !clean(errorMessage)) return { code: '', message: '' }
  const stored = extractWhatsAppProviderError({ errorCode, errorMessage })
  const raw = parsePayload(rawPayload)
  const receipt = extractWhatsAppProviderError(raw.deliveryReceipt)
  const original = receipt.code ? receipt : extractWhatsAppProviderError(raw)
  const matchingProviderError = clean(transport).toLowerCase() !== 'qr' && original.code &&
    (original.code === stored.code || HTTP_ERROR_CODES.has(stored.code) || !stored.code)
  const resolved = matchingProviderError ? original : stored
  return {
    code: resolved.code,
    message: formatWhatsAppProviderError({
      errorCode: resolved.code,
      errorMessage: resolved.message || stored.message
    })
  }
}

export function formatWhatsAppQrFallbackReason(value) {
  const reason = clean(value)
  return reason === LEGACY_EXPERIMENT_QR_REASON ? WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON : reason
}
