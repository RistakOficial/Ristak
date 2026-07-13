import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

import {
  createConversationalTools,
  setNativePaymentReceiptAnalysisHookForTest
} from '../src/agents/conversational/tools.js'

test.afterEach(() => {
  setNativePaymentReceiptAnalysisHookForTest(null)
})

function paymentContext(items, overrides = {}) {
  const suffix = randomUUID()
  const agentId = `agent_payment_scope_${suffix}`
  return {
    runtimeMode: 'tool_calling_v2',
    contactId: `contact_payment_scope_${suffix}`,
    agentId,
    channel: 'whatsapp',
    dryRun: true,
    previewScopeId: `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    config: {
      id: agentId,
      runtimeMode: 'tool_calling_v2',
      objective: 'custom',
      capabilitiesConfig: { schemaVersion: 3, items }
    },
    ...overrides
  }
}

function scheduleCapability(suffix = randomUUID()) {
  return {
    id: 'schedule_appointment',
    enabled: true,
    calendarId: `calendar_payment_scope_${suffix}`,
    bookingOwner: 'ai'
  }
}

function depositCapability() {
  return {
    id: 'collect_payment',
    enabled: true,
    chargeType: 'deposit',
    paymentMode: 'deposit',
    collectionMethod: 'payment_link',
    gateway: 'stripe',
    deposit: {
      enabled: true,
      mode: 'fixed',
      amount: 300,
      currency: 'MXN',
      methods: { paymentLink: true, bankTransfer: false }
    }
  }
}

async function invokePayment(ctx) {
  const paymentTool = createConversationalTools(ctx)
    .find((item) => item.name === 'create_payment_link')
  assert.ok(paymentTool, 'la capacidad de cobro debe exponer create_payment_link')
  return paymentTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
}

test('un deposito independiente no se convierte en anticipo de cita por tener calendario activo', async () => {
  const ctx = paymentContext([
    scheduleCapability(),
    depositCapability()
  ])

  const result = await invokePayment(ctx)

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.simulated, true)
  assert.equal(ctx.actions.length, 1)
  assert.equal(ctx.actions[0].paymentPurpose, 'deposit')
  assert.equal('appointmentSelectionEventId' in ctx.actions[0], false)
})

test('el terminal de agenda puede ligar el deposito al horario con alcance explicito', async () => {
  const ctx = paymentContext([
    scheduleCapability(),
    depositCapability()
  ], {
    // Esta marca sólo la abre el borde terminal de agendamiento después de una
    // oferta aceptada; no nace de tener ambas capacidades encendidas.
    nativePaymentCollectionScope: 'appointment_deposit'
  })

  const result = await invokePayment(ctx)

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.simulated, true)
  assert.equal(ctx.actions.length, 1)
  assert.equal(ctx.actions[0].paymentPurpose, 'appointment_deposit')
})

test('un cobro normal coexiste con calendario y conserva proposito de compra', async () => {
  const ctx = paymentContext([
    scheduleCapability(),
    {
      id: 'collect_payment',
      enabled: true,
      chargeType: 'direct',
      paymentMode: 'full_payment',
      collectionMethod: 'payment_link',
      gateway: 'stripe',
      direct: {
        amount: 850,
        currency: 'MXN',
        concept: 'Servicio independiente de la cita'
      }
    }
  ])

  const result = await invokePayment(ctx)

  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.simulated, true)
  assert.equal(result.amount, 850)
  assert.equal(result.concept, 'Servicio independiente de la cita')
  assert.equal(ctx.actions.length, 1)
  assert.equal(ctx.actions[0].paymentPurpose, 'purchase')
  assert.equal('appointmentSelectionEventId' in ctx.actions[0], false)
})

test('modo prueba de transferencia lee el adjunto real y nunca finge confirmar el pago', async () => {
  const ctx = paymentContext([{
    id: 'collect_payment',
    enabled: true,
    chargeType: 'direct',
    paymentMode: 'full_payment',
    collectionMethod: 'bank_transfer',
    direct: {
      amount: 1200,
      currency: 'MXN',
      concept: 'Servicio por transferencia'
    },
    bankTransfer: { details: 'Banco de prueba, cuenta 1234' },
    receiptProof: { enabled: true },
    testMode: { enabled: true, notify: true }
  }], {
    executionId: 'preview-current-message',
    conversationMessages: [
      {
        id: 'preview-message-with-receipt',
        role: 'user',
        content: 'Ya transferí',
        attachments: [{
          kind: 'image',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,iVBORw0KGgo='
        }]
      },
      { id: 'preview-current-message', role: 'user', content: 'Revísalo por favor' }
    ]
  })
  let analyzedUrl = ''
  setNativePaymentReceiptAnalysisHookForTest(async ({ mediaUrl }) => {
    analyzedUrl = mediaUrl
    return {
      ok: true,
      isPaymentReceipt: true,
      amount: 1200,
      currency: 'MXN',
      bank: 'Banco de prueba',
      reference: 'REF-123',
      confidence: 0.98
    }
  })

  const proofTool = createConversationalTools(ctx)
    .find((item) => item.name === 'register_deposit_payment_proof')
  assert.ok(proofTool)
  const result = await proofTool.invoke(null, JSON.stringify({ montoIndicado: 1200, referencia: null }))

  assert.equal(analyzedUrl, 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(result.ok, true)
  assert.equal(result.simulated, true)
  assert.equal(result.proofMatchesConfiguredPayment, true)
  assert.equal(result.paymentConfirmed, false)
  assert.equal(result.manualReviewRequired, true)
  assert.equal(result.wouldRegisterPendingReview, true)
  assert.equal(ctx.actions[0].paymentPurpose, 'purchase')
  assert.equal(ctx.actions[0].outcome.analysis.reference, 'REF-123')
})

test('en vivo nunca recicla un comprobante viejo del historial para el turno actual', async () => {
  const currentMessageId = `current-message-${randomUUID()}`
  const ctx = paymentContext([{
    id: 'collect_payment',
    enabled: true,
    chargeType: 'direct',
    paymentMode: 'full_payment',
    collectionMethod: 'bank_transfer',
    direct: {
      amount: 1200,
      currency: 'MXN',
      concept: 'Servicio por transferencia'
    },
    bankTransfer: { details: 'Banco de prueba, cuenta 1234' },
    receiptProof: { enabled: true }
  }], {
    dryRun: false,
    executionId: currentMessageId,
    conversationMessages: [
      {
        id: 'old-message-with-receipt',
        role: 'user',
        content: 'Comprobante anterior',
        messageTimestamp: new Date().toISOString(),
        attachments: [{
          kind: 'image',
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,OLDRECEIPT'
        }]
      },
      { id: currentMessageId, role: 'user', content: 'Ya quedó' }
    ]
  })
  let analysisCalls = 0
  setNativePaymentReceiptAnalysisHookForTest(async () => {
    analysisCalls += 1
    return { ok: true, isPaymentReceipt: true, amount: 1200, currency: 'MXN' }
  })

  const proofTool = createConversationalTools(ctx)
    .find((item) => item.name === 'register_deposit_payment_proof')
  assert.ok(proofTool)
  const result = await proofTool.invoke(null, JSON.stringify({ montoIndicado: 1200, referencia: null }))

  assert.equal(result.ok, false)
  assert.equal(result.actionCompleted, false)
  assert.match(result.error, /mensaje actual/i)
  assert.equal(analysisCalls, 0)
  assert.equal(ctx.actions[0].outcome.error, 'no_receipt_media')
})

test('en vivo rechaza incluso el adjunto del turno actual cuando ya venció la ventana del comprobante', async () => {
  const currentMessageId = `stale-current-message-${randomUUID()}`
  const ctx = paymentContext([{
    id: 'collect_payment',
    enabled: true,
    chargeType: 'direct',
    paymentMode: 'full_payment',
    collectionMethod: 'bank_transfer',
    direct: { amount: 1200, currency: 'MXN', concept: 'Servicio por transferencia' },
    bankTransfer: { details: 'Banco de prueba, cuenta 1234' },
    receiptProof: { enabled: true }
  }], {
    dryRun: false,
    executionId: currentMessageId,
    conversationMessages: [{
      id: currentMessageId,
      role: 'user',
      content: 'Este fue el comprobante',
      messageTimestamp: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
      attachments: [{
        kind: 'image',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,STALECURRENT'
      }]
    }]
  })
  let analysisCalls = 0
  setNativePaymentReceiptAnalysisHookForTest(async () => {
    analysisCalls += 1
    return { ok: true, isPaymentReceipt: true, amount: 1200, currency: 'MXN' }
  })

  const result = await createConversationalTools(ctx)
    .find((item) => item.name === 'register_deposit_payment_proof')
    .invoke(null, JSON.stringify({ montoIndicado: 1200, referencia: null }))

  assert.equal(result.ok, false)
  assert.match(result.error, /mensaje actual/i)
  assert.equal(analysisCalls, 0)
})
