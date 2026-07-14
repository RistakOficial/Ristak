import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import {
  createAppointment as createAppointmentController,
  updateAppointment as updateAppointmentController
} from '../src/controllers/calendarsController.js'
import { runIdempotentAppointmentCreation } from '../src/services/appointmentCreationSafetyService.js'
import { INTERNAL_CONTROLLER_CONTEXT } from '../src/agents/invokeController.js'
import {
  createLocalAppointment,
  createLocalBlockedSlot,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

function uniqueKey(label) {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}_123456`
}

async function cleanup(key) {
  await db.run(
    'DELETE FROM appointment_creation_requests WHERE client_request_id = ?',
    [key]
  ).catch(() => {})
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    }
  }
}

test('un fallo posterior al commit local reproduce la misma cita en vez de marcar el intento fallido', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_local_commit_${suffix}`
  const contactId = `contact_local_commit_${suffix}`
  const key = `conv-v2-attempt:${uniqueKey('local_commit')}`
  const payload = {
    calendarId,
    contactId,
    startTime: '2099-08-10T15:00:00.000Z',
    endTime: '2099-08-10T16:00:00.000Z',
    source: 'conversational_agent_v2'
  }
  let createCalls = 0

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente con commit local', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda canónica local',
      source: 'ristak',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const recovered = await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload,
      create: async () => {
        createCalls += 1
        const appointment = await createLocalAppointment({
          ...payload,
          title: 'Cita ya confirmada localmente',
          appointmentStatus: 'confirmed'
        }, { syncStatus: 'pending' })
        await db.run(
          `UPDATE appointment_creation_requests
           SET appointment_id = ? WHERE client_request_id = ? AND status = 'processing'`,
          [appointment.id, key]
        )
        throw new Error('falló una automatización posterior al commit')
      }
    })

    assert.ok(recovered.id)
    assert.equal(recovered.calendarId, calendarId)
    assert.equal(recovered.idempotencyReplay?.state, 'appointment_current')
    assert.equal(createCalls, 1)
    assert.equal(
      await db.get('SELECT status FROM appointment_creation_requests WHERE client_request_id = ?', [key]).then(row => row.status),
      'completed'
    )

    const replay = await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload,
      create: async () => {
        createCalls += 1
        return { id: 'must_not_run' }
      }
    })
    assert.equal(replay.id, recovered.id)
    assert.equal(createCalls, 1)
    assert.equal(
      await db.get('SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?', [calendarId]).then(row => Number(row.total)),
      1
    )
  } finally {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)', [calendarId]).catch(() => {})
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await cleanup(key)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('la misma creación de cita se ejecuta una vez y reproduce su respuesta durable', async () => {
  const key = uniqueKey('appointment_replay')
  const payload = {
    calendarId: 'calendar_1',
    contactId: 'contact_1',
    startTime: '2026-07-11T15:00:00.000Z',
    endTime: '2026-07-11T16:00:00.000Z'
  }
  let executions = 0
  const create = async () => {
    executions += 1
    return { id: 'appointment_1', ...payload, status: 'confirmed' }
  }

  try {
    const first = await runIdempotentAppointmentCreation({ clientRequestId: key, payload, create })
    const replay = await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload: {
        endTime: payload.endTime,
        startTime: payload.startTime,
        contactId: payload.contactId,
        calendarId: payload.calendarId,
        clientRequestId: `${key}:body-copy`
      },
      create
    })

    assert.deepEqual(replay, first)
    assert.equal(executions, 1)
    const request = await db.get(
      `SELECT status, appointment_id, response_json
       FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [key]
    )
    assert.equal(request.status, 'completed')
    assert.equal(request.appointment_id, 'appointment_1')
    assert.deepEqual(JSON.parse(request.response_json), first)
  } finally {
    await cleanup(key)
  }
})

test('dos requests simultáneos con la misma llave no crean dos citas', async () => {
  const key = uniqueKey('appointment_concurrent')
  let executions = 0
  const create = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { id: 'appointment_concurrent_1', status: 'confirmed' }
  }
  const args = {
    clientRequestId: key,
    payload: {
      calendarId: 'calendar_1',
      contactId: 'contact_1',
      startTime: '2026-07-11T17:00:00.000Z',
      endTime: '2026-07-11T18:00:00.000Z'
    },
    create
  }

  try {
    const results = await Promise.allSettled([
      runIdempotentAppointmentCreation(args),
      runIdempotentAppointmentCreation(args)
    ])

    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejection = results.find((result) => result.status === 'rejected')
    assert.equal(rejection?.reason?.status, 409)
    assert.match(String(rejection?.reason?.message), /ya está en proceso/i)
  } finally {
    await cleanup(key)
  }
})

test('dos contactos que compiten por la misma llave v2 de slot dejan una sola creación', async () => {
  const key = `conv-v2-slot:${uniqueKey('shared_resource')}`
  let executions = 0
  const create = async () => {
    executions += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    return { id: `appointment_slot_winner_${executions}`, status: 'confirmed' }
  }
  const basePayload = {
    calendarId: 'calendar_shared_v2',
    startTime: '2026-07-14T17:00:00.000Z',
    endTime: '2026-07-14T18:00:00.000Z',
    source: 'conversational_agent_v2'
  }

  try {
    const results = await Promise.allSettled([
      runIdempotentAppointmentCreation({
        clientRequestId: key,
        payload: { ...basePayload, contactId: 'contact_v2_a' },
        create
      }),
      runIdempotentAppointmentCreation({
        clientRequestId: key,
        payload: { ...basePayload, contactId: 'contact_v2_b' },
        create
      })
    ])

    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    const rejected = results.find((result) => result.status === 'rejected')
    assert.equal(rejected?.reason?.status, 409)
  } finally {
    await cleanup(key)
  }
})

test('un fallo transitorio v2 libera el slot para un solo reintento concurrente', async () => {
  const key = `conv-v2-slot:${uniqueKey('retryable_resource')}`
  const payload = {
    calendarId: 'calendar_retry_v2',
    contactId: 'contact_retry_v2',
    startTime: '2026-07-15T17:00:00.000Z',
    endTime: '2026-07-15T18:00:00.000Z',
    source: 'conversational_agent_v2'
  }
  let executions = 0
  let failFirst = true
  const create = async () => {
    executions += 1
    if (failFirst) {
      failFirst = false
      throw Object.assign(new Error('storage transitorio'), { status: 503 })
    }
    await new Promise((resolve) => setTimeout(resolve, 35))
    return { id: 'appointment_retry_v2_ok', status: 'confirmed' }
  }

  try {
    await assert.rejects(
      () => runIdempotentAppointmentCreation({ clientRequestId: key, payload, create }),
      (error) => error?.status === 503
    )
    const retries = await Promise.allSettled([
      runIdempotentAppointmentCreation({ clientRequestId: key, payload, create }),
      runIdempotentAppointmentCreation({ clientRequestId: key, payload, create })
    ])

    assert.equal(executions, 2)
    assert.equal(retries.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(retries.filter((result) => result.status === 'rejected').length, 1)
    const stored = await db.get(
      'SELECT status, appointment_id FROM appointment_creation_requests WHERE client_request_id = ?',
      [key]
    )
    assert.equal(stored.status, 'completed')
    assert.equal(stored.appointment_id, 'appointment_retry_v2_ok')
  } finally {
    await cleanup(key)
  }
})

test('una cita v2 cancelada libera su llave de slot para una creación nueva', async () => {
  const key = `conv-v2-slot:${uniqueKey('cancelled_resource')}`
  const firstAppointmentId = `appointment_cancelled_v2_${Date.now()}`
  const secondAppointmentId = `appointment_rebooked_v2_${Date.now()}`
  const basePayload = {
    calendarId: 'calendar_cancelled_v2',
    startTime: '2026-07-16T17:00:00.000Z',
    endTime: '2026-07-16T18:00:00.000Z',
    source: 'conversational_agent_v2'
  }
  let executions = 0

  try {
    await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload: { ...basePayload, contactId: 'contact_cancelled_v2_a' },
      create: async () => {
        executions += 1
        await db.run(
          `INSERT INTO appointments (
            id, calendar_id, title, status, appointment_status, start_time, end_time
          ) VALUES (?, ?, ?, 'confirmed', 'confirmed', ?, ?)`,
          [firstAppointmentId, basePayload.calendarId, 'Primera cita v2', basePayload.startTime, basePayload.endTime]
        )
        return { id: firstAppointmentId, status: 'confirmed' }
      }
    })
    await db.run(
      `UPDATE appointments
       SET status = 'cancelled', appointment_status = 'cancelled'
       WHERE id = ?`,
      [firstAppointmentId]
    )

    const rebooked = await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload: { ...basePayload, contactId: 'contact_cancelled_v2_b' },
      create: async () => {
        executions += 1
        return { id: secondAppointmentId, status: 'confirmed' }
      }
    })

    assert.equal(rebooked.id, secondAppointmentId)
    assert.equal(executions, 2)
    const stored = await db.get(
      'SELECT status, appointment_id FROM appointment_creation_requests WHERE client_request_id = ?',
      [key]
    )
    assert.equal(stored.status, 'completed')
    assert.equal(stored.appointment_id, secondAppointmentId)
  } finally {
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [firstAppointmentId, secondAppointmentId]).catch(() => {})
    await cleanup(key)
  }
})

test('un retry del mismo intento v2 devuelve la cita canónica reprogramada y no recrea el slot anterior', async () => {
  const key = `conv-v2-attempt:${uniqueKey('rescheduled_replay')}`
  const appointmentId = `appointment_rescheduled_v2_${Date.now()}`
  const payload = {
    calendarId: 'calendar_rescheduled_v2_original',
    contactId: 'contact_rescheduled_v2',
    startTime: '2099-07-16T17:00:00.000Z',
    endTime: '2099-07-16T18:00:00.000Z',
    source: 'conversational_agent_v2'
  }
  const moved = {
    calendarId: 'calendar_rescheduled_v2_new',
    startTime: '2099-07-17T19:00:00.000Z',
    endTime: '2099-07-17T20:00:00.000Z'
  }
  let executions = 0

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto reprogramado v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [payload.contactId]
    )
    await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload,
      create: async () => {
        executions += 1
        await db.run(
          `INSERT INTO appointments (
            id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
          ) VALUES (?, ?, ?, 'Cita antes de mover', 'confirmed', 'confirmed', ?, ?)`,
          [appointmentId, payload.calendarId, payload.contactId, payload.startTime, payload.endTime]
        )
        return {
          id: appointmentId,
          calendarId: payload.calendarId,
          contactId: payload.contactId,
          title: 'Cita antes de mover',
          status: 'confirmed',
          appointmentStatus: 'confirmed',
          startTime: payload.startTime,
          endTime: payload.endTime
        }
      }
    })
    await db.run(
      `UPDATE appointments
       SET calendar_id = ?, start_time = ?, end_time = ?, title = 'Cita ya movida'
       WHERE id = ?`,
      [moved.calendarId, moved.startTime, moved.endTime, appointmentId]
    )

    const replay = await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload,
      create: async () => {
        executions += 1
        return { id: 'must_not_be_created' }
      }
    })

    assert.equal(executions, 1)
    assert.equal(replay.id, appointmentId)
    assert.equal(replay.calendarId, moved.calendarId)
    assert.equal(replay.startTime, moved.startTime)
    assert.equal(replay.endTime, moved.endTime)
    assert.equal(replay.title, 'Cita ya movida')
    assert.equal(replay.idempotencyReplay?.state, 'appointment_rescheduled')
    assert.equal(replay.idempotencyReplay?.canonicalChanged, true)
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await cleanup(key)
    await db.run('DELETE FROM contacts WHERE id = ?', [payload.contactId]).catch(() => {})
  }
})

test('una lease v2 vencida recupera la cita real y el dueño anterior no pisa el checkpoint', async () => {
  const key = `conv-v2-attempt:${uniqueKey('stale_processing')}`
  const appointmentId = `appointment_stale_v2_${Date.now()}`
  const payload = {
    calendarId: 'calendar_stale_v2',
    contactId: 'contact_stale_v2',
    startTime: '2099-07-18T17:00:00.000Z',
    endTime: '2099-07-18T18:00:00.000Z',
    source: 'conversational_agent_v2'
  }
  let unblockFirst
  let markFirstStarted
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve })
  const firstGate = new Promise((resolve) => { unblockFirst = resolve })
  let retryExecutions = 0

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto lease v2', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [payload.contactId]
    )
    const firstPromise = runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload,
      create: async () => {
        markFirstStarted()
        await firstGate
        return {
          id: appointmentId,
          calendarId: payload.calendarId,
          contactId: payload.contactId,
          title: 'Cita recuperada',
          status: 'confirmed',
          appointmentStatus: 'confirmed',
          startTime: payload.startTime,
          endTime: payload.endTime
        }
      }
    })
    await firstStarted
    await db.run(
      `INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time
      ) VALUES (?, ?, ?, 'Cita recuperada', 'confirmed', 'confirmed', ?, ?)`,
      [appointmentId, payload.calendarId, payload.contactId, payload.startTime, payload.endTime]
    )
    await db.run(
      `UPDATE appointment_creation_requests
       SET updated_at = '2000-01-01T00:00:00.000Z'
       WHERE client_request_id = ?`,
      [key]
    )

    const recovered = await runIdempotentAppointmentCreation({
      clientRequestId: key,
      payload,
      create: async () => {
        retryExecutions += 1
        return { id: 'must_not_be_created_after_recovery' }
      }
    })
    unblockFirst()
    const first = await firstPromise

    assert.equal(retryExecutions, 0)
    assert.equal(recovered.id, appointmentId)
    assert.equal(first.id, appointmentId)
    const stored = await db.get(
      `SELECT status, processing_token, appointment_id
       FROM appointment_creation_requests WHERE client_request_id = ?`,
      [key]
    )
    assert.equal(stored.status, 'completed')
    assert.equal(stored.processing_token, null)
    assert.equal(stored.appointment_id, appointmentId)
  } finally {
    unblockFirst?.()
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await cleanup(key)
    await db.run('DELETE FROM contacts WHERE id = ?', [payload.contactId]).catch(() => {})
  }
})

test('un inbound nuevo del mismo contacto reclama el slot liberado y dos inbounds se serializan por calendario', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_reclaim_v2_${suffix}`
  const contactId = `contact_reclaim_v2_${suffix}`
  const firstKey = `conv-v2-attempt:${uniqueKey('first_inbound')}`
  const secondKey = `conv-v2-attempt:${uniqueKey('second_inbound')}`
  const thirdKey = `conv-v2-attempt:${uniqueKey('third_inbound')}`
  const originalStart = '2099-07-20T15:00:00.000Z'
  const originalEnd = '2099-07-20T16:00:00.000Z'
  const movedStart = '2099-07-21T18:00:00.000Z'
  const movedEnd = '2099-07-21T19:00:00.000Z'
  let firstAppointmentId = ''

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Cliente que reprogramó', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_reclaim_v2',
      name: 'Agenda reclaim v2',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })

    const firstResponse = createResponse()
    await createAppointmentController({
      body: {
        clientRequestId: firstKey,
        calendarId,
        contactId,
        title: 'Cita original',
        startTime: originalStart,
        endTime: originalEnd,
        strictAvailabilityCheck: true,
        source: 'conversational_agent_v2'
      }
    }, firstResponse)
    assert.equal(firstResponse.statusCode, 201, JSON.stringify(firstResponse.body))
    firstAppointmentId = String(firstResponse.body?.data?.id || '')
    assert.ok(firstAppointmentId)

    await db.run(
      `UPDATE appointments SET start_time = ?, end_time = ?, title = 'Cita reprogramada'
       WHERE id = ?`,
      [movedStart, movedEnd, firstAppointmentId]
    )

    const exactReplay = createResponse()
    await createAppointmentController({
      body: {
        clientRequestId: firstKey,
        calendarId,
        contactId,
        title: 'Retry del mismo inbound',
        startTime: originalStart,
        endTime: originalEnd,
        strictAvailabilityCheck: true,
        source: 'conversational_agent_v2'
      }
    }, exactReplay)
    assert.equal(exactReplay.statusCode, 201)
    assert.equal(exactReplay.body?.data?.id, firstAppointmentId)
    assert.equal(exactReplay.body?.data?.startTime, movedStart)
    assert.equal(exactReplay.body?.data?.endTime, movedEnd)
    assert.equal(exactReplay.body?.data?.idempotencyReplay?.state, 'appointment_rescheduled')

    const secondResponse = createResponse()
    const thirdResponse = createResponse()
    await Promise.all([
      createAppointmentController({
        body: {
          clientRequestId: secondKey,
          calendarId,
          contactId,
          title: 'Nuevo inbound A',
          startTime: originalStart,
          endTime: originalEnd,
          strictAvailabilityCheck: true,
          source: 'conversational_agent_v2'
        }
      }, secondResponse),
      createAppointmentController({
        body: {
          clientRequestId: thirdKey,
          calendarId,
          contactId,
          title: 'Nuevo inbound B',
          startTime: originalStart,
          endTime: originalEnd,
          strictAvailabilityCheck: true,
          source: 'conversational_agent_v2'
        }
      }, thirdResponse)
    ])

    assert.deepEqual([secondResponse.statusCode, thirdResponse.statusCode].sort(), [201, 409])
    const originalSlotAppointments = await db.all(
      `SELECT id FROM appointments
       WHERE calendar_id = ? AND start_time = ? AND deleted_at IS NULL
         AND LOWER(COALESCE(appointment_status, status, '')) NOT IN ('cancelled', 'canceled', 'noshow')`,
      [calendarId, originalStart]
    )
    assert.equal(originalSlotAppointments.length, 1)
    const allAppointments = await db.all(
      'SELECT id FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [calendarId, contactId]
    )
    assert.equal(allAppointments.length, 2)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    for (const key of [firstKey, secondKey, thirdKey]) await cleanup(key)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('una llave de cita reutilizada con datos distintos se rechaza', async () => {
  const key = uniqueKey('appointment_mismatch')
  let executions = 0
  const create = async () => ({ id: `appointment_${++executions}`, status: 'confirmed' })
  const basePayload = {
    calendarId: 'calendar_1',
    contactId: 'contact_1',
    startTime: '2026-07-11T19:00:00.000Z',
    endTime: '2026-07-11T20:00:00.000Z'
  }

  try {
    await runIdempotentAppointmentCreation({ clientRequestId: key, payload: basePayload, create })
    await assert.rejects(
      () => runIdempotentAppointmentCreation({
        clientRequestId: key,
        payload: { ...basePayload, endTime: '2026-07-11T20:30:00.000Z' },
        create
      }),
      (error) => error?.status === 409 && /datos distintos/i.test(error.message)
    )
    assert.equal(executions, 1)
  } finally {
    await cleanup(key)
  }
})

