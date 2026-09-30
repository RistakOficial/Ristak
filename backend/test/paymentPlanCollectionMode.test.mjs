import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import { getAccountTimezone, businessTodayDateOnly } from '../src/utils/dateUtils.js'
import { changePaymentPlanCollectionMode } from '../src/services/paymentPlanCollectionService.js'
import { updatePaymentPlan } from '../src/controllers/paymentPlansController.js'
import { createStripePaymentPlan, processDueStripePaymentPlanCharges, saveStripePaymentConfig, setStripeFactoryForTest } from '../src/services/stripePaymentService.js'
import { createConektaPaymentPlan } from '../src/services/conektaPaymentService.js'
import { createRebillPaymentPlan } from '../src/services/rebillPaymentService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { paymentCapabilityToolSpecs } from '../src/mcp/paymentCapabilityTools.js'
import { __mcpRegistryTestHooks } from '../src/mcp/toolRegistry.js'
import { claimAutomaticPlanInstallment } from '../src/services/paymentPlanSafetyService.js'

let configSnapshot
const fixtureIds = []
before(async () => {
  configSnapshot = await db.all('SELECT * FROM app_config')
  await initializeMasterKey()
  await savePaymentSettings({ paymentMode: 'test', automations: { remindersEnabled: true, reminderChannel: 'email' } })
})
after(async () => {
  setStripeFactoryForTest(null)
  for (const id of fixtureIds) {
    await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [id])
    await db.run('DELETE FROM payment_plans WHERE id = ?', [id])
    await db.run('DELETE FROM payment_flows WHERE id = ?', [id])
    await db.run('DELETE FROM payments WHERE contact_id = ?', [id])
    await db.run('DELETE FROM stripe_payment_methods WHERE contact_id = ?', [id])
    await db.run('DELETE FROM contacts WHERE id = ?', [id])
  }
  await db.run('DELETE FROM app_config')
  for (const row of configSnapshot) {
    const columns = Object.keys(row)
    await db.run(`INSERT INTO app_config (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column]))
  }
})

async function fixture({ provider = 'stripe', state = 'installment_plan_active', paymentStatus = 'scheduled' } = {}) {
  const id = `collection_${randomUUID()}`
  fixtureIds.push(id)
  const timezone = await getAccountTimezone()
  const due = DateTime.fromISO(businessTodayDateOnly(timezone), { zone: timezone }).plus({ days: 2 }).set({ hour: 10 }).toUTC().toISO()
  await db.run('INSERT INTO contacts (id, full_name, email) VALUES (?, ?, ?)', [id, 'Cliente de prueba local', `${id}@example.test`])
  await db.run(`INSERT INTO payment_flows (id, contact_id, contact_name, contact_email, total_amount, currency, concept, payment_provider, current_state,
    first_payment_amount, first_payment_status, first_payment_method, first_payment_invoice_id, remaining_automatic, stripe_payment_method_id, metadata)
    VALUES (?, ?, 'Cliente de prueba local', 'local@example.test', 200, 'MXN', 'Proyecto', ?, ?, 100, 'paid', 'payment_link', ?, ?, 'pm_existing_local_fixture', ?)`,
  [id, id, provider, state, `${id}_paid`, provider === 'offline' ? 0 : 1, JSON.stringify({ paymentMode: 'test', remainingFrequency: 'monthly', tax: { enabled: false } })])
  await db.run(`INSERT INTO payments (id, contact_id, amount, currency, status, payment_provider, payment_method, payment_mode, stripe_payment_intent_id, title)
    VALUES (?, ?, 100, 'MXN', 'paid', 'stripe', 'card', 'test', 'pi_paid_history_fixture', 'Proyecto - Pago 1/2')`, [`${id}_paid`, id])
  await db.run(`INSERT INTO payments (id, contact_id, amount, currency, status, payment_provider, payment_method, payment_mode, title, due_date, public_payment_id, payment_url, metadata_json)
    VALUES (?, ?, 100, 'MXN', ?, ?, ?, 'test', 'Proyecto - Pago 2/2', ?, ?, ?, ?)`,
  [`${id}_pending`, id, paymentStatus, provider, `${provider}_scheduled_card`, due, `${id}_public`, `/pay/${id}_public`, JSON.stringify({ paymentPlan: { flowId: id, trigger: 'scheduled_installment' } })])
  await db.run(`INSERT INTO installment_payments (id, flow_id, sequence, amount, due_date, frequency, payment_method, automatic, status, payment_id)
    VALUES (?, ?, 1, 100, ?, 'monthly', ?, ?, ?, ?)`, [`${id}_installment`, id, due, `${provider}_saved_card`, provider === 'offline' ? 0 : 1, paymentStatus, `${id}_pending`])
  return id
}

test('las altas de pasarela rechazan instrucciones offline antes de pedir credenciales o crear cargos', async () => {
  for (const create of [createStripePaymentPlan, createConektaPaymentPlan, createRebillPaymentPlan]) {
    for (const input of [{ remainingAutomatic: false }, { collectionMode: 'offline' }, { remainingPayments: [{ paymentMethod: 'offline' }] }]) {
      await assert.rejects(create(input), /recordatorios usa el plan offline/)
    }
  }
})

test('MCP exige una decisión expresa para domiciliar con cada pasarela', () => {
  for (const provider of ['stripe', 'conekta', 'rebill']) {
    const tool = paymentCapabilityToolSpecs.find(item => item.name === `payments_create_${provider}_plan`)
    assert.ok(tool.inputSchema.required.includes('collectionMode'))
    assert.equal(tool.inputSchema.properties.collectionMode.const, 'automatic')
    assert.equal(tool.inputSchema.properties.remainingAutomatic.const, true)
    const input = { contact: { id: 'local_contact' }, totalAmount: 100, title: 'Plan local', remainingPayments: [{ amount: 100, dueDate: '2099-01-01' }], idempotencyKey: 'local-test-consent-key' }
    const validate = value => __mcpRegistryTestHooks.validateSchemaValue(value, tool.inputSchema)
    assert.throws(() => validate(input), /collectionMode.*requerido/)
    assert.throws(() => validate({ ...input, collectionMode: 'offline' }), /collectionMode.*no permitido/)
    assert.throws(() => validate({ ...input, collectionMode: 'automatic', remainingAutomatic: false }), /remainingAutomatic.*no permitido/)
    assert.doesNotThrow(() => validate({ ...input, collectionMode: 'automatic', remainingAutomatic: true }))
  }
})

test('preparar una cuota exige consentimiento vigente y la misma tarjeta; bloquea cambios al comenzar el cobro', async () => {
  const columns = { stripe: 'stripe_payment_method_id', conekta: 'conekta_payment_source_id', rebill: 'rebill_card_id' }
  for (const [provider, column] of Object.entries(columns)) {
    const id = await fixture({ provider })
    await db.run(`UPDATE payment_flows SET ${column} = 'card_selected_fixture', remaining_automatic = 0 WHERE id = ?`, [id])
    let claims = 0
    const claim = cardId => claimAutomaticPlanInstallment(id, provider, 'installment_plan_active', cardId, async tx => {
      claims++
      return tx.run("UPDATE installment_payments SET status = 'processing' WHERE flow_id = ?", [id])
    })
    assert.equal((await claim('card_selected_fixture')).changes, 0)
    await db.run('UPDATE payment_flows SET remaining_automatic = 1 WHERE id = ?', [id])
    assert.equal((await claim('card_replaced_fixture')).changes, 0)
    await db.run("UPDATE payment_flows SET current_state = 'editing' WHERE id = ?", [id])
    assert.equal((await claim('card_selected_fixture')).changes, 0)
    assert.equal(claims, 0)
    await db.run("UPDATE payment_flows SET current_state = 'installment_plan_active' WHERE id = ?", [id])
    assert.equal((await claim('card_selected_fixture')).changes, 1)
    assert.equal(claims, 1)
    await assert.rejects(changePaymentPlanCollectionMode(id, { collectionMode: 'offline' }), /proceso/)
    assert.equal((await db.get('SELECT remaining_automatic FROM payment_flows WHERE id = ?', [id])).remaining_automatic, 1)
  }
})

test('cambiar Stripe/Conekta/Rebill/Mercado Pago a offline conserva historial, fechas, importes e identidad', async () => {
  for (const provider of ['stripe', 'conekta', 'rebill', 'mercadopago']) {
    const id = await fixture({ provider })
    if (provider === 'conekta') await db.run('UPDATE payments SET conekta_payment_source_id = ? WHERE id = ?', ['source_not_charged_fixture', `${id}_pending`])
    if (provider === 'rebill') await db.run('UPDATE payments SET rebill_customer_id = ?, rebill_card_id = ? WHERE id = ?', ['customer_not_charged_fixture', 'card_not_charged_fixture', `${id}_pending`])
    const historical = await db.get('SELECT * FROM payments WHERE id = ?', [`${id}_paid`])
    const pendingBefore = await db.get('SELECT * FROM payments WHERE id = ?', [`${id}_pending`])
    await changePaymentPlanCollectionMode(id, { collectionMode: 'offline' }, { actorId: 'operator_local_test' })
    const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [id])
    const pending = await db.get('SELECT * FROM payments WHERE id = ?', [`${id}_pending`])
    const installment = await db.get('SELECT * FROM installment_payments WHERE flow_id = ?', [id])
    assert.equal(flow.payment_provider, 'offline')
    assert.equal(flow.remaining_automatic, 0)
    assert.equal(flow.stripe_payment_method_id, 'pm_existing_local_fixture')
    assert.equal(flow.first_payment_status, 'paid')
    assert.equal(flow.current_state, 'offline_plan_active')
    assert.equal(installment.automatic, 0)
    assert.equal(installment.payment_method, 'offline')
    assert.equal(pending.status, 'pending')
    assert.equal(JSON.parse(pending.metadata_json).offlineReminder, true)
    assert.equal(pending.conekta_payment_source_id, null)
    assert.equal(pending.rebill_card_id, null)
    assert.equal(pending.rebill_customer_id, null)
    for (const key of ['id', 'amount', 'currency', 'due_date', 'public_payment_id', 'payment_url']) assert.equal(pending[key], pendingBefore[key])
    assert.deepEqual(await db.get('SELECT * FROM payments WHERE id = ?', [`${id}_paid`]), historical)
    assert.equal(JSON.parse(flow.metadata).collectionModeHistory.at(-1).actorId, 'operator_local_test')
    const schedule = JSON.parse((await db.get('SELECT * FROM payment_plans WHERE id = ?', [id])).schedule_json)
    assert.equal(schedule.collectionMode, 'offline')
    assert.equal(schedule.firstPayment.paymentProvider, 'stripe')
    assert.equal(schedule.firstPayment.paymentMethod, 'card')
    assert.equal(schedule.installments[0].hasPaymentActivity, false)
  }
})

test('el endpoint usado por la pantalla y MCP devuelve el plan canónico actualizado', async () => {
  const id = await fixture()
  let response
  await updatePaymentPlan({ params: { scheduleId: id }, body: { collectionMode: 'offline' }, user: { id: 'operator' } }, {
    status(code) { assert.equal(code, 200); return this },
    json(value) { response = value }
  })
  assert.equal(response.success, true)
  assert.equal(response.data.id, id)
  assert.equal(response.data.source, 'offline')
})

test('un plan pausado sigue pausado al cambiar a offline', async () => {
  const id = await fixture({ state: 'paused' })
  await changePaymentPlanCollectionMode(id, { collectionMode: 'offline' })
  assert.equal((await db.get('SELECT current_state FROM payment_flows WHERE id = ?', [id])).current_state, 'offline_plan_paused')
})

test('no se cambia un cobro en proceso ni un checkout iniciado; un rechazo revierte todo', async () => {
  for (const busy of ['processing', 'requires_action', 'intent']) {
    const id = await fixture({ paymentStatus: busy === 'intent' ? 'scheduled' : busy })
    if (busy === 'intent') await db.run('UPDATE payments SET stripe_payment_intent_id = ? WHERE id = ?', ['pi_in_progress_fixture', `${id}_pending`])
    const before = await db.get('SELECT * FROM payment_flows WHERE id = ?', [id])
    await assert.rejects(changePaymentPlanCollectionMode(id, { collectionMode: 'offline' }), /proceso|actividad/)
    assert.deepEqual(await db.get('SELECT * FROM payment_flows WHERE id = ?', [id]), before)
  }
})

test('apagar domiciliación es posible aunque se hayan desactivado globalmente los avisos', async () => {
  await savePaymentSettings({ automations: { remindersEnabled: false } })
  const id = await fixture()
  await changePaymentPlanCollectionMode(id, { collectionMode: 'offline' })
  assert.equal((await db.get('SELECT remaining_automatic FROM payment_flows WHERE id = ?', [id])).remaining_automatic, 0)
  await savePaymentSettings({ automations: { remindersEnabled: true } })
})

test('el cron omite un plan offline aunque arrastre estado activo y cuotas automáticas antiguas', async () => {
  setStripeFactoryForTest(() => ({})) // No se permite ninguna operación de red en esta prueba.
  await saveStripePaymentConfig({ enabled: true, mode: 'test', publishableKey: 'pk_test_local_guard_fixture', secretKey: 'sk_test_local_guard_fixture' })
  const id = await fixture()
  const timezone = await getAccountTimezone()
  const due = DateTime.fromISO(businessTodayDateOnly(timezone), { zone: timezone }).startOf('day').toUTC().toISO()
  await db.run('UPDATE payment_flows SET remaining_automatic = 0 WHERE id = ?', [id])
  await db.run('UPDATE installment_payments SET due_date = ? WHERE flow_id = ?', [due, id])
  await db.run('UPDATE payments SET due_date = ? WHERE id = ?', [due, `${id}_pending`])
  assert.deepEqual(await processDueStripePaymentPlanCharges(), [])
  assert.equal((await db.get('SELECT status FROM installment_payments WHERE flow_id = ?', [id])).status, 'scheduled')
  assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [`${id}_pending`])).status, 'scheduled')
})

test('domiciliar un plan offline exige seleccionar su tarjeta y nunca cobra al guardar (prueba local)', async () => {
  // Configuración sintética sólo para probar la selección local; ninguna llamada llega al proveedor.
  let providerCalls = 0
  setStripeFactoryForTest(() => { providerCalls++; throw new Error('Esta prueba no permite llamadas a Stripe') })
  await saveStripePaymentConfig({ enabled: true, mode: 'test', publishableKey: 'pk_test_local_collection_fixture', secretKey: 'sk_test_local_collection_fixture' })
  const id = await fixture({ provider: 'offline', state: 'offline_plan_paused', paymentStatus: 'pending' })
  await db.run(`INSERT INTO stripe_payment_methods (id, contact_id, stripe_customer_id, stripe_payment_method_id, mode, brand, last4)
    VALUES (?, ?, 'cus_local_fixture', 'pm_local_fixture', 'test', 'visa', '4242')`, [`${id}_card`, id])
  await assert.rejects(changePaymentPlanCollectionMode(id, { collectionMode: 'automatic', paymentProvider: 'stripe' }), /tarjeta seleccionada/)
  await assert.rejects(changePaymentPlanCollectionMode(id, { collectionMode: 'automatic', paymentProvider: 'clip', paymentMethodId: 'pm_local_fixture' }), /Mercado Pago y CLIP/)
  await changePaymentPlanCollectionMode(id, { collectionMode: 'automatic', paymentProvider: 'stripe', paymentMethodId: 'pm_local_fixture' })
  const flow = await db.get('SELECT * FROM payment_flows WHERE id = ?', [id])
  assert.equal(flow.current_state, 'paused')
  assert.equal(flow.remaining_automatic, 1)
  assert.equal(flow.stripe_payment_method_id, 'pm_local_fixture')
  assert.equal((await db.get('SELECT automatic FROM installment_payments WHERE flow_id = ?', [id])).automatic, 1)
  assert.equal(providerCalls, 0)
  await changePaymentPlanCollectionMode(id, { collectionMode: 'offline' })
  await db.run('UPDATE installment_payments SET due_date = ? WHERE flow_id = ?', ['2000-01-01', id])
  await assert.rejects(changePaymentPlanCollectionMode(id, { collectionMode: 'automatic', paymentProvider: 'stripe', paymentMethodId: 'pm_local_fixture' }), /Reprograma/)
  assert.equal((await db.get('SELECT remaining_automatic FROM payment_flows WHERE id = ?', [id])).remaining_automatic, 0)
  assert.equal(providerCalls, 0)
})
