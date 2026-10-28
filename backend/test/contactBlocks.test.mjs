import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { db, databaseReady, setAppConfig, repairSoftDeletedContactsWithNewInboundActivity } from '../src/config/database.js'
import { addContactBlock, removeContactBlock, findContactBlock, assertContactNotBlocked, normalizeBlockedIdentity, CONTACT_BLOCK_PUBLIC_MESSAGE } from '../src/services/contactBlockService.js'
import { createContactBlock, getContactBlocks, deleteContactBlock } from '../src/controllers/contactBlocksController.js'
import { restoreSoftDeletedContactForNewInbound } from '../src/services/contactIdentityService.js'
import { createLocalAppointment, upsertLocalAppointment, createLocalCalendar } from '../src/services/localCalendarService.js'
import { createPublicAppointment } from '../src/controllers/calendarsController.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { captureQrChatMessage, sendWhatsAppApiTextMessage, processMetaDirectWebhookPayload } from '../src/services/whatsappApiService.js'
import { createBlock, createSite, createSubmissionFromRequest, createImportedSiteFromHtml, updateSite } from '../src/services/sitesService.js'
import { resolveInboundAgentForContact } from '../src/agents/conversational/runner.js'

await databaseReady
const admin = { id: 'block-test-admin', role: 'admin' }
const recorder = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this }, json(body) { this.body = body; return this } })
const blocked = error => error.status === 403 && error.code === 'request_unavailable' && error.message === CONTACT_BLOCK_PUBLIC_MESSAGE

async function fixture(t, options = {}) {
  const id = `block_test_${randomUUID()}`
  const email = `${randomUUID()}@example.test`
  const phone = '+19995550101'
  await db.run('INSERT INTO contacts (id, full_name, email, phone, deleted_at) VALUES (?, ?, ?, ?, ?)', [id, 'Persona ficticia', email, phone, options.archived ? '2020-01-01 00:00:00' : null])
  t.after(async () => {
    await db.run('DELETE FROM appointment_participants WHERE contact_id = ?', [id])
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [id])
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [id])
    await db.run('DELETE FROM contacts WHERE id = ?', [id])
    await db.run('DELETE FROM contact_blocks')
  })
  return { id, email, phone }
}

test('exact identity normalization never uses names, substrings, country suffixes or email aliases', async () => {
  assert.equal(normalizeBlockedIdentity('phone', '+52 1 55 1234 5678'), '+525512345678')
  assert.equal(normalizeBlockedIdentity('phone', '0052 55 1234 5678'), '+525512345678')
  assert.equal(normalizeBlockedIdentity('phone', '+1 5512345678'), '+15512345678')
  for (const value of ['5512345678', 'Esmeralda Morales', '+525512345678999999', '123', '+52EXT5512345678']) assert.equal(normalizeBlockedIdentity('phone', value), '')
  assert.equal(normalizeBlockedIdentity('email', ' ANA+test@Example.test '), 'ana+test@example.test')
})

test('administrative handlers reject employees on reads and mutations, and invalid identities', async () => {
  for (const handler of [createContactBlock, getContactBlocks, deleteContactBlock]) {
    const res = recorder()
    await handler({ user: { role: 'employee' }, body: {}, query: {}, params: {} }, res)
    assert.equal(res.statusCode, 403)
    assert.equal(res.body.code, 'admin_required')
  }
  const res = recorder()
  await createContactBlock({ user: admin, body: { identityType: 'phone', identityValue: '5555555555' } }, res)
  assert.equal(res.statusCode, 400)
})

test('blocking is idempotent, exact, reversible, and survives deletion of the CRM row', async t => {
  const contact = await fixture(t)
  const a = await addContactBlock({ identityType: 'email', identityValue: contact.email.toUpperCase(), reason: 'Private reason must never reach public responses' })
  const b = await addContactBlock({ identityType: 'email', identityValue: contact.email })
  assert.equal(a.id, b.id)
  await assert.rejects(() => assertContactNotBlocked({ contactId: contact.id }), blocked)
  await assert.rejects(() => assertContactNotBlocked({ phone: contact.phone }), blocked)
  assert.equal(await findContactBlock({ email: `other-${contact.email}` }), null)
  await db.run('DELETE FROM contacts WHERE id = ?', [contact.id])
  await assert.rejects(() => assertContactNotBlocked({ email: contact.email }), blocked)
  await removeContactBlock(a.id)
  assert.equal(await findContactBlock({ email: contact.email }), null)
})

test('administrators can add, search, paginate and remove blocks without restoring archived contacts', async t => {
  const contact = await fixture(t, { archived: true })
  const created = recorder()
  await createContactBlock({ user: admin, body: { identityType: 'email', identityValue: contact.email, reason: 'Internal test reason' } }, created)
  assert.equal(created.statusCode, 201)
  const listed = recorder()
  await getContactBlocks({ user: admin, query: { search: contact.email.toUpperCase(), limit: 1, offset: 0 } }, listed)
  assert.equal(listed.body.data.total, 1)
  assert.equal(listed.body.data.items[0].id, created.body.data.id)
  const literal = recorder()
  await getContactBlocks({ user: admin, query: { search: '%' } }, literal)
  assert.equal(literal.body.data.total, 0)
  const removed = recorder()
  await deleteContactBlock({ user: admin, params: { id: created.body.data.id } }, removed)
  assert.equal(removed.body.success, true)
  assert.ok((await db.get('SELECT deleted_at FROM contacts WHERE id = ?', [contact.id])).deleted_at)
})

