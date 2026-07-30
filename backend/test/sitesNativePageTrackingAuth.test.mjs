import test from 'node:test'
import assert from 'node:assert/strict'

if (process.env.DATABASE_URL) {
  throw new Error('sitesNativePageTrackingAuth.test.mjs sólo puede usar SQLite local; elimina DATABASE_URL.')
}
if (process.env.RISTAK_SQLITE_PATH) {
  throw new Error('sitesNativePageTrackingAuth.test.mjs exige la SQLite temporal de node:test; elimina RISTAK_SQLITE_PATH.')
}

const {
  databaseDialect,
  databaseReady,
  db
} = await import('../src/config/database.js')
await databaseReady
assert.equal(databaseDialect, 'sqlite')

const { collectEvent } = await import('../src/controllers/trackingController.js')
const {
  deleteConfig,
  getConfig,
  saveConfig
} = await import('../src/controllers/configController.js')
const {
  NativePageTrackingAuthError,
  authenticateTrackingPageView,
  createNativePageTrackingContext,
  consumeNativePageViewRateLimit,
  resetNativePageViewRateLimitForTests
} = await import('../src/services/nativePageTrackingAuthService.js')
const { signPublicContextClaims } = await import('../src/services/publicContextTokenService.js')
const {
  getSite,
  renderPublicSiteHtml
} = await import('../src/services/sitesService.js')

function suffix(label) {
  return `${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function extractTrackingContext(html) {
  const marker = 'const RSTK_CONTEXT = '
  const start = html.indexOf(marker)
  assert.notEqual(start, -1)
  const valueStart = start + marker.length
  const valueEnd = html.indexOf(';\n', valueStart)
  assert.notEqual(valueEnd, -1)
  return JSON.parse(html.slice(valueStart, valueEnd))
}

function requestFor(host, body, { origin = `https://${host}`, ip = '127.0.0.1' } = {}) {
  return {
    headers: {
      host,
      origin,
      'content-length': String(Buffer.byteLength(JSON.stringify(body))),
      'user-agent': 'Ristak native page auth local test'
    },
    body,
    ip,
    protocol: 'https',
    secure: true,
    socket: { remoteAddress: ip }
  }
}

