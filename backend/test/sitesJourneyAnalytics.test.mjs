import test from 'node:test'
import assert from 'node:assert/strict'
import { DateTime } from 'luxon'

if (process.env.DATABASE_URL) {
  throw new Error('sitesJourneyAnalytics.test.mjs solo puede ejecutarse con SQLite local; elimina DATABASE_URL.')
}
if (process.env.RISTAK_SQLITE_PATH) {
  throw new Error('sitesJourneyAnalytics.test.mjs exige la SQLite temporal de node:test; elimina RISTAK_SQLITE_PATH.')
}

const {
  databaseDialect,
  databaseReady,
  db
} = await import('../src/config/database.js')

await databaseReady

assert.equal(
  databaseDialect,
  'sqlite',
  'Las pruebas de recorridos de Sites jamás deben escribir en PostgreSQL.'
)

const {
  getSite,
  getSitesTrackingSummary,
  renderPublicSiteHtml
} = await import('../src/services/sitesService.js')
const { getAccountTimezone } = await import('../src/utils/dateUtils.js')

function testSuffix(label) {
  return `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

async function analyticsDateWindow() {
  const timezone = await getAccountTimezone({ forceRefresh: true })
  const businessNow = DateTime.utc().setZone(timezone)
  return {
    dateFrom: businessNow.minus({ days: 1 }).toISODate(),
    dateTo: businessNow.plus({ days: 1 }).toISODate()
  }
}

async function insertPublicSite({
  id,
  name,
  slug,
  siteType,
  theme
}) {
  const now = DateTime.utc().toISO()
  await db.run(`
    INSERT INTO public_sites (
      id,
      name,
      slug,
      site_type,
      status,
      title,
      theme_json,
      published_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 'published', ?, ?, ?, ?, ?)
  `, [
    id,
    name,
    slug,
    siteType,
    name,
    JSON.stringify(theme),
    now,
    now,
    now
  ])
}

async function insertSiteBlock({
  id,
  siteId,
  blockType,
  label,
  pageId,
  sortOrder,
  required = true
}) {
  await db.run(`
    INSERT INTO public_site_blocks (
      id,
      site_id,
      block_type,
      label,
      content,
      placeholder,
      required,
      options_json,
      settings_json,
      sort_order
    ) VALUES (?, ?, ?, ?, '', '', ?, '[]', ?, ?)
  `, [
    id,
    siteId,
    blockType,
    label,
    required ? 1 : 0,
    JSON.stringify({ pageId }),
    sortOrder
  ])
}

async function insertNativePageView({
  suffix,
  eventKey,
  siteId,
  pageId,
  pageTitle,
  sessionId,
  visitorId,
  contactId = null,
  pageFlowRevision = null,
  pageJourneyId = null,
  at
}) {
  const resolvedPageJourneyId = pageJourneyId || (
    pageFlowRevision ? `journey_${sessionId}` : null
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
      site_id,
      public_page_id,
      public_page_title,
      page_flow_revision,
      page_journey_id
    ) VALUES (?, ?, ?, ?, 'native_site', 'native_site_view', ?, ?, ?, ?, ?, ?, ?)
  `, [
    sessionId,
    visitorId,
    contactId,
    `page_event_${suffix}_${eventKey}`,
    at,
    at,
    siteId,
    pageId,
    pageTitle,
    pageFlowRevision,
    resolvedPageJourneyId
  ])
}

async function insertFlowEvent({
  suffix,
  attemptId,
  eventSequence,
  eventName,
  visitorId,
  sessionId,
  contactId = null,
  siteId,
  formSiteId,
  publicPageId,
  flowRevision,
  stepId,
  targetStepId = null,
  fieldId = null,
  stepIndex,
  stepTotal,
  stepKind = 'question',
  outcome = null,
  submissionId = null,
  eventAt
}) {
  const eventKey = `${attemptId}_${eventSequence}`
  await db.run(`
    INSERT INTO site_flow_events (
      id,
      event_id,
      payload_hash,
      attempt_id,
      event_sequence,
      event_name,
      visitor_id,
      session_id,
      contact_id,
      site_id,
      form_site_id,
      public_page_id,
      flow_revision,
      step_id,
      target_step_id,
      field_id,
      step_index,
      step_total,
      step_kind,
      outcome,
      submission_id,
      event_at,
      created_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `, [
    `flow_row_${suffix}_${eventKey}`,
    `flow_event_${suffix}_${eventKey}`,
    `flow_hash_${suffix}_${eventKey}`,
    attemptId,
    eventSequence,
    eventName,
    visitorId,
    sessionId,
    contactId,
    siteId,
    formSiteId,
    publicPageId,
    flowRevision,
    stepId,
    targetStepId,
    fieldId,
    stepIndex,
    stepTotal,
    stepKind,
    outcome,
    submissionId,
    eventAt,
    eventAt
  ])
}

async function seedFlowAttempt({
  suffix,
  flow,
  siteId,
  attemptKey,
  visitorId,
  contactId = null,
  baseTime,
  events
}) {
  const attemptId = `attempt_${suffix}_${attemptKey}`
  const sessionId = `flow_session_${suffix}_${attemptKey}`
  const stageById = new Map(flow.stages.map(stage => [stage.stageId, stage]))

  for (const [eventOffset, event] of events.entries()) {
    const stage = stageById.get(event.stepId) || flow.stages[0]
    await insertFlowEvent({
      suffix,
      attemptId,
      eventSequence: event.eventSequence,
      eventName: event.eventName,
      visitorId,
      sessionId,
      contactId,
      siteId,
      formSiteId: flow.formSiteId,
      publicPageId: flow.stages[0].stageId,
      flowRevision: flow.flowRevision,
      stepId: event.stepId,
      targetStepId: event.targetStepId,
      fieldId: event.fieldId,
      stepIndex: Number(stage?.order || 0) + 1,
      stepTotal: flow.stages.length,
      stepKind: stage?.kind || 'question',
      outcome: event.outcome,
      submissionId: event.submissionId,
      eventAt: DateTime.fromISO(baseTime, { zone: 'utc' })
        .plus({ seconds: eventOffset })
        .toISO()
    })
  }
}

function extractMainFormFlow(html) {
  const marker = 'const MAIN_FORM_FLOW = '
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, 'El HTML público debe declarar MAIN_FORM_FLOW.')
  const valueStart = start + marker.length
  const valueEnd = html.indexOf(';\n', valueStart)
  assert.notEqual(valueEnd, -1, 'MAIN_FORM_FLOW debe terminar como una asignación JSON.')
  return JSON.parse(html.slice(valueStart, valueEnd))
}

