import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { db, databaseReady, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import { getGigstackContactLink, getGigstackClientContext, linkGigstackContact, searchGigstackClients, resolveGigstackClientForPayment } from '../src/services/gigstackContactService.js'
import { recoverPaymentFiscalTax } from '../src/services/paymentFiscalTaxRecoveryService.js'
import { inspectGigstackPaymentForTransaction, issueGigstackInvoiceForTransaction, registerGigstackPaymentForTransactionInBackground, setGigstackInvoiceDeliveryDependenciesForTest } from '../src/services/gigstackInvoiceService.js'
import { paymentCapabilityToolSpecs } from '../src/mcp/paymentCapabilityTools.js'
import { invokeController } from '../src/mcp/controllerInvoker.js'

const originalFetch = globalThis.fetch
const token = livemode => `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ livemode, team: 'team_fixture', key_id: 'fixture' })).toString('base64url')}.signature`
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const client = (id = 'client_fixture', changes = {}) => ({ id, name: 'Cliente Fiscal', email: 'fiscal@example.test', phone: '+525512345678', tax_id: 'FISC910101AB1', tax_system: '612', legal_name: 'CLIENTE FISCAL', address: { zip: '03100' }, is_valid: true, team: 'team_fixture', livemode: false, ...changes })
const tax = { enabled: true, taxName: 'IVA', rateValue: 16, rateType: 'percentage', calculationMode: 'inclusive', subtotalAmount: 31250, taxAmount: 5000, totalAmount: 36250 }

async function fixture(run) {
  await databaseReady
  await initializeMasterKey()
  await savePaymentSettings({ taxes: { enabled: true, gigstackEnabled: true, gigstackSatConnected: true, gigstackTestApiToken: token(false), gigstackLiveApiToken: token(true), gigstackClientMatchMode: 'email', gigstackSendEmail: false, gigstackSendWhatsapp: false } }, { allowGigstackFiscalOverride: true })
  const suffix = crypto.randomUUID()
  const contactId = `fiscal_contact_${suffix}`
  const paymentId = `fiscal_payment_${suffix}`
  const sourcePaymentId = `fiscal_source_${suffix}`
  const planId = `fiscal_plan_${suffix}`
  await db.run('INSERT INTO contacts (id, full_name, phone) VALUES (?, ?, ?)', [contactId, 'Cliente Fiscal', '+525512345678'])
  await db.run("INSERT INTO payment_flows (id, contact_id, total_amount, currency, payment_provider, current_state, first_payment_invoice_id) VALUES (?, ?, 108750, 'MXN', 'offline', 'offline_plan_paused', ?)", [planId, contactId, sourcePaymentId])
  const baseMetadata = { paymentPlan: { flowId: planId }, stripe: { cardFunding: 'credit' } }
  await db.run("INSERT INTO payments (id, contact_id, amount, currency, status, payment_mode, payment_provider, metadata_json) VALUES (?, ?, 36250, 'MXN', 'paid', 'test', 'stripe', ?)", [paymentId, contactId, JSON.stringify(baseMetadata)])
  await db.run("INSERT INTO payments (id, contact_id, amount, currency, status, payment_mode, payment_provider, metadata_json) VALUES (?, ?, 36250, 'MXN', 'paid', 'test', 'stripe', ?)", [sourcePaymentId, contactId, JSON.stringify({ ...baseMetadata, tax })])
  await db.run("INSERT INTO installment_payments (id, flow_id, sequence, amount, status, payment_id) VALUES (?, ?, 1, 36250, 'paid', ?)", [`installment_${suffix}`, planId, paymentId])
  const read = () => db.get('SELECT * FROM payments WHERE id = ?', [paymentId])
  globalThis.fetch = async url => {
    if (new URL(url).pathname.endsWith('/clients/client_fixture')) return response({ data: client() })
    return response({ data: [client()], has_more: false })
  }
  try { await run({ contactId, paymentId, sourcePaymentId, planId, read }) } finally {
    await db.run('DELETE FROM gigstack_invoice_delivery_jobs WHERE payment_id IN (?, ?)', [paymentId, sourcePaymentId])
    await db.run('DELETE FROM gigstack_invoice_jobs WHERE payment_id IN (?, ?)', [paymentId, sourcePaymentId])
    await db.run('DELETE FROM gigstack_contact_links WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM installment_payments WHERE flow_id = ?', [planId])
    await db.run('DELETE FROM payment_flows WHERE id = ?', [planId])
    await db.run('DELETE FROM payments WHERE id IN (?, ?)', [paymentId, sourcePaymentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
}

afterEach(async () => {
  globalThis.fetch = originalFetch
  setGigstackInvoiceDeliveryDependenciesForTest(null)
  await setAppConfig('payments_settings', null)
})

test('manual binding previews without side effects and survives a contact without email', async () => {
  await fixture(async ({ contactId, paymentId, read }) => {
    const before = await read()
    const preview = await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test' })
    const context = await getGigstackClientContext('test')
    assert.equal(await getGigstackContactLink(contactId, context), null)
    await assert.rejects(linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test', dryRun: false }), { code: 'gigstack_client_link_conflict' })
    await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test', dryRun: false, expectedPreviewRevision: preview.previewRevision, actorId: 'admin_fixture' })
    assert.equal((await getGigstackContactLink(contactId, context)).actor_id, 'admin_fixture')
    assert.deepEqual(await read(), before)
    assert.equal((await db.get('SELECT email FROM contacts WHERE id = ?', [contactId])).email, null)
    const resolved = await resolveGigstackClientForPayment({ ...before, contact_email: '' }, { taxes: { gigstackEnabled: true, gigstackTestApiToken: token(false), gigstackClientMatchMode: 'email' } }, 'test')
    assert.deepEqual(resolved, { id: 'client_fixture' })
    assert.equal(await getGigstackContactLink(contactId, await getGigstackClientContext('live')), null)
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])).count, 0)
  })
})

test('binding rejects stale previews, wrong environment, wrong team and an invoice currently processing', async () => {
  await fixture(async ({ contactId, paymentId }) => {
    const args = { contactId, clientId: 'client_fixture', mode: 'test' }
    const preview = await linkGigstackContact(args)
    await db.run('UPDATE contacts SET phone = ? WHERE id = ?', ['+525500000000', contactId])
    await assert.rejects(linkGigstackContact({ ...args, dryRun: false, expectedPreviewRevision: preview.previewRevision }), { code: 'gigstack_client_link_conflict' })
    for (const changes of [{ livemode: true }, { team: 'team_other' }, { id: 'other_client' }]) {
      globalThis.fetch = async () => response({ data: client('client_fixture', changes) })
      await assert.rejects(linkGigstackContact(args), { code: 'gigstack_client_link_conflict' })
    }
    globalThis.fetch = async () => response({ data: client() })
    const current = await linkGigstackContact(args)
    await db.run("INSERT INTO gigstack_invoice_jobs (payment_id, payment_mode, status, lease_until_at_ms) VALUES (?, 'test', 'processing', ?)", [paymentId, Date.now() + 60000])
    await assert.rejects(linkGigstackContact({ ...args, dryRun: false, expectedPreviewRevision: current.previewRevision }), { code: 'gigstack_client_link_conflict' })
  })
})

test('client discovery keeps pagination and phone matching never trusts an incomplete or ambiguous scan', async () => {
  await fixture(async ({ contactId, read }) => {
    const calls = []
    globalThis.fetch = async url => {
      calls.push(String(url))
      const second = new URL(url).searchParams.has('next')
      return response({ data: second ? [client('client_second')] : [client('client_first')], has_more: !second })
    }
    const discovery = await searchGigstackClients({ contactId, mode: 'test', query: 'no match' })
    assert.equal(discovery.clients.length, 0)
    assert.equal(discovery.next, 'client_first')
    const settings = { taxes: { gigstackEnabled: true, gigstackTestApiToken: token(false) } }
    await assert.rejects(resolveGigstackClientForPayment({ ...await read(), contact_phone: '+525512345678' }, settings, 'test'), { code: 'gigstack_client_link_conflict' })
    assert.ok(calls.some(url => url.includes('next=client_first')))
    globalThis.fetch = async () => response({ data: [client('client_us', { phone: '+15512345678' })], has_more: false })
    await assert.rejects(resolveGigstackClientForPayment({ ...await read(), contact_phone: '+525512345678' }, settings, 'test'), { code: 'missing_gigstack_client' })
  })
})

test('tax recovery restores the exact included IVA on the paid installment without changing money, dates or source', async () => {
  await fixture(async ({ paymentId, sourcePaymentId, planId, read }) => {
    const before = await read()
    const sourceBefore = await db.get('SELECT * FROM payments WHERE id = ?', [sourcePaymentId])
    const planBefore = await db.get('SELECT * FROM payment_flows WHERE id = ?', [planId])
    const preview = await recoverPaymentFiscalTax(paymentId, sourcePaymentId)
    assert.equal(preview.subtotalAmount, 31250)
    assert.equal(preview.taxAmount, 5000)
    assert.deepEqual(await read(), before)
    await assert.rejects(recoverPaymentFiscalTax(paymentId, sourcePaymentId, { dryRun: false }), { code: 'payment_fiscal_tax_recovery_conflict' })
    const result = await recoverPaymentFiscalTax(paymentId, sourcePaymentId, { dryRun: false, expectedPreviewRevision: preview.previewRevision, actorId: 'admin_fixture' })
    assert.equal(result.changed, true)
    const after = await read()
    assert.deepEqual({ ...after, metadata_json: before.metadata_json, updated_at: before.updated_at }, before)
    assert.equal(JSON.parse(after.metadata_json).fiscalTaxRecovery.actorId, 'admin_fixture')
    assert.deepEqual(await db.get('SELECT * FROM payments WHERE id = ?', [sourcePaymentId]), sourceBefore)
    assert.deepEqual(await db.get('SELECT * FROM payment_flows WHERE id = ?', [planId]), planBefore)
  })
})

test('tax repair never overwrites an explicit choice or accepts unrelated, mismatched or fiscally active payments', async () => {
  await fixture(async ({ paymentId, sourcePaymentId, read }) => {
    const original = await read()
    for (const extra of [{ tax: { enabled: false } }, { applyTax: false }, { gigstack: { pendingRemotePaymentId: 'remote' } }, { paymentPlan: { flowId: 'other' } }]) {
      await db.run('UPDATE payments SET metadata_json = ? WHERE id = ?', [JSON.stringify({ ...JSON.parse(original.metadata_json), ...extra }), paymentId])
      await assert.rejects(recoverPaymentFiscalTax(paymentId, sourcePaymentId), { code: 'payment_fiscal_tax_recovery_conflict' })
    }
    await db.run('UPDATE payments SET metadata_json = ?, currency = ? WHERE id = ?', [original.metadata_json, 'USD', paymentId])
    await assert.rejects(recoverPaymentFiscalTax(paymentId, sourcePaymentId), { code: 'payment_fiscal_tax_recovery_conflict' })
  })
})

test('manual issue previews, stamps once and delivers only PDF/XML to WhatsApp without charging again', async () => {
  await fixture(async ({ contactId, paymentId, sourcePaymentId, read }) => {
    const binding = await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test' })
    await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test', dryRun: false, expectedPreviewRevision: binding.previewRevision })
    const taxPreview = await recoverPaymentFiscalTax(paymentId, sourcePaymentId)
    await recoverPaymentFiscalTax(paymentId, sourcePaymentId, { dryRun: false, expectedPreviewRevision: taxPreview.previewRevision })
    const calls = []
    const sent = []
    globalThis.fetch = async (url, options) => {
      calls.push([options.method, new URL(url).pathname])
      if (new URL(url).pathname.includes('/clients/')) return response({ data: client() })
      if (options.method === 'POST') {
        const body = JSON.parse(options.body)
        assert.deepEqual(body.client, { id: 'client_fixture' })
        assert.equal(body.payment_form, '04')
        assert.equal(body.items[0].unit_price, 36250)
        assert.equal(body.items[0].taxes[0].inclusive, true)
        assert.equal(body.ignore_emails, true)
        assert.equal(body.automation_type, 'pue_invoice')
        assert.equal((await db.get('SELECT status FROM gigstack_invoice_jobs WHERE payment_id = ?', [paymentId])).status, 'processing')
        return response({ data: { id: 'remote_payment_fixture', client: { id: 'client_fixture' }, status: 'succeeded', livemode: false, invoices: ['invoice_fixture'] } })
      }
      if (new URL(url).pathname.endsWith('/files')) return response({ data: { pdf: `data:application/pdf;base64,${Buffer.from('%PDF-1.4 fixture').toString('base64')}`, xml: '<?xml version="1.0"?><cfdi/>' } })
      if (new URL(url).pathname.includes('/payments/')) return response({ data: { id: 'remote_payment_fixture', status: 'succeeded', livemode: false, invoices: ['invoice_fixture'] } })
      return response({ data: { id: 'invoice_fixture', status: 'stamped', uuid: 'uuid_fixture', livemode: false } })
    }
    setGigstackInvoiceDeliveryDependenciesForTest({
      resolvePaymentWhatsAppRoute: async () => ({ available: true, transport: 'qr', phoneNumberId: 'qr_fixture' }),
      paymentWhatsAppRouteArgs: () => ({ transport: 'qr', phoneNumberId: 'qr_fixture' }),
      sendWhatsAppApiDocumentMessage: async args => { sent.push(args); return { id: `doc_${sent.length}`, status: 'sent' } },
      sendEmailToContact: async () => { throw new Error('Unexpected email') }
    })
    const before = await read()
    const args = { deliveryChannel: 'whatsapp' }
    const preview = await issueGigstackInvoiceForTransaction(paymentId, args)
    assert.equal(preview.client.taxId, 'FISC910101AB1')
    assert.equal(calls.some(([method]) => method === 'POST'), false)
    assert.deepEqual(await read(), before)
    await assert.rejects(issueGigstackInvoiceForTransaction(paymentId, { ...args, dryRun: false }), { code: 'gigstack_invoice_preview_changed' })
    const result = await issueGigstackInvoiceForTransaction(paymentId, { ...args, dryRun: false, expectedPreviewRevision: preview.previewRevision, actorId: 'admin_fixture' })
    assert.equal(result.delivery.filter(result => result.sent).length, 2)
    assert.equal(sent.length, 2)
    assert.equal(sent.every(message => message.contactId === contactId && message.sensitive), true)
    const next = await issueGigstackInvoiceForTransaction(paymentId, args)
    await issueGigstackInvoiceForTransaction(paymentId, { ...args, dryRun: false, expectedPreviewRevision: next.previewRevision })
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1)
    assert.equal(sent.length, 2)
    assert.equal((await read()).amount, before.amount)
  })
})

