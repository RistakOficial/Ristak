import test, { before, beforeEach, afterEach } from 'node:test'
import { mockRoutableEmailDns, resetEmailRecipientDns } from './helpers/emailRecipientDns.mjs'
import { setEmailRecipientResolverFactoryForTest } from '../src/services/emailRecipientService.js'
import assert from 'node:assert/strict'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { initializeMasterKey } from '../src/utils/encryption.js'
import { readFile } from 'node:fs/promises'

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
beforeEach(mockRoutableEmailDns)
afterEach(resetEmailRecipientDns)
before(async () => {
  const { db } = await import('../src/config/database.js')
  await db.exec(await readFile(new URL('../migrations/versioned/004_audit_log.sql', import.meta.url), 'utf8'))
})

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
  beforeCreateResponse = null,
  importedAttendee = null
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
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, body, ifMatch: headers['If-Match'] })

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
              end: { dateTime: '2026-06-17T19:00:00.000Z', timeZone: 'America/Mexico_City' },
              ...(importedAttendee ? { attendees: [importedAttendee] } : {})
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
        const event = { ...createdEvents.get(eventId), ...body, id: eventId }
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
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, body, ifMatch: headers['If-Match'] })

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
      if (events.has(body?.id)) return googleJson({ error: { message: 'already_exists' } }, 409)
      const event = { ...body, id: body?.id || `event-${randomUUID()}` }
      events.set(event.id, event)
      return googleJson(event)
    }
    if (method === 'PATCH') {
      if (!events.has(eventId)) return googleJson({ error: { message: 'not_found' } }, 404)
      const existing = events.get(eventId)
      if (headers['If-Match'] && headers['If-Match'] !== existing.etag) {
        return googleJson({ error: { message: 'precondition_failed' } }, 412)
      }
      const event = { ...existing, ...body, id: eventId, etag: `"${randomUUID()}"` }
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

    assert.deepEqual(googleRequests.map(request => request.method), ['POST', 'GET', 'GET', 'PATCH', 'GET', 'DELETE', 'GET', 'DELETE', 'GET'])
    assert.match(googleRequests[0].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events\?sendUpdates=all$/)
    assert.equal(googleRequests[0].body.start.dateTime, '2026-06-15T18:00:00.000Z')
    assert.match(googleRequests[1].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}$`))
    assert.match(googleRequests[3].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}\\?sendUpdates=all$`))
    assert.equal(googleRequests[3].body.start.dateTime, '2026-06-16T20:00:00.000Z')
    assert.match(googleRequests[5].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}\\?sendUpdates=all$`))
    assert.match(googleRequests[7].path, new RegExp(`/calendar/v3/calendars/ventas%40test\\.com/events/${deterministicGoogleEventId}\\?sendUpdates=all$`))
    assert.match(googleRequests[8].path, /showDeleted=true/)

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

test('dos calendarios Ristak publican citas distintas en el mismo Google Calendar', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const firstCalendarId = `rstk_cal_google_legacy_owner_a_${suffix}`
  const secondCalendarId = `rstk_cal_google_legacy_owner_b_${suffix}`
  const firstAppointmentId = `rstk_appt_google_shared_a_${suffix}`
  const secondAppointmentId = `rstk_appt_google_shared_b_${suffix}`
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
      name: 'Segundo espejo Google',
      googleCalendarId: googleFetch.calendarA,
      googleAccessRole: 'owner'
    }, { allowGoogleSyncMetadata: true })
    const firstAppointment = await localCalendarService.createLocalAppointment({
      id: firstAppointmentId,
      calendarId: firstCalendarId,
      title: 'Cita de la agenda A',
      startTime: '2026-08-21T18:00:00.000Z',
      endTime: '2026-08-21T19:00:00.000Z'
    })
    const secondAppointment = await localCalendarService.createLocalAppointment({
      id: secondAppointmentId,
      calendarId: secondCalendarId,
      title: 'Cita de la agenda B',
      startTime: '2026-08-22T18:00:00.000Z',
      endTime: '2026-08-22T19:00:00.000Z'
    })

    await googleCalendarService.syncAppointmentToGoogle(firstAppointment)
    await googleCalendarService.syncAppointmentToGoogle(secondAppointment)

    assert.deepEqual(googleRequests.map(request => request.method), ['POST', 'POST'])
    assert.equal(googleFetch.eventsByCalendar.get(googleFetch.calendarA).size, 2)
    const firstLocal = await localCalendarService.getLocalAppointment(firstAppointmentId)
    const secondLocal = await localCalendarService.getLocalAppointment(secondAppointmentId)
    assert.equal(firstLocal.googleProviderCalendarId, googleFetch.calendarA)
    assert.equal(secondLocal.googleProviderCalendarId, googleFetch.calendarA)
    assert.notEqual(firstLocal.googleEventId, secondLocal.googleEventId)
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [firstAppointmentId, secondAppointmentId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [firstCalendarId, secondCalendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('borrar en Google cancela la cita Ristak sin borrar su historial ni recrear el evento', async () => {
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

    const outgoingSnapshot = await localCalendarService.createLocalAppointment({
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
    assert.equal(result.deleted, 1)
    assert.equal(result.linkedCalendars, 1)

    const preservedAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(preservedAppointment.status, 'cancelled')
    assert.equal(preservedAppointment.appointmentStatus, 'cancelled')
    assert.equal(preservedAppointment.googleEventId, 'evt_google_cancelled')
    assert.equal(preservedAppointment.googleProviderCalendarId, 'ventas@test.com')
    assert.equal(preservedAppointment.googleMirrorGeneration, 0)
    assert.equal(preservedAppointment.googleSyncStatus, 'synced')
    assert.equal(preservedAppointment.googleSyncError, null)
    assert.equal(preservedAppointment.title, 'Cita borrada en Google')
    assert.equal(preservedAppointment.startTime, outgoingSnapshot.startTime)

    const repaired = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(repaired.synced, 0)
    const repairedAppointment = await localCalendarService.getLocalAppointment(appointmentId)
    assert.equal(repairedAppointment.googleEventId, 'evt_google_cancelled')
    assert.equal(repairedAppointment.googleSyncStatus, 'synced')
    assert.equal(repairedAppointment.status, 'cancelled')
    const replay = await googleCalendarService.syncGoogleEventsToLocal({ calendarId })
    assert.equal(replay.deleted, 0)
    // Un trabajo encolado con el objeto anterior tampoco puede resucitarla.
    await googleCalendarService.syncAppointmentToGoogle(outgoingSnapshot)

    assert.equal(requests.length, 2)
    assert.equal(requests[0].path, '/api/license/oauth-handoff/claim')
    assert.equal(requests[1].path, '/api/license/google-calendar/refresh-token')
    assert.equal(googleRequests.length, 2)
    assert.equal(googleRequests[0].method, 'GET')
    assert.match(googleRequests[0].path, /showDeleted=true/)
    assert.equal(googleRequests.every(request => request.method === 'GET'), true)
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM audit_log WHERE entity_id = ? AND action = 'google_cancelled'", [appointmentId])).total, 1)
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

// Misma frontera OAuth/API que las pruebas anteriores; sin cuentas de Google ni
// envíos reales. La base de datos y los servicios locales sí se ejecutan completos.
async function withGoogleSafetyFixture(callback) {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer([])
  const googleRequests = []
  const googleFetch = createGoogleRelinkFetchMock(googleRequests)
  const { db } = await import('../src/config/database.js')
  const local = await import('../src/services/localCalendarService.js')
  const google = await import('../src/services/googleCalendarService.js')
  const calendarId = `rstk_cal_safety_${randomUUID()}`
  try {
    Object.assign(process.env, {
      LICENSE_SERVER_URL: baseUrl, CLIENT_ID: 'cli_google_oauth', LICENSE_KEY: 'RSTK-GOOGLE-TEST',
      INSTALLATION_ID: 'inst_google_oauth', APP_URL: 'https://demo.onrender.com',
      APP_VERSION: '1.0.0', OWNER_EMAIL: 'dueno@example.test'
    })
    global.fetch = (url, options) => String(url).startsWith(baseUrl) ? previousFetch(url, options) : googleFetch(url, options)
    await google.claimGoogleCalendarOAuthHandoff('google_handoff_test')
    await local.createLocalCalendar({ id: calendarId, name: 'Agenda segura', googleCalendarId: googleFetch.calendarA }, { allowGoogleSyncMetadata: true })
    const create = changes => local.createLocalAppointment({
      id: `rstk_appt_safety_${randomUUID()}`, calendarId, title: 'Cita segura',
      startTime: '2030-09-01T17:00:00.000Z', endTime: '2030-09-01T18:00:00.000Z',
      ...changes
    })
    await callback({ db, local, google, create, calendarId, googleRequests, googleFetch,
      providerId: googleFetch.calendarA, events: googleFetch.eventsByCalendar.get(googleFetch.calendarA) })
  } finally {
    const rows = await db.all('SELECT id FROM appointments WHERE calendar_id = ?', [calendarId])
    for (const row of rows) {
      await db.run('DELETE FROM audit_log WHERE entity_id = ?', [row.id])
      await local.deleteLocalAppointment(row.id)
    }
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId])
    await google.deleteGoogleCalendarConfig()
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
}

function mockMixedRecipientDns() {
  setEmailRecipientResolverFactoryForTest(() => ({
    resolveMx: async domain => [{ exchange: domain === 'bien.com' ? '0.0.0.0.' : 'mail.example.test' }],
    resolve4: async () => ['192.0.2.25'], resolve6: async () => []
  }))
}
const mixedParticipants = [
  { role: 'requester', name: 'Correo inválido', email: 'bien@bien.com' },
  { role: 'primary_attendee', name: 'Correo válido', email: 'bueno@example.test' }
]

test('Google crea la cita sin invitar al correo imposible y sí invita al bueno una sola vez', async () => {
  mockMixedRecipientDns()
  await withGoogleSafetyFixture(async ({ google, local, create, calendarId, googleRequests }) => {
    const appointment = await create({ participants: mixedParticipants })
    const result = await google.syncAppointmentToGoogle(appointment)
    assert.deepEqual(result.event.attendees.map(item => item.email), ['bueno@example.test'])
    assert.equal(result.excludedRecipients[0].email, 'bien@bien.com')
    assert.equal((await local.getLocalAppointment(appointment.id)).participants.some(item => item.email === 'bien@bien.com'), true)
    assert.equal((await google.syncLocalAppointmentsToGoogle({ calendarId })).total, 0)
    await google.syncAppointmentToGoogle(appointment)
    assert.deepEqual(googleRequests.map(request => request.method), ['POST', 'GET'])
    assert.match(googleRequests[0].path, /sendUpdates=all$/)
  })
})

test('antes de editar o borrar un evento legado retira el correo malo sin notificarle y avisa al resto', async () => {
  mockMixedRecipientDns()
  await withGoogleSafetyFixture(async ({ google, local, create, providerId, events, googleRequests }) => {
    const appointment = await create({ participants: mixedParticipants, googleEventId: 'legacy-event', googleProviderCalendarId: providerId })
    const legacy = { id: 'legacy-event', ...google.buildGoogleEventPayload(appointment), summary: 'Título anterior', etag: '"legacy-v1"' }
    events.set(legacy.id, legacy)
    await google.syncAppointmentToGoogle(appointment)
    assert.deepEqual(googleRequests.map(request => request.method), ['GET', 'PATCH', 'PATCH'])
    assert.match(googleRequests[1].path, /sendUpdates=none$/)
    assert.equal(googleRequests[1].ifMatch, '"legacy-v1"')
    assert.deepEqual(googleRequests[1].body.attendees.map(item => item.email), ['bueno@example.test'])
    assert.match(googleRequests[2].path, /sendUpdates=all$/)
    assert.deepEqual(googleRequests[2].body.attendees.map(item => item.email), ['bueno@example.test'])

    events.set(legacy.id, legacy)
    googleRequests.length = 0
    const cancelled = await local.updateLocalAppointment(appointment.id, { status: 'cancelled', appointmentStatus: 'cancelled' })
    await google.deleteGoogleEventForAppointment(cancelled)
    assert.deepEqual(googleRequests.map(request => request.method), ['GET', 'PATCH', 'DELETE'])
    assert.match(googleRequests[1].path, /sendUpdates=none$/)
    assert.match(googleRequests[2].path, /sendUpdates=all$/)
    assert.equal(events.has(legacy.id), false)
  })
})

test('una caída DNS deja pendiente la invitación y no pierde participantes ni publica a medias', async () => {
  setEmailRecipientResolverFactoryForTest(() => ({ resolveMx: async () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' }) } }))
  await withGoogleSafetyFixture(async ({ google, local, create, googleRequests }) => {
    const appointment = await create({ participants: mixedParticipants })
    await assert.rejects(google.syncAppointmentToGoogle(appointment), error => error.code === 'email_recipient_dns_unavailable')
    assert.equal(googleRequests.length, 0)
    const stored = await local.getLocalAppointment(appointment.id)
    assert.equal(stored.googleSyncStatus, 'error')
    assert.equal(stored.participants.length, 2)
    assert.equal(stored.appointmentStatus, 'confirmed')
  })
})

test('el push detecta el evento cancelado antes de PATCH y no lo resucita', async () => {
  await withGoogleSafetyFixture(async ({ google, create, providerId, events, googleRequests }) => {
    const appointment = await create({ googleEventId: 'cancelled-event', googleProviderCalendarId: providerId })
    events.set('cancelled-event', {
      id: 'cancelled-event', status: 'cancelled',
      extendedProperties: { private: { ristakCalendarId: 'previous-local-calendar' } }
    })
    const result = await google.syncAppointmentToGoogle(appointment)
    assert.equal(result.appointment.appointmentStatus, 'cancelled')
    await google.syncAppointmentToGoogle(appointment)
    assert.deepEqual(googleRequests.map(request => request.method), ['GET'])
  })
})

test('un 404 no autoriza cancelar la cita local ni crear otra copia en Google', async () => {
  await withGoogleSafetyFixture(async ({ google, local, create, providerId, googleRequests }) => {
    const appointment = await create({ googleEventId: 'unavailable-event', googleProviderCalendarId: providerId })
    await assert.rejects(google.syncAppointmentToGoogle(appointment), error => error.status === 404)
    const stored = await local.getLocalAppointment(appointment.id)
    assert.equal(stored.appointmentStatus, 'confirmed')
    assert.equal(stored.googleEventId, 'unavailable-event')
    assert.equal(stored.googleMirrorGeneration, 0)
    assert.deepEqual(googleRequests.map(request => request.method), ['GET'])
  })
})

test('If-Match protege una cancelación ocurrida entre la lectura y el PATCH', async () => {
  await withGoogleSafetyFixture(async ({ google, create, providerId, calendarId, events, googleRequests }) => {
    const appointment = await create({ googleEventId: 'race-event', googleProviderCalendarId: providerId })
    events.set('race-event', { id: 'race-event', ...google.buildGoogleEventPayload(appointment), summary: 'Título anterior', etag: '"before"' })
    const originalFetch = global.fetch
    let raced = false
    global.fetch = async (url, options = {}) => {
      const result = await originalFetch(url, options)
      if (!raced && String(url).endsWith('/events/race-event') && (!options.method || options.method === 'GET')) {
        raced = true
        events.set('race-event', { id: 'race-event', status: 'cancelled', etag: '"after"' })
      }
      return result
    }
    await assert.rejects(google.syncAppointmentToGoogle(appointment), error => error.status === 412)
    assert.equal(events.get('race-event').status, 'cancelled')
    const pulled = await google.syncGoogleEventsToLocal({ calendarId })
    assert.equal(pulled.deleted, 1)
    assert.equal(googleRequests.some(request => request.method === 'POST'), false)
  })
})

test('un POST ambiguo que reconcilia un evento ya cancelado no cambia de generación para invitar de nuevo', async () => {
  await withGoogleSafetyFixture(async ({ google, create, events, calendarId, googleRequests }) => {
    const appointment = await create({})
    const eventId = google.googleAppointmentEventIdForLocalAppointment(appointment.id)
    events.set(eventId, { id: eventId, status: 'cancelled' })
    const result = await google.syncAppointmentToGoogle(appointment)
    assert.equal(result.appointment.appointmentStatus, 'cancelled')
    assert.equal(result.appointment.googleMirrorGeneration, 0)
    assert.equal((await google.syncLocalAppointmentsToGoogle({ calendarId })).total, 0)
    assert.deepEqual(googleRequests.map(request => request.method), ['POST', 'GET'])
  })
})

test('un PATCH aplicado con respuesta perdida se reconcilia sin volver a notificar', async () => {
  await withGoogleSafetyFixture(async ({ google, create, providerId, events, googleRequests }) => {
    const appointment = await create({ googleEventId: 'lost-response', googleProviderCalendarId: providerId })
    events.set('lost-response', { id: 'lost-response', ...google.buildGoogleEventPayload(appointment), summary: 'Título anterior', etag: '"old"' })
    const originalFetch = global.fetch
    let lost = false
    global.fetch = async (url, options = {}) => {
      const result = await originalFetch(url, options)
      if (!lost && options.method === 'PATCH') {
        lost = true
        return googleJson({ error: { message: 'response_lost_after_commit' } }, 503)
      }
      return result
    }
    await assert.rejects(google.syncAppointmentToGoogle(appointment), error => error.status === 503)
    const recovered = await google.syncAppointmentToGoogle(appointment)
    assert.equal(recovered.appointment.googleSyncStatus, 'synced')
    assert.deepEqual(googleRequests.map(request => request.method), ['GET', 'PATCH', 'GET'])
  })
})

test('una respuesta vieja no marca pendiente una cancelación aunque comparta timestamp local', async () => {
  await withGoogleSafetyFixture(async ({ db, google, local, create, providerId, events, googleRequests }) => {
    const appointment = await create({ googleEventId: 'same-timestamp', googleProviderCalendarId: providerId })
    events.set('same-timestamp', { id: 'same-timestamp', ...google.buildGoogleEventPayload(appointment), etag: '"before"' })
    const originalFetch = global.fetch
    let raced = false
    global.fetch = async (url, options = {}) => {
      const result = await originalFetch(url, options)
      if (!raced && String(url).endsWith('/events/same-timestamp')) {
        raced = true
        await db.run("UPDATE appointments SET status = 'cancelled', appointment_status = 'cancelled', google_sync_status = 'synced' WHERE id = ?", [appointment.id])
        events.set('same-timestamp', { id: 'same-timestamp', status: 'cancelled', etag: '"after"' })
      }
      return result
    }
    await assert.rejects(google.syncAppointmentToGoogle(appointment), error => error.code === 'appointment_provider_response_stale')
    const current = await local.getLocalAppointment(appointment.id)
    assert.equal(current.dateUpdated, appointment.dateUpdated)
    assert.equal(current.appointmentStatus, 'cancelled')
    assert.equal(current.googleSyncStatus, 'synced')
    assert.deepEqual(googleRequests.map(request => request.method), ['GET'])
  })
})

test('OAuth Google bloquea horarios sin crear contactos cuando el calendario lo desactiva', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_guest_import_${suffix}`
  const importedGuestEmail = `google-disabled-guest-${suffix}@example.test`
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
      importedAttendee: {
        email: importedGuestEmail,
        displayName: 'Invitado que no entra al CRM'
      }
    })
    global.fetch = (url, options) => String(url).startsWith(baseUrl)
      ? previousFetch(url, options)
      : googleFetch(url, options)

    ;({ db } = await import('../src/config/database.js'))
    const localCalendarService = await import('../src/services/localCalendarService.js')
    googleCalendarService = await import('../src/services/googleCalendarService.js')
    await googleCalendarService.claimGoogleCalendarOAuthHandoff('google_handoff_test')

    const calendar = await localCalendarService.createLocalCalendar({
      id: calendarId,
      name: 'Agenda que sólo bloquea horarios'
    })
    assert.equal(calendar.googleGuestContactImportEnabled, false)

    await googleCalendarService.updateLocalCalendarGoogleSync({
      calendarId,
      googleCalendarId: 'ventas@test.com'
    })

    const firstSync = await googleCalendarService.syncGoogleEventsToLocal({
      calendarId,
      startTime: '2026-06-17T00:00:00.000Z',
      endTime: '2026-06-18T00:00:00.000Z'
    })
    assert.equal(firstSync.saved, 1)

    const blockingAppointment = await db.get(`
      SELECT calendar_id, contact_id, source
      FROM appointments
      WHERE google_event_id = ?
    `, ['evt_google_imported'])
    assert.equal(blockingAppointment.calendar_id, calendarId)
    assert.equal(blockingAppointment.source, 'google')
    assert.equal(blockingAppointment.contact_id, null)
    assert.equal(
      (await db.get('SELECT COUNT(*) AS total FROM contacts WHERE LOWER(email) = LOWER(?)', [importedGuestEmail])).total,
      0
    )

    const enabled = await localCalendarService.updateLocalCalendar(calendarId, {
      googleGuestContactImportEnabled: true
    })
    assert.equal(enabled.googleGuestContactImportEnabled, true)

    const secondSync = await googleCalendarService.syncGoogleEventsToLocal({
      calendarId,
      startTime: '2026-06-17T00:00:00.000Z',
      endTime: '2026-06-18T00:00:00.000Z'
    })
    assert.equal(secondSync.saved, 1)

    const linkedAppointment = await db.get(
      'SELECT contact_id FROM appointments WHERE google_event_id = ?',
      ['evt_google_imported']
    )
    assert.ok(linkedAppointment.contact_id)
    assert.equal(
      (await db.get('SELECT COUNT(*) AS total FROM contacts WHERE LOWER(email) = LOWER(?)', [importedGuestEmail])).total,
      1
    )
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE LOWER(email) = LOWER(?)', [importedGuestEmail]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})

