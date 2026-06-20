import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  completeStripeConnectOAuth,
  createStripeConnectOAuthUrl,
  setStripeConnectActiveMode,
  setStripeConnectFetchForTest,
  setStripeFactoryForTest,
  syncStripeConnectFromCentral,
  testStripePaymentConfig
} from '../src/services/stripePaymentService.js'
import { setVerifiedAppBaseUrlResolverForTests } from '../src/services/licenseService.js'

const STRIPE_ENV_KEYS = [
  'STRIPE_CONNECT_TEST_CLIENT_ID',
  'STRIPE_CONNECT_TEST_SECRET_KEY',
  'STRIPE_CONNECT_TEST_PUBLISHABLE_KEY',
  'STRIPE_CONNECT_LIVE_CLIENT_ID',
  'STRIPE_CONNECT_LIVE_SECRET_KEY',
  'STRIPE_CONNECT_LIVE_PUBLISHABLE_KEY',
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'APP_URL'
]

async function snapshotStripeConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'stripe_%'"
  )
  const previousEnv = Object.fromEntries(STRIPE_ENV_KEYS.map((key) => [key, process.env[key]]))

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
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
    setStripeConnectFetchForTest(null)
    setStripeFactoryForTest(null)
    setVerifiedAppBaseUrlResolverForTests()
  }
}

function mockOAuthResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body
  }
}

test('Stripe Connect OAuth guarda cuenta, scopes y webhook automatico', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    process.env.STRIPE_CONNECT_TEST_CLIENT_ID = 'ca_test_client'
    process.env.STRIPE_CONNECT_TEST_SECRET_KEY = 'sk_test_platform'
    process.env.STRIPE_CONNECT_TEST_PUBLISHABLE_KEY = 'pk_test_platform'

    let webhookCreatePayload = null
    let webhookCreateOptions = null
    let balanceOptions = null

    setStripeConnectFetchForTest(async (url, options = {}) => {
      assert.equal(url, 'https://connect.stripe.com/oauth/token')
      const params = new URLSearchParams(String(options.body))
      assert.equal(params.get('grant_type'), 'authorization_code')
      assert.equal(params.get('code'), 'ac_test_code')
      assert.match(String(options.headers?.Authorization || ''), /^Basic /)

      return mockOAuthResponse({
        scope: 'read_write',
        stripe_user_id: 'acct_test_connected',
        livemode: false,
        token_type: 'bearer',
        access_token: 'sk_test_connected_access',
        refresh_token: 'rt_test_connected',
        stripe_publishable_key: 'pk_test_connected'
      })
    })

    setStripeFactoryForTest((secretKey) => {
      if (secretKey === 'sk_test_connected_access') {
        return {
          balance: {
            retrieve: async (_params = {}, options = {}) => {
              balanceOptions = options
              return {
                livemode: false,
                available: [{ amount: 1000, currency: 'mxn' }]
              }
            }
          }
        }
      }

      assert.equal(secretKey, 'sk_test_platform')
      return {
        accounts: {
          retrieve: async (accountId) => {
            assert.equal(accountId, 'acct_test_connected')
            return {
              id: accountId,
              email: 'owner@example.com',
              charges_enabled: true,
              payouts_enabled: true,
              details_submitted: true,
              business_profile: {
                name: 'Ristak Test Stripe'
              }
            }
          }
        },
        webhookEndpoints: {
          create: async (payload, options = {}) => {
            webhookCreatePayload = payload
            webhookCreateOptions = options
            return {
              id: 'we_test_123',
              url: payload.url,
              secret: 'whsec_test_123'
            }
          },
          del: async () => ({ deleted: true })
        }
      }
    })

    const started = await createStripeConnectOAuthUrl({
      mode: 'test',
      baseUrl: 'https://app.example.com',
      returnPath: '/settings/payments/stripe'
    })
    const authorizeUrl = new URL(started.url)
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, 'https://connect.stripe.com/oauth/authorize')
    assert.equal(authorizeUrl.searchParams.get('client_id'), 'ca_test_client')
    assert.equal(authorizeUrl.searchParams.get('scope'), 'read_write')
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), 'https://app.example.com/api/stripe/connect/callback')

    const completed = await completeStripeConnectOAuth({
      code: 'ac_test_code',
      state: authorizeUrl.searchParams.get('state'),
      baseUrl: 'https://app.example.com'
    })

    assert.equal(completed.config.connectionType, 'connect')
    assert.equal(completed.config.configured, true)
    assert.equal(completed.config.connectedAccountId, 'acct_test_connected')
    assert.equal(completed.config.accountLabel, 'Ristak Test Stripe')
    assert.equal(completed.config.publishableKey, 'pk_test_connected')
    assert.equal(completed.config.connectScope, 'read_write')
    assert.equal(completed.config.connectUsesAccessToken, true)
    assert.equal(completed.config.connectUsesPlatformAccountHeader, false)
    assert.equal(completed.config.hasWebhookSecret, true)
    assert.equal(completed.config.connectWebhookEndpointId, 'we_test_123')
    assert.equal(completed.config.connectWebhookStatus, 'active')

    assert.equal(webhookCreatePayload.url, 'https://app.example.com/api/stripe/webhook')
    assert.equal(webhookCreatePayload.connect, true)
    assert.deepEqual(webhookCreatePayload.enabled_events.includes('payment_intent.succeeded'), true)
    assert.deepEqual(webhookCreateOptions, {})

    const testResult = await testStripePaymentConfig()
    assert.equal(testResult.connectionType, 'connect')
    assert.equal(testResult.connectedAccountId, 'acct_test_connected')
    assert.deepEqual(balanceOptions, {})
  })
})

