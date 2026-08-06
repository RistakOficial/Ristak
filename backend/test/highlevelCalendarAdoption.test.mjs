import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DateTime } from 'luxon'

import { db } from '../src/config/database.js'
import { domainToolSpecs } from '../src/mcp/domainTools.js'
import {
  adoptDisconnectedHighLevelCalendars,
  upsertLocalAppointment,
  upsertLocalCalendar
} from '../src/services/localCalendarService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const backendRoot = join(__dirname, '..')
const SOURCE_PREFERENCE_KEY = 'calendar_source_preference'

async function snapshotRows(tableName) {
  const rows = await db.all(`SELECT * FROM ${tableName}`).catch(() => [])
  return {
    async restore() {
      await db.run(`DELETE FROM ${tableName}`).catch(() => undefined)

      for (const row of rows) {
        const columns = Object.keys(row)
        if (!columns.length) continue
        const quotedColumns = columns.map(column => `"${column}"`).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        await db.run(
          `INSERT INTO ${tableName} (${quotedColumns}) VALUES (${placeholders})`,
          columns.map(column => row[column])
        )
      }
    }
  }
}

async function snapshotAppConfigValue(configKey) {
  const row = await db.get('SELECT * FROM app_config WHERE config_key = ?', [configKey])
  return {
    async restore() {
      await db.run('DELETE FROM app_config WHERE config_key = ?', [configKey]).catch(() => undefined)
      if (!row) return

      const columns = Object.keys(row)
      const quotedColumns = columns.map(column => `"${column}"`).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      await db.run(
        `INSERT INTO app_config (${quotedColumns}) VALUES (${placeholders})`,
        columns.map(column => row[column])
      )
    }
  }
}

async function cleanupCalendar(calendarId) {
  await db.run('DELETE FROM appointment_highlevel_mirror_intents WHERE local_calendar_id = ?', [calendarId]).catch(() => undefined)
  await db.run('DELETE FROM appointments WHERE calendar_id = ?', [calendarId]).catch(() => undefined)
  await db.run('DELETE FROM calendars WHERE id = ?', [calendarId]).catch(() => undefined)
}

