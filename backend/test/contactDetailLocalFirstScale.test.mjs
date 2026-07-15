import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { getContactById, getContactJourney } from '../src/controllers/contactsController.js'
import {
  listContactAppointmentsPage,
  listContactPaymentsPage
} from '../src/services/contactDetailPaginationService.js'

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    writableEnded: false,
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      this.writableEnded = true
      return this
    }
  }
}

async function cleanup(contactId) {
  await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM payments WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM sessions WHERE contact_id = ?', [contactId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
}

test('detalle inicial es local-first y las colecciones grandes usan keyset sin duplicados', async () => {
  const contactId = `detail_scale_${randomUUID()}`
  await cleanup(contactId)

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
      [contactId, 'Contacto de escala', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z']
    )

    await db.transaction(async transaction => {
      for (let index = 0; index < 45; index += 1) {
        const suffix = String(index).padStart(3, '0')
        await transaction.run(
          `INSERT INTO payments (id, contact_id, amount, currency, status, date, created_at)
           VALUES (?, ?, ?, 'MXN', 'paid', ?, ?)`,
          [`detail-payment-${suffix}-${contactId}`, contactId, index + 1, '2099-02-01T12:00:00.000Z', '2099-02-01T12:00:00.000Z']
        )
        await transaction.run(
          `INSERT INTO appointments (id, contact_id, title, status, start_time, date_added)
           VALUES (?, ?, ?, 'confirmed', ?, ?)`,
          [`detail-appointment-${suffix}-${contactId}`, contactId, `Cita ${suffix}`, '2099-03-01T12:00:00.000Z', '2099-01-15T12:00:00.000Z']
        )
      }
    })

    const detailResponse = responseRecorder()
    await getContactById({ params: { id: contactId }, query: {} }, detailResponse)
    assert.equal(detailResponse.statusCode, 200)
    assert.deepEqual(detailResponse.body.data.payments, [])
    assert.deepEqual(detailResponse.body.data.appointments, [])
    assert.equal(detailResponse.body.data.paymentsTotal, 45)
    assert.equal(detailResponse.body.data.hasPaymentRecords, true)
    assert.equal(detailResponse.body.data.appointmentsTotal, 45)

    for (const [loader, collection] of [
      [listContactPaymentsPage, 'payments'],
      [listContactAppointmentsPage, 'appointments']
    ]) {
      const ids = []
      let cursor = null
      do {
        const page = await loader({ contactId, cursor, limit: 10 })
        ids.push(...page[collection].map(row => row.id))
        cursor = page.pagination.nextCursor
      } while (cursor)

      assert.equal(ids.length, 45)
      assert.equal(new Set(ids).size, 45)
    }

    const firstPaymentPage = await listContactPaymentsPage({ contactId, limit: 5 })
    await assert.rejects(
      listContactAppointmentsPage({
        contactId,
        cursor: firstPaymentPage.pagination.nextCursor,
        limit: 5
      }),
      error => error?.status === 400
    )
  } finally {
    await cleanup(contactId)
  }
})

test('journey completo queda acotado y pagina eventos anteriores con cursor compuesto', async () => {
  const contactId = `journey_scale_${randomUUID()}`
  await cleanup(contactId)

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [contactId, 'Journey de escala', `${contactId}@example.test`, '2098-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z']
    )
    await db.transaction(async transaction => {
      for (let index = 0; index < 125; index += 1) {
        const second = String(index % 60).padStart(2, '0')
        const minute = String(Math.floor(index / 60)).padStart(2, '0')
        await transaction.run(
          `INSERT INTO email_messages (
             id, contact_id, direction, status, from_email, to_email,
             subject, message_text, message_timestamp, created_at
           ) VALUES (?, ?, 'inbound', 'received', ?, ?, ?, ?, ?, ?)`,
          [
            `journey-email-${String(index).padStart(3, '0')}-${contactId}`,
            contactId,
            `${contactId}@example.test`,
            'crm@example.test',
            `Mensaje ${index}`,
            `Contenido ${index}`,
            `2099-04-01T12:${minute}:${second}.000Z`,
            `2099-04-01T12:${minute}:${second}.000Z`
          ]
        )
      }
    })

    const firstResponse = responseRecorder()
    await getContactJourney({ params: { id: contactId }, query: { limit: '40' } }, firstResponse)
    assert.equal(firstResponse.statusCode, 200)
    assert.equal(firstResponse.body.data.length, 40)

    const oldest = firstResponse.body.data[0]
    const secondResponse = responseRecorder()
    await getContactJourney({
      params: { id: contactId },
      query: {
        limit: '40',
        beforeEventDate: oldest.cursorDate || oldest.date,
        beforeEventCursor: oldest.cursorKey
      }
    }, secondResponse)
    assert.equal(secondResponse.statusCode, 200)
    assert.ok(secondResponse.body.data.length > 0)
    const firstKeys = new Set(firstResponse.body.data.map(event => `${event.cursorDate || event.date}:${event.cursorKey}`))
    assert.equal(secondResponse.body.data.some(event => firstKeys.has(`${event.cursorDate || event.date}:${event.cursorKey}`)), false)
  } finally {
    await cleanup(contactId)
  }
})

