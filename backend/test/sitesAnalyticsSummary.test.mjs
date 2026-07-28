import test from 'node:test'
import assert from 'node:assert/strict'
import { databaseDialect, db } from '../src/config/database.js'
import { getSitesAnalyticsSummaryHandler } from '../src/controllers/sitesController.js'
import { getSitesTrackingSummary } from '../src/services/sitesService.js'

function handlerResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = Number(code)
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

test('sites analytics summary uses first-party events and caps conversion rate by unique converting visitors', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `site_analytics_${suffix}`
  const formId = `form_analytics_${suffix}`
  const submissionId = `submission_analytics_${suffix}`
  const secondSiteSubmissionId = `submission_analytics_second_${suffix}`
  const formSubmissionId = `form_submission_analytics_${suffix}`
  const inRange = '2026-01-15T18:00:00.000Z'
  const outOfRange = '2026-01-10T18:00:00.000Z'

  try {
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [siteId, 'Landing analiticas', `landing-analytics-${suffix}`, 'landing_page', 'published']
    )
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [formId, 'Form analiticas', `form-analytics-${suffix}`, 'standard_form', 'published']
    )

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_site`,
      `visitor_${suffix}_site`,
      `event_${suffix}_site_view`,
      'native_site_view',
      inRange,
      inRange,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id,
        submission_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?, ?)
    `, [
      `session_${suffix}_site`,
      `visitor_${suffix}_site`,
      `event_${suffix}_site_conversion_a`,
      'native_site_conversion',
      inRange,
      inRange,
      siteId,
      submissionId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id,
        submission_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?, ?)
    `, [
      `session_${suffix}_site`,
      `visitor_${suffix}_site`,
      `event_${suffix}_site_conversion_b`,
      'native_site_conversion',
      inRange,
      inRange,
      siteId,
      secondSiteSubmissionId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_old`,
      `visitor_${suffix}_old`,
      `event_${suffix}_old_view`,
      'native_site_view',
      outOfRange,
      outOfRange,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, 'external_pixel', ?, ?, ?, ?)
    `, [
      `session_${suffix}_external`,
      `visitor_${suffix}_external`,
      `event_${suffix}_external_view`,
      'native_site_view',
      inRange,
      inRange,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        form_site_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_form`,
      `visitor_${suffix}_form`,
      `event_${suffix}_form_view`,
      'page_view',
      inRange,
      inRange,
      formId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        form_site_id,
        submission_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?, ?)
    `, [
      `session_${suffix}_form`,
      `visitor_${suffix}_form`,
      `event_${suffix}_form_conversion`,
      'native_site_conversion',
      inRange,
      inRange,
      formId,
      formSubmissionId
    ])

    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [submissionId, siteId, '{}', inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [secondSiteSubmissionId, siteId, '{}', inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [formSubmissionId, formId, '{}', JSON.stringify({ formFinalSubmit: true }), inRange]
    )

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId, formId],
      dateFrom: '2026-01-15',
      dateTo: '2026-01-15'
    })

    assert.equal(summary.bySiteId[siteId].views, 1)
    assert.equal(summary.bySiteId[siteId].visitors, 1)
    assert.equal(summary.bySiteId[siteId].sessions, 1)
    assert.equal(summary.bySiteId[siteId].submissions, 2)
    assert.equal(summary.bySiteId[siteId].completedSubmissions, 2)
    assert.equal(summary.bySiteId[siteId].qualifiedConversions, 2)
    assert.equal(summary.bySiteId[siteId].convertingVisitors, 1)
    assert.equal(summary.bySiteId[siteId].unattributedConversions, 0)
    assert.equal(summary.bySiteId[siteId].conversions, 2)
    assert.equal(summary.bySiteId[siteId].conversionRate, 100)
    assert.equal(summary.bySiteId[formId].views, 1)
    assert.equal(summary.bySiteId[formId].visitors, 1)
    assert.equal(summary.bySiteId[formId].sessions, 1)
    assert.equal(summary.bySiteId[formId].submissions, 1)
    assert.equal(summary.bySiteId[formId].qualifiedConversions, 1)
    assert.equal(summary.bySiteId[formId].convertingVisitors, 1)
    assert.equal(summary.bySiteId[formId].conversions, 1)
    assert.equal(summary.bySiteId[formId].conversionRate, 100)
    assert.deepEqual(summary.aggregate, {
      views: 2,
      visitors: 2,
      sessions: 2,
      submissions: 3,
      completedSubmissions: 3,
      terminalExitSubmissions: 0,
      qualifiedConversions: 3,
      disqualifiedSubmissions: 0,
      partialSubmissions: 0,
      legacyUnknownSubmissions: 0,
      convertingVisitors: 2,
      unattributedConversions: 0,
      conversions: 3,
      conversionRate: 100,
      entityCount: 2
    })
    assert.equal(summary.schemaVersion, 3)
    assert.equal(summary.meta.source, 'first_party')
    assert.equal(summary.coverage.status, 'ready')
    assert.equal(summary.coverage.legacyViewEvents, 0)
    assert.equal(summary.coverage.timestampAdjustedEvents, 0)
    assert.equal(summary.rankings.byConversions[0]?.siteId, siteId)
    assert.deepEqual(summary.series, [{
      periodKey: '2026-01-15',
      views: 2,
      visitors: 2,
      sessions: 2,
      submissions: 3,
      completedSubmissions: 3,
      qualifiedConversions: 3,
      disqualifiedSubmissions: 0,
      partialSubmissions: 0,
      legacyUnknownSubmissions: 0
    }])
    assert.deepEqual(Object.keys(summary.formFunnels), [siteId, formId])
    assert.equal(summary.formFunnels[siteId].submissions, 2)
    assert.equal(summary.formFunnels[formId].submissions, 1)

    const legacyHttpResponse = handlerResponse()
    await getSitesAnalyticsSummaryHandler({ body: { siteIds: [siteId, formId] } }, legacyHttpResponse)
    assert.equal(legacyHttpResponse.statusCode, 200)
    assert.deepEqual(Object.keys(legacyHttpResponse.payload?.data?.formFunnels || {}), [siteId, formId])

    const emptyRange = await getSitesTrackingSummary({
      siteIds: [siteId, formId],
      dateFrom: '2026-01-16',
      dateTo: '2026-01-16'
    })
    assert.equal(emptyRange.bySiteId[siteId].views, 0)
    assert.equal(emptyRange.bySiteId[siteId].conversions, 0)
    assert.equal(emptyRange.bySiteId[formId].views, 0)
  } finally {
    await db.run(
      'DELETE FROM public_site_submissions WHERE id IN (?, ?, ?)',
      [submissionId, secondSiteSubmissionId, formSubmissionId]
    ).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`session_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?)', [siteId, formId]).catch(() => undefined)
  }
})

