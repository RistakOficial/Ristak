import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, databaseReady } from '../src/config/database.js'
import {
  __conversationalToolsTestHooks,
  buildNativeFreeSlotDays,
  createConversationalTools,
  setNativeHandoffAfterAssignmentHookForTest,
  setPreventiveMutationFenceHookForTest
} from '../src/agents/conversational/tools.js'
import { buildNativeConversationalInstructions } from '../src/agents/conversational/nativePrompt.js'
import {
  applyConversationalAgentPreventiveMeasure,
  getActiveConversationalAgentPreventiveMeasure
} from '../src/services/conversationalAgentSafetyService.js'
import { getConversationState } from '../src/services/conversationalAgentService.js'
import { ensureToolCallingV2VisibleReply } from '../src/agents/conversational/runner.js'
import { getAccountTimezone } from '../src/utils/dateUtils.js'
import { upsertLocalCalendar } from '../src/services/localCalendarService.js'

await databaseReady

function uniquePhone() {
  return `+521${String(Math.floor(Math.random() * 10_000_000_000)).padStart(10, '0')}`
}

function buildContext(contactId, fields, { items = [], policy = 'replace_placeholders', dryRun = false } = {}) {
  const capabilitiesConfig = {
    schemaVersion: 2,
    dataRequirements: {
      enabled: true,
      fields,
      updateContact: { enabled: true, policy },
      participants: {
        enabled: false,
        allowPrimaryAttendeeDifferentFromRequester: true,
        guestFields: ['name'],
        maxGuests: 10
      }
    },
    items
  }
  return {
    runtimeMode: 'tool_calling_v2',
    contactId,
    agentId: `agent_contact_data_${randomUUID()}`,
    executionId: `message_contact_data_${randomUUID()}`,
    channel: 'whatsapp',
    dryRun,
    followUpMode: false,
    actions: [],
    accountLocale: { currency: 'MXN' },
    capabilitiesConfig,
    config: { id: `agent_contact_data_${randomUUID()}`, capabilitiesConfig }
  }
}

function contactDataPayload(overrides = {}) {
  return {
    fullName: null,
    phone: null,
    alternatePhone: null,
    email: null,
    company: null,
    address: null,
    customValues: null,
    confirmedReplacement: false,
    ...overrides
  }
}

function temporarySafetyPolicy() {
  return {
    id: 'conversational-default-prevention',
    version: '2',
    quarantine: { mode: 'temporary', durationMinutes: 15 },
    notification: { enabled: false, audience: 'account_admins' }
  }
}

