import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { deleteTransaction, getTransactionById, voidTransaction } from '../src/controllers/transactionsController.js'
import GHLClient from '../src/services/ghlClient.js'
import { __invoicesSyncTestHooks } from '../src/services/invoicesSyncService.js'
import {
  getPaymentDeletionGuard,
  paymentHasExternalArtifact,
  paymentHasLedgerActivity
} from '../src/services/paymentRecordSafetyService.js'
import {
  saveStripePaymentConfig,
  refreshStripePaymentFromIntent,
  setStripeFactoryForTest
} from '../src/services/stripePaymentService.js'
import { deleteSubscription } from '../src/services/subscriptionsService.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

function suffix(label = 'payment_safety') {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    },
    send(payload) {
      this.payload = payload
      return this
    }
  }
}

async function snapshotStripeConfig(callback) {
  const previousRows = await db.all("SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'stripe_%'")

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
    for (const row of previousRows) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET
           config_value = excluded.config_value,
           updated_at = CURRENT_TIMESTAMP`,
        [row.config_key, row.config_value]
      )
    }
    setStripeFactoryForTest(null)
  }
}

async function snapshotHighLevelConfig(callback) {
  const columns = await db.all('PRAGMA table_info(highlevel_config)').then(rows => rows.map(row => row.name))
  const previousRows = await db.all('SELECT * FROM highlevel_config').catch(() => [])
  await db.run('DELETE FROM highlevel_config')

  try {
    await db.run(
      `INSERT INTO highlevel_config (location_id, api_token, ghl_invoice_mode, created_at)
       VALUES ('location_payment_delete', 'token_payment_delete', 'live', CURRENT_TIMESTAMP)`
    )
    return await callback()
  } finally {
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of previousRows) {
      const availableColumns = columns.filter(column => Object.prototype.hasOwnProperty.call(row, column))
      if (!availableColumns.length) continue
      const placeholders = availableColumns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO highlevel_config (${availableColumns.join(', ')}) VALUES (${placeholders})`,
        availableColumns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
}