test('sites analytics summary deduplicates visitors by visitor_id without merging distinct visitors by contact', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `site_identity_${suffix}`
  const inRange = '2026-02-12T18:00:00.000Z'
  const withinSession = '2026-02-12T18:10:00.000Z'
  const afterInactivity = '2026-02-12T18:41:00.000Z'
  const contactId = `contact_identity_${suffix}`

  try {
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [siteId, 'Landing identidad', `landing-identity-${suffix}`, 'landing_page', 'published']
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
       VALUES (?, 'Contacto analiticas', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_a`,
      `visitor_${suffix}_old`,
      contactId,
      `event_${suffix}_identity_a`,
      'native_site_view',
      inRange,
      inRange,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_a_repeat`,
      `visitor_${suffix}_old`,
      contactId,
      `event_${suffix}_identity_a_repeat`,
      'page_view',
      withinSession,
      withinSession,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_a_after_inactivity`,
      `visitor_${suffix}_old`,
      contactId,
      `event_${suffix}_identity_a_after_inactivity`,
      'page_view',
      afterInactivity,
      afterInactivity,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_b`,
      `visitor_${suffix}_new`,
      contactId,
      `event_${suffix}_identity_b`,
      'page_view',
      inRange,
      inRange,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, 'native_site', ?, ?, ?, ?)
    `, [
      `session_${suffix}_anonymous`,
      `visitor_${suffix}_anonymous`,
      `event_${suffix}_identity_anonymous`,
      'native_site_view',
      inRange,
      inRange,
      siteId
    ])

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      dateFrom: '2026-02-12',
      dateTo: '2026-02-12'
    })

    assert.equal(summary.bySiteId[siteId].views, 5)
    assert.equal(summary.bySiteId[siteId].visitors, 3)
    assert.equal(summary.bySiteId[siteId].sessions, 4)
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`session_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
  }
})

