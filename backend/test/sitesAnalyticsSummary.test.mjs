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

test('sites analytics summary respects selected site ids and date range', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `site_analytics_${suffix}`
  const formId = `form_analytics_${suffix}`
  const submissionId = `submission_analytics_${suffix}`
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
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_site`, `visitor_${suffix}_site`, 'native_site_view', inRange, inRange, siteId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        created_at,
        site_id,
        submission_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_site`, `visitor_${suffix}_site`, 'native_site_conversion', inRange, inRange, siteId, submissionId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_old`, `visitor_${suffix}_old`, 'native_site_view', outOfRange, outOfRange, siteId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        created_at,
        form_site_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_form`, `visitor_${suffix}_form`, 'page_view', inRange, inRange, formId])

    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [submissionId, siteId, '{}', inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, form_site_id, response_json, created_at) VALUES (?, ?, ?, ?, ?)',
      [formSubmissionId, siteId, formId, '{}', inRange]
    )

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId, formId],
      dateFrom: '2026-01-15',
      dateTo: '2026-01-15'
    })

    assert.equal(summary.bySiteId[siteId].views, 1)
    assert.equal(summary.bySiteId[siteId].visitors, 1)
    assert.equal(summary.bySiteId[siteId].sessions, 1)
    assert.equal(summary.bySiteId[siteId].conversions, 2)
    assert.equal(summary.bySiteId[siteId].conversionRate, 200)
    assert.equal(summary.bySiteId[formId].views, 1)
    assert.equal(summary.bySiteId[formId].visitors, 1)
    assert.equal(summary.bySiteId[formId].sessions, 1)
    assert.equal(summary.bySiteId[formId].conversions, 1)
    assert.equal(summary.aggregate.views, 2)
    assert.equal(summary.aggregate.visitors, 2)
    assert.equal(summary.aggregate.sessions, 2)
    assert.equal(summary.aggregate.conversions, 2)
    assert.equal(summary.aggregate.entityCount, 2)
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
    await db.run('DELETE FROM public_site_submissions WHERE id IN (?, ?)', [submissionId, formSubmissionId]).catch(() => undefined)
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`session_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id IN (?, ?)', [siteId, formId]).catch(() => undefined)
  }
})

test('sites analytics summary deduplicates visitors by contact identity', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const siteId = `site_identity_${suffix}`
  const inRange = '2026-02-12T18:00:00.000Z'
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
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_a`, `visitor_${suffix}_old`, contactId, 'native_site_view', inRange, inRange, siteId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        contact_id,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_b`, `visitor_${suffix}_new`, contactId, 'page_view', inRange, inRange, siteId])

    await db.run(`
      INSERT INTO sessions (
        session_id,
        visitor_id,
        event_name,
        started_at,
        created_at,
        site_id
      ) VALUES (?, ?, ?, ?, ?, ?)
    `, [`session_${suffix}_anonymous`, `visitor_${suffix}_anonymous`, 'native_site_view', inRange, inRange, siteId])

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      dateFrom: '2026-02-12',
      dateTo: '2026-02-12'
    })

    assert.equal(summary.bySiteId[siteId].views, 3)
    assert.equal(summary.bySiteId[siteId].visitors, 2)
    assert.equal(summary.bySiteId[siteId].sessions, 3)
  } finally {
    await db.run('DELETE FROM sessions WHERE session_id LIKE ?', [`session_${suffix}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [siteId]).catch(() => undefined)
  }
})

test('sites analytics summary includes form completion by question', async () => {
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
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`submission_${suffix}_complete`, formId, JSON.stringify({ [q1]: 'Raul', [q2]: 'raul@example.com', [q3]: '+5216560000000' }), inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`submission_${suffix}_partial`, formId, JSON.stringify({ [q1]: 'Ana', [q2]: 'ana@example.com' }), inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`submission_${suffix}_first`, formId, JSON.stringify({ [q1]: 'Luis' }), inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`submission_${suffix}_malformed`, formId, '{malformed', inRange]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`submission_${suffix}_old`, formId, JSON.stringify({ [q1]: 'Viejo', [q2]: 'old@example.com', [q3]: '1234567890' }), outOfRange]
    )

    const summary = await getSitesTrackingSummary({
      siteIds: [formId],
      formFunnelSiteId: formId,
      dateFrom: '2026-03-20',
      dateTo: '2026-03-20'
    })

    const funnel = summary.formFunnels[formId]
    assert.equal(funnel.submissions, 4)
    assert.equal(funnel.starts, 4)
    assert.equal(funnel.fields.length, 3)
    assert.deepEqual(
      funnel.fields.map(field => [field.label, field.answeredCount, field.answerRate, field.stepCompletionRate]),
      [
        ['Nombre', 3, 75, 75],
        ['Correo', 2, 50, 66.7],
        ['WhatsApp', 1, 25, 50]
      ]
    )
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
        session_id, visitor_id, event_name, started_at, created_at, ${form ? 'form_site_id' : 'site_id'}
      ) VALUES (?, ?, 'native_site_view', ?, ?, ?)
    `, [`scale_session_${eventSuffix}`, `scale_visitor_${eventSuffix}`, eventAt, eventAt, siteId])
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
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`${prefix}_submission_a`, publishedFormId, JSON.stringify({ [formQuestionId]: 'Raul' }), eventAt]
    )
    await db.run(
      'INSERT INTO public_site_submissions (id, site_id, response_json, created_at) VALUES (?, ?, ?, ?)',
      [`${prefix}_submission_b`, secondPublishedFormId, JSON.stringify({ [secondFormQuestionId]: 'raul@example.com' }), eventAt]
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
