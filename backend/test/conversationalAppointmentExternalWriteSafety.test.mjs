import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { createAppointment } from '../src/controllers/calendarsController.js'
import { invokeController } from '../src/agents/invokeController.js'
import {
  createLocalAppointment,
  syncLocalAppointmentsToHighLevel,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

const GOOGLE_CONFIG_KEY = 'google_calendar_service_account_config'

function appointmentWindow(daysAhead = 30) {
  const start = DateTime.utc().plus({ days: daysAhead }).startOf('day').set({ hour: 12 })
  return {
    startTime: start.toISO(),
    endTime: start.plus({ hours: 1 }).toISO(),
    weekday: start.weekday === 7 ? 0 : start.weekday
  }
}

function appointmentCreationRequestHash(payload = {}) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable)
    if (!value || typeof value !== 'object') return value
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stable(value[key])
      return result
    }, {})
  }
  return createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex')
}

async function createLinkedCalendar({ calendarId, ghlCalendarId = '', googleCalendarId = '', window }) {
  return upsertLocalCalendar({
    id: calendarId,
    name: `Agenda local ${calendarId}`,
    source: 'ristak',
    ghlCalendarId,
    googleCalendarId,
    slotDuration: 60,
    slotInterval: 60,
    appoinmentPerSlot: 1,
    appoinmentPerDay: 10,
    allowBookingFor: 365,
    allowBookingForUnit: 'days',
    openHours: [{
      daysOfTheWeek: [window.weekday],
      hours: [{ openHour: 9, openMinute: 0, closeHour: 18, closeMinute: 0 }]
    }]
  }, { source: 'ristak', syncStatus: 'synced', allowGoogleSyncMetadata: true })
}

async function callStrictAgentCreate({ calendarId, contactId, clientRequestId, window }) {
  return invokeController(createAppointment, {
    body: {
      clientRequestId,
      calendarId,
      contactId,
      title: 'Cita canónica local',
      startTime: window.startTime,
      endTime: window.endTime,
      timeZone: 'UTC',
      assignedUserId: 'ristak_user_test',
      source: 'conversational_agent_v2',
      strictAvailabilityCheck: true
    },
    internalContext: { conversationalAgentAppointment: true }
  })
}

