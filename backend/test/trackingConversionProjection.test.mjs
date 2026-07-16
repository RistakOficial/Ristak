import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { DateTime } from 'luxon'
import pg from 'pg'

import { databaseDialect, db, setAppConfig } from '../src/config/database.js'
import { getGroupExpression } from '../src/services/analyticsService.js'
import { runCrmListProjectionBackfill } from '../src/services/crmListProjectionService.js'
import { migrationRunsForDialect, runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  runTrackingAnalyticsProjectionBackfill
} from '../src/services/trackingAnalyticsProjectionService.js'
import {
  getTrackingConversionProjectionStatus,
  queryTrackingConversionProjection,
  runTrackingConversionProjectionBackfill,
  supportsTrackingConversionProjectionFilters
} from '../src/services/trackingConversionProjectionService.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

const postgresConnectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''
const sqliteMigrationUrl = new URL('../migrations/versioned/116_tracking_conversion_projection.sqlite.sql', import.meta.url)
const postgresMigrationUrl = new URL('../migrations/versioned/116a_tracking_conversion_projection.postgres.sql', import.meta.url)

const SUCCESS_STATUSES = ['succeeded', 'paid', 'completed', 'complete', 'fulfilled', 'success']
const INACTIVE_APPOINTMENT_STATUSES = [
  'cancelled',
  'canceled',
  'no_show',
  'no-show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
]
const ATTENDED_APPOINTMENT_STATUSES = ['show', 'showed', 'completed', 'complete', 'attended']

const sqlList = values => values.map(value => `'${value}'`).join(', ')
const successSql = sqlList(SUCCESS_STATUSES)
const inactiveSql = sqlList(INACTIVE_APPOINTMENT_STATUSES)
const attendedSql = sqlList(ATTENDED_APPOINTMENT_STATUSES)

