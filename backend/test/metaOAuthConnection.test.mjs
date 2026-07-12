import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { encrypt, initializeMasterKey, isEncrypted } from '../src/utils/encryption.js'
import { getMetaConfig, saveMetaConfig } from '../src/services/metaAdsService.js'
import { reconcileMetaBusinessWithHighLevel } from '../src/services/highlevelSyncService.js'
import {
  META_OAUTH_REQUIRED_SCOPES,
  completeMetaOAuthConnection,
  cleanupMetaOAuthPendingSessions,
  createMetaOAuthConnectionUrl,
  disconnectMetaOAuthConnection,
  finalizeMetaOAuthConnection,
  getMetaOAuthConnectionStatus,
  setMetaOAuthCentralClientForTest,
  setMetaOAuthFetchForTest,
  setMetaOAuthRuntimeClientForTest
} from '../src/services/metaOAuthService.js'
import { safeMetaGraphTransportError } from '../src/utils/metaGraphSecurity.js'

const TABLES = ['meta_config', 'meta_oauth_pending_sessions', 'meta_oauth_connection_backups']
const CONFIG_KEYS = [
  'meta_config_disconnected',
  'meta_messenger_messaging_enabled',
  'meta_instagram_messaging_enabled',
  'meta_facebook_comments_enabled',
  'meta_instagram_comments_enabled'
]

async function snapshotTable(table) {
  const rows = await db.all(`SELECT * FROM ${table}`).catch(() => [])
  return async () => {
    await db.run(`DELETE FROM ${table}`)
    for (const row of rows) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      )
    }
  }
}

