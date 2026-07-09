import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { CHEAPEST_OPENAI_MODEL } from '../src/config/openAIModels.js'
import { APPOINTMENT_CONFIRMATION_MODEL } from '../src/agents/appointmentConfirmationAgent.js'
import {
  assignAgentToConversation,
  buildConversationalAgentMetrics,
  CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY,
  completeConversationalAgentSalePaymentFromInvoice,
  completeConversationGoalLinkFromWebhook,
  createConversationalAgent,
  createConversationGoalLink,
  ensureConversationalAgentRuntimeEnabledForPublishedAgents,
  entryRulesMatch,
  getConversationalAgent,
  getConversationalAgentConfig,
  getConversationGoalLink,
  getConversationState,
  listConversationStates,
  listConversationStatesForContact,
  getAgentFollowUpStepDelayMs,
  getAgentReplyDeliveryPartDelayMs,
  handleConversationalAgentTriggerLinkClick,
  applyAgentCompletionAction,
  mergeAdvancedClosingContext,
  normalizeAgentFollowUp,
  normalizeAgentGoalWorkflow,
  normalizeAgentReplyDelivery,
  normalizeConversationalSuccessAction,
  recordConversationalAgentEvent,
  saveConversationalAgentConfig,
  setConversationSignal,
  setConversationStatus,
  setConversationalCompletionSummaryGeneratorForTest,
  shouldSuppressChatNotificationForConversationalAgent,
  shouldMigrateLegacyConversationalAgentConfig,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'
import { createTriggerLink } from '../src/services/triggerLinksService.js'
import {
  createLocalAppointment,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'
import {
  buildReplyPartDelaySchedule,
  buildPendingReplyContextMessage,
  normalizeConversationalChannel,
  RECOVERABLE_CONVERSATIONAL_CHANNELS,
  applyConversationalRuntimeReplyGuard,
  replySuggestsHumanHandoff,
  sanitizeAgentReply,
  sendReplyParts,
  rewritePrematurePriceDisclosure,
  shouldEscalateSilentSchedulingQuestion,
  waitForConversationalResponseWindow,
  shouldSendConversationalReplyThroughHighLevel,
  shouldIncludeConversationalBinaryMedia,
  shouldRecoverPendingInbound,
  splitReplyIntoParts
} from '../src/agents/conversational/runner.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
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
  DEFAULT_CLOSING_STRATEGY,
  LIGHT_DIRECT_CLOSING_STRATEGY,
  buildBusinessAdaptiveClosingSection,
  buildClosingStrategyTemplateParameters,
  buildConversationalInstructions,
  renderClosingStrategyTemplate,
  resolveDefaultClosingStrategyBase,
  usesLightDirectClosingBase
} from '../src/agents/conversational/prompt.js'
import {
  buildBusinessProfilePromptParameters,
  normalizeBusinessProfileExtraction
} from '../src/services/aiAgentService.js'
import {
  resolveHighLevelMessageChannel,
  upsertHighLevelConversationMessage
} from '../src/services/highlevelConversationsSyncService.js'

test('flujos IA automaticos de bajo costo usan siempre el modelo mas barato aprobado', () => {
  assert.equal(CHEAPEST_OPENAI_MODEL, 'gpt-5.4-nano')
  assert.equal(MESSAGE_SPLITTER_MODEL, CHEAPEST_OPENAI_MODEL)
  assert.equal(APPOINTMENT_CONFIRMATION_MODEL, CHEAPEST_OPENAI_MODEL)
})

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

    await assert.rejects(
      updateConversationalAgent(agent.id, {
        followUp: {
          enabled: true,
          first: { enabled: true, value: 3, unit: 'hours' },
          second: { enabled: true, value: 2, unit: 'hours' },
          strategy: 'retomar sin sonar automático'
        }
      }),
      /orden de los seguimientos/
    )
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

test('agenda conversacional respeta la politica de empalme de citas', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_conv_overlap_${suffix}`
  const appointmentId = `rstk_appt_conv_overlap_${suffix}`
  const contactId = `rstk_contact_conv_overlap_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 30 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const dateKey = nextMonday.toISODate()
  const slotStart = nextMonday
    .set({ hour: 15, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate()
  const slotEnd = new Date(slotStart.getTime() + 60 * 60000)
  const expectedSlot = slotStart.toISOString()
  const includesExpectedSlot = (days = []) => days
    .flatMap((day) => Array.isArray(day.slots) ? day.slots : [])
    .some((slot) => Math.abs(new Date(slot).getTime() - slotStart.getTime()) < 1000)

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'loc_conv_overlap_test',
      name: 'Calendario agente empalme',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 15, openMinute: 0, closeHour: 17, closeMinute: 0 }]
        }
      ]
    }, {
      source: 'ristak',
      syncStatus: 'synced'
    })

    await createLocalAppointment({
      id: appointmentId,
      calendarId,
      contactId: 'contact_existing_overlap',
      locationId: 'loc_conv_overlap_test',
      title: 'Cita existente',
      source: 'ristak',
      startTime: slotStart.toISOString(),
      endTime: slotEnd.toISOString(),
      appointmentStatus: 'confirmed'
    }, {
      locationId: 'loc_conv_overlap_test',
      syncStatus: 'synced'
    })

    const blockedCtx = {
      contactId,
      dryRun: true,
      actions: [],
      config: {
        objective: 'citas',
        successAction: 'book_appointment',
        goalWorkflow: {
          appointments: {
            owner: 'ai',
            calendarId,
            allowOverlappingAppointments: false
          }
        }
      }
    }
    const blockedTools = createConversationalTools(blockedCtx)
    const blockedFreeSlots = blockedTools.find((item) => item.name === 'get_free_slots')
    const blockedBook = blockedTools.find((item) => item.name === 'book_appointment')
    assert.ok(blockedFreeSlots)
    assert.ok(blockedBook)
    // Un agente de citas cierra con book_appointment (cita real), no con mark_ready_to_advance.
    assert.equal(blockedTools.find((item) => item.name === 'mark_ready_to_advance'), undefined)

    const unavailable = await blockedFreeSlots.invoke(null, JSON.stringify({ calendarId, startDate: dateKey, endDate: dateKey }))
    assert.equal(unavailable.overlapPolicy, 'blocked')
    assert.equal(includesExpectedSlot(unavailable.slots), false)

    const blockedAppointment = await blockedBook.invoke(null, JSON.stringify({
      calendarId,
      startTime: expectedSlot,
      title: 'Cita nueva',
      notes: 'Debe bloquearse'
    }))
    assert.equal(blockedAppointment.ok, false)
    assert.equal(blockedAppointment.overlapBlocked, true)
    assert.match(blockedAppointment.error, /no permite empalmar citas/)

    const allowedCtx = {
      ...blockedCtx,
      actions: [],
      config: {
        ...blockedCtx.config,
        goalWorkflow: {
          appointments: {
            owner: 'ai',
            calendarId,
            allowOverlappingAppointments: true
          }
        }
      }
    }
    const allowedTools = createConversationalTools(allowedCtx)
    const allowedFreeSlots = allowedTools.find((item) => item.name === 'get_free_slots')
    const allowedBook = allowedTools.find((item) => item.name === 'book_appointment')
    assert.ok(allowedFreeSlots)
    assert.ok(allowedBook)

    const available = await allowedFreeSlots.invoke(null, JSON.stringify({ calendarId, startDate: dateKey, endDate: dateKey }))
    assert.equal(available.overlapPolicy, 'allowed')
    assert.ok(includesExpectedSlot(available.slots))

    const allowedAppointment = await allowedBook.invoke(null, JSON.stringify({
      calendarId,
      startTime: expectedSlot,
      title: 'Cita nueva',
      notes: 'Puede empalmar'
    }))
    assert.equal(allowedAppointment.ok, true)
    assert.equal(allowedAppointment.simulated, true)
    assert.equal(allowedAppointment.appointment.startTime, expectedSlot)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('book_appointment rechaza un horario inventado o fuera de horario de atención', async () => {
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
        successAction: 'book_appointment',
        goalWorkflow: { appointments: { owner: 'ai', calendarId, allowOverlappingAppointments: false } }
      }
    }
    const bookTool = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    assert.ok(bookTool)

    const result = await bookTool.invoke(null, JSON.stringify({
      calendarId,
      startTime: outOfHours,
      title: 'Cita inventada',
      notes: 'Hora fuera de horario de atención'
    }))
    assert.equal(result.ok, false)
    assert.equal(result.invalidSlot, true)
    assert.equal(ctx.actions.length, 0)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('tool de avance bloquea la meta si falta validar anticipo configurado', async () => {
  const ctx = {
    contactId: 'test_deposit_gate_contact',
    dryRun: true,
    actions: [],
    config: {
      objective: 'citas',
      successAction: 'ready_for_human',
      goalWorkflow: {
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 900,
          currency: 'MXN'
        }
      }
    }
  }
  const markReadyTool = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
  assert.ok(markReadyTool)

  const blocked = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere agendar valoración',
    resumen: 'Pidió horarios para esta semana',
    urgencia: 'media',
    siguientePaso: 'Validar anticipo',
    confirm: true,
    anticipoValidado: false
  }))

  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /Falta validar el anticipo \(900 MXN\)/)
  assert.equal(ctx.actions.length, 0)

  const allowed = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere agendar valoración',
    resumen: 'Mandó comprobante del anticipo',
    urgencia: 'media',
    siguientePaso: 'Confirmar horario',
    confirm: true,
    anticipoValidado: true
  }))

  assert.equal(allowed.ok, true)
  assert.equal(allowed.simulated, true)
  assert.equal(allowed.signal, 'ready_for_human')
  assert.equal(ctx.actions[0]?.type, 'mark_ready_to_advance')
})

test('mark_ready_to_advance no cierra sin confirmación explícita (candado anti falso cierre)', async () => {
  const ctx = {
    contactId: 'test_confirm_gate_contact',
    dryRun: true,
    actions: [],
    config: {
      objective: 'citas',
      successAction: 'ready_for_human',
      goalWorkflow: {}
    }
  }
  const markReadyTool = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
  assert.ok(markReadyTool)

  // Sin confirm: sólo interés blando -> NO debe marcar objetivo cumplido.
  const soft = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Sólo mostró interés general',
    resumen: 'Dijo "me interesa" pero no pidió avanzar',
    urgencia: 'baja',
    siguientePaso: 'Seguir conversando',
    confirm: false
  }))
  assert.equal(soft.ok, false)
  assert.match(soft.error, /Aún no\. Ejecuta esto SÓLO cuando el objetivo del agente ya se cumplió/)
  assert.equal(ctx.actions.length, 0)

  // Con confirm: la persona pidió explícitamente avanzar -> sí procede (simulado).
  const ready = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Pidió que un asesor lo contacte',
    resumen: 'Dijo "quiero que me llamen"',
    urgencia: 'alta',
    siguientePaso: 'Pasar a asesor',
    confirm: true
  }))
  assert.equal(ready.ok, true)
  assert.equal(ready.simulated, true)
  assert.equal(ready.signal, 'ready_for_human')
  assert.equal(ready.wouldMarkObjectiveCompleted, true)
  assert.equal(ctx.actions[0]?.type, 'mark_ready_to_advance')
  assert.equal(ctx.actions[0]?.effect?.marksObjectiveCompleted, true)
})

