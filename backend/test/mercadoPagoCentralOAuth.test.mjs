import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  createMercadoPagoOAuthUrl,
  getMercadoPagoPaymentConfig,
  syncMercadoPagoFromCentral
} from '../src/services/mercadoPagoPaymentService.js'
import { setVerifiedAppBaseUrlResolverForTests } from '../src/services/licenseService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'

const ENV_KEYS = [
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'APP_URL',
  'PUBLIC_APP_URL'
]

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function withMercadoPagoConfigSnapshot(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'"
  )
  const previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'mercadopago_%' OR config_key = 'payments_settings'")
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }

    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    setVerifiedAppBaseUrlResolverForTests()
  }
}

test('Mercado Pago central manda modo prueba y el cliente guarda secretos desde handoff local', async () => {
  await initializeMasterKey()

  await withMercadoPagoConfigSnapshot(async () => {
    let connectPayload = null
    let claimPayload = null

    const licenseServer = http.createServer(async (req, res) => {
      if (req.method !== 'POST') return writeJson(res, 404, { success: false, error: 'not_found' })
      const payload = await readJson(req)

      if (req.url === '/api/license/mercadopago/connect-url') {
        connectPayload = payload
        return writeJson(res, 200, {
          success: true,
          url: 'https://auth.mercadopago.com/authorization?client_id=mp_app&test=true',
          mode: 'test',
          redirect_uri: 'https://portal.test/api/mercadopago/connect/callback',
          webhook_url: 'https://app.test/api/mercadopago/webhook'
        })
      }

      if (req.url === '/api/license/oauth-handoff/claim') {
        claimPayload = payload
        assert.equal(payload.provider, 'mercadopago')
        assert.equal(payload.handoff_token, 'mp_handoff_test')
        return writeJson(res, 200, {
          success: true,
          handoff: {
            payload: {
              connection: {
                configured: true,
                connected: true,
                user_id: '998877',
                public_key: 'APP_USR-sandbox-public-key',
                scope: 'offline_access',
                livemode: false,
                mode: 'test',
                token_type: 'bearer',
                account_email: 'mp-sandbox@test.com',
                account_label: 'Mercado Pago Sandbox',
                webhook_url: 'https://app.test/api/mercadopago/webhook',
                token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
                connected_at: new Date().toISOString(),
                access_token: 'APP_USR-sandbox-access-token',
                refresh_token: 'TG-sandbox-refresh-token',
                webhook_secret: 'mp_sandbox_webhook_secret'
              }
            }
          }
        })
      }

      return writeJson(res, 404, { success: false, error: 'not_found' })
    })

    await new Promise(resolve => licenseServer.listen(0, '127.0.0.1', resolve))
    const baseUrl = `http://127.0.0.1:${licenseServer.address().port}`

    try {
      process.env.LICENSE_SERVER_URL = baseUrl
      process.env.CLIENT_ID = 'cli_mp_central'
      process.env.LICENSE_KEY = 'lic_mp_central'
      process.env.INSTALLATION_ID = 'inst_mp_central'
      process.env.APP_URL = 'https://app.test'
      setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.test')
      await savePaymentSettings({ paymentMode: 'test' })

      const oauth = await createMercadoPagoOAuthUrl({
        appUrl: 'https://app.test',
        returnPath: '/settings/payments/mercadopago'
      })

      assert.equal(oauth.mode, 'test')
      assert.equal(oauth.url, 'https://auth.mercadopago.com/authorization?client_id=mp_app&test=true')
      assert.equal(oauth.redirectUri, 'https://portal.test/api/mercadopago/connect/callback')
      assert.equal(oauth.webhookUrl, 'https://app.test/api/mercadopago/webhook')
      assert.equal(connectPayload.mode, 'test')
      assert.equal(connectPayload.client_id, 'cli_mp_central')
      assert.equal(connectPayload.license_key, 'lic_mp_central')
      assert.equal(connectPayload.installation_id, 'inst_mp_central')
      assert.equal(connectPayload.app_url, 'https://app.test')
      assert.equal(connectPayload.return_path, '/settings/payments/mercadopago')

      const config = await syncMercadoPagoFromCentral({ handoffToken: 'mp_handoff_test' })
      assert.equal(claimPayload.client_id, 'cli_mp_central')
      assert.equal(config.configured, true)
      assert.equal(config.mode, 'test')
      assert.equal(config.livemode, false)
      assert.equal(config.accountLabel, 'Mercado Pago Sandbox')
      assert.equal(config.publicKey, 'APP_USR-sandbox-public-key')
      assert.equal(config.hasAccessToken, true)
      assert.equal(config.hasRefreshToken, true)
      assert.equal(config.hasWebhookSecret, true)
      assert.equal(config.modeConnections.test.connected, true)
      assert.equal(config.modeConnections.test.accountLabel, 'Mercado Pago Sandbox')
      assert.equal(config.modeConnections.test.hasRefreshToken, true)
      assert.equal(config.modeConnections.test.hasWebhookSecret, true)
      assert.equal(config.modeConnections.live.connected, false)

      const liveConfig = await getMercadoPagoPaymentConfig({ mode: 'live' })
      assert.equal(liveConfig.configured, false)
      assert.equal(liveConfig.hasAccessToken, false)

      const secrets = await getMercadoPagoPaymentConfig({ includeSecrets: true })
      assert.equal(secrets.accessToken, 'APP_USR-sandbox-access-token')
      assert.equal(secrets.refreshToken, 'TG-sandbox-refresh-token')
      assert.equal(secrets.webhookSecret, 'mp_sandbox_webhook_secret')
    } finally {
      licenseServer.closeAllConnections?.()
      await new Promise(resolve => licenseServer.close(resolve))
    }
  })
})
