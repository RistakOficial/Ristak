import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import {
  assignAgentToConversation,
  buildConversationalAgentMetrics,
  claimConversationalReplyDelivery,
  checkpointConversationalReplyDelivery,
  completeConversationGoalLinkFromWebhook,
  createConversationalAgent,
  createConversationGoalLink,
  entryRulesMatch,
  getConversationalAgent,
  getConversationalReplyDeliveryPlan,
  getConversationGoalLink,
  getConversationState,
  listConversationStates,
  listConversationStatesForContact,
  getAgentFollowUpStepDelayMs,
  getAgentReplyDeliveryPartDelayMs,
  normalizeAgentFollowUp,
  normalizeAgentGoalWorkflow,
  normalizeAgentReplyDelivery,
  normalizeConversationalSuccessAction,
  getOrCreateConversationalReplyDeliveryPlan,
  recordConversationalAgentEvent,
  setConversationSignal,
  setConversationStatus,
  settleConversationalReplyDelivery,
  shouldSuppressChatNotificationForConversationalAgent,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'
import {
  createLocalAppointment,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'
import {
  buildReplyPartDelaySchedule,
  canDeclareConversationalReplyUndeliveredBeforeSend,
  normalizeConversationalChannel,
  RECOVERABLE_CONVERSATIONAL_CHANNELS,
  getConversationalFollowUpTiming,
  sendReplyParts,
  waitForConversationalResponseWindow,
  shouldSendConversationalReplyThroughHighLevel,
  shouldIncludeConversationalBinaryMedia,
  shouldRecoverPendingInbound,
  splitReplyIntoParts
} from '../src/agents/conversational/runner.js'
import { buildNativeFreeSlotDays, createConversationalTools } from '../src/agents/conversational/tools.js'
import {
  buildConversationalMediaSummary,
  hydrateConversationalMessagesMedia,
  hydrateConversationalPreviewMessagesMedia,
  inferConversationalMediaKind
} from '../src/agents/conversational/mediaContext.js'
import {
  MESSAGE_SPLITTER_MODEL,
  splitMessageIntoBubbles,
  splitMessageIntoBubblesFallback
} from '../src/agents/conversational/messageSplitter.js'
import {
  resolveHighLevelMessageChannel,
  upsertHighLevelConversationMessage
} from '../src/services/highlevelConversationsSyncService.js'

async function removeConversationGoalLinksForTest(contactId) {
  await db.run(`
    DELETE FROM conversational_agent_goal_evidence_claims
    WHERE goal_id IN (
      SELECT id FROM conversational_agent_goal_links WHERE contact_id = ?
    )
  `, [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
}

test('normaliza la entrega de respuestas en partes', () => {
  const defaultDelivery = normalizeAgentReplyDelivery()
  assert.equal(defaultDelivery.mode, 'split')
  assert.equal(defaultDelivery.splitMessagesEnabled, true)

  const delivery = normalizeAgentReplyDelivery({
    mode: 'split',
    maxBubbleLength: 40,
    minDelaySeconds: 12,
    maxDelaySeconds: 3,
    maxBubbles: 20
  })

  assert.equal(delivery.mode, 'split')
  assert.equal(delivery.splitMessagesEnabled, true)
  assert.equal(delivery.maxBubbleLength, 80)
  assert.equal(delivery.maxBubbles, 10)
  assert.equal(delivery.minDelaySeconds, 3)
  assert.equal(delivery.maxDelaySeconds, 12)
})

test('normaliza aliases de canal conversacional sin forzar WhatsApp', () => {
  assert.equal(normalizeConversationalChannel('instagram_dm'), 'instagram')
  assert.equal(normalizeConversationalChannel('facebook'), 'messenger')
  assert.equal(normalizeConversationalChannel('sms_qr'), 'sms')
  assert.equal(normalizeConversationalChannel('mms'), 'sms')
  assert.equal(normalizeConversationalChannel('ghl_whatsapp'), 'whatsapp')
  assert.equal(normalizeConversationalChannel('ghl_webchat'), 'webchat')
  assert.equal(normalizeConversationalChannel('website_chat'), 'webchat')
  assert.equal(normalizeConversationalChannel('correo'), 'email')
  assert.equal(normalizeConversationalChannel('no-existe'), 'whatsapp')
})

test('recuperacion de pendientes cubre todos los canales conversacionales', () => {
  assert.deepEqual(RECOVERABLE_CONVERSATIONAL_CHANNELS, ['whatsapp', 'instagram', 'messenger', 'sms', 'webchat', 'email'])
})

test('la entrega conserva el contexto SMS pero puede salir por el WhatsApp elegido', async () => {
  const sends = []
  const result = await sendReplyParts({
    contactId: 'contacto_ruta_ghl',
    phone: '+526561111111',
    latest: {
      id: 'mensaje_sms_origen',
      channel: 'sms',
      transport: 'ghl_sms',
      phone: '+526561111111',
      business_phone: '+19155550001'
    },
    agentConfig: {
      id: 'agente_ruta_ghl',
      replyDelivery: { mode: 'single', splitMessagesEnabled: false }
    },
    reply: 'Respuesta única',
    channel: 'sms',
    deliveryChannel: 'whatsapp',
    deliveryFromNumber: '+19155550002',
    dependencies: {
      sendTextMessage: async (payload) => {
        sends.push(payload)
        return { messageId: 'respuesta_ghl' }
      },
      loadNewerInbound: async () => null,
      recordEvent: async () => undefined,
      markReplyComplete: async () => undefined
    }
  })

  assert.equal(result.sentParts, 1)
  assert.equal(sends.length, 1)
  assert.equal(sends[0].channel, 'whatsapp')
  assert.equal(sends[0].from, '+19155550002')
  assert.equal(sends[0].text, 'Respuesta única')
})

test('responde por HighLevel cuando el WhatsApp entrante viene de GHL', () => {
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'whatsapp',
      latest: { transport: 'ghl_whatsapp' }
    }),
    true
  )
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'ghl_whatsapp',
      latest: {}
    }),
    true
  )
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'whatsapp',
      latest: { transport: 'api' }
    }),
    false
  )
})

test('responde por HighLevel cuando el chat entrante es webchat de GHL', () => {
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'webchat',
      latest: { transport: 'ghl_webchat' }
    }),
    true
  )
})

test('responde Messenger e Instagram por Meta directo salvo que el origen sea HighLevel', () => {
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'messenger',
      latest: { provider: 'meta', transport: 'messenger' }
    }),
    false
  )
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'instagram',
      latest: { provider: 'meta', transport: 'instagram' }
    }),
    false
  )
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'messenger',
      latest: { provider: 'highlevel', source: 'conversations_sync' }
    }),
    true
  )
  assert.equal(
    shouldSendConversationalReplyThroughHighLevel({
      channel: 'instagram',
      latest: { transport: 'ghl_instagram' }
    }),
    true
  )
})

test('detecta canales conversacionales de HighLevel sin mandarlos a WhatsApp por default', () => {
  assert.deepEqual(
    resolveHighLevelMessageChannel({ messageType: 'TYPE_WEBCHAT' }),
    { table: 'whatsapp', transport: 'ghl_webchat' }
  )
  assert.deepEqual(
    resolveHighLevelMessageChannel({ type: 'TYPE_EMAIL' }),
    { table: 'email', transport: 'ghl_email' }
  )
  assert.deepEqual(
    resolveHighLevelMessageChannel({ messageType: 'TYPE_MMS' }),
    { table: 'whatsapp', transport: 'ghl_sms' }
  )
  assert.deepEqual(
    resolveHighLevelMessageChannel({ messageType: 'TYPE_WHATSAPP' }),
    { table: 'whatsapp', transport: 'ghl_whatsapp' }
  )
})

