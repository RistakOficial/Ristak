import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey, isEncrypted } from '../src/utils/encryption.js'
import {
  getMetaConfig,
  getMetaSocialConfig,
  resolveMetaCapiAccessToken,
  saveMetaConfig,
  updateRecentAds
} from '../src/services/metaAdsService.js'
import {
  completeMetaOAuthIntegration,
  cleanupMetaOAuthIntegrationSessions,
  createMetaOAuthIntegrationUrl,
  disconnectMetaOAuthIntegration,
  finalizeMetaOAuthIntegration,
  getMetaOAuthIntegrationStatus,
  setMetaOAuthIntegrationCentralClientForTest,
  setMetaOAuthIntegrationRuntimeClientForTest
} from '../src/services/metaOAuthIntegrationService.js'
import {
  META_OAUTH_ADS_REQUIRED_SCOPES,
  META_OAUTH_SOCIAL_REQUIRED_SCOPES,
  setMetaOAuthFetchForTest
} from '../src/services/metaOAuthService.js'
import { getActiveMetaOAuthIntegration } from '../src/services/metaOAuthIntegrationConfigService.js'
import {
  isMetaAdsConnected,
  isMetaSocialConnected
} from '../src/services/integrationConnectionStateService.js'
import { getMetaCustomValues } from '../src/controllers/metaController.js'

const TABLES = [
  'meta_config',
  'meta_oauth_integrations',
  'meta_oauth_integration_sessions',
  'highlevel_config'
]
const APP_CONFIG_KEYS = [
  'meta_config_disconnected',
  'meta_whatsapp_schedule_enabled',
  'meta_whatsapp_purchase_enabled',
  'meta_payment_purchase_event_config',
  'meta_messenger_messaging_enabled',
  'meta_facebook_comments_enabled',
  'meta_instagram_messaging_enabled',
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

async function withIsolatedSplitMeta(callback) {
  const restorers = []
  for (const table of TABLES) restorers.push(await snapshotTable(table))
  const configRows = await db.all(
    `SELECT config_key, config_value FROM app_config
     WHERE config_key IN (${APP_CONFIG_KEYS.map(() => '?').join(', ')})`,
    APP_CONFIG_KEYS
  )
  try {
    for (const table of TABLES) await db.run(`DELETE FROM ${table}`)
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${APP_CONFIG_KEYS.map(() => '?').join(', ')})`,
      APP_CONFIG_KEYS
    )
    await setAppConfig('meta_config_disconnected', '0')
    return await callback()
  } finally {
    setMetaOAuthFetchForTest()
    setMetaOAuthIntegrationCentralClientForTest()
    setMetaOAuthIntegrationRuntimeClientForTest()
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${APP_CONFIG_KEYS.map(() => '?').join(', ')})`,
      APP_CONFIG_KEYS
    )
    for (const row of configRows) await setAppConfig(row.config_key, row.config_value)
    for (const restore of restorers.reverse()) await restore()
  }
}

function graphResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data }
}

