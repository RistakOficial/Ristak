import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(testDir, '..', '..')

test('Calendario publica la vista sin esperar métricas mensuales y no duplica el mismo rango', async () => {
  const source = await readFile(join(repoRoot, 'frontend/src/pages/Appointments/Appointments.tsx'), 'utf8')
  const start = source.indexOf('const loadEvents = useCallback')
  const end = source.indexOf('useEffect(() => {', start)
  const loader = source.slice(start, end)

  assert.ok(start >= 0 && end > start)
  assert.match(loader, /const visibleEventsPromise = calendarsService\.getEvents/)
  assert.match(loader, /startTime === monthStartTime && endTime === monthEndTime\s*\? visibleEventsPromise/)
  assert.match(loader, /const publishVisibleEvents = visibleEventsPromise\s*\.then/)
  assert.match(loader, /const publishMonthlyStats = monthlyEventsPromise\s*\.then/)
  assert.ok(loader.indexOf('setEvents(eventsData)') < loader.indexOf('await Promise.all'))
  assert.match(loader, /publishVisibleEvents[\s\S]*setLoading\(false\)/)
  assert.match(loader, /publishMonthlyStats[\s\S]*Conserva el último snapshot de KPIs/)
})
