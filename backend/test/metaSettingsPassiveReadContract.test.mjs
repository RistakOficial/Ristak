import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  getAdAccounts,
  getConfig,
  getMetaAssets,
  getMetaCustomValues,
  getMetaSocialMessagingSetup,
  getMetaWebhookInfo,
  getPages,
  getPixels,
  revealMetaToken,
  saveAndSyncMeta,
  saveConfig,
  saveMetaMessengerUserToken,
  getSocialProfiles,
  getSyncSettings,
  syncFromHighLevel,
  verifyToken
} from '../src/controllers/metaController.js'
import {
  getMetaOAuthConnectionStatus,
  refreshMetaOAuthConnectionStatus,
  setMetaOAuthCentralClientForTest
} from '../src/services/metaOAuthService.js'
import {
  getMetaOAuthIntegrationStatus,
  refreshMetaOAuthIntegrationStatus,
  setMetaOAuthIntegrationCentralClientForTest
} from '../src/services/metaOAuthIntegrationService.js'
import { reconcileMetaBusinessWithHighLevel } from '../src/services/highlevelSyncService.js'
import {
  clearMetaAssetSnapshot,
  getMetaAssetSnapshot,
  saveMetaAssetSnapshot
} from '../src/services/metaAssetSnapshotService.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const readSource = relativePath => readFile(join(repoRoot, relativePath), 'utf8')

const TABLES = [
  'meta_config',
  'meta_oauth_integrations',
  'meta_oauth_integration_sessions',
  'meta_oauth_pending_sessions',
  'meta_oauth_connection_backups',
  'meta_oauth_authorized_assets',
  'highlevel_config'
]

