import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { createConversationalTools } from '../src/agents/conversational/tools.js'
import { revalidateAppointmentSlot } from '../src/agents/conversational/actionEvidence.js'

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

test('create_payment_link rechaza un monto distinto a la capacidad blindada', async () => {
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
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [{
          id: 'collect_payment',
          enabled: true,
          paymentMode: 'deposit',
          currency: 'USD',
          deposit: {
            enabled: true,
            mode: 'fixed',
            amount: 100,
            currency: 'USD',
            methods: { paymentLink: true, bankTransfer: false }
          }
        }]
      }
    }
  }

  const tool = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
  const result = await tool.invoke(null, JSON.stringify({
    quantity: 1,
    agreedAmount: 175
  }))

  assert.equal(result.ok, false)
  assert.equal(result.amountMismatch, true)
  assert.equal(result.actionCompleted, false)
  assert.match(result.error, /no coincide/i)
  assert.match(result.error, /No se creó ningún link/)
  assert.equal(ctx.actions.length, 0)
})

test('ctx.actions registra outcomes verificables para objetivo, links, pago y handoff', async () => {
  const internalCtx = {
    contactId: `outcome_internal_${randomUUID()}`,
    dryRun: true,
    actions: [],
    config: {
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'handoff_human', enabled: true },
          { id: 'custom_goal', enabled: true, description: 'Meta de prueba', completion: 'handoff' }
        ]
      }
    }
  }
  const internalTools = createConversationalTools(internalCtx)
  const markReady = internalTools.find((item) => item.name === 'mark_ready_to_advance')
  const handoff = internalTools.find((item) => item.name === 'send_to_human')

  await markReady.invoke(null, JSON.stringify({
    intencionDetectada: 'Meta cumplida en simulación',
    resumen: 'Resumen de prueba',
    urgencia: 'media',
    siguientePaso: 'Revisar',
    confirm: true
  }))
  await handoff.invoke(null, JSON.stringify({ motivo: 'Revisión humana', resumen: 'Caso de prueba' }))

  assert.deepEqual(
    internalCtx.actions.map((action) => [action.type, action.outcome?.status]),
    [
      ['mark_ready_to_advance', 'simulated'],
      ['send_to_human', 'simulated']
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
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          {
            id: 'send_link',
            enabled: true,
            linkKind: 'verified_goal',
            url: 'https://agenda.example/reservar',
            trackingParam: 'goal_id'
          },
          {
            id: 'custom_goal',
            enabled: true,
            description: 'Completar la reservación externa',
            completion: 'send_link'
          }
        ]
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
      capabilitiesConfig: {
        schemaVersion: 1,
        items: [
          { id: 'send_link', enabled: true, linkKind: 'trigger', url: 'https://links.example/continuar' },
          { id: 'custom_goal', enabled: true, description: 'Enviar recurso', completion: 'send_link' }
        ]
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
        capabilitiesConfig: {
          schemaVersion: 1,
          items: [{
            id: 'collect_payment',
            enabled: true,
            paymentMode: 'deposit',
            currency: 'USD',
            deposit: {
              enabled: true,
              mode: 'fixed',
              amount: 100,
              currency: 'USD',
              methods: { paymentLink: true, bankTransfer: false }
            }
          }]
        }
      }
    }
    const paymentTool = createConversationalTools(paymentCtx).find((item) => item.name === 'create_payment_link')
    const paymentResult = await paymentTool.invoke(null, JSON.stringify({
      quantity: 1,
      agreedAmount: null
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
      config: {
        capabilitiesConfig: {
          schemaVersion: 1,
          items: [{ id: 'handoff_human', enabled: true }]
        }
      }
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
      config: {
        capabilitiesConfig: {
          schemaVersion: 1,
          items: [{ id: 'handoff_human', enabled: true }]
        }
      }
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