async function cleanupSafetyContact(contactId) {
  await db.run(
    `DELETE FROM conversational_agent_safety_audit
     WHERE case_id IN (SELECT id FROM conversational_agent_safety_cases WHERE contact_id = ?)`,
    [contactId]
  ).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_safety_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_safety_cases WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_events WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM conversational_agent_state WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('nombres genéricos de canal y teléfonos no cuentan como identidad confirmada', () => {
  const placeholders = [
    'Usuario de WhatsApp',
    'Usuario WhatsApp',
    'WhatsApp User',
    'Usuario de Instagram',
    'Usuario de Facebook',
    'Usuario de Messenger',
    '6567426612',
    '+52 (656) 742-6612'
  ]
  const dataRequirements = {
    enabled: true,
    fields: [{ field: 'full_name', level: 'required', scope: 'appointment' }]
  }

  for (const fullName of placeholders) {
    assert.equal(__conversationalToolsTestHooks.isPlaceholderContactName(fullName), true, fullName)
    const validation = __conversationalToolsTestHooks.assertRequiredContactData({
      scope: 'appointment',
      contact: { id: 'contact_placeholder', full_name: fullName },
      dataRequirements
    })
    assert.equal(validation.ok, false, fullName)
    assert.deepEqual(validation.requiredFields, [{ field: 'full_name', label: 'nombre completo' }])
  }

  assert.equal(__conversationalToolsTestHooks.isPlaceholderContactName('Paty Jiménez'), false)
  const participant = __conversationalToolsTestHooks.buildAppointmentParticipant({
    contact: { full_name: 'Raúl Gómez' },
    title: null,
    notes: 'Dolor de rodilla',
    attendeeName: null,
    attendeeContext: null,
    primaryAttendee: { name: 'Paty Jiménez', relation: 'mamá' }
  })
  assert.match(participant.title, /Paty Jiménez/)
  assert.match(participant.notes, /Raúl Gómez/)
  assert.match(participant.notes, /mamá/)
  assert.equal(participant.attendeeName, 'Paty Jiménez')
})

test('una condición sólo bloquea cuando el hecho estructurado ocurre de verdad', () => {
  const dataRequirements = {
    enabled: true,
    fields: [{
      field: 'email',
      level: 'conditional',
      scope: 'appointment',
      condition: {
        fact: 'appointment.primary_attendee_is_different',
        operator: 'is_true',
        value: true
      }
    }]
  }
  const contact = { id: 'contact_conditional', full_name: 'Raúl Gómez', email: null }

  const inactive = __conversationalToolsTestHooks.assertRequiredContactData({
    scope: 'appointment',
    contact,
    dataRequirements,
    facts: { 'appointment.primary_attendee_is_different': false }
  })
  assert.equal(inactive.ok, true)

  const active = __conversationalToolsTestHooks.assertRequiredContactData({
    scope: 'appointment',
    contact,
    dataRequirements,
    facts: { 'appointment.primary_attendee_is_different': true }
  })
  assert.equal(active.ok, false)
  assert.equal(active.needsData, true)
  assert.deepEqual(active.requiredFields, [{ field: 'email', label: 'correo' }])

  const freeTextCondition = __conversationalToolsTestHooks.assertRequiredContactData({
    scope: 'appointment',
    contact,
    dataRequirements: {
      ...dataRequirements,
      fields: [{ ...dataRequirements.fields[0], condition: 'cuando parezca necesario' }]
    },
    facts: { 'appointment.primary_attendee_is_different': true }
  })
  assert.equal(freeTextCondition.ok, true)
})

test('los campos configurados de participantes aplican al titular distinto y a invitados, sin fallback oculto', () => {
  const contact = {
    id: 'requester_contact',
    full_name: 'Raúl Gómez',
    phone: '+526561111111',
    email: 'raul@example.com'
  }
  const configured = {
    participants: {
      enabled: true,
      guestFields: ['name', 'email'],
      maxGuests: 10
    }
  }

  const missingPrimary = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: { name: 'Paty Jiménez', phone: null, email: null, relation: 'mamá' },
    requirements: configured
  })
  assert.equal(missingPrimary.ok, false)
  assert.match(missingPrimary.error, /titular distinto.*email/i)

  const missingGuest = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: {
      name: 'Paty Jiménez',
      email: 'paty@example.com',
      emailSourceQuote: 'El correo de Paty es paty@example.com',
      phone: null,
      relation: 'mamá'
    },
    guests: [{ name: 'Luis', phone: null, email: null, relation: 'hijo' }],
    conversationMessages: [{ role: 'user', content: 'El correo de Paty es paty@example.com' }],
    requirements: configured
  })
  assert.equal(missingGuest.ok, false)
  assert.match(missingGuest.error, /invitado.*email/i)

  const noConfiguredFallback = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: { name: null, phone: null, email: null, relation: 'mamá' },
    guests: [{ name: null, phone: null, email: null, relation: 'hijo' }],
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(noConfiguredFallback.ok, true)
  assert.equal(noConfiguredFallback.primary.relation, 'mamá')
  assert.equal(noConfiguredFallback.guests[0].relation, 'hijo')

  const invalidPrimaryPhone = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: { name: 'Paty Jiménez', phone: '123', relation: 'mamá' },
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(invalidPrimaryPhone.ok, false)
  assert.match(invalidPrimaryPhone.error, /titular.*7 y 15 dígitos/i)

  const invalidRequesterAsPrimary = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact: { ...contact, phone: '123' },
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(invalidRequesterAsPrimary.ok, false)
  assert.match(invalidRequesterAsPrimary.error, /titular.*7 y 15 dígitos/i)

  const invalidGuestPhone = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    guests: [{ name: 'Luis', phone: 'teléfono pendiente', relation: 'hijo' }],
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(invalidGuestPhone.ok, false)
  assert.match(invalidGuestPhone.error, /invitado.*7 y 15 dígitos/i)

  const forbiddenDifferentPrimary = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: { name: 'Paty Jiménez', phone: '+526567426612', relation: 'mamá' },
    requirements: {
      participants: {
        enabled: true,
        allowPrimaryAttendeeDifferentFromRequester: false,
        guestFields: [],
        maxGuests: 2
      }
    }
  })
  assert.equal(forbiddenDifferentPrimary.ok, false)
  assert.match(forbiddenDifferentPrimary.error, /no permite agendar para un titular distinto/i)
  assert.match(forbiddenDifferentPrimary.error, /primaryAttendee en null/i)

  const tooManyGuests = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    guests: [{ name: 'Uno' }, { name: 'Dos' }, { name: 'Tres' }],
    requirements: {
      participants: {
        enabled: false,
        allowPrimaryAttendeeDifferentFromRequester: true,
        guestFields: [],
        maxGuests: 2
      }
    }
  })
  assert.equal(tooManyGuests.ok, false)
  assert.match(tooManyGuests.error, /máximo 2 invitados/i)
  assert.match(tooManyGuests.error, /recibí 3/i)
  assert.match(tooManyGuests.error, /no se omitió ni truncó/i)

  const exactGuestLimit = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    guests: [{ name: 'Uno' }, { name: 'Dos' }],
    requirements: {
      participants: {
        enabled: false,
        allowPrimaryAttendeeDifferentFromRequester: false,
        guestFields: [],
        maxGuests: 2
      }
    }
  })
  assert.equal(exactGuestLimit.ok, true)
  assert.equal(exactGuestLimit.guests.length, 2)
  assert.equal(exactGuestLimit.primary.contactId, contact.id)

  const normalizedPhones = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '(656) 742-6612',
      phoneSourceQuote: 'Para Paty usa el (656) 742-6612',
      relation: 'mamá'
    },
    guests: [{
      name: 'Luis',
      phone: '+52 656 111 2233',
      phoneSourceQuote: 'Luis usa el +52 656 111 2233',
      relation: 'hijo'
    }],
    conversationMessages: [
      { role: 'user', content: 'Para Paty usa el (656) 742-6612' },
      { role: 'user', content: 'Luis usa el +52 656 111 2233' }
    ],
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(normalizedPhones.ok, true)
  assert.equal(normalizedPhones.primary.phone.replace(/\D/g, ''), '526567426612')
  assert.equal(normalizedPhones.guests[0].phone.replace(/\D/g, ''), '526561112233')
})

