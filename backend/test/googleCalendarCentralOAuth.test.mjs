import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { initializeMasterKey } from '../src/utils/encryption.js'

const ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'APP_URL',
  'APP_VERSION',
  'OWNER_EMAIL'
]
const GOOGLE_CALENDAR_CONFIG_KEY = 'google_calendar_service_account_config'

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

function googleJson(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function createGoogleApiFetchMock(requests, { cancelledAppointmentId = '' } = {}) {
  return async (url, options = {}) => {
    const parsed = new URL(String(url))
    const method = String(options.method || 'GET').toUpperCase()
    const headers = options.headers || {}
    const bodyText = options.body ? String(options.body) : ''
    const body = bodyText ? JSON.parse(bodyText) : null

    assert.equal(headers.Authorization, 'Bearer google-local-access')
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, body })

    if (parsed.pathname === '/calendar/v3/users/me/calendarList') {
      return googleJson({
        items: [
          {
            id: 'ventas@test.com',
            summary: 'Ventas',
            accessRole: 'owner',
            timeZone: 'America/Mexico_City',
            primary: true
          }
        ]
      })
    }

    if (parsed.pathname.includes('/calendar/v3/calendars/ventas%40test.com/events')) {
      if (method === 'GET') {
        return googleJson({
          items: [
            {
              id: 'evt_google_imported',
              summary: 'Cita importada desde Google',
              start: { dateTime: '2026-06-17T18:00:00.000Z', timeZone: 'America/Mexico_City' },
              end: { dateTime: '2026-06-17T19:00:00.000Z', timeZone: 'America/Mexico_City' }
            },
            {
              id: 'evt_google_cancelled',
              status: 'cancelled',
              extendedProperties: {
                private: cancelledAppointmentId ? { ristakAppointmentId: cancelledAppointmentId } : {}
              }
            }
          ]
        })
      }

      if (method === 'POST' || method === 'PATCH') {
        return googleJson({
          id: method === 'POST' ? 'evt_google_created' : 'evt_google_created',
          ...body
        })
      }

      if (method === 'DELETE') {
        return new Response(null, { status: 204 })
      }
    }

    return googleJson({ error: 'not_found' }, 404)
  }
}