test('mark_ready_to_advance cubre datos/filtrar/personalizado (cierre por humano), no las acciones concretas', () => {
  const toolNames = (config) => createConversationalTools({
    contactId: 'test_obj_coverage', dryRun: true, actions: [], config
  }).map((item) => item.name)

  // datos y filtrar cierran juntando datos / calificando y avisando a un humano.
  for (const objective of ['datos', 'filtrar', 'custom']) {
    const names = toolNames({ objective, successAction: 'ready_for_human', goalWorkflow: {} })
    assert.ok(names.includes('mark_ready_to_advance'), `${objective} debe exponer mark_ready_to_advance`)
  }

  // Las acciones de cierre concretas NO exponen mark_ready_to_advance: cierran con su acción real.
  for (const successAction of ['book_appointment', 'ready_to_buy', 'send_goal_url', 'send_trigger_link']) {
    const names = toolNames({ objective: 'citas', successAction, goalWorkflow: {} })
    assert.equal(names.includes('mark_ready_to_advance'), false, `${successAction} no debe exponer mark_ready_to_advance`)
  }
})

test('agente de ventas cierra con create_payment_link, no con mark_ready_to_advance', () => {
  const ctx = {
    contactId: 'test_sales_scoping_contact',
    dryRun: true,
    actions: [],
    accountLocale: { currency: 'USD' },
    config: {
      objective: 'ventas',
      successAction: 'ready_to_buy',
      goalWorkflow: {
        sales: {
          paymentMode: 'full_payment'
        },
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 500
        }
      }
    }
  }
  const tools = createConversationalTools(ctx)
  // mark_ready_to_advance ya NO se expone para ventas: marcaría objetivo cumplido sin pago real.
  assert.equal(tools.find((item) => item.name === 'mark_ready_to_advance'), undefined)
  // El cierre de ventas es enviar el link (la venta queda PENDIENTE hasta el pago real).
  assert.ok(tools.find((item) => item.name === 'create_payment_link'))
  // Sigue pudiendo escalar a humano cuando se atora, sin marcar objetivo cumplido.
  assert.ok(tools.find((item) => item.name === 'send_to_human'))
})

test('modo solicitar anticipo en venta bloquea hasta comprobante y usa moneda de cuenta', async () => {
  const ctx = {
    contactId: 'test_sales_deposit_contact',
    dryRun: true,
    actions: [],
    accountLocale: { currency: 'USD' },
    config: {
      objective: 'ventas',
      successAction: 'ready_for_human',
      goalWorkflow: {
        sales: {
          paymentMode: 'deposit'
        },
        deposit: {
          enabled: false,
          mode: 'fixed',
          amount: 300,
          currency: ''
        }
      }
    }
  }
  const markReadyTool = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
  assert.ok(markReadyTool)

  const blocked = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere apartar su lugar',
    resumen: 'Aceptó dejar pago inicial',
    urgencia: 'alta',
    siguientePaso: 'Pasar al asesor',
    confirm: true
  }))

  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /Falta validar el pago solicitado \(300 USD\)/)
  assert.equal(ctx.actions.length, 0)

  const allowed = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere apartar su lugar',
    resumen: 'Mandó comprobante válido',
    urgencia: 'alta',
    siguientePaso: 'Pasar al asesor',
    confirm: true,
    comprobanteValidado: true
  }))

  assert.equal(allowed.ok, true)
  assert.equal(allowed.signal, 'ready_for_human')
  assert.equal(ctx.actions[0]?.type, 'mark_ready_to_advance')
})

test('anticipo configurado desde la meta también bloquea enlace de venta hasta comprobante', async () => {
  const ctx = {
    contactId: 'test_sales_deposit_goal_url_contact',
    dryRun: true,
    actions: [],
    accountLocale: { currency: 'USD' },
    config: {
      objective: 'ventas',
      successAction: 'send_goal_url',
      goalWorkflow: {
        sales: {
          paymentMode: 'deposit',
          url: 'https://checkout.test/pedido',
          trackingParam: 'pedido_ref'
        },
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 250,
          currency: ''
        }
      }
    }
  }
  const sendGoalUrlTool = createConversationalTools(ctx).find((item) => item.name === 'send_goal_url')
  assert.ok(sendGoalUrlTool)

  const blocked = await sendGoalUrlTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere comprar',
    resumen: 'Aceptó pagar anticipo antes del checkout',
    confirm: true
  }))

  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /Falta validar el pago solicitado \(250 USD\)/)
  assert.equal(ctx.actions.length, 0)

  const allowed = await sendGoalUrlTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere comprar',
    resumen: 'Mandó comprobante válido',
    confirm: true,
    comprobanteValidado: true
  }))

  assert.equal(allowed.ok, true)
  assert.equal(allowed.simulated, true)
  assert.match(allowed.sentUrl, /goal_simulado/)
  assert.equal(ctx.actions[0]?.type, 'send_goal_url')
})

