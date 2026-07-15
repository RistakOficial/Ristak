import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { findNewerSubstantiveConversationalInbound } from '../src/services/conversationalInboundAuthorityService.js'

async function insertContact(contactId) {
  await db.run(`
    INSERT INTO contacts (id, full_name, created_at, updated_at)
    VALUES (?, 'Prueba de autoridad inbound', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [contactId])
}

async function insertWhatsAppInbound({
  id,
  contactId,
  remoteMessageId,
  messageTimestamp = null,
  createdAt
}) {
  await db.run(`
    INSERT INTO whatsapp_api_messages (
      id, provider, ycloud_message_id, contact_id, transport, direction,
      message_type, message_text, message_timestamp, created_at, updated_at
    ) VALUES (?, 'highlevel', ?, ?, 'ghl_whatsapp', 'inbound',
              'text', ?, ?, ?, ?)
  `, [id, remoteMessageId, contactId, id, messageTimestamp, createdAt, createdAt])
}

async function cleanupContact(contactId) {
  await db.run('DELETE FROM chat_inbound_message_claims WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('dos filas renderizables del mismo mensaje remoto no se invalidan entre sí', async () => {
  const suffix = randomUUID()
  const contactId = `authority_envelope_${suffix}`
  const handledMessageId = `authority_handled_${suffix}`
  const siblingMessageId = `authority_sibling_${suffix}`
  const newerMessageId = `authority_newer_${suffix}`
  const remoteMessageId = `ghl_remote_${suffix}`

  try {
    await insertContact(contactId)
    await insertWhatsAppInbound({
      id: handledMessageId,
      contactId,
      remoteMessageId,
      messageTimestamp: '2099-07-14T12:00:00.000Z',
      createdAt: '2099-07-14 12:00:01'
    })
    await insertWhatsAppInbound({
      id: siblingMessageId,
      contactId,
      remoteMessageId,
      messageTimestamp: '2099-07-14T12:00:00.000Z',
      createdAt: '2099-07-14 12:00:01'
    })

    const onlySibling = await findNewerSubstantiveConversationalInbound({
      contactId,
      handledMessageId,
      channel: 'ghl_whatsapp'
    })
    assert.equal(onlySibling.checked, true)
    assert.equal(onlySibling.newerMessage, null)
    assert.equal(onlySibling.reason, 'current')

    await insertWhatsAppInbound({
      id: newerMessageId,
      contactId,
      remoteMessageId: `ghl_remote_newer_${suffix}`,
      messageTimestamp: '2099-07-14T12:01:00.000Z',
      createdAt: '2099-07-14 12:01:01'
    })

    const trulyNewer = await findNewerSubstantiveConversationalInbound({
      contactId,
      handledMessageId,
      channel: 'whatsapp'
    })
    assert.equal(trulyNewer.checked, true)
    assert.equal(trulyNewer.newerMessage?.id, newerMessageId)
    assert.equal(trulyNewer.reason, 'newer_substantive_inbound')
  } finally {
    await cleanupContact(contactId)
  }
})

test('la autoridad interpreta timestamps SQLite como UTC y no mezcla claimed_at con created_at', async () => {
  const previousTimezone = process.env.TZ
  const suffix = randomUUID()
  const utcContactId = `authority_utc_${suffix}`
  const claimContactId = `authority_claim_${suffix}`
  const utcHandledId = `authority_utc_handled_${suffix}`
  const utcNewerId = `authority_utc_newer_${suffix}`
  const claimHandledId = `authority_claim_handled_${suffix}`
  const claimCandidateId = `authority_claim_candidate_${suffix}`

  process.env.TZ = 'America/Ciudad_Juarez'
  try {
    await insertContact(utcContactId)
    await insertWhatsAppInbound({
      id: utcHandledId,
      contactId: utcContactId,
      remoteMessageId: `remote_utc_handled_${suffix}`,
      createdAt: '2099-07-14 12:00:00'
    })
    await insertWhatsAppInbound({
      id: utcNewerId,
      contactId: utcContactId,
      remoteMessageId: `remote_utc_newer_${suffix}`,
      createdAt: '2099-07-14T17:30:00.000Z'
    })

    const utcOrder = await findNewerSubstantiveConversationalInbound({
      contactId: utcContactId,
      handledMessageId: utcHandledId,
      channel: 'whatsapp'
    })
    assert.equal(utcOrder.newerMessage?.id, utcNewerId)

    await insertContact(claimContactId)
    await insertWhatsAppInbound({
      id: claimHandledId,
      contactId: claimContactId,
      remoteMessageId: `remote_claim_handled_${suffix}`,
      createdAt: '2099-07-14 12:00:00'
    })
    await insertWhatsAppInbound({
      id: claimCandidateId,
      contactId: claimContactId,
      remoteMessageId: `remote_claim_candidate_${suffix}`,
      createdAt: '2099-07-14 11:00:00'
    })
    await db.run(`
      INSERT INTO chat_inbound_message_claims (
        channel, message_id, contact_id, message_timestamp, claimed_at
      ) VALUES ('whatsapp', ?, ?, NULL, '2099-07-15T12:00:00.000Z')
    `, [claimCandidateId, claimContactId])

    const mixedClaim = await findNewerSubstantiveConversationalInbound({
      contactId: claimContactId,
      handledMessageId: claimHandledId,
      channel: 'whatsapp'
    })
    assert.equal(mixedClaim.checked, true)
    assert.equal(mixedClaim.newerMessage, null)
    assert.equal(mixedClaim.reason, 'current')
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
    await cleanupContact(utcContactId)
    await cleanupContact(claimContactId)
  }
})
