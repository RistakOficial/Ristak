import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { CHEAPEST_OPENAI_MODEL } from '../src/config/openAIModels.js'
import { APPOINTMENT_CONFIRMATION_MODEL } from '../src/agents/appointmentConfirmationAgent.js'
import {
  buildConversationalAgentMetrics,
  completeConversationalAgentSalePaymentFromInvoice,
  completeConversationGoalLinkFromWebhook,
  createConversationalAgent,
  createConversationGoalLink,
  getConversationalAgent,
  getConversationGoalLink,
  getConversationState,
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
  shouldMigrateLegacyConversationalAgentConfig,
  updateConversationalAgent
} from '../src/services/conversationalAgentService.js'
import { createTriggerLink } from '../src/services/triggerLinksService.js'
import {
  buildReplyPartDelaySchedule,
  buildPendingReplyContextMessage,
  sanitizeAgentReply,
  sendReplyParts,
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
  buildBusinessAdaptiveClosingSection,
  buildClosingStrategyTemplateParameters,
  buildConversationalInstructions,
  renderClosingStrategyTemplate
} from '../src/agents/conversational/prompt.js'
import {
  buildBusinessProfilePromptParameters,
  normalizeBusinessProfileExtraction
} from '../src/services/aiAgentService.js'

test('flujos IA automaticos de bajo costo usan siempre el modelo mas barato aprobado', () => {
  assert.equal(CHEAPEST_OPENAI_MODEL, 'gpt-5.4-nano')
  assert.equal(MESSAGE_SPLITTER_MODEL, CHEAPEST_OPENAI_MODEL)
  assert.equal(APPOINTMENT_CONFIRMATION_MODEL, CHEAPEST_OPENAI_MODEL)
})

test('normaliza la entrega de respuestas en partes', () => {
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
      trackingParam: 'booking-ref!'
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
    anticipoValidado: true
  }))

  assert.equal(allowed.ok, true)
  assert.equal(allowed.simulated, true)
  assert.equal(allowed.signal, 'ready_for_human')
  assert.equal(ctx.actions[0]?.type, 'mark_ready_to_advance')
})

test('modo venta completa no bloquea avance por anticipo legacy', async () => {
  const ctx = {
    contactId: 'test_sales_full_payment_contact',
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
  const markReadyTool = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
  assert.ok(markReadyTool)

  const allowed = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere comprar el curso completo',
    resumen: 'Pidió pagar todo',
    urgencia: 'media',
    siguientePaso: 'Crear link de pago'
  }))

  assert.equal(allowed.ok, true)
  assert.equal(allowed.signal, 'ready_to_buy')
  assert.equal(ctx.actions[0]?.type, 'mark_ready_to_advance')
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
    siguientePaso: 'Pasar al asesor'
  }))

  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /Falta validar el pago solicitado \(300 USD\)/)
  assert.equal(ctx.actions.length, 0)

  const allowed = await markReadyTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere apartar su lugar',
    resumen: 'Mandó comprobante válido',
    urgencia: 'alta',
    siguientePaso: 'Pasar al asesor',
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
    assert.match(state.signalSummary, /equipo debe continuar/)

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
    assert.match(state.signal_summary, /appt_123/)
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
    assert.match(state.signal_summary, /purchase_123/)
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
    assert.match(state.signalSummary, /invoice_agent_123/)

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
  assert.equal(parts.join(' '), longReply)
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

  assert.deepEqual(result.messages, ['sí, mañana a las 5 está perfecto'])
})

test('modo humano usa fallback natural cuando no hay splitter IA disponible', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ah ya te entendí… ¿pero cómo está eso exactamente?',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 120, randomizeSplitting: true },
    random: () => 0.8
  })

  assert.equal(result.source, 'fallback')
  assert.deepEqual(result.messages, ['ah ya te entendí…', '¿pero cómo está eso exactamente?'])
})

test('modo humano acepta BREAK como separador pero no lo expone al contacto', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora dime qué fecha te queda mejor',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120 },
    aiSplitter: async () => 'ok perfecto [BREAK] ahora dime qué fecha te queda mejor'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['ok perfecto', 'ahora dime qué fecha te queda mejor'])
  assert.ok(result.messages.every((message) => !message.includes('[BREAK]')))
})

test('modo humano separa BREAK aunque venga dentro de JSON válido', async () => {
  const result = await splitMessageIntoBubbles({
    text: 'ok perfecto ahora dime qué fecha te queda mejor',
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 4, maxBubbleLength: 120 },
    aiSplitter: async () => '{"messages":["ok perfecto [BREAK] ahora dime qué fecha te queda mejor"]}'
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, ['ok perfecto', 'ahora dime qué fecha te queda mejor'])
  assert.ok(result.messages.every((message) => !message.includes('[BREAK]')))
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
    'ya..',
    'entonces sí traes ese tema encima',
    'pa entenderte bien y no decirte algo al aire',
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
    'ya..',
    'entonces sí traes ese tema encima',
    'pa entenderte bien y no decirte algo al aire',
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
  assert.deepEqual(result.messages, ['claro,', 'de qué te gustaría saber?'])
})