async function withIsolatedMeta(callback) {
  const restorers = []
  for (const table of TABLES) restorers.push(await snapshotTable(table))
  const configRows = await db.all(
    `SELECT * FROM app_config WHERE config_key IN (${CONFIG_KEYS.map(() => '?').join(', ')})`,
    CONFIG_KEYS
  )
  try {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`)
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${CONFIG_KEYS.map(() => '?').join(', ')})`,
      CONFIG_KEYS
    )
    return await callback()
  } finally {
    setMetaOAuthFetchForTest()
    setMetaOAuthCentralClientForTest()
    setMetaOAuthRuntimeClientForTest()
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${CONFIG_KEYS.map(() => '?').join(', ')})`,
      CONFIG_KEYS
    )
    for (const row of configRows) await setAppConfig(row.config_key, row.config_value)
    for (const restore of restorers.reverse()) await restore()
  }
}

function graphResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

test('Meta OAuth usa handoff cifrado, preflights atómicos, aislamiento HighLevel y restaura manual', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    await db.run(`
      INSERT INTO meta_config (
        ad_account_id, access_token, connection_mode, app_id, app_secret,
        messenger_user_token, meta_business_id, pixel_id, page_id, instagram_account_id
      ) VALUES (?, ?, 'manual_system_user', ?, ?, ?, ?, ?, ?, ?)
    `, [
      'manual-ad', encrypt('manual-token'), 'manual-app', encrypt('manual-secret'),
      encrypt('manual-messenger-token'), 'manual-business', 'manual-pixel', 'manual-page', 'manual-ig'
    ])
    await setAppConfig('meta_config_disconnected', '0')
    await setAppConfig('meta_messenger_messaging_enabled', '0')

    let createUrlCalls = 0
    let failRegister = false
    let timeoutAfterCommit = false
    let disconnectCalls = 0
    let activeCentralConnection = null
    const subscriptionCalls = []
    const handoffMeta = {
      connection_id: 'connection-1',
      access_token: 'oauth-bisu-token',
      appsecret_proof: 'oauth-bisu-proof',
      source: 'oauth_bisu',
      app_id: 'oauth-app',
      config_id: 'flfb-config',
      user_id: 'isu-1',
      scopes: [...META_OAUTH_REQUIRED_SCOPES],
      granular_scopes: [{ scope: 'pages_messaging', target_ids: ['page-1'] }],
      assets: {
        business_id: 'business-1',
        pages: [{
          id: 'page-1', name: 'Página Uno', business_id: 'business-1',
          tasks: ['ANALYZE', 'MESSAGING', 'MODERATE'],
          page_access_token: 'oauth-page-token',
          page_appsecret_proof: 'oauth-page-proof',
          instagram_business_account: { id: 'ig-1', username: 'demo' }
        }],
        ad_accounts: [{ id: 'act_123', name: 'Ads', business_id: 'business-1' }],
        pixels: [{ id: 'pixel-1', name: 'Pixel', ad_account_id: 'act_123' }],
        instagram_accounts: [{ id: 'ig-1', page_id: 'page-1', username: 'demo' }]
      }
    }
    let handoffScopes = [...META_OAUTH_REQUIRED_SCOPES]
    let graphPageTasks = ['ANALYZE', 'MESSAGING', 'MODERATE']
    setMetaOAuthCentralClientForTest({
      getStatus: async () => ({
        configured: true, available: true, review_pending: false, mode: 'redirect',
        app_id: 'oauth-app', config_id: 'flfb-config', required_scopes: META_OAUTH_REQUIRED_SCOPES,
        connection: activeCentralConnection || { connected: false, connection_id: null, webhook_selections: [] }
      }),
      createConnectUrl: async ({ returnPath }) => {
        createUrlCalls += 1
        assert.equal(returnPath, '/settings/meta-ads/token')
        return { connectUrl: 'https://installer.test/meta/connect', mode: 'redirect' }
      },
      claimHandoff: async () => ({ payload: { meta: { ...handoffMeta, scopes: handoffScopes } } }),
      updateWebhookSubscription: async input => {
        subscriptionCalls.push(input)
        if (failRegister && input.action === 'register') throw new Error('relay unavailable')
        if (input.action === 'unregister') {
          activeCentralConnection = null
          return { registered: false }
        }
        activeCentralConnection = {
          connected: true,
          connection_id: input.connectionId,
          webhook_selections: [{
            page_id: input.pageId,
            instagram_account_id: input.instagramAccountId || null,
            callback_url: input.webhookUrl,
            active: true
          }]
        }
        if (timeoutAfterCommit) throw new Error('request to https://installer.test timed out')
        return { subscribed: input.action === 'register' }
      },
      disconnect: async () => { disconnectCalls += 1; activeCentralConnection = null; return { disconnected: true } }
    })

    let graphScopes = [...META_OAUTH_REQUIRED_SCOPES]
    const graphCalls = []
    setMetaOAuthFetchForTest(async urlValue => {
      const url = new URL(urlValue)
      graphCalls.push(url)
      assert.equal(url.searchParams.get('appsecret_proof'), 'oauth-bisu-proof')
      const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
      if (path === '/me' && url.searchParams.get('fields') === 'id,name') return graphResponse({ id: 'isu-1', name: 'Integration System User' })
      if (path === '/me/permissions') return graphResponse({ data: [
        ...graphScopes.map(permission => ({ permission, status: 'granted' })),
        { permission: 'optional_old_scope', status: 'declined' }
      ] })
      if (path === '/me/businesses') return graphResponse({ data: [{ id: 'business-1', name: 'Negocio' }] })
      if (path === '/me/adaccounts') return graphResponse({ data: [
        { id: 'act_123', name: 'Ads', timezone_name: 'America/Ciudad_Juarez', business: { id: 'business-1' } },
        { id: 'act_999', name: 'Ads no consentida', timezone_name: 'UTC', business: { id: 'business-1' } }
      ] })
      if (path === '/me/accounts') return graphResponse({ data: [{
        id: 'page-1', name: 'Página Uno', business: { id: 'business-1' },
        tasks: graphPageTasks,
        instagram_business_account: { id: 'ig-1', username: 'demo' }
      }, {
        id: 'page-live-extra', name: 'No consentida', tasks: graphPageTasks,
        instagram_business_account: { id: 'ig-live-extra', username: 'extra' }
      }] })
      if (path === '/act_123/adspixels') return graphResponse({ data: [{ id: 'pixel-1', name: 'Pixel' }] })
      return graphResponse({ error: { message: `unexpected ${path}` } }, 404)
    })

    const status = await getMetaOAuthConnectionStatus()
    assert.equal(status.reviewPending, false)
    assert.equal(status.configured, true)
    assert.equal(status.available, true)
    assert.equal(status.manualBackupAvailable, false)
    assert.equal(status.connectUrl, '')
    assert.equal(createUrlCalls, 0, 'leer status no debe crear state OAuth')
    assert.equal((await createMetaOAuthConnectionUrl()).connectUrl, 'https://installer.test/meta/connect')
    assert.equal(createUrlCalls, 1)

    graphScopes = META_OAUTH_REQUIRED_SCOPES.filter(scope => scope !== 'ads_read')
    handoffScopes = [...graphScopes]
    await assert.rejects(
      () => completeMetaOAuthConnection({ handoffToken: 'handoff-missing-scope' }),
      error => error.code === 'META_OAUTH_REQUIRED_SCOPES_MISSING'
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token')

    graphScopes = [...META_OAUTH_REQUIRED_SCOPES]
    handoffScopes = [...META_OAUTH_REQUIRED_SCOPES]

    handoffMeta.granular_scopes = [{ scope: 'pages_messaging', target_ids: ['otra-page'] }]
    const granularMismatch = await completeMetaOAuthConnection({ handoffToken: 'handoff-granular-mismatch' })
    await assert.rejects(
      () => finalizeMetaOAuthConnection({ sessionId: granularMismatch.sessionId, publicBaseUrl: 'https://tenant.test' }),
      error => error.code === 'META_OAUTH_GRANULAR_TARGET_MISMATCH'
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token')
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [granularMismatch.sessionId])

    handoffMeta.granular_scopes = [{ scope: 'pages_messaging', target_ids: ['page-1'] }]
    graphPageTasks = ['ANALYZE', 'MODERATE']
    const missingTasks = await completeMetaOAuthConnection({ handoffToken: 'handoff-missing-page-tasks' })
    await assert.rejects(
      () => finalizeMetaOAuthConnection({ sessionId: missingTasks.sessionId, publicBaseUrl: 'https://tenant.test' }),
      error => error.code === 'META_OAUTH_PAGE_TASKS_MISSING'
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token')
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [missingTasks.sessionId])
    graphPageTasks = ['ANALYZE', 'MESSAGING', 'MODERATE']

    const completed = await completeMetaOAuthConnection({ handoffToken: 'handoff-ok' })
    const serialized = JSON.stringify(completed)
    assert.equal(serialized.includes('oauth-bisu-token'), false)
    assert.equal(serialized.includes('oauth-page-token'), false)
    assert.equal(serialized.includes('proof'), false)
    assert.ok(completed.sessionId)
    assert.equal(completed.adAccounts.some(account => account.id === 'act_999'), false)
    assert.equal(completed.pages.some(page => page.id === 'page-live-extra'), false)
    assert.equal(completed.pages[0].instagramAccounts[0].id, 'ig-1')
    assert.equal((await getMetaConfig()).access_token, 'manual-token', 'complete no promueve todavía')
    const pendingRow = await db.get('SELECT payload_encrypted FROM meta_oauth_pending_sessions WHERE id = ?', [completed.sessionId])
    assert.equal(pendingRow.payload_encrypted.includes('oauth-bisu-token'), false)

    const runtimeInputs = []
    setMetaOAuthRuntimeClientForTest({
      ensurePageSubscription: async ({ config }) => {
        runtimeInputs.push(config)
        assert.equal(config.oauth_page_access_token, 'oauth-page-token')
        assert.equal(config.oauth_page_appsecret_proof, 'oauth-page-proof')
        return { pageId: 'page-1' }
      },
      removePageSubscription: async () => ({ unsubscribed: true }),
      syncCrons: async () => { throw new Error('cron test failure') },
      enableSocialChannels: async () => ({ messengerMessaging: true }),
      startSocialHistory: () => ({ syncStarted: true, started: ['messenger', 'instagram'], skipped: [] }),
      updateRecentAds: async () => ({ success: true })
    })

    failRegister = true
    await assert.rejects(
      () => finalizeMetaOAuthConnection({ sessionId: completed.sessionId, publicBaseUrl: 'https://tenant.test' }),
      /relay unavailable/
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token', 'preflight fallido conserva manual')
    assert.equal((await db.get('SELECT status FROM meta_oauth_pending_sessions WHERE id = ?', [completed.sessionId])).status, 'pending')

    failRegister = false
    const finalized = await finalizeMetaOAuthConnection({ sessionId: completed.sessionId, publicBaseUrl: 'https://tenant.test' })
    assert.equal(finalized.connected, true)
    assert.equal(finalized.connectionMode, 'oauth_bisu')
    assert.match(finalized.runtimeWarnings.join(' '), /cron test failure/)
    assert.equal(subscriptionCalls.at(-1).webhookUrl, 'https://tenant.test/webhooks/meta/installer-relay')
    assert.equal(subscriptionCalls.at(-1).connectionId, 'connection-1')
    const oauth = await getMetaConfig()
    assert.equal(oauth.connection_mode, 'oauth_bisu')
    assert.equal(oauth.access_token, 'oauth-bisu-token')
    assert.equal(oauth.oauth_appsecret_proof, 'oauth-bisu-proof')
    assert.equal(oauth.oauth_page_access_token, 'oauth-page-token')
    assert.equal(oauth.oauth_page_appsecret_proof, 'oauth-page-proof')
    assert.equal(oauth.messenger_user_token, null)
    const rawOauth = await db.get('SELECT * FROM meta_config LIMIT 1')
    assert.equal(isEncrypted(rawOauth.access_token), true)
    assert.equal(isEncrypted(rawOauth.oauth_page_access_token), true)
    assert.equal(isEncrypted(rawOauth.oauth_page_appsecret_proof), true)

    const reconciliation = await reconcileMetaBusinessWithHighLevel('unused-location', 'unused-token')
    assert.equal(reconciliation.action, 'oauth_isolated')
    await assert.rejects(
      () => saveMetaConfig('stale-ad', 'stale-manual-token', null, 'stale-page', null, {
        timezoneData: { timezone_name: 'UTC', timezone_id: null, timezone_offset_hours_utc: 0 }
      }),
      error => error.code === 'META_OAUTH_MANUAL_REPLACEMENT_REQUIRES_DISCONNECT'
    )
    assert.equal((await getMetaConfig()).connection_mode, 'oauth_bisu')
    assert.equal((await getMetaOAuthConnectionStatus()).manualBackupAvailable, true)
    await assert.rejects(
      () => finalizeMetaOAuthConnection({ sessionId: completed.sessionId, publicBaseUrl: 'https://tenant.test' }),
      error => ['META_OAUTH_SESSION_UNAVAILABLE', 'META_OAUTH_SESSION_ALREADY_USED'].includes(error.code)
    )

    const disconnected = await disconnectMetaOAuthConnection()
    assert.equal(disconnected.disconnected, true)
    assert.equal(disconnected.restoredManual, true)
    assert.equal(disconnectCalls, 1)
    const restored = await getMetaConfig()
    assert.equal(restored.connection_mode, 'manual_system_user')
    assert.equal(restored.access_token, 'manual-token')
    assert.equal(restored.app_id, 'manual-app')
    assert.equal(restored.messenger_user_token, 'manual-messenger-token')
    assert.equal(await getAppConfig('meta_messenger_messaging_enabled'), '0')
    assert.ok(graphCalls.length >= 6)

    handoffMeta.connection_id = 'connection-2'
    timeoutAfterCommit = true
    const timeoutSession = await completeMetaOAuthConnection({ handoffToken: 'handoff-timeout-after-commit' })
    const reconciled = await finalizeMetaOAuthConnection({
      sessionId: timeoutSession.sessionId,
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(reconciled.connected, true)
    assert.equal((await getMetaConfig()).oauth_connection_id, 'connection-2')
    timeoutAfterCommit = false
    await disconnectMetaOAuthConnection()
    assert.equal(disconnectCalls, 2)
    assert.equal(safeMetaGraphTransportError(
      new Error('request to https://graph.facebook.com/me?access_token=secret&appsecret_proof=proof failed')
    ), 'No se pudo contactar Meta Graph.')
  })
})

test('cleanup OAuth compensa subscribed_apps abandonado antes de purgar el secreto', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    let pageCleanupCalls = 0
    let relayCleanupCalls = 0
    setMetaOAuthRuntimeClientForTest({
      removePageSubscription: async ({ config }) => {
        pageCleanupCalls += 1
        assert.equal(config.oauth_page_access_token, 'page-token')
        assert.equal(config.oauth_page_appsecret_proof, 'page-proof')
      }
    })
    setMetaOAuthCentralClientForTest({
      updateWebhookSubscription: async input => {
        assert.equal(input.action, 'unregister')
        relayCleanupCalls += 1
        return { registered: false }
      }
    })
    const payload = {
      connectionId: 'abandoned-connection',
      accessToken: 'bisu-token',
      appSecretProof: 'bisu-proof',
      pageSecrets: { 'page-abandoned': { pageAccessToken: 'page-token', pageAppSecretProof: 'page-proof' } },
      saga: {
        stage: 'subscribed',
        selection: { pageId: 'page-abandoned', instagramAccountId: '' },
        webhookUrl: 'https://tenant.test/webhooks/meta/installer-relay',
        cleanupDeadline: new Date(Date.now() + 60_000).toISOString()
      }
    }
    await db.run(
      `INSERT INTO meta_oauth_pending_sessions (id, payload_encrypted, status, expires_at, updated_at)
       VALUES ('abandoned', ?, 'consuming', ?, ?)`,
      [
        encrypt(JSON.stringify(payload)),
        new Date(Date.now() - 60_000).toISOString().replace('T', ' ').replace('Z', ''),
        new Date(Date.now() - 3 * 60_000).toISOString().replace('T', ' ').replace('Z', '')
      ]
    )
    await cleanupMetaOAuthPendingSessions()
    assert.equal(pageCleanupCalls, 1)
    assert.equal(relayCleanupCalls, 1)
    assert.equal(await db.get("SELECT id FROM meta_oauth_pending_sessions WHERE id = 'abandoned'"), null)
  })
})

test('cleanup OAuth completa efectos idempotentes si el commit central ambiguo sí fue promovido', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    const connectionId = 'reconciled-connection'
    const webhookUrl = 'https://tenant.test/webhooks/meta/installer-relay'
    await db.run(
      `INSERT INTO meta_config (
        ad_account_id, access_token, connection_mode, page_id, instagram_account_id,
        oauth_connection_id, oauth_page_access_token, oauth_page_appsecret_proof,
        oauth_connected, oauth_validated, oauth_relay_status
      ) VALUES ('123', ?, 'oauth_bisu', 'page-1', 'ig-1', ?, ?, ?, 1, 1, 'pending')`,
      [encrypt('bisu-token'), connectionId, encrypt('page-token'), encrypt('page-proof')]
    )
    const payload = {
      connectionId,
      saga: {
        stage: 'central_unknown',
        selection: { adAccountId: '123', pageId: 'page-1', instagramAccountId: 'ig-1' },
        webhookUrl,
        cleanupDeadline: new Date(Date.now() + 60_000).toISOString()
      }
    }
    await db.run(
      `INSERT INTO meta_oauth_pending_sessions (id, payload_encrypted, status, expires_at)
       VALUES ('central-unknown', ?, 'cleanup_pending', ?)`,
      [
        encrypt(JSON.stringify(payload)),
        new Date(Date.now() + 60_000).toISOString().replace('T', ' ').replace('Z', '')
      ]
    )

    const effects = { crons: 0, channels: 0, history: 0, ads: 0 }
    setMetaOAuthCentralClientForTest({
      getStatus: async () => ({
        connection: {
          connected: true,
          connection_id: connectionId,
          webhook_selections: [{
            page_id: 'page-1', instagram_account_id: 'ig-1', callback_url: webhookUrl, active: true
          }]
        }
      })
    })
    setMetaOAuthRuntimeClientForTest({
      syncCrons: async () => { effects.crons += 1 },
      enableSocialChannels: async () => { effects.channels += 1; return { messengerMessaging: true } },
      startSocialHistory: () => { effects.history += 1; return { syncStarted: true, started: ['messenger', 'instagram'], skipped: [] } },
      updateRecentAds: async () => { effects.ads += 1; return { success: true } }
    })

    await cleanupMetaOAuthPendingSessions()
    assert.deepEqual(effects, { crons: 1, channels: 1, history: 1, ads: 1 })
    assert.equal(await db.get("SELECT id FROM meta_oauth_pending_sessions WHERE id = 'central-unknown'"), null)
    assert.equal((await db.get('SELECT oauth_relay_status FROM meta_config LIMIT 1')).oauth_relay_status, 'registered')
  })
})
