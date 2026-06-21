import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { db } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  completeStripeConnectOAuth,
  createStripeConnectOAuthUrl,
  deleteStripePaymentConfig,
  getStripePaymentConfig,
  saveStripePaymentConfig,
  setStripeConnectActiveMode,
  setStripeFactoryForTest,
  syncStripeConnectFromCentral,
  testStripePaymentConfig
} from '../src/services/stripePaymentService.js'

const STRIPE_ENV_KEYS = [
  'STRIPE_CONNECT_OAUTH_ENABLED',
  'STRIPE_CONNECT_TEST_CLIENT_ID',
  'STRIPE_CONNECT_TEST_SECRET_KEY',
  'STRIPE_CONNECT_TEST_PUBLISHABLE_KEY',
  'STRIPE_CONNECT_LIVE_CLIENT_ID',
  'STRIPE_CONNECT_LIVE_SECRET_KEY',
  'STRIPE_CONNECT_LIVE_PUBLISHABLE_KEY'
]

async function snapshotStripeConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'stripe_%'"
  )
  const previousEnv = Object.fromEntries(STRIPE_ENV_KEYS.map((key) => [key, process.env[key]]))

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%'")
    for (const key of STRIPE_ENV_KEYS) delete process.env[key]
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
    setStripeFactoryForTest(null)
  }
}

test('Stripe manual: guarda Restricted API Key cifrada como flujo oficial', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    const config = await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_manual_public',
      secretKey: 'rk_test_manual_restricted',
      webhookSecret: 'whsec_manual_secret',
      accountLabel: 'Stripe usuario'
    })

    assert.equal(config.configured, true)
    assert.equal(config.connectionType, 'manual')
    assert.equal(config.configurationStatus, 'configured_manually')
    assert.equal(config.accountLabel, 'Stripe usuario')
    assert.equal(config.hasSecretKey, true)
    assert.equal(config.secretKey, undefined)

    const secretRow = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['stripe_secret_key_encrypted']
    )
    assert.ok(secretRow?.config_value)
    assert.notEqual(secretRow.config_value, 'rk_test_manual_restricted')
  })
})

test('Stripe manual: prueba conexión con una llamada mínima sin exponer la key', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    let receivedSecretKey = ''
    setStripeFactoryForTest((secretKey) => {
      receivedSecretKey = secretKey
      return {
        balance: {
          retrieve: async () => ({
            livemode: false,
            available: [{ amount: 1000, currency: 'mxn' }]
          })
        }
      }
    })

    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_manual_public',
      secretKey: 'rk_test_manual_restricted',
      accountLabel: 'Stripe usuario'
    })

    const result = await testStripePaymentConfig()

    assert.equal(result.ok, true)
    assert.equal(result.connectionType, 'manual')
    assert.equal(result.livemode, false)
    assert.equal(result.available, 1)
    assert.equal(receivedSecretKey, 'rk_test_manual_restricted')
    assert.equal(JSON.stringify(result).includes('rk_test_manual_restricted'), false)
  })
})

test('Stripe manual: desconecta y elimina credenciales guardadas', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_manual_public',
      secretKey: 'rk_test_manual_restricted',
      webhookSecret: 'whsec_manual_secret',
      accountLabel: 'Stripe usuario'
    })

    const config = await deleteStripePaymentConfig()
    assert.equal(config.configured, false)
    assert.equal(config.connectionType, 'manual')
    assert.equal(config.configurationStatus, 'disconnected')

    const credentialRows = await db.all(
      `SELECT config_key FROM app_config
       WHERE config_key IN ('stripe_publishable_key', 'stripe_secret_key_encrypted', 'stripe_webhook_secret_encrypted')`
    )
    assert.equal(credentialRows.length, 0)
  })
})

test('Stripe OAuth queda desactivado por defecto aunque existan variables Connect', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    process.env.STRIPE_CONNECT_TEST_CLIENT_ID = 'ca_test_client'
    process.env.STRIPE_CONNECT_TEST_SECRET_KEY = 'sk_test_platform'
    process.env.STRIPE_CONNECT_TEST_PUBLISHABLE_KEY = 'pk_test_platform'

    await assert.rejects(
      () => createStripeConnectOAuthUrl({
        mode: 'test',
        baseUrl: 'https://app.example.com',
        returnPath: '/settings/payments/stripe'
      }),
      (error) => error?.status === 404 && /Configura Stripe manualmente/i.test(error.message)
    )
    await assert.rejects(() => syncStripeConnectFromCentral({ handoffToken: 'test' }), { status: 404 })
    await assert.rejects(() => setStripeConnectActiveMode('test'), { status: 404 })
    await assert.rejects(() => completeStripeConnectOAuth({ code: 'code', state: 'state' }), { status: 404 })
  })
})

test('Stripe OAuth legacy guardado no cuenta como configuración oficial cuando el flag está apagado', async () => {
  await snapshotStripeConfig(async () => {
    await db.run(
      `INSERT INTO app_config (config_key, config_value, updated_at)
       VALUES
         ('stripe_enabled', '1', CURRENT_TIMESTAMP),
         ('stripe_connection_type', 'connect', CURRENT_TIMESTAMP),
         ('stripe_publishable_key', 'pk_test_connected', CURRENT_TIMESTAMP),
         ('stripe_connect_account_id', 'acct_legacy_connect', CURRENT_TIMESTAMP),
         ('stripe_connect_access_token_encrypted', 'sk_test_connected_access', CURRENT_TIMESTAMP)`
    )

    const config = await getStripePaymentConfig()

    assert.equal(config.configured, false)
    assert.equal(config.connectionType, 'manual')
    assert.equal(config.configurationStatus, 'disconnected')
    assert.equal(config.connectedAccountId, '')
    assert.equal(config.stripeConnectOAuthEnabled, false)
  })
})

test('Stripe manual: la UI oficial no expone rutas ni copy de OAuth', async () => {
  const settingsPath = fileURLToPath(new URL('../../frontend/src/pages/Settings/PaymentsConfiguration.tsx', import.meta.url))
  const servicePath = fileURLToPath(new URL('../../frontend/src/services/stripePaymentsService.ts', import.meta.url))
  const settingsSource = await readFile(settingsPath, 'utf8')
  const serviceSource = await readFile(servicePath, 'utf8')
  const officialUiSource = `${settingsSource}\n${serviceSource}`

  assert.match(officialUiSource, /Restricted API Key/)
  assert.match(officialUiSource, /Ristak no procesa pagos en nombre de terceros/)
  assert.doesNotMatch(officialUiSource, /Stripe Connect/)
  assert.doesNotMatch(officialUiSource, /stripe_connect/)
  assert.doesNotMatch(officialUiSource, /\/api\/stripe\/connect/)
  assert.doesNotMatch(officialUiSource, /Conectar con Stripe/)
})