test('automatic registration retains the remote client association for the next payment', async () => {
  await fixture(async ({ contactId, sourcePaymentId }) => {
    const calls = []
    globalThis.fetch = async (url, options) => {
      calls.push([options.method, String(url)])
      if (options.method === 'POST') return response({ data: { id: 'remote_auto_fixture', client: { id: 'client_fixture' }, status: 'succeeded', livemode: false, invoices: ['invoice_fixture'] } })
      if (String(url).includes('/clients?')) return response({ data: [client()], has_more: false })
      return response({ data: { status: 'stamped', uuid: 'uuid_auto', livemode: false } })
    }
    assert.equal((await registerGigstackPaymentForTransactionInBackground(sourcePaymentId)).registered, true)
    assert.equal((await getGigstackContactLink(contactId, await getGigstackClientContext('test'))).client_id, 'client_fixture')
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1)
  })
})

test('manual issuance rejects incomplete receivers, stale identity and an active lease before registering', async () => {
  await fixture(async ({ contactId, sourcePaymentId }) => {
    const link = await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test' })
    await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test', dryRun: false, expectedPreviewRevision: link.previewRevision })
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.method, 'GET')
      return response({ data: client('client_fixture', { is_valid: false }) })
    }
    await assert.rejects(issueGigstackInvoiceForTransaction(sourcePaymentId), { code: 'gigstack_client_fiscal_incomplete' })
    globalThis.fetch = async () => response({ data: client() })
    const preview = await issueGigstackInvoiceForTransaction(sourcePaymentId)
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.method, 'GET')
      return response({ data: client('client_fixture', { tax_id: 'OTHER910101AB1' }) })
    }
    await assert.rejects(issueGigstackInvoiceForTransaction(sourcePaymentId, { dryRun: false, expectedPreviewRevision: preview.previewRevision }), { code: 'gigstack_invoice_preview_changed' })
    globalThis.fetch = async () => response({ data: client() })
    await db.run("INSERT INTO gigstack_invoice_jobs (payment_id, payment_mode, status, claim_token, lease_until_at_ms) VALUES (?, 'test', 'processing', 'other-worker', ?)", [sourcePaymentId, Date.now() + 60000])
    await assert.rejects(issueGigstackInvoiceForTransaction(sourcePaymentId, { dryRun: false, expectedPreviewRevision: preview.previewRevision }), { code: 'gigstack_invoice_busy' })
    assert.equal((await db.get('SELECT claim_token FROM gigstack_invoice_jobs WHERE payment_id = ?', [sourcePaymentId])).claim_token, 'other-worker')
  })
})