test('a new inbound cannot reactivate a blocked archived contact; removing the block restores the old behavior', async t => {
  const contact = await fixture(t, { archived: true })
  const rule = await addContactBlock({ identityType: 'contact', identityValue: contact.id })
  const inbound = { contactId: contact.id, messageTimestamp: '2099-01-01T00:00:00Z' }
  assert.equal((await restoreSoftDeletedContactForNewInbound(inbound)).reason, 'contact_blocked')
  assert.ok((await db.get('SELECT deleted_at FROM contacts WHERE id = ?', [contact.id])).deleted_at)
  await db.run("INSERT INTO whatsapp_api_messages (id, contact_id, direction, message_timestamp) VALUES (?, ?, 'inbound', '2099-01-01 00:00:00')", [randomUUID(), contact.id])
  await repairSoftDeletedContactsWithNewInboundActivity()
  assert.ok((await db.get('SELECT deleted_at FROM contacts WHERE id = ?', [contact.id])).deleted_at)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contact.id])
  await removeContactBlock(rule.id)
  assert.equal((await restoreSoftDeletedContactForNewInbound(inbound)).restored, true)
})

test('a secondary number is never automatically added as another person-wide rule', async t => {
  const contact = await fixture(t)
  await db.run('INSERT INTO contact_phone_numbers (id, contact_id, phone, is_primary, source) VALUES (?, ?, ?, 0, ?)', [randomUUID(), contact.id, '+525599955501', 'unverified_import'])
  await addContactBlock({ identityType: 'contact', identityValue: contact.id })
  assert.equal(await findContactBlock({ phone: '+525599955501' }), null)
  assert.ok(await findContactBlock({ phone: contact.phone }))
})

test('phone blocking preserves country boundaries and does not block contacts sharing a name', async t => {
  await fixture(t)
  await addContactBlock({ identityType: 'phone', identityValue: '+525512345678' })
  assert.ok(await findContactBlock({ phone: '+5215512345678' }))
  assert.equal(await findContactBlock({ phone: '+15512345678' }), null)
  assert.equal(await findContactBlock({ email: 'other@example.test' }), null)
})

test('local and imported-provider reservations reject blocked identities but can still store cancellation history', async t => {
  const contact = await fixture(t)
  await addContactBlock({ identityType: 'email', identityValue: contact.email })
  const appointment = { id: `block_appt_${randomUUID()}`, contactId: contact.id, startTime: '2099-01-01T15:00:00Z', endTime: '2099-01-01T16:00:00Z' }
  await assert.rejects(() => createLocalAppointment(appointment), blocked)
  await assert.rejects(() => upsertLocalAppointment({ ...appointment, source: 'ghl' }), blocked)
  await assert.rejects(() => upsertLocalAppointment({ ...appointment, appointmentStatus: 'completed' }), blocked)
  const history = await upsertLocalAppointment({ ...appointment, id: `history_${randomUUID()}`, startTime: '2000-01-01T15:00:00Z', endTime: '2000-01-01T16:00:00Z', appointmentStatus: 'completed' })
  assert.equal(history.appointmentStatus, 'completed')
  const cancelled = await upsertLocalAppointment({ ...appointment, appointmentStatus: 'cancelled' })
  assert.equal(cancelled.appointmentStatus, 'cancelled')
  await assert.rejects(() => upsertLocalAppointment({ ...appointment, appointmentStatus: 'confirmed' }), blocked)
})