test('OAuth Google permite varios calendarios Ristak por destino sin duplicar la cita importada', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_linked_google_${suffix}`
  const mirrorCalendarId = `rstk_cal_linked_google_mirror_${suffix}`
  const importedGuestEmail = `google-guest-${suffix}@example.test`
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
    const googleFetch = createGoogleApiFetchMock(googleRequests, {
      importedAttendee: {
        email: importedGuestEmail,
        displayName: 'Contacto Google'
      }
    })
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
      name: 'Valoraciones Ristak',
      googleGuestContactImportEnabled: true
    })
    const mirrorCalendar = await localCalendarService.createLocalCalendar({
      id: mirrorCalendarId,
      name: 'Segundo calendario Ristak',
      googleGuestContactImportEnabled: true
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

    let mirrorStatusCode = 200
    let mirrorResponseBody = null
    await updateCalendarGoogleSync({
      params: { id: mirrorCalendar.id },
      body: { googleCalendarId: 'ventas@test.com' }
    }, {
      status(code) {
        mirrorStatusCode = code
        return this
      },
      json(payload) {
        mirrorResponseBody = payload
        return this
      }
    })
    assert.equal(mirrorStatusCode, 200)
    assert.equal(mirrorResponseBody.success, true)
    assert.equal(mirrorResponseBody.data.googleCalendarId, 'ventas@test.com')
    assert.equal(mirrorResponseBody.data.initialGoogleSync.saved, 2)

    const linkedCalendars = await localCalendarService.listGoogleLinkedLocalCalendars()
    assert.ok(linkedCalendars.some(item => item.id === calendarId && item.googleCalendarId === 'ventas@test.com'))
    assert.ok(linkedCalendars.some(item => item.id === mirrorCalendarId && item.googleCalendarId === 'ventas@test.com'))

    const importedAppointment = await db.get(
      'SELECT title, calendar_id, contact_id, google_event_id, source FROM appointments WHERE google_event_id = ?',
      ['evt_google_imported']
    )
    assert.equal(importedAppointment.title, 'Cita importada desde Google')
    assert.equal(importedAppointment.calendar_id, calendarId)
    assert.equal(importedAppointment.source, 'google')
    assert.ok(importedAppointment.contact_id)

    const occupancyShadow = await db.get(`
      SELECT calendar_id, contact_id, google_event_id, google_provider_calendar_id, source
      FROM appointments
      WHERE calendar_id = ? AND source = 'google_shadow'
    `, [mirrorCalendarId])
    assert.equal(occupancyShadow.calendar_id, mirrorCalendarId)
    assert.equal(occupancyShadow.contact_id, null)
    assert.equal(occupancyShadow.google_event_id, null)
    assert.equal(occupancyShadow.google_provider_calendar_id, 'ventas@test.com')
    assert.equal(occupancyShadow.source, 'google_shadow')
    assert.equal(
      (await db.get('SELECT COUNT(*) AS total FROM contacts WHERE LOWER(email) = LOWER(?)', [importedGuestEmail])).total,
      1
    )

    await googleCalendarService.updateLocalCalendarGoogleSync({
      calendarId,
      googleCalendarId: ''
    })
    const promotedSync = await googleCalendarService.syncGoogleEventsToLocal({
      calendarId: mirrorCalendarId,
      startTime: '2026-06-17T00:00:00.000Z',
      endTime: '2026-06-18T00:00:00.000Z'
    })
    assert.equal(promotedSync.saved, 1)
    const promotedAppointment = await db.get(`
      SELECT calendar_id, contact_id, google_event_id, source
      FROM appointments
      WHERE google_event_id = ?
    `, ['evt_google_imported'])
    assert.equal(promotedAppointment.calendar_id, mirrorCalendarId)
    assert.equal(promotedAppointment.source, 'google')
    assert.ok(promotedAppointment.contact_id)
    assert.equal(
      (await db.get("SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ? AND source = 'google_shadow'", [mirrorCalendarId])).total,
      0
    )
    assert.equal(
      (await db.get('SELECT COUNT(*) AS total FROM contacts WHERE LOWER(email) = LOWER(?)', [importedGuestEmail])).total,
      1
    )

    const defaultConfig = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', ['default_calendar_id'])
    const attributionConfig = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', ['attribution_calendar_ids'])
    assert.equal(defaultConfig.config_value, existingDefaultCalendarId)
    assert.deepEqual(JSON.parse(attributionConfig.config_value), previousAttributionIds)

    assert.equal(requests.length, 2)
    assert.equal(requests[0].path, '/api/license/oauth-handoff/claim')
    assert.equal(requests[1].path, '/api/license/google-calendar/refresh-token')
    assert.equal(googleRequests.length, 5)
    assert.equal(googleRequests[0].path, '/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true&minAccessRole=reader')
    assert.match(googleRequests[1].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events/)
    assert.match(googleRequests[1].path, /showDeleted=true/)
    assert.equal(googleRequests[2].path, '/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true&minAccessRole=reader')
    assert.match(googleRequests[3].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events/)
    assert.match(googleRequests[3].path, /showDeleted=true/)
    assert.match(googleRequests[4].path, /\/calendar\/v3\/calendars\/ventas%40test\.com\/events/)
    assert.match(googleRequests[4].path, /showDeleted=true/)
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE calendar_id IN (?, ?)', [calendarId, mirrorCalendarId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE LOWER(email) = LOWER(?)', [importedGuestEmail]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id IN (?, ?)', [calendarId, mirrorCalendarId]).catch(() => undefined)
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

test('mover una cita canónica desde Google reagenda el no-show y crea seguimiento si ya asistió', async () => {
  await initializeMasterKey()
  const previousEnv = snapshotEnv()
  const requests = []
  const googleRequests = []
  const previousFetch = global.fetch
  const { server, baseUrl } = await startLicenseServer(requests)
  const suffix = randomUUID()
  const calendarId = `rstk_cal_google_bidirectional_${suffix}`
  const contactId = `rstk_contact_google_bidirectional_${suffix}`
  const noShowAppointmentId = `rstk_appt_google_noshow_${suffix}`
  const attendedAppointmentId = `rstk_appt_google_attended_${suffix}`
  const staleAppointmentId = `rstk_appt_google_stale_${suffix}`
  const noShowEventId = `google_noshow_${suffix}`
  const attendedEventId = `google_attended_${suffix}`
  const staleEventId = `google_stale_${suffix}`
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
      id: calendarId,
      name: 'Agenda bidireccional',
      googleCalendarId: googleFetch.calendarA,
      googleAccessRole: 'owner',
      googleCalendarSummary: 'Google A',
      googleCalendarTimeZone: 'America/Ciudad_Juarez'
    }, { allowGoogleSyncMetadata: true })
    await db.run(
      'INSERT INTO contacts (id, full_name, email, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, 'Cliente de agenda bidireccional', `calendar-${suffix}@example.test`]
    )

    const participants = [
      { role: 'requester', contactId },
      { role: 'primary_attendee', contactId }
    ]
    await localCalendarService.createLocalAppointment({
      id: noShowAppointmentId,
      calendarId,
      contactId,
      participants,
      googleEventId: noShowEventId,
      googleProviderCalendarId: googleFetch.calendarA,
      googleSyncStatus: 'synced',
      title: 'Cita que no ocurrió',
      appointmentStatus: 'noshow',
      status: 'noshow',
      startTime: '2030-09-01T17:00:00.000Z',
      endTime: '2030-09-01T18:00:00.000Z',
      dateUpdated: '2030-09-01T18:05:00.000Z'
    }, { syncStatus: 'synced' })
    await localCalendarService.createLocalAppointment({
      id: attendedAppointmentId,
      calendarId,
      contactId,
      participants,
      googleEventId: attendedEventId,
      googleProviderCalendarId: googleFetch.calendarA,
      googleSyncStatus: 'synced',
      bookingOrigin: 'public_calendar',
      title: 'Videollamada realizada',
      appointmentStatus: 'showed',
      status: 'showed',
      startTime: '2030-09-02T17:00:00.000Z',
      endTime: '2030-09-02T18:00:00.000Z',
      dateUpdated: '2030-09-02T18:05:00.000Z'
    }, { syncStatus: 'synced' })
    await localCalendarService.createLocalAppointment({
      id: staleAppointmentId,
      calendarId,
      contactId,
      participants,
      googleEventId: staleEventId,
      googleProviderCalendarId: googleFetch.calendarA,
      googleSyncStatus: 'synced',
      title: 'Edición local más nueva',
      appointmentStatus: 'confirmed',
      status: 'confirmed',
      startTime: '2030-09-03T17:00:00.000Z',
      endTime: '2030-09-03T18:00:00.000Z',
      dateUpdated: '2040-09-03T18:05:00.000Z'
    }, { syncStatus: 'synced' })

    const providerEvents = googleFetch.eventsByCalendar.get(googleFetch.calendarA)
    providerEvents.set(noShowEventId, {
      id: noShowEventId,
      summary: 'Cita que no ocurrió',
      status: 'confirmed',
      updated: '2031-09-01T20:00:00.000Z',
      start: { dateTime: '2031-09-05T17:00:00.000Z' },
      end: { dateTime: '2031-09-05T18:00:00.000Z' },
      extendedProperties: { private: { ristakAppointmentId: noShowAppointmentId, ristakCalendarId: calendarId } }
    })
    providerEvents.set(attendedEventId, {
      id: attendedEventId,
      summary: 'Videollamada realizada',
      status: 'confirmed',
      updated: '2031-09-02T20:00:00.000Z',
      start: { dateTime: '2031-09-08T17:00:00.000Z' },
      end: { dateTime: '2031-09-08T18:00:00.000Z' },
      extendedProperties: { private: { ristakAppointmentId: attendedAppointmentId, ristakCalendarId: calendarId } }
    })
    providerEvents.set(staleEventId, {
      id: staleEventId,
      summary: 'Edición remota vieja',
      status: 'confirmed',
      updated: '2039-09-03T20:00:00.000Z',
      start: { dateTime: '2031-09-09T17:00:00.000Z' },
      end: { dateTime: '2031-09-09T18:00:00.000Z' },
      extendedProperties: { private: { ristakAppointmentId: staleAppointmentId, ristakCalendarId: calendarId } }
    })

    const firstSync = await googleCalendarService.syncGoogleEventsToLocal({
      calendarId,
      startTime: '2030-01-01T00:00:00.000Z',
      endTime: '2032-01-01T00:00:00.000Z'
    })
    assert.equal(firstSync.saved, 3)

    const rescheduledNoShow = await localCalendarService.getLocalAppointment(noShowAppointmentId)
    assert.equal(rescheduledNoShow.appointmentStatus, 'rescheduled')
    assert.equal(rescheduledNoShow.startTime, '2031-09-05T17:00:00.000Z')
    assert.equal(rescheduledNoShow.googleEventId, noShowEventId)

    const attendedHistory = await localCalendarService.getLocalAppointment(attendedAppointmentId)
    assert.equal(attendedHistory.appointmentStatus, 'showed')
    assert.equal(attendedHistory.startTime, '2030-09-02T17:00:00.000Z')
    assert.equal(attendedHistory.googleEventId, null)
    assert.equal(attendedHistory.googleSyncStatus, 'history_only')

    const followUpRow = await db.get(
      'SELECT id FROM appointments WHERE follow_up_from_appointment_id = ?',
      [attendedAppointmentId]
    )
    assert.ok(followUpRow?.id)
    const followUp = await localCalendarService.getLocalAppointment(followUpRow.id)
    assert.equal(followUp.appointmentStatus, 'confirmed')
    assert.equal(followUp.startTime, '2031-09-08T17:00:00.000Z')
    assert.equal(followUp.googleEventId, attendedEventId)
    assert.equal(followUp.followUpFromAppointmentId, attendedAppointmentId)
    assert.equal(followUp.bookingOrigin, 'public_calendar')
    assert.equal(followUp.participants.length, 2)
    assert.equal(followUp.participants.every(participant => participant.contactId === contactId), true)

    const repairedRemoteFollowUp = providerEvents.get(attendedEventId)
    assert.equal(repairedRemoteFollowUp.extendedProperties.private.ristakAppointmentId, followUp.id)
    assert.equal(repairedRemoteFollowUp.extendedProperties.private.ristakCalendarId, calendarId)

    const staleLocal = await localCalendarService.getLocalAppointment(staleAppointmentId)
    assert.equal(staleLocal.startTime, '2030-09-03T17:00:00.000Z')
    assert.equal(staleLocal.appointmentStatus, 'confirmed')
    assert.equal(staleLocal.googleSyncStatus, 'pending')

    const outbound = await googleCalendarService.syncLocalAppointmentsToGoogle({ calendarId })
    assert.equal(outbound.total, 1, 'sólo la edición local vieja debe repararse; el historial atendido no se republica')

    await googleCalendarService.syncGoogleEventsToLocal({
      calendarId,
      startTime: '2030-01-01T00:00:00.000Z',
      endTime: '2032-01-01T00:00:00.000Z'
    })
    const rowsAfterReplay = await db.get(
      'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
      [calendarId]
    )
    assert.equal(Number(rowsAfterReplay.total), 4, 'un replay no debe crear otro seguimiento')
  } finally {
    if (db) {
      await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await googleCalendarService?.deleteGoogleCalendarConfig?.().catch(() => undefined)
    global.fetch = previousFetch
    server.closeAllConnections?.()
    server.close()
    restoreEnv(previousEnv)
  }
})
