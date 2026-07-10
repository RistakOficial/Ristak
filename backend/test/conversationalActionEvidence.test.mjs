import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import {
  revalidateAppointmentSlot,
  verifyAppointmentConfirmationEvidence
} from '../src/agents/conversational/actionEvidence.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'

test('book_appointment bloquea una acción real si la confirmación sólo existe en la intención del LLM', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_action_evidence_${suffix}`
  const contactId = `rstk_contact_action_evidence_${suffix}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 21 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slot = nextMonday.set({ hour: 15, minute: 0, second: 0, millisecond: 0 })

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'loc_action_evidence',
      name: 'Calendario evidencia de acción',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      openHours: [
        { daysOfTheWeek: [1], hours: [{ openHour: 15, openMinute: 0, closeHour: 17, closeMinute: 0 }] }
      ]
    }, { source: 'ristak', syncStatus: 'synced' })

    const ctx = {
      contactId,
      dryRun: false,
      actions: [],
      conversationMessages: [
        { role: 'assistant', content: `¿Confirmas la cita del ${slot.toFormat('dd/MM/yyyy')} a las 15:00?` },
        { role: 'user', content: 'Sí' }
      ],
      config: {
        objective: 'citas',
        successAction: 'book_appointment',
        goalWorkflow: { appointments: { owner: 'ai', calendarId } }
      }
    }
    const tool = createConversationalTools(ctx).find((item) => item.name === 'book_appointment')
    const result = await tool.invoke(null, JSON.stringify({
      calendarId,
      startTime: slot.toUTC().toISO(),
      title: 'Cita sin evidencia persistida',
      notes: 'El modelo dice que sí, pero la conversación real no lo demuestra'
    }))

    assert.equal(result.ok, false)
    assert.equal(result.confirmationRequired, true, JSON.stringify(result))
    assert.equal(result.actionCompleted, false)
    assert.match(result.error, /No se agendó nada/)
    assert.equal(ctx.actions.length, 0)

    ctx.dryRun = true
    const simulated = await tool.invoke(null, JSON.stringify({
      calendarId,
      startTime: slot.toUTC().toISO(),
      title: 'Cita simulada',
      notes: 'Sólo previsualización'
    }))
    assert.equal(simulated.ok, true)
    assert.equal(simulated.simulated, true)
    assert.equal(ctx.actions[0]?.type, 'book_appointment')
    assert.equal(ctx.actions[0]?.outcome?.status, 'simulated')
    assert.equal(ctx.actions[0]?.outcome?.actionCompleted, false)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('una confirmación vieja por día de semana no autoriza una cita nueva', async () => {
  const timezone = 'America/Ciudad_Juarez'
  const now = DateTime.fromISO('2026-07-10T10:00:00', { zone: timezone })
  const slot = DateTime.fromISO('2026-07-17T15:00:00', { zone: timezone })
  const result = await verifyAppointmentConfirmationEvidence({
    startTime: slot.toISO(),
    timezone,
    nowMs: now.toMillis(),
    messages: [{
      id: 'confirmation_2025',
      direction: 'inbound',
      text: 'Sí, el viernes a las 3 pm',
      timestamp: '2025-01-03T21:00:00.000Z'
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(result.confirmationRequired, true)
  assert.equal(result.actionCompleted, false)
})

test('una respuesta breve reciente queda ligada a la oferta exacta anterior', async () => {
  const timezone = 'America/Ciudad_Juarez'
  const now = DateTime.fromISO('2026-07-10T10:10:00', { zone: timezone })
  const slot = DateTime.fromISO('2026-07-17T15:00:00', { zone: timezone })
  const result = await verifyAppointmentConfirmationEvidence({
    startTime: slot.toISO(),
    timezone,
    nowMs: now.toMillis(),
    messages: [
      {
        id: 'offer_recent',
        direction: 'outbound',
        text: '¿Confirmas la cita del 17/07/2026 a las 15:00?',
        timestamp: now.minus({ minutes: 5 }).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
      },
      {
        id: 'confirmation_recent',
        direction: 'inbound',
        text: 'Sí, perfecto',
        timestamp: now.minus({ minutes: 2 }).toUTC().toFormat('yyyy-MM-dd HH:mm:ss')
      }
    ]
  })

  assert.equal(result.ok, true)
  assert.equal(result.evidenceVerified, true)
  assert.equal(result.offerMessageId, 'offer_recent')
  assert.equal(result.confirmationMessageId, 'confirmation_recent')
})

test('una confirmación reciente que escribe fecha y hora exactas no requiere repetir la oferta', async () => {
  const timezone = 'America/Ciudad_Juarez'
  const now = DateTime.fromISO('2026-07-10T10:10:00', { zone: timezone })
  const slot = DateTime.fromISO('2026-07-17T15:00:00', { zone: timezone })
  const result = await verifyAppointmentConfirmationEvidence({
    startTime: slot.toISO(),
    timezone,
    nowMs: now.toMillis(),
    messages: [{
      id: 'direct_exact_confirmation',
      direction: 'inbound',
      text: 'Sí, agéndame el 17 de julio a las 3 pm',
      timestamp: now.minus({ minutes: 1 }).toUTC().toISO()
    }]
  })

  assert.equal(result.ok, true)
  assert.equal(result.evidenceVerified, true)
  assert.equal(result.confirmationMessageId, 'direct_exact_confirmation')
  assert.equal(result.offerMessageId, undefined)
})

test('día de semana y hora sin oferta exacta siguen siendo ambiguos aunque sean recientes', async () => {
  const timezone = 'America/Ciudad_Juarez'
  const now = DateTime.fromISO('2026-07-10T10:10:00', { zone: timezone })
  const slot = DateTime.fromISO('2026-07-17T15:00:00', { zone: timezone })
  const result = await verifyAppointmentConfirmationEvidence({
    startTime: slot.toISO(),
    timezone,
    nowMs: now.toMillis(),
    messages: [{
      id: 'ambiguous_weekday_confirmation',
      direction: 'inbound',
      text: 'Sí, el viernes a las 3 pm',
      timestamp: now.minus({ minutes: 1 }).toUTC().toISO()
    }]
  })

  assert.equal(result.ok, false)
  assert.equal(result.confirmationRequired, true)
})

test('revalidación de slots falla cerrado y pide transferencia si el calendario no responde', async () => {
  const result = await revalidateAppointmentSlot({
    calendarId: 'calendar_unavailable',
    requestedStartTime: '2026-08-10T21:00:00.000Z',
    windowStart: '2026-08-10',
    windowEnd: '2026-08-10',
    lookupSlots: async () => {
      throw new Error('calendar storage unavailable')
    }
  })

  assert.equal(result.ok, false)
  assert.equal(result.availabilityCheckFailed, true)
  assert.equal(result.transferRequired, true)
  assert.equal(result.actionCompleted, false)
  assert.match(result.error, /No se agendó nada/)
})

test('create_payment_link rechaza un monto distinto al workflow aunque el LLM lo confirme', async () => {
  const ctx = {
    contactId: `payment_amount_mismatch_${randomUUID()}`,
    dryRun: true,
    actions: [],
    accountLocale: { currency: 'USD' },
    conversationMessages: [
      { role: 'assistant', content: 'El Curso Intensivo cuesta 100 USD. ¿Te envío el link de pago?' },
      { role: 'user', content: 'Sí, mándame el link de pago' }
    ],
    config: {
      objective: 'ventas',
      successAction: 'ready_to_buy',
      goalWorkflow: {
        sales: {
          owner: 'ai',
          productName: 'Curso Intensivo',
          priceName: 'Pago único',
          amount: 100,
          currency: 'USD',
          paymentMode: 'full_payment'
        }
      }
    }
  }

  const tool = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
  const result = await tool.invoke(null, JSON.stringify({
    amount: 175,
    currency: 'USD',
    concept: 'Curso Intensivo',
    dueDate: null,
    channel: 'whatsapp',
    confirm: true
  }))

  assert.equal(result.ok, false)
  assert.equal(result.amountMismatch, true)
  assert.equal(result.actionCompleted, false)
  assert.match(result.error, /no coincide con el cobro configurado/i)
  assert.match(result.error, /No se creó ni envió ningún link/)
  assert.equal(ctx.actions.length, 0)
})

test('un comprobante inventado por boolean no sustituye un pago verificable existente', async () => {
  const ctx = {
    contactId: `fake_receipt_${randomUUID()}`,
    dryRun: false,
    actions: [],
    accountLocale: { currency: 'USD' },
    conversationMessages: [
      { role: 'assistant', content: '¿Quieres que el equipo continúe con tu cita?' },
      { role: 'user', content: 'Sí' }
    ],
    config: {
      id: `agent_fake_receipt_${randomUUID()}`,
      objective: 'citas',
      successAction: 'ready_for_human',
      goalWorkflow: {
        deposit: {
          enabled: true,
          mode: 'fixed',
          amount: 250,
          currency: 'USD'
        }
      }
    }
  }

  const tool = createConversationalTools(ctx).find((item) => item.name === 'mark_ready_to_advance')
  const result = await tool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere continuar',
    resumen: 'El modelo afirmó que vio un comprobante',
    urgencia: 'alta',
    siguientePaso: 'Validar pago',
    confirm: true,
    comprobanteValidado: true
  }))

  assert.equal(result.ok, false)
  assert.equal(result.paymentEvidenceRequired, true)
  assert.equal(result.claimedProofIgnored, true)
  assert.equal(result.actionCompleted, false)
  assert.match(result.error, /No existe un pago confirmado o registro verificable/)
  assert.equal(ctx.actions.length, 0)
})

test('ctx.actions registra outcomes verificables para cierre, links, pago, handoff y descarte', async () => {
  const internalCtx = {
    contactId: `outcome_internal_${randomUUID()}`,
    dryRun: true,
    actions: [],
    config: { objective: 'custom', successAction: 'none', goalWorkflow: {} }
  }
  const internalTools = createConversationalTools(internalCtx)
  const markReady = internalTools.find((item) => item.name === 'mark_ready_to_advance')
  const handoff = internalTools.find((item) => item.name === 'send_to_human')
  const discard = internalTools.find((item) => item.name === 'discard_conversation')

  await markReady.invoke(null, JSON.stringify({
    intencionDetectada: 'Meta cumplida en simulación',
    resumen: 'Resumen de prueba',
    urgencia: 'media',
    siguientePaso: 'Revisar',
    confirm: true
  }))
  await handoff.invoke(null, JSON.stringify({ motivo: 'Revisión humana', resumen: 'Caso de prueba' }))
  await discard.invoke(null, JSON.stringify({ motivo: 'Spam', resumen: 'Caso de prueba', nivelDeRiesgo: 'bajo' }))

  assert.deepEqual(
    internalCtx.actions.map((action) => [action.type, action.outcome?.status]),
    [
      ['mark_ready_to_advance', 'simulated'],
      ['send_to_human', 'simulated'],
      ['discard_conversation', 'simulated']
    ]
  )
  assert.ok(internalCtx.actions.every((action) => action.outcome?.ok === true))
  assert.ok(internalCtx.actions.every((action) => action.outcome?.actionCompleted === false))

  const goalCtx = {
    contactId: `outcome_goal_${randomUUID()}`,
    dryRun: true,
    actions: [],
    conversationMessages: [
      { role: 'assistant', content: '¿Te mando el enlace para continuar?' },
      { role: 'user', content: 'Sí' }
    ],
    config: {
      objective: 'citas',
      successAction: 'send_goal_url',
      goalWorkflow: {
        appointments: { owner: 'url', url: 'https://agenda.example/reservar', trackingParam: 'goal_id' }
      }
    }
  }
  const goalTool = createConversationalTools(goalCtx).find((item) => item.name === 'send_goal_url')
  const goalResult = await goalTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere agendar',
    resumen: 'Aceptó continuar por enlace',
    confirm: true
  }))
  assert.equal(goalResult.ok, true)
  assert.equal(goalCtx.actions[0]?.outcome?.status, 'simulated')
  assert.equal(goalCtx.actions[0]?.outcome?.deliveryConfirmed, false)

  const triggerCtx = {
    contactId: `outcome_trigger_${randomUUID()}`,
    dryRun: true,
    actions: [],
    conversationMessages: goalCtx.conversationMessages,
    config: {
      objective: 'custom',
      successAction: 'send_trigger_link',
      goalWorkflow: {
        triggerLink: {
          triggerLinkId: 'trigger_outcome_test',
          triggerLinkPublicId: 'outcome-public',
          triggerLinkName: 'Continuar',
          triggerLinkUrl: 'https://links.example/continuar'
        }
      }
    }
  }
  const triggerTool = createConversationalTools(triggerCtx).find((item) => item.name === 'send_trigger_link')
  const triggerResult = await triggerTool.invoke(null, JSON.stringify({
    intencionDetectada: 'Quiere continuar',
    resumen: 'Aceptó el enlace',
    confirm: true
  }))
  assert.equal(triggerResult.ok, true)
  assert.equal(triggerCtx.actions[0]?.outcome?.status, 'simulated')
  assert.equal(triggerCtx.actions[0]?.outcome?.deliveryConfirmed, false)

  const contactId = `outcome_payment_${randomUUID()}`
  await db.run(
    'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    [contactId, '+15555550123', 'outcome@example.com', 'Contacto Outcome', 'test']
  )
  try {
    const paymentCtx = {
      contactId,
      dryRun: true,
      actions: [],
      accountLocale: { currency: 'USD' },
      conversationMessages: [
        { role: 'assistant', content: 'El Curso Outcome cuesta 100 USD. ¿Te envío el link de pago?' },
        { role: 'user', content: 'Sí, mándame el link de pago' }
      ],
      config: {
        objective: 'ventas',
        successAction: 'ready_to_buy',
        goalWorkflow: {
          sales: {
            owner: 'ai',
            productName: 'Curso Outcome',
            amount: 100,
            currency: 'USD',
            paymentMode: 'full_payment'
          }
        }
      }
    }
    const paymentTool = createConversationalTools(paymentCtx).find((item) => item.name === 'create_payment_link')
    const paymentResult = await paymentTool.invoke(null, JSON.stringify({
      amount: 100,
      currency: 'USD',
      concept: 'Curso Outcome',
      dueDate: null,
      channel: 'whatsapp',
      confirm: true
    }))
    assert.equal(paymentResult.ok, true)
    assert.equal(paymentCtx.actions[0]?.outcome?.status, 'simulated')
    assert.equal(paymentCtx.actions[0]?.outcome?.wouldCreateAndSendLink, true)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('ctx.actions distingue un handoff real confirmado de un handoff fallido', async () => {
  const contactId = `outcome_handoff_${randomUUID()}`
  await db.run(
    'INSERT INTO contacts (id, phone, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
    [contactId, '+15555550456', 'handoff@example.com', 'Contacto Handoff', 'test']
  )
  try {
    const successCtx = {
      contactId,
      dryRun: false,
      actions: [],
      config: { objective: 'custom', successAction: 'none', goalWorkflow: {} }
    }
    const successTool = createConversationalTools(successCtx).find((item) => item.name === 'send_to_human')
    const success = await successTool.invoke(null, JSON.stringify({
      motivo: 'Necesita revisión',
      resumen: 'Handoff real de prueba'
    }))
    assert.equal(success.ok, true)
    assert.equal(successCtx.actions[0]?.outcome?.status, 'ok')
    assert.equal(successCtx.actions[0]?.outcome?.transferredToHuman, true)
    assert.equal(successCtx.actions[0]?.outcome?.actionCompleted, true)

    const failedCtx = {
      contactId: '',
      dryRun: false,
      actions: [],
      config: { objective: 'custom', successAction: 'none', goalWorkflow: {} }
    }
    const failedTool = createConversationalTools(failedCtx).find((item) => item.name === 'send_to_human')
    const failed = await failedTool.invoke(null, JSON.stringify({
      motivo: 'No hay contacto real',
      resumen: 'Debe fallar cerrado'
    }))
    assert.equal(failed.ok, false)
    assert.equal(failedCtx.actions[0]?.outcome?.status, 'error')
    assert.equal(failedCtx.actions[0]?.outcome?.ok, false)
    assert.equal(failedCtx.actions[0]?.outcome?.actionCompleted, false)
  } finally {
    await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