test('acción final del agente asigna el contacto al usuario configurado', async () => {
  const contactId = 'test_completion_assign_contact'

  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, custom_fields, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215550000033', 'completion@test.local', 'Completion Test', JSON.stringify({ leadScore: 'alto' }), 'test']
    )

    const result = await applyAgentCompletionAction({
      goalWorkflow: {
        completion: {
          mode: 'assign_user',
          userId: 'user_completion_1',
          userName: 'Ana Ventas'
        }
      }
    }, contactId)

    assert.equal(result.mode, 'assign_user')
    assert.equal(result.userId, 'user_completion_1')

    const row = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
    const customFields = JSON.parse(row.custom_fields)
    assert.equal(customFields.leadScore, 'alto')
    assert.equal(customFields.assignedUser, 'user_completion_1')
    assert.equal(customFields.assignedUserName, 'Ana Ventas')
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('resumen de meta concretada lo genera un resumidor interno con el historial completo', async () => {
  const contactId = 'test_completion_closing_context_summary'

  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215550000066', 'closing-summary@test.local', 'Closing Summary Test', 'test']
    )
    await db.run(
      `INSERT INTO conversational_agent_state (contact_id, status, closing_context_json, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
      [contactId, 'active', JSON.stringify({
        contactReason: 'Dolor en rodilla derecha al subir escaleras y caminar',
        whyNow: 'Lleva tres semanas sin mejorar y ya no quiere dejarlo pasar',
        realProblem: 'Teme una lesion de menisco por correr y jugar futbol',
        problemMagnitudeAwareness: 'Ya entiende que seguir entrenando con dolor puede empeorar la lesion',
        attemptedBefore: 'Rodillera, hielo e ibuprofeno con alivio minimo',
        impact: 'Trabaja de pie y no puede entrenar con confianza',
        objection: 'Pensaba que se iba a quitar solo y le preocupaba el gasto',
        desiredOutcome: 'Volver a entrenar sin miedo',
        timingPreference: 'Jueves 25 de junio a las 11:00 AM'
      })]
    )
    await db.run(`
      INSERT INTO whatsapp_api_messages (id, contact_id, direction, message_type, message_text, message_timestamp, created_at)
      VALUES
        (?, ?, 'inbound', 'text', ?, '2026-06-21T16:00:00.000Z', '2026-06-21T16:00:00.000Z'),
        (?, ?, 'outbound', 'text', ?, '2026-06-21T16:01:00.000Z', '2026-06-21T16:01:00.000Z'),
        (?, ?, 'inbound', 'text', ?, '2026-06-21T16:02:00.000Z', '2026-06-21T16:02:00.000Z')
    `, [
      `${contactId}_msg_1`, contactId, 'Me duele la rodilla derecha desde hace semanas y con hielo e ibuprofeno no se me quita.',
      `${contactId}_msg_2`, contactId, 'Va, revisemos horarios para una valoración.',
      `${contactId}_msg_3`, contactId, 'Sí agéndame el jueves, me preocupa lesionarme más cuando entreno.'
    ])
    setConversationalCompletionSummaryGeneratorForTest(async ({ messages, actionSummary, fallbackSummary }) => {
      assert.ok(messages.some((message) => message.text.includes('rodilla derecha')))
      assert.match(actionSummary, /Agendó cita/)
      assert.equal(fallbackSummary, '')
      return 'Dolor de rodilla derecha sin mejorar con hielo e ibuprofeno; quiere valoración porque teme lesionarse al entrenar.'
    })

    await setConversationSignal(contactId, 'appointment_booked', {
      reason: 'Cita agendada por el agente',
      actionSummarySource: 'Cita - Closing Summary Test · 2026-06-25T17:00:00.000Z',
      originalSummary: 'Cita - Closing Summary Test · 2026-06-25T17:00:00.000Z',
      status: 'completed',
      agentId: 'agent_summary_test'
    })

    const state = await getConversationState(contactId)
    assert.match(state.signalSummary, /Agendó cita para el jueves 25 de junio a las 11 a\.m\./)
    assert.match(state.signalSummary, /Resumen: Dolor de rodilla derecha sin mejorar con hielo e ibuprofeno/)
    assert.doesNotMatch(state.signalSummary, /Rodillera/)
    assert.doesNotMatch(state.signalSummary, /Volver a entrenar sin miedo/)

    const event = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'signal_set' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    const detail = JSON.parse(event.detail_json)
    assert.equal(detail.signal, 'appointment_booked')
    assert.match(detail.actionSummary, /Agendó cita para el jueves 25 de junio a las 11 a\.m\./)
    assert.equal(detail.summary, 'Dolor de rodilla derecha sin mejorar con hielo e ibuprofeno; quiere valoración porque teme lesionarse al entrenar.')
    assert.equal(detail.summarySource, 'internal_summary_agent')
    assert.doesNotMatch(detail.summary, /preocupaba el gasto/)
    assert.equal(detail.originalSummary, 'Cita - Closing Summary Test · 2026-06-25T17:00:00.000Z')
  } finally {
    setConversationalCompletionSummaryGeneratorForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('resumen de meta concretada usa el historial del canal real', async () => {
  const contactId = `contact_summary_channel_${randomUUID()}`

  try {
    await db.run(
      'INSERT OR IGNORE INTO contacts (id, full_name, phone, email) VALUES (?, ?, ?, ?)',
      [contactId, 'Resumen Canal', '+526560000001', 'resumen-canal@test.local']
    )
    await db.run(`
      INSERT OR REPLACE INTO conversational_agent_state (contact_id, status, channel, updated_at)
      VALUES (?, 'active', 'instagram', CURRENT_TIMESTAMP)
    `, [contactId])
    await db.run(`
      INSERT INTO whatsapp_api_messages (id, contact_id, direction, message_type, message_text, message_timestamp, created_at)
      VALUES (?, ?, 'inbound', 'text', ?, '2026-06-21T15:00:00.000Z', '2026-06-21T15:00:00.000Z')
    `, [`${contactId}_wa`, contactId, 'Este texto de WhatsApp no debe entrar al resumen de Instagram.'])
    await db.run(`
      INSERT INTO meta_social_messages (id, platform, contact_id, direction, message_type, message_text, message_timestamp, created_at)
      VALUES
        (?, 'instagram', ?, 'inbound', 'text', ?, '2026-06-21T16:00:00.000Z', '2026-06-21T16:00:00.000Z'),
        (?, 'instagram', ?, 'outbound', 'text', ?, '2026-06-21T16:01:00.000Z', '2026-06-21T16:01:00.000Z')
    `, [
      `${contactId}_ig_1`, contactId, 'Vengo de Instagram, me urge revisar la rodilla porque ya me limita al caminar.',
      `${contactId}_ig_2`, contactId, 'Va, puedo ayudarte a encontrar horario para valoración.'
    ])

    setConversationalCompletionSummaryGeneratorForTest(async ({ messages, channel }) => {
      assert.equal(channel, 'instagram')
      assert.ok(messages.some((message) => message.text.includes('Vengo de Instagram')))
      assert.ok(!messages.some((message) => message.text.includes('WhatsApp no debe entrar')))
      return 'Llegó por Instagram con dolor de rodilla que ya le limita caminar; pidió valoración.'
    })

    await setConversationSignal(contactId, 'appointment_booked', {
      reason: 'Cita agendada por Instagram',
      actionSummarySource: 'Cita - Instagram Canal · 2026-06-25T17:00:00.000Z',
      status: 'completed',
      agentId: 'agent_summary_instagram_test'
    })

    const state = await getConversationState(contactId)
    assert.match(state.signalSummary, /Resumen: Llegó por Instagram/)
    assert.doesNotMatch(state.signalSummary, /WhatsApp no debe entrar/)
  } finally {
    setConversationalCompletionSummaryGeneratorForTest(null)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('click del enlace de disparo cumple objetivo personalizado y detiene la IA', async () => {
  const contactId = 'test_trigger_link_goal_contact'
  let triggerLink = null
  let agent = null

  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215550000002', 'trigger-link@test.local', 'Trigger Link Test', 'test']
    )

    triggerLink = await createTriggerLink({
      name: 'Diagnóstico express',
      destinationUrl: 'https://example.test/diagnostico'
    })

    agent = await createConversationalAgent({
      name: 'Agente trigger link',
      objective: 'custom',
      customObjective: 'Que toque el enlace de diagnóstico',
      successAction: 'send_trigger_link',
      goalWorkflow: {
        triggerLink: {
          triggerLinkId: triggerLink.id,
          triggerLinkPublicId: triggerLink.publicId,
          triggerLinkName: triggerLink.name,
          triggerLinkUrl: triggerLink.publicUrl
        }
      }
    })

    await db.run(
      'INSERT OR REPLACE INTO conversational_agent_state (contact_id, status, agent_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [contactId, 'active', agent.id]
    )

    const ignored = await handleConversationalAgentTriggerLinkClick({
      contactId,
      triggerLinkId: 'trigger_link_equivocado',
      triggerLinkPublicId: 'otro',
      triggerLinkName: 'Otro enlace'
    })
    assert.equal(ignored.matched, false)

    let state = await getConversationState(contactId)
    assert.equal(state.status, 'active')
    assert.equal(state.signal, null)

    await recordConversationalAgentEvent({
      contactId,
      eventType: 'trigger_link_sent',
      detail: {
        triggerLinkId: triggerLink.id,
        triggerLinkPublicId: triggerLink.publicId,
        resumen: 'Quiere diagnóstico express para saber si su dolor requiere atención inmediata.'
      }
    })

    const completed = await handleConversationalAgentTriggerLinkClick({
      contactId,
      triggerLinkId: triggerLink.id,
      triggerLinkPublicId: triggerLink.publicId,
      triggerLinkName: triggerLink.name,
      eventId: 'trigger_event_test'
    })

    assert.equal(completed.matched, true)
    state = await getConversationState(contactId)
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'ready_for_human')
    assert.match(state.signalReason, /Diagnóstico express/)
    assert.match(state.signalSummary, /Resumen: Quiere diagnóstico express/)

    const event = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'trigger_link_goal_completed' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    assert.ok(event?.detail_json)
    assert.match(event.detail_json, /trigger_event_test/)
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('confirmacion automatica de enlace de calendario confirma cita con ID real', async () => {
  const contactId = 'test_goal_url_contact'
  await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
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

    const completed = await completeConversationGoalLinkFromWebhook({
      booking_ref: link.id,
      calendar_id: 'cal_demo',
      appointment_id: 'appt_123',
      status: 'scheduled'
    })

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
    await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('confirmacion automatica de pedido valida producto antes de cerrar venta', async () => {
  const contactId = 'test_goal_order_contact'
  await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
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

    await assert.rejects(
      () => completeConversationGoalLinkFromWebhook({
        pedido_ref: link.id,
        product_id: 'prod_y',
        price_id: 'price_mensual',
        purchase_id: 'purchase_wrong',
        status: 'paid'
      }),
      /producto esperado/
    )

    const pending = await getConversationGoalLink(link.id)
    assert.equal(pending.status, 'pending')

    const completed = await completeConversationGoalLinkFromWebhook({
      pedido_ref: link.id,
      product_id: 'prod_x',
      price_id: 'price_mensual',
      purchase_id: 'purchase_123',
      status: 'paid'
    })

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
    await db.run('DELETE FROM conversational_agent_goal_links WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('pago exitoso de link creado por agente completa la venta conversacional', async () => {
  const contactId = 'test_agent_payment_invoice_contact'
  let agent = null

  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)

  try {
    await db.run(
      'INSERT INTO contacts (id, phone, email, full_name, custom_fields, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, '+5215550000044', 'agent-payment@test.local', 'Agent Payment Test', JSON.stringify({}), 'test']
    )

    agent = await createConversationalAgent({
      name: 'Agente venta completa',
      objective: 'ventas',
      successAction: 'ready_to_buy',
      goalWorkflow: {
        sales: {
          owner: 'ai',
          paymentMode: 'full_payment'
        },
        completion: {
          mode: 'assign_user',
          userId: 'user_completion_1',
          userName: 'Ana Ventas'
        }
      }
    })

    await db.run(
      'INSERT OR REPLACE INTO conversational_agent_state (contact_id, status, agent_id, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
      [contactId, 'active', agent.id]
    )

    await recordConversationalAgentEvent({
      contactId,
      eventType: 'payment_link_created',
      detail: {
        agentId: agent.id,
        invoiceId: 'invoice_agent_123',
        amount: 1200,
        currency: 'USD',
        paymentMode: 'full_payment'
      }
    })

    const result = await completeConversationalAgentSalePaymentFromInvoice({
      contactId,
      invoiceId: 'invoice_agent_123',
      amount: 1200,
      currency: 'USD',
      status: 'paid',
      reference: 'Invoice #123'
    })

    assert.equal(result.matched, true)
    assert.equal(result.signal, 'purchase_completed')
    assert.equal(result.agentId, agent.id)

    const state = await getConversationState(contactId)
    assert.equal(state.status, 'completed')
    assert.equal(state.signal, 'purchase_completed')
    assert.match(state.signalSummary, /Pagó \$1,200 USD/)
    assert.doesNotMatch(state.signalSummary, /invoice_agent_123/)

    const completionEvent = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'signal_set' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    const completionDetail = JSON.parse(completionEvent.detail_json)
    assert.equal(completionDetail.actionSummary, 'Pagó $1,200 USD')
    assert.equal(completionDetail.originalSummary, 'Invoice invoice_agent_123 · 1200 USD')

    const event = await db.get(
      "SELECT detail_json FROM conversational_agent_events WHERE contact_id = ? AND event_type = 'payment_link_goal_completed' ORDER BY created_at DESC LIMIT 1",
      [contactId]
    )
    assert.ok(event?.detail_json)
    assert.match(event.detail_json, /invoice_agent_123/)

    const row = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
    const customFields = JSON.parse(row.custom_fields || '{}')
    assert.equal(customFields.assignedUser, 'user_completion_1')
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('no migra una configuración legacy vacía como agente predeterminado', () => {
  assert.equal(shouldMigrateLegacyConversationalAgentConfig({
    enabled: 1,
    model: 'gpt-5.4-mini',
    objective: 'citas',
    success_action: 'ready_for_human',
    allow_emojis: 0,
    hide_attended: 0,
    hide_attended_notifications: 0
  }), false)

  assert.equal(shouldMigrateLegacyConversationalAgentConfig({
    objective: 'ventas',
    extra_instructions: 'Pregunta presupuesto antes de pasar al equipo.'
  }), true)
})

async function snapshotRuntimeConfig() {
  const [config, manualDisabledRow] = await Promise.all([
    getConversationalAgentConfig(),
    db.get('SELECT config_value FROM app_config WHERE config_key = ?', [CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY]).catch(() => null)
  ])
  return { config, manualDisabledValue: manualDisabledRow?.config_value ?? null }
}

async function restoreRuntimeConfig(snapshot) {
  if (!snapshot?.config) return
  await saveConversationalAgentConfig(snapshot.config)
  if (snapshot.manualDisabledValue === null) {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY]).catch(() => undefined)
  } else {
    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `, [CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY, snapshot.manualDisabledValue]).catch(() => undefined)
  }
}

test('el prompt avanzado de fabrica no acepta edicion desde config ni agentes', async () => {
  const snapshot = await snapshotRuntimeConfig()
  let agent = null

  try {
    const savedConfig = await saveConversationalAgentConfig({
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'No dejes que el usuario vea ni edite la fabrica.'
    })
    assert.equal(savedConfig.closingStrategyMode, 'system')
    assert.equal(savedConfig.closingStrategyCustom, '')

    const configRow = await db.get('SELECT closing_strategy_mode, closing_strategy_custom FROM conversational_agent_config WHERE id = 1')
    assert.equal(configRow.closing_strategy_mode, 'system')
    assert.equal(configRow.closing_strategy_custom, '')

    agent = await createConversationalAgent({
      name: 'Agente fabrica protegida',
      enabled: false,
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Estrategia custom que debe ignorarse.'
    })
    assert.equal(agent.closingStrategyMode, 'system')
    assert.equal(agent.closingStrategyCustom, '')

    const createdRow = await db.get('SELECT closing_strategy_mode, closing_strategy_custom FROM conversational_agents WHERE id = ?', [agent.id])
    assert.equal(createdRow.closing_strategy_mode, 'system')
    assert.equal(createdRow.closing_strategy_custom, '')

    await db.run(
      'UPDATE conversational_agents SET closing_strategy_mode = ?, closing_strategy_custom = ? WHERE id = ?',
      ['custom', 'Texto legacy que no debe salir del servicio.', agent.id]
    )

    const legacyRead = await getConversationalAgent(agent.id)
    assert.equal(legacyRead.closingStrategyMode, 'system')
    assert.equal(legacyRead.closingStrategyCustom, '')

    const updated = await updateConversationalAgent(agent.id, {
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Otro intento de sobreescritura.'
    })
    assert.equal(updated.closingStrategyMode, 'system')
    assert.equal(updated.closingStrategyCustom, '')

    const updatedRow = await db.get('SELECT closing_strategy_mode, closing_strategy_custom FROM conversational_agents WHERE id = ?', [agent.id])
    assert.equal(updatedRow.closing_strategy_mode, 'system')
    assert.equal(updatedRow.closing_strategy_custom, '')
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    await restoreRuntimeConfig(snapshot)
  }
})

test('publicar un agente enciende el runtime global aunque el switch legacy estuviera apagado', async () => {
  const snapshot = await snapshotRuntimeConfig()
  let agent = null

  try {
    await saveConversationalAgentConfig({ enabled: false })
    agent = await createConversationalAgent({
      name: 'Agente runtime apagado',
      enabled: false
    })

    const published = await updateConversationalAgent(agent.id, { enabled: true })
    const config = await getConversationalAgentConfig()
    const marker = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY])

    assert.equal(published.enabled, true)
    assert.equal(config.enabled, true)
    assert.equal(marker?.config_value ?? null, null)
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    await restoreRuntimeConfig(snapshot)
  }
})

test('repara runtime viejo apagado si ya existe un agente publicado sin apagado manual', async () => {
  const snapshot = await snapshotRuntimeConfig()
  let agent = null

  try {
    await saveConversationalAgentConfig({ enabled: false })
    await db.run('DELETE FROM app_config WHERE config_key = ?', [CONVERSATIONAL_AGENT_MANUAL_DISABLED_CONFIG_KEY])
    agent = await createConversationalAgent({
      name: 'Agente publicado heredado',
      enabled: false
    })
    await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agent.id])

    const config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({ reason: 'test_legacy_published_agent' })

    assert.equal(config.enabled, true)
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    await restoreRuntimeConfig(snapshot)
  }
})

