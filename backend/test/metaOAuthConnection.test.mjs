import test from 'node:test'
import assert from 'node:assert/strict'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { API_URLS } from '../src/config/constants.js'
import { decrypt, encrypt, initializeMasterKey, isEncrypted } from '../src/utils/encryption.js'
import { getMetaConfig, getMetaSocialConfig, saveMetaConfig } from '../src/services/metaAdsService.js'
import { reconcileMetaBusinessWithHighLevel } from '../src/services/highlevelSyncService.js'
import {
  META_OAUTH_REQUIRED_SCOPES,
  completeMetaOAuthConnection,
  prepareMetaOAuthConnection,
  cleanupMetaOAuthPendingSessions,
  createMetaOAuthConnectionUrl,
  disconnectMetaOAuthConnection,
  finalizeMetaOAuthConnection,
  getMetaOAuthConnectionStatus,
  prepareMetaOAuthReconfiguration,
  setMetaOAuthCentralClientForTest,
  setMetaOAuthFetchForTest,
  setMetaOAuthMarkLocalRelayForTest,
  setMetaOAuthRuntimeClientForTest
} from '../src/services/metaOAuthService.js'
import { safeMetaGraphTransportError } from '../src/utils/metaGraphSecurity.js'
import {
  extractMetaAccessToken,
  getMetaCustomValues,
  verifyToken as verifyMetaTokenController
} from '../src/controllers/metaController.js'

