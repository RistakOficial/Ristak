import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendRoot = join(__dirname, '..')

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
  assert.match(routesSource, /publicCalendarsRoutes\.post\('\/public\/:slug\/appointments'/)
  assert.equal(routesSource.includes("router.get('/public/:slug/free-slots'"), false)
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