function uniquePrefix() {
  return `tracking_conversion_projection_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function businessRange(startDate, endExclusiveDate, timezone) {
  return {
    startUtc: DateTime.fromISO(startDate, { zone: timezone }).startOf('day').toUTC().toISO(),
    endExclusiveUtc: DateTime.fromISO(endExclusiveDate, { zone: timezone }).startOf('day').toUTC().toISO(),
    timezone
  }
}

function emptyMetrics() {
  return { registrations: 0, prospects: 0, appointments: 0, attendances: 0, customers: 0, purchases: 0 }
}

function normalizeRows(rows, includeSeries) {
  const metrics = rows.reduce((totals, row) => ({
    registrations: totals.registrations + Number(row.registrations || 0),
    prospects: totals.prospects + Number(row.prospects || 0),
    appointments: totals.appointments + Number(row.appointments || 0),
    attendances: totals.attendances + Number(row.attendances || 0),
    customers: totals.customers + Number(row.customers || 0),
    purchases: totals.purchases + Number(row.purchases || 0)
  }), emptyMetrics())
  const stageCounts = rows.reduce((totals, row) => ({
    appointmentScheduled: totals.appointmentScheduled + Number(row.stage_appointments || 0),
    appointmentAttended: totals.appointmentAttended + Number(row.stage_attendances || 0)
  }), { appointmentScheduled: 0, appointmentAttended: 0 })
  const series = includeSeries
    ? rows.map(row => ({
        period: String(row.period || ''),
        registrations: Number(row.registrations || 0),
        prospects: Number(row.prospects || 0),
        appointments: Number(row.appointments || 0),
        attendances: Number(row.attendances || 0),
        customers: Number(row.customers || 0),
        purchases: Number(row.purchases || 0)
      }))
    : []
  return { metrics, series, stageCounts }
}

function legacyStageExpression(alias = 'cf') {
  return `CASE
    WHEN ${alias}.contact_id IS NULL OR ${alias}.contact_id = '' THEN NULL
    WHEN COALESCE(${alias}.payment_count, 0) > 0 THEN 'customer'
    WHEN COALESCE(${alias}.has_attendance, 0) > 0 THEN 'appointment_attended'
    WHEN COALESCE(${alias}.has_appointment, 0) > 0 THEN 'appointment_scheduled'
    ELSE 'prospect'
  END`
}

async function queryLegacyConversionSql(range, { groupBy = 'day', includeSeries = true, conversionStages = [] } = {}) {
  const params = [range.startUtc, range.endExclusiveUtc]
  const periodExpression = getGroupExpression('contact_created_at', groupBy, range.timezone)
  const stages = [...new Set(conversionStages)]
  const stageCondition = stages.length > 0
    ? `${legacyStageExpression('cf')} IN (${stages.map(() => '?').join(', ')})`
    : ''
  params.push(...stages)

  const rows = await db.all(`
    WITH
    candidate_contacts AS (
      SELECT c.id AS contact_id
      FROM contacts c
      WHERE c.created_at >= ?
        AND c.created_at < ?
        AND (
          (c.visitor_id IS NOT NULL AND c.visitor_id != '')
          OR LOWER(COALESCE(c.source, '')) LIKE '%whatsapp%'
          OR EXISTS (SELECT 1 FROM whatsapp_api_messages wam WHERE wam.contact_id = c.id)
          OR EXISTS (SELECT 1 FROM whatsapp_api_attribution waa WHERE waa.contact_id = c.id)
          OR EXISTS (SELECT 1 FROM whatsapp_attribution wa WHERE wa.contact_id = c.id)
        )
    ),
    payment_facts AS (
      SELECT p.contact_id, COUNT(*) AS payment_count
      FROM payments p
      INNER JOIN candidate_contacts candidate ON candidate.contact_id = p.contact_id
      WHERE COALESCE(p.amount, 0) > 0
        AND LOWER(COALESCE(p.status, '')) IN (${successSql})
        AND COALESCE(p.payment_mode, 'live') != 'test'
      GROUP BY p.contact_id
    ),
    appointment_facts AS (
      SELECT
        a.contact_id,
        MAX(CASE
          WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${inactiveSql}) THEN 1
          ELSE 0
        END) AS has_appointment,
        MAX(CASE
          WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) IN (${attendedSql}) THEN 1
          ELSE 0
        END) AS has_attended_status
      FROM appointments a
      INNER JOIN candidate_contacts candidate ON candidate.contact_id = a.contact_id
      GROUP BY a.contact_id
    ),
    attendance_facts AS (
      SELECT signal.contact_id, 1 AS has_attendance_signal
      FROM appointment_attendance_signals signal
      INNER JOIN candidate_contacts candidate ON candidate.contact_id = signal.contact_id
      GROUP BY signal.contact_id
    ),
    contact_facts AS (
      SELECT
        c.id AS contact_id,
        c.created_at AS contact_created_at,
        COALESCE(pf.payment_count, 0) AS payment_count,
        CASE WHEN c.appointment_date IS NOT NULL OR COALESCE(af.has_appointment, 0) > 0 THEN 1 ELSE 0 END AS has_appointment,
        CASE
          WHEN COALESCE(att.has_attendance_signal, 0) > 0 OR COALESCE(af.has_attended_status, 0) > 0 THEN 1
          ELSE 0
        END AS has_attendance
      FROM contacts c
      INNER JOIN candidate_contacts candidate ON candidate.contact_id = c.id
      LEFT JOIN payment_facts pf ON pf.contact_id = c.id
      LEFT JOIN appointment_facts af ON af.contact_id = c.id
      LEFT JOIN attendance_facts att ON att.contact_id = c.id
    )
    SELECT
      ${includeSeries ? `${periodExpression} AS period,` : `NULL AS period,`}
      COUNT(*) AS registrations,
      SUM(CASE WHEN ${legacyStageExpression('cf')} = 'prospect' THEN 1 ELSE 0 END) AS prospects,
      SUM(CASE WHEN COALESCE(cf.has_appointment, 0) > 0 THEN 1 ELSE 0 END) AS appointments,
      SUM(CASE WHEN COALESCE(cf.has_attendance, 0) > 0 THEN 1 ELSE 0 END) AS attendances,
      SUM(CASE WHEN COALESCE(cf.payment_count, 0) > 0 THEN 1 ELSE 0 END) AS customers,
      SUM(COALESCE(cf.payment_count, 0)) AS purchases,
      SUM(CASE WHEN ${legacyStageExpression('cf')} = 'appointment_scheduled' THEN 1 ELSE 0 END) AS stage_appointments,
      SUM(CASE WHEN ${legacyStageExpression('cf')} = 'appointment_attended' THEN 1 ELSE 0 END) AS stage_attendances
    FROM contact_facts cf
    ${stageCondition ? `WHERE ${stageCondition}` : ''}
    ${includeSeries ? `GROUP BY ${periodExpression} ORDER BY period ASC` : ''}
  `, params)

  return normalizeRows(rows, includeSeries)
}

async function cleanup(prefix) {
  await db.run('DELETE FROM whatsapp_api_attribution WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM whatsapp_attribution WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM sessions WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM appointment_attendance_signals WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM appointments WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM payments WHERE contact_id LIKE ?', [`${prefix}%`])
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`])
}

