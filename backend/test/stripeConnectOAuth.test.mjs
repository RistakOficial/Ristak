import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  completeStripeConnectOAuth,
  createStripeConnectOAuthUrl,
  setStripeConnectFetchForTest,
  setStripeFactoryForTest,
  testStripePaymentConfig
} from '../src/services/stripePaymentService.js'

const STRIPE_ENV_KEYS = [
  'STRIPE_CONNECT_TEST_CLIENT_ID',
  'STRIPE_CONNECT_TEST_SECRET_KEY',
  'STRIPE_CONNECT_TEST_PUBLISHABLE_KEY'
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
        balance: {
          retrieve: async (_params = {}, options = {}) => {
            balanceOptions = options
            return {
              livemode: false,
              available: [{ amount: 1000, currency: 'mxn' }]
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
    assert.equal(completed.config.publishableKey, 'pk_test_platform')
    assert.equal(completed.config.connectScope, 'read_write')
    assert.equal(completed.config.hasWebhookSecret, true)
    assert.equal(completed.config.connectWebhookEndpointId, 'we_test_123')
    assert.equal(completed.config.connectWebhookStatus, 'active')

    assert.equal(webhookCreatePayload.url, 'https://app.example.com/api/stripe/webhook')
    assert.deepEqual(webhookCreatePayload.enabled_events.includes('payment_intent.succeeded'), true)
    assert.deepEqual(webhookCreateOptions, { stripeAccount: 'acct_test_connected' })

    const testResult = await testStripePaymentConfig()
    assert.equal(testResult.connectionType, 'connect')
    assert.equal(testResult.connectedAccountId, 'acct_test_connected')
    assert.deepEqual(balanceOptions, { stripeAccount: 'acct_test_connected' })
  })
})