test('titular distinto e invitados nunca heredan teléfono o correo del solicitante sin evidencia literal', () => {
  const contact = {
    id: 'requester_identity_guard',
    full_name: 'Raúl Gómez',
    phone: '+526561111111',
    email: 'raul@example.com'
  }
  const copiedWithoutEvidence = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+52 656 111 1111',
      email: 'raul@example.com',
      relation: 'mamá'
    },
    guests: [{
      name: 'Luis',
      phone: '+526561111111',
      email: 'raul@example.com',
      relation: 'hermano'
    }],
    conversationMessages: [
      { role: 'user', content: 'La cita es para mi mamá Paty y también irá Luis' }
    ],
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(copiedWithoutEvidence.ok, true)
  assert.equal(copiedWithoutEvidence.requester.email, 'raul@example.com')
  assert.equal(copiedWithoutEvidence.requester.phone.replace(/\D/g, ''), '526561111111')
  assert.equal(copiedWithoutEvidence.primary.email, '')
  assert.equal(copiedWithoutEvidence.primary.phone, '')
  assert.equal(copiedWithoutEvidence.guests[0].email, '')
  assert.equal(copiedWithoutEvidence.guests[0].phone, '')

  const requiredCopiedValue = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: { name: 'Paty Jiménez', email: 'raul@example.com', relation: 'mamá' },
    conversationMessages: [{ role: 'user', content: 'La cita es para Paty' }],
    requirements: { participants: { enabled: true, guestFields: ['name', 'email'], maxGuests: 10 } }
  })
  assert.equal(requiredCopiedValue.ok, false)
  assert.match(requiredCopiedValue.error, /titular distinto.*email/i)

  const explicitlyShared = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: 'Para Paty usa raul@example.com y el 656 111 1111',
      email: 'raul@example.com',
      emailSourceQuote: 'Para Paty usa raul@example.com y el 656 111 1111',
      relation: 'mamá'
    },
    conversationMessages: [
      { role: 'assistant', content: '¿Qué datos uso para Paty?' },
      { role: 'user', content: 'Para Paty usa raul@example.com y el 656 111 1111' }
    ],
    requirements: { participants: { enabled: true, guestFields: ['name', 'email', 'phone'], maxGuests: 10 } }
  })
  assert.equal(explicitlyShared.ok, true)
  assert.equal(explicitlyShared.primary.email, 'raul@example.com')
  assert.equal(explicitlyShared.primary.phone.replace(/\D/g, ''), '526561111111')

  const dispersedDigitsAndPartialEmail = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: 'El folio 52656 y luego 1111111 no es un teléfono',
      email: 'raul@example.com',
      emailSourceQuote: 'Mi otro correo es notraul@example.com.mx',
      relation: 'mamá'
    },
    conversationMessages: [
      { role: 'user', content: 'El folio 52656 y luego 1111111 no es un teléfono' },
      { role: 'user', content: 'Mi otro correo es notraul@example.com.mx' },
      { role: 'assistant', content: 'Para Paty usa raul@example.com y +52 656 111 1111' }
    ],
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(dispersedDigitsAndPartialEmail.ok, true)
  assert.equal(dispersedDigitsAndPartialEmail.primary.phone, '')
  assert.equal(dispersedDigitsAndPartialEmail.primary.email, '')

  const assistantIsNeverEvidence = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact,
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: 'Para Paty usa raul@example.com y el 656 111 1111',
      email: 'raul@example.com',
      emailSourceQuote: 'Para Paty usa raul@example.com y el 656 111 1111',
      relation: 'mamá'
    },
    conversationMessages: [
      { role: 'assistant', content: 'Para Paty usa raul@example.com y el 656 111 1111' }
    ],
    requirements: { participants: { enabled: false, guestFields: [], maxGuests: 10 } }
  })
  assert.equal(assistantIsNeverEvidence.ok, true)
  assert.equal(assistantIsNeverEvidence.primary.phone, '')
  assert.equal(assistantIsNeverEvidence.primary.email, '')
})