async function setTimezone(timezone) {
  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, timezone)
  invalidateTimezoneCache()
}

async function convergeTrackingProjection() {
  let result = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    result = await runTrackingAnalyticsProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 20,
      maxQueueBatches: 20,
      yieldMs: 0
    })
    if (result.ready) return result
  }
  assert.fail(`la proyección de sesiones no convergió: ${JSON.stringify(result)}`)
}

async function insertContact({ id, timestamp, source = 'tracking', visitor = true, appointmentDate = null }) {
  await db.run(`
    INSERT INTO contacts (id, full_name, source, visitor_id, appointment_date, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [id, id, source, visitor ? `${id}_visitor` : null, appointmentDate, timestamp, timestamp])
}

async function convergeConversionProjection() {
  let result = null
  for (let attempt = 0; attempt < 20; attempt += 1) {
    result = await runTrackingConversionProjectionBackfill({
      batchSize: 100,
      queueBatchSize: 100,
      maxBatches: 20,
      maxQueueBatches: 20,
      yieldMs: 0
    })
    if (result.ready) break
  }
  assert.equal(result?.ready, true, `la proyección no convergió: ${JSON.stringify(result)}`)
  assert.equal((await getTrackingConversionProjectionStatus()).ready, true)
}

test('116 separa dialectos y los triggers sólo coalescen la llave en la cola', async () => {
  assert.equal(migrationRunsForDialect('116_tracking_conversion_projection.sqlite.sql', 'sqlite'), true)
  assert.equal(migrationRunsForDialect('116_tracking_conversion_projection.sqlite.sql', 'postgres'), false)
  assert.equal(migrationRunsForDialect('116a_tracking_conversion_projection.postgres.sql', 'postgres'), true)
  assert.equal(migrationRunsForDialect('116a_tracking_conversion_projection.postgres.sql', 'sqlite'), false)

  const [sqliteSql, postgresSql, serviceSource] = await Promise.all([
    readFile(sqliteMigrationUrl, 'utf8'),
    readFile(postgresMigrationUrl, 'utf8'),
    readFile(new URL('../src/services/trackingConversionProjectionService.js', import.meta.url), 'utf8')
  ])
  for (const sql of [sqliteSql, postgresSql]) {
    assert.match(sql, /tracking_conversion_projection_state/i)
    assert.match(sql, /tracking_conversion_change_queue/i)
    assert.match(sql, /tracking_conversion_contact_fact/i)
    assert.match(sql, /tracking_conversion_daily_rollup/i)
    assert.match(sql, /revision\s*=\s*tracking_conversion_change_queue\.revision\s*\+\s*1/i)
  }

  const postgresTriggerFunctions = postgresSql.slice(
    postgresSql.indexOf('CREATE OR REPLACE FUNCTION enqueue_tracking_conversion_contact_row_change'),
    postgresSql.indexOf('DROP TRIGGER IF EXISTS trg_tracking_conversion_contact_change')
  )
  assert.match(postgresTriggerFunctions, /INSERT INTO tracking_conversion_change_queue/i)
  assert.doesNotMatch(postgresTriggerFunctions, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?tracking_conversion_(?:contact_fact|daily_rollup)/i)
  assert.doesNotMatch(postgresTriggerFunctions, /\bEXISTS\s*\(|\bFROM\s+contacts\b/i)

  const sourceBatch = serviceSource.slice(
    serviceSource.indexOf('async function readSourceRowsByIds'),
    serviceSource.indexOf('async function readFactsByIds')
  )
  assert.match(sourceBatch, /active_appointments_count/i)
  assert.match(sourceBatch, /WHEN COALESCE\(cla\.active_appointments_count, 0\) <= 0 THEN 0/i)
  assert.match(sourceBatch, /FROM appointments exceptional_no_show[\s\S]*= 'no-show'/i)
  assert.doesNotMatch(sourceBatch, /NOT IN\s*\(/i, 'el backfill no repite un probe general de citas por contacto')
})

test('116a usa tipos PostgreSQL y no pierde una mutación concurrente durante el lock del worker', {
  skip: !postgresConnectionString,
  timeout: 30_000
}, async () => {
  const client = new pg.Client({ connectionString: postgresConnectionString })
  const concurrentClient = new pg.Client({ connectionString: postgresConnectionString })
  const schema = `tracking_conversion_projection_${randomUUID().replaceAll('-', '')}`
  const contactId = randomUUID()
  await client.connect()
  await concurrentClient.connect()
  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await concurrentClient.query(`SET search_path TO "${schema}", public`)
    await client.query(`
      CREATE TABLE contacts (
        id UUID PRIMARY KEY,
        visitor_id TEXT,
        source TEXT,
        created_at TIMESTAMPTZ,
        appointment_date TIMESTAMPTZ
      );
      CREATE TABLE contact_list_activity (
        contact_id UUID PRIMARY KEY,
        purchases_count BIGINT NOT NULL DEFAULT 0,
        active_appointments_count BIGINT NOT NULL DEFAULT 0,
        attended_appointments_count BIGINT NOT NULL DEFAULT 0,
        attendance_signals_count BIGINT NOT NULL DEFAULT 0
      );
      CREATE TABLE whatsapp_api_messages (id UUID PRIMARY KEY, contact_id UUID);
      CREATE TABLE whatsapp_api_attribution (id UUID PRIMARY KEY, contact_id UUID);
      CREATE TABLE whatsapp_attribution (id UUID PRIMARY KEY, contact_id UUID)
    `)
    await client.query(await readFile(postgresMigrationUrl, 'utf8'))

    await client.query(`
      INSERT INTO contacts(id, visitor_id, source, created_at)
      VALUES ($1, 'visitor-pg', 'tracking', '2026-01-02T01:30:00Z')
    `, [contactId])
    await client.query(`UPDATE contacts SET source = 'tracking-updated' WHERE id = $1`, [contactId])
    await client.query(`UPDATE contacts SET visitor_id = 'visitor-pg-updated' WHERE id = $1`, [contactId])
    const queued = await client.query(`
      SELECT contact_id, revision, pg_typeof(contact_id)::text AS id_type
      FROM tracking_conversion_change_queue
      WHERE contact_id = $1::text
    `, [contactId])
    assert.deepEqual(queued.rows[0], {
      contact_id: contactId,
      revision: '3',
      id_type: 'text'
    })

    await client.query(`
      INSERT INTO tracking_conversion_contact_fact(
        contact_id, contact_created_at, business_date, stage, prospects
      ) VALUES ($1::text, '2026-01-02T01:30:00Z', '2026-01-01', 'prospect', 1)
    `, [contactId])
    const fact = await client.query(`
      SELECT
        business_date::text AS business_date,
        pg_typeof(business_date)::text AS date_type,
        pg_typeof(contact_created_at)::text AS timestamp_type
      FROM tracking_conversion_contact_fact
      WHERE contact_id = $1::text
    `, [contactId])
    assert.deepEqual(fact.rows[0], {
      business_date: '2026-01-01',
      date_type: 'date',
      timestamp_type: 'timestamp with time zone'
    })

    // El worker serializa su propio singleton, no el write path de producto.
    // Una revisión que llega durante ese lock debe sobrevivir al ACK CAS viejo.
    await client.query('BEGIN')
    await client.query(`
      SELECT singleton_id
      FROM tracking_conversion_projection_state
      WHERE singleton_id = 1
      FOR UPDATE
    `)
    const snapshot = await client.query(`
      SELECT revision
      FROM tracking_conversion_change_queue
      WHERE contact_id = $1::text
    `, [contactId])
    await concurrentClient.query(`SET lock_timeout = '750ms'`)
    const concurrentStartedAt = Date.now()
    await concurrentClient.query(`
      UPDATE contacts SET source = 'WhatsApp API' WHERE id = $1
    `, [contactId])
    assert.ok(Date.now() - concurrentStartedAt < 750)
    const staleAck = await client.query(`
      DELETE FROM tracking_conversion_change_queue
      WHERE contact_id = $1::text AND revision = $2
    `, [contactId, snapshot.rows[0].revision])
    assert.equal(staleAck.rowCount, 0)
    await client.query('COMMIT')

    const preserved = await client.query(`
      SELECT revision
      FROM tracking_conversion_change_queue
      WHERE contact_id = $1::text
    `, [contactId])
    assert.equal(preserved.rows[0].revision, '4')
  } finally {
    await client.query('ROLLBACK').catch(() => undefined)
    await client.query('SET search_path TO public').catch(() => undefined)
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
    await concurrentClient.end().catch(() => undefined)
    await client.end().catch(() => undefined)
  }
})

test('la proyeccion conserva la semantica del SQL legacy para actual, anterior y serie', async () => {
  const prefix = uniquePrefix()
  const timezone = 'America/Ciudad_Juarez'
  const currentRange = businessRange('2092-06-01', '2092-06-03', timezone)
  const previousRange = businessRange('2092-05-30', '2092-06-01', timezone)
  const at = (date, hour = 10) => DateTime.fromISO(`${date}T${String(hour).padStart(2, '0')}:00:00`, { zone: timezone }).toUTC().toISO()

  await runVersionedMigrations()
  await assert.rejects(
    queryTrackingConversionProjection({ currentRange, previousRange }),
    error => error?.code === 'tracking_conversion_projection_warming' && error?.status === 503
  )
  await cleanup(prefix)
  try {
    const prospect = `${prefix}_prospect`
    const contactAppointment = `${prefix}_contact_appointment`
    const activeAppointment = `${prefix}_active_appointment`
    const attendedStatus = `${prefix}_attended_status`
    const attendedSignal = `${prefix}_attended_signal`
    const customer = `${prefix}_customer`
    const noShow = `${prefix}_no_show`
    const whatsapp = `${prefix}_whatsapp`
    const excluded = `${prefix}_excluded`
    const previousProspect = `${prefix}_previous_prospect`
    const previousCustomer = `${prefix}_previous_customer`

    await insertContact({ id: prospect, timestamp: at('2092-06-01') })
    await insertContact({
      id: contactAppointment,
      timestamp: at('2092-06-01', 11),
      appointmentDate: at('2092-06-10')
    })
    await insertContact({ id: activeAppointment, timestamp: at('2092-06-02', 9) })
    await insertContact({ id: attendedStatus, timestamp: at('2092-06-02', 10) })
    await insertContact({ id: attendedSignal, timestamp: at('2092-06-02', 11) })
    await insertContact({ id: customer, timestamp: at('2092-06-02', 12) })
    await insertContact({ id: noShow, timestamp: at('2092-06-02', 13) })
    await insertContact({ id: whatsapp, timestamp: at('2092-06-02', 14), source: 'WhatsApp API', visitor: false })
    await insertContact({ id: excluded, timestamp: at('2092-06-02', 15), source: 'manual', visitor: false })
    await insertContact({ id: previousProspect, timestamp: at('2092-05-30') })
    await insertContact({ id: previousCustomer, timestamp: at('2092-05-31') })

    const appointments = [
      [`${prefix}_active`, activeAppointment, 'confirmed'],
      [`${prefix}_attended`, attendedStatus, 'completed'],
      [`${prefix}_cancelled`, attendedSignal, 'cancelled'],
      // El ledger historico considero por error `no-show` como activo. La ruta
      // proyectada conserva la semantica legacy aun con esa fila ya materializada.
      [`${prefix}_no_show_appointment`, noShow, 'no-show']
    ]
    for (const [id, contactId, status] of appointments) {
      await db.run(`
        INSERT INTO appointments (id, contact_id, title, status, appointment_status, start_time, date_added)
        VALUES (?, ?, 'Cita analitica', ?, ?, ?, ?)
      `, [id, contactId, status, status, at('2092-06-15'), at('2092-06-01')])
    }

    await db.run(`
      INSERT INTO appointment_attendance_signals (id, contact_id, appointment_id, source, first_seen_at, updated_at)
      VALUES (?, ?, ?, 'webhook_showed', ?, ?)
    `, [`${prefix}_signal`, attendedSignal, `${prefix}_cancelled`, at('2092-06-15'), at('2092-06-15')])

    const payments = [
      [`${prefix}_paid`, customer, 100, 'paid', 'live'],
      [`${prefix}_complete`, customer, 50, 'complete', 'live'],
      [`${prefix}_test`, customer, 900, 'succeeded', 'test'],
      [`${prefix}_failed`, customer, 80, 'failed', 'live'],
      [`${prefix}_zero`, customer, 0, 'succeeded', 'live'],
      [`${prefix}_excluded_paid`, excluded, 500, 'succeeded', 'live'],
      [`${prefix}_previous_paid`, previousCustomer, 25, 'fulfilled', 'live']
    ]
    for (const [id, contactId, amount, status, mode] of payments) {
      const timestamp = contactId === previousCustomer ? at('2092-05-31') : at('2092-06-02')
      await db.run(`
        INSERT INTO payments (id, contact_id, amount, status, payment_mode, date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [id, contactId, amount, status, mode, timestamp, timestamp, timestamp])
    }

    await runCrmListProjectionBackfill({ batchSize: 100, yieldMs: 0 })
    await convergeConversionProjection()

    const projected = await queryTrackingConversionProjection({
      currentRange,
      previousRange,
      groupBy: 'day'
    })
    assert.ok(projected)

    const legacyCurrent = await queryLegacyConversionSql(currentRange, { groupBy: 'day', includeSeries: true })
    const legacyPrevious = await queryLegacyConversionSql(previousRange, { groupBy: 'day', includeSeries: false })
    assert.deepEqual(projected.current, legacyCurrent)
    assert.deepEqual(projected.previous, legacyPrevious)

    for (const groupBy of ['month', 'year']) {
      const groupedProjection = await queryTrackingConversionProjection({
        currentRange,
        previousRange,
        groupBy
      })
      const groupedLegacy = await queryLegacyConversionSql(currentRange, { groupBy, includeSeries: true })
      assert.deepEqual(groupedProjection.current, groupedLegacy)
    }

    const projectedCustomers = await queryTrackingConversionProjection({
      currentRange,
      previousRange,
      groupBy: 'day',
      filters: { conversion_stage: ['customer'] }
    })
    const legacyCustomers = await queryLegacyConversionSql(currentRange, {
      groupBy: 'day',
      includeSeries: true,
      conversionStages: ['customer']
    })
    assert.deepEqual(projectedCustomers.current, legacyCustomers)

    const projectedInvalidStage = await queryTrackingConversionProjection({
      currentRange,
      previousRange,
      groupBy: 'day',
      filters: { conversion_stage: ['bogus'] }
    })
    const legacyInvalidStage = await queryLegacyConversionSql(currentRange, {
      groupBy: 'day',
      includeSeries: true,
      conversionStages: ['bogus']
    })
    assert.deepEqual(projectedInvalidStage.current, legacyInvalidStage)
    assert.deepEqual(projectedInvalidStage.current.metrics, emptyMetrics())
    assert.deepEqual(projectedInvalidStage.current.series, [])

    assert.equal(projected.current.metrics.registrations, 8, 'el contacto manual sin fuente analitica queda fuera')
    assert.equal(projected.current.metrics.purchases, 2, 'test, failed y monto cero no cuentan')
  } finally {
    await cleanup(prefix)
  }
})