test('sites analytics summary never fans one CRM contact out to multiple converting web visitors', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `site_conversion_identity_${suffix}`
  const contactId = `contact_conversion_identity_${suffix}`
  const attributedSubmissionId = `submission_attributed_${suffix}`
  const unattributedSubmissionId = `submission_unattributed_${suffix}`
  const inRange = '2026-02-18T18:00:00.000Z'

  try {
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [siteId, 'Landing conversion identity', `landing-conversion-identity-${suffix}`, 'landing_page', 'published']
    )
    await db.run(
      `INSERT INTO contacts (id, full_name, source, created_at, updated_at)
       VALUES (?, 'Contacto compartido', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId]
    )

    for (const visitorSuffix of ['a', 'b']) {
      await db.run(`
        INSERT INTO sessions (
          session_id,
          visitor_id,
          contact_id,
          event_id,
          tracking_source,
          event_name,
          started_at,
          created_at,
          site_id
        ) VALUES (?, ?, ?, ?, 'native_site', 'native_site_view', ?, ?, ?)
      `, [
        `session_${suffix}_${visitorSuffix}`,
        `visitor_${suffix}_${visitorSuffix}`,
        contactId,
        `event_${suffix}_view_${visitorSuffix}`,
        inRange,
        inRange,
        siteId
      ])
    }

    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, contact_id, response_json, status, created_at
      ) VALUES (?, ?, ?, '{}', 'received', ?)`,
      [attributedSubmissionId, siteId, contactId, inRange]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, contact_id, response_json, status, created_at
      ) VALUES (?, ?, ?, '{}', 'received', ?)`,
      [unattributedSubmissionId, siteId, contactId, inRange]
    )

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_id,
        tracking_source,
        event_name,
        submission_id,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, 'native_site', 'native_site_conversion', ?, ?, ?, ?)
    `, [
      `session_${suffix}_a`,
      `visitor_${suffix}_a`,
      contactId,
      `event_${suffix}_conversion_attributed`,
      attributedSubmissionId,
      inRange,
      inRange,
      siteId
    ])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_id,
        tracking_source,
        event_name,
        submission_id,
        started_at,
        created_at,
        site_id
      ) VALUES ('', '', ?, ?, 'native_site', 'native_site_conversion', ?, ?, ?, ?)
    `, [
      contactId,
      `event_${suffix}_conversion_contact_only`,
      unattributedSubmissionId,
      inRange,
      inRange,
      siteId
    ])

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      dateFrom: '2026-02-18',
      dateTo: '2026-02-18'
    })
    const stats = summary.bySiteId[siteId]

    assert.equal(stats.views, 2)
    assert.equal(stats.visitors, 2)
    assert.equal(stats.qualifiedConversions, 2)
    assert.equal(stats.convertingVisitors, 1)
    assert.equal(stats.unattributedConversions, 1)
    assert.equal(stats.conversionRate, 50)
  } finally {
    await db.run(
      'DELETE FROM public_site_submissions WHERE id IN (?, ?)',
      [attributedSubmissionId, unattributedSubmissionId]
    ).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE event_id LIKE ?', [`event_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
  }
})