test('respeta el apagado manual aunque exista un agente publicado', async () => {
  const snapshot = await snapshotRuntimeConfig()
  let agent = null

  try {
    await saveConversationalAgentConfig({ enabled: false })
    agent = await createConversationalAgent({
      name: 'Agente apagado manual',
      enabled: false
    })
    await db.run('UPDATE conversational_agents SET enabled = 1 WHERE id = ?', [agent.id])

    const config = await ensureConversationalAgentRuntimeEnabledForPublishedAgents({ reason: 'test_manual_disabled' })

    assert.equal(config.enabled, false)
  } finally {
    if (agent?.id) await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    await restoreRuntimeConfig(snapshot)
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
  const snapshot = await snapshotRuntimeConfig()
  const contactId = `contact_agent_mode_${randomUUID()}`
  let agent = null

  try {
    await saveConversationalAgentConfig({ enabled: true })
    agent = await createConversationalAgent({
      name: 'Agente modo editable',
      enabled: true,
      hideAttended: false,
      hideAttendedNotifications: false
    })

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
    if (agent?.id) {
      await db.run('DELETE FROM conversational_agent_events WHERE detail_json LIKE ?', [`%${agent.id}%`]).catch(() => undefined)
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agent.id]).catch(() => undefined)
    }
    await restoreRuntimeConfig(snapshot)
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
      { agent_id: 'agent_2', status: 'human', signal: null, updated_at: '2026-06-13T10:15:00Z' }
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

test('sanitiza razonamiento interno antes de enviar al contacto', () => {
  const raw = [
    'Vale. Tengo el contexto del negocio. El contacto es nuevo. Ahora voy a responder.',
    '',
    '**Lectura:** llega corto, directo, con una necesidad puntual (costos). **Movimiento:** no voy a soltar los valores de golpe.',
    '',
    'Voy a regresar la pregunta para que se especifique qué es lo que le interesa exactamente, transmitiendo que tengo varias cosas. Desarmado, sin ser mamón.',
    '',
    'Corto. Uno o dos valores concretos nada más si pregunta específico después. Espejeo su sequedad pero desde arriba.',
    '',
    'qué cosa.. digo, tengo varias cosas por acá, cuál fue lo que te llamó?'
  ].join('\n')

  assert.equal(
    sanitizeAgentReply(raw),
    'qué cosa.. digo, tengo varias cosas por acá, cuál fue lo que te llamó?'
  )
})

test('bloquea una respuesta que solo contiene razonamiento interno', () => {
  const raw = [
    '**Lectura:** pregunta precio, energía seca.',
    'Voy a regresar la pregunta y no voy a soltar valores de golpe.',
    'Primer mensaje desarmado, registro profesional.'
  ].join('\n')

  assert.equal(sanitizeAgentReply(raw), '')
})

test('conserva una respuesta visible etiquetada tras razonamiento interno', () => {
  const raw = [
    '**Lectura:** trae una duda puntual.',
    '**Respuesta visible:** claro, depende de qué necesitas revisar primero'
  ].join('\n')

  assert.equal(sanitizeAgentReply(raw), 'claro, depende de qué necesitas revisar primero')
})

test('candado runtime detecta promesas de pase a humano sin herramienta', () => {
  const reply = 'perfecto, gracias entonces ya con eso te ayudan a seguir el agendado'
  assert.equal(replySuggestsHumanHandoff(reply), true)

  const result = applyConversationalRuntimeReplyGuard({
    reply,
    latestText: 'Ok',
    actions: [],
    config: { persuasionLevel: 'high' }
  })

  assert.equal(result.forceHumanHandoff?.source, 'human_handoff_promise_without_action')
  assert.deepEqual(result.events.map((event) => event.type), ['runtime_handoff_promise_forced'])
})

test('candado runtime no duplica pase si la herramienta real ya se ejecuto', () => {
  const result = applyConversationalRuntimeReplyGuard({
    reply: 'va, te paso con el equipo para que te confirmen',
    latestText: 'Ok',
    actions: [{ type: 'mark_ready_to_advance' }],
    config: { persuasionLevel: 'high' }
  })

  assert.equal(result.forceHumanHandoff, null)
  assert.deepEqual(result.events, [])
})

test('candado runtime convierte silencio ante confirmacion de agenda en pase humano real', () => {
  const latestText = 'Entonces si queda agendada para mañana viernes a la 1 pm???'
  assert.equal(shouldEscalateSilentSchedulingQuestion(latestText, [{ type: 'stay_silent' }]), true)

  const result = applyConversationalRuntimeReplyGuard({
    reply: '',
    latestText,
    actions: [{ type: 'stay_silent', motivo: 'se requiere consultar agenda antes de responder' }],
    config: { persuasionLevel: 'high' },
    suppressReply: true
  })

  assert.equal(result.suppressReply, false)
  assert.equal(result.reply, 'Te paso con el equipo para que te confirmen eso.')
  assert.equal(result.forceHumanHandoff?.source, 'silent_scheduling_question')
  assert.deepEqual(result.events.map((event) => event.type), [
    'runtime_silence_escalated_to_human',
    'runtime_handoff_promise_forced'
  ])
})

test('candado runtime quita precio prematuro si el mismo mensaje aun pide calificar', () => {
  const reply = 'Claro, la valoración tiene un valor de $800. Para darte bien el dato, cuéntame qué buscas resolver?'
  const rewritten = rewritePrematurePriceDisclosure(reply, { persuasionLevel: 'high' })

  assert.equal(rewritten.includes('$800'), false)
  assert.equal(rewritten, 'Claro, para darte un valor que sí aplique, cuéntame tantito qué estás buscando resolver?')
})

test('candado runtime respeta anfitrion y precio ya contextualizado', () => {
  const reply = 'La consulta vale $800. Te gustaría agendar?'

  assert.equal(rewritePrematurePriceDisclosure(reply, { persuasionLevel: 'low' }), reply)
  assert.equal(rewritePrematurePriceDisclosure(reply, { persuasionLevel: 'high' }), reply)
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

test('si el contacto interrumpe entre globos se detienen los restantes y se devuelve el inbound', async () => {
  const sequence = []
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
      loadNewerInbound: async () => newerInbound,
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

test('parte respuestas largas respetando el máximo de segmentos', () => {
  const longReply = [
    'va, ya te entendí. Lo primero es ubicar qué necesitas resolver ahorita y qué tan urgente se volvió para ti.',
    'También necesito saber si ya intentaste algo antes, porque eso cambia bastante la recomendación.',
    'Con esa información puedo decirte cuál sería el siguiente paso sin inventarte cosas ni darte vueltas.'
  ].join(' ')

  const parts = splitReplyIntoParts(longReply, {
    mode: 'split',
    minMessageLengthToSplit: 1,
    maxBubbleLength: 120,
    maxBubbles: 6,
    minDelaySeconds: 1,
    maxDelaySeconds: 3
  })

  assert.ok(parts.length > 1)
  assert.ok(parts.length <= 6)
  assert.ok(parts.every((part) => part.trim().length > 0))
  assert.equal(parts.join(' ').toLocaleLowerCase('es-MX'), longReply.toLocaleLowerCase('es-MX'))
  assert.match(parts[0], /^Va/)
})

test('switch apagado envia una sola respuesta aunque el texto sea largo', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'Este mensaje es suficientemente largo para partirse, pero el modo esta apagado y debe salir completo.',
    settings: { mode: 'single', splitMessagesEnabled: false, maxBubbleLength: 80 },
    aiSplitter: async () => ({ messages: ['no deberia usarse'] })
  })

  assert.equal(result.source, 'disabled')
  assert.deepEqual(result.messages, ['Este mensaje es suficientemente largo para partirse, pero el modo esta apagado y debe salir completo.'])
})

test('mensaje corto se queda en un solo globo', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'Ok, listo.',
    settings: { mode: 'split', minMessageLengthToSplit: 120, minBubbleLength: 20 },
    aiSplitter: async () => ({ messages: ['Ok', 'listo.'] }),
    random: () => 0.99
  })

  assert.equal(result.source, 'threshold')
  assert.deepEqual(result.messages, ['Ok, listo.'])
})

test('modo humano no fuerza globos cuando la respuesta corta es una sola idea', () => {
  const result = splitMessageIntoBubblesFallback({
    text: 'sí, mañana a las 5 está perfecto',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 20, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0
  })

  assert.deepEqual(result.messages, ['Sí, mañana a las 5 está perfecto'])
})

test('modo humano usa fallback natural cuando no hay splitter IA disponible', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ah ya te entendí… ¿pero cómo está eso exactamente?',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0.8
  })

  assert.equal(result.source, 'fallback')
  assert.deepEqual(result.messages, ['Ah ya te entendí…', '¿pero cómo está eso exactamente?'])
})

test('modo humano acepta BREAK como separador pero no lo expone al contacto', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora dime qué fecha te queda mejor',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120 },
    aiSplitter: async () => 'ok perfecto [BREAK] ahora dime qué fecha te queda mejor'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['Ok perfecto', 'ahora dime qué fecha te queda mejor'])
  assert.ok(result.messages.every((message) => !message.includes('[BREAK]')))
})

test('modo humano separa BREAK aunque venga dentro de JSON válido', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora dime qué fecha te queda mejor',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120 },
    aiSplitter: async () => '{"messages":["ok perfecto [BREAK] ahora dime qué fecha te queda mejor"]}'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['Ok perfecto', 'ahora dime qué fecha te queda mejor'])
  assert.ok(result.messages.every((message) => !message.includes('[BREAK]')))
})

test('modo humano alterna mayuscula inicial entre globos', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora te explico rápido luego vemos horarios para cerrar te pido el dato',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 1, maxBubbleLength: 120 },
    aiSplitter: async () => 'ok perfecto [BREAK] Ahora te explico rápido [BREAK] luego vemos horarios [BREAK] Para cerrar te pido el dato'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [
    'Ok perfecto',
    'ahora te explico rápido',
    'Luego vemos horarios',
    'para cerrar te pido el dato'
  ])
})

test('modo humano conserva mayusculas obligatorias al alternar globos', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto Ana Gómez queda registrada luego confirmamos fecha 24 de junio queda apartado después usamos WhatsApp como canal',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 1, maxBubbleLength: 120 },
    aiSplitter: async () => ({
      messages: [
        'ok perfecto',
        'Ana Gómez queda registrada',
        'luego confirmamos fecha',
        '24 de junio queda apartado',
        'después usamos WhatsApp como canal',
        'WhatsApp queda como canal final'
      ]
    })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [
    'Ok perfecto',
    'Ana Gómez queda registrada',
    'Luego confirmamos fecha',
    '24 de junio queda apartado',
    'Después usamos WhatsApp como canal',
    'WhatsApp queda como canal final'
  ])
})

test('modo humano repara globos con reacción, salto y pregunta en el mismo mensaje', async () => {
  const original = 'ya.. entonces sí traes ese tema encima\n\npa entenderte bien y no decirte algo al aire, hoy cómo te llegan los pacientes?'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 240, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: [original] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [
    'Ya..',
    'entonces sí traes ese tema encima',
    'Pa entenderte bien y no decirte algo al aire',
    'hoy cómo te llegan los pacientes?'
  ])
})

test('modo humano fallback separa reaccion lectura puente y pregunta final', () => {
  const original = 'ya.. entonces sí traes ese tema encima\npa entenderte bien y no decirte algo al aire, hoy cómo te llegan los pacientes?'
  const result = splitMessageIntoBubblesFallback({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 240, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.deepEqual(result.messages, [
    'Ya..',
    'entonces sí traes ese tema encima',
    'Pa entenderte bien y no decirte algo al aire',
    'hoy cómo te llegan los pacientes?'
  ])
})

test('modo humano deja una reaccion con coma como globo propio', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'claro, de qué te gustaría saber?',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: ['claro, de qué te gustaría saber?'] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['Claro,', 'de qué te gustaría saber?'])
})

test('modo humano no deja una frase dependiente sola antes de una pregunta', async () => {
  const original = 'depende de lo que necesites. tú eres médico o lo ves para alguien más?'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 160, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: ['depende de lo que necesites.', 'tú eres médico o lo ves para alguien más?'] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['Depende de lo que necesites. tú eres médico o lo ves para alguien más?'])
})

