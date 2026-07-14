import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildConversationalAppointmentTransitionEvents,
  buildRepeatedConversationalAppointmentQuestionEvent,
  buildSanitizedConversationalReplyTelemetry,
  classifyConversationalAppointmentQuestion,
  detectRepeatedConversationalAppointmentQuestion,
  extractAppointmentReadToolTelemetryActions,
  guardConversationalAppointmentReplyAgainstState,
  runConversationalAgentPreview,
  sanitizeAppointmentActionTelemetry
} from '../src/agents/conversational/runner.js'

const FORBIDDEN_KEYS = new Set([
  'replyPreview',
  'actions',
  'title',
  'name',
  'attendeeName',
  'phone',
  'email',
  'notes',
  'participants',
  'customerQuote',
  'visibleReply',
  'confirmationEvidence'
])

function collectKeys(value, result = []) {
  if (!value || typeof value !== 'object') return result
  if (Array.isArray(value)) {
    value.forEach((item) => collectKeys(item, result))
    return result
  }
  for (const [key, child] of Object.entries(value)) {
    result.push(key)
    collectKeys(child, result)
  }
  return result
}

function assertNoSensitiveTelemetry(value, secrets = []) {
  const serialized = JSON.stringify(value)
  for (const key of collectKeys(value)) {
    assert.equal(FORBIDDEN_KEYS.has(key), false, `la telemetría incluyó la llave sensible ${key}`)
  }
  for (const secret of secrets) {
    assert.equal(serialized.includes(secret), false, `la telemetría filtró ${secret}`)
  }
}

test('sanitizeAppointmentActionTelemetry conserva soporte útil sin PII y normaliza UTC', () => {
  const action = {
    type: 'book_appointment',
    calendarId: 'calendar_123',
    appointmentId: 'appointment_456',
    clientRequestId: 'request_789',
    startTime: '2026-07-16T10:30:00-06:00',
    endTime: '2026-07-16T11:15:00-06:00',
    title: 'Consulta privada de Patricia',
    attendeeName: 'Patricia Gómez',
    phone: '+526561234567',
    email: 'patricia@example.com',
    notes: 'Tiene una condición médica privada',
    participants: [{ name: 'Patricia Gómez', email: 'patricia@example.com' }],
    confirmationEvidence: {
      customerQuote: 'Sí, el jueves a las diez y media me queda perfecto'
    },
    outcome: {
      status: 'ok',
      code: 'appointment_created',
      controllerAttempts: 3,
      visibleReply: 'Listo Patricia, quedó agendada',
      appointmentId: 'appointment_456'
    }
  }
  const ctx = {
    contactId: 'contact_123',
    config: { id: 'agent_123' },
    channel: 'whatsapp',
    runtimeMode: 'tool_calling_v2',
    executionId: 'message_123',
    dryRun: false,
    appointmentOfferDecision: { active: true }
  }

  const detail = sanitizeAppointmentActionTelemetry(action, {
    ctx,
    observedAt: new Date('2026-07-14T18:00:00.000Z')
  })

  assert.equal(detail.tool, 'book_appointment')
  assert.equal(detail.outcome, 'ok')
  assert.equal(detail.code, 'appointment_created')
  assert.equal(detail.previousState, 'awaiting_slot_confirmation')
  assert.equal(detail.newState, 'appointment_booked')
  assert.equal(detail.mode, 'live')
  assert.equal(detail.calendarId, 'calendar_123')
  assert.equal(detail.clientRequestId, 'request_789')
  assert.equal(detail.appointmentId, 'appointment_456')
  assert.equal(detail.retryCount, 2)
  assert.equal(detail.startTimeUtc, '2026-07-16T16:30:00.000Z')
  assert.equal(detail.endTimeUtc, '2026-07-16T17:15:00.000Z')
  assert.equal(detail.observedAtUtc, '2026-07-14T18:00:00.000Z')
  assertNoSensitiveTelemetry(detail, [
    'Patricia',
    '+526561234567',
    'patricia@example.com',
    'condición médica',
    'jueves a las diez'
  ])
})

