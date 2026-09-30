import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON,
  extractWhatsAppProviderError,
  formatWhatsAppProviderError,
  formatWhatsAppQrFallbackReason,
  isWhatsAppBillingError,
  resolveStoredWhatsAppProviderError
} from '../src/utils/whatsappProviderError.js'

const billingTitle = 'Business eligibility payment issue'
const missingPaymentDetail = 'Message failed to send because no payment method is set up for your WhatsApp Business account.'
const billingError = {
  code: 131042,
  message: billingTitle,
  error_data: { details: missingPaymentDetail }
}

test('Meta receipts retain the exact provider code and actionable payment detail', () => {
  assert.deepEqual(extractWhatsAppProviderError({ errors: [billingError] }), {
    code: '131042',
    message: `${billingTitle}: ${missingPaymentDetail}`,
    details: missingPaymentDetail
  })
  assert.deepEqual(extractWhatsAppProviderError({
    errorCode: '131042',
    errorMessage: `${billingTitle}: ${missingPaymentDetail}`,
    whatsappApiError: billingError
  }), {
    code: '131042',
    message: `${billingTitle}: ${missingPaymentDetail}`,
    details: missingPaymentDetail
  })
})

test('YCloud wrappers and synchronous Graph failures preserve provider codes instead of HTTP status', () => {
  const ycloudError = Object.assign(new Error(billingTitle), {
    statusCode: 400,
    ycloud: { error: { code: 'BAD_REQUEST', message: billingTitle, whatsappApiError: billingError } }
  })
  assert.equal(extractWhatsAppProviderError(ycloudError).code, '131042')
  assert.equal(isWhatsAppBillingError(ycloudError), true)
  assert.equal(isWhatsAppBillingError({ statusCode: 403, ycloud: {
    error: { code: 'BALANCE_INSUFFICIENT', message: 'Your account balance is insufficient.' }
  } }), true)
  assert.equal(extractWhatsAppProviderError({ statusCode: 400, graphCode: 132005,
    message: '(#132005) Translated text too long' }).code, '132005')
  assert.equal(extractWhatsAppProviderError({ errorCode: '400',
    errorMessage: '(#132005) Translated text too long' }).code, '132005')
})

test('billing guidance only claims a missing payment method when Meta actually reported it', () => {
  const missing = formatWhatsAppProviderError({ errors: [billingError] })
  assert.match(missing, /en ese momento.*no tenía un método de pago/i)
  assert.match(missing, /cuenta de WhatsApp/i)
  assert.match(missing, /tarjeta guardada para anuncios/i)

  const generic = formatWhatsAppProviderError({ errorCode: '131042', errorMessage: billingTitle })
  assert.match(generic, /problema de facturación/i)
  assert.doesNotMatch(generic, /no tenía un método de pago/i)
  assert.match(formatWhatsAppProviderError({ errorCode: '130472' }), /no depende del método de pago/i)
  assert.match(formatWhatsAppProviderError({ errorCode: '131049' }), /Evita reintentarlo de inmediato/)
})

test('historical failures use stored Meta details without changing their delivery state', () => {
  for (const rawPayload of [
    { errors: [billingError] },
    JSON.stringify({ deliveryReceipt: { errors: [billingError] } })
  ]) {
    const result = resolveStoredWhatsAppProviderError({
      errorCode: '131042', errorMessage: billingTitle, rawPayload
    })
    assert.equal(result.code, '131042')
    assert.match(result.message, /en ese momento.*no tenía un método de pago/i)
  }
  assert.equal(resolveStoredWhatsAppProviderError({ errorCode: '400', errorMessage: 'Failed',
    rawPayload: { errors: [{ code: 132005, message: 'Translated text too long' }] }
  }).code, '132005')
})

test('a recovered QR message never regains the old API failure from its raw payload', () => {
  assert.deepEqual(resolveStoredWhatsAppProviderError({
    errorCode: null,
    errorMessage: null,
    rawPayload: {
      errors: [billingError],
      deliveryReceipt: { errors: [billingError] },
      apiFailure: { errorCode: '130472', errorMessage: "User's number is part of an experiment" },
      qrFallback: { applied: true, status: 'delivered' }
    }
  }), { code: '', message: '' })
})

test('unrelated or malformed payloads preserve the actual error', () => {
  for (const rawPayload of ['{broken', null, { errors: [billingError] }]) {
    assert.deepEqual(resolveStoredWhatsAppProviderError({
      errorCode: '479', errorMessage: 'QR disconnected', rawPayload
    }), { code: '479', message: 'QR disconnected' })
  }
  assert.equal(formatWhatsAppProviderError(new Error('Falta el número destino')), 'Falta el número destino')
  const ambiguous = Object.assign(new Error('Meta falló (131000). Ristak no usó el respaldo QR para evitar duplicar el mensaje.'), {
    graphCode: 131000, graphMessage: '(#131000) Something went wrong'
  })
  assert.equal(extractWhatsAppProviderError(ambiguous).message, ambiguous.message)
  assert.equal(formatWhatsAppProviderError(ambiguous), ambiguous.message)
  assert.deepEqual(resolveStoredWhatsAppProviderError({
    errorCode: '500', errorMessage: 'QR failed', transport: 'qr', rawPayload: { errors: [billingError] }
  }), { code: '500', message: 'QR failed' })
  assert.deepEqual(extractWhatsAppProviderError(), { code: '', message: '', details: '' })
})

test('old and new experiment fallback notices clearly state the successful QR send', () => {
  const legacy = 'WhatsApp no entregó la plantilla porque el destinatario está incluido en el experimento 130472; Ristak la envió como texto por el respaldo QR.'
  assert.equal(formatWhatsAppQrFallbackReason(legacy), WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON)
  assert.equal(formatWhatsAppQrFallbackReason(WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON), WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON)
  assert.match(WHATSAPP_EXPERIMENT_QR_FALLBACK_REASON, /^Ristak envió el mensaje/)
  assert.equal(formatWhatsAppQrFallbackReason('Ventana cerrada'), 'Ventana cerrada')
})