test('OAuth Social y Ads aíslan scopes, activos, runtime, rollback y desconexión', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, access_token, connection_mode, pixel_id, page_id,
         instagram_account_id, oauth_appsecret_proof
       ) VALUES (?, ?, 'manual_system_user', ?, ?, ?, ?)`,
      [
        'legacy-ad', encrypt('legacy-token'), 'legacy-dataset', 'legacy-page',
        'legacy-ig', encrypt('legacy-proof')
      ]
    )

    const socialHandoff = {
      integration_kind: 'social',
      connection_id: 'social-connection-1',
      access_token: 'social-token',
      appsecret_proof: 'social-proof',
      app_id: 'meta-app',
      config_id: 'social-config',
      scopes: [...META_OAUTH_SOCIAL_REQUIRED_SCOPES],
      granular_scopes: [
        { scope: 'pages_messaging', target_ids: ['page-1'] },
        { scope: 'instagram_manage_messages', target_ids: ['page-1', 'ig-1'] }
      ],
      assets: {
        pages: [{
          id: 'page-1',
          name: 'Página Uno',
          tasks: ['MESSAGING', 'MODERATE'],
          page_access_token: 'social-page-token',
          page_appsecret_proof: 'social-page-proof',
          instagram_business_account: { id: 'ig-1', username: 'demo' }
        }],
        instagram_accounts: [{ id: 'ig-1', page_id: 'page-1', username: 'demo' }]
      }
    }
    const adsHandoff = {
      integration_kind: 'ads',
      connection_id: 'ads-connection-1',
      access_token: 'ads-token',
      appsecret_proof: 'ads-proof',
      app_id: 'meta-app',
      config_id: 'ads-config',
      scopes: [...META_OAUTH_ADS_REQUIRED_SCOPES],
      granular_scopes: [{ scope: 'ads_read', target_ids: ['act_123'] }],
      assets: {
        businesses: [{ id: 'business-1', name: 'Negocio' }],
        ad_accounts: [{ id: 'act_123', name: 'Ads', business_id: 'business-1' }],
        pixels: [{ id: 'dataset-1', name: 'Dataset', ad_account_id: 'act_123' }]
      }
    }

    const graphCalls = []
    let socialGraphTasks = null
    setMetaOAuthFetchForTest(async urlValue => {
      const url = new URL(urlValue)
      const path = url.pathname.replace(/^\/v\d+\.\d+/, '')
      const proof = url.searchParams.get('appsecret_proof')
      graphCalls.push({ path, proof })
      const social = proof === 'social-proof'
      if (path === '/me' && url.searchParams.get('fields') === 'id,name') {
        return graphResponse({ id: social ? 'social-user' : 'ads-user', name: social ? 'Social User' : 'Ads User' })
      }
      if (path === '/me/permissions') {
        const scopes = social ? META_OAUTH_SOCIAL_REQUIRED_SCOPES : META_OAUTH_ADS_REQUIRED_SCOPES
        return graphResponse({ data: scopes.map(permission => ({ permission, status: 'granted' })) })
      }
      if (path === '/me/accounts') {
        return graphResponse({ data: [{
          id: 'page-1', name: 'Página Uno',
          ...(socialGraphTasks ? { tasks: socialGraphTasks } : {}),
          instagram_business_account: { id: 'ig-1', username: 'demo' }
        }] })
      }
      if (path === '/me/businesses') return graphResponse({ data: [{ id: 'business-1', name: 'Negocio' }] })
      if (path === '/me/adaccounts') {
        return graphResponse({ data: [{
          id: 'act_123', name: 'Ads', business: { id: 'business-1' }, timezone_name: 'America/Ciudad_Juarez'
        }] })
      }
      if (path === '/act_123/adspixels') return graphResponse({ data: [{ id: 'dataset-1', name: 'Dataset' }] })
      return graphResponse({ error: { message: `unexpected ${path}` } }, 404)
    })

    let failAdsFinalize = false
    let failSocialRegister = false
    let failCentralStatus = false
    let commitAdsThenTimeout = false
    const activeCentral = { social: '', ads: '' }
    const centralCalls = []
    setMetaOAuthIntegrationCentralClientForTest({
      getStatus: async ({ integrationKind }) => {
        if (failCentralStatus) throw new Error('central status unavailable')
        return {
          configured: true,
          available: true,
          review_pending: false,
          connection: {
            connected: Boolean(activeCentral[integrationKind]),
            connection_id: activeCentral[integrationKind] || null
          },
          required_scopes: integrationKind === 'social'
            ? META_OAUTH_SOCIAL_REQUIRED_SCOPES
            : META_OAUTH_ADS_REQUIRED_SCOPES
        }
      },
      createConnectUrl: async input => {
        centralCalls.push({ type: 'connect-url', ...input })
        return { connectUrl: `https://installer.test/meta/${input.integrationKind}` }
      },
      claimHandoff: async ({ handoffToken }) => ({
        payload: { meta: handoffToken.startsWith('social') ? socialHandoff : adsHandoff }
      }),
      updateWebhookSubscription: async input => {
        centralCalls.push({ type: 'webhook', ...input })
        if (input.action === 'register' && failSocialRegister) {
          throw new Error('central social unavailable')
        }
        if (input.action === 'register') activeCentral.social = input.connectionId
        if (input.action === 'unregister') activeCentral.social = ''
        return { registered: input.action === 'register' }
      },
      finalize: async input => {
        centralCalls.push({ type: 'finalize', ...input })
        if (failAdsFinalize) throw new Error('central ads unavailable')
        activeCentral.ads = input.connectionId
        if (commitAdsThenTimeout) throw new Error('central response timeout')
        return { connected: true }
      },
      disconnect: async input => {
        centralCalls.push({ type: 'disconnect', ...input })
        activeCentral[input.integrationKind] = ''
        return { disconnected: true }
      }
    })

    const subscriptions = []
    const removedSubscriptions = []
    const cronProviders = []
    const socialChannelDefaults = []
    const enabledSocialConfigs = []
    const enabledConversionEvents = []
    let adsSyncRuns = 0
    setMetaOAuthIntegrationRuntimeClientForTest({
      enableConversionEvents: async input => {
        enabledConversionEvents.push(input)
        return { enabled: true, scheduleEnabled: true, purchaseEnabled: true }
      },
      ensurePageSubscription: async ({ config }) => {
        subscriptions.push(config)
        return { subscribed: true }
      },
      removePageSubscription: async ({ config }) => {
        removedSubscriptions.push(config)
        return { unsubscribed: true }
      },
      enableSocialChannels: async config => {
        enabledSocialConfigs.push(config)
        return { messengerMessaging: true, instagramMessaging: true }
      },
      startSocialHistory: ({ platforms }) => ({ syncStarted: true, started: platforms, skipped: [] }),
      syncSocialChannelDefaults: async transition => { socialChannelDefaults.push(transition) },
      syncCrons: async provider => { cronProviders.push(provider) },
      updateRecentAds: async () => {
        adsSyncRuns += 1
        return { success: true, count: 0 }
      }
    })

    const socialStatusBefore = await getMetaOAuthIntegrationStatus('social')
    assert.equal(socialStatusBefore.integrationKind, 'social')
    assert.equal(socialStatusBefore.manualConfigured, true)
    assert.equal(socialStatusBefore.oauth.connected, false)
    assert.deepEqual(socialStatusBefore.requiredScopes, META_OAUTH_SOCIAL_REQUIRED_SCOPES)
    assert.equal((await createMetaOAuthIntegrationUrl({ integrationKind: 'social' })).integrationKind, 'social')

    // Incluso si el fallback vivo no devuelve `tasks`, la evidencia del
    // handoff debe bloquear una Page sin MESSAGING/MODERATE. ANALYZE no aplica.
    socialHandoff.assets.pages[0].tasks = ['MODERATE', 'ANALYZE']
    const missingTaskSession = await completeMetaOAuthIntegration({
      integrationKind: 'social',
      handoffToken: 'social-missing-messaging'
    })
    await assert.rejects(
      () => finalizeMetaOAuthIntegration({
        integrationKind: 'social',
        sessionId: missingTaskSession.sessionId,
        pageId: 'page-1',
        publicBaseUrl: 'https://tenant.test'
      }),
      error => error.code === 'META_OAUTH_PAGE_TASKS_MISSING'
    )
    await db.run('DELETE FROM meta_oauth_integration_sessions WHERE id = ?', [missingTaskSession.sessionId])
    socialHandoff.assets.pages[0].tasks = ['MESSAGING', 'MODERATE']

    const socialSession = await completeMetaOAuthIntegration({
      integrationKind: 'social',
      handoffToken: 'social-handoff'
    })
    assert.equal(socialSession.integrationKind, 'social')
    assert.equal(socialSession.adAccounts.length, 0)
    assert.equal(socialSession.pages.length, 1)
    assert.equal(graphCalls.some(call => call.proof === 'social-proof' && call.path === '/me/adaccounts'), false)
    assert.equal(graphCalls.some(call => call.proof === 'social-proof' && call.path === '/me/businesses'), false)
    assert.equal(JSON.stringify(socialSession).includes('social-token'), false)

    const socialResult = await finalizeMetaOAuthIntegration({
      integrationKind: 'social',
      sessionId: socialSession.sessionId,
      pageId: 'page-1',
      instagramAccountId: 'ig-1',
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal(socialResult.connected, true)
    assert.equal(socialResult.selected.adAccountId, '')
    assert.equal(socialResult.capabilities.socialMessaging, true)
    assert.equal(subscriptions[0].oauth_page_access_token, 'social-page-token')
    assert.equal(centralCalls.some(call => call.type === 'webhook' && call.integrationKind === 'social'), true)
    assert.equal(centralCalls.some(call => call.type === 'finalize' && call.integrationKind === 'social'), false)
    assert.equal((await getMetaSocialConfig()).access_token, 'social-token')
    assert.equal((await getMetaConfig()).access_token, 'legacy-token')
    assert.equal(await isMetaSocialConnected(), true)

    // Renovar OAuth sobre la misma Page no puede ejecutar DELETE
    // subscribed_apps contra la Page que acaba de quedar activa.
    socialHandoff.connection_id = 'social-connection-2'
    socialHandoff.access_token = 'social-token-2'
    const renewedSocialSession = await completeMetaOAuthIntegration({
      integrationKind: 'social',
      handoffToken: 'social-renewed-same-page'
    })
    await finalizeMetaOAuthIntegration({
      integrationKind: 'social',
      sessionId: renewedSocialSession.sessionId,
      pageId: 'page-1',
      publicBaseUrl: 'https://tenant.test'
    })
    assert.equal((await getMetaSocialConfig()).access_token, 'social-token-2')
    assert.equal(socialChannelDefaults.at(-1)?.previousInstagramAccountId, 'ig-1')
    assert.equal(socialChannelDefaults.at(-1)?.nextInstagramAccountId, '')
    assert.equal(removedSubscriptions.length, 0, 'renovar la misma Page conserva subscribed_apps')

    // La compensación de un candidato fallido sobre esa misma Page tampoco
    // debe desuscribir la conexión A que sigue activa.
    socialHandoff.connection_id = 'social-connection-3'
    socialHandoff.access_token = 'social-token-3'
    failSocialRegister = true
    const failedSocialSession = await completeMetaOAuthIntegration({
      integrationKind: 'social',
      handoffToken: 'social-failed-same-page'
    })
    await assert.rejects(
      () => finalizeMetaOAuthIntegration({
        integrationKind: 'social',
        sessionId: failedSocialSession.sessionId,
        pageId: 'page-1',
        instagramAccountId: 'ig-1',
        publicBaseUrl: 'https://tenant.test'
      }),
      /central social unavailable/
    )
    failSocialRegister = false
    assert.equal((await getMetaSocialConfig()).access_token, 'social-token-2')
    assert.equal(removedSubscriptions.length, 0, 'rollback de la misma Page conserva subscribed_apps')
    await db.run('DELETE FROM meta_oauth_integration_sessions WHERE id = ?', [failedSocialSession.sessionId])
    const subscriptionsBeforeAds = subscriptions.length

    const adsSession = await completeMetaOAuthIntegration({
      integrationKind: 'ads',
      handoffToken: 'ads-handoff'
    })
    assert.equal(adsSession.integrationKind, 'ads')
    assert.equal(adsSession.pages.length, 0)
    assert.equal(adsSession.adAccounts.length, 1)
    assert.equal(adsSession.defaults.pixelId, '', 'Dataset nunca se autoelige')
    assert.equal(graphCalls.some(call => call.proof === 'ads-proof' && call.path === '/me/accounts'), false)

    const adsResult = await finalizeMetaOAuthIntegration({
      integrationKind: 'ads',
      sessionId: adsSession.sessionId,
      adAccountId: 'act_123'
    })
    assert.equal(adsResult.connected, true)
    assert.equal(adsResult.selected.pageId, '')
    assert.equal(adsResult.selected.pixelId, '')
    assert.equal(adsResult.capabilities.adsRead, true)
    assert.equal(adsResult.capabilities.capiEnabled, false)
    assert.equal(adsResult.capabilities.campaignPublishing, false)
    assert.equal(adsResult.conversionEvents.enabled, false)
    assert.equal(enabledConversionEvents.length, 0, 'sin Dataset no se activan defaults de CAPI')
    assert.equal(subscriptions.length, subscriptionsBeforeAds, 'Ads jamás suscribe Page')
    assert.equal(centralCalls.some(call => call.type === 'finalize' && call.integrationKind === 'ads'), true)
    assert.equal((await getMetaConfig()).access_token, 'ads-token')
    assert.equal((await getMetaConfig()).ad_account_id, '123')
    assert.equal((await getMetaSocialConfig()).access_token, 'social-token-2')
    assert.equal(resolveMetaCapiAccessToken(await getMetaConfig()), '', 'sin Dataset CAPI permanece apagado')
    assert.equal(await isMetaAdsConnected(), true)

    // WhatsApp conserva su frontera histórica: nunca debe exportar el BISU de
    // Ads como si fuera un System User Token de WhatsApp.
    await setAppConfig('license_key', 'installer-signature-secret')
    await setAppConfig('installation_id', 'test-installation')
    const {
      createMetaDirectConnectUrl,
      getMetaDirectSetupPrefill
    } = await import('../src/services/whatsappApiService.js')
    const connectUrl = await createMetaDirectConnectUrl({ appUrl: 'https://tenant.test' })
    const state = new URL(connectUrl.url).searchParams.get('state')
    const payload = { state }
    const rawBody = JSON.stringify(payload)
    const timestamp = String(Date.now())
    const nonce = `meta-prefill-${crypto.randomUUID()}`
    const signature = crypto
      .createHmac('sha256', 'installer-signature-secret')
      .update(`${timestamp}.${nonce}.${rawBody}`)
      .digest('hex')
    const whatsappPrefill = await getMetaDirectSetupPrefill({
      payload,
      rawBody,
      headers: {
        signature,
        signatureTimestamp: timestamp,
        signatureNonce: nonce,
        installationId: 'test-installation'
      }
    })
    assert.equal(whatsappPrefill.systemUserToken, 'legacy-token')
    assert.equal(whatsappPrefill.datasetId, 'legacy-dataset')
    assert.notEqual(whatsappPrefill.systemUserToken, 'ads-token')

    // Reconectar Ads y fallar antes de la promoción central conserva Ads A y Social.
    adsHandoff.connection_id = 'ads-connection-2'
    adsHandoff.access_token = 'ads-token-2'
    failAdsFinalize = true
    const failedAdsSession = await completeMetaOAuthIntegration({
      integrationKind: 'ads',
      handoffToken: 'ads-reconnect'
    })
    assert.deepEqual(failedAdsSession.adAccounts[0]?.pixels, [{ id: 'dataset-1', name: 'Dataset' }])
    await assert.rejects(
      () => finalizeMetaOAuthIntegration({
        integrationKind: 'ads',
        sessionId: failedAdsSession.sessionId,
        adAccountId: 'act_123',
        datasetId: 'dataset-1'
      }),
      /central ads unavailable/
    )
    assert.equal((await getMetaConfig()).access_token, 'ads-token')
    assert.equal((await getMetaSocialConfig()).access_token, 'social-token-2')
    assert.equal(await db.get(
      `SELECT id FROM meta_oauth_integrations WHERE integration_kind = 'ads' AND status = 'candidate'`
    ), null)

    // La misma reconexión puede reintentarse y ahora habilita CAPI con Dataset verificado.
    failAdsFinalize = false
    const adsWithDataset = await finalizeMetaOAuthIntegration({
      integrationKind: 'ads',
      sessionId: failedAdsSession.sessionId,
      adAccountId: 'act_123',
      datasetId: 'dataset-1'
    })
    assert.equal(adsWithDataset.capabilities.capiEnabled, true)
    assert.equal(adsWithDataset.conversionEvents.enabled, true)
    assert.deepEqual(enabledConversionEvents.at(-1), {
      accessToken: 'ads-token-2',
      pixelId: 'dataset-1'
    })
    const adsConfig = await getMetaConfig()
    assert.equal(adsConfig.access_token, 'ads-token-2')
    assert.equal(adsConfig.pixel_id, 'dataset-1')
    assert.equal(resolveMetaCapiAccessToken(adsConfig), 'ads-token-2')

    // Si Installer hizo commit pero se perdió la respuesta, el status central
    // reconcilia B y nunca restaura A por error.
    adsHandoff.connection_id = 'ads-connection-3'
    adsHandoff.access_token = 'ads-token-3'
    commitAdsThenTimeout = true
    const ambiguousAdsSession = await completeMetaOAuthIntegration({
      integrationKind: 'ads',
      handoffToken: 'ads-timeout-after-commit'
    })
    const reconciledAds = await finalizeMetaOAuthIntegration({
      integrationKind: 'ads',
      sessionId: ambiguousAdsSession.sessionId,
      adAccountId: 'act_123'
    })
    commitAdsThenTimeout = false
    assert.equal(reconciledAds.connected, true)
    assert.equal((await getMetaConfig()).access_token, 'ads-token-3')

    // Si el commit central queda ambiguo y se repara después, la reparación
    // debe activar también crons/efectos, no sólo pintar connected=true.
    adsHandoff.connection_id = 'ads-connection-4'
    adsHandoff.access_token = 'ads-token-4'
    commitAdsThenTimeout = true
    failCentralStatus = true
    const deferredAdsSession = await completeMetaOAuthIntegration({
      integrationKind: 'ads',
      handoffToken: 'ads-deferred-repair'
    })
    await assert.rejects(
      () => finalizeMetaOAuthIntegration({
        integrationKind: 'ads',
        sessionId: deferredAdsSession.sessionId,
        adAccountId: 'act_123'
      }),
      error => error.code === 'META_OAUTH_FINALIZATION_UNCERTAIN'
    )
    failCentralStatus = false
    commitAdsThenTimeout = false
    const cronsBeforeRepair = cronProviders.length
    const adsSyncBeforeRepair = adsSyncRuns
    await db.run(
      `UPDATE meta_oauth_integration_sessions
       SET expires_at = datetime('now', '-1 minute') WHERE id = ?`,
      [deferredAdsSession.sessionId]
    )
    const repaired = await cleanupMetaOAuthIntegrationSessions()
    assert.equal(repaired.repaired, 1)
    assert.equal((await getMetaConfig()).access_token, 'ads-token-4')
    assert.deepEqual(cronProviders.slice(cronsBeforeRepair), ['meta-ads', 'meta'])
    assert.equal(adsSyncRuns, adsSyncBeforeRepair + 1)

    const rawRows = await db.all(`SELECT * FROM meta_oauth_integrations WHERE status = 'active'`)
    assert.equal(rawRows.length, 2)
    assert.equal(rawRows.every(row => isEncrypted(row.access_token)), true)
    assert.equal(isEncrypted(rawRows.find(row => row.integration_kind === 'social').page_access_token), true)

    const disconnectedSocial = await disconnectMetaOAuthIntegration('social')
    assert.equal(disconnectedSocial.disconnected, true)
    assert.equal(disconnectedSocial.restoredLegacy, true)
    assert.equal((await getMetaConfig()).access_token, 'ads-token-4', 'desconectar Social no toca Ads')
    assert.equal((await getMetaSocialConfig()).access_token, 'legacy-token', 'Social cae al manual combinado')
    assert.equal(subscriptions.at(-1)?.access_token, 'legacy-token', 'fallback manual vuelve a suscribir su Page')
    assert.equal(enabledSocialConfigs.at(-1)?.access_token, 'legacy-token')
    assert.equal(socialChannelDefaults.at(-1)?.nextPageId, 'legacy-page')
    assert.equal(await isMetaAdsConnected(), true)
    assert.equal(centralCalls.some(call => call.type === 'disconnect' && call.integrationKind === 'social'), true)

    const disconnectedAds = await disconnectMetaOAuthIntegration('ads')
    assert.equal(disconnectedAds.disconnected, true)
    assert.equal(disconnectedAds.restoredLegacy, true)
    assert.equal((await getMetaConfig()).access_token, 'legacy-token')
    assert.equal(await isMetaSocialConnected(), true, 'el fallback manual Social permanece conectado')
    assert.equal(cronProviders.includes('meta-social'), true)
    assert.equal(cronProviders.includes('meta-ads'), true)
    assert.ok(removedSubscriptions.length >= 1)
  })
})

