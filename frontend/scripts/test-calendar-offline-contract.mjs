import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const offlineStore = await readFile(
  new URL('../src/services/calendarOfflineStore.ts', import.meta.url),
  'utf8'
)
const appSource = await readFile(
  new URL('../src/App.tsx', import.meta.url),
  'utf8'
)
const appointmentsSource = await readFile(
  new URL('../src/pages/Appointments/Appointments.tsx', import.meta.url),
  'utf8'
)
const phoneCalendarSource = await readFile(
  new URL('../src/pages/PhoneCalendar/PhoneCalendar.tsx', import.meta.url),
  'utf8'
)
const phoneChatSource = await readFile(
  new URL('../src/pages/PhoneChat/PhoneChat.tsx', import.meta.url),
  'utf8'
)

assert.match(offlineStore, /createAuthScopedLocalStorageNamespace/)
assert.match(offlineStore, /accessToken: _accessToken/)
assert.match(offlineStore, /access_token: _accessTokenLegacy/)
assert.match(offlineStore, /clientRequestId/)
assert.match(offlineStore, /status: retryable \? 'pending' : 'failed'/)
assert.match(offlineStore, /status === 408 \|\| status === 425 \|\| status === 429 \|\| status >= 500/)
assert.match(offlineStore, /start >= range\.startTime && start <= range\.endTime/)

assert.match(appSource, /CalendarOfflineSyncEffect/)
assert.match(appSource, /window\.addEventListener\('online'/)
assert.match(appSource, /document\.addEventListener\('visibilitychange'/)

for (const [surface, source] of [
  ['Citas de escritorio', appointmentsSource],
  ['Calendario móvil web', phoneCalendarSource],
  ['Agenda desde chat móvil', phoneChatSource]
]) {
  assert.match(
    source,
    /enqueueCalendarAppointment/,
    `${surface} debe guardar la cita en la cola durable cuando falla la red`
  )
  assert.match(
    source,
    /clientRequestId/,
    `${surface} debe conservar la llave idempotente del intento`
  )
}

console.log('Calendar offline contract OK')