test('pausar una conversación del agente dura 24 horas', async () => {
  const contactId = `contact_pause_24_${randomUUID()}`

  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215552400001', `${contactId}@test.local`, 'Pausa Veinticuatro', 'test']
    )

    const beforeMs = Date.now()
    const state = await setConversationStatus(contactId, 'paused', { updatedBy: 'user' })
    const afterMs = Date.now()
    const pausedUntilMs = Date.parse(state.pausedUntilAt)

    assert.equal(state.status, 'paused')
    assert.ok(state.pausedUntilAt)
    assert.ok(pausedUntilMs >= beforeMs + (24 * 60 * 60 * 1000) - 1000)
    assert.ok(pausedUntilMs <= afterMs + (24 * 60 * 60 * 1000) + 1000)

    const stored = await db.get('SELECT status, paused_until_at FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    assert.equal(stored.status, 'paused')
    assert.equal(stored.paused_until_at, state.pausedUntilAt)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('los estados conversacionales son independientes por contacto y agente', async () => {
  const contactId = `contact_agent_scope_${randomUUID()}`
  const agentOneId = `agent_scope_one_${randomUUID()}`
  const agentTwoId = `agent_scope_two_${randomUUID()}`
  const agentThreeId = `agent_scope_three_${randomUUID()}`

  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215552400099', `${contactId}@test.local`, 'Scope Agentes', 'test']
    )

    await assignAgentToConversation(contactId, agentOneId, { activationSource: 'manual', updatedBy: 'user' })
    await assignAgentToConversation(contactId, agentTwoId, { activationSource: 'manual', updatedBy: 'user' })

    const agentOneSkipped = await setConversationStatus(contactId, 'skipped', { updatedBy: 'user', agentId: agentOneId })
    const agentTwoStillActive = await getConversationState(contactId, { agentId: agentTwoId })

    assert.equal(agentOneSkipped.status, 'skipped')
    assert.equal(agentOneSkipped.agentId, agentOneId)
    assert.equal(agentTwoStillActive.status, 'active')
    assert.equal(agentTwoStillActive.agentId, agentTwoId)

    await assignAgentToConversation(contactId, agentThreeId, { activationSource: 'automatic', updatedBy: 'agent' })
    const agentThreeState = await getConversationState(contactId, { agentId: agentThreeId })
    assert.equal(agentThreeState.status, 'active')
    assert.equal(agentThreeState.agentId, agentThreeId)

    const states = await listConversationStatesForContact(contactId)
    const statusesByAgent = new Map(states.map((state) => [state.agentId, state.status]))
    assert.equal(statusesByAgent.get(agentOneId), 'skipped')
    assert.equal(statusesByAgent.get(agentTwoId), 'active')
    assert.equal(statusesByAgent.get(agentThreeId), 'active')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('una pausa vencida se reactiva al consultar el estado', async () => {
  const contactId = `contact_pause_expired_${randomUUID()}`

  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215552400002', `${contactId}@test.local`, 'Pausa Vencida', 'test']
    )
    await db.run(`
      INSERT INTO conversational_agent_state (contact_id, status, paused_until_at, updated_by, updated_at)
      VALUES (?, 'paused', ?, 'user', CURRENT_TIMESTAMP)
    `, [contactId, new Date(Date.now() - 60_000).toISOString()])

    const state = await getConversationState(contactId)
    assert.equal(state.status, 'active')
    assert.equal(state.pausedUntilAt, null)

    const stored = await db.get('SELECT status, paused_until_at, updated_by FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    assert.equal(stored.status, 'active')
    assert.equal(stored.paused_until_at, null)
    assert.equal(stored.updated_by, 'system')

    const event = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'status_changed' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    const detail = JSON.parse(event.detail_json)
    assert.equal(detail.status, 'active')
    assert.equal(detail.reason, 'pause_expired')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('webhooks conversacionales de HighLevel guardan webchat y email en su canal real', async () => {
  const suffix = randomUUID()
  const contactId = `contact_hl_channels_${suffix}`
  const ghlContactId = `ghl_contact_channels_${suffix}`
  const webchatRemoteId = `remote_webchat_${suffix}`
  const emailRemoteId = `remote_email_${suffix}`
  const contactEmail = `canales-${suffix}@example.test`

  await db.run(`
    INSERT INTO contacts (id, ghl_contact_id, phone, email, full_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [contactId, ghlContactId, '+526561110000', contactEmail, 'Contacto Canales'])

  try {
    const webchat = await upsertHighLevelConversationMessage({
      message: {
        id: webchatRemoteId,
        contactId: ghlContactId,
        messageType: 'TYPE_WEBCHAT',
        body: 'Hola desde el chat del sitio',
        direction: 'inbound',
        createdAt: '2099-05-01T10:00:00.000Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })
    const email = await upsertHighLevelConversationMessage({
      message: {
        id: emailRemoteId,
        contactId: ghlContactId,
        type: 'TYPE_EMAIL',
        subject: 'Duda por correo',
        bodyText: 'Quiero más información',
        fromEmail: contactEmail,
        direction: 'inbound',
        createdAt: '2099-05-01T10:01:00.000Z'
      },
      apiToken: 'test-token',
      locationId: 'test-location',
      notifyNewInbound: false
    })

    assert.equal(webchat.skipped, false)
    assert.equal(webchat.table, 'whatsapp')
    assert.equal(email.skipped, false)
    assert.equal(email.table, 'email')

    const webchatRow = await db.get('SELECT transport, direction, message_text FROM whatsapp_api_messages WHERE ycloud_message_id = ?', [webchatRemoteId])
    assert.equal(webchatRow?.transport, 'ghl_webchat')
    assert.equal(webchatRow?.direction, 'inbound')
    assert.equal(webchatRow?.message_text, 'Hola desde el chat del sitio')

    const emailRow = await db.get('SELECT direction, from_email, subject, message_text FROM email_messages WHERE contact_id = ? AND subject = ?', [contactId, 'Duda por correo'])
    assert.equal(emailRow?.direction, 'inbound')
    assert.equal(emailRow?.from_email, contactEmail)
    assert.equal(emailRow?.message_text, 'Quiero más información')
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ?', [webchatRemoteId]).catch(() => undefined)
    await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('la condicion Canal permite chats y SMS sin confundirlos con correo', () => {
  const chatAgent = {
    filters: {
      entry: {
        groups: [{
          conditions: [{ category: 'channel', params: [{ field: 'channel', operator: 'is', value: 'chat' }] }]
        }]
      }
    }
  }
  const emailAgent = {
    filters: {
      entry: {
        groups: [{
          conditions: [{ category: 'channel', params: [{ field: 'channel', operator: 'is', value: 'email' }] }]
        }]
      }
    }
  }

  for (const channel of ['whatsapp', 'instagram', 'messenger', 'sms', 'webchat']) {
    assert.equal(entryRulesMatch(chatAgent, { channel }), true)
  }
  assert.equal(entryRulesMatch(chatAgent, { channel: 'email' }), false)
  assert.equal(entryRulesMatch(emailAgent, { channel: 'email' }), true)
  assert.equal(entryRulesMatch(emailAgent, { channel: 'instagram' }), false)
})

test('la condicion Anuncios separa existencia y comparadores por anuncio', () => {
  const agentWithAd = {
    filters: {
      entry: {
        groups: [{
          conditions: [{ category: 'ads', params: [{ field: 'presence', operator: 'exists' }] }]
        }]
      }
    }
  }
  const agentWithoutAd = {
    filters: {
      entry: {
        groups: [{
          conditions: [{ category: 'ads', params: [{ field: 'presence', operator: 'not_exists' }] }]
        }]
      }
    }
  }
  const exactAdAgent = {
    filters: {
      entry: {
        groups: [{
          conditions: [{
            category: 'ads',
            params: [
              { field: 'presence', operator: 'exists' },
              { field: 'ad', operator: 'is', value: 'ad_123' }
            ]
          }]
        }]
      }
    }
  }
  const containsAdAgent = {
    filters: {
      entry: {
        groups: [{
          conditions: [{
            category: 'ads',
            params: [
              { field: 'presence', operator: 'exists' },
              { field: 'ad', operator: 'contains', value: 'promo verano' }
            ]
          }]
        }]
      }
    }
  }
  const notContainsAdAgent = {
    filters: {
      entry: {
        groups: [{
          conditions: [{
            category: 'ads',
            params: [
              { field: 'presence', operator: 'exists' },
              { field: 'ad', operator: 'not_contains', value: 'frio' }
            ]
          }]
        }]
      }
    }
  }
  const ctx = {
    cameFromAd: true,
    adSourceIds: ['ad_123'],
    adSourceValues: ['ad_123', 'promo verano', 'campana caliente']
  }

  assert.equal(entryRulesMatch(agentWithAd, ctx), true)
  assert.equal(entryRulesMatch(agentWithoutAd, ctx), false)
  assert.equal(entryRulesMatch(agentWithoutAd, { cameFromAd: false, adSourceIds: [], adSourceValues: [] }), true)
  assert.equal(entryRulesMatch(exactAdAgent, ctx), true)
  assert.equal(entryRulesMatch(containsAdAgent, ctx), true)
  assert.equal(entryRulesMatch(notContainsAdAgent, ctx), true)
  assert.equal(entryRulesMatch(containsAdAgent, { cameFromAd: true, adSourceIds: ['ad_999'], adSourceValues: ['campana fria'] }), false)
})

test('normaliza seguimiento del agente conversacional dentro de ventana WhatsApp', () => {
  const followUp = normalizeAgentFollowUp({
    enabled: true,
    first: { value: 30, unit: 'minutes' },
    second: { enabled: true, value: 40, unit: 'hours' },
    strategy: 'retomar contexto sin sonar automático'
  })

  assert.equal(followUp.enabled, true)
  assert.equal(followUp.first.enabled, true)
  assert.equal(followUp.first.value, 30)
  assert.equal(followUp.second.enabled, true)
  assert.equal(followUp.second.value, 23)
  assert.equal(getAgentFollowUpStepDelayMs(followUp.second), 23 * 60 * 60 * 1000)
  assert.equal(followUp.strategy, 'retomar contexto sin sonar automático')
})

test('el primer seguimiento espera desde la respuesta realmente entregada, no desde el inbound original', () => {
  const timing = getConversationalFollowUpTiming({
    latest: {
      id: 'inbound_follow_up_timing_1',
      message_timestamp: '2026-07-13T12:00:00.000Z'
    },
    state: {
      followUpSentCount: 0,
      lastReplyAt: '2026-07-13 12:07:00'
    },
    step: { enabled: true, value: 30, unit: 'minutes' },
    nowMs: Date.parse('2026-07-13T12:31:00.000Z')
  })

  assert.equal(new Date(timing.anchorMs).toISOString(), '2026-07-13T12:07:00.000Z')
  assert.equal(new Date(timing.dueAtMs).toISOString(), '2026-07-13T12:37:00.000Z')
  assert.equal(timing.remainingMs, 6 * 60 * 1000)
})

test('el segundo seguimiento empieza su propio reloj después del primero y respeta una salida posterior', () => {
  const afterFirstFollowUp = getConversationalFollowUpTiming({
    latest: {
      id: 'inbound_follow_up_timing_2',
      message_timestamp: '2026-07-13T12:00:00.000Z'
    },
    state: {
      followUpSentCount: 1,
      lastReplyAt: '2026-07-13 12:37:00',
      followUpLastSentAt: '2026-07-13 12:37:00'
    },
    step: { enabled: true, value: 2, unit: 'hours' },
    nowMs: Date.parse('2026-07-13T12:38:00.000Z')
  })
  assert.equal(new Date(afterFirstFollowUp.dueAtMs).toISOString(), '2026-07-13T14:37:00.000Z')

  const afterNewerOutbound = getConversationalFollowUpTiming({
    latest: {
      id: 'inbound_follow_up_timing_2',
      message_timestamp: '2026-07-13T12:00:00.000Z'
    },
    state: {
      followUpSentCount: 1,
      followUpLastSentAt: '2026-07-13 12:37:00',
      lastReplyAt: '2026-07-13 13:05:00'
    },
    step: { enabled: true, value: 2, unit: 'hours' }
  })
  assert.equal(new Date(afterNewerOutbound.anchorMs).toISOString(), '2026-07-13T13:05:00.000Z')
  assert.equal(new Date(afterNewerOutbound.dueAtMs).toISOString(), '2026-07-13T15:05:00.000Z')
})

test('rechaza rangos invertidos al guardar el agente conversacional', async () => {
  const agent = await createConversationalAgent({
    name: 'Agente rango inválido',
    enabled: false
  })

  try {
    await assert.rejects(
      updateConversationalAgent(agent.id, {
        responseDelay: {
          mode: 'random',
          fixedValue: 10,
          fixedUnit: 'seconds',
          minValue: 8,
          maxValue: 2,
          rangeUnit: 'minutes'
        }
      }),
      /Revisa el rango de espera/
    )

    await assert.rejects(
      updateConversationalAgent(agent.id, {
        replyDelivery: {
          mode: 'split',
          splitMessagesEnabled: true,
          minMessageLengthToSplit: 120,
          maxBubbles: 6,
          minBubbleLength: 20,
          maxBubbleLength: 350,
          targetChars: 350,
          randomizeSplitting: true,
          delayBetweenBubblesEnabled: true,
          minDelaySeconds: 8,
          maxDelaySeconds: 2
        }
      }),
      /Revisa el rango de pausa/
    )

    await assert.rejects(
      updateConversationalAgent(agent.id, {
        followUp: {
          enabled: true,
          first: { enabled: true, value: 24, unit: 'hours' },
          second: { enabled: false, value: 2, unit: 'hours' },
          strategy: 'retomar sin sonar automático'
        }
      }),
      /23 horas/
    )

    const sequentialFollowUp = await updateConversationalAgent(agent.id, {
      followUp: {
        enabled: true,
        first: { enabled: true, value: 3, unit: 'hours' },
        second: { enabled: true, value: 2, unit: 'hours' },
        strategy: 'retomar sin sonar automático'
      }
    })
    assert.equal(sequentialFollowUp.followUp.first.value, 3)
    assert.equal(sequentialFollowUp.followUp.second.value, 2)

    await assert.rejects(
      updateConversationalAgent(agent.id, {
        followUp: {
          enabled: true,
          first: { enabled: true, value: 12, unit: 'hours' },
          second: { enabled: true, value: 12, unit: 'hours' },
          strategy: 'retomar sin sonar automático'
        }
      }),
      /juntos no pueden pasar de 23 horas/
    )
  } finally {
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
  }
})

test('conserva todos los ajustes visibles de globitos al guardar el agente', async () => {
  const agent = await createConversationalAgent({
    name: 'Agente globitos configurables',
    enabled: false
  })

  try {
    const updated = await updateConversationalAgent(agent.id, {
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        minMessageLengthToSplit: 240,
        maxBubbles: 3,
        minBubbleLength: 35,
        maxBubbleLength: 180,
        targetChars: 150,
        randomizeSplitting: false,
        delayBetweenBubblesEnabled: false,
        minDelaySeconds: 4,
        maxDelaySeconds: 9
      }
    })

    assert.deepEqual(updated.replyDelivery, {
      mode: 'split',
      splitMessagesEnabled: true,
      minMessageLengthToSplit: 240,
      maxBubbles: 3,
      minBubbleLength: 35,
      maxBubbleLength: 180,
      targetChars: 150,
      randomizeSplitting: false,
      delayBetweenBubblesEnabled: false,
      minDelaySeconds: 4,
      maxDelaySeconds: 9
    })
  } finally {
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
  }
})

test('guarda la identidad visible del agente conversacional', async () => {
  const agent = await createConversationalAgent({
    name: 'Robot 34',
    enabled: false,
    identityMode: 'custom',
    identityCustomName: 'Marcos'
  })

  try {
    assert.equal(agent.identityMode, 'custom')
    assert.equal(agent.identityCustomName, 'Marcos')
    assert.equal(agent.identityUserId, '')
    assert.equal(agent.identityUserName, '')

    const assignedUser = await updateConversationalAgent(agent.id, {
      identityMode: 'user',
      identityUserId: 'user_admin',
      identityUserName: 'Raul Admin'
    })
    assert.equal(assignedUser.identityMode, 'user')
    assert.equal(assignedUser.identityUserId, 'user_admin')
    assert.equal(assignedUser.identityUserName, 'Raul Admin')
    assert.equal(assignedUser.identityCustomName, '')

    const agentName = await updateConversationalAgent(agent.id, { identityMode: 'agent' })
    assert.equal(agentName.identityMode, 'agent')
    assert.equal(agentName.identityUserId, '')
    assert.equal(agentName.identityUserName, '')
    assert.equal(agentName.identityCustomName, '')

    const business = await updateConversationalAgent(agent.id, { identityMode: 'business' })
    assert.equal(business.identityMode, 'business')
    assert.equal(business.identityUserId, '')
    assert.equal(business.identityUserName, '')
    assert.equal(business.identityCustomName, '')
  } finally {
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
  }
})

test('normaliza acciones del agente conversacional', () => {
  assert.equal(normalizeConversationalSuccessAction('book_appointment'), 'book_appointment')
  assert.equal(normalizeConversationalSuccessAction('ready_to_buy'), 'ready_to_buy')
  assert.equal(normalizeConversationalSuccessAction('send_goal_url'), 'send_goal_url')
  assert.equal(normalizeConversationalSuccessAction('send_trigger_link'), 'send_trigger_link')
  assert.equal(normalizeConversationalSuccessAction('ready_for_human'), 'ready_for_human')
  for (const action of ['internal_signal', 'none', '', null]) {
    assert.equal(normalizeConversationalSuccessAction(action), 'ready_for_human')
  }
})

test('normaliza flujo por enlace con parametro de seguimiento', () => {
  const workflow = normalizeAgentGoalWorkflow({
    appointments: {
      owner: 'url',
      url: 'agenda.test/reserva',
      trackingParam: 'booking-ref!',
      allowOverlappingAppointments: true
    },
    sales: {
      owner: 'url',
      url: 'https://tienda.test/checkout',
      paymentMode: 'deposit',
      trackingParam: 'order_id'
    },
    triggerLink: {
      triggerLinkId: 'trigger_link_123',
      triggerLinkPublicId: 'abc123',
      triggerLinkName: 'Ficha de diagnóstico',
      triggerLinkUrl: 'https://app.test/trigger-links/abc123'
    },
    deposit: {
      enabled: true,
      mode: 'range',
      minAmount: '200',
      maxAmount: '900',
      currency: 'mxn'
    },
    completion: {
      mode: 'assign_user',
      userId: 'user_123',
      userName: 'Ana Ventas'
    }
  })

  assert.equal(workflow.appointments.owner, 'url')
  assert.equal(workflow.appointments.url, 'https://agenda.test/reserva')
  assert.equal(workflow.appointments.trackingParam, 'booking-ref')
  assert.equal(workflow.appointments.allowOverlappingAppointments, true)
  assert.equal(workflow.sales.owner, 'url')
  assert.equal(workflow.sales.paymentMode, 'deposit')
  assert.equal(workflow.sales.trackingParam, 'order_id')
  assert.equal(workflow.triggerLink.triggerLinkId, 'trigger_link_123')
  assert.equal(workflow.triggerLink.triggerLinkPublicId, 'abc123')
  assert.equal(workflow.triggerLink.triggerLinkName, 'Ficha de diagnóstico')
  assert.equal(workflow.triggerLink.triggerLinkUrl, 'https://app.test/trigger-links/abc123')
  assert.equal(workflow.deposit.enabled, true)
  assert.equal(workflow.deposit.mode, 'range')
  assert.equal(workflow.deposit.minAmount, 200)
  assert.equal(workflow.deposit.maxAmount, 900)
  assert.equal(workflow.deposit.currency, 'MXN')
  assert.equal(workflow.completion.mode, 'assign_user')
  assert.equal(workflow.completion.userId, 'user_123')
  assert.equal(workflow.completion.userName, 'Ana Ventas')
})

test('normaliza venta completa como modo default sin forzar moneda fija', () => {
  const workflow = normalizeAgentGoalWorkflow({
    sales: {
      owner: 'ai',
      paymentMode: 'full_payment',
      currency: ''
    },
    deposit: {
      enabled: true,
      mode: 'fixed',
      amount: '500'
    }
  })

  assert.equal(workflow.sales.owner, 'ai')
  assert.equal(workflow.sales.paymentMode, 'full_payment')
  assert.equal(workflow.deposit.enabled, true)
  assert.equal(workflow.deposit.amount, 500)
  assert.equal(workflow.deposit.currency, '')
})

test('offer_appointment_slot rechaza un horario inventado o fuera de horario de atención', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_conv_invalidslot_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 30 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  // Hora claramente fuera del horario de atención (05:00, cuando el calendario abre 15:00-17:00).
  const outOfHours = nextMonday.set({ hour: 5, minute: 0, second: 0, millisecond: 0 }).toUTC().toISO()
  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'loc_conv_invalidslot_test',
      name: 'Calendario slot inválido',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [1], hours: [{ openHour: 15, openMinute: 0, closeHour: 17, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = {
      contactId: `rstk_contact_invalidslot_${suffix}`,
      dryRun: true,
      actions: [],
      config: {
        objective: 'citas',
        capabilitiesConfig: {
          schemaVersion: 1,
          items: [{ id: 'schedule_appointment', enabled: true, calendarId }]
        }
      }
    }
    const offerTool = createConversationalTools(ctx).find((item) => item.name === 'offer_appointment_slot')
    assert.ok(offerTool)

    const result = await offerTool.invoke(null, JSON.stringify({ startTime: outOfHours, appointmentId: null }))
    assert.equal(result.ok, false)
    assert.equal(result.invalidSlot, true)
    assert.equal(ctx.actions.length, 0)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('confirmacion automatica de enlace de calendario confirma cita con ID real', async () => {
  const contactId = 'test_goal_url_contact'
  await removeConversationGoalLinksForTest(contactId)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215550000000', 'goal-url@test.local', 'Goal URL Test', 'test']
    )

    const link = await createConversationGoalLink({
      contactId,
      objective: 'citas',
      targetUrl: 'https://agenda.test/reserva?origen=whatsapp',
      trackingParam: 'booking_ref',
      linkParams: { calendar_id: 'cal_demo' },
      metadata: {
        expected: { calendarId: 'cal_demo' }
      }
    })

    assert.match(link.id, /^goal_/)
    assert.equal(new URL(link.sentUrl).searchParams.get('booking_ref'), link.id)
    assert.equal(new URL(link.sentUrl).searchParams.get('calendar_id'), 'cal_demo')
    assert.equal(new URL(link.sentUrl).searchParams.has('ristak_goal_token'), false)

    const completed = await completeConversationGoalLinkFromWebhook({
      goalId: link.id,
      externalSource: 'calendar:humanized-test',
      calendarId: 'cal_demo',
      externalObjectId: 'appt_123',
      status: 'scheduled'
    }, { authorization: { type: 'external_api', actorId: 'humanized-test', requestId: 'calendar-goal-request' } })

    assert.equal(completed.status, 'completed')
    assert.equal(completed.externalObjectId, 'appt_123')
    assert.equal(completed.signal, 'appointment_booked')

    const stored = await getConversationGoalLink(link.id)
    assert.equal(stored.status, 'completed')
    assert.equal(stored.externalObjectId, 'appt_123')

    const state = await db.get('SELECT status, signal, signal_summary FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'appointment_booked')
    assert.match(state.signal_summary, /Agendó una cita/)
    assert.doesNotMatch(state.signal_summary, /appt_123/)

    const completionEvent = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'signal_set' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    const completionDetail = JSON.parse(completionEvent.detail_json)
    assert.equal(completionDetail.actionSummary, 'Agendó una cita')
    assert.equal(completionDetail.originalSummary, 'ID de cita: appt_123')
  } finally {
    await removeConversationGoalLinksForTest(contactId)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('confirmacion automatica de pedido valida producto antes de cerrar venta', async () => {
  const contactId = 'test_goal_order_contact'
  await removeConversationGoalLinksForTest(contactId)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215550000001', 'goal-order@test.local', 'Goal Order Test', 'test']
    )

    const link = await createConversationGoalLink({
      contactId,
      objective: 'ventas',
      targetUrl: 'https://tienda.test/pedido',
      trackingParam: 'pedido_ref',
      linkParams: {
        product_id: 'prod_x',
        price_id: 'price_mensual'
      },
      metadata: {
        expected: {
          productId: 'prod_x',
          priceId: 'price_mensual',
          productName: 'Producto X',
          priceName: 'Mensual'
        }
      }
    })

    const sentUrl = new URL(link.sentUrl)
    assert.equal(sentUrl.searchParams.get('pedido_ref'), link.id)
    assert.equal(sentUrl.searchParams.get('product_id'), 'prod_x')
    assert.equal(sentUrl.searchParams.get('price_id'), 'price_mensual')
    assert.equal(sentUrl.searchParams.has('ristak_goal_token'), false)

    await assert.rejects(
      () => completeConversationGoalLinkFromWebhook({
        goalId: link.id,
        externalSource: 'payments:humanized-test',
        productId: 'prod_y',
        priceId: 'price_mensual',
        externalObjectId: 'purchase_wrong',
        status: 'paid'
      }, { authorization: { type: 'external_api', actorId: 'humanized-test', requestId: 'order-goal-request' } }),
      /producto esperado/
    )

    const pending = await getConversationGoalLink(link.id)
    assert.equal(pending.status, 'pending')

    const completed = await completeConversationGoalLinkFromWebhook({
      goalId: link.id,
      externalSource: 'payments:humanized-test',
      productId: 'prod_x',
      priceId: 'price_mensual',
      externalObjectId: 'purchase_123',
      status: 'paid'
    }, { authorization: { type: 'external_api', actorId: 'humanized-test', requestId: 'order-goal-request' } })

    assert.equal(completed.status, 'completed')
    assert.equal(completed.externalObjectId, 'purchase_123')
    assert.equal(completed.signal, 'purchase_completed')

    const state = await db.get('SELECT status, signal, signal_summary FROM conversational_agent_state WHERE contact_id = ?', [contactId])
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'purchase_completed')
    assert.match(state.signal_summary, /Pago completado/)
    assert.doesNotMatch(state.signal_summary, /purchase_123/)

    const completionEvent = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'signal_set' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    const completionDetail = JSON.parse(completionEvent.detail_json)
    assert.equal(completionDetail.actionSummary, 'Pago completado')
    assert.equal(completionDetail.originalSummary, 'ID de compra: purchase_123')
  } finally {
    await removeConversationGoalLinksForTest(contactId)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('ocultar atendidas legacy se guarda como silenciar sin sacar el chat de IA', async () => {
  const agent = await createConversationalAgent({
    name: 'Agente visible silenciado',
    enabled: false,
    hideAttended: true,
    hideAttendedNotifications: false
  })

  try {
    assert.equal(agent.hideAttended, false)
    assert.equal(agent.hideAttendedNotifications, true)

    let row = await db.get('SELECT hide_attended, hide_attended_notifications FROM conversational_agents WHERE id = ?', [agent.id])
    assert.equal(row.hide_attended, 0)
    assert.equal(row.hide_attended_notifications, 1)

    const notifyAgent = await updateConversationalAgent(agent.id, {
      hideAttended: false,
      hideAttendedNotifications: false
    })
    assert.equal(notifyAgent.hideAttended, false)
    assert.equal(notifyAgent.hideAttendedNotifications, false)

    row = await db.get('SELECT hide_attended, hide_attended_notifications FROM conversational_agents WHERE id = ?', [agent.id])
    assert.equal(row.hide_attended, 0)
    assert.equal(row.hide_attended_notifications, 0)

    await db.run('UPDATE conversational_agents SET hide_attended = 1, hide_attended_notifications = 0 WHERE id = ?', [agent.id])
    const legacyHiddenAgent = await getConversationalAgent(agent.id)
    assert.equal(legacyHiddenAgent.hideAttended, false)
    assert.equal(legacyHiddenAgent.hideAttendedNotifications, true)
  } finally {
    await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
  }
})

test('cambiar a silenciar aplica sobre conversaciones ya asignadas y mantiene el contacto en el chat del agente', async () => {
  const contactId = `contact_agent_mode_${randomUUID()}`
  let agent = null

  try {
    agent = await createConversationalAgent({
      name: 'Agente modo editable',
      enabled: true,
      hideAttended: false,
      hideAttendedNotifications: false,
      defaultCalendarId: 'cal_runtime_test'
    })
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto de modo editable', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    await assignAgentToConversation(contactId, agent.id, {
      activationSource: 'automatic',
      updatedBy: 'agent'
    })

    assert.equal(await shouldSuppressChatNotificationForConversationalAgent(contactId), false)

    const mutedAgent = await updateConversationalAgent(agent.id, {
      hideAttended: false,
      hideAttendedNotifications: true
    })

    assert.equal(mutedAgent.hideAttended, false)
    assert.equal(mutedAgent.hideAttendedNotifications, true)
    assert.equal(await shouldSuppressChatNotificationForConversationalAgent(contactId), true)

    const contactStates = await listConversationStatesForContact(contactId)
    assert.equal(contactStates.length, 1)
    assert.equal(contactStates[0].agentId, agent.id)
    assert.equal(contactStates[0].agentHideAttendedNotifications, true)
    assert.equal(contactStates[0].agentEnabled, true)

    const listedStates = await listConversationStates({ statuses: ['active'] })
    const listedState = listedStates.find((state) => state.contactId === contactId && state.agentId === agent.id)
    assert.ok(listedState)
    assert.equal(listedState.agentHideAttendedNotifications, true)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agent.id}%`]).catch(() => undefined)
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    }
  }
})

test('calcula métricas del agente conversacional por estado y errores', () => {
  const metrics = buildConversationalAgentMetrics({
    agents: [
      { id: 'agent_1', name: 'Ventas', enabled: true, model: 'gpt-5.4-mini' },
      { id: 'agent_2', name: 'Soporte', enabled: false, model: 'gpt-5.4-mini' }
    ],
    stateRows: [
      { agent_id: 'agent_1', status: 'active', signal: null, updated_at: '2026-06-13T10:00:00Z' },
      { agent_id: 'agent_1', status: 'completed', signal: 'ready_for_human', updated_at: '2026-06-13T10:05:00Z' },
      { agent_id: 'agent_2', status: 'discarded', signal: 'discarded', updated_at: '2026-06-13T10:10:00Z' },
      { agent_id: 'agent_2', status: 'human', signal: 'ready_for_human', updated_at: '2026-06-13T10:15:00Z' }
    ],
    eventSummary: {
      total_events: 8,
      success_events: 1,
      assigned_events: 2,
      reply_events: 3,
      error_events: 1
    }
  })

  assert.equal(metrics.totalAgents, 2)
  assert.equal(metrics.activeAgents, 1)
  assert.equal(metrics.assignedConversations, 1)
  assert.equal(metrics.agentsWithAssignedConversations, 1)
  assert.equal(metrics.completedConversations, 1)
  assert.equal(metrics.discardedConversations, 1)
  assert.equal(metrics.humanTakeovers, 1)
  assert.equal(metrics.errorEvents, 1)
  assert.equal(metrics.successRate, 33)
  assert.equal(metrics.byAgent.find((agent) => agent.agentId === 'agent_1')?.completedConversations, 1)
})

test('calcula una pausa entre partes dentro del rango configurado', () => {
  const delayMs = getAgentReplyDeliveryPartDelayMs({
    replyDelivery: {
      mode: 'split',
      maxBubbleLength: 180,
      delayBetweenBubblesEnabled: true,
      minDelaySeconds: 2,
      maxDelaySeconds: 2
    }
  })

  assert.equal(delayMs, 2000)
})

test('crea calendario de pausas dejando el primer globo inmediato', () => {
  const schedule = buildReplyPartDelaySchedule(['uno', 'dos', 'tres'], {
    replyDelivery: {
      mode: 'split',
      delayBetweenBubblesEnabled: true,
      minDelaySeconds: 2,
      maxDelaySeconds: 2
    }
  })

  assert.deepEqual(schedule, [0, 2000, 2000])
})

test('ventana de respuesta espera antes de OpenAI y absorbe mensajes nuevos', async () => {
  const events = []
  const originalLatest = { id: 'msg_costos', channel: 'whatsapp' }
  const nextLatest = { id: 'msg_ubicacion', channel: 'whatsapp' }
  let waitedMs = 0
  let absorbed = null

  const result = await waitForConversationalResponseWindow({
    contactId: 'contacto_ventana_respuesta',
    latest: originalLatest,
    agentConfig: { id: 'agent_delay_test' },
    channel: 'whatsapp',
    delayMs: 60_000,
    wait: async (ms) => { waitedMs = ms },
    loadLatest: async () => nextLatest,
    recordEvent: async (event) => { events.push(event) },
    onNewerInbound: async (message) => { absorbed = message }
  })

  assert.equal(waitedMs, 60_000)
  assert.equal(result.latest.id, 'msg_ubicacion')
  assert.equal(result.absorbedNewerInbound, true)
  assert.equal(absorbed.id, 'msg_ubicacion')
  assert.deepEqual(events.map((event) => event.eventType), [
    'reply_wait_started',
    'reply_wait_collected_inbound'
  ])
  assert.equal(events[0].detail.phase, 'before_agent_run')
  assert.equal(events[1].detail.originalMessageId, 'msg_costos')
  assert.equal(events[1].detail.messageId, 'msg_ubicacion')
})

test('envio real espera antes de cada globo posterior', async () => {
  const sequence = []
  let splitterArgs = null
  const result = await sendReplyParts({
    contactId: 'contacto-test',
    phone: '+526561111111',
    latest: {
      id: 'mensaje-inicial',
      phone: '+526561111111',
      business_phone: '+526562222222',
      business_phone_number_id: 'phone-row-test'
    },
    agentConfig: {
      id: 'agente-test',
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        delayBetweenBubblesEnabled: true,
        minDelaySeconds: 2,
        maxDelaySeconds: 2
      }
    },
    reply: 'respuesta original',
    apiKey: 'sk-test',
    model: 'test-model',
    dependencies: {
      splitter: async (args) => {
        splitterArgs = args
        return { messages: ['globo uno', 'globo dos', 'globo tres'], source: 'test', reason: 'ok' }
      },
      sendTextMessage: async ({ text }) => {
        sequence.push(`send:${text}`)
      },
      wait: async (delayMs) => {
        sequence.push(`wait:${delayMs}`)
      },
      loadNewerInbound: async () => null,
      recordEvent: async () => {},
      markReplyComplete: async () => {
        sequence.push('complete')
      }
    }
  })

  assert.equal(splitterArgs?.model, undefined)
  assert.equal(splitterArgs?.apiKey, 'sk-test')
  assert.deepEqual(result.delaySchedule, [0, 2000, 2000])
  assert.deepEqual(sequence, [
    'send:globo uno',
    'wait:2000',
    'send:globo dos',
    'wait:2000',
    'send:globo tres',
    'complete'
  ])
})

test('un retry pre-send no declara invisible una respuesta que ya tiene plan durable', async () => {
  const identity = {
    contactId: 'contacto-retry-plan-existente',
    agentId: 'agente-retry-plan-existente',
    channel: 'whatsapp',
    sourceMessageId: 'mensaje-retry-plan-existente'
  }
  assert.equal(await canDeclareConversationalReplyUndeliveredBeforeSend({
    ...identity,
    loadPlan: async () => null
  }), true)
  assert.equal(await canDeclareConversationalReplyUndeliveredBeforeSend({
    ...identity,
    loadPlan: async () => ({
      status: 'completed',
      parts: [{ status: 'sent', attempts: 1 }]
    })
  }), false)
  assert.equal(await canDeclareConversationalReplyUndeliveredBeforeSend({
    ...identity,
    loadPlan: async () => { throw new Error('ledger temporalmente ilegible') }
  }), false)
})

test('un retry reutiliza el plan durable y continúa sólo con los globos pendientes', async () => {
  const suffix = randomUUID()
  const contactId = `contacto-plan-${suffix}`
  const agentId = `agente-plan-${suffix}`
  const latest = { id: `mensaje-plan-${suffix}`, phone: '+526561111111' }
  const sent = []
  let splitterCalls = 0
  let failBeforeSecondPart = true
  let completed = 0
  const replyDeliveryLedger = {
    get: getConversationalReplyDeliveryPlan,
    create: getOrCreateConversationalReplyDeliveryPlan,
    claim: claimConversationalReplyDelivery,
    checkpoint: checkpointConversationalReplyDelivery,
    settle: settleConversationalReplyDelivery
  }
  const base = {
    contactId,
    phone: latest.phone,
    latest,
    agentConfig: {
      id: agentId,
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        delayBetweenBubblesEnabled: true,
        minDelaySeconds: 2,
        maxDelaySeconds: 2
      }
    },
    reply: 'globo uno globo dos globo tres',
    dependencies: {
      replyDeliveryLedger,
      splitter: async () => {
        splitterCalls += 1
        return { messages: ['globo uno', 'globo dos', 'globo tres'], source: 'ai', reason: 'exact_content_preserved' }
      },
      sendTextMessage: async ({ text, externalId }) => {
        sent.push({ text, externalId })
        return { id: `provider-${text.replaceAll(' ', '-')}` }
      },
      wait: async () => {
        if (failBeforeSecondPart) {
          failBeforeSecondPart = false
          throw new Error('reinicio_antes_del_segundo_globo')
        }
      },
      loadNewerInbound: async () => null,
      recordEvent: async () => {},
      markReplyComplete: async () => { completed += 1 }
    }
  }

  try {
    await assert.rejects(sendReplyParts(base), /reinicio_antes_del_segundo_globo/)
    assert.deepEqual(sent.map((item) => item.text), ['globo uno'])

    const retry = await sendReplyParts({
      ...base,
      reply: 'una redacción distinta que jamás debe reemplazar el primer plan',
      dependencies: {
        ...base.dependencies,
        splitter: async () => { throw new Error('el retry no debe volver a dividir') }
      }
    })

    assert.equal(splitterCalls, 1)
    assert.deepEqual(sent.map((item) => item.text), ['globo uno', 'globo dos', 'globo tres'])
    assert.equal(new Set(sent.map((item) => item.externalId)).size, 3)
    assert.equal(retry.sentParts, 3)
    assert.equal(retry.durableStatus, 'completed')
    assert.equal(completed, 1)

    const completedRetry = await sendReplyParts({
      ...base,
      dependencies: {
        ...base.dependencies,
        splitter: async () => { throw new Error('un plan completado tampoco se recalcula') },
        sendTextMessage: async () => { throw new Error('un plan completado no se reenvía') }
      }
    })
    assert.equal(completedRetry.resumed, true)
    assert.equal(completedRetry.durableStatus, 'completed')
    assert.equal(sent.length, 3)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
  }
})