async function startLicenseServer(requests) {
  const server = http.createServer(async (req, res) => {
    const payload = await readJson(req)
    assert.equal(payload.client_id, 'cli_google_oauth')
    assert.equal(payload.license_key, 'RSTK-GOOGLE-TEST')
    assert.equal(payload.installation_id, 'inst_google_oauth')

    if (req.url === '/api/auth/google/start') {
      requests.push({ path: req.url, body: payload })
      assert.equal(payload.mode, 'login')
      return json(res, 200, {
        success: true,
        url: 'https://accounts.google.test/oauth',
        mode: 'login',
        redirect_uri: 'https://portal.test/api/auth/google/callback'
      })
    }

    if (req.url === '/api/license/oauth-handoff/claim') {
      requests.push({ path: req.url, body: payload })
      assert.equal(payload.provider, 'google_calendar')
      assert.equal(payload.handoff_token, 'google_handoff_test')
      return json(res, 200, {
        success: true,
        handoff: {
          payload: {
            calendar: {
              refresh_token: 'google-refresh-token',
              email: 'agenda@test.com',
              name: 'Agenda Google',
              picture_url: 'https://lh3.googleusercontent.com/calendar.png',
              scopes: [
                'openid',
                'email',
                'profile',
                'https://www.googleapis.com/auth/calendar.events',
                'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
              ],
              connected_at: '2026-06-20T00:00:00.000Z'
            }
          }
        }
      })
    }

    if (req.url === '/api/license/google-calendar/refresh-token') {
      requests.push({ path: req.url, body: payload })
      assert.equal(payload.refresh_token, 'google-refresh-token')
      return json(res, 200, {
        success: true,
        token: {
          access_token: 'google-local-access',
          expires_in: 3600,
          token_type: 'Bearer'
        }
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

test('Google Login central conserva return_path móvil y limpia rutas inseguras', async () => {
  const previousEnv = snapshotEnv()
  const requests = []
  const { server, baseUrl } = await startLicenseServer(requests)

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'

    const { startGoogleLogin } = await import('../src/controllers/authController.js')
    const callStart = async (body) => {
      let statusCode = 200
      let responseBody = null
      const res = {
        status(code) {
          statusCode = code
          return this
        },
        json(payload) {
          responseBody = payload
          return this
        }
      }

      await startGoogleLogin({ body }, res)
      return { statusCode, responseBody }
    }

    const mobile = await callStart({ return_path: '/phone/chat' })
    assert.equal(mobile.statusCode, 200)
    assert.equal(mobile.responseBody.url, 'https://accounts.google.test/oauth')
    assert.equal(requests[0].path, '/api/auth/google/start')
    assert.equal(requests[0].body.return_path, '/phone/chat')

    await callStart({ return_path: 'https://evil.test/steal' })
    assert.equal(requests[1].body.return_path, '/dashboard')
  } finally {
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('estado Google Calendar en instalación licenciada muestra OAuth central antes de conectar', async () => {
  const previousEnv = snapshotEnv()
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = 'https://license.ristak.test'
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'

    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.deleteGoogleCalendarConfig()

    const { getGoogleCalendarIntegration } = await import('../src/controllers/calendarsController.js')
    let statusCode = 200
    let responseBody = null
    const res = {
      status(code) {
        statusCode = code
        return this
      },
      json(payload) {
        responseBody = payload
        return this
      }
    }

    await getGoogleCalendarIntegration({}, res)

    assert.equal(statusCode, 200)
    assert.equal(responseBody.success, true)
    assert.equal(responseBody.data.connectionMode, 'oauth')
    assert.equal(responseBody.data.configured, true)
    assert.equal(responseBody.data.connected, false)
  } finally {
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    restoreEnv(previousEnv)
  }
})

test('Google Calendar ignora configuración manual legacy y exige OAuth local', async () => {
  let db = null
  let previousConfig = null

  try {
    ;({ db } = await import('../src/config/database.js'))
    const googleCalendarService = await import('../src/services/googleCalendarService.js')
    previousConfig = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [GOOGLE_CALENDAR_CONFIG_KEY])

    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `, [GOOGLE_CALENDAR_CONFIG_KEY, JSON.stringify({
      connectionMode: 'service_account',
      credentialsEncrypted: 'legacy-json',
      calendarId: 'legacy@test.com',
      connectedAt: '2026-06-20T00:00:00.000Z'
    })])

    const publicConfig = await googleCalendarService.getGoogleCalendarConfig()
    assert.equal(publicConfig.connectionMode, 'oauth')
    assert.equal(publicConfig.connected, false)
    assert.equal(publicConfig.calendarId, 'legacy@test.com')

    const privateConfig = await googleCalendarService.getGoogleCalendarConfig({ includeCredentials: true })
    assert.equal(privateConfig, null)
  } finally {
    if (db) {
      if (previousConfig) {
        await db.run(`
          INSERT INTO app_config (config_key, config_value, updated_at)
          VALUES (?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(config_key) DO UPDATE SET
            config_value = excluded.config_value,
            updated_at = CURRENT_TIMESTAMP
        `, [GOOGLE_CALENDAR_CONFIG_KEY, previousConfig.config_value]).catch(() => undefined)
      } else {
        await db.run('DELETE FROM app_config WHERE config_key = ?', [GOOGLE_CALENDAR_CONFIG_KEY]).catch(() => undefined)
      }
    }
  }
})

test('OAuth Google reclama handoff y sincroniza eventos con credenciales locales', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_${suffix}`
  const appointmentId = `rstk_appt_google_${suffix}`
  let db = null
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@clinica.test'
    const googleFetch = createGoogleApiFetchMock(googleRequests)
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')

    const config = await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')
    assert.equal(config.connectionMode, 'oauth')
    assert.equal(config.connected, true)
    assert.equal(config.googleAccountEmail, 'agenda@test.com')

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

    assert.equal(requests.length, 2)
    assert.equal(requests[0].path, '/api/license/oauth-handoff/claim')
    assert.equal(requests[0].body.provider, 'google_calendar')
    assert.equal(requests[1].path, '/api/license/google-calendar/refresh-token')

    assert.deepEqual(googleRequests.map(request => request.method), ['POST', 'PATCH', 'DELETE', 'GET'])
    assert.match(googleRequests[0].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events$/)
    assert.equal(googleRequests[0].body.start.dateTime, '2026-06-15T18:00:00.000Z')
    assert.match(googleRequests[1].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events\/evt_google_created$/)
    assert.equal(googleRequests[1].body.start.dateTime, '2026-06-16T20:00:00.000Z')
    assert.match(googleRequests[2].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events\/evt_google_created$/)
    assert.match(googleRequests[3].path, /showDeleted=true/)

    const finalAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(finalAppointment.googleEventId, null)

  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE google_event_id = ?', ['evt_google_imported']).catch(() => undefined)
      await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('OAuth Google local elimina en Ristak los eventos cancelados desde Google Calendar', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_delete_${suffix}`
  const appointmentId = `rstk_appt_google_delete_${suffix}`
  let db = null
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@clinica.test'
    const googleFetch = createGoogleApiFetchMock(googleRequests, { cancelledAppointmentId: appointmentId })
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')

    await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Valoraciones con delete',
      googleCalendarId: 'ventas@test.com',
      accessRole: 'owner',
      googleCalendarSummary: 'Ventas',
      googleCalendarTimeZone: 'America/Mexico_City'
    })

    await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      googleEventId: 'evt_google_cancelled',
      title: 'Cita borrada en Google',
      startTime: '2026-06-18T18:00:00.000Z',
      endTime: '2026-06-18T19:00:00.000Z'
    }, { syncStatus: 'synced' })

    const result = await googleCalendarService.syncGoogleEventsToLocal({
      startTime: '2026-06-17T00:00:00.000Z',
      endTime: '2026-06-19T00:00:00.000Z',
      calendarId
    })

    assert.equal(result.saved, 1)
    assert.equal(result.deleted, 1)
    assert.equal(result.linkedCalendars, 1)

    const deletedAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(deletedAppointment, null)

    assert.equal(requests.length, 2)
    assert.equal(requests[0].path, '/api/license/oauth-handoff/claim')
    assert.equal(requests[1].path, '/api/license/google-calendar/refresh-token')
    assert.equal(googleRequests.length, 1)
    assert.equal(googleRequests[0].method, 'GET')
    assert.match(googleRequests[0].path, /showDeleted=true/)
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE google_event_id IN (?, ?)', ['evt_google_imported', 'evt_google_cancelled']).catch(() => undefined)
      await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('OAuth Google local importa eventos despues de ligar un calendario Ristak a Google', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_linked_google_${suffix}`
  const configKeys = ['default_calendar_id', 'attribution_calendar_ids']
  const previousConfigRows = new Map()
  const existingDefaultCalendarId = `rstk_cal_default_${suffix}`
  const previousAttributionIds = [`rstk_cal_attr_${suffix}`]
  let db = null
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@clinica.test'
    const googleFetch = createGoogleApiFetchMock(googleRequests)
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    const { updateCalendarGoogleSync } = await import('../src/controllers/calendarsController.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')
    for (const key of configKeys) {
      previousConfigRows.set(key, await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [key]))
    }

    const calendar = await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Valoraciones Ristak'
    })
    await localCalendarService.createLocalCalendar({
      id: existingDefaultCalendarId,
      name: 'Calendario Principal Existente'
    })
    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `, ['default_calendar_id', existingDefaultCalendarId])
    await db.run(`
      INSERT INTO app_config (config_key, config_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(config_key) DO UPDATE SET
        config_value = excluded.config_value,
        updated_at = CURRENT_TIMESTAMP
    `, ['attribution_calendar_ids', JSON.stringify(previousAttributionIds)])
    assert.equal(calendar.googleCalendarId, '')

    let statusCode = 200
    let responseBody = null
    await updateCalendarGoogleSync({
      params: { id: calendar.id },
      body: { googleCalendarId: 'ventas@test.com' }
    }, {
      status(code) {
        statusCode = code
        return this
      },
      json(payload) {
        responseBody = payload
        return this
      }
    })
    assert.equal(statusCode, 200)
    assert.equal(responseBody.success, true)
    assert.equal(responseBody.data.googleCalendarId, 'ventas@test.com')
    assert.equal(responseBody.data.googleAccessRole, 'owner')
    assert.equal(responseBody.data.initialGoogleSync.saved, 1)

    const linkedCalendars = await localCalendarService.listGoogleLinkedLocalCalendars()
    assert.ok(linkedCalendars.some(item => item.id === calendarId && item.googleCalendarId === 'ventas@test.com'))

    const importedAppointment = await db.get(
      'SELECT title, calendar_id, google_event_id FROM appointments WHERE google_event_id = ?',
      ['evt_google_imported']
    )
    assert.equal(importedAppointment.title, 'Cita importada desde Google')
    assert.equal(importedAppointment.calendar_id, calendarId)

    const defaultConfig = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', ['default_calendar_id'])
    const attributionConfig = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', ['attribution_calendar_ids'])
    assert.equal(defaultConfig.config_value, existingDefaultCalendarId)
    assert.deepEqual(JSON.parse(attributionConfig.config_value), previousAttributionIds)

    assert.equal(requests.length, 2)
    assert.equal(requests[0].path, '/api/license/oauth-handoff/claim')
    assert.equal(requests[1].path, '/api/license/google-calendar/refresh-token')
    assert.equal(googleRequests.length, 2)
    assert.equal(googleRequests[0].path, '/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true&minAccessRole=reader')
    assert.match(googleRequests[1].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events/)
    assert.match(googleRequests[1].path, /showDeleted=true/)
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE google_event_id = ?', ['evt_google_imported']).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [existingDefaultCalendarId]).catch(() => undefined)
      for (const key of configKeys) {
        const previous = previousConfigRows.get(key)
        if (previous) {
          await db.run(`
            INSERT INTO app_config (config_key, config_value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(config_key) DO UPDATE SET
              config_value = excluded.config_value,
              updated_at = CURRENT_TIMESTAMP
          `, [key, previous.config_value]).catch(() => undefined)
        } else {
          await db.run('DELETE FROM app_config WHERE config_key = ?', [key]).catch(() => undefined)
        }
      }
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})
