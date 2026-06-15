import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'APP_URL',
  'APP_VERSION',
  'OWNER_EMAIL'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function startLicenseServer(requests) {
  const server = http.createServer(async (req, res) => {
    const payload = await readJson(req)
    assert.equal(payload.client_id, 'cli_google_oauth')
    assert.equal(payload.license_key, 'RSTK-GOOGLE-TEST')
    assert.equal(payload.installation_id, 'inst_google_oauth')

    if (req.url === '/api/license/google-calendar/events/list') {
      requests.push({ path: req.url, body: payload })
      assert.equal(payload.google_calendar_id, 'ventas@test.com')
      return json(res, 200, {
        success: true,
        events: [
          {
            id: 'evt_google_imported',
            summary: 'Cita importada desde Google',
            start: { dateTime: '2026-06-17T18:00:00.000Z', timeZone: 'America/Mexico_City' },
            end: { dateTime: '2026-06-17T19:00:00.000Z', timeZone: 'America/Mexico_City' }
          }
        ]
      })
    }

    if (req.url === '/api/license/google-calendar/events/upsert') {
      requests.push({ path: req.url, body: payload })
      return json(res, 200, {
        success: true,
        event: {
          id: payload.google_event_id || 'evt_google_created',
          ...payload.event
        }
      })
    }

    if (req.url === '/api/license/google-calendar/events/delete') {
      requests.push({ path: req.url, body: payload })
      return json(res, 200, {
        success: true,
        deleted: true,
        event_id: payload.google_event_id
      })
    }

    json(res, 404, { success: false, error: 'not found' })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  }
}

test('OAuth central crea, edita y elimina eventos de Google Calendar sin guardar tokens locales', async () => {
  const previousEnv = snapshotEnv()
  const requests = []
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_${suffix}`
  const appointmentId = `rstk_appt_google_${suffix}`
  let db = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@clinica.test'

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    const googleCalendarService = await import('../src/services/googleCalendarService.js')

    const calendar = await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Valoraciones',
      googleCalendarId: 'ventas@test.com',
      accessRole: 'owner',
      googleCalendarSummary: 'Ventas',
      googleCalendarTimeZone: 'America/Mexico_City'
    })
    assert.equal(calendar.googleCalendarId, 'ventas@test.com')

    let appointment = await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Cita de valoración',
      startTime: '2026-06-15T18:00:00.000Z',
      endTime: '2026-06-15T19:00:00.000Z',
      notes: 'Primera visita'
    })

    const created = await googleCalendarService.syncAppointmentToGoogle(appointment)
    assert.equal(created.appointment.googleEventId, 'evt_google_created')

    appointment = await localCalendarService.updateLocalAppointment(appointmentId, {
      startTime: '2026-06-16T20:00:00.000Z',
      endTime: '2026-06-16T21:00:00.000Z'
    })
    const updated = await googleCalendarService.syncAppointmentToGoogle(appointment)
    assert.equal(updated.appointment.googleEventId, 'evt_google_created')

    const deleted = await googleCalendarService.deleteGoogleEventForAppointment(updated.appointment)
    assert.equal(deleted.deleted, true)

    const imported = await googleCalendarService.syncGoogleEventsToLocal({
      startTime: '2026-06-17T00:00:00.000Z',
      endTime: '2026-06-18T00:00:00.000Z',
      calendarId
    })
    assert.equal(imported.saved, 1)
    assert.equal(imported.linkedCalendars, 1)

    const importedAppointment = await db.get(
      'SELECT title, calendar_id, google_event_id FROM appointments WHERE google_event_id = ?',
      ['evt_google_imported']
    )
    assert.equal(importedAppointment.title, 'Cita importada desde Google')
    assert.equal(importedAppointment.calendar_id, calendarId)

    assert.equal(requests.length, 4)
    assert.equal(requests[0].path, '/api/license/google-calendar/events/upsert')
    assert.equal(requests[0].body.google_calendar_id, 'ventas@test.com')
    assert.equal(requests[0].body.google_event_id, null)
    assert.equal(requests[0].body.event.start.dateTime, '2026-06-15T18:00:00.000Z')
    assert.equal(requests[1].body.google_event_id, 'evt_google_created')
    assert.equal(requests[1].body.event.start.dateTime, '2026-06-16T20:00:00.000Z')
    assert.equal(requests[2].path, '/api/license/google-calendar/events/delete')
    assert.equal(requests[2].body.google_event_id, 'evt_google_created')
    assert.equal(requests[3].path, '/api/license/google-calendar/events/list')
    assert.equal(requests[3].body.time_min, '2026-06-17T00:00:00.000Z')

    const finalAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(finalAppointment.googleEventId, null)

  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE google_event_id = ?', ['evt_google_imported']).catch(() => undefined)
      await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})