test('sites analytics summary keeps an embedded standard-form checkpoint partial for both form and outer landing', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const landingId = `landing_embedded_checkpoint_${suffix}`
  const formId = `form_embedded_checkpoint_${suffix}`
  const submissionId = `submission_embedded_checkpoint_${suffix}`
  const inRange = '2026-02-22T18:00:00.000Z'

  try {
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [landingId, 'Landing con formulario', `landing-embedded-checkpoint-${suffix}`, 'landing_page', 'published']
    )
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [formId, 'Formulario embebido', `form-embedded-checkpoint-${suffix}`, 'standard_form', 'published']
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, form_site_id, response_json, meta_json, status, created_at
      ) VALUES (?, ?, ?, '{}', ?, 'received', ?)`,
      [submissionId, landingId, formId, JSON.stringify({ formFinalSubmit: false }), inRange]
    )

    const summary = await getSitesTrackingSummary({
      siteIds: [landingId, formId],
      dateFrom: '2026-02-22',
      dateTo: '2026-02-22'
    })

    for (const siteId of [landingId, formId]) {
      assert.equal(summary.bySiteId[siteId].submissions, 0)
      assert.equal(summary.bySiteId[siteId].completedSubmissions, 0)
      assert.equal(summary.bySiteId[siteId].partialSubmissions, 1)
      assert.equal(summary.bySiteId[siteId].qualifiedConversions, 0)
      assert.equal(summary.bySiteId[siteId].conversions, 0)
    }
  } finally {
    await db.run('DELETE FROM public_site_submissions WHERE id = ?', [submissionId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?)', [landingId, formId]).catch(() => undefined)
  }
})

test('sites analytics summary measures terminal answer coverage and keeps incomplete or legacy submissions out of conversions', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const formId = `form_funnel_${suffix}`
  const q1 = `question_one_${suffix}`
  const q2 = `question_two_${suffix}`
  const q3 = `question_three_${suffix}`
  const inRange = '2026-03-20T18:00:00.000Z'
  const outOfRange = '2026-03-10T18:00:00.000Z'

  try {
    await db.run(
      'INSERT INTO public_sites (id, name, slug, site_type, status) VALUES (?, ?, ?, ?, ?)',
      [formId, 'Formulario embudo', `form-funnel-${suffix}`, 'standard_form', 'published']
    )

    await db.run(
      'INSERT INTO public_site_blocks (id, site_id, block_type, label, required, sort_order, options_json, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [q1, formId, 'short_text', 'Nombre', 1, 1, '[]', '{}']
    )
    await db.run(
      'INSERT INTO public_site_blocks (id, site_id, block_type, label, required, sort_order, options_json, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [q2, formId, 'email', 'Correo', 1, 2, '[]', '{}']
    )
    await db.run(
      'INSERT INTO public_site_blocks (id, site_id, block_type, label, required, sort_order, options_json, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [q3, formId, 'phone', 'WhatsApp', 0, 3, '[]', '{}']
    )

    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, response_json, meta_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `submission_${suffix}_complete_zero_false`,
        formId,
        JSON.stringify({ [q1]: 'Raul', [q2]: 0, [q3]: false }),
        JSON.stringify({ formFinalSubmit: true }),
        'received',
        inRange
      ]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, response_json, meta_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `submission_${suffix}_complete_sparse`,
        formId,
        JSON.stringify({ [q1]: 'Ana', [q2]: '', [q3]: null }),
        JSON.stringify({ formFinalSubmit: true }),
        'received',
        inRange
      ]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, response_json, meta_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `submission_${suffix}_terminal_disqualified`,
        formId,
        JSON.stringify({ [q1]: 'Luis', [q2]: 0 }),
        JSON.stringify({ immediateDisqualify: true }),
        'disqualified',
        inRange
      ]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, response_json, meta_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `submission_${suffix}_checkpoint`,
        formId,
        JSON.stringify({ [q1]: 'Checkpoint', [q2]: 99, [q3]: true }),
        JSON.stringify({ formFinalSubmit: false }),
        'received',
        inRange
      ]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, response_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      [
        `submission_${suffix}_legacy_unknown`,
        formId,
        JSON.stringify({ [q1]: 'Legacy', [q2]: 42, [q3]: true }),
        'received',
        inRange
      ]
    )
    await db.run(
      `INSERT INTO public_site_submissions (
        id, site_id, response_json, meta_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        `submission_${suffix}_old`,
        formId,
        JSON.stringify({ [q1]: 'Viejo', [q2]: 1, [q3]: true }),
        JSON.stringify({ formFinalSubmit: true }),
        'received',
        outOfRange
      ]
    )

    const summary = await getSitesTrackingSummary({
      siteIds: [formId],
      formFunnelSiteId: formId,
      dateFrom: '2026-03-20',
      dateTo: '2026-03-20'
    })

    const funnel = summary.formFunnels[formId]
    assert.equal(summary.bySiteId[formId].submissions, 3)
    assert.equal(summary.bySiteId[formId].completedSubmissions, 2)
    assert.equal(summary.bySiteId[formId].terminalExitSubmissions, 1)
    assert.equal(summary.bySiteId[formId].qualifiedConversions, 2)
    assert.equal(summary.bySiteId[formId].disqualifiedSubmissions, 1)
    assert.equal(summary.bySiteId[formId].partialSubmissions, 1)
    assert.equal(summary.bySiteId[formId].legacyUnknownSubmissions, 1)
    assert.equal(summary.bySiteId[formId].conversions, 2)
    assert.equal(summary.bySiteId[formId].convertingVisitors, 0)
    assert.equal(summary.bySiteId[formId].unattributedConversions, 2)
    assert.equal(summary.bySiteId[formId].conversionRate, 0)
    assert.equal(summary.coverage.status, 'partial')
    assert.equal(summary.coverage.legacyUnknownSubmissions, 1)
    assert.equal(summary.meta.status, 'partial')
    assert.equal(summary.meta.warnings.some(warning => /no permiten probar si fueron finales/i.test(warning)), true)
    assert.equal(funnel.submissions, 3)
    assert.equal(funnel.completedSubmissions, 2)
    assert.equal(funnel.terminalExitSubmissions, 1)
    assert.equal(funnel.qualifiedConversions, 2)
    assert.equal(funnel.disqualifiedSubmissions, 1)
    assert.equal(funnel.partialSubmissions, 1)
    assert.equal(funnel.legacyUnknownSubmissions, 1)
    assert.equal(funnel.measurement, 'saved_submission_answer_coverage')
    assert.equal(Object.hasOwn(funnel, 'starts'), false)
    assert.equal(funnel.fields.length, 3)
    assert.deepEqual(
      funnel.fields.map(field => [
        field.label,
        field.finalSubmissions,
        field.answeredCount,
        field.unansweredCount,
        field.answerRate
      ]),
      [
        ['Nombre', 3, 3, 0, 100],
        ['Correo', 3, 2, 1, 66.7],
        ['WhatsApp', 3, 1, 2, 33.3]
      ]
    )
    assert.deepEqual(summary.series, [{
      periodKey: '2026-03-20',
      views: 0,
      visitors: 0,
      sessions: 0,
      submissions: 3,
      completedSubmissions: 2,
      qualifiedConversions: 2,
      disqualifiedSubmissions: 1,
      partialSubmissions: 1,
      legacyUnknownSubmissions: 1
    }])
  } finally {
    await db.run('DELETE FROM public_site_submissions WHERE site_id = ?', [formId]).catch(() => undefined)
    await db.run('DELETE FROM public_site_blocks WHERE site_id = ?', [formId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [formId]).catch(() => undefined)
  }
})

