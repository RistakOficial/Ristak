import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  assertExactPaymentPlanTotal,
  assertPlanCanChangeState,
  markOverduePaymentPlanChargesForReview,
  runIdempotentPaymentPlanCreation
} from '../src/services/paymentPlanSafetyService.js'
import {
  applyRebillPaymentPlanAction,
  refreshRebillPaymentPlanMirrors,
  updateRebillPaymentPlanSchedule
} from '../src/services/rebillPaymentService.js'
import { handleConektaWebhookView } from '../src/controllers/conektaPaymentsController.js'
import { withCronLock } from '../src/utils/cronLock.js'
import { getAccountTimezone, normalizeDateOnlyInTimezone } from '../src/utils/dateUtils.js'

function suffix() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

async function cleanup(prefix) {
  await db.run('DELETE FROM payment_plan_creation_hash_guards WHERE idempotency_key LIKE ?', [`${prefix}%`]).catch(() => {})
  await db.run('DELETE FROM payment_plan_creation_requests WHERE idempotency_key LIKE ?', [`${prefix}%`]).catch(() => {})
  await db.run('DELETE FROM payment_plans WHERE id LIKE ?', [`${prefix}%`]).catch(() => {})
  await db.run('DELETE FROM installment_payments WHERE flow_id LIKE ?', [`${prefix}%`]).catch(() => {})
  await db.run('DELETE FROM payments WHERE id LIKE ?', [`${prefix}%`]).catch(() => {})
  await db.run('DELETE FROM payment_flows WHERE id LIKE ?', [`${prefix}%`]).catch(() => {})
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => {})
}

test('creación idempotente ejecuta una sola vez y reproduce la respuesta', async () => {
  const prefix = `safety_${suffix()}`
  const key = `${prefix}_request_key_123456`
  let executions = 0
  const args = {
    provider: 'stripe',
    idempotencyKey: key,
    payload: { totalAmount: 100, currency: 'MXN', contact: { id: 'contact_1' } },
    create: async () => {
      executions += 1
      return { flowId: `${prefix}_flow`, currentState: 'installment_plan_active' }
    }
  }
  try {
    const first = await runIdempotentPaymentPlanCreation(args)
    const replay = await runIdempotentPaymentPlanCreation(args)
    assert.deepEqual(replay, first)
    assert.equal(executions, 1)
  } finally {
    await cleanup(prefix)
  }
})

test('dos llaves distintas y simultáneas para el mismo plan sólo permiten una creación', async () => {
  const prefix = `safety_${suffix()}`
  const payload = { totalAmount: 333.33, currency: 'MXN', contact: { id: `${prefix}_contact` } }
  let executions = 0
  const create = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 30))
    return { flowId: `${prefix}_flow` }
  }
  try {
    const results = await Promise.allSettled([
      runIdempotentPaymentPlanCreation({ provider: 'stripe', idempotencyKey: `${prefix}_request_a_123456`, payload: structuredClone(payload), create }),
      runIdempotentPaymentPlanCreation({ provider: 'stripe', idempotencyKey: `${prefix}_request_b_123456`, payload: structuredClone(payload), create })
    ])
    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1)
    assert.match(String(results.find((result) => result.status === 'rejected')?.reason?.message), /ya se está creando/i)
  } finally {
    await cleanup(prefix)
  }
})

test('una validación sin efectos permite corregir y reenviar con la misma llave', async () => {
  const prefix = `safety_${suffix()}`
  const key = `${prefix}_validation_key_123456`
  let executions = 0
  const create = async () => {
    executions += 1
    if (executions === 1) throw Object.assign(new Error('monto inválido'), { status: 400 })
    return { flowId: `${prefix}_flow` }
  }
  try {
    await assert.rejects(() => runIdempotentPaymentPlanCreation({ provider: 'stripe', idempotencyKey: key, payload: { totalAmount: 0 }, create }), /monto inválido/)
    const result = await runIdempotentPaymentPlanCreation({ provider: 'stripe', idempotencyKey: key, payload: { totalAmount: 100 }, create })
    assert.equal(result.flowId, `${prefix}_flow`)
    assert.equal(executions, 2)
  } finally {
    await cleanup(prefix)
  }
})

test('clientes legacy sin header también quedan deduplicados', async () => {
  const prefix = `safety_${suffix()}`
  let executions = 0
  const payload = { totalAmount: 125, currency: 'MXN', contact: { id: `${prefix}_contact` } }
  const create = async () => ({ flowId: `${prefix}_flow_${++executions}` })
  try {
    const first = await runIdempotentPaymentPlanCreation({ provider: 'stripe', payload, create })
    const replay = await runIdempotentPaymentPlanCreation({ provider: 'stripe', payload, create })
    assert.equal(replay.flowId, first.flowId)
    assert.equal(executions, 1)
  } finally {
    const requests = await db.all('SELECT provider, request_hash, idempotency_key FROM payment_plan_creation_requests WHERE flow_id LIKE ?', [`${prefix}%`])
    for (const request of requests || []) {
      await db.run(
        'DELETE FROM payment_plan_creation_hash_guards WHERE provider = ? AND request_hash = ? AND idempotency_key = ?',
        [request.provider, request.request_hash, request.idempotency_key]
      ).catch(() => {})
    }
    await db.run('DELETE FROM payment_plan_creation_requests WHERE flow_id LIKE ?', [`${prefix}%`]).catch(() => {})
  }
})