test('un fallo antes del primer envío conserva el plan pending para reenviar la misma oferta', async () => {
  const suffix = randomUUID()
  const contactId = `contacto-plan-primer-envio-${suffix}`
  const agentId = `agente-plan-primer-envio-${suffix}`
  const latest = { id: `mensaje-plan-primer-envio-${suffix}`, phone: '+526561111111' }
  const originalReply = 'El martes a las 4:00 p.m. está disponible. ¿Te funciona ese horario?'
  const sent = []
  let failBeforeProvider = true
  const replyDeliveryLedger = {
    get: getConversationalReplyDeliveryPlan,
    create: getOrCreateConversationalReplyDeliveryPlan,
    claim: claimConversationalReplyDelivery,
    checkpoint: checkpointConversationalReplyDelivery,
    settle: settleConversationalReplyDelivery
  }
  const base = {
    contactId,
    phone: latest.phone,
    latest,
    agentConfig: {
      id: agentId,
      replyDelivery: { mode: 'single', splitMessagesEnabled: false }
    },
    reply: originalReply,
    dependencies: {
      replyDeliveryLedger,
      forceSingleMessage: true,
      sendTextMessage: async ({ text }) => {
        sent.push(text)
        return { id: `provider-${suffix}` }
      },
      loadNewerInbound: async () => {
        if (failBeforeProvider) {
          failBeforeProvider = false
          throw new Error('fallo_antes_de_llamar_al_proveedor')
        }
        return null
      },
      recordEvent: async () => {},
      markReplyComplete: async () => {}
    }
  }

  try {
    let failure = null
    await assert.rejects(sendReplyParts(base), (error) => {
      failure = error
      return /fallo_antes_de_llamar_al_proveedor/.test(String(error?.message || ''))
    })
    assert.equal(failure.conversationalReplyDelivery?.sentParts, 0)
    assert.equal(failure.conversationalReplyDelivery?.durableStatus, 'pending')
    assert.ok(failure.conversationalReplyDelivery?.planId)

    const retry = await sendReplyParts({
      ...base,
      reply: 'Este texto nuevo no debe reemplazar la oferta durable.'
    })
    assert.deepEqual(sent, [originalReply])
    assert.equal(retry.durableStatus, 'completed')
    assert.equal(retry.resumed, undefined)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => {})
  }
})

