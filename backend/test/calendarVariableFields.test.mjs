import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import { previewCalendarHandler } from '../src/controllers/sitesController.js'
import { createLocalCalendar } from '../src/services/localCalendarService.js'
import { createVariableField } from '../src/services/variableFieldsService.js'

function createResponseStub() {
  const state = { statusCode: null, contentType: '', body: null, headers: {} }
  return {
    state,
    set(name, value) {
      state.headers[name] = value
      return this
    },
    status(code) {
      state.statusCode = code
      return this
    },
    type(value) {
      state.contentType = value
      return this
    },
    send(body) {
      state.body = body
      return this
    }
  }
}

test('el calendario público resuelve campos variables antes de generar su HTML', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const field = await createVariableField({
    label: `Nombre calendario ${suffix}`,
    fieldKey: `calendar_name_${suffix}`,
    value: 'Consulta Premium'
  })
  const calendarId = `rstk_calendar_variable_${suffix}`
  const slug = `agenda-variable-${suffix}`

  try {
    const calendar = await createLocalCalendar({
      id: calendarId,
      slug,
      name: `Agenda ${field.parameter}`,
      description: `Reserva tu ${field.parameter}`,
      isActive: true
    })

    const req = {
      params: { slug: calendar.slug },
      query: {},
      headers: { host: 'calendar.example.test' }
    }
    const res = createResponseStub()

    await previewCalendarHandler(req, res)

    assert.equal(res.state.statusCode, 200)
    assert.equal(res.state.contentType, 'html')
    assert.equal(res.state.headers['Cache-Control'], 'no-store')
    assert.match(res.state.body, /Agenda Consulta Premium/)
    assert.match(res.state.body, /Reserva tu Consulta Premium/)
    assert.equal(res.state.body.includes(field.parameter), false)
  } finally {
    await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
    await db.run('DELETE FROM variable_fields WHERE id = ?', [field.id]).catch(() => undefined)
  }
})
