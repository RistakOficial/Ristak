import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db, databaseReady } from '../src/config/database.js'
import { saveEmailMessageRow } from '../src/services/emailService.js'
import { upsertHighLevelConversationMessage } from '../src/services/highlevelConversationsSyncService.js'
import { upsertMetaSocialMessage } from '../src/services/metaSocialMessagingService.js'
import { syncYCloudMessageRecords } from '../src/services/whatsappApiService.js'
import {
  acquireConversationalInboundCommitLock,
  withConversationalInboundCommitLock
} from '../src/services/conversationalInboundCommitLockService.js'

await databaseReady

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function insertContact({ id, ghlContactId, phone, email, name }) {
  await db.run(`
    INSERT INTO contacts (
      id, ghl_contact_id, phone, email, full_name, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [id, ghlContactId || null, phone || null, email || null, name])
}

async function cleanupOwnershipFixture({ contactIds, appointmentIds = [], messageIds = [] }) {
  if (messageIds.length) {
    const placeholders = messageIds.map(() => '?').join(', ')
    await db.run(`DELETE FROM chat_inbound_message_claims WHERE message_id IN (${placeholders})`, messageIds).catch(() => undefined)
    await db.run(`DELETE FROM whatsapp_api_attribution WHERE whatsapp_api_message_id IN (${placeholders})`, messageIds).catch(() => undefined)
    await db.run(`DELETE FROM whatsapp_api_messages WHERE id IN (${placeholders})`, messageIds).catch(() => undefined)
    await db.run(`DELETE FROM meta_social_messages WHERE id IN (${placeholders})`, messageIds).catch(() => undefined)
    await db.run(`DELETE FROM email_messages WHERE id IN (${placeholders})`, messageIds).catch(() => undefined)
  }
  if (appointmentIds.length) {
    const placeholders = appointmentIds.map(() => '?').join(', ')
    await db.run(`DELETE FROM appointments WHERE id IN (${placeholders})`, appointmentIds).catch(() => undefined)
  }
  if (contactIds.length) {
    const placeholders = contactIds.map(() => '?').join(', ')
    await db.run(`DELETE FROM chat_inbound_message_claims WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM whatsapp_api_attribution WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM whatsapp_api_messages WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM meta_social_messages WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM email_messages WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM whatsapp_api_contacts WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM meta_social_contacts WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM contact_phone_numbers WHERE contact_id IN (${placeholders})`, contactIds).catch(() => undefined)
    await db.run(`DELETE FROM contacts WHERE id IN (${placeholders})`, contactIds).catch(() => undefined)
  }
}

test('Email, HighLevel, Meta y WhatsApp no reparentan una burbuja deduplicada', async () => {
  const suffix = randomUUID()
  const contactA = `ownership_a_${suffix}`
  const contactB = `ownership_b_${suffix}`
  const ghlA = `ghl_ownership_a_${suffix}`
  const ghlB = `ghl_ownership_b_${suffix}`
  const phoneA = `+5211${String(Date.now()).slice(-8)}`
  const phoneB = `+5222${String(Date.now() + 1).slice(-8)}`
  const emailA = `ownership-a-${suffix}@example.test`
  const emailB = `ownership-b-${suffix}@example.test`
  const emailMessageId = `email_ownership_${suffix}`
  const ghlRemoteMessageId = `ghl_ownership_${suffix}`
  const metaRemoteMessageId = `meta_ownership_${suffix}`
  const whatsappRemoteMessageId = `wa_ownership_${suffix}`
  const businessPhone = `+5299${String(Date.now() + 2).slice(-8)}`
  const ownedMessageIds = [emailMessageId]

  try {
    await insertContact({ id: contactA, ghlContactId: ghlA, phone: phoneA, email: emailA, name: 'Dueño A' })
    await insertContact({ id: contactB, ghlContactId: ghlB, phone: phoneB, email: emailB, name: 'Dueño B' })

    const emailRow = {
      id: emailMessageId,
      direction: 'inbound',
      status: 'delivered',
      toEmail: 'ventas@example.test',
      fromEmail: emailA,
      subject: 'Ownership email',
      text: 'Corrección explícita',
      messageTimestamp: '2026-07-14T18:00:00.000Z'
    }
    await saveEmailMessageRow({ ...emailRow, contactId: contactA })
    await saveEmailMessageRow({ ...emailRow, contactId: contactB, fromEmail: emailB })
    assert.equal((await db.get('SELECT contact_id FROM email_messages WHERE id = ?', [emailMessageId]))?.contact_id, contactA)

    const highLevelMessage = {
      id: ghlRemoteMessageId,
      messageType: 'TYPE_WHATSAPP',
      body: 'Corrección explícita GHL',
      direction: 'inbound',
      createdAt: '2026-07-14T18:01:00.000Z'
    }
    await upsertHighLevelConversationMessage({
      message: { ...highLevelMessage, contactId: ghlA },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })
    await upsertHighLevelConversationMessage({
      message: { ...highLevelMessage, contactId: ghlB },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })
    const ghlRow = await db.get(
      'SELECT id, contact_id FROM whatsapp_api_messages WHERE ycloud_message_id = ?',
      [ghlRemoteMessageId]
    )
    assert.equal(ghlRow?.contact_id, contactA)
    ownedMessageIds.push(ghlRow.id)

    const metaMessage = {
      platform: 'instagram',
      metaMessageId: metaRemoteMessageId,
      senderId: `sender_${suffix}`,
      recipientId: `recipient_${suffix}`,
      instagramAccountId: `ig_business_${suffix}`,
      direction: 'inbound',
      status: 'delivered',
      messageType: 'text',
      messageText: 'Corrección explícita Meta',
      messageTimestamp: '2026-07-14T18:02:00.000Z',
      raw: { provider: 'meta-test' },
      referral: null,
      isMutation: false
    }
    const firstMeta = await upsertMetaSocialMessage({
      socialContactId: null,
      contactId: contactA,
      socialMessage: metaMessage,
      historyImport: true
    })
    await upsertMetaSocialMessage({
      socialContactId: null,
      contactId: contactB,
      socialMessage: metaMessage,
      historyImport: true
    })
    assert.equal((await db.get('SELECT contact_id FROM meta_social_messages WHERE id = ?', [firstMeta.messageId]))?.contact_id, contactA)
    ownedMessageIds.push(firstMeta.messageId)

    const whatsappRecord = {
      id: whatsappRemoteMessageId,
      provider: 'ycloud',
      to: businessPhone,
      sendTime: '2026-07-14T18:03:00.000Z',
      type: 'text',
      text: { body: 'Corrección explícita WhatsApp' }
    }
    const firstWhatsapp = await syncYCloudMessageRecords([{
      ...whatsappRecord,
      contactId: contactA,
      from: phoneA
    }], {
      businessPhoneHints: [businessPhone],
      direction: 'inbound',
      eventType: 'whatsapp.inbound_message.received',
      source: 'ownership_test'
    })
    const secondWhatsapp = await syncYCloudMessageRecords([{
      ...whatsappRecord,
      contactId: contactB,
      from: phoneB
    }], {
      businessPhoneHints: [businessPhone],
      direction: 'inbound',
      eventType: 'whatsapp.inbound_message.received',
      source: 'ownership_test'
    })
    assert.equal(firstWhatsapp.failed, 0)
    assert.equal(secondWhatsapp.failed, 0)
    const whatsappRow = await db.get(
      'SELECT id, contact_id FROM whatsapp_api_messages WHERE provider_message_id = ?',
      [whatsappRemoteMessageId]
    )
    assert.equal(whatsappRow?.contact_id, contactA)
    ownedMessageIds.push(whatsappRow.id)

    // El único caso permitido en un UPSERT es completar una fila legacy sin
    // dueño; una propiedad no nula nunca se sobreescribe.
    await db.run('UPDATE email_messages SET contact_id = NULL WHERE id = ?', [emailMessageId])
    await saveEmailMessageRow({ ...emailRow, contactId: contactB, fromEmail: emailB })
    assert.equal((await db.get('SELECT contact_id FROM email_messages WHERE id = ?', [emailMessageId]))?.contact_id, contactB)
  } finally {
    await cleanupOwnershipFixture({ contactIds: [contactA, contactB], messageIds: ownedMessageIds.filter(Boolean) })
  }
})

test('un UPSERT bajo el lock de B no puede sacar de A un inbound después del fence terminal de A', async () => {
  const suffix = randomUUID()
  const contactA = `ownership_fence_a_${suffix}`
  const contactB = `ownership_fence_b_${suffix}`
  const messageId = `ownership_fence_message_${suffix}`
  const appointmentId = `ownership_fence_appointment_${suffix}`
  let releaseTerminal
  let terminalStarted
  let terminalPromise = null
  let writerPromise = null
  const terminalReleaseGate = new Promise(resolve => { releaseTerminal = resolve })
  const terminalStartedGate = new Promise(resolve => { terminalStarted = resolve })

  try {
    await insertContact({ id: contactA, email: `fence-a-${suffix}@example.test`, name: 'Fence A' })
    await insertContact({ id: contactB, email: `fence-b-${suffix}@example.test`, name: 'Fence B' })
    await saveEmailMessageRow({
      id: messageId,
      contactId: contactA,
      direction: 'inbound',
      status: 'delivered',
      fromEmail: `fence-a-${suffix}@example.test`,
      toEmail: 'ventas@example.test',
      subject: 'Corrección con fence',
      text: 'Mejor otra hora',
      messageTimestamp: '2026-07-14T18:04:00.000Z'
    })

    terminalPromise = db.transaction(async transactionDatabase => {
      await acquireConversationalInboundCommitLock({
        contactId: contactA,
        channel: 'email',
        database: transactionDatabase,
        dialect: 'sqlite'
      })
      assert.equal((await transactionDatabase.get(
        'SELECT contact_id FROM email_messages WHERE id = ?',
        [messageId]
      ))?.contact_id, contactA)
      terminalStarted()
      await terminalReleaseGate
      await transactionDatabase.run(
        `INSERT INTO appointments (id, contact_id, title, status, start_time, end_time)
         VALUES (?, ?, 'Cita protegida', 'confirmed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [appointmentId, contactA]
      )
    })

    await terminalStartedGate
    let writerSettled = false
    writerPromise = withConversationalInboundCommitLock({
      contactId: contactB,
      channel: 'email',
      dialect: 'sqlite'
    }, () => saveEmailMessageRow({
      id: messageId,
      contactId: contactB,
      direction: 'inbound',
      status: 'delivered',
      fromEmail: `fence-b-${suffix}@example.test`,
      toEmail: 'ventas@example.test',
      subject: 'Corrección con fence',
      text: 'Mejor otra hora',
      messageTimestamp: '2026-07-14T18:04:00.000Z'
    })).finally(() => { writerSettled = true })

    await delay(75)
    assert.equal(writerSettled, false)
    releaseTerminal()
    await terminalPromise
    await writerPromise

    assert.equal((await db.get('SELECT contact_id FROM email_messages WHERE id = ?', [messageId]))?.contact_id, contactA)
    assert.equal((await db.get('SELECT contact_id FROM appointments WHERE id = ?', [appointmentId]))?.contact_id, contactA)
  } finally {
    releaseTerminal?.()
    await terminalPromise?.catch(() => undefined)
    await writerPromise?.catch(() => undefined)
    await cleanupOwnershipFixture({
      contactIds: [contactA, contactB],
      appointmentIds: [appointmentId],
      messageIds: [messageId]
    })
  }
})

