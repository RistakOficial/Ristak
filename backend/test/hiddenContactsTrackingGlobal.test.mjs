import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import {
  getSessionMetricsByDateRange,
  getSessionsByDateRange
} from '../src/services/trackingService.js'
import {
  clearTrackingAnalyticsSummaryCache,
  getTrackingAnalyticsSummary,
  searchTrackingSessions
} from '../src/services/trackingAnalyticsService.js'
import {
  getSitesTrackingSummary,
  listSiteSubmissions
} from '../src/services/sitesService.js'
import {
  getVideoPlaybackAggregate,
  getVideoPlaybackViewers,
  linkVideoVisitorToContact,
  recordVideoPlaybackEvent
} from '../src/services/videoTrackingService.js'
import {
  buildHiddenContactDataCondition,
  getHiddenContactFilters
} from '../src/utils/hiddenContactsFilter.js'
import {
  ACCOUNT_TIMEZONE_CONFIG_KEY,
  invalidateTimezoneCache
} from '../src/utils/dateUtils.js'

function marker(label) {
  return `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function cleanup(prefix, filterText) {
  await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run('DELETE FROM contacts WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  await db.run(
    'DELETE FROM hidden_contact_filters WHERE LOWER(filter_text) = LOWER(?)',
    [filterText]
  ).catch(() => undefined)
  clearTrackingAnalyticsSummaryCache()
}

test('contactos ocultos desaparecen de eventos, búsquedas y métricas de tracking', async () => {
  const prefix = marker('hidden_tracking_global')
  const date = '2098-10-12'
  const timestamp = `${date}T14:00:00.000Z`
  const hiddenContactId = `${prefix}_hidden_contact`
  const visibleContactId = `${prefix}_visible_contact`
  const hiddenVisitorId = `${prefix}_hidden_visitor`
  const hiddenSessionId = `${prefix}_hidden_session`
  const filterText = `${prefix}_private`

  await setAppConfig(ACCOUNT_TIMEZONE_CONFIG_KEY, 'UTC')
  invalidateTimezoneCache()
  await cleanup(prefix, filterText)

  try {
    await db.run(`
      INSERT INTO contacts (
        id, full_name, email, visitor_id, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'tracking', ?, ?)
    `, [
      hiddenContactId,
      'Contacto privado',
      `${filterText}@example.test`,
      hiddenVisitorId,
      timestamp,
      timestamp
    ])
    await db.run(`
      INSERT INTO contacts (
        id, full_name, email, visitor_id, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'tracking', ?, ?)
    `, [
      visibleContactId,
      'Contacto visible',
      `${prefix}_public@example.test`,
      `${prefix}_visible_visitor`,
      timestamp,
      timestamp
    ])

    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, full_name, email,
        event_name, started_at, created_at, utm_campaign
      ) VALUES (?, ?, ?, ?, 'Contacto privado', ?, 'page_view', ?, ?, ?)
    `, [
      randomUUID(),
      hiddenSessionId,
      hiddenVisitorId,
      hiddenContactId,
      `${filterText}@example.test`,
      timestamp,
      timestamp,
      prefix
    ])
    // Simula una fila histórica que todavía no recibió contact_id. Comparte la
    // identidad de tracking con el contacto oculto y tampoco debe reaparecer.
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, event_name, started_at, created_at, utm_campaign
      ) VALUES (?, ?, ?, 'page_view', ?, ?, ?)
    `, [
      randomUUID(),
      `${hiddenSessionId}_unlinked`,
      hiddenVisitorId,
      timestamp,
      timestamp,
      prefix
    ])
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, full_name, email,
        event_name, started_at, created_at, utm_campaign
      ) VALUES (?, ?, ?, ?, 'Contacto visible', ?, 'page_view', ?, ?, ?)
    `, [
      randomUUID(),
      `${prefix}_visible_session`,
      `${prefix}_visible_visitor`,
      visibleContactId,
      `${prefix}_public@example.test`,
      timestamp,
      timestamp,
      prefix
    ])

    await db.run(`
      INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
      VALUES (?, 'contains', CURRENT_TIMESTAMP)
    `, [filterText])
    clearTrackingAnalyticsSummaryCache()

    const search = await searchTrackingSessions({
      start: date,
      end: date,
      q: prefix,
      column: 'utm_campaign',
      limit: 20
    })
    assert.deepEqual(
      search.items.map(row => row.contact_id),
      [visibleContactId],
      'la tabla keyset no devuelve filas enlazadas ni identidades históricas ocultas'
    )

    const legacyRows = await getSessionsByDateRange(date, date, { limit: 20, offset: 0 })
    assert.deepEqual(legacyRows.map(row => row.contact_id), [visibleContactId])

    const legacyMetrics = await getSessionMetricsByDateRange(date, date)
    assert.deepEqual(legacyMetrics, {
      pageViews: 1,
      uniqueVisitors: 1,
      uniqueSessions: 1,
      returningUsers: 0
    })

    const summary = await getTrackingAnalyticsSummary({
      start: date,
      end: date,
      groupBy: 'day',
      filters: {},
      includeFacets: false
    })
    assert.equal(summary.metrics.current.pageViews, 1)
    assert.equal(summary.metrics.current.uniqueVisitors, 1)
    assert.equal(summary.metrics.current.identifiedContacts, 1)
    assert.equal(summary.metrics.current.registrations, 1)
  } finally {
    await cleanup(prefix, filterText)
  }
})