test('modo humano fallback no corta depende de lo que necesitas antes del contexto', () => {
  const original = 'depende de lo que necesites. tú eres médico o lo ves para alguien más?'
  const result = splitMessageIntoBubblesFallback({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 160, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.deepEqual(result.messages, ['Depende de lo que necesites. tú eres médico o lo ves para alguien más?'])
})

test('modo humano puede llegar hasta seis globos sólo cuando el texto largo lo amerita', () => {
  const longReply = [
    'va, ya te entendí.',
    'Primero revisamos qué estás intentando resolver ahorita.',
    'Luego vemos qué ya probaste antes para no repetir lo mismo.',
    'Después ubicamos qué dato real falta para darte una respuesta clara.',
    'Con eso te digo cuál sería el siguiente paso sin inventarte nada.',
    'Y si sí hace sentido, lo pasamos a revisión con alguien del equipo.'
  ].join(' ')

  const result = splitMessageIntoBubblesFallback({
    text: longReply,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.ok(result.messages.length > 4)
  assert.ok(result.messages.length <= 6)
  assert.equal(result.messages.join(' ').toLocaleLowerCase('es-MX'), longReply.toLocaleLowerCase('es-MX'))
  assert.match(result.messages[0], /^Va/)
})

test('mensaje casual se divide en globos humanos con IA', async () => {
  const original = 'Sí bro, ya puedes poner esa publicidad. Lo ideal sería que primero subas unos videos mostrando el servicio. Después activamos la campaña y vamos midiendo qué personas escriben para ajustar el anuncio. No te preocupes, yo te voy diciendo paso a paso qué hacer.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 5, minBubbleLength: 20, maxBubbleLength: 140 },
    aiSplitter: async () => ({
      messages: [
        'Sí bro, ya puedes poner esa publicidad.',
        'Lo ideal sería que primero subas unos videos mostrando el servicio.',
        'Después activamos la campaña y vamos midiendo qué personas escriben para ajustar el anuncio.',
        'No te preocupes, yo te voy diciendo paso a paso qué hacer.'
      ]
    })
  })

  assert.equal(result.source, 'ai')
  assert.equal(result.messages.length, 4)
  assert.equal(result.messages[0], 'Sí bro, ya puedes poner esa publicidad.')
})

test('mensaje largo respeta el máximo de globos', async () => {
  const original = [
    'Primero revisamos el objetivo de la campaña para que no se gaste presupuesto en mensajes que no sirven.',
    'Luego validamos que el anuncio tenga una oferta clara y que el primer mensaje de WhatsApp conteste rápido.',
    'Después medimos qué contactos avanzan, cuáles preguntan precio y cuáles necesitan seguimiento manual.',
    'Con esa información ajustamos el texto, el público y el presupuesto sin cambiar todo a ciegas.',
    'Al final te digo qué decisión tomar y qué parte conviene escalar.'
  ].join(' ')

  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 3, minBubbleLength: 20, maxBubbleLength: 140 },
    aiSplitter: async () => ({
      messages: original.split('. ').map((part) => (part.endsWith('.') ? part : `${part}.`))
    })
  })

  assert.equal(result.messages.length, 3)
  assert.ok(result.messages.every((message) => message.trim()))
})

test('no rompe URLs al dividir', async () => {
  const original = 'Claro, entra a https://ristak.com/demo?source=whatsapp para revisar la demo. Después dime si quieres que la conectemos con tu campaña actual.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 4, minBubbleLength: 20, maxBubbleLength: 90 },
    aiSplitter: async () => ({
      messages: [
        'Claro, entra a https://ristak.com/demo?source=whatsapp para revisar la demo.',
        'Después dime si quieres que la conectemos con tu campaña actual.'
      ]
    })
  })

  assert.ok(result.messages.some((message) => message.includes('https://ristak.com/demo?source=whatsapp')))
})

test('no rompe teléfono ni precio al dividir', async () => {
  const original = 'Perfecto, el anticipo sería de $1,500 MXN y el teléfono para confirmar es +52 656 123 4567. Ya con eso apartamos tu lugar.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 4, minBubbleLength: 20, maxBubbleLength: 90 },
    aiSplitter: async () => ({
      messages: [
        'Perfecto, el anticipo sería de $1,500 MXN y el teléfono para confirmar es +52 656 123 4567.',
        'Ya con eso apartamos tu lugar.'
      ]
    })
  })

  assert.ok(result.messages.some((message) => message.includes('$1,500 MXN')))
  assert.ok(result.messages.some((message) => message.includes('+52 656 123 4567')))
})

test('conserva pasos enumerados en orden', async () => {
  const original = '1. Manda el video. 2. Confirmamos el presupuesto. 3. Activamos la campaña. 4. Revisamos resultados mañana.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 4, minBubbleLength: 10, maxBubbleLength: 80 },
    aiSplitter: async () => ({
      messages: [
        '1. Manda el video.',
        '2. Confirmamos el presupuesto.',
        '3. Activamos la campaña.',
        '4. Revisamos resultados mañana.'
      ]
    })
  })

  assert.deepEqual(result.messages.map((message) => message.match(/^\d/)?.[0]), ['1', '2', '3', '4'])
})

test('falla de JSON de la IA usa fallback con el texto original', async () => {
  const original = 'Esta respuesta debe quedarse completa si el divisor devuelve basura.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 5 },
    aiSplitter: async () => 'no soy json'
  })

  assert.equal(result.source, 'fallback')
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

test('mensaje formal conserva tono formal', async () => {
  const original = 'Con gusto. Para poder avanzar, necesitamos confirmar la fecha de la cita y el servicio requerido. En cuanto me comparta esos datos, le indico la disponibilidad.'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', minMessageLengthToSplit: 1, maxBubbles: 3, minBubbleLength: 20, maxBubbleLength: 120 },
    aiSplitter: async () => ({
      messages: [
        'Con gusto. Para poder avanzar, necesitamos confirmar la fecha de la cita y el servicio requerido.',
        'En cuanto me comparta esos datos, le indico la disponibilidad.'
      ]
    })
  })

  assert.equal(result.messages.length, 2)
  assert.match(result.messages.join(' '), /Con gusto/)
  assert.match(result.messages.join(' '), /le indico/)
})