test('sites analytics summary returns an empty aggregate without scope or legacy ids', async () => {
  const summary = await getSitesTrackingSummary({})

  assert.deepEqual(summary.aggregate, {
    views: 0,
    visitors: 0,
    sessions: 0,
    submissions: 0,
    completedSubmissions: 0,
    terminalExitSubmissions: 0,
    qualifiedConversions: 0,
    disqualifiedSubmissions: 0,
    partialSubmissions: 0,
    legacyUnknownSubmissions: 0,
    convertingVisitors: 0,
    unattributedConversions: 0,
    conversions: 0,
    conversionRate: 0,
    entityCount: 0
  })
  assert.deepEqual(summary.bySiteId, {})
  assert.deepEqual(summary.formFunnels, {})
})

test('sites analytics v2 rechaza scopes ambiguos y consultas globales sin rango', async () => {
  await assert.rejects(
    () => getSitesTrackingSummary({
      siteScope: { siteType: 'sites', landingMode: 'webiste', status: 'published' },
      dateFrom: '2026-03-20',
      dateTo: '2026-03-20'
    }),
    error => error?.status === 400 && /alcance/i.test(error.message)
  )

  await assert.rejects(
    () => getSitesTrackingSummary({
      siteScope: { siteType: 'sites', landingMode: 'all', status: 'published' }
    }),
    error => error?.status === 400 && /rango de fechas/i.test(error.message)
  )
})