test('journey pagina sesiones completas mayores al limite sin truncados ni duplicados', async () => {
  const contactId = `journey_sessions_${randomUUID()}`
  const visitorId = `visitor_${randomUUID()}`
  const largeSessionId = `large_session_${randomUUID()}`
  const pageLimit = 7
  await cleanup(contactId)

  try {
    await db.run(
      `INSERT INTO contacts (id, full_name, visitor_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [contactId, 'Journey con sesiones completas', visitorId, '2098-01-01T00:00:00.000Z', '2098-01-01T00:00:00.000Z']
    )

    await db.transaction(async transaction => {
      for (let index = 0; index < 125; index += 1) {
        const second = String(index % 60).padStart(2, '0')
        const minute = String(Math.floor(index / 60)).padStart(2, '0')
        const timestamp = `2099-06-01T12:${minute}:${second}.000Z`
        await transaction.run(
          `INSERT INTO sessions (
             id, session_id, visitor_id, contact_id, event_name,
             started_at, created_at, page_url, source_platform
           ) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?, ?)`,
          [
            randomUUID(),
            largeSessionId,
            visitorId,
            contactId,
            timestamp,
            timestamp,
            'https://crm.example.test/landing',
            'website'
          ]
        )
      }

      for (let sessionIndex = 0; sessionIndex < 25; sessionIndex += 1) {
        const logicalSessionId = `logical_session_${String(sessionIndex).padStart(2, '0')}_${randomUUID()}`
        const minute = String(Math.floor(sessionIndex / 5)).padStart(2, '0')
        for (let eventIndex = 0; eventIndex < 3; eventIndex += 1) {
          const second = String(eventIndex).padStart(2, '0')
          const timestamp = `2099-05-01T12:${minute}:${second}.000Z`
          await transaction.run(
            `INSERT INTO sessions (
               id, session_id, visitor_id, contact_id, event_name,
               started_at, created_at, page_url, source_platform
             ) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?, ?)`,
            [
              randomUUID(),
              logicalSessionId,
              visitorId,
              contactId,
              timestamp,
              timestamp,
              'https://crm.example.test/landing',
              'website'
            ]
          )
        }
      }
    })

    const seenEventCursors = new Set()
    const pageVisitEvents = []
    let beforeEventDate = null
    let beforeEventCursor = null
    let pagesLoaded = 0

    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const response = responseRecorder()
      await getContactJourney({
        params: { id: contactId },
        query: {
          limit: String(pageLimit),
          ...(beforeEventDate
            ? { beforeEventDate, beforeEventCursor }
            : {})
        }
      }, response)

      assert.equal(response.statusCode, 200)
      const events = response.body.data
      assert.ok(events.length <= pageLimit)
      if (!events.length) break
      pagesLoaded += 1

      events.forEach(event => {
        const eventCursor = `${event.cursorDate || event.date}:${event.cursorKey}`
        assert.equal(seenEventCursors.has(eventCursor), false, `cursor duplicado: ${eventCursor}`)
        seenEventCursors.add(eventCursor)
        if (event.type === 'page_visit') pageVisitEvents.push(event)
      })

      const oldestEvent = events[0]
      beforeEventDate = oldestEvent.cursorDate || oldestEvent.date
      beforeEventCursor = oldestEvent.cursorKey
      if (events.length < pageLimit) break
    }

    assert.ok(pagesLoaded >= 4)
    assert.equal(pageVisitEvents.length, 26)
    assert.equal(new Set(pageVisitEvents.map(event => event.cursorKey)).size, 26)

    const largeSessionEvent = pageVisitEvents.find(event => event.data.session_id === largeSessionId)
    assert.ok(largeSessionEvent)
    assert.equal(largeSessionEvent.cursorKey, `page_visit:${largeSessionId}`)
    assert.equal(largeSessionEvent.data.session_event_count, 125)
    assert.equal(largeSessionEvent.data.tracking_session_ids.length, 125)
  } finally {
    await cleanup(contactId)
  }
})

test('el GET de detalle no contiene calentamiento externo ni búsqueda telefónica por sufijo', async () => {
  const source = await readFile(new URL('../src/controllers/contactsController.js', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export const getContactById'), source.indexOf('async function assertVisibleContact'))

  assert.doesNotMatch(body, /await\s+fetch\s*\(/)
  assert.doesNotMatch(body, /warmWhatsApp(?:Api|Qr)?ProfilePictures/)
  assert.doesNotMatch(body, /LIKE\s+\?/i)
  assert.match(body, /isContactListProjectionReady\(\{ schedule: false \}\)/)
})