test('un checkpoint local fallido o con lease vencida no se reproduce con un payload distinto', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_checkpoint_mismatch_${suffix}`
  const contactId = `contact_checkpoint_mismatch_${suffix}`
  const appointmentId = `appointment_checkpoint_mismatch_${suffix}`
  const failedKey = `conv-v2-attempt:${uniqueKey('failed_checkpoint_mismatch')}`
  const processingKey = `conv-v2-attempt:${uniqueKey('processing_checkpoint_mismatch')}`
  const payload = {
    calendarId,
    contactId,
    startTime: '2099-09-10T15:00:00.000Z',
    endTime: '2099-09-10T16:00:00.000Z',
    source: 'conversational_agent_v2'
  }
  let unexpectedExecutions = 0

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto checkpoint mismatch', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await upsertLocalCalendar({ id: calendarId, name: 'Agenda checkpoint mismatch', source: 'ristak' }, {
      source: 'ristak',
      syncStatus: 'synced'
    })
    await createLocalAppointment({
      ...payload,
      id: appointmentId,
      title: 'Cita local original',
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'pending' })

    for (const key of [failedKey, processingKey]) {
      await runIdempotentAppointmentCreation({
        clientRequestId: key,
        payload,
        create: async () => ({ id: appointmentId, ...payload, status: 'confirmed' })
      })
    }
    await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'failed', response_json = NULL, error_status = 503,
           error_message = 'fallo posterior', processing_token = NULL
       WHERE client_request_id = ?`,
      [failedKey]
    )
    await db.run(
      `UPDATE appointment_creation_requests
       SET status = 'processing', response_json = NULL, processing_token = 'stale-token',
           updated_at = '2000-01-01T00:00:00.000Z'
       WHERE client_request_id = ?`,
      [processingKey]
    )

    const mismatchedPayload = { ...payload, endTime: '2099-09-10T16:30:00.000Z' }
    for (const key of [failedKey, processingKey]) {
      await assert.rejects(
        () => runIdempotentAppointmentCreation({
          clientRequestId: key,
          payload: mismatchedPayload,
          create: async () => {
            unexpectedExecutions += 1
            return { id: 'must_not_run' }
          }
        }),
        (error) => error?.status === 409 && /datos distintos/i.test(error.message)
      )
    }
    assert.equal(unexpectedExecutions, 0)
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await cleanup(failedKey)
    await cleanup(processingKey)
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('un resultado ambiguo queda bloqueado para no crear otra cita a ciegas', async () => {
  const key = uniqueKey('appointment_ambiguous')
  let executions = 0
  const args = {
    clientRequestId: key,
    payload: {
      calendarId: 'calendar_1',
      contactId: 'contact_1',
      startTime: '2026-07-11T21:00:00.000Z',
      endTime: '2026-07-11T22:00:00.000Z'
    },
    create: async () => {
      executions += 1
      throw Object.assign(new Error('La conexión se perdió después de agendar.'), { statusCode: 503 })
    }
  }

  try {
    await assert.rejects(
      () => runIdempotentAppointmentCreation(args),
      (error) => error?.status === 503
    )
    await assert.rejects(
      () => runIdempotentAppointmentCreation(args),
      (error) => error?.status === 503 && /conexión se perdió/i.test(error.message)
    )
    assert.equal(executions, 1)
    const request = await db.get(
      `SELECT status, error_status
       FROM appointment_creation_requests
       WHERE client_request_id = ?`,
      [key]
    )
    assert.equal(request.status, 'failed')
    assert.equal(Number(request.error_status), 503)
  } finally {
    await cleanup(key)
  }
})