test('la evidencia literal de participante puede vivir en el historial omitido', async () => {
  const sourceQuote = 'Para Paty usa paty@example.com y el 656 111 1111'
  const historyCalls = []
  const ctx = {
    conversationMessages: [{ role: 'user', content: 'sí, ese horario está bien' }],
    loadConversationHistoryPage: async (request) => {
      historyCalls.push(request)
      return {
        ok: true,
        messages: [{ role: 'inbound', content: sourceQuote }],
        hasMore: false,
        nextCursor: null
      }
    }
  }
  const evidenceMessages = await __conversationalToolsTestHooks.resolveAppointmentParticipantEvidenceMessages({
    ctx,
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: sourceQuote,
      email: 'paty@example.com',
      emailSourceQuote: sourceQuote,
      relation: 'mamá'
    }
  })
  const participants = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact: {
      id: 'requester_history_guard',
      full_name: 'Raúl Gómez',
      phone: '+526567426612',
      email: 'raul@example.com'
    },
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: sourceQuote,
      email: 'paty@example.com',
      emailSourceQuote: sourceQuote,
      relation: 'mamá'
    },
    conversationMessages: evidenceMessages,
    requirements: { participants: { enabled: true, guestFields: ['name', 'phone', 'email'], maxGuests: 10 } }
  })
  assert.equal(participants.ok, true)
  assert.equal(participants.primary.phone, '+526561111111')
  assert.equal(participants.primary.email, 'paty@example.com')
  assert.equal(historyCalls.length, 1)
  assert.equal(historyCalls[0].query, '656 111 1111')

  const fallbackCalls = []
  const fallbackMessages = await __conversationalToolsTestHooks.resolveAppointmentParticipantEvidenceMessages({
    ctx: {
      conversationMessages: [],
      historyContext: { telemetry: { omittedMessages: 1 } },
      loadConversationHistoryPage: async (request) => {
        fallbackCalls.push(request)
        if (request.mode === 'search') {
          return { ok: true, messages: [], hasMore: false, nextCursor: null }
        }
        return {
          ok: true,
          messages: [{ role: 'user', content: sourceQuote }],
          hasMore: false,
          nextCursor: null
        }
      }
    },
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: sourceQuote,
      email: null,
      emailSourceQuote: null,
      relation: 'mamá'
    }
  })
  const fallbackParticipants = __conversationalToolsTestHooks.buildAppointmentParticipants({
    contact: { id: 'requester_fallback_guard', full_name: 'Raúl', phone: '+526567426612' },
    primaryAttendee: {
      name: 'Paty Jiménez',
      phone: '+526561111111',
      phoneSourceQuote: sourceQuote,
      email: null,
      emailSourceQuote: null,
      relation: 'mamá'
    },
    conversationMessages: fallbackMessages,
    requirements: { participants: { enabled: true, guestFields: ['name', 'phone'], maxGuests: 10 } }
  })
  assert.equal(fallbackParticipants.ok, true)
  assert.deepEqual(fallbackCalls.map((call) => call.mode), ['search', 'oldest'])
})

test('prompt blindado respeta titular distinto apagado y límite de invitados sin truncado', () => {
  const instructions = buildNativeConversationalInstructions({
    capabilitiesConfig: {
      schemaVersion: 2,
      dataRequirements: {
        enabled: true,
        fields: [],
        participants: {
          enabled: true,
          allowPrimaryAttendeeDifferentFromRequester: false,
          guestFields: ['name'],
          maxGuests: 2
        }
      },
      items: [{ id: 'schedule_appointment', enabled: true, calendarId: 'calendar-test', bookingOwner: 'ai' }]
    },
    capabilityManifest: [{
      id: 'schedule_appointment',
      label: 'Agendar cita',
      enabled: true,
      ready: true,
      summary: 'Calendario configurado',
      missingConfiguration: []
    }]
  })

  assert.match(instructions, /no permite un titular distinto/i)
  assert.match(instructions, /primaryAttendee y attendeeName en null/i)
  assert.match(instructions, /máximo 2 invitados/i)
  assert.match(instructions, /no omitas ni trunques/i)
})