test('QR, Meta WhatsApp and AI stop before saving incoming messages or sending a reply', async t => {
  const contact = await fixture(t, { archived: true })
  await addContactBlock({ identityType: 'phone', identityValue: contact.phone })
  const result = await captureQrChatMessage({ businessPhone: '+19995550102', contactPhone: contact.phone, wamid: `block_msg_${randomUUID()}`, direction: 'inbound', text: 'Solo prueba ficticia', timestamp: '2099-01-01T00:00:00Z' })
  assert.equal(result.reason, 'contact_blocked')
  assert.equal(result.isNew, false)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM whatsapp_api_messages WHERE contact_id = ?', [contact.id])).n, 0)
  assert.equal((await resolveInboundAgentForContact({ contactId: contact.id, channel: 'whatsapp' })).agentConfig, null)
  await assert.rejects(() => sendWhatsAppApiTextMessage({ contactId: contact.id, to: contact.phone, text: 'Must never send' }), blocked)
  const meta = await processMetaDirectWebhookPayload({ payload: { object: 'whatsapp_business_account', entry: [{ id: 'fictitious_waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'fictitious_phone', display_phone_number: '+19995550102' }, messages: [{ from: contact.phone.slice(1), id: randomUUID(), timestamp: '4070908800', type: 'text', text: { body: 'Fictitious blocked inbound' } }] } }] }] } })
  assert.ok(meta.some(item => item.reason === 'contact_blocked'))
})

test('an inbound resolving through a linked secondary number cannot update or reopen the blocked contact', async t => {
  const contact = await fixture(t, { archived: true })
  const secondary = '+19995550103'
  await db.run('INSERT INTO contact_phone_numbers (id, contact_id, phone, is_primary, source) VALUES (?, ?, ?, 0, ?)', [randomUUID(), contact.id, secondary, 'unverified_import'])
  await addContactBlock({ identityType: 'contact', identityValue: contact.id })
  assert.equal(await findContactBlock({ phone: secondary }), null, 'the secondary must not become a new global phone ban')
  const result = await processMetaDirectWebhookPayload({ payload: { object: 'whatsapp_business_account', entry: [{ id: 'fictitious_waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: 'fictitious_phone', display_phone_number: '+19995550102' }, messages: [{ from: secondary.slice(1), id: randomUUID(), timestamp: '4070908800', type: 'text', text: { body: 'Fictitious secondary inbound' } }] } }] }] } })
  assert.ok(result.some(item => item.reason === 'contact_blocked'))
  const row = await db.get('SELECT phone, deleted_at FROM contacts WHERE id = ?', [contact.id])
  assert.equal(row.phone, contact.phone)
  assert.ok(row.deleted_at)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM whatsapp_api_messages WHERE contact_id = ?', [contact.id])).n, 0)
  assert.equal(await findContactBlock({ phone: secondary }), null)
})

test('native and imported public forms return a generic error before submissions, contacts or automation side effects', async t => {
  const contact = await fixture(t, { archived: true })
  await addContactBlock({ identityType: 'email', identityValue: contact.email, reason: 'Never public' })
  await setAppConfig('sites_public_domain', 'example.test')
  await setAppConfig('sites_public_domain_verified', '1')
  await setAppConfig('sites_public_domain_checked_at', new Date().toISOString())
  const req = { headers: { host: 'example.test', 'user-agent': 'node-test' }, hostname: 'example.test', path: '/', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } }
  const site = await createSite({ name: 'Fictitious blocked form', slug: `blocked-${randomUUID()}`, siteType: 'standard_form', status: 'published', blankCanvas: true })
  const withBlock = await createBlock(site.id, { blockType: 'email', label: 'Email', required: true, settings: { systemFieldKey: 'email', internalName: 'email' } })
  const emailBlock = withBlock.blocks.find(block => block.blockType === 'email')
  await assert.rejects(() => createSubmissionFromRequest(req, { siteId: site.id, finalSubmit: true, responses: { [emailBlock.id]: contact.email.toUpperCase() } }), blocked)
  const created = await createImportedSiteFromHtml({ name: 'Fictitious imported blocked form', siteType: 'landing_page', filename: 'block.html', fileBase64: Buffer.from('<form id="lead"><input name="email" type="email"><button type="submit">Send</button></form>').toString('base64') })
  await updateSite(created.site.id, { status: 'published', theme: created.site.theme })
  await assert.rejects(() => createSubmissionFromRequest(req, { siteId: created.site.id, importedFormId: created.import.formMappings[0].formId, rawFields: { email: contact.email } }), blocked)
  for (const siteId of [site.id, created.site.id]) assert.equal((await db.get('SELECT COUNT(*) AS n FROM public_site_submissions WHERE site_id = ?', [siteId])).n, 0)
  assert.ok((await db.get('SELECT deleted_at FROM contacts WHERE id = ?', [contact.id])).deleted_at)
})

test('the public calendar returns a generic error and does not create an appointment', async t => {
  const contact = await fixture(t)
  const timezone = await getAccountTimezone()
  const start = DateTime.now().setZone(timezone).plus({ days: 5 }).startOf('day').set({ hour: 13 })
  const slug = `blocked-public-${randomUUID()}`
  const calendar = await createLocalCalendar({ name: 'Fictitious blocked calendar', slug, widgetSlug: slug,
    slotDuration: 60, slotDurationUnit: 'mins', slotInterval: 60, slotIntervalUnit: 'mins', allowBookingAfter: 0, allowBookingAfterUnit: 'hours', allowBookingFor: 365, allowBookingForUnit: 'days',
    openHours: [{ daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6], hours: [{ openHour: 13, openMinute: 0, closeHour: 16, closeMinute: 0 }] }] })
  await addContactBlock({ identityType: 'email', identityValue: contact.email })
  const headers = { host: 'example.test', 'user-agent': 'node-test' }
  const req = { params: { slug }, query: {}, body: { startTime: start.toISO(), timezone, name: 'Persona ficticia', email: contact.email, phone: contact.phone }, headers, hostname: 'example.test', protocol: 'https', ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' }, get(name) { return headers[name.toLowerCase()] || '' } }
  const res = recorder()
  await createPublicAppointment(req, res)
  assert.equal(res.statusCode, 403, JSON.stringify(res.body))
  assert.equal(res.body.error, CONTACT_BLOCK_PUBLIC_MESSAGE)
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM appointments WHERE calendar_id = ?', [calendar.id])).n, 0)
})