const TABLES = [
  'meta_config',
  'meta_oauth_pending_sessions',
  'meta_oauth_connection_backups',
  'meta_oauth_authorized_assets',
  'meta_oauth_integrations',
  'meta_oauth_integration_sessions'
]
const CONFIG_KEYS = [
  'meta_config_disconnected',
  'meta_messenger_messaging_enabled',
  'meta_instagram_messaging_enabled',
  'meta_facebook_comments_enabled',
  'meta_instagram_comments_enabled',
  'meta_whatsapp_schedule_enabled',
  'meta_whatsapp_purchase_enabled',
  'meta_payment_purchase_event_config'
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
    setMetaOAuthMarkLocalRelayForTest()
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
        pixels: [{ id: 'pixel-1', name: 'Pixel', business_id: 'business-1' }],
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
          available: handoffMeta.assets,
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
    let datasetTasks = ['UPLOAD']
    let failBusinessesEdge = false
    const graphCalls = []
    setMetaOAuthFetchForTest(async urlValue => {
      const url = new URL(urlValue)
      graphCalls.push(url)
      assert.equal(url.searchParams.get('appsecret_proof'), 'oauth-bisu-proof')
      const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
      if (path === '/isu-1' && url.searchParams.get('fields') === 'id,name') return graphResponse({ id: 'isu-1', name: 'Integration System User' })
      if (path === '/me/permissions') return graphResponse({ data: [
        ...graphScopes.map(permission => ({ permission, status: 'granted' })),
        { permission: 'optional_old_scope', status: 'declined' }
      ] })
      if (path === '/me/businesses') {
        return failBusinessesEdge
          ? graphResponse({ error: { message: 'business edge unavailable' } }, 500)
          : graphResponse({ data: [{ id: 'business-1', name: 'Negocio' }] })
      }
      if (path === '/me/adaccounts') return graphResponse({ data: [
        { id: 'act_123', name: 'Ads', timezone_name: 'America/Ciudad_Juarez', business: { id: 'business-1' } },
        { id: 'act_999', name: 'Ads no consentida', timezone_name: 'UTC', business: { id: 'business-1' } }
      ] })
      if (path === '/isu-1/assigned_ad_accounts') return graphResponse({ data: [
        { id: 'act_123', name: 'Ads', timezone_name: 'America/Ciudad_Juarez', business: { id: 'business-1' } }
      ] })
      if (path === '/me/accounts') return graphResponse({ data: [{
        id: 'page-1', name: 'Página Uno', business: { id: 'business-1' },
        tasks: graphPageTasks,
        instagram_business_account: { id: 'ig-1', username: 'demo' }
      }, {
        id: 'page-live-extra', name: 'No consentida', tasks: graphPageTasks,
        instagram_business_account: { id: 'ig-live-extra', username: 'extra' }
      }] })
      if (path === '/isu-1/assigned_pages') return graphResponse({ data: [{
        id: 'page-1', name: 'Página Uno', business: { id: 'business-1' },
        tasks: graphPageTasks,
        instagram_business_account: { id: 'ig-1', username: 'demo' }
      }] })
      if (path === '/business-1/owned_pixels') return graphResponse({ data: [{ id: 'pixel-1', name: 'Pixel' }] })
      if (path === '/business-1/client_pixels') return graphResponse({ data: [] })
      if (path === '/act_123/adspixels') return graphResponse({ data: [] })
      if (path === '/pixel-1') return graphResponse({ id: 'pixel-1', name: 'Pixel' })
      if (path === '/pixel-1/assigned_users') return graphResponse({
        data: [{ id: 'isu-1', name: 'Integration System User', permitted_tasks: datasetTasks }]
      })
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
      () => prepareMetaOAuthConnection({ handoffToken: 'handoff-missing-scope' }),
      error => error.code === 'META_OAUTH_REQUIRED_SCOPES_MISSING'
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token')

    graphScopes = [...META_OAUTH_REQUIRED_SCOPES]
    handoffScopes = [...META_OAUTH_REQUIRED_SCOPES]

    handoffMeta.granular_scopes = [{ scope: 'pages_messaging', target_ids: ['otra-page'] }]
    const granularMismatch = await prepareMetaOAuthConnection({ handoffToken: 'handoff-granular-mismatch' })
    await assert.rejects(
      () => finalizeMetaOAuthConnection({ sessionId: granularMismatch.sessionId, publicBaseUrl: 'https://tenant.test' }),
      error => error.code === 'META_OAUTH_GRANULAR_TARGET_MISMATCH'
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token')
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [granularMismatch.sessionId])

    handoffMeta.granular_scopes = [{ scope: 'pages_messaging', target_ids: ['page-1'] }]
    handoffMeta.assets.pages[0].tasks = ['ANALYZE', 'MODERATE']
    const missingTasks = await prepareMetaOAuthConnection({ handoffToken: 'handoff-missing-page-tasks' })
    await assert.rejects(
      () => finalizeMetaOAuthConnection({
        sessionId: missingTasks.sessionId,
        pageId: 'page-1',
        publicBaseUrl: 'https://tenant.test'
      }),
      error => error.code === 'META_OAUTH_PAGE_TASKS_MISSING'
    )
    assert.equal((await getMetaConfig()).access_token, 'manual-token')
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [missingTasks.sessionId])
    handoffMeta.assets.pages[0].tasks = ['ANALYZE', 'MESSAGING', 'MODERATE']

    const completed = await prepareMetaOAuthConnection({ handoffToken: 'handoff-ok' })
    const serialized = JSON.stringify(completed)
    assert.equal(serialized.includes('oauth-bisu-token'), false)
    assert.equal(serialized.includes('oauth-page-token'), false)
    assert.equal(serialized.includes('proof'), false)
    assert.ok(completed.sessionId)
    assert.equal(completed.adAccounts.some(account => account.id === 'act_999'), false)
    assert.deepEqual(completed.adAccounts[0].pixels, [{ id: 'pixel-1', name: 'Pixel', businessId: 'business-1' }])
    assert.equal(completed.pages.some(page => page.id === 'page-live-extra'), false)
    assert.equal(completed.pages[0].instagramAccounts[0].id, 'ig-1')
    assert.equal(graphCalls.some(url => ['/me', '/me/accounts', '/me/adaccounts', '/me/permissions'].includes(url.pathname.replace(/^\/v\d+\.\d+/, ''))), false)
    assert.equal((await getMetaConfig()).access_token, 'manual-token', 'complete no promueve todavía')
    const pendingRow = await db.get('SELECT payload_encrypted FROM meta_oauth_pending_sessions WHERE id = ?', [completed.sessionId])
    assert.equal(pendingRow.payload_encrypted.includes('oauth-bisu-token'), false)

    datasetTasks = []
    await assert.rejects(
      () => finalizeMetaOAuthConnection({
        sessionId: completed.sessionId,
        pixelId: 'pixel-1',
        publicBaseUrl: 'https://tenant.test'
      }),
      error => error.code === 'META_OAUTH_DATASET_UPLOAD_ACCESS_REQUIRED'
    )
    assert.equal((await db.get('SELECT status FROM meta_oauth_pending_sessions WHERE id = ?', [completed.sessionId])).status, 'pending')
    assert.equal((await getMetaConfig()).access_token, 'manual-token')
    datasetTasks = ['UPLOAD']

    const runtimeInputs = []
    let removedRuntimeSubscriptions = 0
    setMetaOAuthRuntimeClientForTest({
      ensurePageSubscription: async ({ config }) => {
        runtimeInputs.push(config)
        assert.equal(config.oauth_page_access_token, 'oauth-page-token')
        assert.equal(config.oauth_page_appsecret_proof, 'oauth-page-proof')
        return { pageId: 'page-1' }
      },
      removePageSubscription: async () => {
        removedRuntimeSubscriptions += 1
        return { unsubscribed: true }
      },
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
    const finalized = await finalizeMetaOAuthConnection({
      sessionId: completed.sessionId,
      pixelId: 'pixel-1',
      publicBaseUrl: 'https://tenant.test'
    })
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
    assert.equal(oauth.pixel_id, 'pixel-1')
    assert.equal(await getAppConfig('meta_whatsapp_schedule_enabled'), '1')
    assert.equal(await getAppConfig('meta_whatsapp_purchase_enabled'), '1')
    const rawOauth = await db.get('SELECT * FROM meta_config LIMIT 1')
    assert.equal(isEncrypted(rawOauth.access_token), true)
    assert.equal(isEncrypted(rawOauth.oauth_page_access_token), true)
    assert.equal(isEncrypted(rawOauth.oauth_page_appsecret_proof), true)
    const authorizedVault = await db.get(
      'SELECT connection_id, payload_encrypted FROM meta_oauth_authorized_assets WHERE id = ?',
      ['unified']
    )
    assert.equal(authorizedVault.connection_id, 'connection-1')
    assert.equal(isEncrypted(authorizedVault.payload_encrypted), true)
    assert.equal(authorizedVault.payload_encrypted.includes('oauth-page-token'), false)

    const internalSelection = await prepareMetaOAuthReconfiguration()
    assert.equal(internalSelection.defaults.adAccountId, '123')
    assert.equal(internalSelection.defaults.pageId, 'page-1')
    assert.equal(internalSelection.defaults.pixelId, 'pixel-1')
    assert.deepEqual(internalSelection.adAccounts.map(account => account.id), ['act_123'])
    assert.deepEqual(internalSelection.pages.map(page => page.id), ['page-1'])
    assert.equal(JSON.stringify(internalSelection).includes('oauth-page-token'), false)
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [internalSelection.sessionId])

    // Reautorizar la misma Page no puede ejecutar DELETE subscribed_apps. Ese
    // DELETE es global para la app/Page y rompería tanto la conexión anterior
    // durante rollback como la conexión recién promovida al terminar.
    handoffMeta.connection_id = 'connection-same-page'
    failBusinessesEdge = true
    const samePageReconnect = await prepareMetaOAuthConnection({ handoffToken: 'handoff-same-page' })
    assert.equal(samePageReconnect.businesses[0]?.id, 'business-1')
    const removalsBeforeSamePageReconnect = removedRuntimeSubscriptions
    failRegister = true
    await assert.rejects(
      () => finalizeMetaOAuthConnection({
        sessionId: samePageReconnect.sessionId,
        pixelId: 'pixel-1',
        publicBaseUrl: 'https://tenant.test'
      }),
      /relay unavailable/
    )
    assert.equal(removedRuntimeSubscriptions, removalsBeforeSamePageReconnect)
    assert.equal((await getMetaConfig()).oauth_connection_id, 'connection-1')

    failRegister = false
    const samePageFinalized = await finalizeMetaOAuthConnection({
      sessionId: samePageReconnect.sessionId,
      pixelId: 'pixel-1',
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(samePageFinalized.connected, true)
    assert.equal(removedRuntimeSubscriptions, removalsBeforeSamePageReconnect)
    assert.equal((await getMetaConfig()).oauth_connection_id, 'connection-same-page')
    failBusinessesEdge = false

    handoffMeta.connection_id = 'connection-without-dataset'
    const withoutDatasetReconnect = await prepareMetaOAuthConnection({ handoffToken: 'handoff-without-dataset' })
    const withoutDatasetFinalized = await finalizeMetaOAuthConnection({
      sessionId: withoutDatasetReconnect.sessionId,
      pixelId: '',
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(withoutDatasetFinalized.connected, true)
    assert.equal((await getMetaConfig()).pixel_id, null)
    assert.equal(await getAppConfig('meta_whatsapp_schedule_enabled'), '0')
    assert.equal(await getAppConfig('meta_whatsapp_purchase_enabled'), '0')
    assert.equal(JSON.parse(await getAppConfig('meta_payment_purchase_event_config')).enabled, false)

    handoffMeta.connection_id = 'connection-social-only'
    const socialOnlyReconnect = await prepareMetaOAuthConnection({ handoffToken: 'handoff-social-only' })
    const socialOnlyFinalized = await finalizeMetaOAuthConnection({
      sessionId: socialOnlyReconnect.sessionId,
      adAccountId: '',
      pixelId: '',
      pageId: 'page-1',
      instagramAccountId: 'ig-1',
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(socialOnlyFinalized.connected, true)
    assert.equal(socialOnlyFinalized.adsSync.syncStarted, false)
    assert.equal((await getMetaConfig()).ad_account_id, null)
    assert.equal((await getMetaConfig()).page_id, 'page-1')

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

    handoffMeta.connection_id = 'connection-auto'
    const automatic = await completeMetaOAuthConnection({
      handoffToken: 'handoff-auto',
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(automatic.connected, true)
    assert.equal(automatic.selected.pageId, 'page-1')
    assert.equal(automatic.selected.adAccountId, '123')
    assert.equal(automatic.selected.pixelId, '')
    const automaticStatus = await getMetaOAuthConnectionStatus()
    assert.deepEqual(automaticStatus.selectedAssets.page, { id: 'page-1', name: 'Página Uno' })
    assert.deepEqual(automaticStatus.selectedAssets.adAccount, { id: '123', name: 'Ads' })
    await db.run('DELETE FROM meta_oauth_authorized_assets')
    const legacyNameFallback = await getMetaOAuthConnectionStatus()
    assert.deepEqual(legacyNameFallback.selectedAssets.page, { id: 'page-1', name: 'Página Uno' })
    assert.deepEqual(legacyNameFallback.selectedAssets.adAccount, { id: '123', name: 'Ads' })
    await disconnectMetaOAuthConnection()

    handoffMeta.connection_id = 'connection-2'
    timeoutAfterCommit = true
    const timeoutSession = await prepareMetaOAuthConnection({ handoffToken: 'handoff-timeout-after-commit' })
    const reconciled = await finalizeMetaOAuthConnection({
      sessionId: timeoutSession.sessionId,
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(reconciled.connected, true)
    const withoutDataset = await getMetaConfig()
    assert.equal(withoutDataset.oauth_connection_id, 'connection-2')
    assert.equal(withoutDataset.pixel_id, null)
    assert.equal(await getAppConfig('meta_whatsapp_schedule_enabled'), '0')
    assert.equal(await getAppConfig('meta_whatsapp_purchase_enabled'), '0')
    assert.equal(JSON.parse(await getAppConfig('meta_payment_purchase_event_config')).enabled, false)
    timeoutAfterCommit = false
    await disconnectMetaOAuthConnection()
    assert.equal(disconnectCalls, 3)
    assert.equal(safeMetaGraphTransportError(
      new Error('request to https://graph.facebook.com/me?access_token=secret&appsecret_proof=proof failed')
    ), 'No se pudo contactar Meta Graph.')
  })
})

test('Meta OAuth maestro reconoce USER aunque Installer conserve source oauth_bisu', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    const graphCalls = []
    const handoffMeta = {
      connection_id: 'user-connection',
      access_token: 'long-lived-user-token',
      appsecret_proof: 'user-token-proof',
      source: 'oauth_bisu',
      debug_token_type: 'USER',
      app_id: 'oauth-app',
      config_id: 'flfb-user-config',
      user_id: 'meta-user-1',
      expires_at: Math.floor(Date.now() / 1000) + 50 * 24 * 60 * 60,
      scopes: [...META_OAUTH_REQUIRED_SCOPES],
      granular_scopes: [{ scope: 'pages_messaging', target_ids: ['page-user'] }],
      assets: {
        // El client_business_id identifica el negocio dueño de la configuración
        // FLFB; no necesariamente es el dueño de cada activo que el usuario
        // autorizó en el mismo modal.
        business_id: 'business-app-owner',
        pages: [{
          id: 'page-user',
          name: 'Página User Token',
          business_id: 'business-social',
          tasks: ['ANALYZE', 'MESSAGING', 'MODERATE'],
          page_access_token: 'page-user-token',
          page_appsecret_proof: 'page-user-proof',
          instagram_business_account: { id: 'ig-user', username: 'user_demo' }
        }],
        ad_accounts: [{ id: '777', name: 'Ads User', business_id: 'business-ads' }],
        pixels: [{ id: 'pixel-user', name: 'Dataset User', business_id: 'business-dataset' }],
        instagram_accounts: [{ id: 'ig-user', page_id: 'page-user', username: 'user_demo' }]
      }
    }

    let centralConnected = false
    setMetaOAuthCentralClientForTest({
      getStatus: async () => ({
        configured: true,
        available: true,
        source: 'oauth_bisu',
        connection: { connected: centralConnected, connection_id: centralConnected ? 'user-connection' : null }
      }),
      claimHandoff: async () => ({ payload: { meta: handoffMeta } }),
      updateWebhookSubscription: async input => {
        centralConnected = input.action === 'register'
        return { registered: centralConnected }
      },
      disconnect: async () => {
        centralConnected = false
        return { disconnected: true }
      }
    })
    setMetaOAuthRuntimeClientForTest({
      ensurePageSubscription: async ({ config }) => {
        assert.equal(config.connection_mode, 'oauth_user')
        assert.equal(config.oauth_page_access_token, 'page-user-token')
        return { subscribed: true }
      },
      removePageSubscription: async () => ({ unsubscribed: true }),
      syncCrons: async () => undefined,
      enableSocialChannels: async () => ({ messengerMessaging: true }),
      startSocialHistory: () => ({ syncStarted: true, started: ['messenger', 'instagram'], skipped: [] }),
      updateRecentAds: async () => ({ success: true })
    })
    setMetaOAuthFetchForTest(async urlValue => {
      const url = new URL(urlValue)
      const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
      graphCalls.push(path)
      assert.equal(url.searchParams.get('appsecret_proof'), 'user-token-proof')
      if (path === '/me') return graphResponse({ id: 'meta-user-1', name: 'Administrador Meta' })
      if (path === '/me/permissions') return graphResponse({
        data: META_OAUTH_REQUIRED_SCOPES.map(permission => ({ permission, status: 'granted' }))
      })
      if (path === '/me/businesses') return graphResponse({ data: [{ id: 'business-user', name: 'Negocio User' }] })
      if (path === '/me/adaccounts') return graphResponse({ data: [{
        id: 'act_777', name: 'Ads User', timezone_name: 'America/Ciudad_Juarez', business: { id: 'business-user' }
      }] })
      if (path === '/me/accounts') return graphResponse({ data: [{
        id: 'page-user',
        name: 'Página User Token',
        business: { id: 'business-user' },
        tasks: ['ANALYZE', 'MESSAGING', 'MODERATE'],
        instagram_business_account: { id: 'ig-user', username: 'user_demo' }
      }] })
      if (path === '/business-user/owned_pixels') return graphResponse({ data: [{ id: 'pixel-user', name: 'Dataset User' }] })
      if (path === '/business-user/client_pixels') return graphResponse({ data: [] })
      if (path === '/act_777/adspixels') return graphResponse({ data: [{ id: 'pixel-user', name: 'Dataset User' }] })
      if (path === '/pixel-user') return graphResponse({ id: 'pixel-user', name: 'Dataset User' })
      return graphResponse({ error: { message: `unexpected ${path}` } }, 404)
    })

    const completed = await prepareMetaOAuthConnection({ handoffToken: 'user-handoff' })
    assert.equal(completed.connectionMode, 'oauth_user')
    assert.deepEqual(completed.businesses.map(item => item.id).sort(), [
      'business-ads',
      'business-app-owner',
      'business-dataset',
      'business-social'
    ])
    assert.deepEqual(completed.datasets, [{
      id: 'pixel-user',
      name: 'Dataset User',
      businessId: 'business-dataset'
    }])
    assert.equal(graphCalls.includes('/me'), false)
    assert.equal(graphCalls.includes('/me/accounts'), false)
    assert.equal(graphCalls.includes('/me/adaccounts'), false)
    assert.equal(graphCalls.some(path => path.includes('/assigned_pages')), false)
    assert.equal(graphCalls.some(path => path.includes('/assigned_ad_accounts')), false)

    const finalized = await finalizeMetaOAuthConnection({
      sessionId: completed.sessionId,
      pageId: 'page-user',
      instagramAccountId: 'ig-user',
      adAccountId: '777',
      pixelId: 'pixel-user',
      publicBaseUrl: 'https://tenant-user.onrender.com'
    })
    assert.equal(finalized.connectionMode, 'oauth_user')
    assert.equal(finalized.connected, true)
    const config = await getMetaConfig()
    assert.equal(config.connection_mode, 'oauth_user')
    assert.equal(config.access_token, 'long-lived-user-token')
    assert.equal(config.oauth_page_access_token, 'page-user-token')
    assert.equal(config.pixel_id, 'pixel-user')
    assert.equal(config.oauth_business_id, 'business-dataset')
    assert.equal(graphCalls.some(path => path.includes('/assigned_users')), false)

    const status = await getMetaOAuthConnectionStatus()
    assert.equal(status.connectionMode, 'oauth_user')
    assert.equal(status.oauth.connected, true)
    assert.ok(status.oauth.tokenExpiresAt)

    const reconfiguration = await prepareMetaOAuthReconfiguration()
    assert.equal(reconfiguration.connectionMode, 'oauth_user')
    assert.equal(reconfiguration.pages[0].id, 'page-user')
    await db.run('DELETE FROM meta_oauth_pending_sessions WHERE id = ?', [reconfiguration.sessionId])

    const disconnected = await disconnectMetaOAuthConnection({ publicBaseUrl: 'https://tenant-user.onrender.com' })
    assert.equal(disconnected.disconnected, true)
  })
})

test('Meta OAuth USER guarda el handoff verificado aunque Graph esté limitado', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    const handoffMeta = {
      connection_id: 'rate-limited-connection',
      access_token: 'rate-limited-user-token',
      appsecret_proof: 'rate-limited-proof',
      source: 'oauth_user',
      debug_token_type: 'USER',
      app_id: 'oauth-app',
      config_id: 'flfb-user-config',
      user_id: 'meta-user-rate-limited',
      scopes: [...META_OAUTH_REQUIRED_SCOPES],
      granular_scopes: [{ scope: 'pages_messaging', target_ids: ['page-rate-limited'] }],
      assets: {
        business_id: 'business-rate-limited',
        pages: [{
          id: 'page-rate-limited',
          name: 'Página verificada por Installer',
          business_id: 'business-rate-limited',
          tasks: ['ANALYZE', 'MESSAGING', 'MODERATE'],
          page_access_token: 'page-rate-limited-token',
          page_appsecret_proof: 'page-rate-limited-proof',
          instagram_business_account: { id: 'ig-rate-limited', username: 'ig_verificada' }
        }],
        ad_accounts: [{ id: 'act_404', name: 'Ads verificada', business_id: 'business-rate-limited' }],
        pixels: [{
          id: 'pixel-rate-limited',
          name: 'Dataset verificado',
          ad_account_id: '404',
          business_id: 'business-rate-limited'
        }]
      }
    }
    setMetaOAuthCentralClientForTest({
      claimHandoff: async () => ({ payload: { meta: handoffMeta } })
    })
    let graphCalls = 0
    setMetaOAuthFetchForTest(async () => {
      graphCalls += 1
      return graphResponse({
        error: { message: '(#4) Application request limit reached', code: 4, is_transient: true }
      }, 403)
    })

    const completed = await prepareMetaOAuthConnection({ handoffToken: 'rate-limited-handoff' })

    assert.equal(graphCalls, 0, 'el cliente no debe volver a validar el handoff contra Graph')
    assert.equal(completed.connectionMode, 'oauth_user')
    assert.equal(completed.pages[0].id, 'page-rate-limited')
    assert.equal(completed.pages[0].instagramAccounts[0].id, 'ig-rate-limited')
    assert.equal(completed.adAccounts[0].id, 'act_404')
    assert.equal(completed.adAccounts[0].pixels[0].id, 'pixel-rate-limited')
    assert.ok(await db.get(
      "SELECT id FROM meta_oauth_pending_sessions WHERE id = ? AND status = 'pending'",
      [completed.sessionId]
    ))
  })
})

test('desconectar OAuth combinado conserva subscribed_apps si split Social usa la misma Page', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, pixel_id, access_token, connection_mode, page_id, instagram_account_id,
         oauth_connection_id, oauth_page_access_token, oauth_page_appsecret_proof,
         oauth_connected, oauth_validated
       ) VALUES ('unified-ad', 'unified-dataset', ?, 'oauth_bisu', 'shared-page', 'shared-ig', 'legacy-combined', ?, ?, 1, 1)`,
      [encrypt('legacy-combined-token'), encrypt('legacy-page-token'), encrypt('legacy-page-proof')]
    )
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         page_access_token, page_appsecret_proof, page_id,
         instagram_account_id, validated, connected_at
       ) VALUES (
         'split-social', 'social', 'active', 'split-social-connection', ?, ?, ?,
         'shared-page', 'shared-ig', 1, CURRENT_TIMESTAMP
       )`,
      [encrypt('split-social-token'), encrypt('split-page-token'), encrypt('split-page-proof')]
    )
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         ad_account_id, dataset_id, validated, connected_at
       ) VALUES (
         'split-ads', 'ads', 'active', 'split-ads-connection', ?,
         'split-ad', 'split-dataset', 1, CURRENT_TIMESTAMP
       )`,
      [encrypt('split-ads-token')]
    )

    let removedSubscriptions = 0
    setMetaOAuthCentralClientForTest({
      updateWebhookSubscription: async () => ({ registered: false }),
      disconnect: async () => ({ disconnected: true })
    })
    setMetaOAuthRuntimeClientForTest({
      removePageSubscription: async () => { removedSubscriptions += 1 },
      syncCrons: async () => undefined
    })

    assert.equal((await getMetaConfig()).access_token, 'legacy-combined-token')
    assert.equal((await getMetaConfig()).ad_account_id, 'unified-ad')
    assert.equal((await getMetaSocialConfig()).access_token, 'legacy-combined-token')

    const result = await disconnectMetaOAuthConnection()
    assert.equal(result.disconnected, true)
    assert.equal(removedSubscriptions, 0)
    assert.ok(await db.get(
      `SELECT id FROM meta_oauth_integrations
       WHERE integration_kind = 'social' AND status = 'active' AND page_id = 'shared-page'`
    ))
    assert.equal((await getMetaConfig()).access_token, 'split-ads-token')
    assert.equal((await getMetaConfig()).ad_account_id, 'split-ad')
    assert.equal((await getMetaSocialConfig()).access_token, 'split-social-token')
  })
})

test('desconectar OAuth combinado restaura primero una Page split distinta y permite reintentar', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, access_token, connection_mode, page_id, instagram_account_id,
         oauth_connection_id, oauth_page_access_token, oauth_page_appsecret_proof,
         oauth_connected, oauth_validated
       ) VALUES ('unified-ad', ?, 'oauth_bisu', 'unified-page', 'unified-ig',
         'unified-connection', ?, ?, 1, 1)`,
      [encrypt('unified-token'), encrypt('unified-page-token'), encrypt('unified-page-proof')]
    )
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         page_access_token, page_appsecret_proof, page_id,
         instagram_account_id, validated, connected_at
       ) VALUES ('split-social-different', 'social', 'active', 'split-social-different-connection',
         ?, ?, ?, 'split-page', 'split-ig', 1, CURRENT_TIMESTAMP)`,
      [encrypt('split-token'), encrypt('split-page-token'), encrypt('split-page-proof')]
    )

    const calls = []
    let failRestore = true
    let disconnectCalls = 0
    setMetaOAuthCentralClientForTest({
      updateWebhookSubscription: async input => {
        calls.push(input)
        if (input.integrationKind === 'social' && input.action === 'register' && failRestore) {
          throw new Error('restore unavailable')
        }
        return { registered: input.action === 'register' }
      },
      disconnect: async () => { disconnectCalls += 1; return { disconnected: true } }
    })
    setMetaOAuthRuntimeClientForTest({
      removePageSubscription: async () => ({ unsubscribed: true }),
      syncCrons: async () => undefined
    })

    await assert.rejects(
      () => disconnectMetaOAuthConnection({ publicBaseUrl: 'https://tenant.test' }),
      error => error.code === 'META_OAUTH_SPLIT_SOCIAL_RESTORE_FAILED'
    )
    assert.equal(disconnectCalls, 0)
    assert.equal(calls.some(call => !call.integrationKind && call.action === 'unregister'), false)
    assert.equal((await getMetaConfig()).oauth_connection_id, 'unified-connection')

    failRestore = false
    calls.length = 0
    const result = await disconnectMetaOAuthConnection({ publicBaseUrl: 'https://tenant.test' })
    assert.equal(result.restoredSplitSocial, true)
    assert.equal(disconnectCalls, 1)
    assert.equal(calls[0].integrationKind, 'social')
    assert.equal(calls[0].action, 'register')
    assert.equal(calls[0].webhookUrl, 'https://tenant.test/webhooks/meta/installer-relay')
    assert.equal(calls[1].integrationKind, undefined)
    assert.equal(calls[1].action, 'unregister')

    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return this }
    }
    await getMetaCustomValues({}, response)
    assert.equal(response.body?.data?.hasSplitSocial, true)
    assert.equal(response.body?.data?.hasSplitAds, false)
    assert.match(response.body?.data?.accessToken || '', /^\*\*\*/)
    assert.equal(response.body?.data?.pageId, 'split-page')
    assert.equal(response.body?.data?.instagramAccountId, 'split-ig')
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
    assert.deepEqual(effects, { crons: 3, channels: 1, history: 1, ads: 1 })
    assert.equal(await db.get("SELECT id FROM meta_oauth_pending_sessions WHERE id = 'central-unknown'"), null)
    assert.equal((await db.get('SELECT oauth_relay_status FROM meta_config LIMIT 1')).oauth_relay_status, 'registered')
  })
})

test('commit central confirmado nunca restaura A si falla la marca local; scheduler repara B', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    await db.run(
      `INSERT INTO meta_config (
        ad_account_id, access_token, connection_mode, page_id, instagram_account_id,
        oauth_connection_id, oauth_page_access_token, oauth_page_appsecret_proof,
        oauth_connected, oauth_validated, oauth_relay_status
      ) VALUES ('111', ?, 'oauth_bisu', 'page-a', 'ig-a', 'connection-a', ?, ?, 1, 1, 'registered')`,
      [encrypt('token-a'), encrypt('page-token-a'), encrypt('page-proof-a')]
    )
    const sessionId = 'commit-point-session'
    const webhookUrl = 'https://tenant.test/webhooks/meta/installer-relay'
    const pendingPayload = {
      accessToken: 'token-b',
      appSecretProof: 'proof-b',
      pageSecrets: { 'page-b': { pageAccessToken: 'page-token-b', pageAppSecretProof: 'page-proof-b' } },
      connectionId: 'connection-b',
      appId: 'app-b',
      configId: 'config-b',
      user: { id: 'user-b', name: 'User B' },
      permissions: {
        granted: [...META_OAUTH_REQUIRED_SCOPES],
        missing: [],
        granular: [{ scope: 'pages_messaging', targetIds: ['page-b'] }]
      },
      businesses: [{ id: 'business-b', name: 'Business B' }],
      adAccounts: [{
        id: 'act_222', businessId: 'business-b', timezoneName: 'UTC',
        pixels: [{ id: 'pixel-b', name: 'Pixel B' }]
      }],
      pages: [{
        id: 'page-b', businessId: 'business-b', tasksAvailable: true,
        tasks: ['ANALYZE', 'MESSAGING', 'MODERATE'],
        instagramAccounts: [{ id: 'ig-b', pageId: 'page-b' }]
      }],
      defaults: {
        businessId: 'business-b', adAccountId: '222', pixelId: 'pixel-b',
        pageId: 'page-b', instagramAccountId: 'ig-b'
      }
    }
    await db.run(
      `INSERT INTO meta_oauth_pending_sessions (id, payload_encrypted, status, expires_at)
       VALUES (?, ?, 'pending', ?)`,
      [
        sessionId,
        encrypt(JSON.stringify(pendingPayload)),
        new Date(Date.now() + 15 * 60_000).toISOString().replace('T', ' ').replace('Z', '')
      ]
    )

    let unregisterCalls = 0
    let previousPageCleanupCalls = 0
    const effects = { crons: 0, channels: 0, history: 0, ads: 0 }
    setMetaOAuthCentralClientForTest({
      updateWebhookSubscription: async input => {
        if (input.action === 'unregister') unregisterCalls += 1
        return { registered: input.action === 'register', connection_id: 'connection-b' }
      },
      getStatus: async () => ({
        connection: {
          connected: true,
          connection_id: 'connection-b',
          webhook_selections: [{
            page_id: 'page-b', instagram_account_id: 'ig-b', callback_url: webhookUrl, active: true
          }]
        }
      })
    })
    setMetaOAuthRuntimeClientForTest({
      ensurePageSubscription: async () => ({ subscribed: true }),
      removePageSubscription: async ({ config }) => {
        if (config.oauth_connection_id === 'connection-a') previousPageCleanupCalls += 1
      },
      syncCrons: async () => { effects.crons += 1 },
      enableSocialChannels: async () => { effects.channels += 1; return { messengerMessaging: true } },
      startSocialHistory: () => { effects.history += 1; return { syncStarted: true, started: ['messenger', 'instagram'], skipped: [] } },
      updateRecentAds: async () => { effects.ads += 1; return { success: true } }
    })
    setMetaOAuthFetchForTest(async urlValue => {
      const url = new URL(urlValue)
      const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
      if (path === '/pixel-b') return graphResponse({ id: 'pixel-b', name: 'Pixel B' })
      if (path === '/pixel-b/assigned_users') return graphResponse({
        data: [{ id: 'user-b', name: 'User B', tasks: ['UPLOAD'] }]
      })
      return graphResponse({ error: { message: `unexpected ${path}` } }, 404)
    })
    setMetaOAuthMarkLocalRelayForTest(async () => {
      throw new Error('simulated local relay write failure')
    })

    const repairing = await finalizeMetaOAuthConnection({ sessionId, publicBaseUrl: 'https://tenant.test' })
    assert.equal(repairing.connected, true)
    assert.equal(repairing.repairPending, true)
    assert.equal(unregisterCalls, 0)
    const localB = await getMetaConfig()
    assert.equal(localB.oauth_connection_id, 'connection-b')
    assert.equal(localB.oauth_relay_status, 'repair_pending')
    assert.equal(localB.access_token, 'token-b')

    setMetaOAuthMarkLocalRelayForTest()
    const pendingRow = await db.get(
      'SELECT payload_encrypted FROM meta_oauth_pending_sessions WHERE id = ?',
      [sessionId]
    )
    const repairPayload = JSON.parse(decrypt(pendingRow.payload_encrypted))
    repairPayload.saga.nextCleanupAt = new Date(Date.now() - 1_000).toISOString()
    await db.run(
      `UPDATE meta_oauth_pending_sessions SET payload_encrypted = ?, updated_at = datetime('now', '-3 minutes')
       WHERE id = ?`,
      [encrypt(JSON.stringify(repairPayload)), sessionId]
    )
    await cleanupMetaOAuthPendingSessions()

    assert.equal(unregisterCalls, 0)
    assert.equal(previousPageCleanupCalls, 1)
    assert.deepEqual(effects, { crons: 3, channels: 1, history: 1, ads: 1 })
    assert.equal((await getMetaConfig()).oauth_connection_id, 'connection-b')
    assert.equal((await getMetaConfig()).oauth_relay_status, 'registered')
    assert.equal(await db.get('SELECT id FROM meta_oauth_pending_sessions WHERE id = ?', [sessionId]), null)
  })
})

test('el Authorization de Ristak nunca se confunde con un token de Meta', () => {
  assert.equal(extractMetaAccessToken({
    headers: { authorization: 'Bearer ristak-session-jwt' }
  }), null)
  assert.equal(extractMetaAccessToken({
    headers: {
      authorization: 'Bearer ristak-session-jwt',
      'x-meta-access-token': 'meta-token-explicito'
    }
  }), 'meta-token-explicito')
})

test('el estado pasivo del OAuth usa expiración local sin consultar Graph', async () => {
  await initializeMasterKey()
  await withIsolatedMeta(async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString()
    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, access_token, connection_mode, page_id,
         token_expires_at, oauth_connected, oauth_validated,
         oauth_granted_scopes_json, oauth_relay_status
       ) VALUES (?, ?, 'oauth_user', ?, ?, 1, 1, ?, 'registered')`,
      [
        'ad-local',
        encrypt('oauth-token-local'),
        'page-local',
        expiresAt,
        JSON.stringify(['ads_read', 'pages_messaging'])
      ]
    )

    const response = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code
        return this
      },
      json(body) {
        this.body = body
        return this
      }
    }
    await verifyMetaTokenController({}, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.body?.configured, true)
    assert.equal(response.body?.tokenStatus?.valid, true)
    assert.deepEqual(response.body?.tokenStatus?.scopes, ['ads_read', 'pages_messaging'])
    assert.match(response.body?.tokenStatus?.message || '', /Meta conectado/)
  })
})