test('adopta calendarios HighLevel desconectados sin cambiar IDs, slugs ni citas', async () => {
  const suffix = randomUUID()
  const calendarId = `ghl_adopt_${suffix}`
  const remoteCalendarId = `ghl_remote_adopt_${suffix}`
  const importedAppointmentId = `ghl_appt_imported_${suffix}`
  const localAppointmentId = `rstk_appt_linked_${suffix}`
  const deletedAppointmentId = `ghl_appt_deleted_${suffix}`
  const googleAppointmentId = `google_appt_${suffix}`
  const highLevelSnapshot = await snapshotRows('highlevel_config')
  const preferenceSnapshot = await snapshotAppConfigValue(SOURCE_PREFERENCE_KEY)
  const start = DateTime.utc().plus({ days: 30 }).set({ hour: 16, minute: 0, second: 0, millisecond: 0 })

  try {
    await db.run('DELETE FROM highlevel_config')
    await db.run('DELETE FROM app_config WHERE config_key = ?', [SOURCE_PREFERENCE_KEY])
    await db.run(
      'INSERT INTO app_config (config_key, config_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
      [SOURCE_PREFERENCE_KEY, 'ghl']
    )

    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: remoteCalendarId,
      locationId: 'loc_adoption_test',
      name: 'Agenda que será Ristak',
      slug: `agenda-adoptada-${suffix}`,
      widgetSlug: `agenda-adoptada-${suffix}`,
      source: 'ghl',
      slotDuration: 45,
      notes: 'Configuración que debe sobrevivir'
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId: remoteCalendarId,
      locationId: 'loc_adoption_test',
      syncStatus: 'synced'
    })

    await upsertLocalAppointment({
      id: importedAppointmentId,
      ghlAppointmentId: `remote_imported_${suffix}`,
      calendarId,
      locationId: 'loc_adoption_test',
      title: 'Cita importada',
      source: 'ghl',
      startTime: start.toISO(),
      endTime: start.plus({ minutes: 45 }).toISO()
    }, {
      id: importedAppointmentId,
      source: 'ghl',
      ghlAppointmentId: `remote_imported_${suffix}`,
      calendarId,
      locationId: 'loc_adoption_test',
      syncStatus: 'error',
      syncError: 'fallo remoto anterior'
    })
    await upsertLocalAppointment({
      id: localAppointmentId,
      ghlAppointmentId: `remote_linked_${suffix}`,
      calendarId,
      locationId: 'loc_adoption_test',
      title: 'Cita creada en Ristak y ligada',
      source: 'ristak',
      startTime: start.plus({ hours: 1 }).toISO(),
      endTime: start.plus({ hours: 1, minutes: 45 }).toISO()
    }, {
      id: localAppointmentId,
      source: 'ristak',
      ghlAppointmentId: `remote_linked_${suffix}`,
      calendarId,
      locationId: 'loc_adoption_test',
      syncStatus: 'pending'
    })
    await upsertLocalAppointment({
      id: deletedAppointmentId,
      ghlAppointmentId: `remote_deleted_${suffix}`,
      calendarId,
      locationId: 'loc_adoption_test',
      title: 'Cita borrada localmente',
      source: 'ghl',
      startTime: start.plus({ hours: 2 }).toISO(),
      endTime: start.plus({ hours: 2, minutes: 45 }).toISO()
    }, {
      id: deletedAppointmentId,
      source: 'ghl',
      ghlAppointmentId: `remote_deleted_${suffix}`,
      calendarId,
      locationId: 'loc_adoption_test',
      syncStatus: 'pending_delete'
    })
    await upsertLocalAppointment({
      id: googleAppointmentId,
      googleEventId: `google_remote_${suffix}`,
      calendarId,
      title: 'Cita Google que no debe cambiar',
      source: 'google',
      startTime: start.plus({ hours: 3 }).toISO(),
      endTime: start.plus({ hours: 3, minutes: 45 }).toISO()
    }, {
      id: googleAppointmentId,
      source: 'google',
      googleEventId: `google_remote_${suffix}`,
      calendarId,
      syncStatus: 'synced',
      googleSyncStatus: 'synced'
    })

    await db.run(`
      INSERT INTO appointment_highlevel_mirror_intents (
        appointment_id, local_calendar_id, remote_calendar_id, start_time, end_time,
        normalized_title, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)
    `, [
      importedAppointmentId,
      calendarId,
      remoteCalendarId,
      start.toISO(),
      start.plus({ minutes: 45 }).toISO(),
      'cita importada',
      start.plus({ hours: 1 }).toISO()
    ])

    const result = await adoptDisconnectedHighLevelCalendars([calendarId])

    assert.equal(result.adoptedCalendarCount, 1)
    assert.equal(result.adoptedAppointmentCount, 3)
    assert.equal(result.discardedMirrorIntentCount, 1)
    assert.equal(result.sourcePreferenceUpdated, true)
    assert.equal(result.calendars[0]?.id, calendarId)
    assert.equal(result.calendars[0]?.source, 'ristak')
    assert.equal(result.calendars[0]?.slug, `agenda-adoptada-${suffix}`)
    assert.equal(result.calendars[0]?.slotDuration, 45)

    const storedCalendar = await db.get(
      'SELECT id, source, ghl_calendar_id, location_id, slug, sync_status, sync_error, last_synced_at FROM calendars WHERE id = ?',
      [calendarId]
    )
    assert.deepEqual(storedCalendar, {
      id: calendarId,
      source: 'ristak',
      ghl_calendar_id: null,
      location_id: null,
      slug: `agenda-adoptada-${suffix}`,
      sync_status: 'synced',
      sync_error: null,
      last_synced_at: null
    })

    const adoptedAppointments = await db.all(`
      SELECT id, source, ghl_appointment_id, location_id, sync_status, sync_error, synced_at
      FROM appointments
      WHERE id IN (?, ?, ?)
      ORDER BY id
    `, [deletedAppointmentId, importedAppointmentId, localAppointmentId])
    assert.equal(adoptedAppointments.length, 3)
    for (const appointment of adoptedAppointments) {
      assert.equal(appointment.source, 'ristak')
      assert.equal(appointment.ghl_appointment_id, null)
      assert.equal(appointment.location_id, null)
      assert.equal(appointment.sync_error, null)
      assert.equal(appointment.synced_at, null)
    }
    assert.equal(
      adoptedAppointments.find(appointment => appointment.id === deletedAppointmentId)?.sync_status,
      'pending_delete'
    )
    assert.equal(
      adoptedAppointments.find(appointment => appointment.id === importedAppointmentId)?.sync_status,
      'synced'
    )

    const googleAppointment = await db.get(
      'SELECT source, google_event_id, google_sync_status FROM appointments WHERE id = ?',
      [googleAppointmentId]
    )
    assert.deepEqual(googleAppointment, {
      source: 'google',
      google_event_id: `google_remote_${suffix}`,
      google_sync_status: 'synced'
    })

    const preference = await db.get('SELECT config_value FROM app_config WHERE config_key = ?', [SOURCE_PREFERENCE_KEY])
    assert.equal(preference?.config_value, 'ristak')
  } finally {
    await cleanupCalendar(calendarId)
    await preferenceSnapshot.restore()
    await highLevelSnapshot.restore()
  }
})