test('un fallo del splitter o de su telemetría nunca deja mudo al agente', async () => {
  const sent = []
  let completed = false
  const original = 'Esta respuesta debe enviarse completa aunque falle la mini-IA.'
  const result = await sendReplyParts({
    contactId: 'contacto-fallback-globos',
    phone: '+526561111111',
    latest: { id: 'mensaje-fallback-globos', phone: '+526561111111' },
    agentConfig: {
      id: 'agente-fallback-globos',
      replyDelivery: { mode: 'split', splitMessagesEnabled: true }
    },
    reply: original,
    apiKey: 'sk-test',
    dependencies: {
      splitter: async () => { throw new Error('splitter_caido') },
      sendTextMessage: async ({ text }) => { sent.push(text) },
      loadNewerInbound: async () => null,
      recordEvent: async () => { throw new Error('telemetria_caida') },
      markReplyComplete: async () => { completed = true }
    }
  })

  assert.deepEqual(sent, [original])
  assert.deepEqual(result.parts, [original])
  assert.equal(result.sentParts, 1)
  assert.equal(completed, true)
})

test('un fallo aislado de telemetría conserva todos los globos ya validados', async () => {
  const sent = []
  const result = await sendReplyParts({
    contactId: 'contacto-telemetria-globos',
    phone: '+526561111111',
    latest: { id: 'mensaje-telemetria-globos', phone: '+526561111111' },
    agentConfig: {
      id: 'agente-telemetria-globos',
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        delayBetweenBubblesEnabled: false
      }
    },
    reply: 'Primera idea. Segunda idea.',
    dependencies: {
      splitter: async () => ({
        messages: ['Primera idea.', 'Segunda idea.'],
        source: 'ai',
        reason: 'exact_content_preserved'
      }),
      sendTextMessage: async ({ text }) => { sent.push(text) },
      loadNewerInbound: async () => null,
      recordEvent: async () => { throw new Error('telemetria_caida') },
      markReplyComplete: async () => {}
    }
  })

  assert.deepEqual(sent, ['Primera idea.', 'Segunda idea.'])
  assert.equal(result.sentParts, 2)
})

