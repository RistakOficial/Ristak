import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { preparePaymentReceiptLink } from '../src/controllers/transactionsController.js'
import { getPublicOfflinePayment } from '../src/services/offlinePaymentPlanService.js'
import { domainToolSpecs } from '../src/mcp/domainTools.js'

const baseUrl = 'https://receipts.example.test'
const request = id => ({ params: { id }, protocol: 'https', headers: { host: 'receipts.example.test' } })
const response = () => ({
  statusCode: 200,
  status(code) { this.statusCode = code; return this },
  json(payload) { this.payload = payload; return this }
})

async function fixture({ status = 'paid', provider = 'manual', method = 'bank_transfer', publicId = null } = {}) {
  const id = `receipt_test_${randomUUID()}`
  const contactId = `${id}_contact`
  await db.run('INSERT INTO contacts (id, full_name, email, source) VALUES (?, ?, ?, ?)',
    [contactId, 'Receipt test', 'receipt@example.test', 'test'])
  await db.run(`INSERT INTO payments
    (id, contact_id, amount, currency, status, payment_provider, payment_method,
     payment_mode, reference, title, description, date, paid_at, public_payment_id, metadata_json)
    VALUES (?, ?, 1800, 'USD', ?, ?, ?, 'test', 'TEST-TRANSFER', 'Receipt test',
      'Receipt test', '2026-10-13T23:54:00Z', '2026-10-13T23:54:00Z', ?, '{"tax":{"enabled":false}}')`,
    [id, contactId, status, provider, method, publicId])
  return {
    id, contactId,
    cleanup: async () => {
      await db.run('DELETE FROM payments WHERE id = ?', [id])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  }
}

test('concurrent receipt repairs preserve the paid transfer and produce one usable public identity', async () => {
  const f = await fixture()
  try {
    const before = await db.get('SELECT * FROM payments WHERE id = ?', [f.id])
    const responses = [response(), response()]
    await Promise.all(responses.map(res => preparePaymentReceiptLink(request(f.id), res)))
    assert.ok(responses.every(res => res.statusCode === 200))
    assert.equal(responses[0].payload.data.link, responses[1].payload.data.link)
    assert.match(responses[0].payload.data.link, /^https:\/\/receipts\.example\.test\/pay\/rstk_pay_[A-Za-z0-9]+\?receipt=1$/)
    const after = await db.get('SELECT * FROM payments WHERE id = ?', [f.id])
    for (const key of Object.keys(before)) {
      if (!['public_payment_id', 'payment_url', 'updated_at'].includes(key)) assert.deepEqual(after[key], before[key], key)
    }
    assert.equal(after.payment_url, responses[0].payload.data.link.replace('?receipt=1', ''))
    const publicReceipt = await getPublicOfflinePayment(after.public_payment_id, { baseUrl })
    assert.equal(publicReceipt.id, f.id)
    assert.equal(publicReceipt.status, 'paid')
    assert.equal(publicReceipt.amount, 1800)
    assert.equal(publicReceipt.currency, 'USD')
    assert.equal(publicReceipt.provider, 'offline')
    assert.equal(publicReceipt.paymentPlan, null)
    assert.deepEqual(publicReceipt.paidAt, before.paid_at)
    assert.equal(publicReceipt.contact.email, 'receipt@example.test')
    assert.equal(await getPublicOfflinePayment(f.id, { baseUrl }), null)
    assert.equal((await db.get('SELECT count(*) AS n FROM payments WHERE id = ?', [f.id])).n, 1)
    assert.equal((await db.get('SELECT count(*) AS n FROM email_messages WHERE contact_id = ?', [f.contactId])).n, 0)
    assert.equal((await db.get('SELECT count(*) AS n FROM payment_automation_dispatches WHERE payment_id = ?', [f.id])).n, 0)
    const replay = response()
    await preparePaymentReceiptLink(request(f.id), replay)
    assert.equal(replay.payload.data.link, responses[0].payload.data.link)
    await db.run("UPDATE payments SET status = 'refunded' WHERE id = ?", [f.id])
    assert.equal(await getPublicOfflinePayment(after.public_payment_id, { baseUrl }), null)
  } finally { await f.cleanup() }
})

test('repair refuses unpaid, revoked, other gateway and cash payments without adding a public identity', async () => {
  const cases = [
    ...['pending', 'partial', 'refunded', 'void', 'deleted'].map(status => ({ status })),
    { provider: 'stripe', method: 'stripe' },
    { method: 'cash' }
  ]
  for (const options of cases) {
    const f = await fixture(options)
    try {
      const res = response()
      await preparePaymentReceiptLink(request(f.id), res)
      assert.equal(res.statusCode, 409, JSON.stringify(options))
      const row = await db.get('SELECT * FROM payments WHERE id = ?', [f.id])
      assert.equal(row.public_payment_id, null)
      assert.equal(row.payment_url, null)
      assert.equal(row.status, options.status || 'paid')
    } finally { await f.cleanup() }
  }
})

test('repair retains an existing public identity when only the URL is absent', async () => {
  const f = await fixture({ publicId: 'rstk_pay_ReceiptExistingIdentity' })
  try {
    const res = response()
    await preparePaymentReceiptLink(request(f.id), res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.data.link, `${baseUrl}/pay/rstk_pay_ReceiptExistingIdentity?receipt=1`)
    const row = await db.get('SELECT * FROM payments WHERE id = ?', [f.id])
    assert.equal(row.public_payment_id, 'rstk_pay_ReceiptExistingIdentity')
    assert.equal(row.reference, 'TEST-TRANSFER')
  } finally { await f.cleanup() }
})

test('receipt MCP operations use existing payment scopes and require idempotency', async () => {
  for (const [name, scope] of [['payments_prepare_receipt', 'ristak.write'], ['payments_send_receipt', 'ristak.execute']]) {
    const spec = domainToolSpecs.find(tool => tool.name === name)
    assert.ok(spec)
    assert.equal(spec.scope, scope)
    assert.equal(spec.access, 'write')
    assert.equal(spec.idempotencyRequired, true)
    assert.ok(spec.inputSchema.required.includes('idempotencyKey'))
  }
})