test('tools de agenda rechazan titular distinto y exceso de invitados antes de cualquier cita', async () => {
  const calendarId = `calendar_participant_policy_${randomUUID()}`
  const timezone = await getAccountTimezone()
  const baseDay = DateTime.now().setZone(timezone).plus({ days: 30 }).startOf('day')
  const slot = baseDay.set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
  const selectedStartTime = slot.toUTC().toISO()
  const localLabel = buildNativeFreeSlotDays([{
    date: slot.toISODate(),
    timezone,
    slots: [selectedStartTime]
  }], timezone)[0].options[0].localLabel
  const baseCapabilities = {
    schemaVersion: 2,
    safetyPolicy: { enabled: false },
    dataRequirements: {
      enabled: true,
      fields: [],
      participants: {
        enabled: true,
        allowPrimaryAttendeeDifferentFromRequester: false,
        guestFields: [],
        maxGuests: 2
      }
    },
    items: [{
      id: 'schedule_appointment',
      enabled: true,
      calendarId,
      bookingOwner: 'ai',
      allowOverlaps: false,
      handoffUserId: '',
      handoffUserName: ''
    }]
  }
  await upsertLocalCalendar({
    id: calendarId,
    locationId: `location_participant_policy_${randomUUID()}`,
    name: 'Calendario política',
    source: 'ristak',
    slotDuration: 60,
    slotInterval: 60,
    openHours: [{
      daysOfTheWeek: [slot.weekday],
      hours: [{ openHour: 10, openMinute: 0, closeHour: 11, closeMinute: 0 }]
    }]
  }, { source: 'ristak', syncStatus: 'synced' })
  try {
    const buildTools = async (capabilitiesConfig) => {
      const suffix = randomUUID()
      const agentId = `agent_participant_policy_${suffix}`
      const offerExecutionId = `offer_participant_policy_${suffix}`
      const executionId = `message_participant_policy_${suffix}`
      const ctx = {
      runtimeMode: 'tool_calling_v2',
      contactId: `virtual_contact_${suffix}`,
      agentId,
      executionId: offerExecutionId,
      dryRun: true,
      channel: 'whatsapp',
      previewScopeId: `appointment_preview_${createHash('sha256').update(suffix).digest('hex').slice(0, 48)}`,
      followUpMode: false,
      actions: [],
      conversationMessages: [{ id: `opening_${suffix}`, role: 'user', content: 'quiero agendar' }],
      virtualContact: {
        fullName: 'Raúl Gómez',
        phone: '+526561111111',
        email: 'raul@example.com'
      },
      capabilitiesConfig,
      config: { id: agentId, runtimeMode: 'tool_calling_v2', capabilitiesConfig }
      }
      const offered = await createConversationalTools(ctx)
        .find((tool) => tool.name === 'offer_appointment_slot')
        .invoke(null, JSON.stringify({ startTime: selectedStartTime }))
      assert.equal(offered.ok, true, JSON.stringify(offered))
      ctx.actions = []
      ctx.executionId = executionId
      ctx.conversationMessages = [
        { id: `offer_visible_${suffix}`, role: 'assistant', content: offered.visibleReply },
        { id: executionId, role: 'user', content: 'sí, ese horario está bien' }
      ]
      return createConversationalTools(ctx)
    }

    const book = (await buildTools(baseCapabilities)).find((tool) => tool.name === 'book_appointment')
    assert.ok(book)
    const forbiddenPrimary = await book.invoke(null, JSON.stringify({
      startTime: selectedStartTime,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime,
        customerQuote: 'sí, ese horario está bien',
        assistantOfferQuote: localLabel
      },
      title: null,
      notes: null,
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: { name: 'Paty Jiménez', phone: null, email: null, relation: 'mamá' },
      guests: []
    }))
    assert.equal(forbiddenPrimary.ok, false)
    assert.match(forbiddenPrimary.error, /no permite agendar para un titular distinto/i)

    const tooManyGuests = await book.invoke(null, JSON.stringify({
      startTime: selectedStartTime,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime,
        customerQuote: 'sí, ese horario está bien',
        assistantOfferQuote: localLabel
      },
      title: null,
      notes: null,
      attendeeName: null,
      attendeeContext: null,
      primaryAttendee: null,
      guests: [
        { name: 'Uno', phone: null, email: null, relation: null },
        { name: 'Dos', phone: null, email: null, relation: null },
        { name: 'Tres', phone: null, email: null, relation: null }
      ]
    }))
    assert.equal(tooManyGuests.ok, false)
    assert.match(tooManyGuests.error, /máximo 2 invitados/i)
    assert.match(tooManyGuests.error, /no se omitió ni truncó/i)

    const humanCapabilities = {
      ...baseCapabilities,
      items: [{ ...baseCapabilities.items[0], bookingOwner: 'human', handoffUserId: '7', handoffUserName: 'Mariana' }]
    }
    const requestHuman = (await buildTools(humanCapabilities)).find((tool) => tool.name === 'request_human_booking')
    assert.ok(requestHuman)
    const forbiddenHumanPrimary = await requestHuman.invoke(null, JSON.stringify({
      startTime: selectedStartTime,
      selectionEvidence: {
        selectionMode: 'accepted_prior_offer',
        selectedStartTime,
        customerQuote: 'sí, ese horario está bien',
        assistantOfferQuote: localLabel
      },
      title: null,
      notes: null,
      attendeeName: 'Paty Jiménez',
      attendeeContext: 'mamá',
      primaryAttendee: null,
      guests: []
    }))
    assert.equal(forbiddenHumanPrimary.ok, false)
    assert.match(forbiddenHumanPrimary.error, /no permite agendar para un titular distinto/i)
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  }
})