test('handoff y selección no pueden cruzarse entre Social y Ads', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    setMetaOAuthIntegrationCentralClientForTest({
      claimHandoff: async () => ({
        payload: {
          meta: {
            integration_kind: 'ads',
            connection_id: 'cross-kind',
            access_token: 'token',
            appsecret_proof: 'proof'
          }
        }
      })
    })
    await assert.rejects(
      () => completeMetaOAuthIntegration({ integrationKind: 'social', handoffToken: 'wrong-kind' }),
      error => error.code === 'META_OAUTH_HANDOFF_KIND_MISMATCH'
    )
  })
})

test('cleanup y disconnect Social preservan fallback OAuth de la misma Page y restauran runtime', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    await db.run(
      `INSERT INTO meta_config (
         access_token, connection_mode, page_id, instagram_account_id,
         oauth_page_access_token, oauth_page_appsecret_proof,
         oauth_connected, oauth_validated
       ) VALUES (?, 'oauth_bisu', 'legacy-page', 'legacy-ig', ?, ?, 1, 1)`,
      [encrypt('legacy-oauth-token'), encrypt('legacy-page-token'), encrypt('legacy-page-proof')]
    )

    const removedPages = []
    const ensuredFallbacks = []
    const channelTransitions = []
    setMetaOAuthIntegrationCentralClientForTest({
      updateWebhookSubscription: async () => ({ registered: false }),
      disconnect: async () => ({ disconnected: true })
    })
    setMetaOAuthIntegrationRuntimeClientForTest({
      ensurePageSubscription: async ({ config }) => {
        ensuredFallbacks.push(config)
        return { subscribed: true }
      },
      removePageSubscription: async ({ config }) => {
        removedPages.push(config.page_id)
        return { unsubscribed: true }
      },
      enableSocialChannels: async () => ({ messengerMessaging: true }),
      syncSocialChannelDefaults: async input => { channelTransitions.push(input) },
      syncCrons: async () => undefined
    })

    const expiredPayload = {
      integrationKind: 'social',
      connectionId: 'expired-candidate',
      accessToken: 'expired-token',
      appSecretProof: 'expired-proof',
      pageSecrets: {
        'legacy-page': {
          pageAccessToken: 'expired-page-token',
          pageAppSecretProof: 'expired-page-proof'
        }
      },
      saga: {
        stage: 'page_subscribed',
        selected: {
          businessId: '', adAccountId: '', pixelId: '',
          pageId: 'legacy-page', instagramAccountId: 'legacy-ig'
        }
      }
    }
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token, page_id
       ) VALUES ('expired-row', 'social', 'candidate', 'expired-candidate', ?, 'legacy-page')`,
      [encrypt('expired-token')]
    )
    await db.run(
      `INSERT INTO meta_oauth_integration_sessions (
         id, integration_kind, payload_encrypted, status, expires_at
       ) VALUES ('expired-session', 'social', ?, 'consuming', datetime('now', '-1 minute'))`,
      [encrypt(JSON.stringify(expiredPayload))]
    )

    const cleanup = await cleanupMetaOAuthIntegrationSessions()
    assert.equal(cleanup.removed, 1)
    assert.deepEqual(removedPages, [], 'candidate expirado no desuscribe fallback OAuth de la misma Page')

    const insertActiveSocial = async ({ id, connectionId, pageId }) => {
      await db.run(
        `INSERT INTO meta_oauth_integrations (
           id, integration_kind, status, connection_id, access_token,
           page_access_token, page_appsecret_proof, page_id, validated, connected_at
         ) VALUES (?, 'social', 'active', ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
        [
          id,
          connectionId,
          encrypt(`${id}-token`),
          encrypt(`${id}-page-token`),
          encrypt(`${id}-page-proof`),
          pageId
        ]
      )
    }

    await insertActiveSocial({
      id: 'same-page-active',
      connectionId: 'same-page-connection',
      pageId: 'legacy-page'
    })
    const samePageDisconnect = await disconnectMetaOAuthIntegration('social')
    assert.equal(samePageDisconnect.restoredLegacy, true)
    assert.deepEqual(removedPages, [], 'disconnect no borra subscribed_apps compartido por fallback OAuth')
    assert.equal(ensuredFallbacks.at(-1)?.access_token, 'legacy-oauth-token')
    assert.equal(channelTransitions.at(-1)?.nextPageId, 'legacy-page')

    await insertActiveSocial({
      id: 'different-page-active',
      connectionId: 'different-page-connection',
      pageId: 'split-only-page'
    })
    await disconnectMetaOAuthIntegration('social')
    assert.deepEqual(removedPages, ['split-only-page'], 'una Page sin fallback sí se desuscribe')
    assert.equal(ensuredFallbacks.at(-1)?.page_id, 'legacy-page')
  })
})