test('Stripe Connect OAuth conserva conexiones separadas para prueba y en vivo', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    process.env.STRIPE_CONNECT_TEST_CLIENT_ID = 'ca_test_client'
    process.env.STRIPE_CONNECT_TEST_SECRET_KEY = 'sk_test_platform'
    process.env.STRIPE_CONNECT_TEST_PUBLISHABLE_KEY = 'pk_test_platform'
    process.env.STRIPE_CONNECT_LIVE_CLIENT_ID = 'ca_live_client'
    process.env.STRIPE_CONNECT_LIVE_SECRET_KEY = 'sk_live_platform'
    process.env.STRIPE_CONNECT_LIVE_PUBLISHABLE_KEY = 'pk_live_platform'

    const oauthByCode = {
      ac_test_code: {
        scope: 'read_write',
        stripe_user_id: 'acct_test_connected',
        livemode: false,
        token_type: 'bearer',
        access_token: 'sk_test_connected_access',
        refresh_token: 'rt_test_connected',
        stripe_publishable_key: 'pk_test_connected'
      },
      ac_live_code: {
        scope: 'read_write',
        stripe_user_id: 'acct_live_connected',
        livemode: true,
        token_type: 'bearer',
        access_token: 'sk_live_connected_access',
        refresh_token: 'rt_live_connected',
        stripe_publishable_key: 'pk_live_connected'
      }
    }
    const balanceSecrets = []

    setStripeConnectFetchForTest(async (_url, options = {}) => {
      const params = new URLSearchParams(String(options.body))
      const response = oauthByCode[params.get('code')]
      assert.ok(response, 'OAuth code esperado en test')
      return mockOAuthResponse(response)
    })

    setStripeFactoryForTest((secretKey) => {
      if (secretKey === 'sk_test_connected_access' || secretKey === 'sk_live_connected_access') {
        return {
          balance: {
            retrieve: async () => {
              balanceSecrets.push(secretKey)
              return {
                livemode: secretKey.startsWith('sk_live_'),
                available: [{ amount: 1000, currency: 'mxn' }]
              }
            }
          }
        }
      }

      assert.ok(['sk_test_platform', 'sk_live_platform'].includes(secretKey))
      return {
        accounts: {
          retrieve: async (accountId) => ({
            id: accountId,
            email: `${accountId}@stripe.test`,
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
            business_profile: {
              name: accountId.includes('live') ? 'Stripe Live' : 'Stripe Test'
            }
          })
        },
        webhookEndpoints: {
          create: async (payload, options = {}) => {
            assert.equal(payload.connect, true)
            assert.deepEqual(options, {})
            const accountId = payload.metadata?.stripe_account_id
            assert.ok(accountId)
            return {
              id: `we_${accountId}`,
              url: payload.url,
              secret: `whsec_${accountId}`
            }
          },
          del: async () => ({ deleted: true })
        }
      }
    })

    const startedTest = await createStripeConnectOAuthUrl({
      mode: 'test',
      baseUrl: 'https://app.example.com',
      returnPath: '/settings/payments/stripe?stripe_setup=dual&stripe_step=test'
    })
    const testUrl = new URL(startedTest.url)
    const completedTest = await completeStripeConnectOAuth({
      code: 'ac_test_code',
      state: testUrl.searchParams.get('state'),
      baseUrl: 'https://app.example.com'
    })

    assert.equal(completedTest.config.mode, 'test')
    assert.equal(completedTest.config.connectModes.test.connected, true)
    assert.equal(completedTest.config.connectModes.live.connected, false)

    const startedLive = await createStripeConnectOAuthUrl({
      mode: 'live',
      baseUrl: 'https://app.example.com',
      returnPath: '/settings/payments/stripe?stripe_setup=dual&stripe_step=live'
    })
    const liveUrl = new URL(startedLive.url)
    const completedLive = await completeStripeConnectOAuth({
      code: 'ac_live_code',
      state: liveUrl.searchParams.get('state'),
      baseUrl: 'https://app.example.com'
    })

    assert.equal(completedLive.config.mode, 'live')
    assert.equal(completedLive.config.connectModes.test.connected, true)
    assert.equal(completedLive.config.connectModes.live.connected, true)
    assert.equal(completedLive.config.connectedAccountId, 'acct_live_connected')
    assert.equal(completedLive.config.publishableKey, 'pk_live_connected')

    const testConfig = await setStripeConnectActiveMode('test')
    assert.equal(testConfig.mode, 'test')
    assert.equal(testConfig.connectedAccountId, 'acct_test_connected')
    assert.equal(testConfig.publishableKey, 'pk_test_connected')

    const testResult = await testStripePaymentConfig()
    assert.equal(testResult.livemode, false)

    const liveConfig = await setStripeConnectActiveMode('live')
    assert.equal(liveConfig.mode, 'live')
    assert.equal(liveConfig.connectedAccountId, 'acct_live_connected')

    const liveResult = await testStripePaymentConfig()
    assert.equal(liveResult.livemode, true)
    assert.deepEqual(balanceSecrets, ['sk_test_connected_access', 'sk_live_connected_access'])
  })
})