test('save_contact_data sólo guarda campos autorizados y valida teléfono/correo', async () => {
  const contactId = `contact_data_${randomUUID()}`
  const phone = uniquePhone()
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Usuario de WhatsApp', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, phone]
  )

  try {
    const nameContext = buildContext(contactId, [{
      field: 'full_name',
      level: 'required',
      scope: 'appointment'
    }])
    const nameTool = createConversationalTools(nameContext).find((item) => item.name === 'save_contact_data')
    assert.ok(nameTool)

    const unauthorized = await nameTool.invoke(null, JSON.stringify(contactDataPayload({
      fullName: 'Paty Jiménez',
      customValues: [{ key: 'vip_secret', value: 'sí' }]
    })))
    assert.equal(unauthorized.ok, false)
    assert.match(unauthorized.error, /no están autorizados/i)
    assert.equal((await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId])).full_name, 'Usuario de WhatsApp')

    const saved = await nameTool.invoke(null, JSON.stringify(contactDataPayload({ fullName: 'Raúl Gómez' })))
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.changedFields, ['full_name'])
    assert.equal((await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId])).full_name, 'Raúl Gómez')

    const emailContext = buildContext(contactId, [{
      field: 'email',
      level: 'required',
      scope: 'payment'
    }])
    const emailTool = createConversationalTools(emailContext).find((item) => item.name === 'save_contact_data')
    const invalidEmail = await emailTool.invoke(null, JSON.stringify(contactDataPayload({ email: 'no-es-correo' })))
    assert.equal(invalidEmail.ok, false)
    assert.match(invalidEmail.error, /formato válido/i)
    assert.equal((await db.get('SELECT email FROM contacts WHERE id = ?', [contactId])).email, null)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('save_contact_data no se expone cuando Datos requeridos está apagado', () => {
  const capabilitiesConfig = {
    schemaVersion: 2,
    dataRequirements: {
      enabled: false,
      fields: [],
      updateContact: { enabled: true, policy: 'replace_placeholders' },
      participants: { enabled: false, guestFields: ['name'], maxGuests: 10 }
    },
    items: []
  }
  const tools = createConversationalTools({
    runtimeMode: 'tool_calling_v2',
    contactId: `contact_disabled_${randomUUID()}`,
    dryRun: true,
    followUpMode: false,
    actions: [],
    capabilitiesConfig,
    config: { capabilitiesConfig }
  })
  assert.equal(tools.some((item) => item.name === 'save_contact_data'), false)
})