function extractTrackingContext(html) {
  const marker = 'const RSTK_CONTEXT = '
  const start = html.indexOf(marker)
  assert.notEqual(start, -1, 'El HTML público debe declarar RSTK_CONTEXT.')
  const valueStart = start + marker.length
  const valueEnd = html.indexOf(';\n', valueStart)
  assert.notEqual(valueEnd, -1, 'RSTK_CONTEXT debe terminar como una asignación JSON.')
  return JSON.parse(html.slice(valueStart, valueEnd))
}

async function insertHiddenFilter(filterText) {
  await db.run(`
    INSERT INTO contacts (id, full_name, source, created_at, updated_at)
    VALUES (?, 'Contacto sintético oculto', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [filterText])
  await db.run(`
    INSERT INTO hidden_contact_filters (filter_text, match_type, created_at)
    VALUES (?, 'exact', CURRENT_TIMESTAMP)
  `, [filterText])
}

async function cleanupSyntheticData({ siteIds, hiddenFilter }) {
  const placeholders = siteIds.map(() => '?').join(', ')
  await db.run(
    `DELETE FROM site_flow_events
     WHERE site_id IN (${placeholders}) OR form_site_id IN (${placeholders})`,
    [...siteIds, ...siteIds]
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM sessions WHERE site_id IN (${placeholders}) OR form_site_id IN (${placeholders})`,
    [...siteIds, ...siteIds]
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM public_site_submissions
     WHERE site_id IN (${placeholders}) OR form_site_id IN (${placeholders})`,
    [...siteIds, ...siteIds]
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM public_site_blocks WHERE site_id IN (${placeholders})`,
    siteIds
  ).catch(() => undefined)
  await db.run(
    `DELETE FROM public_sites WHERE id IN (${placeholders})`,
    siteIds
  ).catch(() => undefined)
  await db.run(
    'DELETE FROM contacts WHERE id = ?',
    [hiddenFilter]
  ).catch(() => undefined)
  await db.run(
    'DELETE FROM hidden_contact_filters WHERE filter_text = ?',
    [hiddenFilter]
  ).catch(() => undefined)
}

test('page funnel analytics keeps reloads, direct entries, progress, and hidden contacts honest', async () => {
  const suffix = testSuffix('page_journey')
  const siteId = `site_${suffix}`
  const hiddenContactId = `hidden_contact_${suffix}`
  const pageIds = {
    intro: `page_intro_${suffix}`,
    offer: `page_offer_${suffix}`,
    thanks: `page_thanks_${suffix}`
  }
  const pages = [
    { id: pageIds.intro, title: 'Entrada', sortOrder: 0 },
    { id: pageIds.offer, title: 'Oferta', sortOrder: 1 },
    { id: pageIds.thanks, title: 'Gracias', sortOrder: 2 }
  ]
  const staleBase = DateTime.utc().minus({ hours: 2 })
  const activeBase = DateTime.utc().minus({ minutes: 5 })

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Embudo sintético',
      slug: `embudo-sintetico-${suffix}`,
      siteType: 'landing_page',
      theme: { pageMode: 'funnel', pages }
    })
    await insertHiddenFilter(hiddenContactId)
    const site = await getSite(siteId, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const publicHtml = await renderPublicSiteHtml(site, {
      pageId: pageIds.intro,
      trackingEnabled: true,
      preview: false
    })
    const pageFlowRevision = extractTrackingContext(publicHtml).pageFlowRevision
    assert.match(pageFlowRevision, /^[A-Za-z0-9_-]{32}$/)

    for (let index = 0; index < 10; index += 1) {
      const base = index === 9
        ? activeBase
        : staleBase.plus({ minutes: index })
      const identity = {
        sessionId: `page_session_${suffix}_${index}`,
        visitorId: `page_visitor_${suffix}_${index}`,
        pageFlowRevision
      }

      await insertNativePageView({
        suffix,
        eventKey: `main_${index}_intro`,
        siteId,
        pageId: pageIds.intro,
        pageTitle: 'Entrada',
        ...identity,
        at: base.toISO()
      })

      if (index === 0) {
        await insertNativePageView({
          suffix,
          eventKey: 'main_0_intro_reload',
          siteId,
          pageId: pageIds.intro,
          pageTitle: 'Entrada',
          ...identity,
          at: base.plus({ seconds: 1 }).toISO()
        })
      }

      if (index < 8) {
        await insertNativePageView({
          suffix,
          eventKey: `main_${index}_offer`,
          siteId,
          pageId: pageIds.offer,
          pageTitle: 'Oferta',
          ...identity,
          at: base.plus({ seconds: 10 }).toISO()
        })
      }

      if (index < 4) {
        await insertNativePageView({
          suffix,
          eventKey: `main_${index}_thanks`,
          siteId,
          pageId: pageIds.thanks,
          pageTitle: 'Gracias',
          ...identity,
          at: base.plus({ seconds: 20 }).toISO()
        })
      }
    }

    await insertNativePageView({
      suffix,
      eventKey: 'direct_offer',
      siteId,
      pageId: pageIds.offer,
      pageTitle: 'Oferta',
      sessionId: `page_session_${suffix}_direct`,
      visitorId: `page_visitor_${suffix}_direct`,
      pageFlowRevision,
      at: staleBase.plus({ minutes: 20 }).toISO()
    })

    for (const [offset, page] of pages.entries()) {
      await insertNativePageView({
        suffix,
        eventKey: `hidden_${page.id}`,
        siteId,
        pageId: page.id,
        pageTitle: page.title,
        sessionId: `page_session_${suffix}_hidden`,
        visitorId: `page_visitor_${suffix}_hidden`,
        contactId: hiddenContactId,
        pageFlowRevision,
        at: staleBase.plus({ minutes: 30, seconds: offset }).toISO()
      })
    }

    const dateWindow = await analyticsDateWindow()
    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      pageFunnelSiteId: siteId,
      ...dateWindow
    })

    assert.equal(summary.schemaVersion, 4)
    assert.deepEqual(Object.keys(summary.pageFunnels), [siteId])
    assert.deepEqual(summary.formJourneys, {})

    const funnel = summary.pageFunnels[siteId]
    assert.equal(funnel.measurement, 'first_party_page_journey_v1')
    assert.equal(funnel.coverage.status, 'verified')
    assert.equal(funnel.entrants, 10)
    assert.equal(funnel.uniqueEntrants, 10)
    assert.equal(funnel.completedAttempts, 4)
    assert.equal(funnel.completedVisitors, 4)
    assert.equal(funnel.conversionRate, 40)

    assert.equal(summary.bySiteId[siteId].views, 24)
    assert.equal(summary.bySiteId[siteId].visitors, 11)
    assert.equal(summary.bySiteId[siteId].sessions, 11)

    const [intro, offer, thanks] = funnel.stages
    assert.deepEqual(
      {
        stageId: intro.stageId,
        totalViews: intro.totalViews,
        reachedAttempts: intro.reachedAttempts,
        reachedVisitors: intro.reachedVisitors,
        advancedAttempts: intro.advancedAttempts,
        inProgressAttempts: intro.inProgressAttempts,
        droppedAttempts: intro.droppedAttempts,
        advanceRate: intro.advanceRate,
        dropOffRate: intro.dropOffRate,
        directEntries: intro.directEntries
      },
      {
        stageId: pageIds.intro,
        totalViews: 11,
        reachedAttempts: 10,
        reachedVisitors: 10,
        advancedAttempts: 8,
        inProgressAttempts: 1,
        droppedAttempts: 1,
        advanceRate: 80,
        dropOffRate: 10,
        directEntries: 0
      }
    )
    assert.deepEqual(intro.nextStages, [{
      stageId: pageIds.offer,
      label: 'Oferta',
      attempts: 8,
      visitors: 8,
      rate: 80
    }])

    assert.deepEqual(
      {
        stageId: offer.stageId,
        totalViews: offer.totalViews,
        reachedAttempts: offer.reachedAttempts,
        reachedVisitors: offer.reachedVisitors,
        advancedAttempts: offer.advancedAttempts,
        droppedAttempts: offer.droppedAttempts,
        inProgressAttempts: offer.inProgressAttempts,
        advanceRate: offer.advanceRate,
        dropOffRate: offer.dropOffRate,
        directEntries: offer.directEntries
      },
      {
        stageId: pageIds.offer,
        totalViews: 9,
        reachedAttempts: 9,
        reachedVisitors: 9,
        advancedAttempts: 4,
        droppedAttempts: 5,
        inProgressAttempts: 0,
        advanceRate: 44.4,
        dropOffRate: 55.6,
        directEntries: 1
      }
    )
    assert.deepEqual(offer.nextStages, [{
      stageId: pageIds.thanks,
      label: 'Gracias',
      attempts: 4,
      visitors: 4,
      rate: 44.4
    }])

    assert.deepEqual(
      {
        stageId: thanks.stageId,
        totalViews: thanks.totalViews,
        reachedAttempts: thanks.reachedAttempts,
        reachedVisitors: thanks.reachedVisitors,
        terminalAttempts: thanks.terminalAttempts,
        advanceRate: thanks.advanceRate,
        dropOffRate: thanks.dropOffRate
      },
      {
        stageId: pageIds.thanks,
        totalViews: 4,
        reachedAttempts: 4,
        reachedVisitors: 4,
        terminalAttempts: 4,
        advanceRate: 0,
        dropOffRate: 0
      }
    )
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: hiddenContactId
    })
  }
})