test('si entra otro mensaje mientras la mini-IA divide no sale ni el primer globo viejo', async () => {
  const sent = []
  const newerInbound = { id: 'mensaje-nuevo-durante-splitter', message_text: 'y también manejan sábados?' }
  const result = await sendReplyParts({
    contactId: 'contacto-interrumpe-splitter',
    phone: '+526561111111',
    latest: { id: 'mensaje-base-splitter', phone: '+526561111111' },
    agentConfig: {
      id: 'agente-interrumpe-splitter',
      replyDelivery: { mode: 'split', splitMessagesEnabled: true }
    },
    reply: 'Primera idea. Segunda idea.',
    apiKey: 'sk-test',
    dependencies: {
      splitter: async () => ({
        messages: ['Primera idea.', 'Segunda idea.'],
        source: 'ai',
        reason: 'exact_content_preserved'
      }),
      sendTextMessage: async ({ text }) => { sent.push(text) },
      loadNewerInbound: async () => newerInbound,
      recordEvent: async () => {}
    }
  })

  assert.deepEqual(sent, [])
  assert.equal(result.sentParts, 0)
  assert.equal(result.interruptedBy, newerInbound)
})

test('si el contacto interrumpe entre globos se detienen los restantes y se devuelve el inbound', async () => {
  const sequence = []
  let inboundChecks = 0
  const newerInbound = { id: 'waapi_msg_interrumpe_globos', message_text: 'también dónde están ubicados?' }
  const result = await sendReplyParts({
    contactId: 'contacto-interrumpe-globos',
    phone: '+526561111111',
    latest: {
      id: 'waapi_msg_costos',
      phone: '+526561111111',
      business_phone: '+526562222222',
      business_phone_number_id: 'phone-row-test'
    },
    agentConfig: {
      id: 'agente-interrupcion-globos',
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        delayBetweenBubblesEnabled: true,
        minDelaySeconds: 2,
        maxDelaySeconds: 2
      }
    },
    reply: 'globo uno\n\nglobo dos\n\nglobo tres',
    apiKey: 'sk-test',
    model: 'gpt-test',
    dependencies: {
      splitter: async () => ({
        messages: ['globo uno', 'globo dos', 'globo tres'],
        source: 'test',
        reason: 'fixture'
      }),
      sendTextMessage: async ({ text }) => {
        sequence.push(`send:${text}`)
      },
      wait: async (delayMs) => {
        sequence.push(`wait:${delayMs}`)
      },
      loadNewerInbound: async () => {
        inboundChecks += 1
        return inboundChecks === 1 ? null : newerInbound
      },
      recordEvent: async (event) => {
        sequence.push(`event:${event.eventType}`)
      },
      markReplyComplete: async () => {
        sequence.push('complete')
      }
    }
  })

  assert.equal(result.interruptedBy, newerInbound)
  assert.equal(result.sentParts, 1)
  assert.deepEqual(result.parts, ['globo uno', 'globo dos', 'globo tres'])
  assert.deepEqual(sequence, [
    'event:reply_splitter_result',
    'send:globo uno',
    'event:reply_part_sent',
    'event:reply_part_wait_started',
    'wait:2000'
  ])
})