function responseMock() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    status(code) {
      this.statusCode = code
      return this
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = String(value)
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

async function seedSite({ id, slug, pages, host, domainId }) {
  const now = new Date().toISOString()
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
    ) VALUES (?, ?, ?, 'landing_page', 'published', ?, ?, ?, ?, ?)
  `, [
    id,
    `Embudo ${id}`,
    slug,
    `Embudo ${id}`,
    JSON.stringify({ pageMode: 'funnel', pages }),
    now,
    now,
    now
  ])
  await db.run(`
    INSERT INTO public_site_domains (
      id,
      domain,
      render_domain_verified,
      default_route_site_id,
      default_route_page_id,
      created_at,
      updated_at
    ) VALUES (?, ?, 1, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      domain = excluded.domain,
      render_domain_verified = 1,
      default_route_site_id = excluded.default_route_site_id,
      default_route_page_id = excluded.default_route_page_id,
      updated_at = CURRENT_TIMESTAMP
  `, [domainId, host, id, pages[0].id])
}

async function cleanup({ siteIds, domainId, sessionIds = [], contactId = '' }) {
  if (sessionIds.length) {
    const placeholders = sessionIds.map(() => '?').join(', ')
    await db.run(
      `DELETE FROM tracking_identity_matches WHERE session_id IN (${placeholders})`,
      sessionIds
    ).catch(() => undefined)
    await db.run(
      `DELETE FROM sessions WHERE session_id IN (${placeholders})`,
      sessionIds
    ).catch(() => undefined)
  }
  await db.run('DELETE FROM public_site_domains WHERE id = ?', [domainId]).catch(() => undefined)
  if (siteIds.length) {
    const placeholders = siteIds.map(() => '?').join(', ')
    await db.run(`DELETE FROM public_sites WHERE id IN (${placeholders})`, siteIds).catch(() => undefined)
  }
  if (contactId) {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
}

test('signed page context derives one journey per tab and rejects cross-page/site/host or expired tokens', async () => {
  const run = suffix('signed_context')
  const host = `funnel-${run}.example.test`
  const domainId = `domain_${run}`
  const siteA = `site_a_${run}`
  const siteB = `site_b_${run}`
  const pagesA = [
    { id: `page_a1_${run}`, title: 'Entrada', slug: 'entrada', sortOrder: 0 },
    { id: `page_a2_${run}`, title: 'Oferta', slug: 'oferta', sortOrder: 1 }
  ]
  const pagesB = [
    { id: `page_b1_${run}`, title: 'Otro inicio', slug: 'otro-inicio', sortOrder: 0 }
  ]

  try {
    await seedSite({ id: siteA, slug: `embudo-a-${run}`, pages: pagesA, host, domainId })
    await seedSite({ id: siteB, slug: `embudo-b-${run}`, pages: pagesB, host, domainId })
    const loadedA = await getSite(siteA, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const loadedB = await getSite(siteB, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const firstContext = extractTrackingContext(await renderPublicSiteHtml(loadedA, {
      pageId: pagesA[0].id,
      trackingEnabled: true,
      publicHost: host
    }))
    const secondContext = extractTrackingContext(await renderPublicSiteHtml(loadedA, {
      pageId: pagesA[1].id,
      trackingEnabled: true,
      publicHost: host
    }))

    assert.match(firstContext.pageContextToken, /^pct1\./)
    assert.match(firstContext.pageFlowRevision, /^[A-Za-z0-9_-]{32}$/)
    assert.equal(firstContext.pageContextToken.includes('page_journey'), false)

    const common = {
      tracking_source: 'native_site',
      site_id: siteA,
      page_flow_revision: firstContext.pageFlowRevision
    }
    const tabOneNonce = `tab_one_nonce_${run}`
    const tabTwoNonce = `tab_two_nonce_${run}`
    const firstTabPageOne = await authenticateTrackingPageView({
      eventName: 'native_site_view',
      req: requestFor(host, {}, { origin: `https://${host}` }),
      data: {
        ...common,
        public_page_id: pagesA[0].id,
        page_context_token: firstContext.pageContextToken,
        page_tab_nonce: tabOneNonce,
        url: `https://${host}/${loadedA.slug}/entrada`
      }
    })
    const firstTabPageTwo = await authenticateTrackingPageView({
      eventName: 'native_site_view',
      req: requestFor(host, {}),
      data: {
        ...common,
        public_page_id: pagesA[1].id,
        page_context_token: secondContext.pageContextToken,
        page_tab_nonce: tabOneNonce,
        url: `https://${host}/${loadedA.slug}/oferta`
      }
    })
    const secondTab = await authenticateTrackingPageView({
      eventName: 'native_site_view',
      req: requestFor(host, {}),
      data: {
        ...common,
        public_page_id: pagesA[0].id,
        page_context_token: firstContext.pageContextToken,
        page_tab_nonce: tabTwoNonce,
        url: `https://${host}/${loadedA.slug}/entrada`
      }
    })

    assert.equal(firstTabPageOne.pageJourneyId, firstTabPageTwo.pageJourneyId)
    assert.notEqual(firstTabPageOne.pageJourneyId, secondTab.pageJourneyId)
    assert.match(firstTabPageOne.pageJourneyId, /^pj_[A-Za-z0-9_-]{40}$/)

    await assert.rejects(
      authenticateTrackingPageView({
        eventName: 'native_site_view',
        req: requestFor(host, {}),
        data: {
          ...common,
          public_page_id: pagesA[1].id,
          page_context_token: firstContext.pageContextToken,
          page_tab_nonce: tabOneNonce,
          url: `https://${host}/${loadedA.slug}/oferta`
        }
      }),
      error => error instanceof NativePageTrackingAuthError &&
        error.code === 'native_site_context_mismatch'
    )
    await assert.rejects(
      authenticateTrackingPageView({
        eventName: 'native_site_view',
        req: requestFor(host, {}),
        data: {
          ...common,
          site_id: siteB,
          public_page_id: pagesB[0].id,
          page_context_token: firstContext.pageContextToken,
          page_tab_nonce: tabOneNonce,
          url: `https://${host}/${loadedB.slug}`
        }
      }),
      error => error instanceof NativePageTrackingAuthError &&
        error.code === 'native_site_context_mismatch'
    )
    await assert.rejects(
      authenticateTrackingPageView({
        eventName: 'native_site_view',
        req: requestFor(`other-${host}`, {}),
        data: {
          ...common,
          public_page_id: pagesA[0].id,
          page_context_token: firstContext.pageContextToken,
          page_tab_nonce: tabOneNonce,
          url: `https://other-${host}/${loadedA.slug}`
        }
      }),
      error => error instanceof NativePageTrackingAuthError &&
        error.code === 'native_site_host_mismatch'
    )

    const parts = firstContext.pageContextToken.split('.')
    parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith('A') ? 'B' : 'A'}`
    await assert.rejects(
      authenticateTrackingPageView({
        eventName: 'native_site_view',
        req: requestFor(host, {}),
        data: {
          ...common,
          public_page_id: pagesA[0].id,
          page_context_token: parts.join('.'),
          page_tab_nonce: tabOneNonce,
          url: `https://${host}/${loadedA.slug}`
        }
      }),
      error => error instanceof NativePageTrackingAuthError &&
        error.code === 'invalid_public_context_token'
    )

    const expired = await createNativePageTrackingContext({
      site: loadedA,
      pageId: pagesA[0].id,
      pageFlowRevision: firstContext.pageFlowRevision,
      host,
      nowMs: Date.now() - (2 * 60 * 60 * 1000)
    })
    await assert.rejects(
      authenticateTrackingPageView({
        eventName: 'native_site_view',
        req: requestFor(host, {}),
        data: {
          ...common,
          public_page_id: pagesA[0].id,
          page_context_token: expired.token,
          page_tab_nonce: tabOneNonce,
          url: `https://${host}/${loadedA.slug}`
        }
      }),
      error => error instanceof NativePageTrackingAuthError &&
        error.code === 'public_context_token_expired'
    )
  } finally {
    await cleanup({ siteIds: [siteA, siteB], domainId })
  }
})