test('el endpoint de calendario integra la llave y no repite la cita local', async () => {
  const key = uniqueKey('appointment_endpoint')
  const body = {
    clientRequestId: key,
    calendarId: `calendar_endpoint_${Date.now()}`,
    title: 'Cita móvil idempotente',
    startTime: '2026-07-12T15:00:00.000Z',
    endTime: '2026-07-12T16:00:00.000Z',
    appointmentStatus: 'confirmed',
    timeZone: 'UTC'
  }
  const first = createResponse()
  const replay = createResponse()
  let appointmentId = ''

  try {
    await createAppointmentController({ body }, first)
    await createAppointmentController({ body }, replay)

    assert.equal(first.statusCode, 201)
    assert.equal(replay.statusCode, 201)
    assert.equal(first.body?.success, true)
    assert.deepEqual(replay.body?.data, JSON.parse(JSON.stringify(first.body?.data)))
    appointmentId = String(first.body?.data?.id || '')
    assert.ok(appointmentId)

    const rows = await db.all('SELECT id FROM appointments WHERE id = ?', [appointmentId])
    assert.equal(rows.length, 1)
  } finally {
    if (appointmentId) await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => {})
    await cleanup(key)
  }
})

test('el endpoint rechaza una cita sin calendario antes de crear el registro local', async () => {
  const title = `Cita sin calendario ${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const response = createResponse()

  await createAppointmentController({
    body: {
      title,
      startTime: '2099-07-12T15:00:00.000Z',
      endTime: '2099-07-12T16:00:00.000Z',
      appointmentStatus: 'confirmed',
      timeZone: 'UTC'
    }
  }, response)

  assert.equal(response.statusCode, 400)
  assert.equal(response.body?.success, false)
  assert.equal(response.body?.code, 'appointment_calendar_required')
  assert.equal(
    await db.get('SELECT COUNT(*) AS total FROM appointments WHERE title = ?', [title]).then(row => Number(row.total)),
    0
  )
})

test('el endpoint conversacional v2 falla cerrado si el calendario configurado no existe', async () => {
  const key = `conv-v2-slot:${uniqueKey('missing_calendar')}`
  const response = createResponse()

  try {
    await createAppointmentController({
      body: {
        clientRequestId: key,
        calendarId: `missing_calendar_${Date.now()}`,
        contactId: 'contact_missing_calendar_v2',
        title: 'No debe crearse',
        startTime: '2026-07-18T15:00:00.000Z',
        endTime: '2026-07-18T16:00:00.000Z',
        strictAvailabilityCheck: true,
        source: 'conversational_agent_v2'
      }
    }, response)

    assert.equal(response.statusCode, 404)
    assert.equal(response.body?.success, false)
    assert.equal(response.body?.code, 'calendar_not_found')
    const stored = await db.get(
      'SELECT status, error_status FROM appointment_creation_requests WHERE client_request_id = ?',
      [key]
    )
    assert.equal(stored.status, 'failed')
    assert.equal(Number(stored.error_status), 404)
  } finally {
    await cleanup(key)
  }
})

test('los flags admin no fuerzan el modo estricto y sólo allowOverlaps interno autoriza el empalme', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_strict_wins_${suffix}`
  const startTime = '2099-07-22T15:00:00.000Z'
  const endTime = '2099-07-22T16:00:00.000Z'

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda con candado estricto',
      source: 'ristak',
      ghlCalendarId: `ghl_${calendarId}`,
      appoinmentPerSlot: 5,
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    await createLocalAppointment({
      calendarId,
      title: 'Cita existente',
      startTime,
      endTime,
      appointmentStatus: 'confirmed'
    })

    const response = createResponse()
    await createAppointmentController({
      body: {
        calendarId,
        title: 'Intento admin de sobreagenda contradictorio',
        startTime,
        endTime,
        strictAvailabilityCheck: true,
        ignoreAppointmentConflicts: true,
        confirmDoubleBooking: true
      }
    }, response)

    assert.equal(response.statusCode, 409)
    assert.equal(response.body?.code, 'slot_unavailable')
    const stored = await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(Number(stored?.total || 0), 1)

    const authorizedResponse = createResponse()
    await createAppointmentController({
      [INTERNAL_CONTROLLER_CONTEXT]: {
        conversationalAgentAppointment: true,
        allowAppointmentOverlaps: true
      },
      body: {
        calendarId,
        title: 'Empalme autorizado por capacidad interna del agente',
        startTime,
        endTime,
        strictAvailabilityCheck: true,
        source: 'conversational_agent_v2',
        ignoreAppointmentConflicts: true,
        confirmDoubleBooking: true
      }
    }, authorizedResponse)

    assert.equal(authorizedResponse.statusCode, 201, JSON.stringify(authorizedResponse.body))
    const afterAuthorized = await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(Number(afterAuthorized?.total || 0), 2)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('una reagenda estricta tampoco hereda el cupo mayor del espejo GHL', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_strict_reschedule_${suffix}`
  const originalStart = '2099-07-22T13:00:00.000Z'
  const originalEnd = '2099-07-22T13:30:00.000Z'
  const occupiedStart = '2099-07-22T13:30:00.000Z'
  const occupiedEnd = '2099-07-22T14:00:00.000Z'

  try {
    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda estricta para reagendar',
      source: 'ristak',
      ghlCalendarId: `ghl_${calendarId}`,
      slotDuration: 60,
      slotInterval: 60,
      appoinmentPerSlot: 5,
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: [{
        daysOfTheWeek: [0, 1, 2, 3, 4, 5, 6],
        hours: [{ openHour: 0, openMinute: 0, closeHour: 24, closeMinute: 0 }]
      }]
    }, { source: 'ristak', syncStatus: 'synced' })
    const movable = await createLocalAppointment({
      calendarId,
      title: 'Cita que se intenta mover',
      startTime: originalStart,
      endTime: originalEnd,
      appointmentStatus: 'confirmed'
    })
    await createLocalAppointment({
      calendarId,
      title: 'Cita que ya ocupa el destino',
      startTime: occupiedStart,
      endTime: occupiedEnd,
      appointmentStatus: 'confirmed'
    })

    const response = createResponse()
    await updateAppointmentController({
      params: { id: movable.id },
      body: {
        // Cambiar sólo el final debe activar la validación. El rango resultante
        // dura exactamente 60 minutos y choca con la segunda cita; por eso esta
        // prueba demuestra cupo/overlap, no un rechazo por duración.
        endTime: occupiedEnd,
        strictAvailabilityCheck: true,
        ignoreAppointmentConflicts: true
      }
    }, response)

    assert.equal(response.statusCode, 409)
    assert.equal(response.body?.code, 'slot_unavailable')
    assert.equal(response.body?.data?.reason, 'slot_conflict')
    const unchanged = await db.get(
      'SELECT start_time, end_time FROM appointments WHERE id = ?',
      [movable.id]
    )
    assert.equal(unchanged?.start_time, originalStart)
    assert.equal(unchanged?.end_time, originalEnd)

    const authorizedResponse = createResponse()
    await updateAppointmentController({
      params: { id: movable.id },
      [INTERNAL_CONTROLLER_CONTEXT]: {
        conversationalAgentAppointment: true,
        allowAppointmentOverlaps: true
      },
      body: {
        endTime: occupiedEnd,
        strictAvailabilityCheck: true,
        ignoreAppointmentConflicts: true
      }
    }, authorizedResponse)

    assert.equal(authorizedResponse.statusCode, 200, JSON.stringify(authorizedResponse.body))
    const authorized = await db.get(
      'SELECT start_time, end_time FROM appointments WHERE id = ?',
      [movable.id]
    )
    assert.equal(authorized?.start_time, originalStart)
    assert.equal(authorized?.end_time, occupiedEnd)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('personalizado empalma citas, pero respeta bloqueos explícitos y rangos válidos', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_custom_overlap_${suffix}`
  const overlapStart = '2099-07-23T15:00:00.000Z'
  const overlapEnd = '2099-07-23T16:00:00.000Z'
  const blockedStart = '2099-07-23T17:00:00.000Z'
  const blockedEnd = '2099-07-23T18:00:00.000Z'

  try {
    const missingCalendarResponse = createResponse()
    await createAppointmentController({
      body: {
        calendarId: `missing_custom_calendar_${suffix}`,
        title: 'Personalizado sin calendario',
        startTime: overlapStart,
        endTime: overlapEnd,
        ignoreAppointmentConflicts: true
      }
    }, missingCalendarResponse)
    assert.equal(missingCalendarResponse.statusCode, 404)
    assert.equal(missingCalendarResponse.body?.code, 'calendar_not_found')

    await upsertLocalCalendar({
      id: calendarId,
      name: 'Agenda personalizada con bloqueos',
      source: 'ristak',
      openHours: [],
      availabilityScheduleConfigured: true
    }, { source: 'ristak', syncStatus: 'synced' })
    await createLocalAppointment({
      calendarId,
      title: 'Cita existente',
      startTime: overlapStart,
      endTime: overlapEnd,
      appointmentStatus: 'confirmed'
    })

    const overlapResponse = createResponse()
    await createAppointmentController({
      body: {
        calendarId,
        title: 'Cita personalizada empalmada',
        startTime: overlapStart,
        endTime: overlapEnd,
        ignoreAppointmentConflicts: true
      }
    }, overlapResponse)

    assert.equal(overlapResponse.statusCode, 201, JSON.stringify(overlapResponse.body))
    assert.equal(
      await db.get(
        'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND start_time = ?',
        [calendarId, overlapStart]
      ).then(row => Number(row.total)),
      2
    )

    await createLocalBlockedSlot({
      calendarId,
      startTime: blockedStart,
      endTime: blockedEnd,
      title: 'Ausencia explícita'
    })
    const blockedResponse = createResponse()
    await createAppointmentController({
      body: {
        calendarId,
        title: 'No debe atravesar la ausencia',
        startTime: blockedStart,
        endTime: blockedEnd,
        ignoreAppointmentConflicts: true
      }
    }, blockedResponse)

    assert.equal(blockedResponse.statusCode, 409)
    assert.equal(blockedResponse.body?.code, 'slot_unavailable')
    assert.equal(blockedResponse.body?.data?.reason, 'blocked')

    const invalidResponse = createResponse()
    await createAppointmentController({
      body: {
        calendarId,
        title: 'No debe aceptar un rango invertido',
        startTime: blockedEnd,
        endTime: blockedStart,
        ignoreAppointmentConflicts: true
      }
    }, invalidResponse)

    assert.equal(invalidResponse.statusCode, 409)
    assert.equal(invalidResponse.body?.code, 'slot_unavailable')
    assert.equal(invalidResponse.body?.data?.reason, 'invalid_slot')

    const originalDbAll = db.all
    try {
      db.all = async (sql, params = []) => {
        if (String(sql).includes('FROM blocked_slots')) {
          throw new Error('fallo simulado leyendo ausencias')
        }
        return originalDbAll.call(db, sql, params)
      }
      const unreadableBlocksResponse = createResponse()
      await createAppointmentController({
        body: {
          calendarId,
          title: 'No debe asumir que no hay ausencias',
          startTime: '2099-07-23T19:00:00.000Z',
          endTime: '2099-07-23T20:00:00.000Z',
          ignoreAppointmentConflicts: true
        }
      }, unreadableBlocksResponse)

      assert.equal(unreadableBlocksResponse.statusCode, 503)
      assert.equal(unreadableBlocksResponse.body?.code, 'availability_check_failed')
    } finally {
      db.all = originalDbAll
    }

    assert.equal(
      await db.get('SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?', [calendarId])
        .then(row => Number(row.total)),
      2
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM blocked_slots WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
  }
})

test('alta v2 y alta legacy concurrentes serializan check+insert y no duplican el slot', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  const calendarId = `calendar_mixed_race_${suffix}`
  const key = `conv-v2-slot:${uniqueKey('mixed_race')}`
  const startTime = '2099-07-19T15:00:00.000Z'
  const endTime = '2099-07-19T16:00:00.000Z'
  const v2Response = createResponse()
  const legacyResponse = createResponse()

  try {
    await upsertLocalCalendar({
      id: calendarId,
      locationId: 'location_mixed_race',
      name: 'Agenda carrera mixta',
      source: 'ristak',
      slotDuration: 60,
      slotInterval: 60,
      allowBookingFor: 36500,
      allowBookingForUnit: 'days',
      openHours: []
    }, { source: 'ristak', syncStatus: 'synced' })

    await Promise.all([
      createAppointmentController({
        body: {
          clientRequestId: key,
          calendarId,
          title: 'Cita v2 concurrente',
          startTime,
          endTime,
          strictAvailabilityCheck: true,
          source: 'conversational_agent_v2'
        }
      }, v2Response),
      createAppointmentController({
        body: {
          calendarId,
          title: 'Cita legacy concurrente',
          startTime,
          endTime
        }
      }, legacyResponse)
    ])

    assert.deepEqual([v2Response.statusCode, legacyResponse.statusCode].sort(), [201, 409])
    const appointments = await db.all(
      `SELECT id FROM appointments
       WHERE calendar_id = ? AND start_time = ? AND deleted_at IS NULL`,
      [calendarId, startTime]
    )
    assert.equal(appointments.length, 1)
  } finally {
    await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => {})
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => {})
    await cleanup(key)
  }
})
