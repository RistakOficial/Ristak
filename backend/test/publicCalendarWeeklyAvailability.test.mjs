import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createPublicAppointment,
  getPublicFreeSlots
} from '../src/controllers/calendarsController.js'
import { createLocalCalendar } from '../src/services/localCalendarService.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

const BUSINESS_TIMEZONE = 'America/Ciudad_Juarez'
const VISITOR_TIMEZONE = 'Asia/Tokyo'
let previousAccountTimezone = null

before(async () => {
  previousAccountTimezone = await getAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY)
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, BUSINESS_TIMEZONE)
  invalidateTimezoneCache()
})

after(async () => {
  if (previousAccountTimezone === null) {
    await db.run('DELETE FROM app_config WHERE config_key = ?', [ACCOUNT_TIMEZONE_CONFIG_KEY])
  } else {
    await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, previousAccountTimezone)
  }
  invalidateTimezoneCache()
})

function createJsonResponse() {
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

function createPublicRequest(calendarSlug, { query = {}, body = {} } = {}) {
  const headers = {
    host: 'localhost:3001',
    'user-agent': 'node-test'
  }
  return {
    params: { slug: calendarSlug },
    query,
    body,
    headers,
    hostname: 'localhost',
    protocol: 'http',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
    get(name) {
      return headers[String(name || '').toLowerCase()] || ''
    }
  }
}

function nextTuesdayInBusinessTimezone() {
  const base = DateTime.now().setZone(BUSINESS_TIMEZONE).plus({ days: 40 }).startOf('day')
  return base.plus({ days: (2 - base.weekday + 7) % 7 })
}

async function createWeeklyFixture(label) {
  const suffix = randomUUID()
  const businessDay = nextTuesdayInBusinessTimezone()
  const slug = `public-weekly-${label}-${suffix}`
  const calendar = await createLocalCalendar({
    name: `Agenda pública semanal ${label}`,
    slug,
    widgetSlug: slug,
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    appoinmentPerSlot: 1,
    allowBookingAfter: 0,
    allowBookingAfterUnit: 'hours',
    allowBookingFor: 365,
    allowBookingForUnit: 'days',
    autoConfirm: true,
    openHours: [{
      daysOfTheWeek: [2],
      hours: [{ openHour: 13, openMinute: 0, closeHour: 16, closeMinute: 0 }]
    }]
  })

  return {
    businessDay,
    calendarId: calendar.id,
    dateKey: businessDay.toISODate(),
    slug,
    emails: []
  }
}

async function cleanupWeeklyFixture(fixture) {
  await db.run('DELETE FROM appointment_participants WHERE appointment_id IN (SELECT id FROM appointments WHERE calendar_id = ?)', [fixture.calendarId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [fixture.calendarId]).catch(() => undefined)
  await db.run('DELETE FROM calendars WHERE id = ?', [fixture.calendarId]).catch(() => undefined)

  for (const email of fixture.emails) {
    const contact = await db.get('SELECT id FROM contacts WHERE email = ?', [email]).catch(() => null)
    if (!contact?.id) continue
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contact.id]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contact.id]).catch(() => undefined)
  }
}

function publicBookingBody(fixture, {
  start,
  email,
  name,
  phone
}) {
  fixture.emails.push(email)
  return {
    startTime: start.toISO(),
    timezone: VISITOR_TIMEZONE,
    name,
    email,
    phone,
    sourceUrl: `http://localhost:3001/calendar/${fixture.slug}`
  }
}

test('la URL pública calcula 13–16 en la zona del negocio y sólo convierte para el visitante', async (t) => {
  const fixture = await createWeeklyFixture('timezone')
  t.after(() => cleanupWeeklyFixture(fixture))

  const businessResponse = createJsonResponse()
  await getPublicFreeSlots(createPublicRequest(fixture.slug, {
    query: {
      startDate: fixture.dateKey,
      endDate: fixture.dateKey,
      timezone: BUSINESS_TIMEZONE
    }
  }), businessResponse)

  const visitorResponse = createJsonResponse()
  await getPublicFreeSlots(createPublicRequest(fixture.slug, {
    query: {
      startDate: fixture.dateKey,
      endDate: fixture.dateKey,
      timezone: VISITOR_TIMEZONE
    }
  }), visitorResponse)

  assert.equal(businessResponse.statusCode, 200)
  assert.equal(visitorResponse.statusCode, 200)
  assert.deepEqual(visitorResponse.body?.data, businessResponse.body?.data)

  const selectedDaySlots = (visitorResponse.body?.data || [])
    .flatMap(day => Array.isArray(day?.slots) ? day.slots : [])
    .filter(slot => DateTime.fromISO(slot, { setZone: true }).setZone(BUSINESS_TIMEZONE).toISODate() === fixture.dateKey)

  const businessTimes = selectedDaySlots.map(slot => (
    DateTime.fromISO(slot, { setZone: true }).setZone(BUSINESS_TIMEZONE).toFormat('HH:mm')
  ))
  const visitorTimes = selectedDaySlots.map(slot => (
    DateTime.fromISO(slot, { setZone: true }).setZone(VISITOR_TIMEZONE).toFormat('yyyy-MM-dd HH:mm')
  ))

  assert.deepEqual(businessTimes, ['13:00', '14:00', '15:00'])
  assert.equal(visitorTimes.length, 3)
  assert.notDeepEqual(visitorTimes.map(value => value.slice(-5)), businessTimes)
})

