import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { databaseDialect, db } from '../src/config/database.js'
import { buildAggregatedReportMetrics } from '../src/services/reportMetricsAggregationService.js'
import { listReportContactsPage } from '../src/services/reportContactsPaginationService.js'
import {
  getCampaignPerformancePage,
  invalidateCampaignPerformanceCache
} from '../src/services/campaignPerformanceService.js'
import { listCampaignContactsPage } from '../src/services/campaignContactsPaginationService.js'
import { runContactPersonIdentityProjectionBackfill } from '../src/services/contactPersonIdentityProjectionService.js'
import { invalidateTimezoneCache, resolveDateRangeWithGHLTimezone } from '../src/utils/dateUtils.js'

test.before(async () => {
  if (databaseDialect !== 'sqlite') return
  await db.exec(readFileSync(
    new URL('../migrations/versioned/070_campaign_performance_materialized_cache.sqlite.sql', import.meta.url),
    'utf8'
  ))
  await db.exec(readFileSync(
    new URL('../migrations/versioned/110_contact_person_identity.sqlite.sql', import.meta.url),
    'utf8'
  ))
})

async function restoreConfig(key, previous) {
  await db.run('DELETE FROM app_config WHERE config_key = ?', [key]).catch(() => undefined)
  if (!previous) return
  await db.run(
    `INSERT INTO app_config (config_key, config_value, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
    [key, previous.config_value, previous.created_at, previous.updated_at]
  )
}

test('Reportes y Publicidad sólo atribuyen la señal al calendario configurado', async () => {
  const suffix = randomUUID()
  const date = '2099-11-08'
  const createdAt = `${date}T17:00:00.000Z`
  const accountId = `account_attendance_calendar_${suffix}`
  const campaignId = `campaign_attendance_calendar_${suffix}`
  const adsetId = `adset_attendance_calendar_${suffix}`
  const adId = `ad_attendance_calendar_${suffix}`
  const selectedCalendarId = `calendar_attendance_selected_${suffix}`
  const excludedCalendarId = `calendar_attendance_excluded_${suffix}`
  const selectedContactId = `contact_attendance_selected_${suffix}`
  const excludedContactId = `contact_attendance_excluded_${suffix}`
  const selectedAppointmentId = `appointment_attendance_selected_${suffix}`
  const excludedAppointmentId = `appointment_attendance_excluded_${suffix}`
  const previousTimezone = await db.get(
    'SELECT * FROM app_config WHERE config_key = ?',
    ['account_timezone']
  )
  const previousCalendars = await db.get(
    'SELECT * FROM app_config WHERE config_key = ?',
    ['attribution_calendar_ids']
  )

  try {
    await db.run('DELETE FROM app_config WHERE config_key IN (?, ?)', [
      'account_timezone',
      'attribution_calendar_ids'
    ])
    await db.run(
      `INSERT INTO app_config (config_key, config_value)
       VALUES ('account_timezone', 'UTC'),
              ('attribution_calendar_ids', ?)`,
      [JSON.stringify([selectedCalendarId])]
    )
    invalidateTimezoneCache()

    await db.run(
      `INSERT INTO meta_ads (
         date, ad_account_id, campaign_id, campaign_name, adset_id, adset_name,
         ad_id, ad_name, spend, clicks, reach
       ) VALUES (?, ?, ?, 'Campaña asistencia', ?, 'Conjunto asistencia', ?, 'Anuncio asistencia', 25, 5, 50)`,
      [date, accountId, campaignId, adsetId, adId]
    )
    await db.run(
      `INSERT INTO contacts (
         id, phone, email, full_name, attribution_ad_id, attribution_ad_name,
         purchases_count, total_paid, created_at, updated_at
       ) VALUES (?, ?, ?, 'Contacto calendario correcto', ?, 'Anuncio asistencia', 0, 0, ?, ?),
                (?, ?, ?, 'Contacto calendario excluido', ?, 'Anuncio asistencia', 0, 0, ?, ?)`,
      [
        selectedContactId,
        `+5211${suffix.replace(/\D/g, '').padEnd(9, '1').slice(0, 9)}`,
        `selected-${suffix}@test.invalid`,
        adId,
        createdAt,
        createdAt,
        excludedContactId,
        `+5212${suffix.replace(/\D/g, '').padEnd(9, '2').slice(0, 9)}`,
        `excluded-${suffix}@test.invalid`,
        adId,
        createdAt,
        createdAt
      ]
    )
    await db.run(
      `INSERT INTO appointments (
         id, calendar_id, contact_id, title, status, appointment_status,
         start_time, end_time, date_added, date_updated
       ) VALUES (?, ?, ?, 'Cita atribuida', 'confirmed', 'confirmed', ?, ?, ?, ?),
                (?, ?, ?, 'Cita fuera de atribución', 'confirmed', 'confirmed', ?, ?, ?, ?)`,
      [
        selectedAppointmentId,
        selectedCalendarId,
        selectedContactId,
        '2099-11-09T17:00:00.000Z',
        '2099-11-09T18:00:00.000Z',
        createdAt,
        createdAt,
        excludedAppointmentId,
        excludedCalendarId,
        excludedContactId,
        '2099-11-09T18:00:00.000Z',
        '2099-11-09T19:00:00.000Z',
        createdAt,
        createdAt
      ]
    )
    await db.run(
      `INSERT INTO appointment_attendance_signals (
         id, contact_id, appointment_id, source, first_seen_at, updated_at
       ) VALUES (?, ?, ?, 'test_calendar_attribution', ?, ?),
                (?, ?, ?, 'test_calendar_attribution', ?, ?)`,
      [
        `${selectedContactId}:${selectedAppointmentId}`,
        selectedContactId,
        selectedAppointmentId,
        createdAt,
        createdAt,
        `${excludedContactId}:${excludedAppointmentId}`,
        excludedContactId,
        excludedAppointmentId,
        createdAt,
        createdAt
      ]
    )
    await runContactPersonIdentityProjectionBackfill({ batchSize: 500, yieldMs: 0 })

    const reports = await buildAggregatedReportMetrics({
      startDate: date,
      endDate: date,
      groupBy: 'day',
      scope: 'attribution'
    })
    const reportBucket = reports.metrics.find(item => item.date === date)
    assert.equal(reportBucket?.leads, 2)
    assert.equal(reportBucket?.attendances, 1)

    const reportContacts = await listReportContactsPage({
      startDate: date,
      endDate: date,
      type: 'attendances',
      scope: 'attribution',
      limit: 10
    })
    assert.deepEqual(reportContacts.contacts.map(contact => contact.id), [selectedContactId])

    invalidateCampaignPerformanceCache()
    const range = await resolveDateRangeWithGHLTimezone({ startDate: date, endDate: date })
    const campaignPage = await getCampaignPerformancePage({
      range,
      level: 'campaign',
      page: 1,
      pageSize: 10
    })
    const campaign = campaignPage.items.find(item => item.id === campaignId)
    assert.equal(campaign?.leads, 2)
    assert.equal(campaign?.attendances, 1)

    const campaignContacts = await listCampaignContactsPage({
      type: 'attendances',
      startDate: date,
      endDate: date,
      campaignId,
      limit: 10
    })
    assert.deepEqual(campaignContacts.contacts.map(contact => contact.id), [selectedContactId])
  } finally {
    invalidateCampaignPerformanceCache()
    await db.run(
      'DELETE FROM appointment_attendance_signals WHERE contact_id IN (?, ?)',
      [selectedContactId, excludedContactId]
    ).catch(() => undefined)
    await db.run(
      'DELETE FROM appointments WHERE id IN (?, ?)',
      [selectedAppointmentId, excludedAppointmentId]
    ).catch(() => undefined)
    await db.run(
      'DELETE FROM contacts WHERE id IN (?, ?)',
      [selectedContactId, excludedContactId]
    ).catch(() => undefined)
    await db.run('DELETE FROM meta_ads WHERE ad_account_id = ?', [accountId]).catch(() => undefined)
    await restoreConfig('account_timezone', previousTimezone)
    await restoreConfig('attribution_calendar_ids', previousCalendars)
    invalidateTimezoneCache()
  }
})