test('la condición genérica excluye contactos y tablas hijas por identidad', async () => {
  const prefix = marker('hidden_generic_scope')
  const hiddenContactId = `${prefix}_contact`
  const filterText = `${prefix}_secret`
  const timestamp = '2098-10-13T14:00:00.000Z'

  await cleanup(prefix, filterText)
  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, email, source, created_at, updated_at)
      VALUES (?, 'Persona oculta', ?, 'test', ?, ?)
    `, [hiddenContactId, `${filterText}@example.test`, timestamp, timestamp])
    await db.run(`
      INSERT INTO sessions (
        id, session_id, visitor_id, contact_id, event_name, started_at, created_at
      ) VALUES (?, ?, ?, ?, 'page_view', ?, ?)
    `, [
      randomUUID(),
      `${prefix}_session`,
      `${prefix}_visitor`,
      hiddenContactId,
      timestamp,
      timestamp
    ])
    await db.run(`
      INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
      VALUES (?, 'contains', CURRENT_TIMESTAMP)
    `, [filterText])

    const filters = await getHiddenContactFilters()
    const contactsCondition = buildHiddenContactDataCondition(filters, {
      tableAlias: 'data_row',
      tableName: 'contacts',
      columns: ['id', 'full_name', 'email', 'phone']
    })
    const sessionsCondition = buildHiddenContactDataCondition(filters, {
      tableAlias: 'data_row',
      tableName: 'sessions',
      columns: ['contact_id', 'visitor_id', 'session_id', 'full_name', 'email']
    })

    const contact = await db.get(`
      SELECT data_row.id
      FROM contacts data_row
      WHERE data_row.id = ? AND ${contactsCondition}
    `, [hiddenContactId])
    const session = await db.get(`
      SELECT data_row.id
      FROM sessions data_row
      WHERE data_row.contact_id = ? AND ${sessionsCondition}
    `, [hiddenContactId])

    assert.equal(contact, null)
    assert.equal(session, null)
  } finally {
    await cleanup(prefix, filterText)
  }
})

test('Sites excluye vistas, conversiones y envíos de contactos ocultos', async () => {
  const prefix = marker('hidden_sites_global')
  const siteId = `${prefix}_site`
  const filterText = `${prefix}_private`
  const timestamp = '2098-10-14T14:00:00.000Z'
  const hiddenContactId = `${prefix}_hidden_contact`
  const visibleContactId = `${prefix}_visible_contact`

  await cleanup(prefix, filterText)
  try {
    await db.run(`
      INSERT INTO public_sites (id, name, slug, site_type, status, created_at, updated_at)
      VALUES (?, 'Site de prueba', ?, 'landing_page', 'published', ?, ?)
    `, [siteId, `${prefix}-slug`, timestamp, timestamp])
    await db.run(`
      INSERT INTO contacts (id, full_name, email, visitor_id, source, created_at, updated_at)
      VALUES (?, 'Contacto privado', ?, ?, 'site_form', ?, ?)
    `, [
      hiddenContactId,
      `${filterText}@example.test`,
      `${prefix}_hidden_visitor`,
      timestamp,
      timestamp
    ])
    await db.run(`
      INSERT INTO contacts (id, full_name, email, visitor_id, source, created_at, updated_at)
      VALUES (?, 'Contacto visible', ?, ?, 'site_form', ?, ?)
    `, [
      visibleContactId,
      `${prefix}_public@example.test`,
      `${prefix}_visible_visitor`,
      timestamp,
      timestamp
    ])

    for (const [visibility, contactId, visitorId, email] of [
      ['hidden', hiddenContactId, `${prefix}_hidden_visitor`, `${filterText}@example.test`],
      ['visible', visibleContactId, `${prefix}_visible_visitor`, `${prefix}_public@example.test`]
    ]) {
      const submissionId = `${prefix}_${visibility}_submission`
      await db.run(`
        INSERT INTO public_site_submissions (
          id, site_id, contact_id, response_json, status, created_at
        ) VALUES (?, ?, ?, ?, 'received', ?)
      `, [
        submissionId,
        siteId,
        contactId,
        JSON.stringify({ email }),
        timestamp
      ])
      await db.run(`
        INSERT INTO sessions (
          id, session_id, visitor_id, contact_id, full_name, email,
          event_name, tracking_source, site_id, submission_id, started_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'page_view', 'native_site', ?, ?, ?, ?)
      `, [
        randomUUID(),
        `${prefix}_${visibility}_session`,
        visitorId,
        contactId,
        visibility === 'hidden' ? 'Contacto privado' : 'Contacto visible',
        email,
        siteId,
        submissionId,
        timestamp,
        timestamp
      ])
    }

    await db.run(`
      INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
      VALUES (?, 'contains', CURRENT_TIMESTAMP)
    `, [filterText])

    const summary = await getSitesTrackingSummary({ siteIds: [siteId] })
    assert.equal(summary.aggregate.views, 1)
    assert.equal(summary.aggregate.visitors, 1)
    assert.equal(summary.aggregate.submissions, 1)
    assert.equal(summary.bySiteId[siteId].views, 1)
    assert.equal(summary.bySiteId[siteId].submissions, 1)

    const submissions = await listSiteSubmissions(siteId)
    assert.deepEqual(submissions.map(row => row.contactId), [visibleContactId])
  } finally {
    await db.run('DELETE FROM sessions WHERE site_id = ?', [siteId]).catch(() => undefined)
    await db.run('DELETE FROM public_site_submissions WHERE site_id = ?', [siteId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
    await cleanup(prefix, filterText)
  }
})

test('analíticas de video excluyen reproducciones de contactos ocultos', async () => {
  const prefix = marker('hidden_video_global')
  const filterText = `${prefix}_private`
  const assetId = `${prefix}_asset`
  const hiddenContactId = `${prefix}_hidden_contact`
  const visibleContactId = `${prefix}_visible_contact`
  const playbackIds = [`${prefix}_hidden_playback`, `${prefix}_visible_playback`]

  await cleanup(prefix, filterText)
  try {
    await db.run(`
      INSERT INTO contacts (id, full_name, email, source)
      VALUES (?, 'Contacto privado', ?, 'site_form')
    `, [hiddenContactId, `${filterText}@example.test`])
    await db.run(`
      INSERT INTO contacts (id, full_name, email, source)
      VALUES (?, 'Contacto visible', ?, 'site_form')
    `, [visibleContactId, `${prefix}_public@example.test`])

    for (const [index, playbackId] of playbackIds.entries()) {
      const visitorId = `${prefix}_${index === 0 ? 'hidden' : 'visible'}_visitor`
      await recordVideoPlaybackEvent({
        visitor_id: visitorId,
        session_id: `${prefix}_${index}_session`,
        event_name: 'video_play',
        data: {
          event_id: `${playbackId}:play`,
          event_sequence: 1,
          ingestion_version: 2,
          playback_id: playbackId,
          media_asset_id: assetId,
          position_seconds: 0,
          duration_seconds: 60
        }
      })
      await linkVideoVisitorToContact(
        visitorId,
        index === 0 ? hiddenContactId : visibleContactId,
        index === 0 ? 'Contacto privado' : 'Contacto visible'
      )
    }

    await db.run(`
      INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
      VALUES (?, 'contains', CURRENT_TIMESTAMP)
    `, [filterText])

    const aggregate = await getVideoPlaybackAggregate({ assetIds: [assetId] })
    assert.equal(aggregate.summary.playbackSessions, 1)
    assert.equal(aggregate.summary.plays, 1)
    assert.equal(aggregate.summary.identifiedContacts, 1)

    const detail = await getVideoPlaybackViewers({ assetId, limit: 10 })
    assert.equal(detail.viewers.length, 1)
    assert.equal(detail.viewers[0].contactId, visibleContactId)
  } finally {
    for (const playbackId of playbackIds) {
      await db.run('DELETE FROM video_playback_events WHERE playback_id = ?', [playbackId]).catch(() => undefined)
      await db.run('DELETE FROM video_playback_sessions WHERE playback_id = ?', [playbackId]).catch(() => undefined)
    }
    await cleanup(prefix, filterText)
  }
})