test('disconnect sólo reporta fallback restaurado cuando el método heredado tiene su activo obligatorio', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    await db.run(
      `INSERT INTO meta_config (access_token, connection_mode)
       VALUES (?, 'manual_system_user')`,
      [encrypt('legacy-token-without-assets')]
    )
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token, page_id, validated, connected_at
       ) VALUES ('social-active', 'social', 'active', 'social-connection', ?, 'split-page', 1, CURRENT_TIMESTAMP)`,
      [encrypt('social-token')]
    )
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token, ad_account_id, validated, connected_at
       ) VALUES ('ads-active', 'ads', 'active', 'ads-connection', ?, 'act_123', 1, CURRENT_TIMESTAMP)`,
      [encrypt('ads-token')]
    )

    setMetaOAuthIntegrationCentralClientForTest({
      updateWebhookSubscription: async () => ({ registered: false }),
      disconnect: async () => ({ disconnected: true })
    })
    setMetaOAuthIntegrationRuntimeClientForTest({
      removePageSubscription: async () => ({ unsubscribed: true }),
      syncSocialChannelDefaults: async () => undefined,
      syncCrons: async () => undefined
    })

    const social = await disconnectMetaOAuthIntegration('social')
    assert.equal(social.restoredLegacy, false, 'un token sin Page no restaura Social')

    const ads = await disconnectMetaOAuthIntegration('ads')
    assert.equal(ads.restoredLegacy, false, 'un token sin Ad Account no restaura Ads')
  })
})

