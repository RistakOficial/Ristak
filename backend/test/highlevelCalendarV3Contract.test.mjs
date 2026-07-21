import test from 'node:test'
import assert from 'node:assert/strict'
import { createCalendar, updateCalendar } from '../src/services/highlevelCalendarService.js'
import { buildHighLevelCalendarPayload } from '../src/services/localCalendarService.js'

test('HighLevel calendar create and update use the current v3 contract', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options })
    return {
      ok: true,
      json: async () => ({ calendar: { id: 'cal_remote' } }),
      text: async () => ''
    }
  }

  try {
    await createCalendar({ locationId: 'loc_test', name: 'Agenda' }, 'token_test')
    await updateCalendar('cal_remote', { name: 'Agenda nueva' }, 'token_test')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.options.headers.Version === 'v3'))
})

test('calendar payload canonicalizes legacy Sunday before sending openHours', () => {
  const payload = buildHighLevelCalendarPayload({
    name: 'Agenda',
    availabilityScheduleConfigured: true,
    openHours: [{
      daysOfTheWeek: [7],
      hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
    }]
  }, 'loc_test')

  assert.deepEqual(payload.openHours, [{
    daysOfTheWeek: [0],
    hours: [{ openHour: 9, openMinute: 0, closeHour: 17, closeMinute: 0 }]
  }])
})
