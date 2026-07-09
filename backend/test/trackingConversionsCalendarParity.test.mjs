import test from 'node:test'
import assert from 'node:assert/strict'

import { db } from '../src/config/database.js'
import { fetchAppointmentsForContacts } from '../src/services/analyticsService.js'
import {
  getContactConversionsByDate,
  getContactConversionsList
} from '../src/controllers/trackingController.js'

// Paridad número↔modal en la gráfica de Conversiones de Analytics.
//
// El conteo (getContactConversionsByDate) marca "tiene cita/asistencia" con un
// EXISTS sobre appointments que NO filtra por calendar_id. Por lo tanto, el
// detalle del modal (getContactConversionsList → fetchAppointmentsForContacts)
// tampoco debe filtrar por calendarios de atribución; si lo hiciera, un contacto
// correctamente contado en "Citas" aparecería con la tarjeta de citas vacía en el
// modal cuando attribution_calendar_ids excluya el calendario donde vive la cita.
//
// Reports (buildContactsList) sí selecciona contactos filtrando por calendarios de
// atribución, así que su detalle debe seguir respetándolos: ese es el default de
// fetchAppointmentsForContacts (respectAttributionCalendars = true).

function createResponse() {
  const response = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }

  return response
}

async function callController(handler, query) {
  const response = createResponse()
  await handler({ query }, response)
  assert.equal(response.statusCode, 200)
  return response.body
}

test('Analytics: el modal muestra citas fuera del calendario de atribución (paridad con el conteo)', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
  const date = '2099-04-11'
  const createdAt = `${date}T18:00:00.000Z`

  const contactId = `analytics-cal-parity-${suffix}`
  const appointmentId = `analytics-cal-parity-appt-${suffix}`
  const outsideCalendarId = `cal-outside-attribution-${suffix}`
  const attributionCalendarId = `cal-only-attribution-${suffix}`

  // Guardar el valor previo de attribution_calendar_ids para restaurarlo al final.
  const previousConfig = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['attribution_calendar_ids']
  )

  const cleanup = async () => {
    await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM app_config WHERE config_key = ?', ['attribution_calendar_ids'])
    if (previousConfig && previousConfig.config_value != null) {
      await db.run(
        'INSERT INTO app_config (config_key, config_value) VALUES (?, ?)',
        ['attribution_calendar_ids', previousConfig.config_value]
      )
    }
  }

  await cleanup()

  try {
    // Configurar calendarios de atribución que EXCLUYEN el calendario de la cita.
    await db.run(
      'INSERT INTO app_config (config_key, config_value) VALUES (?, ?)',
      ['attribution_calendar_ids', JSON.stringify([attributionCalendarId])]
    )

    await db.run(`
      INSERT INTO contacts (
        id, email, full_name, visitor_id, total_paid, purchases_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      contactId,
      `analytics-cal-parity-${suffix}@local.invalid`,
      'Analytics Cita Fuera de Atribución',
      `visitor-cal-parity-${suffix}`,
      0,
      0,
      createdAt,
      createdAt
    ])

    // Cita ACTIVA (confirmed) pero en un calendario que NO es de atribución.
    await db.run(`
      INSERT INTO appointments (
        id, calendar_id, contact_id, title, status, appointment_status, start_time
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      appointmentId,
      outsideCalendarId,
      contactId,
      'Cita de prueba',
      'confirmed',
      'confirmed',
      `${date}T20:00:00.000Z`
    ])

    // 1) El CONTEO cuenta la cita aunque viva fuera del calendario de atribución.
    const conversions = await callController(getContactConversionsByDate, { start: date, end: date })
    const day = conversions.data.find(row => row.date === date)
    assert.ok(day, 'debe existir el día en el conteo de conversiones')
    assert.equal(day.registrations, 1)
    assert.equal(day.appointments, 1, 'el conteo NO debe filtrar por calendario de atribución')
    assert.equal(day.attendances, 0)
    assert.equal(day.customers, 0)

    // 2) Contraste directo del gate en fetchAppointmentsForContacts:
    //    - default (Reports) RESPETA los calendarios de atribución → sin citas.
    const respectingMap = await fetchAppointmentsForContacts([contactId])
    assert.equal(
      (respectingMap.get(contactId) || []).length,
      0,
      'con respectAttributionCalendars=true la cita fuera del calendario de atribución se excluye'
    )
    //    - Analytics BYPASSEA el filtro → devuelve la cita.
    const bypassMap = await fetchAppointmentsForContacts([contactId], { respectAttributionCalendars: false })
    const bypassAppointments = bypassMap.get(contactId) || []
    assert.equal(
      bypassAppointments.length,
      1,
      'con respectAttributionCalendars=false se muestran todas las citas del contacto'
    )
    assert.equal(bypassAppointments[0].id, appointmentId)

    // 3) End-to-end: el modal de Analytics recibe la cita (sub-array poblado).
    const list = await callController(getContactConversionsList, {
      start: date,
      end: date,
      type: 'appointments'
    })
    const contact = list.data.contacts.find(row => row.id === contactId)
    assert.ok(contact, 'el contacto contado debe aparecer en la lista de Analytics')
    assert.equal(
      contact.appointments.length,
      1,
      'el modal debe mostrar la cita para mantener la paridad número↔modal'
    )
    assert.equal(contact.appointments[0].id, appointmentId)
  } finally {
    await cleanup()
  }
})