test('custom-values expone split efectivo sin mezclar activos ni revivir el token manual', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         page_id, instagram_account_id, validated, connected_at
       ) VALUES ('social-only', 'social', 'active', 'social-only-connection', ?, 'split-page', 'split-ig', 1, CURRENT_TIMESTAMP)`,
      [encrypt('social-only-token')]
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
    await getMetaCustomValues({}, response)

    assert.equal(response.statusCode, 200)
    assert.equal(response.body?.success, true)
    assert.match(response.body?.data?.accessToken || '', /^\*\*\*/)
    assert.equal(response.body?.data?.adAccountId, '')
    assert.equal(response.body?.data?.pageId, 'split-page')
    assert.equal(response.body?.data?.instagramAccountId, 'split-ig')
    assert.equal(response.body?.data?.hasSplitAds, false)
    assert.equal(response.body?.data?.hasSplitSocial, true)
    assert.equal(response.body?.data?.connectionMode, 'oauth_bisu')

    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         ad_account_id, dataset_id, validated, connected_at
       ) VALUES ('ads-only', 'ads', 'active', 'ads-only-connection', ?, 'split-ad', 'split-dataset', 1, CURRENT_TIMESTAMP)`,
      [encrypt('ads-only-token')]
    )
    await getMetaCustomValues({}, response)

    assert.match(response.body?.data?.accessToken || '', /^\*\*\*/)
    assert.equal(response.body?.data?.adAccountId, 'split-ad')
    assert.equal(response.body?.data?.pixelId, 'split-dataset')
    assert.equal(response.body?.data?.pageId, 'split-page')
    assert.equal(response.body?.data?.instagramAccountId, 'split-ig')
    assert.equal(response.body?.data?.hasSplitAds, true)
    assert.equal(response.body?.data?.hasSplitSocial, true)

    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, access_token, connection_mode, pixel_id, page_id, instagram_account_id
       ) VALUES ('legacy-ad', ?, 'manual_system_user', 'legacy-dataset', 'legacy-page', 'legacy-ig')`,
      [encrypt('legacy-manual-token')]
    )
    await getMetaCustomValues({}, response)

    assert.match(response.body?.data?.accessToken || '', /^\*\*\*/)
    assert.equal(response.body?.data?.adAccountId, 'split-ad')
    assert.equal(response.body?.data?.pageId, 'split-page')
    assert.equal(response.body?.data?.instagramAccountId, 'split-ig')
    assert.equal(response.body?.data?.connectionMode, 'oauth_bisu')

    await db.run('DELETE FROM meta_oauth_integrations')
    await getMetaCustomValues({}, response)
    assert.equal(response.body?.data?.adAccountId, '')
    assert.equal(response.body?.data?.pageId, '')
    assert.equal(response.body?.data?.instagramAccountId, '')
    assert.equal(response.body?.data?.connectionMode || null, null)
    assert.equal(response.body?.data?.hasSplitAds === true, false)
    assert.equal(response.body?.data?.hasSplitSocial === true, false)
  })
})

test('el flag de desconexión legacy no apaga el runtime de OAuth Ads separado', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token, validated, connected_at
       ) VALUES ('ads-without-selection', 'ads', 'active', 'ads-without-selection-connection', ?, 1, CURRENT_TIMESTAMP)`,
      [encrypt('split-ads-token')]
    )
    await setAppConfig('meta_config_disconnected', '1')

    const result = await updateRecentAds()
    assert.equal(result.message, 'No config', 'OAuth Ads ignora el flag legacy y llega a validar su propia selección')

    await setAppConfig('meta_config_disconnected', '0')
  })
})

