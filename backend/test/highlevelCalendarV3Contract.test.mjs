import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { createCalendar, updateCalendar } from '../src/services/highlevelCalendarService.js'
import {
  buildHighLevelCalendarPayload,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

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
    await updateCalendar('cal_remote', {
      id: 'cal_remote',
      locationId: 'loc_test',
      ghlCalendarId: 'cal_remote',
      ghl_calendar_id: 'cal_remote',
      name: 'Agenda nueva'
    }, 'token_test')
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.options.headers.Version === 'v3'))

  const createBody = JSON.parse(requests[0].options.body)
  const updateBody = JSON.parse(requests[1].options.body)
  assert.equal(createBody.locationId, 'loc_test')
  assert.equal(updateBody.locationId, undefined)
  assert.equal(updateBody.id, undefined)
  assert.equal(updateBody.ghlCalendarId, undefined)
  assert.equal(updateBody.ghl_calendar_id, undefined)
  assert.equal(updateBody.name, 'Agenda nueva')
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

test('successful calendar sync clears a previous provider error', async () => {
  const id = `rstk_cal_sync_error_${randomUUID()}`
  try {
    await upsertLocalCalendar({
      id,
      name: 'Agenda con reintento',
      source: 'ristak',
      syncError: 'fallo anterior'
    }, {
      id,
      source: 'ristak',
      syncStatus: 'error',
      syncError: 'fallo anterior'
    })

    const synced = await upsertLocalCalendar({
      id,
      name: 'Agenda con reintento',
      source: 'ristak',
      syncError: 'fallo anterior'
    }, {
      id,
      source: 'ristak',
      syncStatus: 'synced',
      syncError: null,
      acknowledgeLocalWrite: true
    })

    assert.equal(synced.syncStatus, 'synced')
    assert.equal(synced.syncError, null)
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [id]).catch(() => undefined)
  }
})
