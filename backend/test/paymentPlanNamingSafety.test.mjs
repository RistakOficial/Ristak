import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { updateInvoiceSchedule } from '../src/controllers/highlevelController.js'
import {
  applyOfflinePaymentPlanAction,
  persistOfflinePaymentPlanMirror
} from '../src/services/offlinePaymentPlanService.js'
import {
  assertPaymentPlanNamingChangeAllowed,
  updatePaymentPlanNaming
} from '../src/services/paymentPlanNamingService.js'

function createPrefix() {
  return `payment_plan_naming_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
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
    }
  }
}

async function cleanupFixture(fixture) {
  const paymentIds = fixture.paymentIds || []
  if (paymentIds.length) {
    const placeholders = paymentIds.map(() => '?').join(', ')
    await db.run(`DELETE FROM payment_automation_dispatches WHERE payment_id IN (${placeholders})`, paymentIds).catch(() => undefined)
  }
  await db.run('DELETE FROM payment_plans WHERE id = ?', [fixture.flowId]).catch(() => undefined)
  await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [fixture.flowId]).catch(() => undefined)
  if (paymentIds.length) {
    const placeholders = paymentIds.map(() => '?').join(', ')
    await db.run(`DELETE FROM payments WHERE id IN (${placeholders})`, paymentIds).catch(() => undefined)
  }
  await db.run('DELETE FROM payment_flows WHERE id = ?', [fixture.flowId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => undefined)
}

async function seedUnusedOfflinePlan() {
  const prefix = createPrefix()
  const fixture = {
    contactId: `${prefix}_contact`,
    flowId: `${prefix}_flow`,
    paymentIds: [`${prefix}_payment_1`, `${prefix}_payment_2`],
    installmentIds: [`${prefix}_installment_1`, `${prefix}_installment_2`]
  }

  await db.run(
    `INSERT INTO contacts (id, full_name, email, created_at, updated_at)
     VALUES (?, 'Cliente sin actividad', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [fixture.contactId, `${prefix}@example.test`]
  )
  await db.run(
    `INSERT INTO payment_flows (
       id, contact_id, contact_name, contact_email, total_amount, currency, concept,
       payment_provider, current_state, first_payment_status, metadata, created_at, updated_at
     ) VALUES (?, ?, 'Cliente sin actividad', ?, 1000, 'MXN', 'Plan original',
       'offline', 'offline_plan_active', 'not_required', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [fixture.flowId, fixture.contactId, `${prefix}@example.test`, JSON.stringify({ remainingFrequency: 'monthly' })]
  )

  for (let index = 0; index < fixture.paymentIds.length; index += 1) {
    const paymentId = fixture.paymentIds[index]
    const installmentId = fixture.installmentIds[index]
    const sequence = index + 1
    const dueDate = `2099-0${sequence + 1}-28`
    await db.run(
      `INSERT INTO payments (
         id, contact_id, amount, currency, status, payment_method, payment_mode,
         payment_provider, title, description, metadata_json, date, due_date,
         created_at, updated_at
       ) VALUES (?, ?, 500, 'MXN', 'pending', 'offline', 'live', 'offline', ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentId,
        fixture.contactId,
        `Plan original - Pago ${sequence} de 2`,
        `Plan original - Pago ${sequence} de 2`,
        JSON.stringify({ paymentPlan: { flowId: fixture.flowId, installmentId } }),
        dueDate,
        dueDate
      ]
    )
    await db.run(
      `INSERT INTO installment_payments (
         id, flow_id, sequence, amount, due_date, frequency, payment_method,
         automatic, status, payment_id, created_at, updated_at
       ) VALUES (?, ?, ?, 500, ?, 'monthly', 'offline', 0, 'pending', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [installmentId, fixture.flowId, sequence, dueDate, paymentId]
    )
  }

  await persistOfflinePaymentPlanMirror(fixture.flowId)
  return fixture
}

test('renombra por separado plan y factura sin mover el calendario y sobrevive al refresco del espejo', async () => {
  const fixture = await seedUnusedOfflinePlan()
  try {
    const before = await db.all(
      'SELECT id, amount, due_date, status FROM payments WHERE id IN (?, ?) ORDER BY id',
      fixture.paymentIds
    )

    await updatePaymentPlanNaming(fixture.flowId, {
      name: 'Plan interno Lilia',
      title: 'Factura proyecto premium',
      description: 'Servicios profesionales del proyecto',
      termsNotes: 'Pago por transferencia bancaria.'
    })

    const flow = await db.get('SELECT concept, current_state, metadata FROM payment_flows WHERE id = ?', [fixture.flowId])
    const metadata = JSON.parse(flow.metadata)
    assert.equal(flow.concept, 'Plan interno Lilia')
    assert.equal(flow.current_state, 'offline_plan_active')
    assert.equal(metadata.planName, 'Plan interno Lilia')
    assert.equal(metadata.invoiceTitle, 'Factura proyecto premium')
    assert.equal(metadata.invoiceDescription, 'Servicios profesionales del proyecto')
    assert.equal(metadata.termsNotes, 'Pago por transferencia bancaria.')

    const payments = await db.all(
      'SELECT id, amount, due_date, status, title, description FROM payments WHERE id IN (?, ?) ORDER BY id',
      fixture.paymentIds
    )
    assert.deepEqual(
      payments.map(({ id, amount, due_date, status }) => ({ id, amount, due_date, status })),
      before
    )
    assert.deepEqual(payments.map((payment) => payment.title), [
      'Factura proyecto premium - Pago 1 de 2',
      'Factura proyecto premium - Pago 2 de 2'
    ])
    assert.deepEqual(payments.map((payment) => payment.description), [
      'Servicios profesionales del proyecto - Pago 1 de 2',
      'Servicios profesionales del proyecto - Pago 2 de 2'
    ])

    await persistOfflinePaymentPlanMirror(fixture.flowId)
    const mirror = await db.get('SELECT name, title, description, raw_json FROM payment_plans WHERE id = ?', [fixture.flowId])
    const raw = JSON.parse(mirror.raw_json)
    assert.equal(mirror.name, 'Plan interno Lilia')
    assert.equal(mirror.title, 'Factura proyecto premium')
    assert.equal(mirror.description, 'Servicios profesionales del proyecto')
    assert.equal(raw.termsNotes, 'Pago por transferencia bancaria.')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('eliminar un plan offline sin actividad lo purga y ya no deja un espejo editable', async () => {
  const fixture = await seedUnusedOfflinePlan()
  try {
    const deletion = await applyOfflinePaymentPlanAction(fixture.flowId, 'delete')
    assert.equal(deletion.deleted, true)

    await assert.rejects(
      () => updatePaymentPlanNaming(fixture.flowId, { name: 'Plan que ya no existe' }),
      error => Number(error?.status) === 404
    )
    assert.equal(await db.get('SELECT id FROM payment_flows WHERE id = ?', [fixture.flowId]), null)
    assert.equal(await db.get('SELECT id FROM installment_payments WHERE flow_id = ? LIMIT 1', [fixture.flowId]), null)
    assert.equal(await db.get('SELECT id FROM payments WHERE id IN (?, ?) LIMIT 1', fixture.paymentIds), null)
    assert.equal(await db.get('SELECT id FROM payment_plans WHERE id = ?', [fixture.flowId]), null)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('bloquea el cambio después de un intento o recordatorio enviado, pero no por un envío fallido', async () => {
  const fixture = await seedUnusedOfflinePlan()
  try {
    await db.run(
      `INSERT INTO payment_automation_dispatches (
         id, payment_id, automation_type, channel, status, created_at, updated_at
       ) VALUES (?, ?, 'reminder', 'email', 'failed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [`${fixture.flowId}_failed_dispatch`, fixture.paymentIds[0]]
    )
    await assert.doesNotReject(() => updatePaymentPlanNaming(fixture.flowId, {
      title: 'Factura corregida después de fallo de entrega'
    }))

    await db.run(
      "UPDATE payment_automation_dispatches SET status = 'sent', updated_at = CURRENT_TIMESTAMP WHERE payment_id = ?",
      [fixture.paymentIds[0]]
    )
    await assert.rejects(
      () => updatePaymentPlanNaming(fixture.flowId, { title: 'Factura que ya no debe cambiar' }),
      (error) => error?.status === 409 && /recordatorio enviado/i.test(error.message)
    )

    await db.run('DELETE FROM payment_automation_dispatches WHERE payment_id = ?', [fixture.paymentIds[0]])
    await db.run("UPDATE payments SET status = 'requires_action' WHERE id = ?", [fixture.paymentIds[0]])
    await assert.rejects(
      () => assertPaymentPlanNamingChangeAllowed(fixture.flowId, { name: 'Plan que tampoco debe cambiar' }),
      (error) => error?.status === 409 && /intento de cobro/i.test(error.message)
    )
  } finally {
    await cleanupFixture(fixture)
  }
})
