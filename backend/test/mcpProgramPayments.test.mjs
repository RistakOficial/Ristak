import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { databaseReady, db } from '../src/config/database.js'
import { programPaymentToolSpecs } from '../src/mcp/programPaymentTools.js'
import { callRegisteredMcpTool, __mcpRegistryTestHooks } from '../src/mcp/toolRegistry.js'

const context = { scopes: ['ristak.read'], user: { role: 'admin', permissions: { payments: 'read' } } }

before(async () => {
  await databaseReady
  for (const name of ['129_mcp_oauth_control_plane.sqlite.sql', '170_program_payment_associations.sql']) {
    await db.exec(await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8'))
  }
})

test('seven informational association tools use existing scope/module/admin rules and no arbitrary endpoint', () => {
  assert.equal(programPaymentToolSpecs.length, 7)
  for (const spec of programPaymentToolSpecs) {
    assert.equal(spec.adminOnly, true)
    assert.equal(spec.module, 'payments')
    assert.equal(spec.scope, spec.access === 'write' ? 'ristak.write' : 'ristak.read')
    assert.equal(spec.idempotencyRequired, spec.access === 'write')
    assert.equal(spec.inputSchema.additionalProperties, false)
    for (const key of ['endpoint', 'token', 'url', 'studentId', 'status', 'access']) assert.equal(spec.inputSchema.properties[key], undefined)
    if (spec.access === 'write') assert.ok(spec.inputSchema.required.includes('idempotencyKey'))
  }
  const link = programPaymentToolSpecs.find(spec => spec.name === 'payments_program_link')
  assert.deepEqual(link.inputSchema.properties.decision.properties.confirmed.enum, [true])
  assert.throws(() => __mcpRegistryTestHooks.validateSchemaValue({ sourceType: 'payment', sourceId: 'fixture', endpoint: 'https://unexpected.test/mcp' }, link.inputSchema), { code: 'invalid_arguments' })
})

test('registry rejects insufficient scope, non-admin and missing write idempotency before execution', async () => {
  await assert.rejects(callRegisteredMcpTool({ ...context, scopes: [] }, 'payments_program_review', { sourceType: 'payment' }), { code: 'insufficient_scope' })
  await assert.rejects(callRegisteredMcpTool({ ...context, user: { role: 'user', permissions: { payments: 'read' } } }, 'payments_program_review', { sourceType: 'payment' }), { code: 'admin_required' })
  await assert.rejects(callRegisteredMcpTool(context, 'payments_program_link', { sourceType: 'payment', sourceId: 'fixture' }), { code: 'invalid_arguments' })
})

test('registered review reads canonical fixtures with no remote key or access/payment mutation', async () => {
  const contactId = 'program-fixture-contact'
  const paymentId = 'program-fixture-payment'
  await db.run('INSERT INTO contacts (id, email, full_name) VALUES (?, ?, ?)', [contactId, 'program-fixture@example.test', 'Fixture'])
  await db.run(`INSERT INTO payments (id, contact_id, status, payment_mode, currency, amount, description, metadata_json)
    VALUES (?, ?, 'paid', 'live', 'EUR', 100, 'Consulta individual', '{}')`, [paymentId, contactId])
  const result = await callRegisteredMcpTool(context, 'payments_program_review', { sourceType: 'payment' })
  const item = result.items.find(row => row.sourceId === paymentId)
  assert.equal(item.state, 'needs_decision')
  assert.equal(item.reason, 'separate_service_description')
  assert.equal(item.accessAction, 'none')
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM program_payment_associations')).n, 0)
  assert.equal((await db.get('SELECT status FROM payments WHERE id = ?', [paymentId])).status, 'paid')
  const audit = await db.get("SELECT success FROM mcp_audit_log WHERE tool_name = 'payments_program_review' ORDER BY id DESC LIMIT 1")
  assert.equal(audit.success, 1)
})