test('reply_sent guarda lista blanca y appointment_transition nunca serializa ctx.actions', () => {
  const ctx = {
    contactId: 'contact_reply',
    config: { id: 'agent_reply' },
    channel: 'whatsapp',
    runtimeMode: 'tool_calling_v2',
    executionId: 'message_reply',
    dryRun: true,
    actions: [{
      type: 'offer_appointment_slot',
      calendarId: 'calendar_reply',
      appointmentId: 'appointment_reply',
      startTime: '2026-07-17T09:00:00Z',
      visibleReply: 'Patricia, ¿te funciona el viernes a las nueve?',
      notes: 'No mostrar esta nota',
      participants: [{ email: 'patricia@example.com' }],
      outcome: {
        status: 'simulated',
        visibleReply: 'Patricia, ¿te funciona el viernes a las nueve?'
      }
    }]
  }
  const replyDetail = buildSanitizedConversationalReplyTelemetry({
    ctx,
    partCount: 1,
    pendingInboundCount: 0,
    aiProvider: 'openai',
    modelCallCount: 2
  })
  const transitions = buildConversationalAppointmentTransitionEvents({
    ctx,
    observedAt: new Date('2026-07-14T18:05:00.000Z')
  })

  assert.deepEqual(replyDetail.actionTypes, ['offer_appointment_slot'])
  assert.equal(replyDetail.appointmentActionCount, 1)
  assert.equal(replyDetail.mode, 'test')
  assert.equal(replyDetail.repeatedAppointmentQuestion, false)
  assert.equal(transitions.length, 1)
  assert.equal(transitions[0].eventType, 'appointment_transition')
  assert.equal(transitions[0].detail.newState, 'awaiting_slot_confirmation')
  assert.equal(transitions[0].detail.startTimeUtc, '2026-07-17T09:00:00.000Z')
  assertNoSensitiveTelemetry({ replyDetail, transitions }, [
    'Patricia',
    'patricia@example.com',
    'No mostrar esta nota',
    'viernes a las nueve'
  ])
})

test('un fallo técnico de get_free_slots queda observable sin conservar su mensaje de error', () => {
  const readActions = extractAppointmentReadToolTelemetryActions([{
    type: 'tool_call_output_item',
    rawItem: { type: 'function_call_result', name: 'get_free_slots', callId: 'call_slots_1' },
    output: {
      ok: false,
      availabilityCheckFailed: true,
      availabilityVerificationRequired: true,
      error: 'Falló el calendario privado de Patricia patricia@example.com'
    }
  }])
  const ctx = {
    contactId: 'contact_slots',
    config: { id: 'agent_slots' },
    channel: 'whatsapp',
    runtimeMode: 'tool_calling_v2',
    executionId: 'message_slots',
    dryRun: false,
    actions: [],
    appointmentSelectionProgress: {
      appointmentStatus: 'collecting_time',
      calendarId: 'calendar_slots',
      selectedDate: '2026-07-18',
      availabilityVerificationRequired: true
    }
  }
  const events = buildConversationalAppointmentTransitionEvents({
    ctx,
    appointmentReadActions: readActions,
    observedAt: new Date('2026-07-14T18:07:00.000Z')
  })

  assert.equal(events.length, 1)
  assert.equal(events[0].detail.tool, 'get_free_slots')
  assert.equal(events[0].detail.outcome, 'error')
  assert.equal(events[0].detail.code, 'availability_check_failed')
  assert.equal(events[0].detail.calendarId, 'calendar_slots')
  assert.equal(events[0].detail.previousState, 'collecting_time')
  assert.equal(events[0].detail.newState, 'availability_retry_required')
  assertNoSensitiveTelemetry(events, ['Patricia', 'patricia@example.com', 'Falló el calendario'])
})