async function cleanup(ids) {
  await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM payment_plans WHERE id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM payment_flows WHERE id = ?', [ids.flowId]).catch(() => undefined)
  await db.run('DELETE FROM subscriptions WHERE id = ?', [ids.subscriptionId]).catch(() => undefined)
  await db.run(
    `DELETE FROM payment_automation_dispatches
     WHERE payment_id IN (?, ?, ?, ?, ?)`,
    [ids.paidPaymentId, ids.pendingLinkPaymentId, ids.planPaymentId, ids.voidPaymentId, ids.subscriptionPaymentId]
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM payments
     WHERE id IN (?, ?, ?, ?, ?) OR contact_id = ?`,
    [ids.paidPaymentId, ids.pendingLinkPaymentId, ids.planPaymentId, ids.voidPaymentId, ids.subscriptionPaymentId, ids.contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [ids.contactId]).catch(() => undefined)
}

async function seedSafetyRows(label = 'payment_safety') {
  const idSuffix = suffix(label)
  const ids = {
    contactId: `contact_${idSuffix}`,
    paidPaymentId: `payment_paid_${idSuffix}`,
    pendingLinkPaymentId: `payment_link_${idSuffix}`,
    planPaymentId: `payment_plan_${idSuffix}`,
    voidPaymentId: `payment_void_${idSuffix}`,
    subscriptionPaymentId: `payment_subscription_${idSuffix}`,
    subscriptionId: `subscription_${idSuffix}`,
    flowId: `stripe_flow_${idSuffix}`,
    installmentId: `stripe_installment_${idSuffix}`
  }

  await cleanup(ids)

  await db.run(
    `INSERT INTO contacts (id, full_name, email, phone, source, created_at, updated_at)
     VALUES (?, 'Cliente seguridad pagos', ?, '+5215551112222', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.contactId, `${ids.contactId}@example.test`]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, reference, title, description, paid_at, date, created_at, updated_at
    ) VALUES (?, ?, 500, 'MXN', 'paid', 'cash', 'live', 'manual', 'REC-1', 'Pago pagado', 'Pago pagado',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.paidPaymentId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, public_payment_id, payment_url, date, created_at, updated_at
    ) VALUES (?, ?, 800, 'MXN', 'sent', 'stripe', 'test', 'stripe', 'Link pendiente', 'Link pendiente',
      'pay_safety_public', 'https://example.test/pay/pay_safety_public', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.pendingLinkPaymentId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payment_flows (
      id, contact_id, contact_name, total_amount, currency, concept, payment_type,
      payment_provider, current_state, state_history, created_at, updated_at
    ) VALUES (?, ?, 'Cliente seguridad pagos', 1000, 'MXN', 'Plan protegido', 'partial',
      'stripe', 'installment_plan_active', '[]', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.flowId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, metadata_json, date, created_at, updated_at
    ) VALUES (?, ?, 1000, 'MXN', 'scheduled', 'stripe_scheduled_card', 'test', 'stripe',
      'Pago plan protegido', 'Pago plan protegido', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      ids.planPaymentId,
      ids.contactId,
      JSON.stringify({
        paymentPlan: {
          flowId: ids.flowId,
          installmentId: ids.installmentId,
          trigger: 'scheduled_installment'
        }
      })
    ]
  )

  await db.run(
    `INSERT INTO installment_payments (
      id, flow_id, sequence, amount, due_date, frequency, payment_method,
      automatic, status, payment_id, created_at, updated_at
    ) VALUES (?, ?, 1, 1000, '2099-01-01', 'monthly', 'stripe_saved_card', 1, 'scheduled', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.installmentId, ids.flowId, ids.planPaymentId]
  )

  await db.run(
    `INSERT INTO payment_plans (
      id, contact_id, contact_name, name, title, status, total, currency,
      source, schedule_json, raw_json, created_at, updated_at
    ) VALUES (?, ?, 'Cliente seguridad pagos', 'Plan protegido', 'Plan protegido', 'active', 1000, 'MXN',
      'stripe', '{}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.flowId, ids.contactId]
  )

  await db.run(
    `INSERT INTO payments (
      id, contact_id, amount, currency, status, payment_method, payment_mode,
      payment_provider, title, description, date, created_at, updated_at
    ) VALUES (?, ?, 300, 'MXN', 'paid', 'cash', 'live', 'manual', 'Pago no anulable', 'Pago no anulable',
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [ids.voidPaymentId, ids.contactId]
  )

  return ids
}

test('seguridad pagos: conserva un pago manual/offline cuando ya fue pagado', async () => {
  const ids = await seedSafetyRows('paid_delete')

  try {
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /actividad de pago registrada/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: conserva un pago manual/offline que ya fue anulado', async () => {
  const ids = await seedSafetyRows('void_manual_delete')

  try {
    await db.run(
      `UPDATE payments
       SET status = 'void',
           paid_at = NULL
       WHERE id = ?`,
      [ids.voidPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.voidPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /actividad de pago registrada/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.voidPaymentId])
    assert.equal(row.status, 'void')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra físicamente un pago manual pendiente sin actividad', async () => {
  const ids = await seedSafetyRows('pending_manual_delete')

  try {
    await db.run(
      `UPDATE payments
       SET status = 'pending',
           paid_at = NULL
       WHERE id = ?`,
      [ids.paidPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: conserva registros live de pasarelas conocidas y futuras como historial', async () => {
  for (const provider of ['stripe', 'mercadopago', 'conekta', 'clip', 'rebill', 'highlevel', 'openpay_future']) {
    const ids = await seedSafetyRows(`gateway_${provider}`)

    try {
      await db.run(
        `UPDATE payments
         SET status = 'pending',
             paid_at = NULL,
             payment_provider = ?,
             payment_method = ?
         WHERE id = ?`,
        [provider, `${provider}_checkout`, ids.paidPaymentId]
      )

      const res = createResponse()
      await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

      assert.equal(res.statusCode, 200, provider)
      assert.equal(res.payload.success, true, provider)

      const row = await db.get('SELECT status, payment_provider FROM payments WHERE id = ?', [ids.paidPaymentId])
      assert.equal(row.status, 'deleted', provider)
      assert.equal(row.payment_provider, provider, provider)
    } finally {
      await cleanup(ids)
    }
  }
})

test('seguridad pagos: detecta IDs de pasarela aunque el proveedor venga mal etiquetado como manual', () => {
  assert.equal(paymentHasExternalArtifact({ payment_provider: 'manual', conekta_order_id: 'ord_guard' }), true)
  assert.equal(paymentHasExternalArtifact({ payment_provider: 'manual', rebill_payment_id: 'rebill_guard' }), true)
  assert.equal(paymentHasExternalArtifact({ payment_provider: 'manual', payment_link_request_key: 'link_guard' }), true)
  assert.equal(paymentHasExternalArtifact({ payment_provider: 'manual', metadata_json: JSON.stringify({ stripeChargeId: 'ch_metadata_guard' }) }), true)
  assert.equal(paymentHasExternalArtifact({ payment_provider: 'manual', payment_method: 'cash' }), false)
})

test('seguridad pagos: distingue intentos preparados de actividad financiera real', async () => {
  assert.equal(paymentHasLedgerActivity({ status: 'pending', stripe_payment_intent_id: 'pi_unused' }), false)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', mercadopago_preference_id: 'pref_unused' }), false)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', stripe_charge_id: 'ch_real' }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', mercadopago_payment_id: 'mp_real' }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', conekta_order_id: 'order_real' }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', conekta_charge_id: 'charge_real' }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', rebill_payment_id: 'rebill_real' }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'pending', metadata_json: JSON.stringify({ stripe: { chargeId: 'ch_nested' } }) }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'failed', stripe_payment_intent_id: 'pi_failed' }), true)
  assert.equal(paymentHasLedgerActivity({ status: 'future_provider_unknown_state' }), true)
})

test('seguridad pagos: sólo el borrado individual puede ignorar un estado fallido sin cobro', () => {
  const options = { allowUnpaidFailure: true }
  for (const status of ['failed', 'failure', 'declined']) {
    assert.equal(paymentHasLedgerActivity({ status }), true)
    assert.equal(paymentHasLedgerActivity({ status }, options), false)
    assert.equal(paymentHasLedgerActivity({ status, metadata_json: JSON.stringify({ stripe: { status: 'failed' } }) }, options), false)
  }
  for (const evidence of [
    { paid_at: '2026-10-07T16:00:00Z' },
    { clip_receipt_no: 'receipt_paid' },
    ...['paid', 'partial', 'refunded', 'authorized', 'processing', 'unknown'].map(status => ({
      metadata_json: JSON.stringify({ stripe: { status } })
    }))
  ]) {
    assert.equal(paymentHasLedgerActivity({ status: 'failed', ...evidence }, options), true, JSON.stringify(evidence))
  }
  for (const attempt of [
    { stripe_charge_id: 'ch_declined' },
    { mercadopago_payment_id: 'mp_rejected' },
    { conekta_order_id: 'ord_declined' },
    { clip_payment_id: 'clip_declined' },
    { rebill_payment_id: 'rebill_declined' },
    { metadata_json: JSON.stringify({ stripe: { latestChargeId: 'ch_nested' } }) }
  ]) {
    assert.equal(paymentHasLedgerActivity({ status: 'failed', ...attempt }), true)
    assert.equal(paymentHasLedgerActivity({ status: 'failed', ...attempt }, options), false)
    assert.equal(paymentHasExternalArtifact({ status: 'failed', ...attempt }), true)
  }
})

test('seguridad pagos: elimina pagos manuales fallidos o enviados sin cobro', async () => {
  for (const status of ['failed', 'sent']) {
    const ids = await seedSafetyRows(`unpaid_${status}`)
    try {
      await db.run('UPDATE payments SET status = ?, paid_at = NULL WHERE id = ?', [status, ids.paidPaymentId])
      const detail = createResponse()
      await getTransactionById({ params: { id: ids.paidPaymentId } }, detail)
      assert.equal(detail.payload.data.hasProtectedPaymentActivity, false)

      const res = createResponse()
      await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)
      assert.equal(res.statusCode, 200)
      assert.equal(await db.get('SELECT id FROM payments WHERE id = ?', [ids.paidPaymentId]), null)
    } finally {
      await cleanup(ids)
    }
  }
})

test('seguridad pagos: conserva fallidos y enviados que sí tienen un pago registrado', async () => {
  for (const status of ['failed', 'sent']) {
    const ids = await seedSafetyRows(`recorded_${status}`)
    try {
      await db.run('UPDATE payments SET status = ? WHERE id = ?', [status, ids.paidPaymentId])
      const detail = createResponse()
      await getTransactionById({ params: { id: ids.paidPaymentId } }, detail)
      assert.equal(detail.payload.data.hasProtectedPaymentActivity, true)

      const res = createResponse()
      await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)
      assert.equal(res.statusCode, 422)
      assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [ids.paidPaymentId])).status, status)
    } finally {
      await cleanup(ids)
    }
  }
})

test('seguridad pagos: un cobro concurrente impide borrar físicamente la fila', async (t) => {
  const ids = await seedSafetyRows('concurrent_payment_delete')
  try {
    await db.run("UPDATE payments SET status = 'failed', paid_at = NULL WHERE id = ?", [ids.paidPaymentId])
    const originalRun = db.run.bind(db)
    t.mock.method(db, 'run', async (sql, params = []) => {
      if (sql.startsWith('DELETE FROM payments') && params[0] === ids.paidPaymentId) {
        await originalRun("UPDATE payments SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?", [ids.paidPaymentId])
      }
      return originalRun(sql, params)
    })
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)
    assert.equal(res.statusCode, 409)
    const row = await db.get('SELECT status, paid_at FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row.status, 'paid')
    assert.ok(row.paid_at)
  } finally {
    t.mock.restoreAll()
    await cleanup(ids)
  }
})

test('seguridad pagos: archiva un link fallido sin cobro y conserva protegidos los pagos de un plan', async () => {
  const ids = await seedSafetyRows('unpaid_failed_link')
  try {
    await db.run("UPDATE payments SET status = 'failed', payment_mode = 'live' WHERE id IN (?, ?)", [ids.pendingLinkPaymentId, ids.planPaymentId])
    const deleted = createResponse()
    await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, deleted)
    assert.equal(deleted.statusCode, 200)
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])).status, 'deleted')

    const protectedPlan = createResponse()
    await deleteTransaction({ params: { id: ids.planPaymentId } }, protectedPlan)
    assert.equal(protectedPlan.statusCode, 422)
    assert.match(protectedPlan.payload.error, /plan de pagos/i)
    assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [ids.planPaymentId])).status, 'failed')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: no borra un pago manual con documento fiscal remoto', async () => {
  const ids = await seedSafetyRows('manual_fiscal_guard')

  try {
    await db.run(
      `INSERT INTO gigstack_invoice_jobs (
        payment_id, payment_mode, status, remote_payment_id, created_at, updated_at
      ) VALUES (?, 'live', 'completed', 'fiscal_remote_guard', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.paidPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /documento fiscal/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una transacción pagada cuando es de prueba', async () => {
  const ids = await seedSafetyRows('paid_test_delete')

  try {
    await db.run(
      `UPDATE payments
       SET payment_mode = 'test',
           metadata_json = ?
       WHERE id = ?`,
      [JSON.stringify({ paymentMode: 'test' }), ids.paidPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.paidPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.paidPaymentId])
    assert.equal(row, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: archiva un link live pendiente sin borrar la fila', async () => {
  const ids = await seedSafetyRows('pending_link')

  try {
    await db.run(
      `UPDATE payments
       SET payment_mode = 'live'
       WHERE id = ?`,
      [ids.pendingLinkPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT status, public_payment_id, payment_url FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
    assert.equal(row.status, 'deleted')
    assert.equal(row.public_payment_id, 'pay_safety_public')
    assert.equal(row.payment_url, 'https://example.test/pay/pay_safety_public')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: cancela un PaymentIntent Stripe sin intento y elimina el pago pendiente de la vista', async () => {
  const ids = await seedSafetyRows('pending_stripe_intent')
  const cancelCalls = []

  try {
    await initializeMasterKey()
    await snapshotStripeConfig(async () => {
      setStripeFactoryForTest(() => ({
        paymentIntents: {
          retrieve: async () => ({
            id: 'pi_unused_pending',
            status: 'requires_payment_method',
            amount_received: 0,
            latest_charge: null,
            last_payment_error: null,
            charges: { data: [] }
          }),
          cancel: async (id, payload, options) => {
            cancelCalls.push({ id, payload, options })
            return { id, status: 'canceled' }
          }
        }
      }))
      await saveStripePaymentConfig({
        enabled: true,
        mode: 'live',
        publishableKey: 'pk_live_payment_delete',
        secretKey: 'sk_live_payment_delete'
      })
      await db.run(
        `UPDATE payments
         SET payment_mode = 'live',
             status = 'pending',
             stripe_payment_intent_id = 'pi_unused_pending'
         WHERE id = ?`,
        [ids.pendingLinkPaymentId]
      )

      const guard = await getPaymentDeletionGuard(await db.get('SELECT * FROM payments WHERE id = ?', [ids.pendingLinkPaymentId]))
      assert.equal(guard.hasLedgerActivity, false)
      assert.equal(guard.shouldArchive, true)

      const res = createResponse()
      await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

      assert.equal(res.statusCode, 200)
      assert.equal(cancelCalls.length, 1)
      assert.equal(cancelCalls[0].id, 'pi_unused_pending')
      assert.equal(cancelCalls[0].payload.cancellation_reason, 'abandoned')
      assert.equal(cancelCalls[0].options.timeout, 8000)

      const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
      assert.equal(row.status, 'deleted')
    })
  } finally {
    setStripeFactoryForTest(null)
    await cleanup(ids)
  }
})

test('seguridad pagos: conserva un Stripe pendiente cuando el proveedor ya reporta un intento fallido', async () => {
  const ids = await seedSafetyRows('pending_stripe_attempt')
  let cancelCalls = 0

  try {
    await initializeMasterKey()
    await snapshotStripeConfig(async () => {
      setStripeFactoryForTest(() => ({
        paymentIntents: {
          retrieve: async () => ({
            id: 'pi_attempted_pending',
            status: 'requires_payment_method',
            amount_received: 0,
            latest_charge: null,
            last_payment_error: { code: 'card_declined' },
            charges: { data: [] }
          }),
          cancel: async () => {
            cancelCalls += 1
            return { status: 'canceled' }
          }
        }
      }))
      await saveStripePaymentConfig({
        enabled: true,
        mode: 'live',
        publishableKey: 'pk_live_payment_attempt',
        secretKey: 'sk_live_payment_attempt'
      })
      await db.run(
        `UPDATE payments
         SET payment_mode = 'live',
             status = 'pending',
             stripe_payment_intent_id = 'pi_attempted_pending'
         WHERE id = ?`,
        [ids.pendingLinkPaymentId]
      )

      const res = createResponse()
      await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

      assert.equal(res.statusCode, 422)
      assert.match(res.payload.error, /actividad|historial/i)
      assert.equal(cancelCalls, 0)

      const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
      assert.equal(row.status, 'pending')
    })
  } finally {
    setStripeFactoryForTest(null)
    await cleanup(ids)
  }
})

test('seguridad pagos: cancela Stripe fallido sólo con cero cobro y cancelación confirmada', async () => {
  const ids = await seedSafetyRows('failed_stripe_delete')
  try {
    await initializeMasterKey()
    await snapshotStripeConfig(async () => {
      await saveStripePaymentConfig({
        enabled: true,
        mode: 'live',
        publishableKey: 'pk_live_payment_delete',
        secretKey: 'sk_live_payment_delete'
      })
      const cases = [
        { name: 'rechazo sin cargo', intent: {}, cancelledStatus: 'canceled', expected: 200, calls: 1 },
        { name: 'folio de cargo rechazado', intent: { latest_charge: 'ch_failed' }, charge: { paid: false, status: 'failed' }, cancelledStatus: 'canceled', expected: 200, calls: 1 },
        { name: 'dinero recibido', intent: { amount_received: 500 }, expected: 422, calls: 0 },
        { name: 'cargo cobrado', intent: { latest_charge: 'ch_paid' }, charge: { paid: true, status: 'succeeded', amount_captured: 500 }, expected: 422, calls: 0 },
        { name: 'cargo reembolsado', intent: { latest_charge: 'ch_refunded' }, charge: { paid: false, status: 'failed', amount_refunded: 500 }, expected: 422, calls: 0 },
        { name: 'cargo de otro intento', intent: { latest_charge: 'ch_other_intent' }, charge: { paid: false, status: 'failed', payment_intent: 'pi_other' }, expected: 422, calls: 0 },
        { name: 'en proceso', intent: { status: 'processing' }, expected: 422, calls: 0 },
        { name: 'autenticación pendiente', intent: { status: 'requires_action' }, expected: 422, calls: 0 },
        { name: 'cancelación sin confirmar', intent: {}, cancelledStatus: 'processing', expected: 422, calls: 1 }
      ]
      for (const scenario of cases) {
        let cancelCalls = 0
        setStripeFactoryForTest(() => ({
          charges: {
            retrieve: async id => ({ id, payment_intent: 'pi_failed_unpaid', amount_captured: 0, amount_refunded: 0, ...scenario.charge })
          },
          paymentIntents: {
            retrieve: async () => ({
              id: 'pi_failed_unpaid',
              status: 'requires_payment_method',
              amount_received: 0,
              latest_charge: null,
              last_payment_error: { code: 'card_declined' },
              charges: { data: [] },
              currency: 'mxn',
              amount: 50000,
              metadata: { ristak_payment_id: ids.pendingLinkPaymentId },
              ...scenario.intent
            }),
            cancel: async () => {
              cancelCalls += 1
              return { id: 'pi_failed_unpaid', status: scenario.cancelledStatus }
            }
          }
        }))
        await db.run(
          "UPDATE payments SET payment_mode = 'live', status = 'failed', stripe_payment_intent_id = 'pi_failed_unpaid', stripe_charge_id = ? WHERE id = ?",
          [scenario.intent.latest_charge || null, ids.pendingLinkPaymentId]
        )
        const res = createResponse()
        await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)
        assert.equal(res.statusCode, scenario.expected, scenario.name)
        assert.equal(cancelCalls, scenario.calls, scenario.name)
        const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
        assert.equal(row.status, scenario.expected === 200 ? 'deleted' : 'failed', scenario.name)
        if (scenario.expected === 200) {
          await refreshStripePaymentFromIntent('pi_failed_unpaid', 'live')
          assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])).status, 'deleted', `fallo tardío: ${scenario.name}`)
          const repeated = createResponse()
          await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, repeated)
          assert.equal(repeated.statusCode, 200, `borrado idempotente: ${scenario.name}`)
        }
      }
    })
  } finally {
    setStripeFactoryForTest(null)
    await cleanup(ids)
  }
})

test('seguridad pagos: anula en HighLevel y conserva un tombstone eliminado que no revive por sync', async (t) => {
  const ids = await seedSafetyRows('pending_highlevel_invoice')
  const voidCalls = []
  t.mock.method(GHLClient.prototype, 'voidInvoice', async function voidInvoice(invoiceId) {
    voidCalls.push(invoiceId)
    return { id: invoiceId, status: 'void' }
  })

  try {
    await snapshotHighLevelConfig(async () => {
      await db.run(
        `UPDATE payments
         SET payment_mode = 'live',
             status = 'sent',
             payment_provider = 'highlevel',
             payment_method = '',
             public_payment_id = NULL,
             payment_url = NULL,
             ghl_invoice_id = 'ghl_invoice_unused'
         WHERE id = ?`,
        [ids.pendingLinkPaymentId]
      )

      const res = createResponse()
      await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

      assert.equal(res.statusCode, 200)
      assert.deepEqual(voidCalls, ['ghl_invoice_unused'])

      const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
      assert.equal(row.status, 'deleted')
      assert.equal(__invoicesSyncTestHooks.resolveSyncedInvoiceStatus('deleted', 'void'), 'deleted')
      assert.equal(__invoicesSyncTestHooks.resolveSyncedInvoiceStatus('deleted', 'sent'), 'deleted')
      assert.equal(__invoicesSyncTestHooks.resolveSyncedInvoiceStatus('deleted', 'paid'), 'paid')
    })
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: conserva idempotente el tombstone live de una transacción eliminada', async () => {
  const ids = await seedSafetyRows('deleted_archive')

  try {
    await db.run(
      `UPDATE payments
       SET status = 'deleted',
           payment_mode = 'live'
       WHERE id = ?`,
      [ids.pendingLinkPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id, status, public_payment_id FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
    assert.equal(row.id, ids.pendingLinkPaymentId)
    assert.equal(row.status, 'deleted')
    assert.equal(row.public_payment_id, 'pay_safety_public')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra un link test pendiente aunque tenga URL externa', async () => {
  const ids = await seedSafetyRows('pending_link_test')

  try {
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.pendingLinkPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.pendingLinkPaymentId])
    assert.equal(row, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: no borra una transacción live individual ligada a un plan', async () => {
  const ids = await seedSafetyRows('plan_link')

  try {
    await db.run(
      `UPDATE payments
       SET payment_mode = 'live'
       WHERE id = ?`,
      [ids.planPaymentId]
    )

    const res = createResponse()
    await deleteTransaction({ params: { id: ids.planPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /plan de pagos/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.planPaymentId])
    assert.equal(row.status, 'scheduled')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una transacción test ligada a un plan y limpia la parcialidad', async () => {
  const ids = await seedSafetyRows('plan_link_test')

  try {
    const res = createResponse()
    await deleteTransaction({ params: { id: ids.planPaymentId } }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)

    const row = await db.get('SELECT id FROM payments WHERE id = ?', [ids.planPaymentId])
    const installment = await db.get('SELECT status, payment_id FROM installment_payments WHERE id = ?', [ids.installmentId])

    assert.equal(row, null)
    assert.equal(installment.status, 'deleted')
    assert.equal(installment.payment_id, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una suscripción test con cobros ligados', async () => {
  const ids = await seedSafetyRows('subscription_test_delete')

  try {
    await db.run(
      `INSERT INTO subscriptions (
        id, contact_id, contact_name, name, status, amount, currency,
        interval_type, interval_count, payment_method, payment_provider,
        payment_mode, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 'Cliente seguridad pagos', 'Suscripción test borrable', 'active', 500, 'MXN',
        'monthly', 1, 'stripe_saved_card', 'stripe', 'test', 'ristak', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.subscriptionId, ids.contactId, JSON.stringify({ paymentMode: 'test' })]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, 500, 'MXN', 'paid', 'stripe_subscription', 'test', 'stripe',
        'Cobro suscripción test', 'Cobro suscripción test', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        ids.subscriptionPaymentId,
        ids.contactId,
        JSON.stringify({
          ristakSubscriptionId: ids.subscriptionId,
          source: 'stripe_subscription_invoice'
        })
      ]
    )

    const deleted = await deleteSubscription(ids.subscriptionId)
    assert.equal(deleted, true)

    const subscription = await db.get('SELECT id FROM subscriptions WHERE id = ?', [ids.subscriptionId])
    const payment = await db.get('SELECT id FROM payments WHERE id = ?', [ids.subscriptionPaymentId])

    assert.equal(subscription, null)
    assert.equal(payment, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una suscripción test aunque todavía no tenga cobros', async () => {
  const ids = await seedSafetyRows('subscription_test_empty_delete')

  try {
    await db.run(
      `INSERT INTO subscriptions (
        id, contact_id, contact_name, name, status, amount, currency,
        interval_type, interval_count, payment_method, payment_provider,
        payment_mode, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 'Cliente seguridad pagos', 'Suscripción test sin cobros', 'active', 500, 'MXN',
        'monthly', 1, 'stripe_saved_card', 'stripe', 'test', 'ristak', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.subscriptionId, ids.contactId, JSON.stringify({ paymentMode: 'test' })]
    )

    const deleted = await deleteSubscription(ids.subscriptionId)
    assert.equal(deleted, true)

    const subscription = await db.get('SELECT id FROM subscriptions WHERE id = ?', [ids.subscriptionId])
    assert.equal(subscription, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una suscripción cuando sus cobros ligados son test aunque el modo local esté live', async () => {
  const ids = await seedSafetyRows('subscription_linked_test_delete')

  try {
    await db.run(
      `INSERT INTO subscriptions (
        id, contact_id, contact_name, name, status, amount, currency,
        interval_type, interval_count, payment_method, payment_provider,
        payment_mode, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 'Cliente seguridad pagos', 'Suscripción con modo local stale', 'active', 500, 'MXN',
        'monthly', 1, 'stripe_saved_card', 'stripe', 'live', 'ristak', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.subscriptionId, ids.contactId, JSON.stringify({ paymentMode: 'live' })]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, 500, 'MXN', 'paid', 'stripe_subscription', 'test', 'stripe',
        'Cobro suscripción test stale', 'Cobro suscripción test stale', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        ids.subscriptionPaymentId,
        ids.contactId,
        JSON.stringify({
          ristakSubscriptionId: ids.subscriptionId,
          source: 'stripe_subscription_invoice',
          paymentMode: 'test'
        })
      ]
    )

    const deleted = await deleteSubscription(ids.subscriptionId)
    assert.equal(deleted, true)

    const subscription = await db.get('SELECT id FROM subscriptions WHERE id = ?', [ids.subscriptionId])
    const payment = await db.get('SELECT id FROM payments WHERE id = ?', [ids.subscriptionPaymentId])

    assert.equal(subscription, null)
    assert.equal(payment, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: borra una suscripción Mercado Pago sandbox aunque el modo local esté live', async () => {
  const ids = await seedSafetyRows('subscription_mp_sandbox_delete')

  try {
    await db.run(
      `INSERT INTO subscriptions (
        id, contact_id, contact_name, name, status, amount, currency,
        interval_type, interval_count, payment_method, payment_provider,
        payment_mode, source, mercadopago_preapproval_id, mercadopago_sandbox_init_point,
        metadata_json, raw_json, created_at, updated_at
      ) VALUES (?, ?, 'Cliente seguridad pagos', 'Suscripción MP sandbox stale', 'active', 500, 'MXN',
        'monthly', 1, 'mercadopago_subscription', 'mercadopago',
        'live', 'ristak', ?, 'https://sandbox.mercadopago.test/preapproval', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        ids.subscriptionId,
        ids.contactId,
        `preapproval_${ids.subscriptionId}`,
        JSON.stringify({ paymentMode: 'live' }),
        JSON.stringify({
          mercadoPago: {
            provider: 'mercadopago',
            preapproval: { id: `preapproval_${ids.subscriptionId}`, livemode: false }
          }
        })
      ]
    )

    const deleted = await deleteSubscription(ids.subscriptionId)
    assert.equal(deleted, true)

    const subscription = await db.get('SELECT id FROM subscriptions WHERE id = ?', [ids.subscriptionId])
    assert.equal(subscription, null)
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: no borra una suscripción live con cobros ligados', async () => {
  const ids = await seedSafetyRows('subscription_live_delete')

  try {
    await db.run(
      `INSERT INTO subscriptions (
        id, contact_id, contact_name, name, status, amount, currency,
        interval_type, interval_count, payment_method, payment_provider,
        payment_mode, source, metadata_json, created_at, updated_at
      ) VALUES (?, ?, 'Cliente seguridad pagos', 'Suscripción live protegida', 'active', 500, 'MXN',
        'monthly', 1, 'stripe_saved_card', 'stripe', 'live', 'ristak', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [ids.subscriptionId, ids.contactId, JSON.stringify({ paymentMode: 'live' })]
    )
    await db.run(
      `INSERT INTO payments (
        id, contact_id, amount, currency, status, payment_method, payment_mode,
        payment_provider, title, description, metadata_json, date, created_at, updated_at
      ) VALUES (?, ?, 500, 'MXN', 'paid', 'stripe_subscription', 'live', 'stripe',
        'Cobro suscripción live', 'Cobro suscripción live', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        ids.subscriptionPaymentId,
        ids.contactId,
        JSON.stringify({
          ristakSubscriptionId: ids.subscriptionId,
          source: 'stripe_subscription_invoice',
          paymentMode: 'live'
        })
      ]
    )

    await assert.rejects(
      () => deleteSubscription(ids.subscriptionId),
      /ya tiene cobros registrados|conservar el historial/i
    )

    const subscription = await db.get('SELECT status FROM subscriptions WHERE id = ?', [ids.subscriptionId])
    const payment = await db.get('SELECT status FROM payments WHERE id = ?', [ids.subscriptionPaymentId])

    assert.equal(subscription.status, 'active')
    assert.equal(payment.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})

test('seguridad pagos: no anula un pago ya completado', async () => {
  const ids = await seedSafetyRows('void_paid')

  try {
    const res = createResponse()
    await voidTransaction({ params: { id: ids.voidPaymentId } }, res)

    assert.equal(res.statusCode, 422)
    assert.match(res.payload.error, /reembolso/i)

    const row = await db.get('SELECT status FROM payments WHERE id = ?', [ids.voidPaymentId])
    assert.equal(row.status, 'paid')
  } finally {
    await cleanup(ids)
  }
})