test('page funnel analytics splits stale sessions and assigns abandonment to the deepest incomplete stage', async () => {
  const suffix = testSuffix('page_adversarial')
  const siteId = `site_${suffix}`
  const cleanupFilter = `unused_filter_${suffix}`
  const pageIds = {
    intro: `page_intro_${suffix}`,
    offer: `page_offer_${suffix}`,
    thanks: `page_thanks_${suffix}`
  }
  const pages = [
    { id: pageIds.intro, title: 'Entrada', sortOrder: 0 },
    { id: pageIds.offer, title: 'Oferta', sortOrder: 1 },
    { id: pageIds.thanks, title: 'Gracias', sortOrder: 2 }
  ]
  const staleBase = DateTime.utc().minus({ hours: 4 })
  const activeBase = DateTime.utc().minus({ minutes: 5 })

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Embudo adversarial sintético',
      slug: `embudo-adversarial-${suffix}`,
      siteType: 'landing_page',
      theme: { pageMode: 'funnel', pages }
    })
    const site = await getSite(siteId, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const publicHtml = await renderPublicSiteHtml(site, {
      pageId: pageIds.intro,
      trackingEnabled: true,
      preview: false
    })
    const pageFlowRevision = extractTrackingContext(publicHtml).pageFlowRevision
    const sharedIdentity = {
      sessionId: `shared_session_${suffix}`,
      visitorId: `shared_visitor_${suffix}`,
      pageFlowRevision
    }

    for (const [eventKey, pageId, minutes] of [
      ['first_intro', pageIds.intro, 0],
      ['first_offer', pageIds.offer, 1],
      ['first_return_intro', pageIds.intro, 2],
      // La misma cookie de sesión reaparece 38 minutos después. Debe abrir un
      // intento nuevo aunque el session_id defectuoso siga siendo el mismo.
      ['second_intro', pageIds.intro, 40],
      ['second_offer', pageIds.offer, 41],
      ['second_thanks', pageIds.thanks, 42]
    ]) {
      await insertNativePageView({
        suffix,
        eventKey,
        siteId,
        pageId,
        pageTitle: pages.find(page => page.id === pageId)?.title || '',
        ...sharedIdentity,
        at: staleBase.plus({ minutes }).toISO()
      })
    }

    const activeIdentity = {
      sessionId: `active_session_${suffix}`,
      visitorId: `active_visitor_${suffix}`,
      pageFlowRevision
    }
    for (const [eventKey, pageId, seconds] of [
      ['active_intro', pageIds.intro, 0],
      ['active_offer', pageIds.offer, 10],
      ['active_return_intro', pageIds.intro, 20]
    ]) {
      await insertNativePageView({
        suffix,
        eventKey,
        siteId,
        pageId,
        pageTitle: pages.find(page => page.id === pageId)?.title || '',
        ...activeIdentity,
        at: activeBase.plus({ seconds }).toISO()
      })
    }

    // La analítica general conserva todo el histórico; el detalle del embudo
    // excluye estas vistas porque no prueban la topología actual.
    await insertNativePageView({
      suffix,
      eventKey: 'legacy_without_revision',
      siteId,
      pageId: pageIds.intro,
      pageTitle: 'Entrada',
      sessionId: `legacy_session_${suffix}`,
      visitorId: `legacy_visitor_${suffix}`,
      at: staleBase.plus({ hours: 2 }).toISO()
    })
    for (const [index, page] of pages.entries()) {
      await insertNativePageView({
        suffix,
        eventKey: `old_revision_${index}`,
        siteId,
        pageId: page.id,
        pageTitle: page.title,
        sessionId: `old_revision_session_${suffix}`,
        visitorId: `old_revision_visitor_${suffix}`,
        pageFlowRevision: `old_revision_${suffix}`,
        at: staleBase.plus({ hours: 2, minutes: 10, seconds: index }).toISO()
      })
    }

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      pageFunnelSiteId: siteId,
      ...await analyticsDateWindow()
    })
    const funnel = summary.pageFunnels[siteId]
    const [intro, offer, thanks] = funnel.stages

    assert.equal(summary.bySiteId[siteId].views, 13)
    assert.equal(funnel.coverage.status, 'partial')
    assert.equal(funnel.coverage.excludedRevisions, 1)
    assert.ok(funnel.coverage.warnings.some(warning => warning.includes('sin revisión')))
    assert.ok(funnel.coverage.warnings.some(warning => warning.includes('revisión(es) anterior(es)')))

    assert.equal(funnel.entrants, 3)
    assert.equal(funnel.uniqueEntrants, 2)
    assert.equal(funnel.completedAttempts, 1)
    assert.equal(funnel.completedVisitors, 1)
    assert.equal(funnel.conversionRate, 33.3)

    assert.deepEqual(
      {
        totalViews: intro.totalViews,
        reachedAttempts: intro.reachedAttempts,
        advancedAttempts: intro.advancedAttempts,
        droppedAttempts: intro.droppedAttempts,
        inProgressAttempts: intro.inProgressAttempts
      },
      {
        totalViews: 5,
        reachedAttempts: 3,
        advancedAttempts: 3,
        droppedAttempts: 0,
        inProgressAttempts: 0
      }
    )
    assert.deepEqual(
      {
        totalViews: offer.totalViews,
        reachedAttempts: offer.reachedAttempts,
        advancedAttempts: offer.advancedAttempts,
        droppedAttempts: offer.droppedAttempts,
        inProgressAttempts: offer.inProgressAttempts,
        advanceRate: offer.advanceRate,
        dropOffRate: offer.dropOffRate
      },
      {
        totalViews: 3,
        reachedAttempts: 3,
        advancedAttempts: 1,
        droppedAttempts: 1,
        inProgressAttempts: 1,
        advanceRate: 33.3,
        dropOffRate: 33.3
      }
    )
    assert.deepEqual(offer.nextStages, [{
      stageId: pageIds.thanks,
      label: 'Gracias',
      attempts: 1,
      visitors: 1,
      rate: 33.3
    }])
    assert.equal(thanks.reachedAttempts, 1)
    assert.equal(thanks.terminalAttempts, 1)
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: cleanupFilter
    })
  }
})

