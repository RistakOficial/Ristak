import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { db } from '../src/config/database.js'
import { getEvents } from '../src/controllers/calendarsController.js'
import {
  handleAppointmentShowedWebhook,
  handleAppointmentWebhook
} from '../src/controllers/webhooksController.js'
import {
  persistHighLevelAppointmentFromPull,
  resolveHighLevelPullAppointmentContact
} from '../src/services/highlevelSyncService.js'
import {
  claimPreparedHighLevelMirrorIntent,
  completeHighLevelAppointmentMirrorIntent,
  createLocalAppointment,
  getLocalAppointment,
  markHighLevelAppointmentMirrorError,
  markHighLevelAppointmentMirrorSynced,
  prepareHighLevelAppointmentMirrorIntent,
  reconcileInboundHighLevelAppointment,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

const LOCAL_CALENDAR_SERVICE_SOURCE = new URL('../src/services/localCalendarService.js', import.meta.url)

const BUSINESS_COLUMNS = [
  'id',
  'calendar_id',
  'contact_id',
  'location_id',
  'title',
  'status',
  'appointment_status',
  'assigned_user_id',
  'notes',
  'address',
  'start_time',
  'end_time',
  'date_added',
  'date_updated',
  'source',
  'booking_channel'
]

function responseCapture() {
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

function businessSnapshot(row = {}) {
  return Object.fromEntries(BUSINESS_COLUMNS.map(column => [column, row[column]]))
}

async function createFixture(label, { linkMirror = true } = {}) {
  const suffix = `${label}_${randomUUID()}`
  const calendarId = `rstk_cal_${suffix}`
  const remoteCalendarId = `ghl_cal_${suffix}`
  const contactId = `rstk_contact_${suffix}`
  const remoteContactId = `ghl_contact_${suffix}`
  const appointmentId = `rstk_appt_${suffix}`
  const remoteAppointmentId = `ghl_appt_${suffix}`
  const locationId = `ghl_location_${suffix}`
  const startTime = '2032-08-12T16:00:00.000Z'
  const endTime = '2032-08-12T17:00:00.000Z'

  await db.run(
    `INSERT INTO contacts (id, ghl_contact_id, full_name, email, created_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [contactId, remoteContactId, `Contacto ${label}`, `${suffix}@example.test`]
  )
  await upsertLocalCalendar({
    id: calendarId,
    name: `Agenda ${label}`,
    source: 'ristak',
    ghlCalendarId: remoteCalendarId,
    locationId
  }, {
    source: 'ristak',
    syncStatus: 'synced'
  })
  await createLocalAppointment({
    id: appointmentId,
    calendarId,
    contactId,
    locationId,
    title: 'Cita canónica Ristak',
    status: 'confirmed',
    appointmentStatus: 'confirmed',
    assignedUserId: `ristak_user_${suffix}`,
    notes: 'Notas locales protegidas',
    address: 'Dirección local protegida',
    startTime,
    endTime,
    bookingChannel: 'whatsapp',
    source: 'ristak'
  }, { locationId, syncStatus: 'synced' })
  if (linkMirror) {
    await markHighLevelAppointmentMirrorSynced(appointmentId, remoteAppointmentId)
  }

  return {
    suffix,
    calendarId,
    remoteCalendarId,
    contactId,
    remoteContactId,
    appointmentId,
    remoteAppointmentId,
    locationId,
    startTime,
    endTime
  }
}

async function cleanupFixture(fixture) {
  if (!fixture) return
  await db.run('DELETE FROM appointment_highlevel_mirror_intents WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => undefined)
  await db.run('DELETE FROM appointment_attendance_signals WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => undefined)
  await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [fixture.appointmentId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE id = ? OR ghl_appointment_id = ?', [fixture.appointmentId, fixture.remoteAppointmentId]).catch(() => undefined)
  await db.run('DELETE FROM calendars WHERE id = ?', [fixture.calendarId]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id = ?', [fixture.contactId]).catch(() => undefined)
}

async function assertSingleCanonicalAppointment(fixture, expectedSnapshot) {
  const rows = await db.all(
    'SELECT * FROM appointments WHERE id IN (?, ?) OR ghl_appointment_id = ?',
    [fixture.appointmentId, fixture.remoteAppointmentId, fixture.remoteAppointmentId]
  )
  assert.equal(rows.length, 1)
  assert.deepEqual(businessSnapshot(rows[0]), expectedSnapshot)
  return rows[0]
}

function divergentRemoteEvent(fixture, overrides = {}) {
  return {
    id: fixture.remoteAppointmentId,
    calendarId: fixture.remoteCalendarId,
    contactId: fixture.remoteContactId,
    locationId: fixture.locationId,
    title: 'Título remoto que no manda',
    status: 'cancelled',
    appointmentStatus: 'cancelled',
    assignedUserId: `ghl_user_intruso_${fixture.suffix}`,
    notes: 'Notas remotas que no mandan',
    address: 'Dirección remota que no manda',
    startTime: '2032-08-13T22:00:00.000Z',
    endTime: '2032-08-13T23:00:00.000Z',
    dateAdded: '2032-01-01T00:00:00.000Z',
    dateUpdated: '2032-08-13T00:00:00.000Z',
    ...overrides
  }
}

test('pull GHL reconoce el eco por ghl_appointment_id, conserva la cita Ristak y no duplica', async () => {
  const fixture = await createFixture('pull_echo')
  try {
    const before = await db.get('SELECT * FROM appointments WHERE id = ?', [fixture.appointmentId])
    const expectedSnapshot = businessSnapshot(before)
    const rawEvent = divergentRemoteEvent(fixture)
    const intruderContactId = `ghl_contact_intruso_${fixture.suffix}`
    const contactResolution = await resolveHighLevelPullAppointmentContact({
      remoteAppointmentId: fixture.remoteAppointmentId,
      remoteContactId: intruderContactId,
      ensureContact: async () => assert.fail('un eco Ristak no debe resolver ni crear el contacto remoto')
    })
    assert.deepEqual(contactResolution, {
      localContactId: intruderContactId,
      canonicalContactId: fixture.contactId,
      created: false,
      ownership: 'ristak'
    })

    const result = await persistHighLevelAppointmentFromPull({
      rawEvent,
      normalized: rawEvent,
      localContactId: contactResolution.localContactId,
      localCalendarId: fixture.calendarId,
      locationId: fixture.locationId
    })

    assert.equal(result.ownership, 'ristak')
    assert.equal(result.mirrorDiverged, true)
    const stored = await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(stored.sync_status, 'pending')
    assert.match(stored.sync_error, /\[ghl_mirror_diverged\]/)

    const linkedContactResolution = await resolveHighLevelPullAppointmentContact({
      remoteAppointmentId: fixture.remoteAppointmentId,
      remoteContactId: fixture.remoteContactId,
      ensureContact: async () => assert.fail('un eco exacto tampoco debe resolver o crear contacto')
    })
    const exactEcho = {
      id: fixture.remoteAppointmentId,
      calendarId: fixture.remoteCalendarId,
      contactId: fixture.remoteContactId,
      locationId: before.location_id,
      title: before.title,
      status: before.status,
      appointmentStatus: before.appointment_status,
      assignedUserId: before.assigned_user_id,
      notes: before.notes,
      address: before.address,
      startTime: fixture.startTime,
      endTime: fixture.endTime,
      dateAdded: before.date_added,
      dateUpdated: before.date_updated
    }
    const matched = await persistHighLevelAppointmentFromPull({
      rawEvent: exactEcho,
      normalized: exactEcho,
      localContactId: linkedContactResolution.localContactId,
      localCalendarId: fixture.calendarId,
      locationId: fixture.locationId
    })
    assert.equal(matched.mirrorMatched, true)
    assert.equal(matched.syncStatus, 'synced')
    const reconciled = await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(reconciled.sync_status, 'synced')
    assert.equal(reconciled.sync_error, null)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('un evento nacido en GHL sí se importa como ocupación source=ghl sin duplicarse al repetirlo', async () => {
  const fixture = await createFixture('ghl_native')
  const nativeRemoteId = `ghl_native_${fixture.suffix}`
  try {
    const rawEvent = divergentRemoteEvent(fixture, {
      id: nativeRemoteId,
      title: 'Cita nacida en HighLevel',
      status: 'confirmed',
      appointmentStatus: 'confirmed',
      startTime: '2032-08-14T16:00:00.000Z',
      endTime: '2032-08-14T17:00:00.000Z'
    })

    const first = await reconcileInboundHighLevelAppointment(rawEvent, {
      ghlAppointmentId: nativeRemoteId,
      calendarId: fixture.calendarId,
      contactId: fixture.contactId,
      locationId: fixture.locationId
    })
    const second = await reconcileInboundHighLevelAppointment(rawEvent, {
      ghlAppointmentId: nativeRemoteId,
      calendarId: fixture.calendarId,
      contactId: fixture.contactId,
      locationId: fixture.locationId
    })

    assert.equal(first.ownership, 'ghl')
    assert.equal(first.imported, true)
    assert.equal(second.ownership, 'ghl')
    assert.equal(second.appointment.id, nativeRemoteId)
    const rows = await db.all('SELECT id, source, ghl_appointment_id FROM appointments WHERE ghl_appointment_id = ?', [nativeRemoteId])
    assert.deepEqual(rows, [{ id: nativeRemoteId, source: 'ghl', ghl_appointment_id: nativeRemoteId }])
  } finally {
    await db.run('DELETE FROM appointment_participants WHERE appointment_id = ?', [nativeRemoteId]).catch(() => undefined)
    await db.run('DELETE FROM appointments WHERE id = ?', [nativeRemoteId]).catch(() => undefined)
    await cleanupFixture(fixture)
  }
})

test('webhook appointment de HighLevel no pisa ni duplica una cita Ristak ligada', async () => {
  const fixture = await createFixture('appointment_webhook_echo')
  try {
    const before = await db.get('SELECT * FROM appointments WHERE id = ?', [fixture.appointmentId])
    const expectedSnapshot = businessSnapshot(before)
    const remote = divergentRemoteEvent(fixture)
    const intruderContactId = `ghl_contact_intruso_${fixture.suffix}`
    const res = responseCapture()

    await handleAppointmentWebhook({
      body: {
        contact_id: intruderContactId,
        locationId: fixture.locationId,
        title: remote.title,
        status: remote.status,
        appointment_status: remote.appointmentStatus,
        assignedUserId: remote.assignedUserId,
        notes: remote.notes,
        address: remote.address,
        startTime: remote.startTime,
        endTime: remote.endTime,
        dateUpdated: remote.dateUpdated,
        calendar: {
          id: fixture.remoteCalendarId,
          appointmentId: fixture.remoteAppointmentId
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    const stored = await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(stored.sync_status, 'pending')
    assert.equal(
      Number((await db.get('SELECT COUNT(*) AS total FROM contacts WHERE ghl_contact_id = ?', [intruderContactId])).total),
      0
    )
  } finally {
    await cleanupFixture(fixture)
  }
})

test('webhook GHL adelantado reclama la intención pre-POST y nunca crea una cita externa', async () => {
  const fixture = await createFixture('appointment_webhook_before_post_response', { linkMirror: false })
  try {
    const before = await db.get('SELECT * FROM appointments WHERE id = ?', [fixture.appointmentId])
    const expectedSnapshot = businessSnapshot(before)
    await prepareHighLevelAppointmentMirrorIntent({
      appointmentId: fixture.appointmentId,
      remoteCalendarId: fixture.remoteCalendarId,
      remoteContactId: fixture.remoteContactId,
      locationId: fixture.locationId
    })

    // Simula que el proceso muere justo después de reclamar el webhook y antes
    // de comparar el eco completo. El ID queda ligado, pero nunca se adelanta a
    // "synced" ni se crea una fila HighLevel.
    const claimedBeforeReconcile = await claimPreparedHighLevelMirrorIntent({
      id: fixture.remoteAppointmentId,
      calendarId: fixture.remoteCalendarId,
      contactId: fixture.remoteContactId,
      locationId: fixture.locationId,
      title: before.title,
      startTime: fixture.startTime,
      endTime: fixture.endTime
    })
    assert.equal(claimedBeforeReconcile?.ownership, 'ristak')
    assert.equal(claimedBeforeReconcile?.claimedIntent, true)
    const pendingAfterClaim = await db.get(
      'SELECT id, ghl_appointment_id, sync_status FROM appointments WHERE id = ?',
      [fixture.appointmentId]
    )
    assert.deepEqual(pendingAfterClaim, {
      id: fixture.appointmentId,
      ghl_appointment_id: fixture.remoteAppointmentId,
      sync_status: 'pending'
    })
    assert.equal(
      Number((await db.get('SELECT COUNT(*) AS total FROM appointments WHERE ghl_appointment_id = ?', [fixture.remoteAppointmentId])).total),
      1
    )

    const res = responseCapture()
    await handleAppointmentWebhook({
      body: {
        contact_id: fixture.remoteContactId,
        locationId: fixture.locationId,
        title: before.title,
        status: before.status,
        appointment_status: before.appointment_status,
        assignedUserId: before.assigned_user_id,
        notes: before.notes,
        address: before.address,
        startTime: fixture.startTime,
        endTime: fixture.endTime,
        dateUpdated: before.date_updated,
        calendar: {
          id: fixture.remoteCalendarId,
          appointmentId: fixture.remoteAppointmentId
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)
    const claimed = await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(claimed.id, fixture.appointmentId)
    assert.equal(claimed.source, 'ristak')
    assert.equal(claimed.ghl_appointment_id, fixture.remoteAppointmentId)
    const intent = await db.get(
      'SELECT status, remote_appointment_id FROM appointment_highlevel_mirror_intents WHERE appointment_id = ?',
      [fixture.appointmentId]
    )
    assert.deepEqual(intent, { status: 'linked', remote_appointment_id: fixture.remoteAppointmentId })

    // La respuesta tardía del POST sólo confirma el mismo vínculo; no puede crear
    // ni convertir otra fila en dueña de la cita.
    await markHighLevelAppointmentMirrorSynced(fixture.appointmentId, fixture.remoteAppointmentId)
    await completeHighLevelAppointmentMirrorIntent(fixture.appointmentId, fixture.remoteAppointmentId)
    await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(
      Number((await db.get('SELECT COUNT(*) AS total FROM contacts WHERE ghl_contact_id = ?', [fixture.remoteContactId])).total),
      1
    )
  } finally {
    await cleanupFixture(fixture)
  }
})

test('la confirmación tardía de GHL acepta el mismo ID adelantado pero jamás reemplaza otro dueño remoto', async () => {
  const fixture = await createFixture('mirror_remote_id_cas', { linkMirror: false })
  try {
    const expected = await getLocalAppointment(fixture.appointmentId)

    // Simula que el webhook llegó antes que la respuesta del POST y ya reclamó
    // exactamente el mismo espejo remoto. La confirmación tardía es idempotente.
    await db.run(`
      UPDATE appointments
      SET ghl_appointment_id = ?, sync_status = 'pending'
      WHERE id = ?
    `, [fixture.remoteAppointmentId, fixture.appointmentId])
    const accepted = await markHighLevelAppointmentMirrorSynced(
      fixture.appointmentId,
      fixture.remoteAppointmentId,
      { expectedAppointment: expected }
    )
    assert.equal(accepted.ghlAppointmentId, fixture.remoteAppointmentId)
    assert.equal(accepted.syncStatus, 'synced')

    // Si otro webhook ya reclamó la fila con un ID distinto, una respuesta vieja
    // no puede robar esa relación ni siquiera cuando el negocio no cambió.
    const competingRemoteId = `ghl_competing_${fixture.suffix}`
    await db.run(`
      UPDATE appointments
      SET ghl_appointment_id = ?, sync_status = 'pending'
      WHERE id = ?
    `, [competingRemoteId, fixture.appointmentId])
    const competingSnapshot = await getLocalAppointment(fixture.appointmentId)
    await assert.rejects(
      () => markHighLevelAppointmentMirrorSynced(
        fixture.appointmentId,
        fixture.remoteAppointmentId,
        { expectedAppointment: competingSnapshot }
      ),
      error => error?.code === 'appointment_provider_response_stale'
    )

    const preserved = await getLocalAppointment(fixture.appointmentId)
    assert.equal(preserved.ghlAppointmentId, competingRemoteId)
    assert.equal(preserved.syncStatus, 'pending')
  } finally {
    await cleanupFixture(fixture)
  }
})

test('una respuesta vieja de GHL conserva la edición local nueva y deja el espejo pendiente', async () => {
  const fixture = await createFixture('mirror_business_version_cas', { linkMirror: false })
  try {
    const outgoingSnapshot = await getLocalAppointment(fixture.appointmentId)
    const editedAt = new Date(Date.parse(outgoingSnapshot.dateUpdated) + 60_000).toISOString()
    await db.run(`
      UPDATE appointments
      SET title = ?, sync_status = 'pending', date_updated = ?
      WHERE id = ?
    `, ['Edición local más reciente', editedAt, fixture.appointmentId])

    await assert.rejects(
      () => markHighLevelAppointmentMirrorSynced(
        fixture.appointmentId,
        fixture.remoteAppointmentId,
        { expectedAppointment: outgoingSnapshot }
      ),
      error => error?.code === 'appointment_provider_response_stale'
    )

    let preserved = await getLocalAppointment(fixture.appointmentId)
    assert.equal(preserved.title, 'Edición local más reciente')
    assert.equal(preserved.syncStatus, 'pending')
    assert.equal(
      preserved.ghlAppointmentId,
      fixture.remoteAppointmentId,
      'un ID confirmado se conserva para que el reintento haga PUT y no duplique con otro POST'
    )

    const errorSnapshot = preserved
    const editedAgainAt = new Date(Date.parse(preserved.dateUpdated) + 60_000).toISOString()
    await db.run(`
      UPDATE appointments
      SET notes = ?, sync_status = 'pending', date_updated = ?
      WHERE id = ?
    `, ['Otra edición local todavía más nueva', editedAgainAt, fixture.appointmentId])
    await assert.rejects(
      () => markHighLevelAppointmentMirrorError(
        fixture.appointmentId,
        '[remote_outcome_unknown] HighLevel no confirmó el resultado del write.',
        { expectedAppointment: errorSnapshot }
      ),
      error => error?.code === 'appointment_provider_response_stale'
    )

    preserved = await getLocalAppointment(fixture.appointmentId)
    assert.equal(preserved.notes, 'Otra edición local todavía más nueva')
    assert.equal(preserved.syncStatus, 'pending')
    assert.match(preserved.syncError || '', /remote_outcome_unknown/)
  } finally {
    await cleanupFixture(fixture)
  }
})

test('la cerca de versión GHL usa igualdad de timestamp compatible con PostgreSQL', async () => {
  const source = await readFile(LOCAL_CALENDAR_SERVICE_SOURCE, 'utf8')
  assert.doesNotMatch(source, /COALESCE\(date_updated,\s*''\)/)
  assert.match(source, /AND date_updated = \?/)
})

test('webhook showed trata el estado remoto como divergencia y conserva el estado canónico Ristak', async () => {
  const fixture = await createFixture('showed_webhook_echo')
  try {
    const before = await db.get('SELECT * FROM appointments WHERE id = ?', [fixture.appointmentId])
    const expectedSnapshot = businessSnapshot(before)
    const intruderContactId = `ghl_contact_intruso_${fixture.suffix}`
    const res = responseCapture()

    await handleAppointmentShowedWebhook({
      body: {
        appointmentId: fixture.remoteAppointmentId,
        contactId: intruderContactId,
        locationId: fixture.locationId,
        calendar: {
          id: fixture.remoteCalendarId,
          title: before.title,
          startTime: fixture.startTime,
          endTime: fixture.endTime
        }
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.appointment_id, fixture.appointmentId)
    const stored = await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(stored.appointment_status, 'confirmed')
    assert.equal(stored.sync_status, 'pending')
    const signals = await db.get(
      'SELECT COUNT(*) AS total FROM appointment_attendance_signals WHERE appointment_id = ?',
      [fixture.appointmentId]
    )
    assert.equal(Number(signals.total), 0)
    assert.equal(
      Number((await db.get('SELECT COUNT(*) AS total FROM contacts WHERE ghl_contact_id = ?', [intruderContactId])).total),
      0
    )
  } finally {
    await cleanupFixture(fixture)
  }
})

test('refresh de getEvents usa la misma reconciliación y no crea una segunda fila por el ID GHL', async () => {
  const fixture = await createFixture('events_refresh_echo')
  const previousConfig = await db.all('SELECT * FROM highlevel_config')
  const previousFetch = global.fetch
  try {
    const before = await db.get('SELECT * FROM appointments WHERE id = ?', [fixture.appointmentId])
    const expectedSnapshot = businessSnapshot(before)
    await db.run('DELETE FROM highlevel_config')
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
      [fixture.locationId, `token_${fixture.suffix}`, '{}']
    )
    global.fetch = async (url, options = {}) => {
      assert.equal(String(options.method || 'GET').toUpperCase(), 'GET')
      assert.match(String(url), /services\.leadconnectorhq\.com\/calendars\/events/)
      return new Response(JSON.stringify({ events: [divergentRemoteEvent(fixture)] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const res = responseCapture()
    await getEvents({
      query: {
        startTime: String(Date.parse(fixture.startTime) - 60_000),
        endTime: String(Date.parse(fixture.endTime) + 60_000),
        calendarId: fixture.calendarId
      }
    }, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.body?.success, true)

    const deadline = Date.now() + 3_000
    let stored
    do {
      stored = await db.get('SELECT * FROM appointments WHERE id = ?', [fixture.appointmentId])
      if (stored?.sync_status === 'pending') break
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline)

    await assertSingleCanonicalAppointment(fixture, expectedSnapshot)
    assert.equal(stored?.sync_status, 'pending')
  } finally {
    global.fetch = previousFetch
    await db.run('DELETE FROM highlevel_config').catch(() => undefined)
    for (const row of previousConfig) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO highlevel_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      ).catch(() => undefined)
    }
    await cleanupFixture(fixture)
  }
})