test('todos los writers canónicos, espejos e históricos conservan contact_id existente', async () => {
  const audits = [
    { file: '../src/services/emailService.js', expected: 1 },
    { file: '../src/services/highlevelConversationsSyncService.js', expected: 6 },
    { file: '../src/services/metaSocialMessagingService.js', expected: 2 },
    { file: '../src/services/whatsappApiService.js', expected: 1 },
    { file: '../src/controllers/highlevelController.js', expected: 3, scopeBareAssignmentsToMessageSql: true }
  ]
  const safePattern = /contact_id\s*=\s*COALESCE\(\s*(?:whatsapp_api_messages|email_messages|meta_social_messages)\.contact_id\s*,\s*excluded\.contact_id\s*\)/g
  const unsafeReversedPattern = /contact_id\s*=\s*COALESCE\(\s*excluded\.contact_id\s*,\s*(?:whatsapp_api_messages|email_messages|meta_social_messages)\.contact_id\s*\)/g
  const bareAssignmentPattern = /contact_id\s*=\s*excluded\.contact_id/g

  for (const audit of audits) {
    const source = await readFile(new URL(audit.file, import.meta.url), 'utf8')
    assert.equal(source.match(safePattern)?.length || 0, audit.expected, audit.file)
    assert.equal(source.match(unsafeReversedPattern)?.length || 0, 0, audit.file)
    if (audit.scopeBareAssignmentsToMessageSql) {
      const messageSql = [...source.matchAll(/INSERT INTO\s+(?:whatsapp_api_messages|email_messages|meta_social_messages)\b/g)]
        .map(match => source.slice(match.index, source.indexOf('`', match.index)))
        .join('\n')
      assert.equal(messageSql.match(bareAssignmentPattern)?.length || 0, 0, audit.file)
    } else {
      assert.equal(source.match(bareAssignmentPattern)?.length || 0, 0, audit.file)
    }
  }

  const highLevelSource = await readFile(
    new URL('../src/services/highlevelConversationsSyncService.js', import.meta.url),
    'utf8'
  )
  const historicalSection = highLevelSource.slice(highLevelSource.indexOf('async function persistHistoricalWhatsAppRows'))
  assert.equal(historicalSection.match(safePattern)?.length || 0, 3)
  assert.equal(historicalSection.match(unsafeReversedPattern)?.length || 0, 0)
  assert.equal(historicalSection.match(bareAssignmentPattern)?.length || 0, 0)
})