test('page funnel analytics reports legacy-only activity as unavailable without inventing excluded revisions', async () => {
  const suffix = testSuffix('page_legacy_only')
  const siteId = `site_${suffix}`
  const cleanupFilter = `unused_filter_${suffix}`
  const pageId = `page_intro_${suffix}`

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Embudo legado sintético',
      slug: `embudo-legado-${suffix}`,
      siteType: 'landing_page',
      theme: {
        pageMode: 'funnel',
        pages: [{ id: pageId, title: 'Entrada', sortOrder: 0 }]
      }
    })
    await insertNativePageView({
      suffix,
      eventKey: 'legacy_only',
      siteId,
      pageId,
      pageTitle: 'Entrada',
      sessionId: `legacy_session_${suffix}`,
      visitorId: `legacy_visitor_${suffix}`,
      at: DateTime.utc().minus({ hours: 2 }).toISO()
    })

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      pageFunnelSiteId: siteId,
      ...await analyticsDateWindow()
    })
    const funnel = summary.pageFunnels[siteId]

    assert.equal(summary.bySiteId[siteId].views, 1)
    assert.equal(funnel.coverage.status, 'unavailable')
    assert.equal(funnel.entrants, 0)
    assert.equal(funnel.stages[0].reachedAttempts, 0)
    assert.equal(
      Object.hasOwn(funnel.coverage, 'excludedRevisions'),
      false,
      'una vista legacy no debe fingirse como una revisión anterior numerada'
    )
    assert.ok(funnel.coverage.warnings.some(warning => warning.includes('ninguna vista pertenece')))
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: cleanupFilter
    })
  }
})

test('page flow revision stays stable for the same topology and changes when pages are reordered', async () => {
  const suffix = testSuffix('page_revision')
  const siteId = `site_${suffix}`
  const cleanupFilter = `unused_filter_${suffix}`
  const pages = [
    { id: `page_a_${suffix}`, title: 'A', sortOrder: 0 },
    { id: `page_b_${suffix}`, title: 'B', sortOrder: 1 }
  ]

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Embudo con revisión sintética',
      slug: `embudo-revision-${suffix}`,
      siteType: 'landing_page',
      theme: { pageMode: 'funnel', pages }
    })
    const original = await getSite(siteId, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const originalHtml = await renderPublicSiteHtml(original, {
      pageId: pages[0].id,
      trackingEnabled: true,
      preview: false
    })
    const originalRevision = extractTrackingContext(originalHtml).pageFlowRevision
    const repeatedRevision = extractTrackingContext(await renderPublicSiteHtml(original, {
      pageId: pages[1].id,
      trackingEnabled: true,
      preview: false
    })).pageFlowRevision

    assert.equal(repeatedRevision, originalRevision)
    assert.match(originalHtml, /PAGE_TAB_STORAGE_PREFIX/)
    assert.match(originalHtml, /page_context_token:\s*RSTK_CONTEXT\.pageContextToken/)
    assert.match(originalHtml, /page_tab_nonce:\s*getPageTabNonce\(\)/)

    const reorderedPages = [
      { ...pages[1], sortOrder: 0 },
      { ...pages[0], sortOrder: 1 }
    ]
    await db.run(
      'UPDATE public_sites SET theme_json = ?, updated_at = ? WHERE id = ?',
      [
        JSON.stringify({ pageMode: 'funnel', pages: reorderedPages }),
        DateTime.utc().toISO(),
        siteId
      ]
    )
    const reordered = await getSite(siteId, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const reorderedRevision = extractTrackingContext(await renderPublicSiteHtml(reordered, {
      pageId: reorderedPages[0].id,
      trackingEnabled: true,
      preview: false
    })).pageFlowRevision

    assert.match(originalRevision, /^[A-Za-z0-9_-]{32}$/)
    assert.match(reorderedRevision, /^[A-Za-z0-9_-]{32}$/)
    assert.notEqual(reorderedRevision, originalRevision)
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: cleanupFilter
    })
  }
})