test('sites analytics summary scales beyond 120 sites and bounds explicit detail to the active scope', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const prefix = `sites_scale_${suffix}`
  const websiteIds = Array.from({ length: 125 }, (_, index) => `${prefix}_website_${String(index).padStart(3, '0')}`)
  const outsideFirstWindowId = websiteIds.at(-1)
  const publishedFunnelId = `${prefix}_funnel_published`
  const draftWebsiteId = `${prefix}_website_draft`
  const publishedFormId = `${prefix}_form_published`
  const secondPublishedFormId = `${prefix}_form_second`
  const draftFormId = `${prefix}_form_draft`
  const formQuestionId = `${prefix}_question_a`
  const secondFormQuestionId = `${prefix}_question_b`
  const eventAt = '2098-04-16T18:00:00.000Z'

  const insertSite = async ({
    id,
    siteType,
    status = 'published',
    pageMode = 'funnel',
    updatedAt = '2099-01-01T00:00:00.000Z'
  }) => {
    await db.run(`
      INSERT INTO public_sites (
        id, name, slug, site_type, status, theme_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id,
      id,
      id.replaceAll('_', '-'),
      siteType,
      status,
      JSON.stringify({ pageMode }),
      updatedAt,
      updatedAt
    ])
  }

  const insertView = async (siteId, { form = false } = {}) => {
    const eventSuffix = `${siteId}_${form ? 'form' : 'site'}`
    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_id,
        tracking_source,
        event_name,
        started_at,
        created_at,
        ${form ? 'form_site_id' : 'site_id'}
      ) VALUES (?, ?, ?, 'native_site', 'native_site_view', ?, ?, ?)
    `, [
      `scale_session_${eventSuffix}`,
      `scale_visitor_${eventSuffix}`,
      `scale_event_${eventSuffix}`,
      eventAt,
      eventAt,
      siteId
    ])
  }

  try {
    for (const [index, siteId] of websiteIds.entries()) {
      await insertSite({
        id: siteId,
        siteType: 'landing_page',
        pageMode: 'website',
        updatedAt: index === websiteIds.length - 1
          ? '2090-01-01T00:00:00.000Z'
          : '2099-01-01T00:00:00.000Z'
      })
    }
    await insertSite({ id: publishedFunnelId, siteType: 'landing_page', pageMode: 'funnel' })
    await insertSite({ id: draftWebsiteId, siteType: 'landing_page', status: 'draft', pageMode: 'website' })
    await insertSite({ id: publishedFormId, siteType: 'standard_form' })
    await insertSite({ id: secondPublishedFormId, siteType: 'interactive_form' })
    await insertSite({ id: draftFormId, siteType: 'standard_form', status: 'draft' })

    await Promise.all([
      insertView(outsideFirstWindowId),
      insertView(publishedFunnelId),
      insertView(draftWebsiteId),
      insertView(publishedFormId, { form: true }),
      insertView(secondPublishedFormId, { form: true }),
      insertView(draftFormId, { form: true })
    ])

    await db.run(
      'INSERT INTO public_site_blocks (id, site_id, block_type, label, sort_order, options_json, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [formQuestionId, publishedFormId, 'short_text', 'Nombre', 1, '[]', '{}']
    )
    await db.run(
      'INSERT INTO public_site_blocks (id, site_id, block_type, label, sort_order, options_json, settings_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [secondFormQuestionId, secondPublishedFormId, 'email', 'Correo', 1, '[]', '{}']
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [
        `${prefix}_submission_a`,
        publishedFormId,
        JSON.stringify({ [formQuestionId]: 'Raul' }),
        JSON.stringify({ formFinalSubmit: true }),
        eventAt
      ]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [
        `${prefix}_submission_b`,
        secondPublishedFormId,
        JSON.stringify({ [secondFormQuestionId]: 'raul@example.com' }),
        JSON.stringify({ formFinalSubmit: true }),
        eventAt
      ]
    )

    const pageModeExpression = databaseDialect === 'postgres'
      ? "COALESCE(ristak_safe_jsonb(theme_json) ->> 'pageMode', 'funnel')"
      : "COALESCE(json_extract(CASE WHEN json_valid(theme_json) THEN theme_json ELSE '{}' END, '$.pageMode'), 'funnel')"
    const firstWindow = await db.all(`
      SELECT id
      FROM public_sites
      WHERE id LIKE ?
        AND site_type = 'landing_page'
        AND status = 'published'
        AND ${pageModeExpression} = 'website'
      ORDER BY updated_at DESC, id DESC
      LIMIT 120
    `, [`${prefix}_website_%`])
    assert.equal(firstWindow.length, 120)
    assert.equal(firstWindow.some(row => row.id === outsideFirstWindowId), false)

    const legacySummary = await getSitesTrackingSummary({
      siteIds: websiteIds,
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.equal(Object.keys(legacySummary.bySiteId).length, websiteIds.length)
    assert.equal(Object.keys(legacySummary.formFunnels).length, websiteIds.length)
    assert.equal(legacySummary.aggregate.entityCount, websiteIds.length)

    const websiteSummary = await getSitesTrackingSummary({
      siteScope: {
        siteType: 'sites',
        landingMode: 'website',
        status: 'published'
      },
      breakdownSiteIds: [...websiteIds.slice(0, 104), outsideFirstWindowId],
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.equal(websiteSummary.aggregate.views, 1)
    assert.equal(websiteSummary.aggregate.visitors, 1)
    assert.equal(websiteSummary.aggregate.entityCount, 125)
    assert.equal(Object.keys(websiteSummary.bySiteId).length, 100)
    assert.equal(Object.hasOwn(websiteSummary.bySiteId, outsideFirstWindowId), false)
    assert.equal(websiteSummary.rankings.byViews[0]?.siteId, outsideFirstWindowId)
    assert.equal(websiteSummary.rankings.byViews[0]?.views, 1)
    assert.deepEqual(websiteSummary.formFunnels, {})

    const allLandingSummary = await getSitesTrackingSummary({
      siteScope: { siteType: 'sites', landingMode: 'all', status: 'published' },
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.equal(allLandingSummary.aggregate.views, 2)
    assert.equal(allLandingSummary.aggregate.entityCount, 126)

    const funnelSummary = await getSitesTrackingSummary({
      siteScope: { siteType: 'sites', landingMode: 'funnel', status: 'published' },
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.equal(funnelSummary.aggregate.views, 1)
    assert.equal(funnelSummary.aggregate.entityCount, 1)

    const exactWebsiteSummary = await getSitesTrackingSummary({
      siteScope: {
        siteType: 'sites',
        landingMode: 'website',
        status: 'published',
        siteId: outsideFirstWindowId
      },
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.equal(exactWebsiteSummary.aggregate.views, 1)
    assert.equal(exactWebsiteSummary.aggregate.entityCount, 1)

    const formsSummary = await getSitesTrackingSummary({
      siteScope: { siteType: 'forms', status: 'published' },
      breakdownSiteIds: [publishedFormId, secondPublishedFormId, draftFormId, publishedFunnelId],
      formFunnelSiteId: publishedFormId,
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.equal(formsSummary.aggregate.views, 2)
    assert.equal(formsSummary.aggregate.entityCount, 2)
    assert.deepEqual(Object.keys(formsSummary.bySiteId), [publishedFormId, secondPublishedFormId])
    assert.deepEqual(Object.keys(formsSummary.formFunnels), [publishedFormId])
    assert.equal(formsSummary.formFunnels[publishedFormId].submissions, 1)

    const outOfScopeDetail = await getSitesTrackingSummary({
      siteScope: { siteType: 'sites', landingMode: 'website', status: 'published' },
      breakdownSiteIds: [outsideFirstWindowId, draftWebsiteId, publishedFormId],
      formFunnelSiteId: publishedFormId,
      dateFrom: '2098-04-16',
      dateTo: '2098-04-16'
    })
    assert.deepEqual(Object.keys(outOfScopeDetail.bySiteId), [outsideFirstWindowId])
    assert.deepEqual(outOfScopeDetail.formFunnels, {})
  } finally {
    await db.run('DELETE FROM public_site_submissions WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM public_site_blocks WHERE site_id LIKE ?', [`${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`scale_session_${prefix}%`]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id LIKE ?', [`${prefix}%`]).catch(() => undefined)
  }
})