test('la cola incremental mantiene elegibilidad, etapa, compras, no-show y borrados sin barrer contactos', async () => {
  await runVersionedMigrations()
  await setTimezone('UTC')
  await runCrmListProjectionBackfill({ batchSize: 100, yieldMs: 0 })
  await convergeConversionProjection()

  const prefix = uniquePrefix()
  const contactId = `${prefix}_manual`
  const at = '2096-03-04T12:00:00.000Z'
  const currentRange = businessRange('2096-03-04', '2096-03-05', 'UTC')
  const previousRange = businessRange('2096-03-03', '2096-03-04', 'UTC')
  const read = () => queryTrackingConversionProjection({ currentRange, previousRange })

  await cleanup(prefix)
  try {
    await insertContact({ id: contactId, timestamp: at, source: 'manual', visitor: false })
    await convergeConversionProjection()
    assert.equal((await read()).current.metrics.registrations, 0)

    const messageId = `${prefix}_message`
    await db.run(`
      INSERT INTO whatsapp_api_messages(id, contact_id, direction, message_timestamp, created_at)
      VALUES (?, ?, 'inbound', ?, ?)
    `, [messageId, contactId, at, at])
    await convergeConversionProjection()
    let projected = await read()
    assert.deepEqual(projected.current.metrics, {
      registrations: 1,
      prospects: 1,
      appointments: 0,
      attendances: 0,
      customers: 0,
      purchases: 0
    })

    const paymentId = `${prefix}_payment`
    await db.run(`
      INSERT INTO payments(id, contact_id, amount, status, payment_mode, date, created_at, updated_at)
      VALUES (?, ?, 150, 'paid', 'live', ?, ?, ?)
    `, [paymentId, contactId, at, at, at])
    await convergeConversionProjection()
    projected = await read()
    assert.equal(projected.current.metrics.customers, 1)
    assert.equal(projected.current.metrics.purchases, 1)

    await db.run(`UPDATE payments SET status = 'failed', updated_at = ? WHERE id = ?`, [at, paymentId])
    await convergeConversionProjection()
    projected = await read()
    assert.equal(projected.current.metrics.customers, 0)
    assert.equal(projected.current.metrics.prospects, 1)

    const appointmentId = `${prefix}_appointment`
    await db.run(`
      INSERT INTO appointments(id, contact_id, title, status, appointment_status, start_time, date_added)
      VALUES (?, ?, 'No show exacto', 'no-show', 'no-show', ?, ?)
    `, [appointmentId, contactId, at, at])
    await convergeConversionProjection()
    projected = await read()
    assert.equal(projected.current.metrics.appointments, 0, 'no-show con guion no cuenta como cita activa')
    assert.equal(projected.current.metrics.prospects, 1)

    await db.run(`
      UPDATE appointments
      SET status = 'completed', appointment_status = 'completed'
      WHERE id = ?
    `, [appointmentId])
    await convergeConversionProjection()
    projected = await read()
    assert.equal(projected.current.metrics.appointments, 1)
    assert.equal(projected.current.metrics.attendances, 1)
    assert.equal(projected.current.stageCounts.appointmentAttended, 1)

    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [messageId])
    await convergeConversionProjection()
    assert.equal((await read()).current.metrics.registrations, 0, 'sin fuente analítica deja el fact aunque conserve actividad')

    const attributionId = `${prefix}_attribution`
    await db.run(`
      INSERT INTO whatsapp_api_attribution(id, contact_id, created_at)
      VALUES (?, ?, ?)
    `, [attributionId, contactId, at])
    await convergeConversionProjection()
    assert.equal((await read()).current.metrics.attendances, 1)

    await db.run('DELETE FROM whatsapp_api_attribution WHERE id = ?', [attributionId])
    await convergeConversionProjection()
    assert.equal((await read()).current.metrics.registrations, 0)

    await db.run(`UPDATE contacts SET source = 'WhatsApp API' WHERE id = ?`, [contactId])
    await convergeConversionProjection()
    assert.equal((await read()).current.metrics.registrations, 1)

    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await convergeConversionProjection()
    assert.equal((await read()).current.metrics.registrations, 0)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM tracking_conversion_change_queue')).total), 0)
  } finally {
    await cleanup(prefix)
    await convergeConversionProjection()
  }
})