test('page funnel analytics keeps simultaneous tabs as separate attempts even when cookies share session_id', async () => {
  const suffix = testSuffix('page_parallel_tabs')
  const siteId = `site_${suffix}`
  const cleanupFilter = `unused_filter_${suffix}`
  const pages = [
    { id: `page_a_${suffix}`, title: 'A', sortOrder: 0 },
    { id: `page_b_${suffix}`, title: 'B', sortOrder: 1 },
    { id: `page_c_${suffix}`, title: 'C', sortOrder: 2 }
  ]
  const staleBase = DateTime.utc().minus({ hours: 2 })

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Embudo pestañas sintético',
      slug: `embudo-tabs-${suffix}`,
      siteType: 'landing_page',
      theme: { pageMode: 'funnel', pages }
    })
    const site = await getSite(siteId, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const pageFlowRevision = extractTrackingContext(await renderPublicSiteHtml(site, {
      pageId: pages[0].id,
      trackingEnabled: true,
      preview: false
    })).pageFlowRevision
    const shared = {
      siteId,
      sessionId: `shared_cookie_session_${suffix}`,
      visitorId: `shared_cookie_visitor_${suffix}`,
      pageFlowRevision
    }

    // Dos pestañas activas intercalan eventos con la misma cookie. Sólo
    // page_journey_id permite evitar que el recorrido terminado de una "salve"
    // artificialmente el abandono de la otra.
    for (const event of [
      { key: 'tab_one_a', page: pages[0], seconds: 0, journey: `tab_one_${suffix}` },
      { key: 'tab_two_a', page: pages[0], seconds: 1, journey: `tab_two_${suffix}` },
      { key: 'tab_one_b', page: pages[1], seconds: 2, journey: `tab_one_${suffix}` },
      { key: 'tab_two_b', page: pages[1], seconds: 3, journey: `tab_two_${suffix}` },
      { key: 'tab_two_back_a', page: pages[0], seconds: 4, journey: `tab_two_${suffix}` },
      { key: 'tab_one_c', page: pages[2], seconds: 5, journey: `tab_one_${suffix}` }
    ]) {
      await insertNativePageView({
        suffix,
        eventKey: event.key,
        ...shared,
        pageId: event.page.id,
        pageTitle: event.page.title,
        pageJourneyId: event.journey,
        at: staleBase.plus({ seconds: event.seconds }).toISO()
      })
    }

    const funnel = (await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      pageFunnelSiteId: siteId,
      ...await analyticsDateWindow()
    })).pageFunnels[siteId]

    assert.equal(funnel.entrants, 2)
    assert.equal(funnel.uniqueEntrants, 1)
    assert.equal(funnel.completedAttempts, 1)
    assert.equal(funnel.completedVisitors, 1)
    assert.equal(funnel.stages[1].reachedAttempts, 2)
    assert.equal(funnel.stages[1].advancedAttempts, 1)
    assert.equal(funnel.stages[1].droppedAttempts, 1)
    assert.equal(funnel.stages[0].droppedAttempts, 0)
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: cleanupFilter
    })
  }
})

test('page funnel cohort includes continuation up to 30 minutes after the selected range ends', async () => {
  const suffix = testSuffix('page_range_continuation')
  const siteId = `site_${suffix}`
  const cleanupFilter = `unused_filter_${suffix}`
  const pages = [
    { id: `page_a_${suffix}`, title: 'A', sortOrder: 0 },
    { id: `page_b_${suffix}`, title: 'B', sortOrder: 1 },
    { id: `page_c_${suffix}`, title: 'C', sortOrder: 2 }
  ]

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Embudo frontera sintético',
      slug: `embudo-frontera-${suffix}`,
      siteType: 'landing_page',
      theme: { pageMode: 'funnel', pages }
    })
    const site = await getSite(siteId, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const pageFlowRevision = extractTrackingContext(await renderPublicSiteHtml(site, {
      pageId: pages[0].id,
      trackingEnabled: true,
      preview: false
    })).pageFlowRevision
    const timezone = await getAccountTimezone({ forceRefresh: true })
    const selectedDay = DateTime.utc().setZone(timezone).minus({ days: 2 }).toISODate()
    const dateWindow = { dateFrom: selectedDay, dateTo: selectedDay }
    const probe = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      pageFunnelSiteId: siteId,
      ...dateWindow
    })
    const rangeEnd = DateTime.fromISO(probe.meta.endUtc, { zone: 'utc' })
    assert.equal(rangeEnd.isValid, true)
    const identity = {
      siteId,
      sessionId: `range_session_${suffix}`,
      visitorId: `range_visitor_${suffix}`,
      pageFlowRevision,
      pageJourneyId: `range_journey_${suffix}`
    }

    for (const [eventKey, page, minutesAfterEnd] of [
      ['range_a', pages[0], -1],
      ['range_b', pages[1], 15],
      ['range_c', pages[2], 30]
    ]) {
      await insertNativePageView({
        suffix,
        eventKey,
        ...identity,
        pageId: page.id,
        pageTitle: page.title,
        at: rangeEnd.plus({ minutes: minutesAfterEnd }).toISO()
      })
    }

    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      pageFunnelSiteId: siteId,
      ...dateWindow
    })
    const funnel = summary.pageFunnels[siteId]

    assert.equal(
      summary.bySiteId[siteId].views,
      1,
      'la analítica general conserva el corte exacto del rango'
    )
    assert.equal(funnel.entrants, 1)
    assert.equal(funnel.completedAttempts, 1)
    assert.equal(funnel.conversionRate, 100)
    assert.deepEqual(
      funnel.stages.map(stage => stage.reachedAttempts),
      [1, 1, 1]
    )
    assert.equal(funnel.stages[0].droppedAttempts, 0)
    assert.equal(funnel.stages[1].droppedAttempts, 0)
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: cleanupFilter
    })
  }
})