test('construye contexto interno con mensajes pendientes sin exponerlo al cliente', () => {
  const context = buildPendingReplyContextMessage([
    { id: 'm1', message_text: 'hola, quiero info', message_type: 'text' },
    { id: 'm2', message_text: 'también cuánto cuesta?', message_type: 'text' }
  ])

  assert.equal(context.role, 'user')
  assert.match(context.content, /\[Contexto interno de Ristak:/)
  assert.match(context.content, /Responde considerando TODOS/)
  assert.match(context.content, /1\. hola, quiero info/)
  assert.match(context.content, /2\. también cuánto cuesta\?/)
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

test('rellena parametros de la estrategia de cierre de fabrica', () => {
  const rendered = renderClosingStrategyTemplate(
    'Agente de [NOMBRE_DEL_NEGOCIO] por [CANAL_DE_CONVERSACION]; problema: [PROBLEMA_REAL]; conciencia: [CONCIENCIA_DEL_PROBLEMA]; avance: [HERRAMIENTA_INTERNA_DE_AVANCE]',
    buildClosingStrategyTemplateParameters({
      learned: {
        realProblem: 'dolor que ya afecta su rutina',
        problemMagnitudeAwareness: 'ya entiende que postergarlo puede limitarle más la movilidad'
      },
      profileParameters: {
        NOMBRE_DEL_NEGOCIO: 'Clínica Norte'
      },
      channelLabel: 'WhatsApp',
      advanceToolName: 'mark_ready_to_advance'
    })
  )

  assert.equal(rendered, 'Agente de Clínica Norte por WhatsApp; problema: dolor que ya afecta su rutina; conciencia: ya entiende que postergarlo puede limitarle más la movilidad; avance: mark_ready_to_advance')

  const renderedFallback = renderClosingStrategyTemplate(
    'Agente de [NOMBRE_DEL_NEGOCIO] por [CANAL_DE_CONVERSACION]; problema: [PROBLEMA_REAL]; avance: [HERRAMIENTA_INTERNA_DE_AVANCE]',
    buildClosingStrategyTemplateParameters({
      profileParameters: {
        NOMBRE_DEL_NEGOCIO: 'Clínica Norte'
      },
      channelLabel: 'WhatsApp',
      learned: {
        realProblem: 'dolor que ya afecta su rutina'
      },
      advanceToolName: 'mark_ready_to_advance'
    })
  )

  assert.equal(renderedFallback, 'Agente de Clínica Norte por WhatsApp; problema: dolor que ya afecta su rutina; avance: mark_ready_to_advance')
})

test('convierte el perfil estructurado del negocio en parametros del prompt', () => {
  const extraction = normalizeBusinessProfileExtraction({
    sameBusinessWithPrevious: true,
    profile: {
      businessName: 'Clínica Norte',
      industry: 'clínica dental',
      businessType: 'service',
      description: 'Atiende limpiezas, ortodoncia e implantes en Ciudad Juárez.',
      offerings: [
        { name: 'Limpieza dental', cadence: 'cada 6 meses', price: '$700 MXN' },
        { name: 'Ortodoncia', description: 'tratamiento mensual', price: 'desde $1,200 MXN al mes' }
      ],
      locations: [
        { address: 'Av. Tecnológico 123', city: 'Ciudad Juárez', postalCode: '32500' }
      ],
      hours: { summary: 'Lunes a viernes de 9 a 6' },
      payments: { transfer: 'sí', invoice: 'sí da factura' },
      contacts: { mainPhone: '656 111 2222', extension: '103' }
    }
  }, {
    businessContext: 'Clínica dental en Ciudad Juárez.'
  })

  assert.equal(extraction.profile.businessName, 'Clínica Norte')
  assert.equal(extraction.promptParameters.NOMBRE_DEL_NEGOCIO, 'Clínica Norte')
  assert.equal(extraction.promptParameters.INDUSTRIA, 'clínica dental')
  assert.match(extraction.promptParameters.PRODUCTO_O_SERVICIO, /Limpieza dental/)
  assert.match(extraction.promptParameters.VALOR, /\$700 MXN/)
  assert.match(extraction.promptParameters.UBICACION_O_MODALIDAD, /Ciudad Juárez/)
  assert.match(extraction.promptParameters.DISPONIBILIDAD, /Lunes a viernes/)
  assert.match(extraction.promptParameters.CONDICIONES_IMPORTANTES, /factura/)
  assert.match(extraction.promptParameters.ADAPTACION_CONVERSACIONAL_DEL_NEGOCIO, /clínica dental/)
  assert.match(extraction.promptParameters.RIESGO_VERBAL_A_EVITAR, /compra ya/)

  const rendered = renderClosingStrategyTemplate(
    '[NOMBRE_DEL_NEGOCIO] · [INDUSTRIA] · [PRODUCTO_O_SERVICIO] · [UBICACION_O_MODALIDAD]',
    extraction.promptParameters
  )
  assert.match(rendered, /Clínica Norte · clínica dental/)
  assert.doesNotMatch(rendered, /\[INDUSTRIA\]/)
})

test('parametriza el cierre de fabrica sin transformar el guion general', () => {
  const parameters = buildBusinessProfilePromptParameters({
    businessName: 'Growth Médico',
    industry: 'marketing para médicos especialistas',
    businessType: 'service',
    description: 'Ayuda a médicos a convertir conversaciones de redes en pacientes agendados sin sonar invasivos.',
    offerings: [
      { name: 'sistema de captación de pacientes', description: 'anuncios, WhatsApp y seguimiento para clínicas', price: 'desde $12,000 MXN mensuales' }
    ],
    targetCustomers: 'médicos con agenda irregular que reciben mensajes pero no suficientes citas reales',
    differentiators: 'acompaña al médico con estrategia, anuncios y seguimiento conversacional',
    conversationAdaptation: {
      narrativeFrame: 'No vendas marketing; guía al médico a revisar si depender de recomendaciones y mensajes sueltos está frenando su agenda.',
      customerPerception: 'Debe sentirse como una revisión profesional de su captación de pacientes, no como una compra impulsiva.',
      languageGuidance: 'Habla de pacientes, agenda, consultas, seguimiento y claridad del sistema.',
      contrastFrame: 'Contrasta seguir con conversaciones que no llegan a cita contra ordenar el sistema para que los interesados correctos avancen.',
      discoveryAngles: ['qué pasa con los mensajes que llegan', 'cuántas consultas reales se pierden', 'qué cambió para revisar esto ahora'],
      safeValueLanguage: 'Habla de revisar si tiene sentido y de ver una ruta clara.',
      forbiddenSalesLanguage: 'Evita compra, oferta, invierte hoy y pago hasta que el médico pida avanzar.'
    }
  })

  const section = buildBusinessAdaptiveClosingSection({
    enabled: true,
    parameters
  })

  assert.match(section, /Parámetros del negocio para el guión de fábrica/)
  assert.match(section, /Growth Médico/)
  assert.match(section, /marketing para médicos especialistas/)
  assert.match(section, /No vendas marketing/)
  assert.match(section, /pacientes, agenda, consultas/)
  assert.match(section, /no reescribe, resume, reemplaza ni transforma el guión de fábrica/)
  assert.match(section, /El guión de fábrica manda completo/)
  assert.match(section, /No pongas a la persona en modo comprador/)
  assert.doesNotMatch(section, /Adaptación conversacional al negocio/)
  assert.doesNotMatch(section, /Adapta todo el diálogo/)
  assert.doesNotMatch(section, /manda sobre los ejemplos genéricos/)
})

test('los parametros del perfil no acortan ni cambian la estrategia de fabrica', () => {
  const profileParameters = buildBusinessProfilePromptParameters({
    businessName: 'Academia Sol',
    industry: 'escuela de idiomas',
    offerings: [{ name: 'clases de inglés para adultos', price: '$1,500 MXN mensuales' }],
    locations: [{ modality: 'online y presencial en Chihuahua' }]
  })
  const parameters = buildClosingStrategyTemplateParameters({
    profileParameters,
    config: { objective: 'citas', successAction: 'ready_for_human' },
    channelLabel: 'WhatsApp',
    businessName: 'Academia Sol',
    industry: 'escuela de idiomas',
    offering: 'clases de inglés para adultos',
    personType: 'prospecto',
    accountLocale: { countryCode: 'CO', currency: 'COP', dialCode: '57' }
  })
  const rendered = renderClosingStrategyTemplate(DEFAULT_CLOSING_STRATEGY, parameters, { replaceMissing: true })

  assert.match(rendered, /Academia Sol/)
  assert.match(rendered, /escuela de idiomas/)
  assert.match(rendered, /clases de inglés para adultos/)
  assert.match(rendered, /Cuenta configurada en Colombia \(CO\)/)
  assert.match(rendered, /español colombiano/)
  assert.match(rendered, /listo/)
  assert.match(rendered, /AGENTE CONVERSACIONAL DE CIERRE/)
  assert.match(rendered, /Escribes como una persona real tecleando por WhatsApp/)
  assert.match(rendered, /CÓMO PIENSAS ANTES DE CADA MENSAJE/)
  assert.match(rendered, /CONTEXTO PROFUNDO/)
  assert.match(rendered, /PROHIBICIÓN MÁXIMA/)
  assert.match(rendered, /mark_ready_to_advance/)
  assert.match(rendered, /NOMBRE_DEL_NEGOCIO: Academia Sol/)
  assert.match(rendered, /INDUSTRIA: escuela de idiomas/)
  assert.match(rendered, /PRODUCTO_O_SERVICIO: clases de inglés para adultos/)
  assert.match(rendered, /El patrón invariable: regresar la definición a la persona SIN explicar el producto/)
  assert.doesNotMatch(rendered, /dato pendiente de configurar/)
  assert.doesNotMatch(rendered, /\[(?:ESCRIBIR[^\]]*|NOMBRE_DEL_NEGOCIO|INDUSTRIA|PRODUCTO_O_SERVICIO|CANAL_DE_CONVERSACION|HERRAMIENTA_INTERNA_DE_AVANCE|HERRAMIENTA_INTERNA_DE_DESCARTE)\]/)
  assert.ok(rendered.length > 15000)
})

test('estrategia de fabrica conserva reglas anti-molde y anti-asuncion', () => {
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /me da curiosidad/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /justo ahorita/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /qué te hizo escribirnos/i)
  assert.match(DEFAULT_CLOSING_STRATEGY, /AGENTE CONVERSACIONAL DE CIERRE/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Nota de género/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /PROHIBICIÓN MÁXIMA: NO COPIES/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Todos los ejemplos de este prompt son FILOSOFÍA, no libreto/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /CÓMO PIENSAS ANTES DE CADA MENSAJE/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /CÓMO ESCRIBES \(textura humana real\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Refleja LIMPIO, en sus palabras/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /No jales hacia lo que vendes/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /PROHIBIDO diagnosticar con TUS categorías/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Reacciones y emoción \(escribe con sentimiento\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /La emoción no es decoración/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /LA BIBLIA DEL PRIMER CONTACTO Y LAS PREGUNTAS VAGAS/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Diagnosticar, jalar a tu solución y reflejar mamado/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /tu primera respuesta NO informa. DEVUELVE/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /ante un mensaje vago de apertura/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /EJEMPLOS = FILOSOFÍA \(NO LIBRETO\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NO ASUMAS el perfil de la persona/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /signos de apertura/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 6 — Asumir el perfil/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 7 — Loop de rebotes \+ signos de apertura/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NO te quedes en LOOP rebotando/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Varía el justificante/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Manejo del precio/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /El precio NUNCA es lo primero/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 14 — Dar el precio de inmediato a un pedido específico/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /nunca des el precio de inmediato sin antes sacar plática y construir valor/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NUNCA el menú completo/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /NUNCA suenes evasivo/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /JAMÁS sueltes una "biblia"/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /El "se me hace caro" \(voltea el costo\)/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Humor y buena experiencia/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Cuidado quirúrgico con el lenguaje/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Error 8 — Lenguaje tieso/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /DESCARTE Y SILENCIO/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /Cuándo NO te quedes callado/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /El PRIMER regreso es el más delicado/)
  assert.match(DEFAULT_CLOSING_STRATEGY, /dosis EXTRA de calidez/)
})

test('base ligera y directa existe y es mas ligera que la fabrica', () => {
  assert.match(LIGHT_DIRECT_CLOSING_STRATEGY, /ASISTENTE CONVERSACIONAL EN MODO LIGERO Y DIRECTO/)
  assert.match(LIGHT_DIRECT_CLOSING_STRATEGY, /CÓMO OPERAS \(ligero y directo\)/)
  // La esencia directa: dar info, no rebotar/esconder como la biblia de fabrica.
  assert.match(LIGHT_DIRECT_CLOSING_STRATEGY, /Responde lo que te preguntan, claro y al grano/)
  assert.match(LIGHT_DIRECT_CLOSING_STRATEGY, /GIROS SENSIBLES/)
  assert.doesNotMatch(LIGHT_DIRECT_CLOSING_STRATEGY, /AGENTE CONVERSACIONAL DE CIERRE/)
  // Debe ser sustancialmente mas corta que la biblia de fabrica.
  assert.ok(LIGHT_DIRECT_CLOSING_STRATEGY.length * 3 < DEFAULT_CLOSING_STRATEGY.length)
})

test('usesLightDirectClosingBase cubre la matriz persuasion x lenguaje', () => {
  const persuasions = ['low', 'medium', 'high']
  const languages = ['professional', 'intermediate', 'colloquial']
  const factoryQuadrant = new Set([
    'medium|intermediate', 'medium|colloquial',
    'high|intermediate', 'high|colloquial'
  ])
  for (const persuasionLevel of persuasions) {
    for (const languageLevel of languages) {
      const config = { persuasionLevel, languageLevel }
      const expectedLight = !factoryQuadrant.has(`${persuasionLevel}|${languageLevel}`)
      assert.equal(
        usesLightDirectClosingBase(config),
        expectedLight,
        `combinacion ${persuasionLevel} x ${languageLevel} deberia usar base ${expectedLight ? 'ligera' : 'fabrica'}`
      )
      const base = resolveDefaultClosingStrategyBase(config)
      assert.equal(base === LIGHT_DIRECT_CLOSING_STRATEGY, expectedLight)
      assert.equal(base === DEFAULT_CLOSING_STRATEGY, !expectedLight)
    }
  }
  // Anfitrion (low) SIEMPRE ligera; Ejecutivo (professional) SIEMPRE ligera.
  assert.equal(usesLightDirectClosingBase({ persuasionLevel: 'low', languageLevel: 'colloquial' }), true)
  assert.equal(usesLightDirectClosingBase({ persuasionLevel: 'high', languageLevel: 'professional' }), true)
  // Default de fabrica (Cerrador + Complice) se queda con la biblia.
  assert.equal(usesLightDirectClosingBase({ persuasionLevel: 'high', languageLevel: 'intermediate' }), false)
})

test('instrucciones montan la base correcta y sus moduladores por combinacion', () => {
  const commonContext = {
    businessContext: 'Vendemos consultas.',
    brandVoice: '',
    businessName: 'Clinica Norte',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: 'Ana',
    channel: 'whatsapp',
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  }
  const build = (persuasionLevel, languageLevel) => buildConversationalInstructions({
    config: {
      persuasionLevel,
      languageLevel,
      objective: 'ventas',
      successAction: 'ready_to_buy',
      requiredData: '',
      closingStrategyMode: 'system'
    },
    ...commonContext
  })

  // Cuadrante de fabrica: biblia pesada, sin marca ligera.
  const factory = build('high', 'intermediate')
  assert.match(factory, /AGENTE CONVERSACIONAL DE CIERRE/)
  assert.doesNotMatch(factory, /ASISTENTE CONVERSACIONAL EN MODO LIGERO Y DIRECTO/)

  // Anfitrion + Callejero: base ligera + modulador Anfitrion + modulador Callejero.
  const anfitrionCallejero = build('low', 'colloquial')
  assert.match(anfitrionCallejero, /ASISTENTE CONVERSACIONAL EN MODO LIGERO Y DIRECTO/)
  assert.doesNotMatch(anfitrionCallejero, /AGENTE CONVERSACIONAL DE CIERRE/)
  assert.match(anfitrionCallejero, /Intensidad de persuasión: ANFITRIÓN/)
  assert.match(anfitrionCallejero, /Registro de lenguaje: CALLEJERO/)

  // Cerrador + Ejecutivo: base ligera (por Ejecutivo) + modulador Ejecutivo, sin modulador de persuasion.
  const cerradorEjecutivo = build('high', 'professional')
  assert.match(cerradorEjecutivo, /ASISTENTE CONVERSACIONAL EN MODO LIGERO Y DIRECTO/)
  assert.match(cerradorEjecutivo, /Registro de lenguaje: EJECUTIVO/)
  assert.doesNotMatch(cerradorEjecutivo, /Intensidad de persuasión: (ANFITRIÓN|ESTRATEGA)/)

  // La base ligera NO monta la maquinaria de cierre avanzado; la fabrica ni el placeholder crudo se filtran.
  assert.doesNotMatch(anfitrionCallejero, /Parámetros internos de cierre avanzado/)
  assert.doesNotMatch(anfitrionCallejero, /dato pendiente de configurar/)
  assert.doesNotMatch(anfitrionCallejero, /\[(?:NOMBRE_DEL_NEGOCIO|CANAL_DE_CONVERSACION|OBJETIVO_FINAL|HERRAMIENTA_INTERNA_DE_AVANCE)\]/)

  // Los moduladores de persuasion sobre base ligera NO refieren la "estrategia de cierre"
  // de la fabrica (esa referencia solo aplica cuando corre la biblia).
  assert.doesNotMatch(anfitrionCallejero, /estrategia de cierre de arriba/)
  const estrategaEjecutivo = build('medium', 'professional') // base ligera
  assert.match(estrategaEjecutivo, /ajusta la intensidad de arriba/)
  assert.doesNotMatch(estrategaEjecutivo, /recalibra la estrategia de cierre de arriba/)
  const estrategaComplice = build('medium', 'intermediate') // base fabrica
  assert.match(estrategaComplice, /recalibra la estrategia de cierre de arriba/)
})

test('update_closing_context solo se instruye con la biblia de fabrica activa', () => {
  const commonContext = {
    businessContext: 'Vendemos consultas.',
    brandVoice: '',
    businessName: 'Clinica Norte',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: 'Ana',
    channel: 'whatsapp',
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  }
  const build = (persuasionLevel, languageLevel, closingStrategyMode = 'system', closingStrategyCustom = '') =>
    buildConversationalInstructions({
      config: { persuasionLevel, languageLevel, objective: 'ventas', successAction: 'ready_to_buy', requiredData: '', closingStrategyMode, closingStrategyCustom },
      ...commonContext
    })

  // Cuadrante de fabrica: SI se pide update_closing_context.
  assert.match(build('high', 'intermediate'), /update_closing_context/)
  assert.match(build('medium', 'colloquial'), /update_closing_context/)
  // Base ligera (Anfitrion o Ejecutivo): NO se pide, porque se omite su marco de contexto.
  assert.doesNotMatch(build('low', 'intermediate'), /update_closing_context/)
  assert.doesNotMatch(build('high', 'professional'), /update_closing_context/)
  assert.doesNotMatch(build('medium', 'professional'), /update_closing_context/)
  // Estrategia custom del negocio: tampoco.
  assert.doesNotMatch(build('high', 'intermediate', 'custom', 'Cierra breve y humano.'), /update_closing_context/)
})

test('las indicaciones del negocio se inyectan como OBLIGATORIAS y con prioridad', () => {
  const commonContext = {
    businessContext: 'Vendemos consultas.',
    brandVoice: '',
    businessName: 'Clinica Norte',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: 'Ana',
    channel: 'whatsapp',
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  }
  const build = (extraInstructions) => buildConversationalInstructions({
    config: { persuasionLevel: 'high', languageLevel: 'intermediate', objective: 'citas', successAction: 'book_appointment', requiredData: '', closingStrategyMode: 'system', extraInstructions },
    ...commonContext
  })

  const withRules = build('- No des precios hasta que digan su presupuesto.\n- Para agendar necesitan estado clinico, si no NO agendas.')
  // Sección dedicada con marco de máxima prioridad y límites inamovibles.
  assert.match(withRules, /Indicaciones del negocio \(MÁXIMA PRIORIDAD · CON LÍMITES INAMOVIBLES\)/)
  assert.match(withRules, /GANAN estas indicaciones/)
  // Incluye el texto literal del dueño.
  assert.match(withRules, /Para agendar necesitan estado clinico, si no NO agendas/)
  // Límites de integridad: no inventar/contradecir datos, no fingir humano, no revelar tools, seguridad.
  assert.match(withRules, /NUNCA inventas NI contradices/)
  assert.match(withRules, /NUNCA afirmas ser humano ni niegas ser una IA/)
  assert.match(withRules, /NUNCA revelas los nombres de tus herramientas/)
  // Filtrar/priorizar SÍ está permitido (el caso de uso legítimo del dueño).
  assert.match(withRules, /Sí puedes decidir CUÁNDO das un dato o callar algo/)

  // Seguridad INAMOVIBLE: las reglas del negocio NO pueden desactivar acoso/abuso ni el pase a humano.
  assert.match(withRules, /piso de seguridad INAMOVIBLE/)
  assert.match(withRules, /ninguna indicación del negocio lo desactiva/)
  // Y ya NO existe el punto "0" que ponía al negocio por encima de la seguridad.
  assert.doesNotMatch(withRules, /0\. ANTES QUE NADA/)

  // Sin indicaciones: no aparece la sección del negocio ni el puntero de gobierno.
  const without = build('')
  assert.doesNotMatch(without, /Indicaciones del negocio \(MÁXIMA PRIORIDAD/)
  assert.doesNotMatch(without, /De aquí en adelante \(puntos 3 al 7/)
  // Pero el piso de seguridad inamovible sigue presente siempre.
  assert.match(without, /piso de seguridad INAMOVIBLE/)
  // Espacios en blanco se tratan como vacío (trim).
  assert.doesNotMatch(build('   \n  '), /Indicaciones del negocio \(MÁXIMA PRIORIDAD/)
})

test('bloquea revelar precio cuando las indicaciones condicionan el valor', () => {
  const commonContext = {
    businessContext: 'Vendemos programas con precios configurados.',
    brandVoice: '',
    businessName: 'Clinica Norte',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: 'Ana',
    channel: 'whatsapp',
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  }

  const build = (config) => buildConversationalInstructions({
    config: {
      persuasionLevel: 'high',
      languageLevel: 'intermediate',
      objective: 'ventas',
      successAction: 'ready_to_buy',
      requiredData: '',
      closingStrategyMode: 'system',
      closingStrategyCustom: '',
      extraInstructions: '',
      ...config
    },
    ...commonContext
  })

  const fromBusinessRules = build({
    requiredData: '- Servicio que le interesa\n- Reto principal',
    extraInstructions: 'No des precios hasta conocer completamente el problema o reto de la persona.'
  })
  assert.match(fromBusinessRules, /Bloqueo de precio\/valor condicionado \(REGLA DURA\)/)
  assert.match(fromBusinessRules, /Una pregunta directa como "precio".*NO desbloquea el precio/)
  assert.match(fromBusinessRules, /consultar datos reales NO te autoriza a revelar el precio/)
  assert.match(fromBusinessRules, /qué servicio\/producto busca/)
  assert.match(fromBusinessRules, /qué le pasa hoy o qué quiere resolver/)
  assert.match(fromBusinessRules, /Datos mínimos configurados: - Servicio que le interesa - Reto principal/)
  assert.match(fromBusinessRules, /No des precios hasta conocer completamente el problema o reto/)

  const fromAdvancedStrategy = build({
    closingStrategyMode: 'custom',
    closingStrategyCustom: 'No menciones costos ni cotices hasta entender su situación completa y el reto real.'
  })
  assert.match(fromAdvancedStrategy, /Bloqueo de precio\/valor condicionado \(REGLA DURA\)/)
  assert.match(fromAdvancedStrategy, /Instrucciones avanzadas: No menciones costos ni cotices/)
  assert.match(fromAdvancedStrategy, /Esta sección manda sobre la estrategia de cierre/)

  const promotionOnly = build({
    extraInstructions: 'Menciona la promoción de fin de mes cuando la persona ya esté interesada.'
  })
  assert.doesNotMatch(promotionOnly, /Bloqueo de precio\/valor condicionado/)
})

test('instrucciones universales evitan repetir datos y simular handoff sin tool', () => {
  const instructions = buildConversationalInstructions({
    config: {
      persuasionLevel: 'medium',
      languageLevel: 'intermediate',
      objective: 'citas',
      successAction: 'ready_for_human',
      requiredData: 'Nombre completo y motivo',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      closingStrategyMode: 'system',
      closingStrategyCustom: '',
      goalWorkflow: {
        appointments: {
          owner: 'human'
        }
      }
    },
    businessContext: 'Negocio de servicios con agenda.',
    brandVoice: '',
    businessName: 'Agenda Universal',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: 'Cliente Demo',
    channel: 'whatsapp',
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  })

  assert.match(instructions, /Antes de pedir cualquier dato, revisa el historial visible y get_contact_profile/)
  assert.match(instructions, /Si el dato ya aparece en la conversación o en el perfil, NO lo vuelvas a pedir/)
  assert.match(instructions, /guárdalo con save_contact_data si corresponde/)
  assert.match(instructions, /Nunca escribas como si ya hubieras pasado el chat al equipo/)
  assert.match(instructions, /si no ejecutaste mark_ready_to_advance o send_to_human/)
  assert.match(instructions, /Este agente NO agenda por su cuenta; un humano cierra la cita/)
  assert.match(instructions, /Después de esa tool, el bot se detiene/)
  assert.match(instructions, /una persona que no entiende el proceso después de explicarlo breve/)
})

test('instrucciones del agente respetan el toggle de emojis', () => {
  const baseConfig = {
    objective: 'citas',
    customObjective: '',
    successAction: 'ready_for_human',
    requiredData: '',
    handoffRules: '',
    extraInstructions: '',
    allowEmojis: false,
    closingStrategyMode: 'custom',
    closingStrategyCustom: 'Haz cierre breve y humano.'
  }
  const commonContext = {
    businessContext: '',
    brandVoice: '',
    businessName: 'Clinica Sol',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: null,
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  }

  const disabledInstructions = buildConversationalInstructions({
    config: baseConfig,
    ...commonContext
  })
  const enabledInstructions = buildConversationalInstructions({
    config: { ...baseConfig, allowEmojis: true },
    ...commonContext
  })

  assert.doesNotMatch(disabledInstructions, /Control de emojis/)
  assert.doesNotMatch(disabledInstructions, /No uses emojis en ningún mensaje visible/)
  assert.match(enabledInstructions, /Control de emojis: ACTIVADO/)
  assert.match(enabledInstructions, /incluye 1 emoji cuando suene natural/)
  assert.match(enabledInstructions, /No uses más de 1 emoji por mensaje/)
})

test('instrucciones del agente respetan identidad configurada', () => {
  const baseConfig = {
    objective: 'citas',
    customObjective: '',
    successAction: 'ready_for_human',
    requiredData: '',
    handoffRules: '',
    extraInstructions: '',
    allowEmojis: false,
    closingStrategyMode: 'custom',
    closingStrategyCustom: 'Haz cierre breve y humano.'
  }
  const commonContext = {
    businessContext: '',
    brandVoice: '',
    businessName: 'Clinica Sol',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: null,
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  }

  const businessInstructions = buildConversationalInstructions({
    config: { ...baseConfig, identityMode: 'business' },
    ...commonContext
  })
  assert.match(businessInstructions, /Identidad configurada del agente/)
  assert.match(businessInstructions, /Preséntate como representante de Clinica Sol/)
  assert.match(businessInstructions, /"nosotros"/)
  assert.match(businessInstructions, /No compartas ni inventes un nombre personal/)

  const customInstructions = buildConversationalInstructions({
    config: { ...baseConfig, identityMode: 'custom', identityCustomName: 'Marcos' },
    ...commonContext
  })
  assert.match(customInstructions, /Preséntate como Marcos/)
  assert.match(customInstructions, /"soy Marcos"/)
  assert.match(customInstructions, /Habla en singular cuando te presentes/)

  const agentNameInstructions = buildConversationalInstructions({
    config: { ...baseConfig, name: 'Robot 34', identityMode: 'agent' },
    ...commonContext
  })
  assert.match(agentNameInstructions, /Preséntate como Robot 34/)
  assert.match(agentNameInstructions, /"soy Robot 34"/)
})

test('instrucciones del agente incluyen anticipo y acción final configurados', () => {
  const instructions = buildConversationalInstructions({
    config: {
      objective: 'citas',
      customObjective: '',
      successAction: 'ready_for_human',
      requiredData: '',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Haz cierre breve y humano.',
      goalWorkflow: {
        deposit: {
          enabled: true,
          mode: 'range',
          minAmount: 200,
          maxAmount: 900,
          currency: 'MXN'
        },
        completion: {
          mode: 'assign_user',
          userId: 'user_ventas',
          userName: 'Ana Ventas'
        }
      }
    },
    businessContext: '',
    brandVoice: '',
    businessName: 'Clinica Sol',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: null,
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  })

  assert.match(instructions, /Anticipo antes de concretar/)
  assert.match(instructions, /Monto configurado: entre 200 y 900 MXN/)
  assert.match(instructions, /NO ejecutes la acción de avance hasta que el contacto haya enviado comprobante/)
  assert.match(instructions, /comprobanteValidado=true/)
  assert.match(instructions, /Después de cumplir el objetivo/)
  assert.match(instructions, /asigna el contacto a Ana Ventas/)
})

test('instrucciones de agenda por IA usan calidad real de intencion de meta', () => {
  const instructions = buildConversationalInstructions({
    config: {
      objective: 'citas',
      customObjective: '',
      successAction: 'book_appointment',
      requiredData: '',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      closingStrategyMode: 'system',
      closingStrategyCustom: '',
      goalWorkflow: {
        appointments: {
          owner: 'ai',
          calendarId: 'cal_test',
          allowOverlappingAppointments: false
        }
      }
    },
    businessContext: '',
    brandVoice: '',
    businessName: 'Clinica Sol',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: null,
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  })

  assert.match(instructions, /Flujo de agenda configurado/)
  assert.match(instructions, /Este agente debe intentar agendar por IA/)
  assert.match(instructions, /Si la persona está claramente urgida y pide agendar con motivo real/)
  assert.match(instructions, /registra goalIntentQuality\/goalMotivation\/priceShoppingRisk/)
  assert.match(instructions, /no ejecutes book_appointment hasta que confirme un horario real/)
  assert.match(instructions, /CUÁNDO ACTIVAR book_appointment/)
  assert.match(instructions, /NO la actives si solo saludó, solo preguntó el precio sin dar contexto/)
})

test('instrucciones de venta completa no piden comprobante aunque exista deposito legacy', () => {
  const instructions = buildConversationalInstructions({
    config: {
      objective: 'ventas',
      customObjective: '',
      successAction: 'ready_to_buy',
      requiredData: '',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Haz cierre breve y humano.',
      goalWorkflow: {
        sales: {
          owner: 'ai',
          paymentMode: 'full_payment',
          productName: 'Curso Intensivo',
          amount: 1200,
          currency: ''
        },
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 300,
          currency: ''
        }
      }
    },
    businessContext: '',
    brandVoice: '',
    businessName: 'Academia Sol',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: null,
    accountLocale: { countryCode: 'US', currency: 'USD', dialCode: '1' }
  })

  assert.match(instructions, /Flujo de cobro configurado/)
  assert.match(instructions, /Curso Intensivo · 1200 USD/)
  assert.match(instructions, /Si la persona confirma producto, monto\/canal y motivo real de compra o pago/)
  assert.match(instructions, /registra goalIntentQuality\/goalMotivation\/priceShoppingRisk/)
  assert.doesNotMatch(instructions, /Pago solicitado antes de concretar la venta/)
  assert.doesNotMatch(instructions, /comprobanteValidado=true/)
})

test('instrucciones del agente separan correo de canales de chat', () => {
  const instructions = buildConversationalInstructions({
    config: {
      objective: 'citas',
      customObjective: '',
      successAction: 'ready_for_human',
      requiredData: '',
      handoffRules: '',
      extraInstructions: '',
      allowEmojis: false,
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Cierra breve y claro.'
    },
    businessContext: '',
    brandVoice: '',
    businessName: 'Clinica Mail',
    timezone: 'America/Mexico_City',
    nowIso: 'miércoles, 17 de junio de 2026, 14:00',
    contactName: null,
    channel: 'email',
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  })

  assert.match(instructions, /conversación por Correo/)
  assert.match(instructions, /Forma de respuesta por correo/)
  assert.match(instructions, /un solo cuerpo de correo breve/)
  assert.match(instructions, /texto EXACTO que recibirá la persona por Correo/)
  assert.doesNotMatch(instructions, /conversación de WhatsApp/)
  assert.doesNotMatch(instructions, /texto visible para WhatsApp/)
})

test('agrega memoria interna de cierre solo cuando usa estrategia de fabrica', () => {
  const baseConfig = {
    objective: 'ventas',
    customObjective: '',
    successAction: 'ready_for_human',
    requiredData: '',
    handoffRules: '',
    extraInstructions: '',
    allowEmojis: false,
    closingStrategyMode: 'system',
    closingStrategyCustom: ''
  }
  const advancedClosingContext = {
    enabled: true,
    parameters: {
      NOMBRE_DEL_NEGOCIO: 'Ristak',
      CANAL_DE_CONVERSACION: 'WhatsApp',
      PRODUCTO_O_SERVICIO: 'automatización de mensajes',
      OBJETIVO_FINAL: 'hablar con un humano',
      HERRAMIENTA_INTERNA_DE_AVANCE: 'mark_ready_to_advance',
      HERRAMIENTA_INTERNA_DE_DESCARTE: 'discard_conversation'
    },
    systemFacts: ['Canal detectado: WhatsApp', 'Etiqueta: prospecto'],
    learned: {
      contactReason: 'pierde leads por responder tarde',
      realProblem: 'sus conversaciones se enfrían antes de que el equipo conteste',
      problemMagnitudeAwareness: 'ya entiende que cada hora de espera enfria la intencion de compra',
      goalIntentQuality: 'alta: pidio avanzar hoy con una llamada de diagnostico',
      goalMotivation: 'quiere dejar de perder leads sin contratar otra persona',
      appointmentIntentQuality: 'alta: pidio hablar hoy y acepto avanzar con horario concreto',
      priceShoppingRisk: 'bajo: pregunto valor despues de explicar el problema',
      desiredOutcome: 'responder más rápido sin contratar otra persona'
    },
    missingFields: ['whyNow', 'consequenceIfNoAction']
  }

  const instructions = buildConversationalInstructions({
    config: baseConfig,
    businessContext: 'Software para operación comercial.',
    brandVoice: '',
    businessName: 'Ristak',
    timezone: 'America/Mexico_City',
    nowIso: 'sábado, 13 de junio de 2026, 10:00',
    contactName: 'Juan',
    advancedClosingContext,
    accountLocale: { countryCode: 'MX', currency: 'MXN', dialCode: '52' }
  })

  assert.match(instructions, /Eres el asistente conversacional de Ristak/)
  assert.match(instructions, /conversación por WhatsApp/)
  assert.match(instructions, /Parámetros internos de cierre avanzado/)
  assert.match(instructions, /Puntos aprendidos de esta conversación/)
  assert.match(instructions, /Problema real: sus conversaciones se enfrían/)
  assert.match(instructions, /Conciencia de magnitud del problema: ya entiende que cada hora/)
  assert.match(instructions, /Calidad de intencion de meta: alta/)
  assert.match(instructions, /Motivacion real de meta: quiere dejar de perder leads/)
  assert.match(instructions, /Calidad de intencion de agenda: alta/)
  assert.match(instructions, /Riesgo de solo comparar precio: bajo/)
  assert.match(instructions, /CUÁNDO ACTIVAR mark_ready_to_advance/)
  assert.match(instructions, /NO la actives si solo saludó, solo preguntó el precio sin dar contexto/)
  assert.match(instructions, /Si ya aceptó, no sigas vendiendo/)
  assert.match(instructions, /update_closing_context/)
  assert.match(instructions, /Parámetros del negocio para el guión de fábrica/)
  assert.match(instructions, /El guión de fábrica manda completo/)
  assert.match(instructions, /No pongas a la persona en modo comprador/)
  assert.match(instructions, /Cultura textual regional/)
  assert.match(instructions, /Cuenta configurada en México/)
  assert.match(instructions, /GAD/)
  assert.match(instructions, /Espejo y rapport/)
  assert.doesNotMatch(instructions, /\[NOMBRE_DEL_NEGOCIO\]/)
  assert.match(instructions, /El patrón invariable: regresar la definición a la persona SIN explicar el producto/)
  assert.match(instructions, /\[siguiente paso\]/)
  assert.doesNotMatch(instructions, /\[(?:ESCRIBIR[^\]]*|NOMBRE_DEL_NEGOCIO|INDUSTRIA|PRODUCTO_O_SERVICIO|CANAL_DE_CONVERSACION|HERRAMIENTA_INTERNA_DE_AVANCE|HERRAMIENTA_INTERNA_DE_DESCARTE)\]/)
  assert.match(instructions, /No uses el mismo molde dos veces seguidas/)
  assert.match(instructions, /precisión concreta, reflejo breve, respuesta puntual o siguiente paso/)

  const customInstructions = buildConversationalInstructions({
    config: {
      ...baseConfig,
      closingStrategyMode: 'custom',
      closingStrategyCustom: 'Mi estrategia custom con [NOMBRE_DEL_NEGOCIO]'
    },
    businessContext: '',
    brandVoice: '',
    businessName: 'Ristak',
    timezone: 'America/Mexico_City',
    nowIso: 'sábado, 13 de junio de 2026, 10:00',
    contactName: null,
    advancedClosingContext,
    accountLocale: { countryCode: 'ES', currency: 'EUR', dialCode: '34' }
  })

  assert.match(customInstructions, /Mi estrategia custom con \[NOMBRE_DEL_NEGOCIO\]/)
  assert.match(customInstructions, /Cuenta configurada en España/)
  assert.match(customInstructions, /vale/)
  assert.doesNotMatch(customInstructions, /Lenguaje natural, cercano, mexicano/)
  assert.doesNotMatch(customInstructions, /Parámetros del negocio para el guión de fábrica/)
  assert.doesNotMatch(customInstructions, /Adaptación conversacional al negocio/)
  assert.doesNotMatch(customInstructions, /Parametros internos de cierre avanzado/)
})

test('memoria de cierre avanzado solo acepta parametros del contrato', () => {
  const result = mergeAdvancedClosingContext(
    { contactReason: 'quiere saber precios' },
    {
      whyNow: 'tiene una fecha encima',
      problemMagnitudeAwareness: 'todavia cree que puede esperar aunque perderia la fecha',
      goalIntentQuality: 'dudosa: dice que compra pero evita confirmar producto y canal',
      goalMotivation: 'busca comparar valor antes de decidir',
      appointmentIntentQuality: 'dudosa: dice que agenda pero no confirma dia ni hora',
      priceShoppingRisk: 'alto: insiste en precio y evita contar contexto',
      urgencyLevel: 'alta',
      campoInventado: 'no debe guardarse'
    },
    { updatedBy: 'agent', nowIso: '2026-06-13T10:00:00.000Z' }
  )

  assert.deepEqual(result.changedKeys.sort(), ['appointmentIntentQuality', 'goalIntentQuality', 'goalMotivation', 'priceShoppingRisk', 'problemMagnitudeAwareness', 'urgencyLevel', 'whyNow'])
  assert.equal(result.context.contactReason, 'quiere saber precios')
  assert.equal(result.context.whyNow, 'tiene una fecha encima')
  assert.equal(result.context.problemMagnitudeAwareness, 'todavia cree que puede esperar aunque perderia la fecha')
  assert.equal(result.context.goalIntentQuality, 'dudosa: dice que compra pero evita confirmar producto y canal')
  assert.equal(result.context.goalMotivation, 'busca comparar valor antes de decidir')
  assert.equal(result.context.appointmentIntentQuality, 'dudosa: dice que agenda pero no confirma dia ni hora')
  assert.equal(result.context.priceShoppingRisk, 'alto: insiste en precio y evita contar contexto')
  assert.equal(result.context.urgencyLevel, 'alta')
  assert.equal(result.context.campoInventado, undefined)
  assert.equal(result.context.updatedBy, 'agent')
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
  assert.equal(shouldRecoverPendingInbound({
    ...latest,
    id: 'inbound-viejo',
    message_timestamp: '2026-06-12 23:00:00'
  }, { status: 'active' }, { nowMs, maxAgeMs: 60 * 60 * 1000 }), false)
})