const APP_CONFIG_KEYS = [
  'meta_asset_snapshot_v1',
  'meta_config_disconnected',
  'meta_webhook_verify_token',
  'meta_whatsapp_business_account_id'
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

async function withIsolatedMetaSettings(callback) {
  const restorers = []
  for (const table of TABLES) restorers.push(await snapshotTable(table))
  const appConfigRows = await db.all(
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
    return await callback()
  } finally {
    setMetaOAuthCentralClientForTest()
    setMetaOAuthIntegrationCentralClientForTest()
    await db.run(
      `DELETE FROM app_config WHERE config_key IN (${APP_CONFIG_KEYS.map(() => '?').join(', ')})`,
      APP_CONFIG_KEYS
    )
    for (const row of appConfigRows) await setAppConfig(row.config_key, row.config_value)
    for (const restore of restorers.reverse()) await restore()
  }
}

async function databaseFingerprint() {
  const snapshot = {}
  for (const table of TABLES) {
    snapshot[table] = await db.all(`SELECT * FROM ${table} ORDER BY 1`).catch(() => [])
  }
  snapshot.app_config = await db.all('SELECT * FROM app_config ORDER BY config_key')
  return JSON.stringify(snapshot)
}

function responseRecorder() {
  const result = { statusCode: 200, payload: null }
  result.status = code => {
    result.statusCode = code
    return result
  }
  result.json = payload => {
    result.payload = payload
    return result
  }
  return result
}

function passiveRequest({ query = {}, params = {} } = {}) {
  return {
    body: {},
    headers: { host: 'tenant.test' },
    hostname: 'tenant.test',
    protocol: 'https',
    query,
    params,
    get: name => String(name).toLowerCase() === 'host' ? 'tenant.test' : ''
  }
}

test('Configuración Meta pinta sólo desde estado local y cada GET pasivo deja la base intacta', { timeout: 15_000 }, async () => {
  await initializeMasterKey()
  await withIsolatedMetaSettings(async () => {
    // Texto plano a propósito: un GET no debe aprovechar la navegación para
    // migrarlo. La siguiente mutación explícita sí conserva el hardening previo.
    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, access_token, connection_mode, app_id, meta_business_id,
         pixel_id, page_id, instagram_account_id, oauth_connected, oauth_validated
       ) VALUES (?, ?, 'manual_system_user', ?, ?, ?, ?, ?, 0, 0)`,
      ['123', 'legacy-plain-token', 'legacy-app', 'business-1', 'pixel-1', 'page-1', 'ig-1']
    )
    await db.run(
      `INSERT INTO meta_oauth_integrations (
         id, integration_kind, status, connection_id, access_token,
         app_id, config_id, page_id, instagram_account_id, validated, connected_at
       ) VALUES (?, 'social', 'active', ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`,
      ['social-local', 'social-connection', 'social-plain-token', 'social-app', 'social-config', 'page-1', 'ig-1']
    )
    await db.run(
      'INSERT INTO highlevel_config (location_id, api_token) VALUES (?, ?)',
      ['location-should-not-be-called', 'highlevel-plain-token']
    )
    await setAppConfig('meta_webhook_verify_token', 'local-verify-token')
    await setAppConfig('meta_whatsapp_business_account_id', 'waba-local')

    let installerCalls = 0
    const installerStatus = async () => {
      installerCalls += 1
      return {
        configured: true,
        available: true,
        review_pending: false,
        app_id: 'remote-app',
        config_id: 'remote-config',
        required_scopes: []
      }
    }
    setMetaOAuthCentralClientForTest({ getStatus: installerStatus })
    setMetaOAuthIntegrationCentralClientForTest({ getStatus: installerStatus })

    const before = await databaseFingerprint()
    const controllers = [
      [getConfig, passiveRequest()],
      [getSyncSettings, passiveRequest()],
      [verifyToken, passiveRequest()],
      [getMetaCustomValues, passiveRequest()],
      [getMetaAssets, passiveRequest()],
      [getAdAccounts, passiveRequest()],
      [getPixels, passiveRequest({ query: { adAccountId: '123' } })],
      [getPages, passiveRequest()],
      [getSocialProfiles, passiveRequest({ query: { pageId: 'page-1', instagramAccountId: 'ig-1' } })],
      [getMetaWebhookInfo, passiveRequest()],
      [getMetaSocialMessagingSetup, passiveRequest()]
    ]
    for (const [controller, req] of controllers) {
      const res = responseRecorder()
      await controller(req, res)
      assert.equal(res.statusCode, 200, `${controller.name} debe responder desde estado local`)
      assert.equal(res.payload?.success, true, `${controller.name} conserva el contrato success`)
    }

    const legacyStatus = await getMetaOAuthConnectionStatus()
    const socialStatus = await getMetaOAuthIntegrationStatus('social')
    assert.equal(legacyStatus.remoteChecked, false)
    assert.equal(socialStatus.remoteChecked, false)
    assert.equal(socialStatus.appId, 'social-app')
    assert.equal(installerCalls, 0)
    assert.equal(await databaseFingerprint(), before, 'los GET no cifran, reconcilian, limpian ni escriben durante navegación')
    assert.equal((await db.get('SELECT access_token FROM meta_config LIMIT 1')).access_token, 'legacy-plain-token')
    assert.equal((await db.get("SELECT access_token FROM meta_oauth_integrations WHERE id = 'social-local'")).access_token, 'social-plain-token')

    const remoteLegacy = await refreshMetaOAuthConnectionStatus()
    const remoteSocial = await refreshMetaOAuthIntegrationStatus('social')
    assert.equal(remoteLegacy.remoteChecked, true)
    assert.equal(remoteSocial.remoteChecked, true)
    assert.equal(installerCalls, 2, 'sólo las dos acciones explícitas verifican Installer')
    assert.equal(await databaseFingerprint(), before, 'verificar status remoto tampoco reconcilia la base')
  })
})

test('Configuración trata un System User Token heredado como no conectado y ofrece sólo OAuth', async () => {
  await initializeMasterKey()
  await withIsolatedMetaSettings(async () => {
    await db.run(
      `INSERT INTO meta_config (
         ad_account_id, access_token, connection_mode, pixel_id, page_id,
         instagram_account_id, oauth_connected, oauth_validated
       ) VALUES (?, ?, 'manual_system_user', ?, ?, ?, 0, 0)`,
      ['manual-ad', 'manual-token', 'manual-pixel', 'manual-page', 'manual-instagram']
    )

    const before = await databaseFingerprint()
    const valuesResponse = responseRecorder()
    await getMetaCustomValues(passiveRequest(), valuesResponse)
    assert.equal(valuesResponse.statusCode, 200)
    assert.equal(valuesResponse.payload?.data?.accessToken, '')
    assert.equal(valuesResponse.payload?.data?.adAccountId, '')
    assert.equal(valuesResponse.payload?.data?.pageId, '')

    const configResponse = responseRecorder()
    await getConfig(passiveRequest(), configResponse)
    assert.equal(configResponse.statusCode, 200)
    assert.equal(configResponse.payload?.configured, false)
    assert.equal(await databaseFingerprint(), before, 'la migración visual no borra ni modifica el respaldo cifrado')
  })
})

test('endpoints manuales de Meta exigen OAuth y no aceptan tokens nuevos', async () => {
  for (const controller of [
    saveConfig,
    saveAndSyncMeta,
    saveMetaMessengerUserToken,
    syncFromHighLevel,
    revealMetaToken
  ]) {
    const res = responseRecorder()
    await controller(passiveRequest(), res)
    assert.equal(res.statusCode, 410, `${controller.name} debe retirar el flujo manual`)
    assert.equal(res.payload?.code, 'META_OAUTH_REQUIRED')
    assert.match(res.payload?.error || '', /Conectar con Meta/)
  }
})

test('snapshot manual conserva metadata, aísla tokens e invalida sin guardar secretos', async () => {
  await initializeMasterKey()
  await withIsolatedMetaSettings(async () => {
    const token = 'system-user-token-one'
    await saveMetaAssetSnapshot({
      updatedAt: new Date().toISOString(),
      adAccounts: [{ id: 'act_123', name: 'Cuenta principal' }],
      pages: [{ id: 'page-1', name: 'Página Uno' }],
      profiles: [{ platform: 'facebook', sourceId: 'page-1', name: 'Página Uno' }]
    }, { explicitAccessToken: token })
    await saveMetaAssetSnapshot({
      pixelsByAdAccount: {
        123: [{ id: 'pixel-1', name: 'Dataset Uno' }]
      }
    }, { explicitAccessToken: token })

    const sameConnection = await getMetaAssetSnapshot({ explicitAccessToken: token })
    assert.equal(sameConnection.adAccounts[0].name, 'Cuenta principal')
    assert.equal(sameConnection.pages[0].name, 'Página Uno')
    assert.equal(sameConnection.pixelsByAdAccount['123'][0].name, 'Dataset Uno')
    assert.deepEqual(
      (await getMetaAssetSnapshot({ explicitAccessToken: 'different-token' })).adAccounts,
      [],
      'un token distinto no puede ver el inventario anterior'
    )
    assert.equal(String(await getAppConfig('meta_asset_snapshot_v1')).includes(token), false)

    await clearMetaAssetSnapshot()
    assert.deepEqual((await getMetaAssetSnapshot({ explicitAccessToken: token })).adAccounts, [])
  })
})

test('Meta separa carga pasiva de refresh remoto y HighLevel se lee una sola vez sólo por POST', async () => {
  const [screen, routes, controller, metaAdsService, highLevelService] = await Promise.all([
    readSource('frontend/src/pages/Settings/MetaAdsIntegration.tsx'),
    readSource('backend/src/routes/meta.routes.js'),
    readSource('backend/src/controllers/metaController.js'),
    readSource('backend/src/services/metaAdsService.js'),
    readSource('backend/src/services/highlevelSyncService.js')
  ])

  assert.match(routes, /router\.get\('\/assets', getMetaAssets\)/)
  assert.match(routes, /router\.post\('\/assets\/refresh', refreshMetaAssets\)/)
  assert.match(routes, /router\.get\('\/oauth\/status', getMetaOAuthStatus\)/)
  assert.match(routes, /router\.post\('\/oauth\/status\/refresh', refreshMetaOAuthStatus\)/)

  const initialLoadStart = screen.indexOf('useEffect(() => {\n    void Promise.all([loadCredentials()')
  const initialLoadEnd = screen.indexOf('\n  useEffect(() => {', initialLoadStart + 1)
  assert.ok(initialLoadStart >= 0 && initialLoadEnd > initialLoadStart)
  assert.match(screen.slice(initialLoadStart, initialLoadEnd), /loadCachedMetaAssets\(\)/)
  assert.doesNotMatch(screen.slice(initialLoadStart, initialLoadEnd), /refreshMetaAssets|refreshMetaWizardStep/)
  assert.doesNotMatch(screen, /void refreshMetaWizardStep\(activeStep/)
  assert.match(screen, /scope: step === 2 \? 'pixels' : 'all'/)

  const localValues = getMetaCustomValues.toString()
  assert.doesNotMatch(localValues, /reconcileMetaBusinessWithHighLevel|fetchAndSaveMetaConfig|saveMetaCustomValues/)
  for (const reader of [getMetaAssets, getAdAccounts, getPixels, getPages, getSocialProfiles]) {
    assert.match(reader.toString(), /readLocalMetaAssetSnapshot/)
    assert.doesNotMatch(reader.toString(), /fetchMetaConnection|META_GRAPH|saveMetaAssetSnapshot/)
  }
  assert.match(controller, /const canReuseBaseSnapshot = requestedScope === 'pixels'/)
  assert.match(metaAdsService, /export async function getMetaDeveloperSetup\(\{ refresh = false \} = \{\}\)/)
  assert.match(metaAdsService, /if \(refresh && !appId\)/)
  assert.match(metaAdsService, /if \(refresh && appId && !businessId\)/)
  assert.match(metaAdsService, /normalizeId\(options\.appId\) \|\| existingMetaConfig\?\.app_id/)
  assert.match(controller, /appId: validation\.appId \|\| ''/)

  assert.equal(
    (reconcileMetaBusinessWithHighLevel.toString().match(/fetchHighLevelCustomValues\(/g) || []).length,
    1,
    'una reconciliación explícita hace una sola lectura de Custom Values'
  )
  assert.equal(
    (syncFromHighLevel.toString().match(/reconcileMetaBusinessWithHighLevel\(/g) || []).length,
    1,
    'el controlador no duplica la reconciliación'
  )
  assert.doesNotMatch(syncFromHighLevel.toString(), /fetchAndSaveMetaConfig/)
  assert.match(highLevelService, /direction === 'from_highlevel'/)
  assert.match(highLevelService, /const highLevelNeedsUpdate = !fromHighLevelOnly &&/)
  assert.match(controller, /POST \/api\/meta\/sync-from-highlevel/)
})