test('timezone rebuild mueve el día civil y un restart conserva el estado durable', async () => {
  await runVersionedMigrations()
  await runCrmListProjectionBackfill({ batchSize: 100, yieldMs: 0 })
  const prefix = uniquePrefix()
  const contactId = `${prefix}_timezone`
  const createdAt = '2097-01-01T01:00:00.000Z'

  await cleanup(prefix)
  try {
    await setTimezone('UTC')
    await insertContact({ id: contactId, timestamp: createdAt })
    await convergeConversionProjection()
    let fact = await db.get(`
      SELECT CAST(business_date AS TEXT) AS business_date
      FROM tracking_conversion_contact_fact WHERE contact_id = ?
    `, [contactId])
    assert.equal(fact.business_date, '2097-01-01')

    await setTimezone('America/Ciudad_Juarez')
    await convergeConversionProjection()
    fact = await db.get(`
      SELECT CAST(business_date AS TEXT) AS business_date
      FROM tracking_conversion_contact_fact WHERE contact_id = ?
    `, [contactId])
    assert.equal(fact.business_date, '2096-12-31')

    const restarted = await import(`../src/services/trackingConversionProjectionService.js?restart=${Date.now()}`)
    const status = await restarted.getTrackingConversionProjectionStatus()
    assert.equal(status.ready, true)
    assert.equal(status.timezone, 'America/Ciudad_Juarez')
    const projected = await restarted.queryTrackingConversionProjection({
      currentRange: businessRange('2096-12-31', '2097-01-01', 'America/Ciudad_Juarez'),
      previousRange: businessRange('2096-12-30', '2096-12-31', 'America/Ciudad_Juarez')
    })
    assert.equal(projected.current.metrics.registrations, 1)
  } finally {
    await cleanup(prefix)
    await setTimezone('UTC')
    await convergeConversionProjection()
  }
})