test('/collect derives signed context, deduplicates replay, ignores native contact_id, and downgrades safe legacy/external traffic', async () => {
  const run = suffix('collect_auth')
  const host = `collect-${run}.example.test`
  const domainId = `domain_${run}`
  const siteA = `site_a_${run}`
  const siteB = `site_b_${run}`
  const contactId = `contact_${run}`
  const pagesA = [{ id: `page_a_${run}`, title: 'Entrada', sortOrder: 0 }]
  const pagesB = [{ id: `page_b_${run}`, title: 'Entrada B', sortOrder: 0 }]
  const sessionIds = [
    `signed_session_${run}`,
    `tampered_session_${run}`,
    `legacy_session_${run}`,
    `spoof_session_${run}`,
    `external_session_${run}`
  ]

  try {
    await seedSite({ id: siteA, slug: `embudo-a-${run}`, pages: pagesA, host, domainId })
    await seedSite({ id: siteB, slug: `embudo-b-${run}`, pages: pagesB, host, domainId })
    await db.run(`
      INSERT INTO contacts (id, full_name, source, created_at, updated_at)
      VALUES (?, 'Contacto que no debe vincularse', 'test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [contactId])
    const loaded = await getSite(siteA, {
      includeBlocks: false,
      includeSubmissions: false,
      includeTrackingStats: false
    })
    const context = extractTrackingContext(await renderPublicSiteHtml(loaded, {
      pageId: pagesA[0].id,
      trackingEnabled: true,
      publicHost: host
    }))
    const eventId = `event_${run}`
    const tabNonce = `signed_tab_nonce_${run}`
    const signedBody = {
      visitor_id: `signed_visitor_${run}`,
      session_id: sessionIds[0],
      contact_id: contactId,
      event_name: 'native_site_view',
      ts: Date.now(),
      data: {
        event_id: eventId,
        tracking_source: 'native_site',
        site_id: siteA,
        public_page_id: pagesA[0].id,
        page_flow_revision: context.pageFlowRevision,
        page_journey_id: `attacker_journey_${run}`,
        page_context_token: context.pageContextToken,
        page_tab_nonce: tabNonce,
        url: `https://${host}/${loaded.slug}`
      }
    }

    for (let index = 0; index < 2; index += 1) {
      const response = responseMock()
      await collectEvent(requestFor(host, signedBody), response)
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.payload, { ok: true })
    }

    const signedRows = await db.all(`
      SELECT
        tracking_source,
        site_id,
        public_page_id,
        page_flow_revision,
        page_journey_id,
        contact_id
      FROM sessions
      WHERE event_id = ?
    `, [eventId])
    assert.equal(signedRows.length, 1)
    assert.equal(signedRows[0].tracking_source, 'native_site')
    assert.equal(signedRows[0].site_id, siteA)
    assert.equal(signedRows[0].public_page_id, pagesA[0].id)
    assert.equal(signedRows[0].page_flow_revision, context.pageFlowRevision)
    assert.match(signedRows[0].page_journey_id, /^pj_/)
    assert.notEqual(signedRows[0].page_journey_id, `attacker_journey_${run}`)
    assert.equal(signedRows[0].contact_id, null)

    const tamperedParts = context.pageContextToken.split('.')
    tamperedParts[2] = `${tamperedParts[2].slice(0, -1)}${tamperedParts[2].endsWith('A') ? 'B' : 'A'}`
    const tamperedResponse = responseMock()
    await collectEvent(requestFor(host, {
      ...signedBody,
      session_id: sessionIds[1],
      data: {
        ...signedBody.data,
        event_id: `tampered_${run}`,
        page_context_token: tamperedParts.join('.')
      }
    }), tamperedResponse)
    assert.equal(tamperedResponse.statusCode, 400)
    assert.equal(tamperedResponse.payload.code, 'invalid_public_context_token')

    const legacyResponse = responseMock()
    await collectEvent(requestFor(host, {
      visitor_id: `legacy_visitor_${run}`,
      session_id: sessionIds[2],
      event_name: 'native_site_view',
      ts: Date.now(),
      data: {
        event_id: `legacy_${run}`,
        tracking_source: 'native_site',
        site_id: siteA,
        public_page_id: pagesA[0].id,
        page_flow_revision: 'attacker_revision',
        page_journey_id: 'attacker_journey',
        url: `https://${host}/${loaded.slug}`
      }
    }), legacyResponse)
    assert.equal(legacyResponse.statusCode, 200)
    const legacyRow = await db.get(`
      SELECT tracking_source, site_id, public_page_id, page_flow_revision, page_journey_id
      FROM sessions
      WHERE event_id = ?
    `, [`legacy_${run}`])
    assert.equal(legacyRow.tracking_source, 'native_site')
    assert.equal(legacyRow.site_id, siteA)
    assert.equal(legacyRow.public_page_id, pagesA[0].id)
    assert.equal(legacyRow.page_flow_revision, null)
    assert.equal(legacyRow.page_journey_id, null)

    const spoofResponse = responseMock()
    await collectEvent(requestFor(host, {
      visitor_id: `spoof_visitor_${run}`,
      session_id: sessionIds[3],
      event_name: 'native_site_view',
      ts: Date.now(),
      data: {
        event_id: `spoof_${run}`,
        tracking_source: 'native_site',
        site_id: siteB,
        public_page_id: pagesB[0].id,
        url: `https://${host}/${loaded.slug}`
      }
    }), spoofResponse)
    assert.equal(spoofResponse.statusCode, 200)
    const spoofRow = await db.get(`
      SELECT tracking_source, site_id, public_page_id, page_flow_revision, page_journey_id
      FROM sessions
      WHERE event_id = ?
    `, [`spoof_${run}`])
    assert.equal(spoofRow.tracking_source, 'external_pixel')
    assert.equal(spoofRow.site_id, null)
    assert.equal(spoofRow.public_page_id, null)
    assert.equal(spoofRow.page_flow_revision, null)
    assert.equal(spoofRow.page_journey_id, null)

    const externalResponse = responseMock()
    await collectEvent(requestFor('external.example.test', {
      visitor_id: `external_visitor_${run}`,
      session_id: sessionIds[4],
      event_name: 'page_view',
      ts: Date.now(),
      data: {
        event_id: `external_${run}`,
        tracking_source: 'external_pixel',
        site_id: siteB,
        public_page_id: pagesB[0].id,
        page_flow_revision: 'fake',
        page_journey_id: 'fake',
        url: 'https://external.example.test/landing'
      }
    }, { origin: 'https://external.example.test' }), externalResponse)
    assert.equal(externalResponse.statusCode, 200)
    const externalRow = await db.get(`
      SELECT tracking_source, site_id, public_page_id, page_flow_revision, page_journey_id
      FROM sessions
      WHERE event_id = ?
    `, [`external_${run}`])
    assert.equal(externalRow.tracking_source, 'external_pixel')
    assert.equal(externalRow.site_id, null)
    assert.equal(externalRow.public_page_id, null)
    assert.equal(externalRow.page_flow_revision, null)
    assert.equal(externalRow.page_journey_id, null)
  } finally {
    await cleanup({ siteIds: [siteA, siteB], domainId, sessionIds, contactId })
  }
})