async function startCentralStripeServer({ expectedAppUrl = 'https://app.example.com' } = {}) {
  let lastRequestBody = null
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      lastRequestBody = rawBody ? JSON.parse(rawBody) : null
      res.setHeader('Content-Type', 'application/json')

      if (req.url === '/api/license/stripe-connect/connect-url') {
        assert.equal(lastRequestBody.client_id, 'cli_test_stripe')
        assert.equal(lastRequestBody.license_key, 'RSTK-STRIPE-TEST')
        assert.equal(lastRequestBody.installation_id, 'inst_test_stripe')
        assert.equal(lastRequestBody.app_url, expectedAppUrl)
        assert.equal(lastRequestBody.mode, 'test')
        res.end(JSON.stringify({
          success: true,
          url: 'https://connect.stripe.com/oauth/authorize?state=central_state',
          mode: 'test',
          redirect_uri: 'https://portal.test/api/stripe/connect/callback',
          webhook_url: `${expectedAppUrl}/api/stripe/webhook`
        }))
        return
      }

      if (req.url === '/api/license/stripe-connect/status') {
        assert.equal(lastRequestBody.client_id, 'cli_test_stripe')
        res.end(JSON.stringify({
          success: true,
          connection: {
            connected: true,
            mode: 'test',
            account_id: 'acct_central_connected',
            publishable_key: 'pk_test_connected',
            scope: 'read_write',
            livemode: false,
            token_type: 'bearer',
            account_email: 'owner@stripe.test',
            account_label: 'Stripe Central',
            charges_enabled: true,
            payouts_enabled: true,
            details_submitted: true,
            webhook_endpoint_id: 'we_central_123',
            webhook_url: `${expectedAppUrl}/api/stripe/webhook`,
            webhook_status: 'active',
            connected_at: '2026-06-19T00:00:00.000Z',
            access_token: 'sk_test_connected_access',
            refresh_token: 'rt_test_connected',
            webhook_secret: 'whsec_central_123'
          }
        }))
        return
      }

      if (req.url === '/api/license/stripe-connect/disconnect') {
        res.end(JSON.stringify({ success: true, connection: { connected: false } }))
        return
      }

      res.statusCode = 404
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`
  }
}

test('Stripe Connect central delega OAuth al Installer y sincroniza credenciales', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    const tenantAppUrl = 'https://raulgomez.onrender.com'
    const central = await startCentralStripeServer({ expectedAppUrl: tenantAppUrl })
    try {
      process.env.LICENSE_SERVER_URL = central.baseUrl
      process.env.CLIENT_ID = 'cli_test_stripe'
      process.env.LICENSE_KEY = 'RSTK-STRIPE-TEST'
      process.env.INSTALLATION_ID = 'inst_test_stripe'
      process.env.APP_URL = 'https://render.example.com'
      setVerifiedAppBaseUrlResolverForTests(async () => 'https://app.example.com')

      let balanceOptions = null
      setStripeFactoryForTest((secretKey) => {
        assert.equal(secretKey, 'sk_test_connected_access')
        return {
          balance: {
            retrieve: async (_params = {}, options = {}) => {
              balanceOptions = options
              return { livemode: false, available: [{ amount: 300, currency: 'mxn' }] }
            }
          }
        }
      })

      const started = await createStripeConnectOAuthUrl({
        mode: 'test',
        baseUrl: 'https://app.ristak.com',
        appUrl: tenantAppUrl,
        returnPath: '/settings/payments/stripe'
      })
      assert.equal(started.url, 'https://connect.stripe.com/oauth/authorize?state=central_state')
      assert.equal(started.managedByPortal, true)
      assert.equal(started.redirectUri, 'https://portal.test/api/stripe/connect/callback')

      const config = await syncStripeConnectFromCentral()
      assert.equal(config.configured, true)
      assert.equal(config.connectionType, 'connect')
      assert.equal(config.connectManagedByPortal, true)
      assert.equal(config.connectedAccountId, 'acct_central_connected')
      assert.equal(config.publishableKey, 'pk_test_connected')
      assert.equal(config.hasWebhookSecret, true)
      assert.equal(config.connectUsesAccessToken, true)
      assert.equal(config.connectUsesPlatformAccountHeader, false)
      assert.equal(config.connectWebhookStatus, 'active')

      const result = await testStripePaymentConfig()
      assert.equal(result.connectionType, 'connect')
      assert.equal(result.connectedAccountId, 'acct_central_connected')
      assert.deepEqual(balanceOptions, {})
    } finally {
      central.server.closeAllConnections?.()
      central.server.close()
    }
  })
})