test('detecta la misma pregunta de fecha por categoría sin persistir la conversación', () => {
  const ctx = {
    contactId: 'contact_loop',
    config: { id: 'agent_loop' },
    channel: 'whatsapp',
    runtimeMode: 'tool_calling_v2',
    executionId: 'message_loop',
    dryRun: false,
    appointmentSelectionProgress: {
      appointmentStatus: 'collecting_time',
      calendarId: 'calendar_loop',
      selectedDate: '2026-07-18',
      selectedTime: null,
      selectedTimezone: 'America/Ciudad_Juarez'
    },
    actions: []
  }
  const messages = [
    { id: 'assistant_1', role: 'assistant', content: 'Patricia, ¿qué fecha te gustaría para tu cita?' },
    { id: 'user_1', role: 'user', content: 'El sábado está perfecto, mi correo es patricia@example.com' }
  ]
  const reply = 'Perfecto Patricia. ¿Qué fecha te gustaría para la cita?'

  assert.deepEqual(classifyConversationalAppointmentQuestion(reply), ['date_request'])
  const detection = detectRepeatedConversationalAppointmentQuestion({ reply, messages, ctx })
  assert.deepEqual(detection.categories, ['date_request'])
  assert.equal(detection.repeatCount, 2)
  assert.deepEqual(detection.priorQuestionMessageIds, ['assistant_1'])
  assert.equal(detection.selectedDateKnown, true)
  assert.match(detection.questionPatternHash, /^[a-f0-9]{64}$/)

  const event = buildRepeatedConversationalAppointmentQuestionEvent({
    ctx,
    reply,
    messages,
    observedAt: new Date('2026-07-14T18:10:00.000Z')
  })
  assert.equal(event.eventType, 'loop_question_repeated')
  assert.equal(event.detail.code, 'repeated_appointment_question')
  assert.equal(event.detail.previousState, 'collecting_time')
  assert.equal(event.detail.newState, 'collecting_time')
  assert.equal(event.detail.calendarId, 'calendar_loop')
  assert.equal(event.detail.outcome, 'sent')
  assertNoSensitiveTelemetry(event, [
    'Patricia',
    'patricia@example.com',
    'qué fecha',
    'sábado está perfecto'
  ])
})

test('no marca loop cuando cambia de pedir fecha a pedir hora', () => {
  const detection = detectRepeatedConversationalAppointmentQuestion({
    reply: '¿A qué hora te gustaría venir?',
    messages: [{ id: 'assistant_date', role: 'assistant', content: '¿Qué fecha te gustaría?' }],
    ctx: { appointmentSelectionProgress: { appointmentStatus: 'collecting_time', selectedDate: '2026-07-18' } }
  })
  assert.equal(detection, null)
})

test('no confunde preguntas laterales de fechas u horas con el flujo de agenda', () => {
  for (const reply of [
    'El laboratorio maneja otro horario. ¿Qué día abre el laboratorio?',
    'Antes de tu estudio necesito confirmar algo: ¿a qué hora debes llegar en ayunas?',
    'La recepción te dará las instrucciones. ¿Cuál horario aparece en tu receta?',
    '¿Te funciona el medicamento por la mañana?',
    '¿Te queda alguna duda sobre mañana?',
    '¿Qué día fue tu última consulta?',
    '¿A qué hora fue tu última consulta?'
  ]) {
    assert.deepEqual(classifyConversationalAppointmentQuestion(reply), [], reply)
    const guarded = guardConversationalAppointmentReplyAgainstState({
      reply,
      ctx: {
        actions: [],
        appointmentSelectionProgress: {
          active: true,
          appointmentStatus: 'collecting_time',
          selectedDate: '2026-07-18',
          selectedTime: null
        }
      }
    })
    assert.equal(guarded.prevented, false, reply)
    assert.equal(guarded.reply, reply)
  }
})

test('reconoce las formas operativas cerradas y el imperativo exacto del loop reportado', () => {
  assert.deepEqual(
    classifyConversationalAppointmentQuestion('Conservé el día; dime la hora otra vez.'),
    ['time_request']
  )
  assert.deepEqual(
    classifyConversationalAppointmentQuestion('¿Para cuándo te agendo?'),
    ['date_request']
  )
  assert.deepEqual(
    classifyConversationalAppointmentQuestion('¿Qué fecha te gustaría para tu cita?'),
    ['date_request']
  )
  assert.deepEqual(
    classifyConversationalAppointmentQuestion('¿A qué hora quieres la cita?'),
    ['time_request']
  )
  assert.deepEqual(
    classifyConversationalAppointmentQuestion('¿Te funciona el martes a las 4?'),
    ['slot_confirmation']
  )
})

