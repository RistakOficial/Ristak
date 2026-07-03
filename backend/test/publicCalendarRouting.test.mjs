import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DateTime } from 'luxon'
import { db } from '../src/config/database.js'
import { createPublicAppointment } from '../src/controllers/calendarsController.js'
import { createLocalCalendar } from '../src/services/localCalendarService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendRoot = join(__dirname, '..')

function createJsonResponse() {
  const response = {
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
  return response
}

test('public calendar booking routes stay behind the calendar feature gate', async () => {
  const serverSource = await readFile(join(backendRoot, 'src/server.js'), 'utf8')
  const publicMount = "app.use('/api/calendars', requireFeature('google_calendar'), publicCalendarsRoutes)"
  const gatedMount = "app.use('/api/calendars', requireFeature('google_calendar'), calendarsRoutes)"

  assert.ok(serverSource.includes("import calendarsRoutes, { publicCalendarsRoutes }"), 'server imports public calendar routes')
  assert.ok(serverSource.includes(publicMount), 'server gates public calendar routes')
  assert.ok(serverSource.includes(gatedMount), 'server keeps private calendar routes behind the feature gate')
  assert.ok(
    serverSource.indexOf(publicMount) < serverSource.indexOf(gatedMount),
    'public calendar routes must run before the protected calendar router'
  )
})

test('public calendar endpoints stay out of the protected calendars router', async () => {
  const routesSource = await readFile(join(backendRoot, 'src/routes/calendars.routes.js'), 'utf8')

  assert.match(routesSource, /export const publicCalendarsRoutes = express\.Router\(\)/)
  assert.match(routesSource, /publicCalendarsRoutes\.get\('\/public\/:slug\/free-slots'/)
  assert.match(routesSource, /publicCalendarsRoutes\.get\('\/public\/:slug\/contact-prefill'/)
  assert.match(routesSource, /publicCalendarsRoutes\.post\('\/public\/:slug\/appointments'/)
  assert.equal(routesSource.includes("router.get('/public/:slug/free-slots'"), false)
  assert.equal(routesSource.includes("router.get('/public/:slug/contact-prefill'"), false)
  assert.equal(routesSource.includes("router.post('/public/:slug/appointments'"), false)
})

test('public calendar widget keeps the month visible while slots load or fail', async () => {
  const serviceSource = await readFile(join(backendRoot, 'src/services/localCalendarService.js'), 'utf8')

  assert.match(
    serviceSource,
    /const loadSlots = async \(\) => \{\n\s+renderMonth\(\);\n\s+setLoading\(true\);/,
    'widget should paint the visible month before the availability request finishes'
  )
  assert.match(
    serviceSource,
    /catch \(error\) \{\n\s+slotsByDate = new Map\(\);\n\s+renderMonth\(\);/,
    'widget should keep date cells visible when availability fails'
  )
  assert.equal(serviceSource.includes("daysEl.innerHTML = '';"), false)
})

test('public calendar widget highlights the nearest selectable date after slots load', async () => {
  const serviceSource = await readFile(join(backendRoot, 'src/services/localCalendarService.js'), 'utf8')

  assert.match(
    serviceSource,
    /\.day\.today\.available:not\(\.selected\)/,
    'today should only look highlighted when it is actually selectable'
  )
  assert.match(
    serviceSource,
    /const getNearestAvailableDateKey = \(\) => Array\.from\(slotsByDate\.keys\(\)\)\n\s+\.filter\(isSelectableDateKey\)\n\s+\.sort\(\)\[0\] \|\| '';/,
    'widget should find the first available future date in the visible month'
  )
  assert.match(
    serviceSource,
    /selectedDateKey = getNearestAvailableDateKey\(\);\n\s+renderMonth\(\);\n\s+renderSlotsForDate\(''\);/,
    'widget should paint the selected day without jumping into the slot step'
  )
})

test('public calendar free slots use Ristak local availability only', async () => {
  const controllerSource = await readFile(join(backendRoot, 'src/controllers/calendarsController.js'), 'utf8')
  const match = controllerSource.match(/async function getCalendarFreeSlotsForPublic[\s\S]*?\n}\n\n\/\*\*/)
  assert.ok(match, 'public free slots helper should exist')
  const helperSource = match[0]

  assert.match(helperSource, /return localCalendarService\.getLocalFreeSlots\(/)
  assert.equal(helperSource.includes('syncGoogleEventsForDateRange'), false)
  assert.equal(helperSource.includes('calendarService.getFreeSlots'), false)
  assert.equal(helperSource.includes('ghlCalendarId'), false)
  assert.equal(helperSource.includes('accessToken'), false)
})

test('public calendar widget can prefill contact fields from a previous site submission', async () => {
  const controllerSource = await readFile(join(backendRoot, 'src/controllers/calendarsController.js'), 'utf8')
  const calendarSource = await readFile(join(backendRoot, 'src/services/localCalendarService.js'), 'utf8')
  const sitesSource = await readFile(join(backendRoot, 'src/services/sitesService.js'), 'utf8')
  const sitesRoutesSource = await readFile(join(backendRoot, 'src/routes/sites.routes.js'), 'utf8')
  const sitesControllerSource = await readFile(join(backendRoot, 'src/controllers/sitesController.js'), 'utf8')

  assert.match(controllerSource, /export async function getPublicContactPrefill/)
  assert.match(controllerSource, /resolvePublicPrefillContact/)
  assert.match(sitesSource, /export async function resolvePublicPrefillContact/)
  assert.match(sitesSource, /WHERE contact_id = \?/)
  assert.match(sitesSource, /WHERE s\.session_id = \?/)
  assert.match(sitesSource, /WHERE visitor_id = \?/)
  assert.match(calendarSource, /data-system-field-key=/)
  assert.match(calendarSource, /contact-prefill\?/)
  assert.match(calendarSource, /if \(urlHasContact && !stored\.contactId\) return/)
  assert.match(calendarSource, /const resolved = urlHasContact/)
  assert.match(calendarSource, /applyContactPrefill\(resolved\)/)
  assert.match(calendarSource, /rememberCalendarContact\(payload\.data\?\.contact\)/)
  assert.match(calendarSource, /contactId: activeContact\.contactId \|\| ''/)
  assert.match(calendarSource, /visitorId: activeContact\.visitorId \|\| ''/)
  assert.match(calendarSource, /sessionId: activeContact\.sessionId \|\| ''/)
  assert.match(controllerSource, /resolveTrustedPublicCalendarContactId/)
  assert.match(sitesRoutesSource, /router\.get\('\/public\/contact-prefill'/)
  assert.match(sitesControllerSource, /export async function publicSiteContactPrefillHandler/)
  assert.match(sitesSource, /const readUrlContact = \(\) =>/)
  assert.match(sitesSource, /const rememberContactDraftFromRoot = \(root\) =>/)
  assert.match(sitesSource, /window\.ristakNativeRememberContactDraft = rememberContactDraftFromRoot/)
  assert.match(sitesSource, /const resolved = urlHasContact/)
  assert.match(sitesSource, /if \(target\.searchParams\.get\(key\) === text\) return/)
  assert.match(sitesSource, /addParam\('full_name', contact\.fullName \|\| contact\.name\)/)
  assert.match(sitesSource, /addParam\('phone_number', contact\.phone\)/)
  assert.match(sitesSource, /window\.ristakNativeInitContactPrefill/)
  assert.match(sitesSource, /data-system-field-key=/)
  assert.match(sitesSource, /initImportedContactPrefill/)
  assert.match(sitesSource, /initGateContactPrefill/)
  assert.match(calendarSource, /const readUrlContact = \(\) =>/)
  assert.match(calendarSource, /const rememberCalendarContactDraft = \(\) =>/)
  assert.match(calendarSource, /appendContactPrefillParams\(completionRedirectUrl\)/)
  assert.match(calendarSource, /form\.reset\(\);\n\s+\/\/ Availability reloads reset the form; restore known contact data immediately after\.\n\s+applyContactPrefill\(readStoredContact\(\)\);/)
  assert.match(calendarSource, /name: pick\(\['full_name', 'fullName', 'full-name', 'fullname', 'name', 'nombre', 'nombre_completo', 'contact_name', 'contactName', 'rstk_name', 'rstk_full_name'\]\)/)
  assert.match(calendarSource, /phone: pick\(\['phone_number', 'phoneNumber', 'phone-number', 'phone', 'telefono', 'celular', 'whatsapp', 'contact_phone', 'contactPhone', 'rstk_phone'\]\)/)
  assert.match(sitesSource, /name: pick\(\['full_name', 'fullName', 'full-name', 'fullname', 'name', 'nombre', 'nombre_completo', 'contact_name', 'contactName', 'rstk_name', 'rstk_full_name'\]\)/)
  assert.match(sitesSource, /phone: pick\(\['phone_number', 'phoneNumber', 'phone-number', 'phone', 'telefono', 'celular', 'whatsapp', 'contact_phone', 'contactPhone', 'rstk_phone'\]\)/)
  assert.match(calendarSource, /phone_number/)
  assert.match(sitesSource, /phone: submission\.contactPhone \|\| ''/)
})

test('public calendar booking reuses an existing email contact when phone belongs to another contact', async () => {
  const suffix = randomUUID()
  const calendarSlug = `public-email-existing-${suffix}`
  const calendarIds = []
  const contactIds = [
    `manual_contact_email_${suffix}`,
    `manual_contact_phone_${suffix}`
  ]
  const email = `public-calendar-existing-${suffix}@example.test`
  const phoneInput = '6567426612'
  const normalizedPhone = '+526567426612'
  const baseDay = DateTime.utc().plus({ days: 30 }).startOf('day')
  const nextMonday = baseDay.plus({ days: (1 - baseDay.weekday + 7) % 7 })
  const slotStart = nextMonday.set({ hour: 15, minute: 0 })

  try {
    const calendar = await createLocalCalendar({
      slug: calendarSlug,
      widgetSlug: calendarSlug,
      name: 'Calendario contacto existente',
      slotDuration: 60,
      slotInterval: 60,
      autoConfirm: true,
      openHours: [
        {
          daysOfTheWeek: [1],
          hours: [{ openHour: 15, openMinute: 0, closeHour: 17, closeMinute: 0 }]
        }
      ]
    })
    calendarIds.push(calendar.id)

    await db.run(
      'INSERT INTO contacts (id, email, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactIds[0], email, 'Contacto por correo', 'manual']
    )
    await db.run(
      'INSERT INTO contacts (id, phone, full_name, source, created_at, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactIds[1], normalizedPhone, 'Contacto por telefono', 'manual']
    )

    const req = {
      params: { slug: calendarSlug },
      query: {},
      body: {
        startTime: slotStart.toISO(),
        timezone: 'UTC',
        name: 'RAUL GOMEZ',
        phone: phoneInput,
        email,
        sourceUrl: `http://localhost:3001/calendar/${calendarSlug}`
      },
      headers: {
        host: 'localhost:3001',
        'user-agent': 'node-test'
      },
      hostname: 'localhost',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }
    const res = createJsonResponse()

    await createPublicAppointment(req, res)

    assert.equal(res.statusCode, 201)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.appointment?.contactId, contactIds[0])

    const storedEmailContact = await db.get(
      'SELECT id, email, phone FROM contacts WHERE id = ?',
      [contactIds[0]]
    )
    assert.equal(storedEmailContact.email, email)
    assert.equal(storedEmailContact.phone, normalizedPhone)

    const appointments = await db.all(
      'SELECT id FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [calendar.id, contactIds[0]]
    )
    assert.equal(appointments.length, 1)
  } finally {
    for (const calendarId of calendarIds) {
      await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id IN (?, ?)', contactIds).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', contactIds).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email = ?', [email]).catch(() => undefined)
  }
})

test('public calendar booking keeps the active form contact when calendar email changes', async () => {
  const suffix = randomUUID()
  const calendarSlug = `public-active-contact-${suffix}`
  const contactId = `active_form_contact_${suffix}`
  const visitorId = `visitor_active_contact_${suffix}`
  const oldEmail = `active-old-${suffix}@example.test`
  const newEmail = `active-new-${suffix}@example.test`
  const phoneInput = '6565558800'
  const normalizedPhone = '+526565558800'
  const calendarIds = []
  const baseDay = DateTime.utc().plus({ days: 35 }).startOf('day')
  const nextTuesday = baseDay.plus({ days: (2 - baseDay.weekday + 7) % 7 })
  const slotStart = nextTuesday.set({ hour: 11, minute: 0 })

  try {
    const calendar = await createLocalCalendar({
      slug: calendarSlug,
      widgetSlug: calendarSlug,
      name: 'Calendario contacto activo',
      slotDuration: 60,
      slotInterval: 60,
      autoConfirm: true,
      openHours: [
        {
          daysOfTheWeek: [2],
          hours: [{ openHour: 11, openMinute: 0, closeHour: 13, closeMinute: 0 }]
        }
      ]
    })
    calendarIds.push(calendar.id)

    await db.run(
      'INSERT INTO contacts (id, email, full_name, visitor_id, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [contactId, oldEmail, 'Contacto desde formulario', visitorId, 'ristak_site:formulario']
    )

    const req = {
      params: { slug: calendarSlug },
      query: {},
      body: {
        startTime: slotStart.toISO(),
        timezone: 'UTC',
        contactId,
        visitorId,
        name: 'Contacto Corregido',
        phone: phoneInput,
        email: newEmail,
        sourceUrl: `http://localhost:3001/calendar/${calendarSlug}`,
        meta: { contactId, visitorId }
      },
      headers: {
        host: 'localhost:3001',
        'user-agent': 'node-test'
      },
      hostname: 'localhost',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' }
    }
    const res = createJsonResponse()

    await createPublicAppointment(req, res)

    assert.equal(res.statusCode, 201)
    assert.equal(res.body?.success, true)
    assert.equal(res.body?.data?.appointment?.contactId, contactId)
    assert.equal(res.body?.data?.contact?.contactId, contactId)
    assert.equal(res.body?.data?.contact?.email, newEmail)

    const storedContact = await db.get(
      'SELECT id, email, phone, full_name FROM contacts WHERE id = ?',
      [contactId]
    )
    assert.equal(storedContact.email, newEmail)
    assert.equal(storedContact.phone, normalizedPhone)
    assert.equal(storedContact.full_name, 'Contacto Corregido')

    const appointments = await db.all(
      'SELECT id FROM appointments WHERE calendar_id = ? AND contact_id = ?',
      [calendar.id, contactId]
    )
    assert.equal(appointments.length, 1)
  } finally {
    for (const calendarId of calendarIds) {
      await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
      await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    }
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE email IN (?, ?)', [oldEmail, newEmail]).catch(() => undefined)
  }
})
