import test from 'node:test'
import assert from 'node:assert/strict'
import { updateAppointment } from '../src/services/highlevelCalendarService.js'

test('updateAppointment ignora validacion de slot cuando cambia horario', async () => {
  const originalFetch = globalThis.fetch
  let capturedRequest = null

  globalThis.fetch = async (url, options = {}) => {
    capturedRequest = { url, options }
    return {
      ok: true,
      json: async () => ({ id: 'evt_overlap_test' }),
      text: async () => ''
    }
  }

  try {
    await updateAppointment('evt_overlap_test', {
      startTime: '2026-08-03T10:00:00-06:00',
      endTime: '2026-08-03T11:00:00-06:00',
      appointmentStatus: 'confirmed'
    }, 'test_token')

    const payload = JSON.parse(capturedRequest.options.body)

    assert.equal(payload.ignoreFreeSlotValidation, true)
    assert.equal(payload.ignoreDateRange, true)
    assert.equal(payload.appointmentStatus, 'confirmed')
  } finally {
    globalThis.fetch = originalFetch
  }
})