test('guard live reemplaza la fecha repetida por sólo la hora y registra prevented antes de entregar', () => {
  const ctx = {
    contactId: 'contact_guard_live',
    config: { id: 'agent_guard_live' },
    channel: 'whatsapp',
    runtimeMode: 'tool_calling_v2',
    executionId: 'message_guard_live',
    dryRun: false,
    actions: [],
    appointmentSelectionProgress: {
      active: true,
      appointmentStatus: 'collecting_time',
      calendarId: 'calendar_guard_live',
      selectedDate: '2026-07-18',
      selectedTime: null,
      selectedTimezone: 'America/Ciudad_Juarez'
    }
  }
  const guard = guardConversationalAppointmentReplyAgainstState({
    reply: 'Perfecto, ¿qué fecha te gustaría para la cita?',
    ctx
  })
  assert.equal(guard.prevented, true)
  assert.equal(guard.reason, 'selected_date_question_replaced')
  assert.match(guard.reply, /ya tengo guardado el día/i)
  assert.match(guard.reply, /qué hora/i)
  assert.doesNotMatch(guard.reply, /qué fecha/i)

  const event = buildRepeatedConversationalAppointmentQuestionEvent({
    ctx,
    reply: 'Perfecto, ¿qué fecha te gustaría para la cita?',
    prevention: guard,
    deliveryOutcome: 'prevented',
    observedAt: new Date('2026-07-14T18:12:00.000Z')
  })
  assert.equal(event.eventType, 'loop_question_repeated')
  assert.equal(event.detail.mode, 'live')
  assert.equal(event.detail.outcome, 'prevented')
  assert.equal(event.detail.preventionReason, 'selected_date_question_replaced')
  assert.equal(event.detail.replacementKind, 'time_only_question')
})

test('guard exige revalidar la misma fecha tras fallo técnico y no vuelve a pedir ningún dato', () => {
  const guard = guardConversationalAppointmentReplyAgainstState({
    reply: '¿A qué hora quieres la cita?',
    ctx: {
      actions: [],
      appointmentSelectionProgress: {
        active: true,
        appointmentStatus: 'collecting_time',
        selectedDate: '2026-07-18',
        availabilityVerificationRequired: true
      }
    }
  })
  assert.equal(guard.prevented, true)
  assert.equal(guard.reason, 'availability_revalidation_question_replaced')
  assert.match(guard.reply, /fecha sigue guardada/i)
  assert.match(guard.reply, /volver a revisar ese mismo día/i)
  assert.doesNotMatch(guard.reply, /qué fecha|qué hora/i)
})

test('guard awaiting_confirmation reconstruye la oferta durable y respeta un bubble canónico del turno', () => {
  const ctx = {
    dryRun: true,
    actions: [],
    appointmentOfferDecision: {
      active: true,
      purpose: 'book',
      localLabel: 'sábado 18 de julio a las 10:30',
      calendarId: 'calendar_offer_guard',
      appointmentId: 'appointment_offer_guard',
      startTime: '2026-07-18T16:30:00.000Z',
      timezone: 'America/Ciudad_Juarez'
    }
  }
  const guard = guardConversationalAppointmentReplyAgainstState({
    reply: '¿Qué fecha y a qué hora quieres venir?',
    ctx
  })
  assert.equal(guard.prevented, true)
  assert.equal(guard.reason, 'active_offer_question_replaced')
  assert.match(guard.reply, /sábado 18 de julio a las 10:30/i)
  assert.match(guard.reply, /te funciona/i)
  assert.doesNotMatch(guard.reply, /qué fecha|a qué hora/i)
  const event = buildRepeatedConversationalAppointmentQuestionEvent({
    ctx,
    reply: '¿Qué fecha y a qué hora quieres venir?',
    prevention: guard,
    deliveryOutcome: 'prevented',
    observedAt: new Date('2026-07-14T18:13:00.000Z')
  })
  assert.equal(event.detail.mode, 'test')
  assert.equal(event.detail.outcome, 'prevented')
  assert.equal(event.detail.tool, 'offer_appointment_slot')
  assert.equal(event.detail.calendarId, 'calendar_offer_guard')
  assert.equal(event.detail.appointmentId, 'appointment_offer_guard')
  assert.equal(event.detail.startTimeUtc, '2026-07-18T16:30:00.000Z')

  const serverReply = 'Tengo disponible el sábado 18 de julio a las 11:30. ¿Te funciona?'
  const aligned = guardConversationalAppointmentReplyAgainstState({
    reply: serverReply,
    ctx: {
      ...ctx,
      actions: [{
        type: 'offer_appointment_slot',
        visibleReply: serverReply,
        outcome: { status: 'simulated', visibleReply: serverReply }
      }]
    }
  })
  assert.equal(aligned.prevented, false)
  assert.equal(aligned.reply, serverReply)
})