async function cleanupFixture({ calendarId, contactId, clientRequestId }) {
  await db.run('DELETE FROM appointment_participants WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)', [calendarId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
  await db.run('DELETE FROM appointment_creation_requests WHERE client_request_id = ?', [clientRequestId]).catch(() => undefined)
  await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('GHL desconectado no invalida la cita local ni permite duplicarla al reintentar', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_ghl_mirror_offline_${suffix}`
  const contactId = `rstk_contact_ghl_mirror_offline_${suffix}`
  const clientRequestId = `conv-v2-attempt:ghl-mirror-offline-${suffix}`
  const window = appointmentWindow(31)
  const previousHighLevelConfig = await db.all('SELECT * FROM highlevel_config')

  try {
    await db.run('DELETE FROM highlevel_config')
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto con espejo GHL apagado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await createLinkedCalendar({ calendarId, ghlCalendarId: `ghl_calendar_${suffix}`, window })

    const first = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(first.statusCode, 201, JSON.stringify(first.payload))
    assert.equal(first.payload?.success, true)
    const appointmentId = first.payload?.data?.id
    assert.ok(appointmentId)

    const stored = await db.get(
      'SELECT id, sync_status, ghl_appointment_id FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(stored.id, appointmentId)
    assert.equal(stored.sync_status, 'pending')
    assert.equal(stored.ghl_appointment_id, null)

    const retry = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(retry.statusCode, 201)
    assert.equal(retry.payload?.data?.id, appointmentId)
    assert.equal(
      await db.get('SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?', [calendarId]).then(row => Number(row.total)),
      1
    )
  } finally {
    await cleanupFixture({ calendarId, contactId, clientRequestId })
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of previousHighLevelConfig) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO highlevel_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
})

test('la respuesta de HighLevel sólo ancla el ID del espejo y nunca reescribe la cita local', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_ghl_mirror_fields_${suffix}`
  const contactId = `rstk_contact_ghl_mirror_fields_${suffix}`
  const clientRequestId = `conv-v2-attempt:ghl-mirror-fields-${suffix}`
  const window = appointmentWindow(35)
  const previousHighLevelConfig = await db.all('SELECT * FROM highlevel_config')
  const previousFetch = global.fetch
  const remoteAppointmentId = `ghl_appt_${suffix}`

  try {
    await db.run('DELETE FROM highlevel_config')
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
      [`ghl_location_${suffix}`, `ghl_token_${suffix}`, '{}']
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, ghl_contact_id, created_at, updated_at)
       VALUES (?, 'Contacto local protegido', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_contact_${suffix}`]
    )
    await createLinkedCalendar({ calendarId, ghlCalendarId: `ghl_calendar_${suffix}`, window })
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('/calendars/events/appointments') && String(options.method || '').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({
          appointment: {
            id: remoteAppointmentId,
            title: 'TÍTULO REMOTO QUE NO MANDA',
            contactId: `ghl_contact_intruso_${suffix}`,
            appointmentStatus: 'cancelled',
            status: 'cancelled',
            startTime: '2040-01-01T00:00:00.000Z',
            endTime: '2040-01-01T01:00:00.000Z',
            notes: 'NOTAS REMOTAS QUE NO MANDAN'
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      throw new Error(`Solicitud externa inesperada en prueba: ${url}`)
    }

    const response = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(response.statusCode, 201, JSON.stringify(response.payload))
    const stored = await db.get('SELECT * FROM appointments WHERE id = ?', [response.payload?.data?.id])
    assert.equal(stored.ghl_appointment_id, remoteAppointmentId)
    assert.equal(stored.contact_id, contactId)
    assert.equal(stored.title, 'Cita canónica local')
    assert.equal(stored.status, 'confirmed')
    assert.equal(new Date(stored.start_time).toISOString(), window.startTime)
    assert.equal(new Date(stored.end_time).toISOString(), window.endTime)
    assert.notEqual(stored.notes, 'NOTAS REMOTAS QUE NO MANDAN')
  } finally {
    global.fetch = previousFetch
    await cleanupFixture({ calendarId, contactId, clientRequestId })
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of previousHighLevelConfig) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO highlevel_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
})

test('GHL sin ID deja el espejo en error pero confirma una sola cita local', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_ghl_mirror_no_id_${suffix}`
  const contactId = `rstk_contact_ghl_mirror_no_id_${suffix}`
  const clientRequestId = `conv-v2-attempt:ghl-mirror-no-id-${suffix}`
  const window = appointmentWindow(32)
  const previousHighLevelConfig = await db.all('SELECT * FROM highlevel_config')
  const previousFetch = global.fetch
  let writeCalls = 0
  let reconciliationReads = 0

  try {
    await db.run('DELETE FROM highlevel_config')
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
      [`ghl_location_${suffix}`, `ghl_token_${suffix}`, '{}']
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, ghl_contact_id, created_at, updated_at)
       VALUES (?, 'Contacto con espejo GHL ambiguo', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, `ghl_contact_${suffix}`]
    )
    await createLinkedCalendar({ calendarId, ghlCalendarId: `ghl_calendar_${suffix}`, window })
    global.fetch = async (url, options = {}) => {
      if (String(url).includes('/calendars/events/appointments') && String(options.method || '').toUpperCase() === 'POST') {
        writeCalls += 1
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (String(url).includes('/calendars/events?') && String(options.method || 'GET').toUpperCase() === 'GET') {
        reconciliationReads += 1
        if (reconciliationReads === 1) {
          return new Response(JSON.stringify({ error: 'temporary_read_failure' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      throw new Error(`Solicitud externa inesperada en prueba: ${url}`)
    }

    const first = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(first.statusCode, 201, JSON.stringify(first.payload))
    const appointmentId = first.payload?.data?.id
    assert.ok(appointmentId)

    const stored = await db.get(
      'SELECT id, sync_status, sync_error, ghl_appointment_id FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(stored.id, appointmentId)
    assert.equal(stored.sync_status, 'error')
    assert.equal(stored.ghl_appointment_id, null)
    assert.match(stored.sync_error || '', /identificador verificable/i)
    assert.match(stored.sync_error || '', /remote_outcome_unknown/i)

    const failedReadRetry = await syncLocalAppointmentsToHighLevel(`ghl_location_${suffix}`, `ghl_token_${suffix}`)
    assert.equal(failedReadRetry.failed, 1)
    assert.equal(reconciliationReads, 1)
    let afterRetry = await db.get('SELECT sync_error FROM appointments WHERE id = ?', [appointmentId])
    assert.match(afterRetry.sync_error || '', /remote_outcome_unknown/i, 'un fallo de lectura no debe borrar la marca ambigua')

    const emptyReadRetry = await syncLocalAppointmentsToHighLevel(`ghl_location_${suffix}`, `ghl_token_${suffix}`)
    assert.equal(emptyReadRetry.failed, 1)
    assert.equal(reconciliationReads, 2)
    assert.equal(writeCalls, 1, 'el reconciliador no debe enviar un segundo POST si el primer resultado fue ambiguo')
    afterRetry = await db.get('SELECT sync_error FROM appointments WHERE id = ?', [appointmentId])
    assert.match(afterRetry.sync_error || '', /remote_outcome_unknown/i)

    const retry = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(retry.statusCode, 201)
    assert.equal(retry.payload?.data?.id, appointmentId)
    assert.equal(writeCalls, 1)
    assert.equal(
      await db.get('SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?', [calendarId]).then(row => Number(row.total)),
      1
    )
  } finally {
    global.fetch = previousFetch
    await cleanupFixture({ calendarId, contactId, clientRequestId })
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of previousHighLevelConfig) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO highlevel_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      ).catch(() => undefined)
    }
  }
})

test('Google desconectado queda como espejo en error sin tumbar la cita local', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_mirror_offline_${suffix}`
  const contactId = `rstk_contact_google_mirror_offline_${suffix}`
  const clientRequestId = `conv-v2-attempt:google-mirror-offline-${suffix}`
  const window = appointmentWindow(33)
  const previousGoogleConfig = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [GOOGLE_CONFIG_KEY])

  try {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [GOOGLE_CONFIG_KEY])
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto con espejo Google apagado', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await createLinkedCalendar({ calendarId, googleCalendarId: `google-calendar-${suffix}@example.test`, window })

    const response = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(response.statusCode, 201, JSON.stringify(response.payload))
    assert.equal(response.payload?.success, true)

    const stored = await db.get(
      'SELECT id, google_event_id, google_sync_status, google_sync_error FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(stored.id, response.payload?.data?.id)
    assert.equal(stored.google_event_id, null)
    assert.equal(stored.google_sync_status, 'error')
    assert.match(stored.google_sync_error || '', /no confirmó el espejo/i)
  } finally {
    await cleanupFixture({ calendarId, contactId, clientRequestId })
    if (previousGoogleConfig) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP`,
        [GOOGLE_CONFIG_KEY, previousGoogleConfig.config_value]
      ).catch(() => undefined)
    } else {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [GOOGLE_CONFIG_KEY]).catch(() => undefined)
    }
  }
})