test('form journey analytics separates live progress from legacy answer coverage', async () => {
  const suffix = testSuffix('form_journey')
  const siteId = `form_${suffix}`
  const hiddenContactId = `hidden_contact_${suffix}`
  const submissionId = `submission_${suffix}`
  const pageIds = {
    first: `question_first_${suffix}`,
    second: `question_second_${suffix}`,
    third: `question_third_${suffix}`
  }
  const fieldIds = {
    first: `field_first_${suffix}`,
    second: `field_second_${suffix}`,
    third: `field_third_${suffix}`
  }
  const pages = [
    { id: pageIds.first, title: 'Primera pregunta', sortOrder: 0 },
    { id: pageIds.second, title: 'Segunda pregunta', sortOrder: 1 },
    { id: pageIds.third, title: 'Tercera pregunta', sortOrder: 2 }
  ]
  const staleBase = DateTime.utc().minus({ hours: 2 })
  const activeBase = DateTime.utc().minus({ minutes: 5 })

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Formulario sintético',
      slug: `formulario-sintetico-${suffix}`,
      siteType: 'interactive_form',
      theme: { pages }
    })
    await insertSiteBlock({
      id: fieldIds.first,
      siteId,
      blockType: 'short_text',
      label: '¿Cómo te llamas?',
      pageId: pageIds.first,
      sortOrder: 0
    })
    await insertSiteBlock({
      id: fieldIds.second,
      siteId,
      blockType: 'email',
      label: '¿Cuál es tu correo?',
      pageId: pageIds.second,
      sortOrder: 1
    })
    await insertSiteBlock({
      id: fieldIds.third,
      siteId,
      blockType: 'phone',
      label: '¿Cuál es tu teléfono?',
      pageId: pageIds.third,
      sortOrder: 2
    })
    await insertHiddenFilter(hiddenContactId)

    const site = await getSite(siteId, {
      includeBlocks: true,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const publicHtml = await renderPublicSiteHtml(site, {
      pageId: pageIds.first,
      trackingEnabled: true,
      preview: false
    })
    const previewHtml = await renderPublicSiteHtml(site, {
      pageId: pageIds.first,
      trackingEnabled: false,
      preview: true
    })

    assert.match(publicHtml, /\/api\/sites\/public\/form-progress/)
    assert.doesNotMatch(previewHtml, /\/api\/sites\/public\/form-progress/)

    const flow = extractMainFormFlow(publicHtml)
    assert.equal(flow.formSiteId, siteId)
    assert.match(flow.flowRevision, /^[A-Za-z0-9_-]{32}$/)
    assert.deepEqual(
      flow.stages.map(stage => ({
        stageId: stage.stageId,
        label: stage.label,
        order: stage.order,
        fields: stage.fields.map(field => field.fieldId)
      })),
      [
        {
          stageId: pageIds.first,
          label: '¿Cómo te llamas?',
          order: 0,
          fields: [fieldIds.first]
        },
        {
          stageId: pageIds.second,
          label: '¿Cuál es tu correo?',
          order: 1,
          fields: [fieldIds.second]
        },
        {
          stageId: pageIds.third,
          label: '¿Cuál es tu teléfono?',
          order: 2,
          fields: [fieldIds.third]
        }
      ]
    )

    const completedEvents = [
      { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
      { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
      { eventSequence: 3, eventName: 'field_answered', stepId: pageIds.first, fieldId: fieldIds.first },
      { eventSequence: 4, eventName: 'step_complete', stepId: pageIds.first, targetStepId: pageIds.second },
      { eventSequence: 5, eventName: 'step_view', stepId: pageIds.second },
      { eventSequence: 6, eventName: 'field_answered', stepId: pageIds.second, fieldId: fieldIds.second },
      { eventSequence: 7, eventName: 'step_complete', stepId: pageIds.second, targetStepId: pageIds.third },
      { eventSequence: 8, eventName: 'step_view', stepId: pageIds.third },
      { eventSequence: 9, eventName: 'field_answered', stepId: pageIds.third, fieldId: fieldIds.third },
      {
        eventSequence: 2_147_483_647,
        eventName: 'attempt_completed',
        stepId: pageIds.third,
        outcome: 'qualified',
        submissionId
      }
    ]
    const repeatedVisitorEvents = [
      { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
      { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
      { eventSequence: 3, eventName: 'field_answered', stepId: pageIds.first, fieldId: fieldIds.first },
      { eventSequence: 4, eventName: 'step_complete', stepId: pageIds.first, targetStepId: pageIds.second },
      { eventSequence: 5, eventName: 'step_view', stepId: pageIds.second }
    ]
    const terminalEvents = [
      { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
      { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
      { eventSequence: 3, eventName: 'step_complete', stepId: pageIds.first, targetStepId: pageIds.second },
      { eventSequence: 4, eventName: 'step_view', stepId: pageIds.second },
      { eventSequence: 5, eventName: 'field_answered', stepId: pageIds.second, fieldId: fieldIds.second },
      { eventSequence: 6, eventName: 'step_complete', stepId: pageIds.second, targetStepId: pageIds.third },
      { eventSequence: 7, eventName: 'step_view', stepId: pageIds.third },
      {
        eventSequence: 2_147_483_647,
        eventName: 'attempt_terminal',
        stepId: pageIds.third,
        outcome: 'disqualified',
        submissionId: `terminal_${submissionId}`
      }
    ]
    const activeEvents = [
      { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
      { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first }
    ]
    const droppedEvents = [
      { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
      { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first }
    ]

    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'completed',
      visitorId: `form_visitor_${suffix}_shared`,
      baseTime: staleBase.toISO(),
      events: completedEvents
    })
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'repeat_visitor',
      visitorId: `form_visitor_${suffix}_shared`,
      baseTime: staleBase.plus({ minutes: 5 }).toISO(),
      events: repeatedVisitorEvents
    })
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'terminal',
      visitorId: `form_visitor_${suffix}_terminal`,
      baseTime: staleBase.plus({ minutes: 10 }).toISO(),
      events: terminalEvents
    })
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'active',
      visitorId: `form_visitor_${suffix}_active`,
      baseTime: activeBase.toISO(),
      events: activeEvents
    })
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'dropped',
      visitorId: `form_visitor_${suffix}_dropped`,
      baseTime: staleBase.plus({ minutes: 15 }).toISO(),
      events: droppedEvents
    })
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'hidden',
      visitorId: `form_visitor_${suffix}_hidden`,
      contactId: hiddenContactId,
      baseTime: staleBase.plus({ minutes: 20 }).toISO(),
      events: completedEvents.map(event => ({
        ...event,
        submissionId: event.submissionId ? `hidden_${event.submissionId}` : undefined
      }))
    })
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'hidden_only_at_terminal',
      visitorId: `form_visitor_${suffix}_hidden_terminal`,
      contactId: hiddenContactId,
      baseTime: staleBase.plus({ minutes: 21 }).toISO(),
      events: completedEvents.map(event => ({
        ...event,
        submissionId: event.submissionId ? `hidden_terminal_${event.submissionId}` : undefined
      }))
    })
    await db.run(`
      UPDATE site_flow_events
      SET contact_id = NULL
      WHERE attempt_id = ?
        AND event_name NOT IN ('attempt_completed', 'attempt_terminal')
    `, [`attempt_${suffix}_hidden_only_at_terminal`])

    const submissionAt = staleBase.plus({ minutes: 25 }).toISO()
    await db.run(`
      INSERT INTO public_site_submissions (
        id,
        site_id,
        response_json,
        meta_json,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, 'received', ?)
    `, [
      submissionId,
      siteId,
      JSON.stringify({
        [fieldIds.first]: 'Respuesta sintética',
        [fieldIds.second]: 'synthetic@example.invalid',
        [fieldIds.third]: '+10000000000'
      }),
      JSON.stringify({ formFinalSubmit: true }),
      submissionAt
    ])

    const dateWindow = await analyticsDateWindow()
    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      formFunnelSiteId: siteId,
      formJourneySiteId: siteId,
      ...dateWindow
    })

    assert.equal(summary.schemaVersion, 4)
    assert.deepEqual(Object.keys(summary.formJourneys), [siteId])
    assert.deepEqual(Object.keys(summary.formFunnels), [siteId])

    const journey = summary.formJourneys[siteId]
    assert.equal(journey.measurement, 'first_party_form_journey_v1')
    assert.equal(journey.flowRevision, flow.flowRevision)
    assert.equal(journey.entrants, 5)
    assert.equal(journey.uniqueEntrants, 4)
    assert.equal(journey.completedAttempts, 1)
    assert.equal(journey.completedVisitors, 1)
    assert.equal(journey.conversionRate, 20)
    assert.equal(
      await db.get(`
        SELECT COUNT(*) AS total
        FROM site_flow_events
        WHERE attempt_id = ?
          AND contact_id = ?
      `, [`attempt_${suffix}_hidden_only_at_terminal`, hiddenContactId])
        .then(row => Number(row?.total || 0)),
      1,
      'La prueba deja la identidad oculta únicamente en el cierre del intento.'
    )

    const [first, second, third] = journey.stages
    assert.deepEqual(
      {
        stageId: first.stageId,
        reachedAttempts: first.reachedAttempts,
        reachedVisitors: first.reachedVisitors,
        answeredAttempts: first.answeredAttempts,
        answeredVisitors: first.answeredVisitors,
        advancedAttempts: first.advancedAttempts,
        advancedVisitors: first.advancedVisitors,
        inProgressAttempts: first.inProgressAttempts,
        droppedAttempts: first.droppedAttempts,
        terminalAttempts: first.terminalAttempts,
        advanceRate: first.advanceRate,
        dropOffRate: first.dropOffRate
      },
      {
        stageId: pageIds.first,
        reachedAttempts: 5,
        reachedVisitors: 4,
        answeredAttempts: 2,
        answeredVisitors: 1,
        advancedAttempts: 3,
        advancedVisitors: 2,
        inProgressAttempts: 1,
        droppedAttempts: 1,
        terminalAttempts: 0,
        advanceRate: 60,
        dropOffRate: 20
      }
    )
    assert.deepEqual(first.fields, [{
      fieldId: fieldIds.first,
      label: '¿Cómo te llamas?',
      answeredAttempts: 2,
      answeredVisitors: 1,
      answerRate: 40
    }])
    assert.deepEqual(first.nextStages, [{
      stageId: pageIds.second,
      label: '¿Cuál es tu correo?',
      attempts: 3,
      visitors: 2,
      rate: 60
    }])

    assert.deepEqual(
      {
        stageId: second.stageId,
        reachedAttempts: second.reachedAttempts,
        reachedVisitors: second.reachedVisitors,
        answeredAttempts: second.answeredAttempts,
        answeredVisitors: second.answeredVisitors,
        advancedAttempts: second.advancedAttempts,
        advancedVisitors: second.advancedVisitors,
        inProgressAttempts: second.inProgressAttempts,
        droppedAttempts: second.droppedAttempts,
        terminalAttempts: second.terminalAttempts,
        advanceRate: second.advanceRate,
        dropOffRate: second.dropOffRate
      },
      {
        stageId: pageIds.second,
        reachedAttempts: 3,
        reachedVisitors: 2,
        answeredAttempts: 2,
        answeredVisitors: 2,
        advancedAttempts: 2,
        advancedVisitors: 2,
        inProgressAttempts: 0,
        droppedAttempts: 1,
        terminalAttempts: 0,
        advanceRate: 66.7,
        dropOffRate: 33.3
      }
    )
    assert.deepEqual(second.fields, [{
      fieldId: fieldIds.second,
      label: '¿Cuál es tu correo?',
      answeredAttempts: 2,
      answeredVisitors: 2,
      answerRate: 66.7
    }])
    assert.deepEqual(second.nextStages, [{
      stageId: pageIds.third,
      label: '¿Cuál es tu teléfono?',
      attempts: 2,
      visitors: 2,
      rate: 66.7
    }])

    assert.deepEqual(
      {
        stageId: third.stageId,
        reachedAttempts: third.reachedAttempts,
        reachedVisitors: third.reachedVisitors,
        answeredAttempts: third.answeredAttempts,
        answeredVisitors: third.answeredVisitors,
        advancedAttempts: third.advancedAttempts,
        advancedVisitors: third.advancedVisitors,
        inProgressAttempts: third.inProgressAttempts,
        droppedAttempts: third.droppedAttempts,
        terminalAttempts: third.terminalAttempts,
        advanceRate: third.advanceRate,
        dropOffRate: third.dropOffRate
      },
      {
        stageId: pageIds.third,
        reachedAttempts: 2,
        reachedVisitors: 2,
        answeredAttempts: 1,
        answeredVisitors: 1,
        advancedAttempts: 2,
        advancedVisitors: 2,
        inProgressAttempts: 0,
        droppedAttempts: 0,
        terminalAttempts: 2,
        advanceRate: 100,
        dropOffRate: 0
      }
    )
    assert.deepEqual(third.fields, [{
      fieldId: fieldIds.third,
      label: '¿Cuál es tu teléfono?',
      answeredAttempts: 1,
      answeredVisitors: 1,
      answerRate: 50
    }])

    const legacy = summary.formFunnels[siteId]
    assert.equal(legacy.measurement, 'saved_submission_answer_coverage')
    assert.equal(legacy.submissions, 1)
    assert.equal(Object.hasOwn(legacy, 'stages'), false)
    assert.equal(Object.hasOwn(journey, 'fields'), false)
    assert.deepEqual(
      legacy.fields.map(field => ({
        blockId: field.blockId,
        finalSubmissions: field.finalSubmissions,
        answeredCount: field.answeredCount,
        answerRate: field.answerRate
      })),
      [
        {
          blockId: fieldIds.first,
          finalSubmissions: 1,
          answeredCount: 1,
          answerRate: 100
        },
        {
          blockId: fieldIds.second,
          finalSubmissions: 1,
          answeredCount: 1,
          answerRate: 100
        },
        {
          blockId: fieldIds.third,
          finalSubmissions: 1,
          answeredCount: 1,
          answerRate: 100
        }
      ]
    )
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: hiddenContactId
    })
  }
})