test('guard no da falso positivo cuando el flujo correcto cambia de fecha a hora', () => {
  const guard = guardConversationalAppointmentReplyAgainstState({
    reply: 'Ya tengo el sábado. ¿A qué hora te gustaría venir?',
    ctx: {
      actions: [],
      appointmentSelectionProgress: {
        active: true,
        appointmentStatus: 'collecting_time',
        selectedDate: '2026-07-18',
        selectedTime: null
      }
    }
  })
  assert.equal(guard.prevented, false)
})

test('preview aplica el guard y registra prevented antes de devolver los globos', async () => {
  const recordedEvents = []
  const config = {
    id: 'agent_guard_preview',
    runtimeMode: 'tool_calling_v2',
    aiProvider: 'openai',
    model: 'fake-model',
    replyDelivery: { splitMessagesEnabled: false }
  }
  const result = await runConversationalAgentPreview({
    messages: [
      { id: 'user_date', role: 'user', content: 'El sábado me queda bien' }
    ],
    agentId: config.id,
    executionId: 'message_guard_preview',
    previewScopeId: 'scope_guard_preview'
  }, {
    resolvePreviewRuntimeConfig: async () => ({
      config,
      runtimeDefaults: { aiProvider: 'openai', model: 'fake-model' }
    }),
    resolveAIRuntime: async () => ({
      apiKey: 'stored-test-key-not-real',
      modelProvider: { kind: 'fake' },
      supportsMultimodalInputs: true
    }),
    hydratePreviewMessages: async (messages) => messages,
    runNativeTurn: async (args) => ({
      reply: 'Perfecto, ¿qué fecha te gustaría para la cita?',
      ctx: {
        contactId: args.contactId,
        config: args.config,
        dryRun: true,
        channel: args.channel,
        runtimeMode: 'tool_calling_v2',
        executionId: args.executionId,
        previewScopeId: args.previewScopeId,
        conversationMessages: args.messages,
        actions: [],
        appointmentSelectionProgress: {
          active: true,
          appointmentStatus: 'collecting_time',
          calendarId: 'calendar_guard_preview',
          selectedDate: '2026-07-18',
          selectedTime: null
        }
      },
      model: 'fake-model',
      runtimeMode: 'tool_calling_v2',
      modelCallCount: 1,
      historyTelemetry: args.historyEnvelope.telemetry,
      capabilityManifest: [],
      validationErrors: []
    }),
    recordEvent: async (event) => {
      recordedEvents.push(event)
    }
  })

  assert.match(result.reply, /ya tengo guardado el día/i)
  assert.match(result.reply, /qué hora/i)
  assert.doesNotMatch(result.reply, /qué fecha/i)
  assert.deepEqual(result.replyParts, [result.reply])
  const loopEvent = recordedEvents.find((event) => event.eventType === 'loop_question_repeated')
  assert.ok(loopEvent)
  assert.equal(loopEvent.detail.mode, 'test')
  assert.equal(loopEvent.detail.outcome, 'prevented')
  assert.equal(loopEvent.detail.preventionReason, 'selected_date_question_replaced')
})