test('migrar Ads split con Dataset a OAuth unificado sin Dataset pausa eventos CAPI', async () => {
  await initializeMasterKey()
  await withIsolatedSplitMeta(async () => {
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         ad_account_id, dataset_id, validated, connected_at
       ) VALUES ('ads-with-dataset', 'ads', 'active', 'ads-with-dataset-connection',
         ?, 'split-ad', 'split-dataset', 1, CURRENT_TIMESTAMP)`,
      [encrypt('split-ads-token')]
    )
    await setAppConfig('meta_whatsapp_schedule_enabled', '1')
    await setAppConfig('meta_whatsapp_purchase_enabled', '1')
    await setAppConfig('meta_payment_purchase_event_config', JSON.stringify({ enabled: true, channel: 'smart' }))

    await saveMetaConfig('unified-ad', 'unified-token', null, 'unified-page', null, {
      connectionMode: 'oauth_bisu',
      oauthConnectionId: 'unified-without-dataset',
      oauthUserId: 'isu-1',
      oauthBusinessId: 'business-1',
      appSecretProof: 'proof',
      pageAccessToken: 'page-token',
      pageAppSecretProof: 'page-proof',
      grantedScopes: ['ads_read'],
      validated: true,
      timezoneData: { timezone_name: 'UTC', timezone_id: null, timezone_offset_hours_utc: 0 }
    })

    assert.equal((await getMetaConfig()).pixel_id, null)
    assert.equal(await db.get(
      `SELECT config_value FROM app_config WHERE config_key = 'meta_whatsapp_schedule_enabled'`
    ).then(row => row.config_value), '0')
    assert.equal(await db.get(
      `SELECT config_value FROM app_config WHERE config_key = 'meta_whatsapp_purchase_enabled'`
    ).then(row => row.config_value), '0')
    assert.equal(JSON.parse(await db.get(
      `SELECT config_value FROM app_config WHERE config_key = 'meta_payment_purchase_event_config'`
    ).then(row => row.config_value)).enabled, false)
  })
})