test('un dato obligatorio bloquea el cobro hasta quedar confirmado en la ficha', async () => {
  const contactId = `contact_required_payment_${randomUUID()}`
  const phone = uniquePhone()
  const email = `cliente.${randomUUID()}@example.com`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Cliente Prueba', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, phone]
  )
  const fields = [{ field: 'email', level: 'required', scope: 'payment' }]
  const items = [{
    id: 'collect_payment',
    enabled: true,
    paymentMode: 'full_payment',
    chargeType: 'direct',
    gateway: 'stripe',
    currency: 'MXN',
    direct: { amount: 1200, currency: 'MXN', concept: 'Consulta inicial', description: '' },
    installments: { enabled: false, maxInstallments: 0 },
    expirationMinutes: 60,
    afterPayment: 'continue',
    receiptProof: { enabled: true, disposition: 'pending_review' },
    deposit: { enabled: false, methods: { paymentLink: true, bankTransfer: false } }
  }]
  const ctx = buildContext(contactId, fields, { items, dryRun: true })
  try {
    const paymentTool = createConversationalTools(ctx).find((item) => item.name === 'create_payment_link')
    const blocked = await paymentTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.needsData, true)
    assert.deepEqual(blocked.requiredFields, [{ field: 'email', label: 'correo' }])

    const saveTool = createConversationalTools({ ...ctx, dryRun: false })
      .find((item) => item.name === 'save_contact_data')
    const saved = await saveTool.invoke(null, JSON.stringify(contactDataPayload({ email })))
    assert.equal(saved.ok, true)

    const allowed = await paymentTool.invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    assert.equal(allowed.simulated, true)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('create_payment_link aplica la condición factual del tipo de cobro en el servidor', async () => {
  const contactId = `contact_conditional_payment_${randomUUID()}`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Cliente Condicional', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, uniquePhone()]
  )
  const paymentItem = {
    id: 'collect_payment',
    enabled: true,
    paymentMode: 'full_payment',
    chargeType: 'direct',
    gateway: 'stripe',
    currency: 'MXN',
    direct: { amount: 1200, currency: 'MXN', concept: 'Consulta inicial', description: '' },
    installments: { enabled: false, maxInstallments: 0 },
    expirationMinutes: 60,
    afterPayment: 'continue',
    receiptProof: { enabled: false, disposition: 'pending_review' },
    deposit: { enabled: false, methods: { paymentLink: true, bankTransfer: false } }
  }
  const condition = (fact) => ({ fact, operator: 'is_true', value: true })
  try {
    const fullPaymentContext = buildContext(contactId, [{
      field: 'email',
      level: 'conditional',
      scope: 'payment',
      condition: condition('payment.is_full_payment')
    }], { items: [paymentItem], dryRun: true })
    const blocked = await createConversationalTools(fullPaymentContext)
      .find((item) => item.name === 'create_payment_link')
      .invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(blocked.needsData, true)
    assert.deepEqual(blocked.requiredFields, [{ field: 'email', label: 'correo' }])

    const depositOnlyContext = buildContext(contactId, [{
      field: 'email',
      level: 'conditional',
      scope: 'payment',
      condition: condition('payment.is_deposit')
    }], { items: [paymentItem], dryRun: true })
    const allowed = await createConversationalTools(depositOnlyContext)
      .find((item) => item.name === 'create_payment_link')
      .invoke(null, JSON.stringify({ quantity: 1, agreedAmount: null }))
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    assert.equal(allowed.simulated, true)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('un booleano del modelo nunca reemplaza una identidad válida distinta', async () => {
  const contactId = `contact_identity_guard_${randomUUID()}`
  const phone = uniquePhone()
  const replacementPhone = uniquePhone()
  const currentEmail = `raul.${randomUUID()}@example.com`
  await db.run(
    `INSERT INTO contacts (id, full_name, first_name, last_name, phone, email, created_at, updated_at)
     VALUES (?, 'Raúl Gómez', 'Raúl', 'Gómez', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, phone, currentEmail]
  )
  const fields = [
    { field: 'full_name', level: 'optional', scope: 'any_action' },
    { field: 'phone', level: 'optional', scope: 'any_action' },
    { field: 'email', level: 'optional', scope: 'any_action' }
  ]
  const ctx = buildContext(contactId, fields, { policy: 'confirm_changes' })
  try {
    const saveTool = createConversationalTools(ctx).find((item) => item.name === 'save_contact_data')
    const result = await saveTool.invoke(null, JSON.stringify(contactDataPayload({
      fullName: 'Paty Jiménez',
      phone: replacementPhone,
      email: 'paty@example.com',
      confirmedReplacement: true
    })))
    assert.equal(result.ok, true)
    assert.deepEqual(new Set(result.preservedFields), new Set(['full_name', 'phone', 'email']))
    const contact = await db.get('SELECT full_name, phone, email, custom_fields FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact.full_name, 'Raúl Gómez')
    assert.equal(contact.phone, phone)
    assert.equal(contact.email, currentEmail)
    assert.match(String(contact.custom_fields), /Nombre alternativo/)
    assert.match(String(contact.custom_fields), /paty@example\.com/)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('dos guardados concurrentes recalculan la identidad bloqueada y nunca pisan el snapshot anterior', async () => {
  const contactId = `contact_identity_race_${randomUUID()}`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Contacto', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, uniquePhone()]
  )
  const fields = [{ field: 'full_name', level: 'optional', scope: 'any_action' }]
  const firstName = 'Paty Jiménez'
  const secondName = 'Raúl Gómez'
  try {
    const firstTool = createConversationalTools(buildContext(contactId, fields))
      .find((item) => item.name === 'save_contact_data')
    const secondTool = createConversationalTools(buildContext(contactId, fields))
      .find((item) => item.name === 'save_contact_data')
    const [first, second] = await Promise.all([
      firstTool.invoke(null, JSON.stringify(contactDataPayload({ fullName: firstName }))),
      secondTool.invoke(null, JSON.stringify(contactDataPayload({ fullName: secondName })))
    ])
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    const saved = await db.get('SELECT full_name, custom_fields FROM contacts WHERE id = ?', [contactId])
    assert.ok([firstName, secondName].includes(saved.full_name))
    const alternate = saved.full_name === firstName ? secondName : firstName
    assert.match(String(saved.custom_fields), new RegExp(alternate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal([first, second].filter((result) => result.changedFields.includes('full_name')).length, 1)
    assert.equal([first, second].filter((result) => result.preservedFields.includes('full_name')).length, 1)
  } finally {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})

test('el fence distribuido cubre el efecto completo y después de confirmar cuarentena ya no muta', async () => {
  const contactId = `contact_distributed_safety_${randomUUID()}`
  const agentId = `agent_distributed_safety_${randomUUID()}`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Contacto', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, uniquePhone()]
  )
  const fields = [{ field: 'full_name', level: 'optional', scope: 'any_action' }]
  let releaseMutation
  let mutationEnteredResolve
  const mutationEntered = new Promise((resolve) => { mutationEnteredResolve = resolve })
  const holdMutation = new Promise((resolve) => { releaseMutation = resolve })
  setPreventiveMutationFenceHookForTest(async ({ toolName, contactId: fencedContactId }) => {
    if (toolName !== 'save_contact_data' || fencedContactId !== contactId) return
    mutationEnteredResolve()
    await holdMutation
  })

  try {
    const saveTool = createConversationalTools(buildContext(contactId, fields))
      .find((item) => item.name === 'save_contact_data')
    const mutationPromise = saveTool.invoke(
      null,
      JSON.stringify(contactDataPayload({ fullName: 'Guardado antes de cuarentena' }))
    )
    await mutationEntered

    let quarantineSettled = false
    const quarantinePromise = applyConversationalAgentPreventiveMeasure({
      agentId,
      contactId,
      channel: 'whatsapp',
      sourceMessageId: `message_${randomUUID()}`,
      category: 'phishing',
      severity: 'high',
      reason: 'Intento claro de obtener credenciales mediante un enlace falso.',
      serverPolicy: temporarySafetyPolicy()
    }).finally(() => { quarantineSettled = true })
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(quarantineSettled, false, 'la cuarentena no debe confirmarse a mitad de otro efecto mutable')

    releaseMutation()
    const mutation = await mutationPromise
    assert.equal(mutation.ok, true)
    const quarantine = await quarantinePromise
    assert.equal(quarantine.applied, true)
    assert.ok(await getActiveConversationalAgentPreventiveMeasure({ contactId, channel: 'whatsapp' }))

    setPreventiveMutationFenceHookForTest(null)
    const blocked = await createConversationalTools(buildContext(contactId, fields))
      .find((item) => item.name === 'save_contact_data')
      .invoke(null, JSON.stringify(contactDataPayload({ fullName: 'No debe guardarse' })))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'preventive_measure_active')
    assert.equal((await db.get('SELECT full_name FROM contacts WHERE id = ?', [contactId])).full_name, 'Guardado antes de cuarentena')
  } finally {
    releaseMutation?.()
    setPreventiveMutationFenceHookForTest(null)
    await cleanupSafetyContact(contactId)
  }
})

test('si falla apply_safety_measure el servidor confirma handoff antes de suprimir', async () => {
  const contactId = `contact_safety_fallback_${randomUUID()}`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Contacto riesgoso', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, uniquePhone()]
  )
  const items = [{
    id: 'handoff_human',
    enabled: true,
    rules: 'Cuando exista riesgo',
    userId: '',
    userName: '',
    pastClientsToHuman: false
  }]
  const ctx = buildContext(contactId, [], { items, dryRun: false })
  ctx.executionId = '' // fuerza el fallo previo al ledger preventivo
  try {
    const safetyTool = createConversationalTools(ctx).find((item) => item.name === 'apply_safety_measure')
    const result = await safetyTool.invoke(null, JSON.stringify({
      category: 'phishing',
      severity: 'high',
      confidence: 'certain',
      reason: 'Pidió contraseñas mediante un enlace falso.',
      evidenceSummary: 'El mensaje contiene una solicitud explícita de credenciales.'
    }))
    assert.equal(result.ok, true)
    assert.equal(result.fallbackHandoff, true)
    assert.equal(result.suppressReply, true)
    assert.equal(result.terminal, true)
    const state = await getConversationState(contactId, { agentId: ctx.config.id, channel: 'whatsapp' })
    assert.equal(state?.signal, 'ready_for_human')
    assert.equal(state?.status, 'human')
    assert.equal(await getActiveConversationalAgentPreventiveMeasure({ contactId, channel: 'whatsapp' }), null)
  } finally {
    await cleanupSafetyContact(contactId)
  }
})

test('si también falla el handoff preventivo el turno queda fail-closed y nunca responde al atacante', async () => {
  const contactId = `contact_safety_double_failure_${randomUUID()}`
  await db.run(
    `INSERT INTO contacts (id, full_name, phone, created_at, updated_at)
     VALUES (?, 'Contacto riesgoso', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, uniquePhone()]
  )
  const ctx = buildContext(contactId, [{ field: 'full_name', level: 'optional', scope: 'any_action' }], {
    items: [{ id: 'handoff_human', enabled: true, rules: 'Riesgo', userId: '', userName: '' }],
    dryRun: false
  })
  ctx.executionId = ''
  setNativeHandoffAfterAssignmentHookForTest(async () => {
    throw new Error('fallo forzado del estado humano')
  })
  try {
    const result = await createConversationalTools(ctx)
      .find((item) => item.name === 'apply_safety_measure')
      .invoke(null, JSON.stringify({
        category: 'phishing',
        severity: 'critical',
        confidence: 'certain',
        reason: 'Intentó obtener contraseñas mediante suplantación.',
        evidenceSummary: 'Solicitud explícita de contraseña y enlace malicioso.'
      }))
    assert.equal(result.ok, false)
    assert.equal(result.failClosed, true)
    assert.equal(result.suppressReply, true)
    assert.equal(result.terminal, true)
    assert.equal(ensureToolCallingV2VisibleReply('claro, te ayudo', ctx.actions), '')
    assert.equal((await getConversationState(contactId, { agentId: ctx.config.id, channel: 'whatsapp' }))?.signal || null, null)
  } finally {
    setNativeHandoffAfterAssignmentHookForTest(null)
    await cleanupSafetyContact(contactId)
  }
})

test('una medida preventiva solicitada gana sobre cualquier mutación del mismo turno', async () => {
  const contactId = `contact_safety_fence_${randomUUID()}`
  const items = [{
    id: 'handoff_human',
    enabled: true,
    rules: 'Cuando sea necesario',
    userId: '',
    userName: '',
    pastClientsToHuman: false
  }]
  const ctx = buildContext(contactId, [], { items, dryRun: true })
  ctx.preventiveSafetyRequested = true
  const handoff = createConversationalTools(ctx).find((item) => item.name === 'send_to_human')
  const result = await handoff.invoke(null, JSON.stringify({ motivo: 'Prueba', resumen: 'No debe mutar' }))
  assert.equal(result.ok, false)
  assert.equal(result.code, 'preventive_measure_wins')
  assert.equal(result.terminal, true)
  assert.equal(ctx.actions.length, 0)
})
