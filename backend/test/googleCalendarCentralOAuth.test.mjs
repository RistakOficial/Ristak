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

function createGoogleApiFetchMock(requests, {
  cancelledAppointmentId = '',
  failDeleteOnce = false,
  failCreateAmbiguouslyOnce = false,
  conflictOnDuplicateCreate = false,
  beforeCreateResponse = null
} = {}) {
  let deleteAttempts = 0
  let createAttempts = 0
  const createdEvents = new Map()
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
        const eventPathMatch = parsed.pathname.match(/\/events\/([^/]+)$/)
        if (eventPathMatch) {
          const eventId = decodeURIComponent(eventPathMatch[1])
          const event = createdEvents.get(eventId)
          return event
            ? googleJson(event)
            : googleJson({ error: { message: 'not_found' } }, 404)
        }
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

      if (method === 'POST') {
        createAttempts += 1
        const event = { ...body, id: body?.id || 'evt_google_created' }
        if (conflictOnDuplicateCreate && createdEvents.has(event.id)) {
          return googleJson({ error: { message: 'already_exists' } }, 409)
        }
        createdEvents.set(event.id, event)
        if (typeof beforeCreateResponse === 'function') {
          await beforeCreateResponse({ event, createAttempts })
        }
        if (failCreateAmbiguouslyOnce && createAttempts === 1) {
          return googleJson({ error: { message: 'temporary_create_timeout' } }, 503)
        }
        return googleJson(event)
      }

      if (method === 'PATCH') {
        const eventId = decodeURIComponent(parsed.pathname.split('/').at(-1))
        const event = { ...body, id: eventId }
        createdEvents.set(eventId, event)
        return googleJson(event)
      }

      if (method === 'DELETE') {
        deleteAttempts += 1
        if (failDeleteOnce && deleteAttempts === 1) {
          return googleJson({ error: { message: 'temporary_delete_failure' } }, 503)
        }
        return new Response(null, { status: 204 })
      }
    }

    return googleJson({ error: 'not_found' }, 404)
  }
}

function createGoogleRelinkFetchMock(requests, { failOldDeleteOnce = false } = {}) {
  const calendarA = 'calendar-a@test.com'
  const calendarB = 'calendar-b@test.com'
  const eventsByCalendar = new Map([
    [calendarA, new Map()],
    [calendarB, new Map()]
  ])
  let oldDeleteAttempts = 0

  const handler = async (url, options = {}) => {
    const parsed = new URL(String(url))
    const method = String(options.method || 'GET').toUpperCase()
    const headers = options.headers || {}
    const bodyText = options.body ? String(options.body) : ''
    const body = bodyText ? JSON.parse(bodyText) : null
    assert.equal(headers.Authorization, 'Bearer google-local-access')
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, body })

    if (parsed.pathname === '/calendar/v3/users/me/calendarList') {
      return googleJson({
        items: [calendarA, calendarB].map((id, index) => ({
          id,
          summary: index === 0 ? 'Google A' : 'Google B',
          accessRole: 'owner',
          timeZone: 'America/Ciudad_Juarez',
          primary: index === 0
        }))
      })
    }

    const match = parsed.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/)
    if (!match) return googleJson({ error: 'not_found' }, 404)
    const providerCalendarId = decodeURIComponent(match[1])
    const eventId = match[2] ? decodeURIComponent(match[2]) : ''
    const events = eventsByCalendar.get(providerCalendarId)
    if (!events) return googleJson({ error: 'calendar_not_found' }, 404)

    if (method === 'GET') {
      if (eventId) {
        return events.has(eventId)
          ? googleJson(events.get(eventId))
          : googleJson({ error: { message: 'not_found' } }, 404)
      }
      return googleJson({ items: [...events.values()] })
    }
    if (method === 'POST') {
      const event = { ...body, id: body?.id || `event-${randomUUID()}` }
      events.set(event.id, event)
      return googleJson(event)
    }
    if (method === 'PATCH') {
      if (!events.has(eventId)) return googleJson({ error: { message: 'not_found' } }, 404)
      const event = { ...body, id: eventId }
      events.set(eventId, event)
      return googleJson(event)
    }
    if (method === 'DELETE') {
      if (providerCalendarId === calendarA) {
        oldDeleteAttempts += 1
        if (failOldDeleteOnce && oldDeleteAttempts === 1) {
          return googleJson({ error: { message: 'temporary_old_delete_failure' } }, 503)
        }
      }
      events.delete(eventId)
      return new Response(null, { status: 204 })
    }
    return googleJson({ error: 'unsupported_method' }, 405)
  }

  handler.eventsByCalendar = eventsByCalendar
  handler.calendarA = calendarA
  handler.calendarB = calendarB
  return handler
}

