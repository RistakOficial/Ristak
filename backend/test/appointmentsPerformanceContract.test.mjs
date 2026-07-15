import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

test('Calendario de escritorio acota mes y pagina día/semana sin retener los KPIs', async () => {
  const [source, service] = await Promise.all([
    readFile(join(repoRoot, 'frontend/src/pages/Appointments/Appointments.tsx'), 'utf8'),
    readFile(join(repoRoot, 'frontend/src/services/calendarsService.ts'), 'utf8')
  ])
  const start = source.indexOf('const loadEvents = useCallback')
  const end = source.indexOf('useEffect(() => {', start)
  const loader = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(loader, /viewMode === 'month'[\s\S]*getMonthEventPreview/)
  assert.match(loader, /getEventsPage\([\s\S]*cursor,[\s\S]*limit: VISIBLE_APPOINTMENTS_PAGE_SIZE/)
  assert.match(loader, /includeCounts: !append/)
  assert.match(loader, /signal: controller\.signal/)
  assert.doesNotMatch(loader, /calendarsService\.getEvents\(/)
  assert.match(loader, /const monthlyStatsPromise = append[\s\S]*calendarsService\.getAppointmentStats/)
  assert.match(loader, /const publishVisibleEvents = visibleEventsPromise\s*\.then/)
  assert.match(loader, /const publishMonthlyStats = monthlyStatsPromise\s*\.then/)
  assert.match(loader, /publishVisibleEvents[\s\S]*setLoading\(false\)/)
  assert.match(loader, /publishMonthlyStats[\s\S]*Conserva el último snapshot de KPIs/)
  assert.match(loader, /response\.days\.flatMap\(day => day\.items\)/)
  assert.match(loader, /setEventCountsByDate\(Object\.fromEntries/)
  assert.match(loader, /setVisibleEventsTotal\(response\.total/)
  assert.match(source, /loadEvents\(\{ append: true \}\)/)
  assert.match(source, /Cargar más citas/)

  assert.match(service, /'\/calendars\/events\/month-preview'/)
  assert.match(service, /'\/calendars\/events\/page'/)
  assert.match(service, /'\/calendars\/events\/day-counts'/)
  assert.match(service, /signal/)
})

test('Calendario del teléfono usa conteos exactos y carga páginas completas bajo demanda', async () => {
  const [source, phoneChat] = await Promise.all([
    readFile(join(repoRoot, 'frontend/src/pages/PhoneCalendar/PhoneCalendar.tsx'), 'utf8'),
    readFile(join(repoRoot, 'frontend/src/pages/PhoneChat/PhoneChat.tsx'), 'utf8')
  ])
  const visibleStart = source.indexOf('const loadEvents = useCallback')
  const visibleEnd = source.indexOf('const loadSelectedDayEvents = useCallback', visibleStart)
  const selectedStart = visibleEnd
  const selectedEnd = source.indexOf('useEffect(() => {', selectedStart)
  const visibleLoader = source.slice(visibleStart, visibleEnd)
  const selectedLoader = source.slice(selectedStart, selectedEnd)

  assert.ok(visibleStart >= 0 && visibleEnd > visibleStart)
  assert.match(visibleLoader, /calendarView === 'month'[\s\S]*getMonthEventPreview/)
  assert.match(visibleLoader, /calendarView === 'year'[\s\S]*getEventDayCounts/)
  assert.match(visibleLoader, /getEventsPage\([\s\S]*includeCounts: !append/)
  assert.match(visibleLoader, /signal: controller\.signal/)
  assert.doesNotMatch(visibleLoader, /calendarsService\.getEvents\(/)
  assert.match(selectedLoader, /getEventsPage\([\s\S]*includeCounts: !append/)
  assert.match(source, /selectedDayTotal[\s\S]*Cargar más/)
  assert.match(source, /visibleEventsTotal[\s\S]*Cargar más citas/)
  assert.match(source, /eventCountsByDate\[formatDateKey\(date\)\]/)
  assert.match(source, /getBusinessDateRangeTimestamps/)

  const phoneChatMonthStart = phoneChat.indexOf('calendarsService.getMonthEventPreview({')
  const phoneChatMonthEnd = phoneChat.indexOf('}, [activeAppointmentEntryMode', phoneChatMonthStart)
  const phoneChatMonthLoader = phoneChat.slice(phoneChatMonthStart, phoneChatMonthEnd)
  assert.ok(phoneChatMonthStart >= 0 && phoneChatMonthEnd > phoneChatMonthStart)
  assert.match(phoneChatMonthLoader, /previewLimit: 3/)
  assert.match(phoneChatMonthLoader, /signal: controller\.signal/)
  assert.match(phoneChatMonthLoader, /response\.days\.flatMap\(day => day\.items\)/)
  assert.match(phoneChatMonthLoader, /setAppointmentCalendarEventCountsByDate/)
  assert.doesNotMatch(phoneChatMonthLoader, /calendarsService\.getEvents\(/)
})

test('Próximas citas usa cursor local acotado y carga incremental', async () => {
  const [page, service] = await Promise.all([
    readFile(join(repoRoot, 'frontend/src/pages/Appointments/Appointments.tsx'), 'utf8'),
    readFile(join(repoRoot, 'frontend/src/services/calendarsService.ts'), 'utf8')
  ])
  const start = page.indexOf('const loadUpcomingEvents = useCallback')
  const end = page.indexOf('// Cargar horarios bloqueados', start)
  const loader = page.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(loader, /getUpcomingAppointmentsPage/)
  assert.match(loader, /cursor,/)
  assert.match(loader, /limit: UPCOMING_APPOINTMENTS_PAGE_SIZE/)
  assert.match(loader, /signal: controller\.signal/)
  assert.match(loader, /upcomingEventsBoundaryRef/)
  assert.match(page, /loadUpcomingEvents\(\{ append: true \}\)/)
  assert.match(page, />\s*Cargar más\s*</)

  const futureStart = service.indexOf('async getFutureAppointments(')
  const futureEnd = service.indexOf('\n  },', futureStart)
  const legacyFutureLoader = service.slice(futureStart, futureEnd)
  assert.doesNotMatch(legacyFutureLoader, /setFullYear|getEvents\(/)
  assert.match(legacyFutureLoader, /getUpcomingAppointmentsPage/)
})

test('PhoneApp consume resumen multi-calendario acotado y no descarga el rango completo', async () => {
  const [phoneApp, service, controller, routes] = await Promise.all([
    readFile(join(repoRoot, 'frontend/src/pages/PhoneApp/PhoneApp.tsx'), 'utf8'),
    readFile(join(repoRoot, 'frontend/src/services/calendarsService.ts'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/controllers/calendarsController.js'), 'utf8'),
    readFile(join(repoRoot, 'backend/src/routes/calendars.routes.js'), 'utf8')
  ])

  assert.match(phoneApp, /calendarsService\.getEventsOverview\(\{/)
  assert.match(phoneApp, /limit: 5/)
  assert.match(phoneApp, /appointmentStats: appointmentOverview\.stats/)
  assert.doesNotMatch(phoneApp, /calendarsService\.getEvents\(/)
  assert.match(service, /'\/calendars\/events\/overview'/)
  assert.match(controller, /export async function getEventsOverview/)
  assert.match(routes, /router\.get\('\/events\/overview', calendarsController\.getEventsOverview\)/)
})