test('una lease vencida recupera la cita local canónica sin volver a tocar el espejo', async () => {
  const suffix = randomUUID()
  const calendarId = `rstk_cal_local_crash_${suffix}`
  const contactId = `rstk_contact_local_crash_${suffix}`
  const clientRequestId = `conv-v2-attempt:local-crash-${suffix}`
  const window = appointmentWindow(34)

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, 'Contacto con worker interrumpido', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )
    await createLinkedCalendar({ calendarId, ghlCalendarId: `ghl_calendar_${suffix}`, window })
    const localAppointment = await createLocalAppointment({
      calendarId,
      contactId,
      title: 'Cita local creada antes del crash',
      source: 'conversational_agent_v2',
      startTime: window.startTime,
      endTime: window.endTime,
      appointmentStatus: 'confirmed'
    }, { syncStatus: 'pending' })
    const idempotencyPayload = {
      calendarId,
      contactId,
      startTime: window.startTime,
      endTime: window.endTime,
      source: 'conversational_agent_v2'
    }
    await db.run(
      `INSERT INTO appointment_creation_requests (
         client_request_id, request_hash, status, processing_token,
         appointment_id, created_at, updated_at
       ) VALUES (?, ?, 'processing', ?, ?, '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')`,
      [
        clientRequestId,
        appointmentCreationRequestHash(idempotencyPayload),
        `dead-worker-${suffix}`,
        localAppointment.id
      ]
    )

    const response = await callStrictAgentCreate({ calendarId, contactId, clientRequestId, window })
    assert.equal(response.statusCode, 201, JSON.stringify(response.payload))
    assert.equal(response.payload?.data?.id, localAppointment.id)
    assert.equal(response.payload?.data?.idempotencyReplay?.state, 'appointment_current')
    assert.equal(
      await db.get('SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?', [calendarId]).then(row => Number(row.total)),
      1
    )
    assert.equal(
      await db.get('SELECT status FROM appointment_creation_requests WHERE client_request_id = ?', [clientRequestId]).then(row => row.status),
      'completed'
    )
  } finally {
    await cleanupFixture({ calendarId, contactId, clientRequestId })
  }
})