test('una cuarentena activa justo antes de entregar bloquea el primer globo', async () => {
  const sent = []
  let safetyLockEntries = 0
  const result = await sendReplyParts({
    contactId: 'contacto-safety-antes',
    phone: '+526561111111',
    latest: { id: 'mensaje-safety-antes', phone: '+526561111111' },
    agentConfig: {
      id: 'agente-safety-antes',
      replyDelivery: { mode: 'split', splitMessagesEnabled: true, minParts: 2, maxParts: 3 }
    },
    reply: 'globo uno\n\nglobo dos',
    channel: 'whatsapp',
    dependencies: {
      splitter: async () => ({ messages: ['globo uno', 'globo dos'], source: 'test', reason: 'ok' }),
      wait: async () => undefined,
      loadNewerInbound: async () => null,
      withSafetyDeliveryLock: async (callback) => {
        safetyLockEntries += 1
        return callback()
      },
      loadPreventiveMeasure: async () => ({ id: 'safety-case-before', category: 'phishing' }),
      sendTextMessage: async ({ text }) => sent.push(text),
      recordEvent: async () => undefined
    }
  })

  assert.equal(result.suppressedByPreventiveMeasure, true)
  assert.equal(result.sentParts, 0)
  assert.equal(safetyLockEntries, 1)
  assert.deepEqual(sent, [])
})