test('la URL pública rechaza un POST falsificado fuera de openHours sin insertar cita', async (t) => {
  const fixture = await createWeeklyFixture('outside')
  t.after(() => cleanupWeeklyFixture(fixture))
  const email = `public-weekly-outside-${randomUUID()}@example.test`
  const response = createJsonResponse()

  await createPublicAppointment(createPublicRequest(fixture.slug, {
    body: publicBookingBody(fixture, {
      start: fixture.businessDay.set({ hour: 12 }),
      email,
      name: 'Horario Falsificado',
      phone: '6565559210'
    })
  }), response)

  assert.equal(response.statusCode, 409)
  assert.equal(response.body?.success, false)
  assert.match(response.body?.error || '', /no esta disponible|fuera del horario/i)

  const stored = await db.get(
    'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
    [fixture.calendarId]
  )
  assert.equal(Number(stored?.total || 0), 0)
})

test('la URL pública no acepta una hora casi igual a un slot antes de iniciar cobro o crear contacto', async (t) => {
  const fixture = await createWeeklyFixture('unaligned')
  t.after(() => cleanupWeeklyFixture(fixture))
  const email = `public-weekly-unaligned-${randomUUID()}@example.test`
  const response = createJsonResponse()

  await createPublicAppointment(createPublicRequest(fixture.slug, {
    body: publicBookingBody(fixture, {
      start: fixture.businessDay.set({ hour: 13, second: 30 }),
      email,
      name: 'Horario Casi Igual',
      phone: '6565559213'
    })
  }), response)

  assert.equal(response.statusCode, 409)
  const stored = await db.get(
    'SELECT COUNT(*) AS total FROM appointments WHERE calendar_id = ?',
    [fixture.calendarId]
  )
  assert.equal(Number(stored?.total || 0), 0)
  const contact = await db.get('SELECT id FROM contacts WHERE email = ?', [email])
  assert.equal(contact, null)
})

test('dos POST públicos concurrentes al mismo slot dejan una sola cita', async (t) => {
  const fixture = await createWeeklyFixture('race')
  t.after(() => cleanupWeeklyFixture(fixture))
  const start = fixture.businessDay.set({ hour: 13 })
  const firstResponse = createJsonResponse()
  const secondResponse = createJsonResponse()

  await Promise.all([
    createPublicAppointment(createPublicRequest(fixture.slug, {
      body: publicBookingBody(fixture, {
        start,
        email: `public-weekly-race-a-${randomUUID()}@example.test`,
        name: 'Reserva Concurrente A',
        phone: '6565559211'
      })
    }), firstResponse),
    createPublicAppointment(createPublicRequest(fixture.slug, {
      body: publicBookingBody(fixture, {
        start,
        email: `public-weekly-race-b-${randomUUID()}@example.test`,
        name: 'Reserva Concurrente B',
        phone: '6565559212'
      })
    }), secondResponse)
  ])

  const statuses = [firstResponse.statusCode, secondResponse.statusCode].sort((a, b) => a - b)
  assert.deepEqual(statuses, [201, 409])

  const stored = await db.all(
    'SELECT id, start_time FROM appointments WHERE calendar_id = ?',
    [fixture.calendarId]
  )
  assert.equal(stored.length, 1)
  assert.equal(new Date(stored[0].start_time).getTime(), start.toMillis())
})

test('la URL pública cubre el salto máximo de dos fechas entre UTC-12 y UTC+14', async (t) => {
  const extremeBusinessTimezone = 'Etc/GMT+12'
  const extremeVisitorTimezone = 'Pacific/Kiritimati'
  const suffix = randomUUID()
  const slug = `public-weekly-date-edge-${suffix}`
  let calendarId = ''

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, extremeBusinessTimezone)
  invalidateTimezoneCache()
  t.after(async () => {
    if (calendarId) {
      await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, BUSINESS_TIMEZONE)
    invalidateTimezoneCache()
  })

  const base = DateTime.now().setZone(extremeBusinessTimezone).plus({ days: 40 }).startOf('day')
  const businessMonday = base.plus({ days: (1 - base.weekday + 7) % 7 })
  const expectedSlot = businessMonday.set({ hour: 22 })
  const visitorDate = expectedSlot.setZone(extremeVisitorTimezone).toISODate()
  assert.equal(expectedSlot.toISODate(), businessMonday.toISODate())
  assert.equal(
    DateTime.fromISO(visitorDate).diff(DateTime.fromISO(businessMonday.toISODate()), 'days').days,
    2
  )

  const calendar = await createLocalCalendar({
    name: 'Agenda de borde internacional',
    slug,
    widgetSlug: slug,
    slotDuration: 60,
    slotDurationUnit: 'mins',
    slotInterval: 60,
    slotIntervalUnit: 'mins',
    allowBookingFor: 365,
    allowBookingForUnit: 'days',
    openHours: [{
      daysOfTheWeek: [1],
      hours: [{ openHour: 22, openMinute: 0, closeHour: 23, closeMinute: 0 }]
    }]
  })
  calendarId = calendar.id

  const response = createJsonResponse()
  await getPublicFreeSlots(createPublicRequest(slug, {
    query: {
      startDate: visitorDate,
      endDate: visitorDate,
      timezone: extremeVisitorTimezone
    }
  }), response)

  assert.equal(response.statusCode, 200)
  const returnedSlots = (response.body?.data || []).flatMap(day => day?.slots || [])
  assert.ok(returnedSlots.some(slot => new Date(slot).getTime() === expectedSlot.toMillis()))
})