test('rechaza la adopción completa si HighLevel sigue conectado', async () => {
  const suffix = randomUUID()
  const calendarId = `ghl_adopt_connected_${suffix}`
  const highLevelSnapshot = await snapshotRows('highlevel_config')

  try {
    await db.run('DELETE FROM highlevel_config')
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token, location_data) VALUES (?, ?, ?)',
      ['loc_connected_adoption', 'token_connected_adoption', '{}']
    )
    await upsertLocalCalendar({
      id: calendarId,
      ghlCalendarId: `remote_connected_${suffix}`,
      locationId: 'loc_connected_adoption',
      name: 'Agenda todavía conectada',
      source: 'ghl'
    }, {
      id: calendarId,
      source: 'ghl',
      ghlCalendarId: `remote_connected_${suffix}`,
      locationId: 'loc_connected_adoption',
      syncStatus: 'synced'
    })

    await assert.rejects(
      () => adoptDisconnectedHighLevelCalendars([calendarId]),
      error => {
        assert.equal(error?.status, 409)
        assert.equal(error?.code, 'calendar_adoption_requires_highlevel_disconnect')
        return true
      }
    )

    const stored = await db.get('SELECT source, ghl_calendar_id FROM calendars WHERE id = ?', [calendarId])
    assert.equal(stored?.source, 'ghl')
    assert.equal(stored?.ghl_calendar_id, `remote_connected_${suffix}`)
  } finally {
    await cleanupCalendar(calendarId)
    await highLevelSnapshot.restore()
  }
})

test('expone la adopción por ruta privada y herramienta MCP idempotente', async () => {
  const routesSource = await readFile(join(backendRoot, 'src/routes/calendars.routes.js'), 'utf8')
  assert.match(routesSource, /router\.post\('\/adopt-highlevel', calendarsController\.adoptHighLevelCalendars\)/)

  const tool = domainToolSpecs.find(spec => spec.name === 'appointments_adopt_highlevel_calendars')
  assert.ok(tool)
  assert.equal(tool.module, 'appointments')
  assert.equal(tool.access, 'write')
  assert.equal(tool.scope, 'ristak.execute')
  assert.equal(tool.idempotencyRequired, true)
  assert.deepEqual(tool.inputSchema.required, ['calendarIds', 'idempotencyKey'])
  assert.equal(tool.inputSchema.properties.calendarIds.maxItems, 100)
})