test('los filtros web usan facts 113+116 y respetan started_at posterior al registro', async () => {
  await runVersionedMigrations()
  await setTimezone('UTC')
  await runCrmListProjectionBackfill({ batchSize: 100, yieldMs: 0 })
  const prefix = uniquePrefix()
  const contactId = `${prefix}_filtered`
  const currentRange = businessRange('2098-04-10', '2098-04-11', 'UTC')
  const previousRange = businessRange('2098-04-09', '2098-04-10', 'UTC')

  await cleanup(prefix)
  try {
    await insertContact({ id: contactId, timestamp: '2098-04-10T12:00:00.000Z' })
    const sessions = [
      [randomUUID(), `${prefix}_before`, '2098-04-10T11:00:00.000Z', 'antes', 'newsletter'],
      [randomUUID(), `${prefix}_after`, '2098-04-10T13:00:00.000Z', 'despues', 'fb']
    ]
    for (const [id, sessionId, startedAt, campaign, source] of sessions) {
      await db.run(`
        INSERT INTO sessions(
          id, session_id, visitor_id, contact_id, event_name, started_at,
          page_url, utm_campaign, utm_source, device_type
        ) VALUES (?, ?, ?, ?, 'page_view', ?, 'https://example.test/landing', ?, ?, 'mobile')
      `, [id, sessionId, `${prefix}_visitor`, contactId, startedAt, campaign, source])
    }

    await convergeTrackingProjection()
    await convergeConversionProjection()

    const before = await queryTrackingConversionProjection({
      currentRange,
      previousRange,
      filters: { utm_campaign: ['antes'], device_type: ['mobile'] }
    })
    assert.equal(before.readPath, 'tracking_conversion_contact_fact_filtered')
    assert.equal(before.current.metrics.registrations, 0, 'un evento anterior al alta no atribuye la conversión')

    const after = await queryTrackingConversionProjection({
      currentRange,
      previousRange,
      filters: { utm_campaign: ['despues'], utm_source: ['fb'], device_type: ['mobile'] }
    })
    assert.equal(after.current.metrics.registrations, 1)

    const broadenedSource = await queryTrackingConversionProjection({
      currentRange,
      previousRange,
      filters: { utm_campaign: ['despues'], utm_source: ['Facebook'] }
    })
    assert.equal(
      broadenedSource.current.metrics.registrations,
      0,
      'el alias exacto fb no se ensancha a toda la categoría Facebook'
    )

    const unfiltered = await queryTrackingConversionProjection({ currentRange, previousRange })
    assert.equal(unfiltered.readPath, 'tracking_conversion_daily_rollup')
    assert.equal(unfiltered.projection?.pending, false)
    assert.equal(unfiltered.projection?.available, true)
    assert.equal(unfiltered.current.metrics.registrations, 1)
  } finally {
    await cleanup(prefix)
    await convergeTrackingProjection()
    await convergeConversionProjection()
  }
})

test('la ruta proyectada rechaza filtros web y respeta cancelacion', async () => {
  assert.equal(supportsTrackingConversionProjectionFilters({ conversion_stage: ['customer'] }), true)
  assert.equal(supportsTrackingConversionProjectionFilters({ status: ['read'] }), true)
  assert.equal(supportsTrackingConversionProjectionFilters({ device_type: ['mobile'] }), true)
  assert.equal(supportsTrackingConversionProjectionFilters({ utm_campaign: ['verano'] }), true)
  assert.equal(supportsTrackingConversionProjectionFilters({ invented_dimension: ['x'] }), false)

  const timezone = 'UTC'
  const currentRange = businessRange('2093-01-01', '2093-01-02', timezone)
  const previousRange = businessRange('2092-12-31', '2093-01-01', timezone)
  await assert.rejects(
    queryTrackingConversionProjection({
      currentRange,
      previousRange,
      filters: { invented_dimension: ['x'] }
    }),
    error => error?.code === 'tracking_conversion_projection_filter_unsupported'
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    queryTrackingConversionProjection({ currentRange, previousRange, signal: controller.signal }),
    error => error?.name === 'AbortError'
  )
})
