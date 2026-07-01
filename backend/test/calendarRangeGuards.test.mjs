import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getBlockedSlots,
  getEvents,
  getFreeSlots,
  getPublicFreeSlots
} from '../src/controllers/calendarsController.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

function createResponse() {
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

test('getEvents rechaza rangos de calendario demasiado grandes', async () => {
  const res = createResponse()

  await getEvents({
    query: {
      startTime: '0',
      endTime: String(371 * MS_PER_DAY)
    }
  }, res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body?.success, false)
  assert.match(res.body?.error, /370 días/)
})

test('getFreeSlots rechaza rangos de disponibilidad demasiado grandes', async () => {
  const res = createResponse()

  await getFreeSlots({
    params: { id: 'calendar_1' },
    query: {
      startDate: '2026-01-01',
      endDate: '2026-02-15'
    }
  }, res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body?.success, false)
  assert.match(res.body?.error, /45 días/)
})

test('getPublicFreeSlots valida el rango antes de resolver dominio público', async () => {
  const res = createResponse()

  await getPublicFreeSlots({
    params: { slug: 'demo' },
    query: {
      startDate: '2026-01-01',
      endDate: '2026-02-15'
    },
    headers: {}
  }, res)

  assert.equal(res.statusCode, 400)
  assert.equal(res.body?.success, false)
  assert.match(res.body?.error, /45 días/)
})

test('getBlockedSlots exige rango acotado', async () => {
  const missingRange = createResponse()
  await getBlockedSlots({
    params: { calendarId: 'calendar_1' },
    query: {}
  }, missingRange)

  assert.equal(missingRange.statusCode, 400)
  assert.equal(missingRange.body?.success, false)
  assert.match(missingRange.body?.error, /startTime y endTime/)

  const oversizedRange = createResponse()
  await getBlockedSlots({
    params: { calendarId: 'calendar_1' },
    query: {
      startTime: '0',
      endTime: String(46 * MS_PER_DAY)
    }
  }, oversizedRange)

  assert.equal(oversizedRange.statusCode, 400)
  assert.equal(oversizedRange.body?.success, false)
  assert.match(oversizedRange.body?.error, /45 días/)
})
