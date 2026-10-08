import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { db } from '../src/config/database.js'
import {
  assignAgentToConversation,
  claimConversationInboundMessage,
  getConversationState,
  setConversationSignal,
  setConversationStatus
} from '../src/services/conversationalAgentService.js'

import {
  runManualChatSendAfterHumanTakeover
} from '../src/controllers/manualChatTakeover.js'

test('el takeover por contacto termina antes de permitir el envío manual', async () => {
  const events = []
  let releaseTakeover
  const takeoverReleased = new Promise((resolve) => {
    releaseTakeover = resolve
  })

  const pending = runManualChatSendAfterHumanTakeover({
    contactId: 'contact_manual_order',
    toPhone: '+525500000001',
    send: async () => {
      events.push('provider_send')
      return { id: 'provider_manual_order' }
    }
  }, {
    markByContact: async (contactId, options) => {
      events.push(`takeover_started:${contactId}:${options.updatedBy}`)
      await takeoverReleased
      events.push('takeover_finished')
    },
    markByPhone: async () => {
      events.push('unexpected_phone_fallback')
    }
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, [
    'takeover_started:contact_manual_order:human'
  ])

  releaseTakeover()
  const result = await pending
  assert.deepEqual(result, { id: 'provider_manual_order' })
  assert.deepEqual(events, [
    'takeover_started:contact_manual_order:human',
    'takeover_finished',
    'provider_send'
  ])
})

test('si no puede confirmarse el takeover, el proveedor manual no se toca', async () => {
  let providerCalls = 0

  await assert.rejects(
    () => runManualChatSendAfterHumanTakeover({
      contactId: 'contact_manual_failure',
      send: async () => {
        providerCalls += 1
      }
    }, {
      markByContact: async () => {
        throw Object.assign(new Error('takeover database unavailable'), {
          code: 'TAKEOVER_UNAVAILABLE'
        })
      }
    }),
    (error) => {
      assert.equal(error.code, 'TAKEOVER_UNAVAILABLE')
      return true
    }
  )

  assert.equal(providerCalls, 0)
})

test('sin contactId usa el teléfono como identidad antes del envío', async () => {
  const events = []

  await runManualChatSendAfterHumanTakeover({
    toPhone: ' +52 55 0000 0002 ',
    send: async () => {
      events.push('provider_send')
    }
  }, {
    markByContact: async () => {
      events.push('unexpected_contact_takeover')
    },
    markByPhone: async (phone, options) => {
      events.push(`phone_takeover:${phone}:${options.updatedBy}`)
    }
  })

  assert.deepEqual(events, [
    'phone_takeover:+52 55 0000 0002:human',
    'provider_send'
  ])
})

test('un error real al buscar el contacto por teléfono bloquea el envío manual', async () => {
  const originalGet = db.get
  let sent = false
  db.get = async (sql, ...args) => {
    if (sql.includes('FROM contacts WHERE phone LIKE')) throw new Error('phone lookup unavailable')
    return originalGet(sql, ...args)
  }
  try {
    await assert.rejects(runManualChatSendAfterHumanTakeover({
      toPhone: '+525500000002', send: async () => { sent = true }
    }), /phone lookup unavailable/)
    assert.equal(sent, false)
  } finally {
    db.get = originalGet
  }
})

for (const status of ['active', 'human', 'completed', 'paused']) {
  test(`responder desde Ristak cancela la ejecución pendiente incluso en estado ${status}`, async (t) => {
    const contactId = `manual_reply_${randomUUID()}`
    const agentId = `manual_agent_${randomUUID()}`
    t.after(async () => {
      await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM conversational_agent_manual_assignments WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    })
    await db.run('INSERT INTO contacts (id, full_name) VALUES (?, ?)', [contactId, 'Prueba de intervención humana'])
    await assignAgentToConversation(contactId, agentId, { channel: 'whatsapp', updatedBy: 'user' })
    const claim = await claimConversationInboundMessage(contactId, 'inbound_pending', { agentId, channel: 'whatsapp' })
    assert.equal(claim.claimed, true)
    if (['human', 'completed'].includes(status)) {
      await setConversationSignal(contactId, status === 'human' ? 'ready_for_human' : 'appointment_booked', {
        status, agentId, channel: 'whatsapp', reason: 'Terminal propia del robot'
      })
    } else if (status === 'paused') {
      await setConversationStatus(contactId, 'paused', { agentId, channel: 'whatsapp', updatedBy: 'user' })
    }
    const before = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
    assert.equal(before.inboundProcessingClaimToken, claim.claimToken)
    let sends = 0
    await runManualChatSendAfterHumanTakeover({
      contactId,
      send: async () => {
        const state = await getConversationState(contactId, { agentId, channel: 'whatsapp' })
        assert.equal(state.status, status === 'active' ? 'human' : status)
        assert.equal(state.signal, before.signal)
        assert.equal(state.pausedUntilAt, before.pausedUntilAt)
        assert.equal(state.inboundProcessingClaimToken, null)
        assert.equal(state.inboundProcessingStatus, 'completed')
        assert.equal(state.lastAnsweredInboundMessageId, before.lastAnsweredInboundMessageId)
        sends += 1
      }
    })
    assert.equal(sends, 1)
  })
}

test('todos los endpoints manuales conocidos pasan por la compuerta ordenada', async () => {
  const whatsappSource = await readFile(
    new URL('../src/controllers/whatsappApiController.js', import.meta.url),
    'utf8'
  )
  const highLevelSource = await readFile(
    new URL('../src/controllers/highlevelController.js', import.meta.url),
    'utf8'
  )
  const whatsappEndpoints = [
    ['sendMetaSocialTextMessageView', 'sendMetaSocialTextMessage'],
    ['sendMetaSocialAudioMessageView', 'sendMetaSocialAudioMessage'],
    ['sendMetaSocialAttachmentMessageView', 'sendMetaSocialAttachmentMessage'],
    ['sendMetaSocialReactionMessageView', 'sendMetaSocialReactionMessage'],
    ['sendMetaSocialCommentReplyView', 'sendMetaSocialCommentReply'],
    ['sendWhatsAppApiTextMessageView', 'sendWhatsAppApiTextMessage'],
    ['sendWhatsAppApiReactionMessageView', 'sendWhatsAppApiReactionMessage'],
    ['sendWhatsAppApiLocationMessageView', 'sendWhatsAppApiLocationMessage'],
    ['sendWhatsAppApiInteractiveMessageView', 'sendWhatsAppApiInteractiveMessage'],
    ['sendWhatsAppApiImageMessageView', 'sendWhatsAppApiImageMessage'],
    ['sendWhatsAppApiDocumentMessageView', 'sendWhatsAppApiDocumentMessage'],
    ['sendWhatsAppApiVideoMessageView', 'sendWhatsAppApiVideoMessage'],
    ['sendWhatsAppApiAudioMessageView', 'sendWhatsAppApiAudioMessage'],
    ['sendWhatsAppApiTemplateMessageView', 'sendWhatsAppApiTemplateMessage']
  ]

  for (const [endpoint, providerCall] of whatsappEndpoints) {
    const start = whatsappSource.indexOf(`export async function ${endpoint}`)
    assert.notEqual(start, -1, `falta ${endpoint}`)
    const nextExport = whatsappSource.indexOf('\nexport async function ', start + 1)
    const section = whatsappSource.slice(
      start,
      nextExport === -1 ? whatsappSource.length : nextExport
    )
    assert.match(
      section,
      /await runManualChatSendAfterHumanTakeover\(\{/
    )
    assert.match(section, new RegExp(`send:\\s*\\(\\) => ${providerCall}\\(`))
  }

  assert.doesNotMatch(whatsappSource, /notifyHumanTakeover/)
  assert.match(
    highLevelSource,
    /const response = markHumanTakeover[\s\S]*?await runManualChatSendAfterHumanTakeover\(\{[\s\S]*?contactId: contact\.id,[\s\S]*?send: sendThroughHighLevel/
  )
  assert.doesNotMatch(
    highLevelSource,
    /markHumanTakeoverIfActive\(contact\.id[\s\S]*?\.catch/
  )
})