test('si otra instancia activa cuarentena entre globos no sale el resto', async () => {
  const sent = []
  let checks = 0
  const result = await sendReplyParts({
    contactId: 'contacto-safety-entre',
    phone: '+526561111111',
    latest: { id: 'mensaje-safety-entre', phone: '+526561111111' },
    agentConfig: {
      id: 'agente-safety-entre',
      replyDelivery: { mode: 'split', splitMessagesEnabled: true, minParts: 2, maxParts: 3 }
    },
    reply: 'globo uno\n\nglobo dos\n\nglobo tres',
    channel: 'whatsapp',
    dependencies: {
      splitter: async () => ({ messages: ['globo uno', 'globo dos', 'globo tres'], source: 'test', reason: 'ok' }),
      wait: async () => undefined,
      loadNewerInbound: async () => null,
      withSafetyDeliveryLock: async (callback) => callback(),
      loadPreventiveMeasure: async () => {
        checks += 1
        return checks === 1 ? null : { id: 'safety-case-between', category: 'threat' }
      },
      sendTextMessage: async ({ text }) => {
        sent.push(text)
        return { id: `provider-${sent.length}` }
      },
      recordEvent: async () => undefined
    }
  })

  assert.equal(result.suppressedByPreventiveMeasure, true)
  assert.equal(result.sentParts, 1)
  assert.deepEqual(sent, ['globo uno'])
})

test('correo sale como una sola respuesta aunque el agente tenga globitos activos', async () => {
  const sent = []
  const result = await sendReplyParts({
    contactId: 'contacto-email-test',
    latest: {
      id: 'email-inicial',
      subject: 'Duda sobre cita',
      from_email: 'cliente@example.com',
      channel: 'email'
    },
    agentConfig: {
      id: 'agente-email-test',
      replyDelivery: {
        mode: 'split',
        splitMessagesEnabled: true,
        delayBetweenBubblesEnabled: true,
        minDelaySeconds: 2,
        maxDelaySeconds: 2
      }
    },
    reply: 'Hola, claro. Te paso la información completa en este correo.',
    channel: 'email',
    dependencies: {
      splitter: async () => {
        throw new Error('el correo no debe usar divisor de globitos')
      },
      sendTextMessage: async ({ channel, text }) => {
        sent.push({ channel, text })
      },
      wait: async () => {
        throw new Error('el correo no debe esperar entre globos')
      },
      recordEvent: async () => {},
      markReplyComplete: async () => {}
    }
  })

  assert.deepEqual(result.parts, ['Hola, claro. Te paso la información completa en este correo.'])
  assert.deepEqual(sent, [{ channel: 'email', text: 'Hola, claro. Te paso la información completa en este correo.' }])
})

test('mantiene una sola respuesta cuando la entrega está en modo normal', () => {
  const parts = splitReplyIntoParts('hola, te explico rápido. este mensaje podría dividirse, pero no debe.', {
    mode: 'single',
    maxBubbleLength: 120,
    minDelaySeconds: 1,
    maxDelaySeconds: 3
  })

  assert.deepEqual(parts, ['hola, te explico rápido. este mensaje podría dividirse, pero no debe.'])
})

test('la mini-IA barata parte respuestas largas sin cambiar el contenido', async () => {
  const longReply = [
    'va, ya te entendí. Lo primero es ubicar qué necesitas resolver ahorita y qué tan urgente se volvió para ti.',
    'También necesito saber si ya intentaste algo antes, porque eso cambia bastante la recomendación.',
    'Con esa información puedo decirte cuál sería el siguiente paso sin inventarte cosas ni darte vueltas.'
  ].join(' ')

  let requestedModel = null
  const result = await splitMessageIntoBubbles({
    text: longReply,
    settings: {
      mode: 'split',
      splitMessagesEnabled: true,
      maxBubbleLength: 120,
      maxBubbles: 6
    },
    aiSplitter: async ({ model }) => {
      requestedModel = model
      return {
        messages: [
          'va, ya te entendí. Lo primero es ubicar qué necesitas resolver ahorita y qué tan urgente se volvió para ti.',
          'También necesito saber si ya intentaste algo antes, porque eso cambia bastante la recomendación.',
          'Con esa información puedo decirte cuál sería el siguiente paso sin inventarte cosas ni darte vueltas.'
        ]
      }
    }
  })

  assert.equal(requestedModel, MESSAGE_SPLITTER_MODEL)
  assert.equal(result.source, 'ai')
  assert.equal(result.messages.length, 3)
  assert.equal(result.messages.join(' '), longReply)
})

test('si la mini-IA intenta cambiar el texto se manda completo y sin reescribir', async () => {
  const first = 'sí, mañana a las 5 está perfecto y ya revisé todos los detalles necesarios para confirmar.'
  const second = 'En cuanto quede registrado te mando la confirmación completa por este mismo chat.'
  const original = `${first} ${second}`
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, maxBubbles: 6 },
    aiSplitter: async () => ({ messages: [`Sí${first.slice(2)}`, second] })
  })

  assert.equal(result.source, 'fallback')
  assert.equal(result.reason, 'content_changed')
  assert.deepEqual(result.messages, [original])
})

test('pausas entre globos se pueden apagar', () => {
  const delayMs = getAgentReplyDeliveryPartDelayMs({
    replyDelivery: {
      mode: 'split',
      delayBetweenBubblesEnabled: false,
      minDelaySeconds: 2,
      maxDelaySeconds: 7
    }
  })

  assert.equal(delayMs, 0)
})

test('describe adjuntos multimedia en mensajes conversacionales', () => {
  const row = {
    message_type: 'image',
    media_url: 'https://cdn.test/foto.jpg',
    media_mime_type: 'image/jpeg',
    media_filename: 'foto.jpg'
  }

  assert.equal(inferConversationalMediaKind(row), 'image')
  const summary = buildConversationalMediaSummary(row)
  assert.match(summary, /Adjunto recibido: imagen/)
  assert.match(summary, /foto\.jpg/)
  assert.match(summary, /image\/jpeg/)
})

test('habilita multimedia binaria solo si el runtime la soporta', () => {
  assert.equal(shouldIncludeConversationalBinaryMedia({ runtime: { providerId: 'gemini', supportsMultimodalInputs: true } }), true)
  assert.equal(shouldIncludeConversationalBinaryMedia({ runtime: { providerId: 'openai', supportsMultimodalInputs: true } }), true)
  assert.equal(shouldIncludeConversationalBinaryMedia({ runtime: { supportsMultimodalInputs: false } }), false)
  assert.equal(shouldIncludeConversationalBinaryMedia({ runtime: { providerId: 'claude' } }), false)
})

test('prepara imagen entrante como adjunto visual para el agente conversacional', async () => {
  const messages = [{
    role: 'user',
    content: 'te mando foto',
    message_type: 'image',
    media_url: 'https://cdn.test/foto.jpg',
    media_mime_type: 'image/jpeg',
    media_filename: 'foto.jpg'
  }]

  const hydrated = await hydrateConversationalMessagesMedia(messages, {
    includeBinary: true,
    fetchMediaBuffer: async () => ({
      buffer: Buffer.from([1, 2, 3, 4]),
      mimeType: 'image/jpeg',
      filename: 'foto.jpg'
    })
  })

  assert.equal(hydrated[0].attachments.length, 1)
  assert.equal(hydrated[0].attachments[0].kind, 'image')
  assert.match(hydrated[0].attachments[0].dataUrl, /^data:image\/jpeg;base64,/)
  assert.match(hydrated[0].content, /Contexto del adjunto/)
  assert.match(hydrated[0].content, /analisis directo/)
})