async function startLicenseServer(requests) {
  const server = http.createServer(async (req, res) => {
    const payload = await readJson(req)
    assert.equal(payload.client_id, 'cli_google_oauth')
    assert.equal(payload.license_key, 'RSTK-GOOGLE-TEST')
    assert.equal(payload.installation_id, 'inst_google_oauth')

    if (req.url === '/api/license/google-login/connect-url') {
      requests.push({ path: req.url, body: payload })
      return json(res, 200, {
        success: true,
        url: 'https://accounts.google.test/oauth',
        mode: 'installed_login',
        redirect_uri: 'https://portal.test/api/auth/google/callback'
      })
    }

    if (req.url === '/api/license/google-calendar/connect-url') {
      requests.push({ path: req.url, body: payload })
      return json(res, 200, {
        success: true,
        url: 'https://accounts.google.test/calendar-oauth',
        mode: 'calendar',
        redirect_uri: 'https://portal.test/api/license/google-calendar/callback'
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

    const mobile = await callStart({ return_path: '/movil' })
    assert.equal(mobile.statusCode, 200)
    assert.equal(mobile.responseBody.url, 'https://accounts.google.test/oauth')
    assert.equal(requests[0].path, '/api/license/google-login/connect-url')
    assert.equal(requests[0].body.return_path, 'https://demo.onrender.com/sso?return_path=%2Fmovil')

    await callStart({ return_path: '/phone/chat' })
    assert.equal(requests[1].body.return_path, 'https://demo.onrender.com/sso?return_path=%2Fphone%2Fchat')

    await callStart({ return_path: 'https://evil.test/steal' })
    assert.equal(requests[2].body.return_path, 'https://demo.onrender.com/sso?return_path=%2Fdashboard')
  } finally {
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('Google Calendar OAuth conserva return_path de calendarios y bloquea rutas ajenas', async () => {
  const previousEnv = snapshotEnv()
  const requests = []
  const { server, baseUrl } = await startLicenseServer(requests)

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'

    const { getGoogleCalendarConnectUrl } = await import('../src/controllers/calendarsController.js')
    const callConnectUrl = async (body, headers = { origin: 'https://raulgomez.onrender.com' }) => {
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

      await getGoogleCalendarConnectUrl({ body, headers, protocol: 'https' }, res)
      return { statusCode, responseBody }
    }

    const calendarPath = '/settings/calendars/google?panel=sync'
    const ok = await callConnectUrl({ returnPath: calendarPath })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.responseBody.data.url, 'https://accounts.google.test/calendar-oauth')
    assert.equal(requests[0].path, '/api/license/google-calendar/connect-url')
    assert.equal(requests[0].body.return_path, calendarPath)
    assert.equal(requests[0].body.app_url, 'https://raulgomez.onrender.com')

    await callConnectUrl({ returnPath: '/initialization' })
    assert.equal(requests[1].body.return_path, '/initialization')
    assert.equal(requests[1].body.app_url, 'https://raulgomez.onrender.com')

    await callConnectUrl({ returnPath: '/settings/payments' })
    assert.equal(requests[2].body.return_path, '/settings/calendars/google')
    assert.equal(requests[2].body.app_url, 'https://raulgomez.onrender.com')

    await callConnectUrl({ returnPath: 'https://evil.test/settings/calendars/google' })
    assert.equal(requests[3].body.return_path, '/settings/calendars/google')
    assert.equal(requests[3].body.app_url, 'https://raulgomez.onrender.com')

    await callConnectUrl(
      { returnPath: calendarPath, appUrl: 'https://body-tenant.onrender.com/settings/calendars/google' },
      {}
    )
    assert.equal(requests[4].body.app_url, 'https://body-tenant.onrender.com')

    await callConnectUrl(
      { returnPath: calendarPath },
      { 'x-forwarded-host': 'proxy-tenant.onrender.com', 'x-forwarded-proto': 'https' }
    )
    assert.equal(requests[5].body.app_url, 'https://proxy-tenant.onrender.com')
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
    const googleFetch = createGoogleApiFetchMock(googleRequests, {
      failDeleteOnce: true,
      failCreateAmbiguouslyOnce: true
    })
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
    }, { allowGoogleSyncMetadata: true })
    assert.equal(calendar.googleCalendarId, 'ventas@test.com')

    let appointment = await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Cita de valoración',
      startTime: '2026-06-15T18:00:00.000Z',
      endTime: '2026-06-15T19:00:00.000Z',
      notes: 'Primera visita'
    })

    const deterministicGoogleEventId = googleCalendarService.googleAppointmentEventIdForLocalAppointment(appointmentId)
    const created = await googleCalendarService.syncAppointmentToGoogle(appointment)
    assert.equal(created.appointment.googleEventId, deterministicGoogleEventId)
    assert.equal(created.appointment.googleProviderCalendarId, 'ventas@test.com')
    assert.equal(googleRequests[0].body.id, deterministicGoogleEventId)

    appointment = await localCalendarService.updateLocalAppointment(appointmentId, {
      startTime: '2026-06-16T20:00:00.000Z',
      endTime: '2026-06-16T21:00:00.000Z'
    })
    const updated = await googleCalendarService.syncAppointmentToGoogle(appointment)
    assert.equal(updated.appointment.googleEventId, deterministicGoogleEventId)

    appointment = await localCalendarService.updateLocalAppointment(appointmentId, {
      appointmentStatus: 'cancelled',
      status: 'cancelled'
    })
    await assert.rejects(
      googleCalendarService.deleteGoogleEventForAppointment(appointment),
      /Google Calendar|temporary_delete_failure|503/i
    )
    const failedDelete = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(failedDelete.googleEventId, deterministicGoogleEventId)
    assert.equal(failedDelete.googleSyncStatus, 'error')

    const retriedDelete = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(retriedDelete.synced, 1)

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

    assert.deepEqual(googleRequests.map(request => request.method), ['POST', 'GET', 'PATCH', 'DELETE', 'DELETE', 'GET'])
    assert.match(googleRequests[0].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events\?sendUpdates=all$/)
    assert.equal(googleRequests[0].body.start.dateTime, '2026-06-15T18:00:00.000Z')
    assert.match(googleRequests[1].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}$`))
    assert.match(googleRequests[2].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}\\?sendUpdates=all$`))
    assert.equal(googleRequests[2].body.start.dateTime, '2026-06-16T20:00:00.000Z')
    assert.match(googleRequests[3].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}\\?sendUpdates=all$`))
    assert.match(googleRequests[4].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}\\?sendUpdates=all$`))
    assert.match(googleRequests[5].path, /showDeleted=true/)

    const finalAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(finalAppointment.googleEventId, null)
    assert.equal(finalAppointment.googleProviderCalendarId, null)

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