test('backend tools require an administrator, idempotency and reviewed previews for application', async () => {
  const tools = paymentCapabilityToolSpecs.filter(tool => ['payments_search_fiscal_clients', 'payments_link_fiscal_contact', 'payments_recover_payment_tax', 'payments_issue_fiscal_invoice'].includes(tool.name))
  assert.equal(tools.length, 4)
  for (const tool of tools) {
    assert.equal(tool.adminOnly, true)
    await assert.rejects(tool.execute({ invoke: (handler, request) => invokeController(handler, { user: { id: 2, role: 'member' } }, request) }, { contactId: 'contact', paymentId: 'payment', mode: 'test', idempotencyKey: 'fixture-key' }), { code: 'admin_required' })
  }
})

test('an acknowledgement for another receiver keeps its remote identity but blocks delivery and a second registration', async () => {
  await fixture(async ({ contactId, sourcePaymentId }) => {
    const preview = await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test' })
    await linkGigstackContact({ contactId, clientId: 'client_fixture', mode: 'test', dryRun: false, expectedPreviewRevision: preview.previewRevision })
    const calls = []
    globalThis.fetch = async (url, options) => {
      calls.push(options.method)
      if (String(url).includes('/clients/')) return response({ data: client() })
      return response({ data: { id: 'remote_wrong_receiver', client: { id: 'other_receiver' }, status: 'succeeded', invoices: ['invoice_wrong'], livemode: false } })
    }
    const issue = await issueGigstackInvoiceForTransaction(sourcePaymentId, { deliveryChannel: 'whatsapp' })
    await assert.rejects(issueGigstackInvoiceForTransaction(sourcePaymentId, { dryRun: false, deliveryChannel: 'whatsapp', expectedPreviewRevision: issue.previewRevision }), { code: 'gigstack_payment_client_mismatch' })
    const fiscal = JSON.parse((await db.get('SELECT metadata_json FROM payments WHERE id = ?', [sourcePaymentId])).metadata_json).gigstack
    assert.equal(fiscal.pendingRemotePaymentId, 'remote_wrong_receiver')
    assert.equal(fiscal.expectedClientId, 'client_fixture')
    await assert.rejects(inspectGigstackPaymentForTransaction(sourcePaymentId), { code: 'gigstack_payment_client_mismatch' })
    assert.equal(calls.filter(method => method === 'POST').length, 1)
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM gigstack_invoice_delivery_jobs WHERE payment_id = ?', [sourcePaymentId])).count, 0)
  })
})