test('convierte imagen entrante a analisis textual cuando el proveedor no acepta binario', async () => {
  const messages = [{
    role: 'user',
    content: 'que ves',
    message_type: 'image',
    media_url: 'https://cdn.test/foto.jpg',
    media_mime_type: 'image/jpeg',
    media_filename: 'foto.jpg'
  }]

  const hydrated = await hydrateConversationalMessagesMedia(messages, {
    includeBinary: false,
    fetchMediaBuffer: async () => ({
      buffer: Buffer.from([1, 2, 3, 4]),
      mimeType: 'image/jpeg',
      filename: 'foto.jpg'
    }),
    analyzeVisualMedia: async ({ attachment }) => {
      assert.equal(attachment.kind, 'image')
      return 'Se ve una persona frente a una cabina roja.'
    }
  })

  assert.equal(hydrated[0].attachments.length, 0)
  assert.match(hydrated[0].content, /Analisis automatico del adjunto: Se ve una persona frente a una cabina roja/)
})

test('transcribe audio entrante antes de responder con el agente conversacional', async () => {
  const messages = [{
    role: 'user',
    content: '',
    message_type: 'audio',
    media_url: 'https://cdn.test/nota.webm',
    media_mime_type: 'audio/webm',
    media_filename: 'nota.webm'
  }]

  const hydrated = await hydrateConversationalMessagesMedia(messages, {
    aiProvider: 'openai',
    apiKey: 'sk-test',
    audioTranscriptionApiKey: 'sk-test',
    includeBinary: true,
    fetchMediaBuffer: async () => ({
      buffer: Buffer.from('audio bytes'),
      mimeType: 'audio/webm',
      filename: 'nota.webm'
    }),
    transcribeAudio: async ({ audioBuffer, mimeType }) => {
      assert.equal(audioBuffer.toString(), 'audio bytes')
      assert.equal(mimeType, 'audio/webm')
      return { text: 'quiero cotizar una cita para mañana' }
    }
  })

  assert.equal(hydrated[0].attachments.length, 0)
  assert.match(hydrated[0].content, /Transcripción del audio: quiero cotizar una cita para mañana/)
})

test('video entrante queda como referencia sin fingir análisis visual completo', async () => {
  let fetched = false
  const messages = [{
    role: 'user',
    content: 'mira este video',
    message_type: 'video',
    media_url: 'https://cdn.test/video.mp4',
    media_mime_type: 'video/mp4',
    media_filename: 'video.mp4'
  }]

  const hydrated = await hydrateConversationalMessagesMedia(messages, {
    includeBinary: true,
    fetchMediaBuffer: async () => {
      fetched = true
      return null
    }
  })

  assert.equal(fetched, false)
  assert.equal(hydrated[0].attachments.length, 0)
  assert.match(hydrated[0].content, /Adjunto recibido: video/)
  assert.match(hydrated[0].content, /no analiza movimiento/)
})

test('prepara adjuntos del demo conversacional aunque el mensaje no tenga texto', async () => {
  const dataUrl = `data:application/pdf;base64,${Buffer.from('pdf bytes').toString('base64')}`
  const hydrated = await hydrateConversationalPreviewMessagesMedia([{
    role: 'user',
    content: '',
    attachments: [{
      kind: 'document',
      name: 'cotizacion.pdf',
      mimeType: 'application/pdf',
      dataUrl
    }]
  }], {
    includeBinary: true
  })

  assert.match(hydrated[0].content, /Adjunto recibido: documento/)
  assert.match(hydrated[0].content, /cotizacion\.pdf/)
  assert.equal(hydrated[0].attachments.length, 1)
  assert.equal(hydrated[0].attachments[0].kind, 'pdf')
  assert.equal(hydrated[0].attachments[0].dataUrl, dataUrl)
  assert.match(hydrated[0].content, /analisis directo/)
})

test('demo convierte imagen a analisis textual cuando el proveedor no acepta image_url', async () => {
  const dataUrl = `data:image/jpeg;base64,${Buffer.from('image bytes').toString('base64')}`
  const hydrated = await hydrateConversationalPreviewMessagesMedia([{
    role: 'user',
    content: '',
    attachments: [{
      kind: 'image',
      name: 'foto.jpg',
      mimeType: 'image/jpeg',
      dataUrl
    }]
  }], {
    includeBinary: false,
    analyzeVisualMedia: async ({ attachment, analysisPart }) => {
      assert.equal(attachment.kind, 'image')
      assert.equal(analysisPart.type, 'input_image')
      return { text: 'Hay una persona en la calle junto a una cabina telefonica roja.' }
    }
  })

  assert.match(hydrated[0].content, /Adjunto recibido: imagen/)
  assert.match(hydrated[0].content, /Analisis automatico del adjunto: Hay una persona en la calle/)
  assert.equal(hydrated[0].attachments.length, 0)
})

test('transcribe notas de voz enviadas desde el demo conversacional', async () => {
  const hydrated = await hydrateConversationalPreviewMessagesMedia([{
    role: 'user',
    content: '',
    attachments: [{
      kind: 'audio',
      name: 'nota.webm',
      mimeType: 'audio/webm',
      dataUrl: `data:audio/webm;base64,${Buffer.from('audio bytes').toString('base64')}`,
      durationMs: 2200
    }]
  }], {
    aiProvider: 'openai',
    apiKey: 'sk-test',
    audioTranscriptionApiKey: 'sk-test',
    includeBinary: true,
    transcribeAudio: async ({ audioBuffer, mimeType }) => {
      assert.equal(audioBuffer.toString(), 'audio bytes')
      assert.equal(mimeType, 'audio/webm')
      return { text: 'busco una cita con el doctor el viernes' }
    }
  })

  assert.equal(hydrated[0].attachments.length, 0)
  assert.match(hydrated[0].content, /Transcripción del audio: busco una cita con el doctor el viernes/)
})

test('prepara miniatura de video del demo como entrada visual', async () => {
  const thumbnailDataUrl = `data:image/jpeg;base64,${Buffer.from('thumbnail bytes').toString('base64')}`
  const hydrated = await hydrateConversationalPreviewMessagesMedia([{
    role: 'user',
    content: 'mira este video',
    attachments: [{
      kind: 'video',
      name: 'situacion.mp4',
      mimeType: 'video/mp4',
      dataUrl: `data:video/mp4;base64,${Buffer.from('video bytes').toString('base64')}`,
      thumbnailDataUrl,
      durationMs: 3400
    }]
  }], {
    includeBinary: true
  })

  assert.match(hydrated[0].content, /Adjunto recibido: video/)
  assert.match(hydrated[0].content, /miniatura visual/)
  assert.equal(hydrated[0].attachments.length, 1)
  assert.equal(hydrated[0].attachments[0].kind, 'video')
  assert.equal(hydrated[0].attachments[0].thumbnailDataUrl, thumbnailDataUrl)
})

test('demo convierte miniatura de video a analisis textual para proveedores sin binario', async () => {
  const thumbnailDataUrl = `data:image/jpeg;base64,${Buffer.from('thumbnail bytes').toString('base64')}`
  const hydrated = await hydrateConversationalPreviewMessagesMedia([{
    role: 'user',
    content: 'mira este video',
    attachments: [{
      kind: 'video',
      name: 'situacion.mp4',
      mimeType: 'video/mp4',
      dataUrl: `data:video/mp4;base64,${Buffer.from('video bytes').toString('base64')}`,
      thumbnailDataUrl,
      durationMs: 3400
    }]
  }], {
    includeBinary: false,
    analyzeVisualMedia: async ({ attachment, analysisPart }) => {
      assert.equal(attachment.kind, 'video')
      assert.equal(analysisPart.image_url, thumbnailDataUrl)
      return 'La miniatura muestra una recepcion con varias personas esperando.'
    }
  })

  assert.match(hydrated[0].content, /Analisis automatico del adjunto: La miniatura muestra/)
  assert.match(hydrated[0].content, /miniatura visual/)
  assert.equal(hydrated[0].attachments.length, 0)
})

test('recupera solo mensajes entrantes recientes que no fueron contestados', () => {
  const nowMs = Date.parse('2026-06-13T01:20:00Z')
  const latest = {
    id: 'inbound-reciente',
    message_timestamp: '2026-06-13 01:15:00',
    created_at: '2026-06-13 01:15:00'
  }

  assert.equal(shouldRecoverPendingInbound(latest, { status: 'active' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), true)
  assert.equal(shouldRecoverPendingInbound(latest, { status: 'paused' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound(latest, {
    status: 'active',
    lastAnsweredInboundMessageId: 'inbound-reciente'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound(latest, {
    status: 'active',
    lastReplyAt: '2026-06-13 01:16:00'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound(latest, {
    status: 'active',
    inboundProcessingMessageId: latest.id,
    inboundProcessingStatus: 'processing',
    inboundProcessingLeaseUntilAt: '2026-06-13T01:21:00.000Z'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound({
    ...latest,
    message_timestamp: '2026-06-12 23:00:00'
  }, {
    status: 'active',
    inboundProcessingMessageId: latest.id,
    inboundProcessingStatus: 'failed'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), true)
  assert.equal(shouldRecoverPendingInbound(latest, {
    status: 'active',
    inboundProcessingMessageId: latest.id,
    inboundProcessingStatus: 'completed'
  }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
  assert.equal(shouldRecoverPendingInbound({
    ...latest,
    id: 'inbound-viejo',
    message_timestamp: '2026-06-12 23:00:00'
  }, { status: 'active' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
})
