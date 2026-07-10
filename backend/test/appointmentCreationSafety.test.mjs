import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { createAppointment as createAppointmentController } from '../src/controllers/calendarsController.js'
import { runIdempotentAppointmentCreation } from '../src/services/appointmentCreationSafetyService.js'

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