test('un intento fallido queda bloqueado y pone cualquier plan parcial en revisión', async () => {
  const prefix = `safety_${suffix()}`
  const key = `${prefix}_failed_request_123456`
  const contactId = `${prefix}_contact`
  const flowId = `${prefix}_flow`
  const installmentId = `${prefix}_installment`
  const paymentId = `${prefix}_payment`
  try {
    await db.run('INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [contactId, 'Safety Test'])
    let executions = 0
    const create = async () => {
      executions += 1
      await db.run(
        `INSERT INTO payment_flows (id, contact_id, total_amount, currency, payment_provider, current_state, first_payment_status, metadata)
         VALUES (?, ?, 100, 'MXN', 'stripe', 'installment_plan_active', 'scheduled', ?)`,
        [flowId, contactId, JSON.stringify({ creationRequestKey: key })]
      )
      await db.run(
        `INSERT INTO installment_payments (id, flow_id, sequence, amount, due_date, automatic, status, payment_id)
         VALUES (?, ?, 1, 100, '2099-01-01', 1, 'scheduled', ?)`,
        [installmentId, flowId, paymentId]
      )
      throw Object.assign(new Error('falla simulada después de persistir'), { status: 500 })
    }
    await assert.rejects(() => runIdempotentPaymentPlanCreation({ provider: 'stripe', idempotencyKey: key, payload: { totalAmount: 100 }, create }), /falla simulada/)
    await assert.rejects(() => runIdempotentPaymentPlanCreation({ provider: 'stripe', idempotencyKey: key, payload: { totalAmount: 100 }, create }), /falla simulada/)
    assert.equal(executions, 1)
    const flow = await db.get('SELECT current_state, first_payment_status FROM payment_flows WHERE id = ?', [flowId])
    const installment = await db.get('SELECT status FROM installment_payments WHERE id = ?', [installmentId])
    assert.equal(flow.current_state, 'creation_failed_review')
    assert.equal(flow.first_payment_status, 'overdue_review')
    assert.equal(installment.status, 'overdue_review')
  } finally {
    await cleanup(prefix)
  }
})

test('los importes se comparan en unidades mínimas sin tolerancia escondida', () => {
  assert.doesNotThrow(() => assertExactPaymentPlanTotal({
    totalAmount: 100,
    firstPaymentAmount: 33.33,
    remainingPayments: [{ amount: 33.33 }, { amount: 33.34 }],
    currency: 'MXN'
  }))
  assert.throws(() => assertExactPaymentPlanTotal({
    totalAmount: 100,
    firstPaymentAmount: 33.33,
    remainingPayments: [{ amount: 33.33 }, { amount: 33.33 }],
    currency: 'MXN'
  }), /parcialidades suman/i)
  assert.doesNotThrow(() => assertExactPaymentPlanTotal({
    totalAmount: 100,
    firstPaymentAmount: 25,
    remainingPayments: [{ amount: 75 }],
    currency: 'JPY'
  }))
})

test('Conekta rechaza webhooks financieros cuando no puede verificar la firma', async () => {
  const keys = ['conekta_mode_connections']
  const previous = await db.all(`SELECT config_key, config_value FROM app_config WHERE config_key = ?`, keys)
  try {
    await db.run(`DELETE FROM app_config WHERE config_key = ?`, keys)
    const response = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this },
      json(payload) { this.payload = payload; return this }
    }
    await handleConektaWebhookView({
      rawBody: JSON.stringify({ type: 'order.paid', data: { object: { id: 'ord_untrusted' } } }),
      body: { type: 'order.paid', data: { object: { id: 'ord_untrusted' } } },
      query: {},
      get() { return '' }
    }, response)
    assert.equal(response.statusCode, 503)
    assert.equal(response.payload.success, false)
  } finally {
    await db.run(`DELETE FROM app_config WHERE config_key = ?`, keys)
    for (const row of previous) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP`,
        [row.config_key, row.config_value]
      )
    }
  }
})

test('un cron financiero no corre si otra instancia conserva el lease', async () => {
  const name = `payment-plan-safety-${suffix()}`
  let executions = 0
  try {
    await db.run(
      `INSERT INTO distributed_locks (name, owner_id, locked_until, updated_at)
       VALUES (?, 'another-instance', ?, CURRENT_TIMESTAMP)`,
      [name, new Date(Date.now() + 60_000).toISOString()]
    )
    const result = await withCronLock(name, 60_000, async () => { executions += 1 }, { failOpen: false, leaseTtlMs: 300_000 })
    assert.equal(result.ran, false)
    assert.equal(executions, 0)
  } finally {
    await db.run('DELETE FROM distributed_locks WHERE name = ?', [name]).catch(() => {})
  }
})

test('un atraso pasa a revisión y reactivar exige reprogramarlo', async () => {
  const prefix = `safety_${suffix()}`
  const contactId = `${prefix}_contact`
  const flowId = `${prefix}_flow`
  const installmentId = `${prefix}_installment`
  try {
    await db.run('INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [contactId, 'Safety Test'])
    await db.run(
      `INSERT INTO payment_flows (id, contact_id, total_amount, currency, payment_provider, current_state, first_payment_status, metadata)
       VALUES (?, ?, 100, 'MXN', 'stripe', 'installment_plan_active', 'not_required', '{}')`,
      [flowId, contactId]
    )
    await db.run(
      `INSERT INTO installment_payments (id, flow_id, sequence, amount, due_date, automatic, status)
       VALUES (?, ?, 1, 100, '2000-01-01', 1, 'scheduled')`,
      [installmentId, flowId]
    )
    await markOverduePaymentPlanChargesForReview('stripe')
    assert.equal((await db.get('SELECT status FROM installment_payments WHERE id = ?', [installmentId])).status, 'overdue_review')
    await assert.rejects(() => assertPlanCanChangeState(flowId, { activating: true }), /Reprograma esas fechas/i)
  } finally {
    await cleanup(prefix)
  }
})

test('un plan legado de Mercado Pago no genera links atrasados al reiniciar', async () => {
  const prefix = `safety_${suffix()}`
  const contactId = `${prefix}_contact`
  const flowId = `${prefix}_flow`
  const installmentId = `${prefix}_installment`
  try {
    await db.run('INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [contactId, 'Mercado Pago Safety'])
    await db.run(
      `INSERT INTO payment_flows (id, contact_id, total_amount, currency, payment_provider, current_state, first_payment_status, metadata)
       VALUES (?, ?, 100, 'MXN', 'mercadopago', 'mercadopago_plan_active', 'not_required', '{}')`,
      [flowId, contactId]
    )
    await db.run(
      `INSERT INTO installment_payments (id, flow_id, sequence, amount, due_date, automatic, status)
       VALUES (?, ?, 1, 100, '2000-01-01', 1, 'scheduled')`,
      [installmentId, flowId]
    )
    await markOverduePaymentPlanChargesForReview('mercadopago')
    assert.equal((await db.get('SELECT status FROM installment_payments WHERE id = ?', [installmentId])).status, 'overdue_review')
    assert.equal((await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [flowId])).current_state, 'paused')
  } finally {
    await cleanup(prefix)
  }
})

test('Rebill se administra localmente: refrescar, editar y pausar sin HighLevel', async () => {
  const prefix = `safety_${suffix()}`
  const contactId = `${prefix}_contact`
  const flowId = `${prefix}_flow`
  const installmentId = `${prefix}_installment`
  const paymentId = `${prefix}_payment`
  try {
    await db.run('INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [contactId, 'Rebill Safety'])
    await db.run(
      `INSERT INTO payment_flows (
        id, contact_id, contact_name, total_amount, currency, concept, payment_provider,
        current_state, first_payment_amount, first_payment_status, rebill_card_id, metadata
      ) VALUES (?, ?, 'Rebill Safety', 100, 'MXN', 'Plan Rebill', 'rebill', 'installment_plan_active', 0, 'not_required', 'card_test', ?)`,
      [flowId, contactId, JSON.stringify({ remainingFrequency: 'monthly', paymentMode: 'test' })]
    )
    await db.run(
      `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, payment_provider, payment_mode, title, date, due_date, created_at, updated_at)
       VALUES (?, ?, 100, 'MXN', 'scheduled', 'rebill_scheduled_card', 'rebill', 'test', 'Plan Rebill', '2099-01-01', '2099-01-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [paymentId, contactId]
    )
    await db.run(
      `INSERT INTO installment_payments (id, flow_id, sequence, amount, due_date, frequency, payment_method, automatic, status, payment_id)
       VALUES (?, ?, 1, 100, '2099-01-01', 'monthly', 'rebill_saved_card', 1, 'scheduled', ?)`,
      [installmentId, flowId, paymentId]
    )
    assert.ok((await refreshRebillPaymentPlanMirrors()) >= 1)
    await updateRebillPaymentPlanSchedule(flowId, {
      total: 100,
      title: 'Plan Rebill editado',
      remainingFrequency: 'monthly',
      installments: [{ id: installmentId, amount: 100, dueDate: '2099-02-01', method: 'rebill_auto' }]
    })
    const savedDueDate = (await db.get('SELECT due_date FROM installment_payments WHERE id = ?', [installmentId])).due_date
    assert.equal(normalizeDateOnlyInTimezone(savedDueDate, await getAccountTimezone()), '2099-02-01')
    assert.equal((await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [flowId])).current_state, 'installment_plan_active')
    await applyRebillPaymentPlanAction(flowId, 'pause')
    assert.equal((await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [flowId])).current_state, 'paused')
  } finally {
    await cleanup(prefix)
  }
})