test('cleanup test Google usa el receipt original tras relink, con fila ausente y fallback al provider local', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_cleanup_${suffix}`
  const currentOwnerCalendarId = `rstk_cal_google_cleanup_owner_${suffix}`
  const contactId = `rstk_contact_google_cleanup_${suffix}`
  const agentId = `cagent_google_cleanup_${suffix}`
  const fixtureIds = []
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
    const { cleanupConversationalTestAppointment } = await import(
      '../src/services/conversationalAppointmentTestCleanupService.js'
    )

    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')
    await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Agenda original de pruebas',
      googleCalendarId: 'ventas@test.com',
      accessRole: 'owner',
      googleCalendarSummary: 'Ventas',
      googleCalendarTimeZone: 'America/Mexico_City'
    }, { allowGoogleSyncMetadata: true })
    await db.run(
      'INSERT INTO contacts (id, full_name, created_at, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Contacto cleanup Google']
    )
    await db.run(
      'INSERT INTO conversational_agents (id, name, capabilities_config) VALUES (?, ?, ?)',
      [agentId, 'Agente cleanup Google', JSON.stringify({ schemaVersion: 3, testMode: { enabled: true }, items: [] })]
    )

    const createTestFixture = async (label, startTime, endTime) => {
      const runId = `agent-test-google-cleanup-${label}-${suffix}`
      const effectId = `effect_google_cleanup_${label}_${suffix}`
      const appointmentId = `rstk_appt_google_cleanup_${label}_${suffix}`
      const expiresAt = new Date(Date.now() - 60_000).toISOString()
      const participants = [
        { role: 'requester', contactId },
        { role: 'primary_attendee', contactId }
      ]
      await db.run(`
        INSERT INTO conversational_agent_test_runs (
          id, agent_id, requested_by_user_id, contact_id, effects_json, status, expires_at
        ) VALUES (?, ?, '1', ?, ?, 'active', ?)
      `, [
        runId,
        agentId,
        contactId,
        JSON.stringify({ enabled: true, scheduleAppointment: true }),
        new Date(Date.now() + 60_000).toISOString()
      ])
      await db.run(`
        INSERT INTO conversational_agent_test_effects (
          id, run_id, message_id, effect_type, request_hash, status,
          payload_json, cleanup_status, claim_token, lease_until_at
        ) VALUES (?, ?, ?, 'appointment', ?, 'processing', ?, 'pending', ?, ?)
      `, [
        effectId,
        runId,
        `message_google_cleanup_${label}_${suffix}`,
        `hash_google_cleanup_${label}_${suffix}`,
        JSON.stringify({ calendarId, startTime, endTime, bookingOwner: 'ai', participants }),
        `claim_google_cleanup_${label}_${suffix}`,
        new Date(Date.now() + 60_000).toISOString()
      ])
      const appointment = await localCalendarService.createLocalAppointment({
        id: appointmentId,
        calendarId,
        contactId,
        title: `Cita test ${label}`,
        startTime,
        endTime,
        participants,
        isTest: true,
        testRunId: runId,
        testEffectId: effectId,
        testExpiresAt: expiresAt
      })
      const synced = await googleCalendarService.syncAppointmentToGoogle(appointment)
      assert.equal(
        synced.appointment.googleEventId,
        googleCalendarService.googleTestEventIdForEffect(effectId)
      )
      assert.equal(synced.appointment.googleProviderCalendarId, 'ventas@test.com')
      await db.run(`
        UPDATE conversational_agent_test_effects
        SET status = 'recorded', entity_id = ?, claim_token = NULL, lease_until_at = NULL
        WHERE id = ?
      `, [appointmentId, effectId])
      const receipt = await db.get(`
        SELECT id, command_json, external_id
        FROM conversational_appointment_test_provider_receipts
        WHERE test_effect_id = ? AND provider = 'google'
      `, [effectId])
      assert.equal(receipt.external_id, googleCalendarService.googleTestEventIdForEffect(effectId))
      fixtureIds.push({ runId, effectId, appointmentId, receiptId: receipt.id })
      return { runId, effectId, appointmentId, receipt }
    }

    const missingRow = await createTestFixture(
      'missing',
      '2030-07-22T15:00:00.000Z',
      '2030-07-22T16:00:00.000Z'
    )
    const providerFallback = await createTestFixture(
      'fallback',
      '2030-07-22T17:00:00.000Z',
      '2030-07-22T18:00:00.000Z'
    )

    // El receipt no es un comodín para borrar cualquier ID. Incluso con OAuth
    // válido y provider durable, el evento debe ser el determinista del effect.
    await db.run(
      'UPDATE conversational_appointment_test_provider_receipts SET external_id = ? WHERE id = ?',
      ['evento-arbitrario', missingRow.receipt.id]
    )
    const deletesBeforeTamperCheck = googleRequests.filter(request => request.method === 'DELETE').length
    await assert.rejects(
      googleCalendarService.deleteConversationalTestGoogleEventFromReceipt({
        receiptId: missingRow.receipt.id,
        testEffectId: missingRow.effectId
      }),
      error => error?.code === 'test_google_cleanup_event_identity_mismatch'
    )
    assert.equal(
      googleRequests.filter(request => request.method === 'DELETE').length,
      deletesBeforeTamperCheck
    )
    await db.run(
      'UPDATE conversational_appointment_test_provider_receipts SET external_id = ? WHERE id = ?',
      [googleCalendarService.googleTestEventIdForEffect(missingRow.effectId), missingRow.receipt.id]
    )

    // Caso production de caída: el receipt sobrevivió, pero la fila local no.
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [missingRow.appointmentId])
    await db.run('DELETE FROM appointments WHERE id = ?', [missingRow.appointmentId])
    // Ventana exacta crash-after-provider/before-complete-effect: el receipt y
    // su ID determinista ya existen, pero entity_id todavía no alcanzó a quedar.
    await db.run(
      'UPDATE conversational_agent_test_effects SET entity_id = NULL WHERE id = ?',
      [missingRow.effectId]
    )
    assert.equal(
      (await db.get('SELECT entity_id FROM conversational_agent_test_effects WHERE id = ?', [missingRow.effectId])).entity_id,
      null
    )

    // Sin provider en receipt ni fila local no cae al calendario global/current:
    // falla cerrado antes de tocar Google.
    const missingCommand = JSON.parse(missingRow.receipt.command_json)
    delete missingCommand.providerCalendarId
    await db.run(
      'UPDATE conversational_appointment_test_provider_receipts SET command_json = ? WHERE id = ?',
      [JSON.stringify(missingCommand), missingRow.receipt.id]
    )
    const deletesBeforeMissingProvider = googleRequests.filter(request => request.method === 'DELETE').length
    await assert.rejects(
      googleCalendarService.deleteConversationalTestGoogleEventFromReceipt({
        receiptId: missingRow.receipt.id,
        testEffectId: missingRow.effectId
      }),
      error => error?.code === 'test_google_cleanup_provider_identity_required'
    )
    assert.equal(
      googleRequests.filter(request => request.method === 'DELETE').length,
      deletesBeforeMissingProvider
    )
    missingCommand.providerCalendarId = 'ventas@test.com'
    await db.run(
      'UPDATE conversational_appointment_test_provider_receipts SET command_json = ? WHERE id = ?',
      [JSON.stringify(missingCommand), missingRow.receipt.id]
    )

    // Simula receipt compatible anterior sin providerCalendarId. La columna de
    // la cita sigue conservando el provider original y actúa como fallback.
    const fallbackCommand = JSON.parse(providerFallback.receipt.command_json)
    delete fallbackCommand.providerCalendarId
    await db.run(`
      UPDATE conversational_appointment_test_provider_receipts
      SET command_json = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [JSON.stringify(fallbackCommand), providerFallback.receipt.id])

    // La agenda original ahora apunta a Google L2 y otra agenda es la dueña
    // actual de L1. El owner fence normal bloquearía un DELETE de L1 emitido por
    // calendarId, pero el receipt debe limpiar exactamente el evento creado allí.
    const originalCalendarRow = await db.get('SELECT raw_json FROM calendars WHERE id = ?', [calendarId])
    const relinkedRawJson = JSON.parse(originalCalendarRow.raw_json || '{}')
    relinkedRawJson.googleCalendarId = 'nuevo-owner@test.com'
    await db.run(
      'UPDATE calendars SET raw_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [JSON.stringify(relinkedRawJson), calendarId]
    )
    await localCalendarService.createLocalCalendar({
      id: currentOwnerCalendarId,
      name: 'Dueño actual de Ventas',
      googleCalendarId: 'ventas@test.com',
      accessRole: 'owner'
    }, { allowGoogleSyncMetadata: true })
    const currentOwners = (await localCalendarService.listGoogleLinkedLocalCalendars({ includeInactive: true }))
      .filter(calendar => calendar.googleCalendarId === 'ventas@test.com')
      .map(calendar => calendar.id)
    assert.deepEqual(currentOwners, [currentOwnerCalendarId])

    const missingResult = await cleanupConversationalTestAppointment({
      appointmentId: missingRow.appointmentId,
      testEffectId: missingRow.effectId
    })
    const fallbackResult = await cleanupConversationalTestAppointment({
      appointmentId: providerFallback.appointmentId,
      testEffectId: providerFallback.effectId
    })
    assert.equal(missingResult.status, 'cleaned')
    assert.equal(missingResult.alreadyAbsent, true)
    assert.equal(fallbackResult.status, 'cleaned')
    assert.equal(fallbackResult.deleted, true)

    for (const fixture of fixtureIds) {
      const receipt = await db.get(
        'SELECT cleanup_status FROM conversational_appointment_test_provider_receipts WHERE id = ?',
        [fixture.receiptId]
      )
      const effect = await db.get(
        'SELECT status, cleanup_status FROM conversational_agent_test_effects WHERE id = ?',
        [fixture.effectId]
      )
      assert.equal(receipt.cleanup_status, 'cleaned')
      assert.equal(effect.status, 'cleaned')
      assert.equal(effect.cleanup_status, 'cleaned')
      assert.equal(await db.get('SELECT id FROM appointments WHERE id = ?', [fixture.appointmentId]), null)
    }

    const deletePaths = googleRequests
      .filter(request => request.method === 'DELETE')
      .map(request => request.path)
    assert.equal(deletePaths.length, 2)
    for (const fixture of fixtureIds) {
      assert.ok(deletePaths.some(path => path.includes(
        `/calendars/ventas%40test.com/events/${googleCalendarService.googleTestEventIdForEffect(fixture.effectId)}`
      )))
    }
    assert.equal(deletePaths.some(path => path.includes('nuevo-owner%40test.com')), false)
  } finally {
    if (db) {
      for (const fixture of fixtureIds) {
        await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => undefined)
        await db.run('DELETE FROM conversational_appointment_test_provider_receipts WHERE test_effect_id = ?', [fixture.effectId]).catch(() => undefined)
        await db.run('DELETE FROM appointments WHERE id = ?', [fixture.appointmentId]).catch(() => undefined)
        await db.run('DELETE FROM conversational_agent_test_effects WHERE id = ?', [fixture.effectId]).catch(() => undefined)
        await db.run('DELETE FROM conversational_agent_test_runs WHERE id = ?', [fixture.runId]).catch(() => undefined)
      }
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM conversational_agents WHERE id = ?', [agentId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [calendarId, currentOwnerCalendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('una respuesta vieja de Google no pisa la edición local y el reintento repara el mismo evento sin duplicarlo', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_version_cas_${suffix}`
  const appointmentId = `rstk_appt_google_version_cas_${suffix}`
  let db = null
  let googleCalendarService = null
  let injectedConcurrentEdit = false

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@negocio.test'
    const googleFetch = createGoogleApiFetchMock(googleRequests, {
      conflictOnDuplicateCreate: true,
      beforeCreateResponse: async ({ createAttempts }) => {
        if (createAttempts !== 1 || injectedConcurrentEdit) return
        injectedConcurrentEdit = true
        await db.run(`
          UPDATE appointments
          SET title = ?, notes = ?, google_sync_status = 'pending', date_updated = ?
          WHERE id = ?
        `, [
          'Versión local editada durante el POST',
          'Esta versión nueva es la que debe mandar',
          '2030-01-01T00:00:00.000Z',
          appointmentId
        ])
      }
    })
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')

    await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Agenda canónica con carrera de versión',
      googleCalendarId: 'ventas@test.com',
      googleAccessRole: 'owner',
      googleCalendarSummary: 'Ventas'
    }, { allowGoogleSyncMetadata: true })
    const outgoing = await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Versión local que salió primero',
      notes: 'Esta versión ya quedó vieja',
      startTime: '2027-08-18T18:00:00.000Z',
      endTime: '2027-08-18T19:00:00.000Z'
    })

    await assert.rejects(
      () => googleCalendarService.syncAppointmentToGoogle(outgoing),
      error => error?.code === 'appointment_provider_response_stale'
    )

    let preserved = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(preserved.title, 'Versión local editada durante el POST')
    assert.equal(preserved.notes, 'Esta versión nueva es la que debe mandar')
    assert.equal(preserved.googleEventId, null)
    assert.equal(preserved.googleSyncStatus, 'pending')

    // El POST anterior sí alcanzó a crear el ID determinista en Google. El
    // reintento recibe 409, recupera ese mismo evento y lo corrige con PATCH.
    const repaired = await googleCalendarService.syncAppointmentToGoogle(preserved)
    const deterministicEventId = googleCalendarService.googleAppointmentEventIdForLocalAppointment(appointmentId)
    assert.equal(repaired.appointment.googleEventId, deterministicEventId)
    assert.equal(repaired.appointment.googleSyncStatus, 'synced')
    assert.equal(repaired.event.summary, 'Versión local editada durante el POST')
    assert.equal(repaired.event.description, 'Esta versión nueva es la que debe mandar')

    preserved = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(preserved.title, 'Versión local editada durante el POST')
    assert.equal(preserved.googleEventId, deterministicEventId)
    assert.equal(preserved.googleSyncStatus, 'synced')
    assert.deepEqual(
      googleRequests.map(request => request.method),
      ['POST', 'POST', 'GET', 'PATCH']
    )
  } finally {
    if (db) {
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

test('relink Google A→B retira primero el espejo viejo y conserva intacta la cita local', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_relink_${suffix}`
  const appointmentId = `rstk_appt_google_relink_${suffix}`
  let db = null
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@negocio.test'
    const googleFetch = createGoogleRelinkFetchMock(googleRequests, { failOldDeleteOnce: true })
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')

    await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Agenda canónica para relink',
      googleCalendarId: googleFetch.calendarA,
      googleAccessRole: 'owner',
      googleCalendarSummary: 'Google A'
    }, { allowGoogleSyncMetadata: true })
    const local = await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      title: 'Cita local que no se mueve',
      notes: 'Ristak conserva estos datos',
      startTime: '2026-08-18T18:00:00.000Z',
      endTime: '2026-08-18T19:00:00.000Z'
    })
    const created = await googleCalendarService.syncAppointmentToGoogle(local)
    const eventId = created.appointment.googleEventId
    assert.equal(created.appointment.googleProviderCalendarId, googleFetch.calendarA)
    assert.equal(googleFetch.eventsByCalendar.get(googleFetch.calendarA).size, 1)

    await googleCalendarService.updateLocalCalendarGoogleSync({
      calendarId,
      googleCalendarId: googleFetch.calendarB
    })
    const pendingMove = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(pendingMove.googleEventId, eventId)
    assert.equal(pendingMove.googleProviderCalendarId, googleFetch.calendarA)
    assert.equal(pendingMove.googleSyncStatus, 'pending')

    const failedMove = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(failedMove.failed, 1)
    assert.equal(googleFetch.eventsByCalendar.get(googleFetch.calendarA).size, 1)
    assert.equal(googleFetch.eventsByCalendar.get(googleFetch.calendarB).size, 0)
    const afterFailedMove = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(afterFailedMove.googleEventId, eventId)
    assert.equal(afterFailedMove.googleProviderCalendarId, googleFetch.calendarA)
    assert.equal(afterFailedMove.googleSyncStatus, 'error')

    const moved = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(moved.synced, 1)
    assert.equal(googleFetch.eventsByCalendar.get(googleFetch.calendarA).size, 0)
    assert.equal(googleFetch.eventsByCalendar.get(googleFetch.calendarB).size, 1)
    const finalAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(finalAppointment.id, appointmentId)
    assert.equal(finalAppointment.calendarId, calendarId)
    assert.equal(finalAppointment.title, 'Cita local que no se mueve')
    assert.equal(finalAppointment.notes, 'Ristak conserva estos datos')
    assert.equal(finalAppointment.startTime, '2026-08-18T18:00:00.000Z')
    assert.equal(finalAppointment.googleProviderCalendarId, googleFetch.calendarB)

    const stableRetry = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(stableRetry.total, 0)
    const writes = googleRequests.filter(request => request.method !== 'GET')
    assert.deepEqual(writes.map(request => request.method), ['POST', 'DELETE', 'DELETE', 'POST'])
    assert.match(writes[1].path, /calendar-a%40test\.com/)
    assert.match(writes[2].path, /calendar-a%40test\.com/)
    assert.match(writes[3].path, /calendar-b%40test\.com/)
  } finally {
    if (db) {
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

test('un tombstone viejo tras B→A→B no rota el espejo que todavía pertenece a A', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_stale_tombstone_${suffix}`
  const appointmentId = `rstk_appt_google_stale_tombstone_${suffix}`
  let db = null
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@negocio.test'
    const googleFetch = createGoogleRelinkFetchMock(googleRequests)
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')

    // Estado final de B→A→B: la agenda ya apunta otra vez a B, pero la cita
    // todavía registra A como dueño de su espejo mientras termina la migración.
    await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Agenda religada de vuelta a B',
      googleCalendarId: googleFetch.calendarB,
      googleAccessRole: 'owner',
      googleCalendarSummary: 'Google B'
    }, { allowGoogleSyncMetadata: true })
    const eventId = googleCalendarService.googleAppointmentEventIdForLocalAppointment(appointmentId, 3)
    await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      googleEventId: eventId,
      googleProviderCalendarId: googleFetch.calendarA,
      googleMirrorGeneration: 3,
      googleSyncStatus: 'pending',
      googleSyncError: 'Migración de A hacia B pendiente',
      title: 'Cita local con ownership en A',
      startTime: '2026-08-20T18:00:00.000Z',
      endTime: '2026-08-20T19:00:00.000Z'
    })

    // B conserva un tombstone de su espejo anterior con el mismo ID
    // determinista. Verlo no le da autoridad para invalidar el espejo de A.
    googleFetch.eventsByCalendar.get(googleFetch.calendarB).set(eventId, {
      id: eventId,
      status: 'cancelled',
      extendedProperties: {
        private: {
          ristakAppointmentId: appointmentId,
          ristakCalendarId: calendarId
        }
      }
    })

    const pulled = await googleCalendarService.syncGoogleEventsToLocal({
      calendarId,
      startTime: '2026-08-20T00:00:00.000Z',
      endTime: '2026-08-21T00:00:00.000Z'
    })
    assert.equal(pulled.deleted, 0)

    const preserved = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(preserved.googleEventId, eventId)
    assert.equal(preserved.googleProviderCalendarId, googleFetch.calendarA)
    assert.equal(preserved.googleMirrorGeneration, 3)
    assert.equal(preserved.googleSyncStatus, 'pending')
    assert.equal(preserved.googleSyncError, 'Migración de A hacia B pendiente')
    assert.equal(preserved.status, 'confirmed')
    assert.deepEqual(googleRequests.map(request => request.method), ['GET'])
  } finally {
    if (db) {
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

test('un dueño Google duplicado legacy bloquea outbound antes de cualquier fetch remoto', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const firstCalendarId = `rstk_cal_google_legacy_owner_a_${suffix}`
  const secondCalendarId = `rstk_cal_google_legacy_owner_b_${suffix}`
  const appointmentId = `rstk_appt_google_legacy_owner_${suffix}`
  let db = null
  let googleCalendarService = null

  try {
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_google_oauth'
    process.env.LICENSE_KEY = 'RSTK-GOOGLE-TEST'
    process.env.INSTALLATION_ID = 'inst_google_oauth'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.OWNER_EMAIL = 'dueno@negocio.test'
    const googleFetch = createGoogleRelinkFetchMock(googleRequests)
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')

    await localCalendarService.createLocalCalendar({
      id: firstCalendarId,
      name: 'Dueño Google legítimo',
      googleCalendarId: googleFetch.calendarA,
      googleAccessRole: 'owner'
    }, { allowGoogleSyncMetadata: true })
    await localCalendarService.createLocalCalendar({
      id: secondCalendarId,
      name: 'Agenda legacy duplicada'
    })
    const appointment = await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId: firstCalendarId,
      title: 'No debe salir de Ristak',
      startTime: '2026-08-21T18:00:00.000Z',
      endTime: '2026-08-21T19:00:00.000Z'
    })

    // Bypass deliberado de las rutas protegidas para simular una BD creada por
    // una versión antigua que ya contiene dos dueños del mismo Google Calendar.
    await db.run(
      'UPDATE calendars SET raw_json = ? WHERE id = ?',
      [JSON.stringify({ googleCalendarId: googleFetch.calendarA }), secondCalendarId]
    )

    await assert.rejects(
      () => googleCalendarService.syncAppointmentToGoogle(appointment),
      error => error?.status === 409 && error?.code === 'duplicate_google_calendar_owner'
    )
    assert.equal(googleRequests.length, 0, 'el conflicto local debe detectarse antes de tocar Google')

    const local = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(local.googleEventId, null)
    assert.equal(local.googleProviderCalendarId, null)
    assert.equal(local.title, 'No debe salir de Ristak')
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [firstCalendarId, secondCalendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('OAuth Google conserva la cita local si alguien cancela sólo su espejo en Google', async () => {
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
    const googleFetch = createGoogleApiFetchMock(googleRequests, {
      cancelledAppointmentId: appointmentId,
      failCreateAmbiguouslyOnce: true
    })
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
    }, { allowGoogleSyncMetadata: true })

    await localCalendarService.createLocalAppointment({
      id: appointmentId,
      calendarId,
      googleEventId: 'evt_google_cancelled',
      // La comparación de ownership debe ser case-insensitive: Google puede
      // devolver el mismo ID con distinta capitalización en datos legacy.
      googleProviderCalendarId: 'VENTAS@TEST.COM',
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
    assert.equal(result.deleted, 0)
    assert.equal(result.linkedCalendars, 1)

    const preservedAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(preservedAppointment.status, 'confirmed')
    assert.equal(preservedAppointment.appointmentStatus, 'confirmed')
    assert.equal(preservedAppointment.googleEventId, null)
    assert.equal(preservedAppointment.googleProviderCalendarId, 'ventas@test.com')
    assert.equal(preservedAppointment.googleMirrorGeneration, 1)
    assert.equal(preservedAppointment.googleSyncStatus, 'pending')
    assert.match(preservedAppointment.googleSyncError || '', /copia de Google/i)

    const repaired = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(repaired.synced, 1)
    const repairedAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(
      repairedAppointment.googleEventId,
      googleCalendarService.googleAppointmentEventIdForLocalAppointment(appointmentId, 1)
    )
    assert.notEqual(repairedAppointment.googleEventId, 'evt_google_cancelled')
    assert.equal(repairedAppointment.googleSyncStatus, 'synced')
    assert.equal(repairedAppointment.status, 'confirmed')

    assert.equal(requests.length, 2)
    assert.equal(requests[0].path, '/api/license/oauth-handoff/claim')
    assert.equal(requests[1].path, '/api/license/google-calendar/refresh-token')
    assert.equal(googleRequests.length, 3)
    assert.equal(googleRequests[0].method, 'GET')
    assert.match(googleRequests[0].path, /showDeleted=true/)
    assert.equal(googleRequests[1].method, 'POST')
    assert.equal(googleRequests[2].method, 'GET')
    assert.match(googleRequests[2].path, new RegExp(`/events/${repairedAppointment.googleEventId}$`))
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