test('form journey analytics assigns unresolved attempts only to their last viewed stage', async () => {
  const suffix = testSuffix('form_journey_last_stage')
  const siteId = `form_${suffix}`
  const pageIds = {
    first: `question_first_${suffix}`,
    second: `question_second_${suffix}`,
    third: `question_third_${suffix}`
  }
  const fieldIds = {
    first: `field_first_${suffix}`,
    second: `field_second_${suffix}`,
    third: `field_third_${suffix}`
  }
  const pages = [
    { id: pageIds.first, title: 'Primera pregunta', sortOrder: 0 },
    { id: pageIds.second, title: 'Segunda pregunta', sortOrder: 1 },
    { id: pageIds.third, title: 'Tercera pregunta', sortOrder: 2 }
  ]
  const staleBase = DateTime.utc().minus({ hours: 2 })
  const activeBase = DateTime.utc().minus({ minutes: 5 })

  try {
    await insertPublicSite({
      id: siteId,
      name: 'Formulario sintético adversarial',
      slug: `formulario-sintetico-adversarial-${suffix}`,
      siteType: 'interactive_form',
      theme: { pages }
    })
    await insertSiteBlock({
      id: fieldIds.first,
      siteId,
      blockType: 'short_text',
      label: 'Primera pregunta',
      pageId: pageIds.first,
      sortOrder: 0
    })
    await insertSiteBlock({
      id: fieldIds.second,
      siteId,
      blockType: 'short_text',
      label: 'Segunda pregunta',
      pageId: pageIds.second,
      sortOrder: 1
    })
    await insertSiteBlock({
      id: fieldIds.third,
      siteId,
      blockType: 'short_text',
      label: 'Tercera pregunta',
      pageId: pageIds.third,
      sortOrder: 2
    })

    const site = await getSite(siteId, {
      includeBlocks: true,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const publicHtml = await renderPublicSiteHtml(site, {
      pageId: pageIds.first,
      trackingEnabled: true,
      preview: false
    })
    const flow = extractMainFormFlow(publicHtml)

    const staleAttempts = [
      {
        attemptKey: 'completed_missing_intermediate_events',
        events: [
          { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
          { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
          { eventSequence: 3, eventName: 'step_view', stepId: pageIds.second },
          {
            eventSequence: 2_147_483_647,
            eventName: 'attempt_completed',
            stepId: pageIds.third,
            outcome: 'qualified',
            submissionId: `completed_${suffix}`
          }
        ]
      },
      {
        attemptKey: 'terminal_missing_intermediate_events',
        events: [
          { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
          { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
          { eventSequence: 3, eventName: 'step_view', stepId: pageIds.second },
          {
            eventSequence: 2_147_483_647,
            eventName: 'attempt_terminal',
            stepId: pageIds.second,
            outcome: 'disqualified',
            submissionId: `terminal_${suffix}`
          }
        ]
      },
      {
        attemptKey: 'dropped_after_lost_step_complete',
        events: [
          { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
          { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
          { eventSequence: 3, eventName: 'step_view', stepId: pageIds.second }
        ]
      },
      {
        attemptKey: 'advanced_with_lost_next_view',
        events: [
          { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
          { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
          {
            eventSequence: 3,
            eventName: 'step_complete',
            stepId: pageIds.first,
            targetStepId: pageIds.second
          }
        ]
      },
      {
        attemptKey: 'dropped_after_revisit',
        events: [
          { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
          { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
          {
            eventSequence: 3,
            eventName: 'step_complete',
            stepId: pageIds.first,
            targetStepId: pageIds.second
          },
          { eventSequence: 4, eventName: 'step_view', stepId: pageIds.second },
          { eventSequence: 5, eventName: 'step_view', stepId: pageIds.first }
        ]
      }
    ]

    for (const [index, attempt] of staleAttempts.entries()) {
      await seedFlowAttempt({
        suffix,
        flow,
        siteId,
        attemptKey: attempt.attemptKey,
        visitorId: `visitor_${suffix}_${attempt.attemptKey}`,
        baseTime: staleBase.plus({ minutes: index }).toISO(),
        events: attempt.events
      })
    }
    await seedFlowAttempt({
      suffix,
      flow,
      siteId,
      attemptKey: 'active_after_lost_step_complete',
      visitorId: `visitor_${suffix}_active`,
      baseTime: activeBase.toISO(),
      events: [
        { eventSequence: 1, eventName: 'attempt_start', stepId: pageIds.first },
        { eventSequence: 2, eventName: 'step_view', stepId: pageIds.first },
        { eventSequence: 3, eventName: 'step_view', stepId: pageIds.second }
      ]
    })

    const dateWindow = await analyticsDateWindow()
    const summary = await getSitesTrackingSummary({
      siteIds: [siteId],
      breakdownSiteIds: [siteId],
      formJourneySiteId: siteId,
      ...dateWindow
    })
    const journey = summary.formJourneys[siteId]
    const [first, second, third] = journey.stages

    assert.equal(journey.entrants, 6)
    assert.equal(journey.completedAttempts, 1)
    assert.deepEqual(
      journey.stages.map(stage => ({
        stageId: stage.stageId,
        reachedAttempts: stage.reachedAttempts,
        advancedAttempts: stage.advancedAttempts,
        terminalAttempts: stage.terminalAttempts,
        inProgressAttempts: stage.inProgressAttempts,
        inProgressVisitors: stage.inProgressVisitors,
        droppedAttempts: stage.droppedAttempts,
        droppedVisitors: stage.droppedVisitors
      })),
      [
        {
          stageId: pageIds.first,
          reachedAttempts: 6,
          advancedAttempts: 2,
          terminalAttempts: 0,
          inProgressAttempts: 0,
          inProgressVisitors: 0,
          droppedAttempts: 0,
          droppedVisitors: 0
        },
        {
          stageId: pageIds.second,
          reachedAttempts: 5,
          advancedAttempts: 1,
          terminalAttempts: 1,
          inProgressAttempts: 1,
          inProgressVisitors: 1,
          droppedAttempts: 2,
          droppedVisitors: 2
        },
        {
          stageId: pageIds.third,
          reachedAttempts: 0,
          advancedAttempts: 1,
          terminalAttempts: 1,
          inProgressAttempts: 0,
          inProgressVisitors: 0,
          droppedAttempts: 0,
          droppedVisitors: 0
        }
      ]
    )
    assert.equal(
      journey.stages.reduce((total, stage) => total + stage.droppedAttempts, 0),
      2,
      'Los intentos terminales nunca deben reaparecer como abandonos aunque falten eventos intermedios.'
    )
    assert.equal(
      journey.stages.reduce((total, stage) => total + stage.inProgressAttempts, 0),
      1,
      'Un intento activo sólo debe vivir en su última etapa vista.'
    )
    assert.deepEqual(first.nextStages, [{
      stageId: pageIds.second,
      label: 'Segunda pregunta',
      attempts: 2,
      visitors: 2,
      rate: 33.3
    }])
    assert.deepEqual(second.nextStages, [])
    assert.deepEqual(third.nextStages, [])
  } finally {
    await cleanupSyntheticData({
      siteIds: [siteId],
      hiddenFilter: `unused_hidden_filter_${suffix}`
    })
  }
})
