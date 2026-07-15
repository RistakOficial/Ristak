import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, setAppConfig } from '../src/config/database.js'
import {
  completeMetaDirectEmbeddedSignup,
  prepareMetaDirectEmbeddedSignup,
  setMetaDirectFetchForTest
} from '../src/services/whatsappApiService.js'

const testDir = dirname(fileURLToPath(import.meta.url))

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('el tenant prepara y completa Embedded Signup por backend sin exponer tokens al navegador', async () => {
  const keys = [
    'license_key',
    'license_client_id',
    'installation_id',
    'public_app_url',
    'sites_app_domain',
    'sites_app_domain_verified'
  ]
  const previousRows = await db.all(
    `SELECT config_key, config_value FROM app_config WHERE config_key IN (${keys.map(() => '?').join(',')})`,
    keys
  )
  const previousPortal = process.env.META_WHATSAPP_PUBLIC_URL
  const requests = []
  try {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${keys.map(() => '?').join(',')})`, keys)
    await setAppConfig('license_key', 'signup-license-secret')
    await setAppConfig('license_client_id', 'client-signup-test')
    await setAppConfig('installation_id', 'installation-signup-test')
    await setAppConfig('public_app_url', 'https://tenant-signup.test')
    await setAppConfig('sites_app_domain', 'app.ristak.com')
    await setAppConfig('sites_app_domain_verified', '1')
    process.env.META_WHATSAPP_PUBLIC_URL = 'https://installer-signup.test'
    setMetaDirectFetchForTest(async (input, options = {}) => {
      const url = new URL(String(input))
      const body = JSON.parse(options.body || '{}')
      requests.push({ url, body })
      if (url.pathname.endsWith('/session')) {
        return json({
          success: true,
          session: {
            status: 'pending',
            appId: 'public-app-id',
            configId: 'public-config-id',
            configVersion: 'v4',
            graphVersion: 'v25.0',
            featureType: 'whatsapp_business_app_onboarding',
            sessionInfoVersion: '3',
            loginExtras: { featureType: 'whatsapp_business_app_onboarding' }
          }
        })
      }
      if (url.pathname.endsWith('/complete')) {
        return json({ success: true, result: { completed: true, wabaId: 'waba-1' } })
      }
      return json({ success: false, error: 'ruta inesperada' }, 404)
    })

    const session = await prepareMetaDirectEmbeddedSignup({ appUrl: 'https://tenant-signup.test' })
    assert.equal(session.appId, 'public-app-id')
    assert.equal(session.configId, 'public-config-id')
    assert.ok(session.state)
    assert.equal(new URL(session.connectUrl).origin, 'https://installer-signup.test')
    assert.equal(new URL(session.connectUrl).pathname, '/meta/whatsapp/connect')
    assert.equal(new URL(session.connectUrl).searchParams.get('state'), session.state)
    const stateBody = session.state.slice(0, session.state.lastIndexOf('.'))
    const statePayload = JSON.parse(Buffer.from(stateBody, 'base64url').toString('utf8'))
    assert.equal(statePayload.app_url, 'https://tenant-signup.test')
    assert.deepEqual(session.loginExtras, { featureType: 'whatsapp_business_app_onboarding' })
    assert.equal('systemUserToken' in session, false)
    assert.equal(requests[0].url.origin, 'https://installer-signup.test')

    const result = await completeMetaDirectEmbeddedSignup({
      state: session.state,
      code: 'single-popup-code',
      signupData: { wabaId: 'waba-1', phoneNumberId: 'phone-1' }
    })
    assert.equal(result.completed, true)
    assert.equal(requests[1].body.code, 'single-popup-code')
  } finally {
    setMetaDirectFetchForTest(null)
    if (previousPortal === undefined) delete process.env.META_WHATSAPP_PUBLIC_URL
    else process.env.META_WHATSAPP_PUBLIC_URL = previousPortal
    await db.run(`DELETE FROM app_config WHERE config_key IN (${keys.map(() => '?').join(',')})`, keys)
    for (const row of previousRows) await setAppConfig(row.config_key, row.config_value)
  }
})

test('los callbacks HMAC quedan antes de auth y las rutas humanas siguen protegidas dentro del router', async () => {
  const [serverSource, routesSource, settingsSource] = await Promise.all([
    readFile(join(testDir, '../src/server.js'), 'utf8'),
    readFile(join(testDir, '../src/routes/whatsappApi.routes.js'), 'utf8'),
    readFile(join(testDir, '../../frontend/src/pages/Settings/WhatsAppSettings.tsx'), 'utf8')
  ])
  assert.match(
    serverSource,
    /app\.use\('\/api\/whatsapp-api', requireWhatsAppFeatureForWhatsAppApiRoute, whatsappApiRoutes\)/
  )
  assert.doesNotMatch(
    serverSource,
    /app\.use\('\/api\/whatsapp-api', requireAuth, requireWhatsAppFeatureForWhatsAppApiRoute/
  )
  assert.ok(
    serverSource.indexOf("app.use('/api/whatsapp-api'") < serverSource.indexOf("app.use('/api', costsRoutes)"),
    'WhatsApp debe montarse antes del router catch-all de costos'
  )
  const callbackIndex = routesSource.indexOf("router.post('/meta/connect/complete'")
  const authIndex = routesSource.indexOf('router.use(requireAuth)')
  const statusIndex = routesSource.indexOf("router.get('/status'")
  assert.ok(callbackIndex >= 0 && callbackIndex < authIndex)
  assert.ok(statusIndex > authIndex)
  assert.doesNotMatch(settingsSource, /window\.FB\.login\(/)
  assert.doesNotMatch(settingsSource, /window\.open\([^\n]*ristak-whatsapp-meta/)
  assert.match(settingsSource, /window\.location\.assign\(connectUrl/)
})