test('modo humano no deja una frase dependiente sola antes de una pregunta', async () => {
  const original = 'depende de lo que necesites. tú eres médico o lo ves para alguien más?'
  const result = await splitMessageIntoBubbles({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 160, randomizeSplitting: true },
    aiSplitter: async () => ({ messages: ['depende de lo que necesites.', 'tú eres médico o lo ves para alguien más?'] })
  })

  assert.equal(result.source, 'ai')
  assert.deepEqual(result.messages, [original])
})

test('modo humano fallback no corta depende de lo que necesitas antes del contexto', () => {
  const original = 'depende de lo que necesites. tú eres médico o lo ves para alguien más?'
  const result = splitMessageIntoBubblesFallback({
    text: original,
    settings: { mode: 'split', splitMessagesEnabled: true, minMessageLengthToSplit: 1, maxBubbles: 6, minBubbleLength: 10, maxBubbleLength: 160, randomizeSplitting: true },
    random: () => 0.99
  })

  assert.deepEqual(result.messages, [original])
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
  assert.equal(result.messages.join(' '), longReply)
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
    'Agente de [NOMBRE_DEL_NEGOCIO] por [CANAL_DE_CONVERSACION]; problema: [PROBLEMA_REAL]; avance: [HERRAMIENTA_INTERNA_DE_AVANCE]',
    {
      NOMBRE_DEL_NEGOCIO: 'Clínica Norte',
      CANAL_DE_CONVERSACION: 'WhatsApp',
      PROBLEMA_REAL: 'dolor que ya afecta su rutina',
      HERRAMIENTA_INTERNA_DE_AVANCE: 'mark_ready_to_advance'
    }
  )

  assert.equal(rendered, 'Agente de Clínica Norte por WhatsApp; problema: dolor que ya afecta su rutina; avance: mark_ready_to_advance')
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
  assert.match(rendered, /\[regresa\]/)
  assert.doesNotMatch(rendered, /dato pendiente de configurar/)
  assert.doesNotMatch(rendered, /\[(?:ESCRIBIR[^\]]*|NOMBRE_DEL_NEGOCIO|INDUSTRIA|PRODUCTO_O_SERVICIO|CANAL_DE_CONVERSACION|HERRAMIENTA_INTERNA_DE_AVANCE|HERRAMIENTA_INTERNA_DE_DESCARTE)\]/)
  assert.ok(rendered.length > 15000)
})

test('estrategia de fabrica conserva reglas anti-molde y anti-asuncion', () => {
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /me da curiosidad/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /justo ahorita/i)
  assert.doesNotMatch(DEFAULT_CLOSING_STRATEGY, /qué te hizo escribirnos/i)
  assert.match(DEFAULT_CLOSING_STRATEGY, /AGENTE CONVERSACIONAL DE CIERRE/)
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
  assert.match(DEFAULT_CLOSING_STRATEGY, /dosis EXTRA de ligereza/)
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

  assert.match(disabledInstructions, /Control de emojis: APAGADO/)
  assert.match(disabledInstructions, /No uses emojis en ningún mensaje visible/)
  assert.doesNotMatch(disabledInstructions, /Control de emojis: ACTIVADO/)
  assert.match(enabledInstructions, /Control de emojis: ACTIVADO/)
  assert.match(enabledInstructions, /incluye 1 emoji cuando suene natural/)
  assert.match(enabledInstructions, /No uses más de 1 emoji por mensaje/)
  assert.doesNotMatch(enabledInstructions, /Control de emojis: APAGADO/)
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
  assert.doesNotMatch(instructions, /Pago solicitado antes de concretar la venta/)
  assert.doesNotMatch(instructions, /comprobanteValidado=true/)
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
  assert.match(instructions, /conversación de WhatsApp/)
  assert.match(instructions, /Parámetros internos de cierre avanzado/)
  assert.match(instructions, /Puntos aprendidos de esta conversación/)
  assert.match(instructions, /Problema real: sus conversaciones se enfrían/)
  assert.match(instructions, /update_closing_context/)
  assert.match(instructions, /Parámetros del negocio para el guión de fábrica/)
  assert.match(instructions, /El guión de fábrica manda completo/)
  assert.match(instructions, /No pongas a la persona en modo comprador/)
  assert.match(instructions, /Cultura textual regional/)
  assert.match(instructions, /Cuenta configurada en México/)
  assert.match(instructions, /GAD/)
  assert.match(instructions, /Espejo y rapport/)
  assert.doesNotMatch(instructions, /\[NOMBRE_DEL_NEGOCIO\]/)
  assert.match(instructions, /\[regresa\]/)
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
      urgencyLevel: 'alta',
      campoInventado: 'no debe guardarse'
    },
    { updatedBy: 'agent', nowIso: '2026-06-13T10:00:00.000Z' }
  )

  assert.deepEqual(result.changedKeys.sort(), ['urgencyLevel', 'whyNow'])
  assert.equal(result.context.contactReason, 'quiere saber precios')
  assert.equal(result.context.whyNow, 'tiene una fecha encima')
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
