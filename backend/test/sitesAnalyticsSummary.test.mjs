import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { getSitesTrackingSummary } from '../src/services/sitesService.js'

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
      [`submission_${suffix}_old`, formId, JSON.stringify({ [q1]: 'Viejo', [q2]: 'old@example.com', [q3]: '1234567890' }), outOfRange]
    )

    const summary = await getSitesTrackingSummary({
      siteIds: [formId],
      dateFrom: '2026-03-20',
      dateTo: '2026-03-20'
    })

    const funnel = summary.formFunnels[formId]
    assert.equal(funnel.submissions, 3)
    assert.equal(funnel.starts, 3)
    assert.equal(funnel.fields.length, 3)
    assert.deepEqual(
      funnel.fields.map(field => [field.label, field.answeredCount, field.answerRate, field.stepCompletionRate]),
      [
        ['Nombre', 3, 100, 100],
        ['Correo', 2, 66.7, 66.7],
        ['WhatsApp', 1, 33.3, 50]
      ]
    )
  } finally {
    await db.run('DELETE FROM public_site_submissions WHERE site_id = ?', [formId]).catch(() => undefined)
    await db.run('DELETE FROM public_site_blocks WHERE site_id = ?', [formId]).catch(() => undefined)
    await db.run('DELETE FROM public_sites WHERE id = ?', [formId]).catch(() => undefined)
  }
})