test('native view rate limiter is bounded to native traffic and resets by window', () => {
  resetNativePageViewRateLimitForTests()
  const now = Date.now()
  let result = null
  for (let index = 0; index < 241; index += 1) {
    result = consumeNativePageViewRateLimit({
      ip: '127.0.0.9',
      siteId: 'rate-limited-site',
      nowMs: now
    })
  }
  assert.equal(result.allowed, false)
  assert.ok(result.retryAfterSeconds > 0)
  assert.equal(
    consumeNativePageViewRateLimit({
      ip: '127.0.0.9',
      siteId: 'rate-limited-site',
      nowMs: now + 61_000
    }).allowed,
    true
  )
  resetNativePageViewRateLimitForTests()
})

test('public context signing secret is redacted and immutable through app config endpoints', async () => {
  const internalKey = 'public_context_signing_secret_v1'
  const harmlessKey = suffix('public_context_config_guard')
  await signPublicContextClaims({
    purpose: 'public_context_config_guard_test',
    claims: { test: true }
  })

  const original = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    [internalKey]
  )
  assert.ok(original?.config_value)

  const readResponse = responseMock()
  await getConfig({ query: { keys: internalKey } }, readResponse)
  assert.equal(readResponse.statusCode, 200)
  assert.equal(readResponse.payload?.config?.[internalKey], null)

  const singleWriteResponse = responseMock()
  await saveConfig({
    body: { key: internalKey, value: 'attacker-controlled-value' }
  }, singleWriteResponse)
  assert.equal(singleWriteResponse.statusCode, 400)
  assert.equal(singleWriteResponse.payload?.code, 'RESERVED_INTERNAL_CONFIG')

  const bulkWriteResponse = responseMock()
  await saveConfig({
    body: {
      config: {
        [harmlessKey]: 'must-not-be-written',
        [internalKey]: 'attacker-controlled-value'
      }
    }
  }, bulkWriteResponse)
  assert.equal(bulkWriteResponse.statusCode, 400)
  assert.equal(bulkWriteResponse.payload?.code, 'RESERVED_INTERNAL_CONFIG')
  assert.equal(
    await db.get('SELECT 1 AS found FROM app_config WHERE config_key = ?', [harmlessKey]),
    null
  )

  const deleteResponse = responseMock()
  await deleteConfig({ query: { keys: internalKey } }, deleteResponse)
  assert.equal(deleteResponse.statusCode, 400)
  assert.equal(deleteResponse.payload?.code, 'RESERVED_INTERNAL_CONFIG')

  const after = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ? LIMIT 1',
    [internalKey]
  )
  assert.equal(after?.config_value, original.config_value)
})
