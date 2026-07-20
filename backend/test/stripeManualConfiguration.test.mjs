import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { db } from '../src/config/database.js'
import { getStripeConfigView, saveStripeConfigView } from '../src/controllers/stripePaymentsController.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import {
  deleteStripePaymentConfig,
  getStripePaymentConfig,
  reconcileStripeWebhookConfiguration,
  saveStripePaymentConfig,
  setStripeFactoryForTest,
  testStripePaymentConfig
} from '../src/services/stripePaymentService.js'

const STRIPE_ENV_KEYS = [
  'RENDER_EXTERNAL_URL',
  'PUBLIC_APP_URL',
  'APP_PUBLIC_URL',
  'FRONTEND_URL',
  'APP_URL',
  'INSTALLATION_ID',
  'RISTAK_INSTALLATION_ID',
  'RENDER_SERVICE_ID'
]

async function snapshotStripeConfig(callback) {
  const previousRows = await db.all(
    "SELECT config_key, config_value FROM app_config WHERE config_key LIKE 'stripe_%' OR config_key = 'payments_settings'"
  )
  const previousEnv = Object.fromEntries(STRIPE_ENV_KEYS.map((key) => [key, process.env[key]]))

  try {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%' OR config_key = 'payments_settings'")
    for (const key of STRIPE_ENV_KEYS) delete process.env[key]
    return await callback()
  } finally {
    await db.run("DELETE FROM app_config WHERE config_key LIKE 'stripe_%' OR config_key = 'payments_settings'")
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

function createJsonResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

test('Stripe manual: el modo global de pasarelas selecciona las credenciales activas', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: 'pk_test_global_public',
          secretKey: 'sk_test_global_secret',
          webhookSecret: 'whsec_global_test'
        },
        live: {
          publishableKey: 'pk_live_global_public',
          secretKey: 'sk_live_global_secret',
          webhookSecret: 'whsec_global_live'
        }
      }
    })

    await savePaymentSettings({ paymentMode: 'test' })
    const testConfig = await getStripePaymentConfig({ includeSecrets: true })
    assert.equal(testConfig.mode, 'test')
    assert.equal(testConfig.configured, true)
    assert.equal(testConfig.publishableKey, 'pk_test_global_public')
    assert.equal(testConfig.secretKey, 'sk_test_global_secret')
    assert.equal(testConfig.webhookSecret, 'whsec_global_test')

    await savePaymentSettings({ paymentMode: 'live' })
    const liveConfig = await getStripePaymentConfig({ includeSecrets: true })
    assert.equal(liveConfig.mode, 'live')
    assert.equal(liveConfig.configured, true)
    assert.equal(liveConfig.publishableKey, 'pk_live_global_public')
    assert.equal(liveConfig.secretKey, 'sk_live_global_secret')
    assert.equal(liveConfig.webhookSecret, 'whsec_global_live')
  })
})

test('Stripe manual: guarda Secret keys de prueba y en vivo cifradas como flujo oficial', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    const config = await saveStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: 'pk_test_manual_public',
          secretKey: 'sk_test_manual_secret',
          webhookSecret: 'whsec_manual_test'
        },
        live: {
          publishableKey: 'pk_live_manual_public',
          secretKey: 'sk_live_manual_secret',
          webhookSecret: 'whsec_manual_live'
        }
      }
    })

    assert.equal(config.configured, true)
    assert.equal(config.connectionType, 'manual')
    assert.equal(config.configurationStatus, 'configured_manually')
    assert.equal(config.mode, 'live')
    assert.equal(config.hasSecretKey, true)
    assert.equal(config.manualModes.test.configured, true)
    assert.equal(config.manualModes.live.configured, true)
    assert.equal(config.manualModes.test.publishableKey, 'pk_test_manual_public')
    assert.equal(config.manualModes.live.publishableKey, 'pk_live_manual_public')
    assert.equal(config.secretKey, undefined)

    const secretRow = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['stripe_secret_key_encrypted']
    )
    assert.ok(secretRow?.config_value)
    assert.notEqual(secretRow.config_value, 'sk_live_manual_secret')

    const modesRow = await db.get(
      'SELECT config_value FROM app_config WHERE config_key = ?',
      ['stripe_manual_mode_connections']
    )
    assert.ok(modesRow?.config_value)
    assert.equal(modesRow.config_value.includes('sk_test_manual_secret'), false)
    assert.equal(modesRow.config_value.includes('sk_live_manual_secret'), false)
  })
})

test('Stripe manual: conserva Secret keys existentes cuando la UI reenvía valores enmascarados', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    const initial = await saveStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: 'pk_test_manual_public',
          secretKey: 'sk_test_manual_secret',
          webhookSecret: 'whsec_manual_test'
        },
        live: {
          publishableKey: 'pk_live_manual_public',
          secretKey: 'sk_live_manual_secret',
          webhookSecret: 'whsec_manual_live'
        }
      }
    })

    const updated = await saveStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: initial.manualModes.test.publishableKey,
          secretKey: initial.manualModes.test.secretKeyPreview,
          webhookSecret: initial.manualModes.test.webhookSecretPreview
        },
        live: {
          publishableKey: initial.manualModes.live.publishableKey,
          secretKey: initial.manualModes.live.secretKeyPreview,
          webhookSecret: initial.manualModes.live.webhookSecretPreview
        }
      }
    })

    assert.equal(updated.configured, true)
    assert.equal(updated.mode, 'live')
    assert.equal(updated.manualModes.test.configured, true)
    assert.equal(updated.manualModes.live.configured, true)

    const withSecrets = await getStripePaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(withSecrets.secretKey, 'sk_test_manual_secret')
    assert.equal(withSecrets.webhookSecret, 'whsec_manual_test')

    const liveWithSecrets = await getStripePaymentConfig({ includeSecrets: true, mode: 'live' })
    assert.equal(liveWithSecrets.secretKey, 'sk_live_manual_secret')
    assert.equal(liveWithSecrets.webhookSecret, 'whsec_manual_live')
  })
})

test('Stripe manual: al guardar llaves crea webhook automático con la URL pública detectada', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    const created = []
    const updated = []

    setStripeFactoryForTest(() => ({
      webhookEndpoints: {
        list: async () => ({ data: [] }),
        create: async (payload) => {
          created.push(payload)
          return {
            id: 'we_test_ristak_auto',
            secret: 'whsec_ristak_auto',
            status: 'enabled'
          }
        },
        update: async (id, payload) => {
          updated.push({ id, payload })
          return { id, ...payload }
        }
      }
    }))

    const req = {
      protocol: 'https',
      headers: {
        host: 'payments.example.com'
      },
      body: {
        enabled: true,
        mode: 'test',
        manualModes: {
          test: {
            publishableKey: 'pk_test_auto_public',
            secretKey: 'sk_test_auto_secret'
          }
        }
      }
    }
    const res = createJsonResponse()

    await saveStripeConfigView(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(created.length, 1)
    assert.equal(updated.length, 0)
    assert.equal(created[0].url, 'https://payments.example.com/api/stripe/webhook')
    assert.equal(created[0].description, 'Ristak - Pagos')
    assert.equal(created[0].metadata.ristak, 'payment_webhook')
    assert.equal(created[0].metadata.mode, 'test')
    assert.ok(created[0].enabled_events.includes('payment_intent.succeeded'))
    assert.ok(created[0].enabled_events.includes('customer.subscription.deleted'))
    assert.equal(res.payload.data.manualModes.test.webhookConfigured, true)
    assert.equal(res.payload.data.manualModes.test.webhookEndpointId, 'we_test_ristak_auto')
    assert.equal(res.payload.data.manualModes.test.hasWebhookSecret, true)

    const withSecrets = await getStripePaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(withSecrets.manualModes.test.webhookSecret, 'whsec_ristak_auto')
  })
})

test('Stripe webhook: si el endpoint guardado desapareció crea uno nuevo y reemplaza el secret', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    process.env.INSTALLATION_ID = 'inst_stripe_recovery'

    setStripeFactoryForTest(() => ({
      webhookEndpoints: {
        list: async () => ({ data: [] }),
        create: async () => ({
          id: 'we_deleted_after_creation',
          secret: 'whsec_deleted_endpoint',
          status: 'enabled'
        }),
        update: async (id, payload) => ({ id, ...payload, status: payload.disabled ? 'disabled' : 'enabled' })
      }
    }))

    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publishableKey: 'pk_test_recovery_public',
          secretKey: 'sk_test_recovery_secret'
        }
      }
    }, { webhookUrl: 'https://payments.example.com/api/stripe/webhook' })

    const created = []
    const updated = []
    setStripeFactoryForTest(() => ({
      webhookEndpoints: {
        list: async () => ({
          data: [{
            id: 'we_legacy_same_url',
            url: 'https://payments.example.com/api/stripe/webhook',
            status: 'enabled',
            description: 'Ristak - Pagos',
            enabled_events: ['payment_intent.succeeded'],
            metadata: { ristak: 'payment_webhook', mode: 'test' }
          }]
        }),
        create: async (payload) => {
          created.push(payload)
          return {
            id: 'we_recovered',
            secret: 'whsec_recovered',
            status: 'enabled'
          }
        },
        update: async (id, payload) => {
          updated.push({ id, payload })
          return { id, ...payload, status: payload.disabled ? 'disabled' : 'enabled' }
        }
      }
    }))

    const result = await reconcileStripeWebhookConfiguration({
      webhookUrl: 'https://payments.example.com/api/stripe/webhook'
    })

    assert.equal(result.reconciled, true)
    assert.equal(created.length, 1)
    assert.equal(created[0].metadata.installation_id, 'inst_stripe_recovery')
    assert.deepEqual(updated, [{ id: 'we_legacy_same_url', payload: { disabled: true } }])

    const recovered = await getStripePaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(recovered.webhookEndpointId, 'we_recovered')
    assert.equal(recovered.webhookSecret, 'whsec_recovered')
    assert.equal(recovered.webhookUrl, 'https://payments.example.com/api/stripe/webhook')
  })
})

test('Stripe webhook: conserva el secret cuando actualiza el endpoint exacto a otra URL', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    process.env.INSTALLATION_ID = 'inst_stripe_move'

    setStripeFactoryForTest(() => ({
      webhookEndpoints: {
        list: async () => ({ data: [] }),
        create: async () => ({
          id: 'we_moved_endpoint',
          secret: 'whsec_moved_endpoint',
          status: 'enabled'
        }),
        update: async (id, payload) => ({ id, ...payload, status: 'enabled' })
      }
    }))

    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publishableKey: 'pk_test_move_public',
          secretKey: 'sk_test_move_secret'
        }
      }
    }, { webhookUrl: 'https://old.example.com/api/stripe/webhook' })

    const created = []
    const updated = []
    setStripeFactoryForTest(() => ({
      webhookEndpoints: {
        list: async () => ({
          data: [{
            id: 'we_moved_endpoint',
            url: 'https://old.example.com/api/stripe/webhook',
            status: 'disabled',
            description: 'Ristak - Pagos',
            enabled_events: [],
            metadata: { ristak: 'payment_webhook', mode: 'test' }
          }]
        }),
        create: async (payload) => {
          created.push(payload)
          return { id: 'unexpected', secret: 'whsec_unexpected', status: 'enabled' }
        },
        update: async (id, payload) => {
          updated.push({ id, payload })
          return { id, ...payload, status: 'enabled' }
        }
      }
    }))

    await reconcileStripeWebhookConfiguration({
      webhookUrl: 'https://new.example.com/api/stripe/webhook'
    })

    assert.equal(created.length, 0)
    assert.equal(updated.length, 1)
    assert.equal(updated[0].id, 'we_moved_endpoint')
    assert.equal(updated[0].payload.url, 'https://new.example.com/api/stripe/webhook')
    assert.equal(updated[0].payload.disabled, false)
    assert.equal(updated[0].payload.metadata.installation_id, 'inst_stripe_move')

    const moved = await getStripePaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(moved.webhookEndpointId, 'we_moved_endpoint')
    assert.equal(moved.webhookSecret, 'whsec_moved_endpoint')
    assert.equal(moved.webhookStatus, 'enabled')
    assert.equal(moved.webhookUrl, 'https://new.example.com/api/stripe/webhook')
  })
})

test('Stripe webhook: persiste el secret nuevo aunque falle la otra modalidad', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    process.env.INSTALLATION_ID = 'inst_stripe_partial_recovery'
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: 'pk_test_partial_public',
          secretKey: 'sk_test_partial_secret',
          webhookSecret: 'whsec_test_stale'
        },
        live: {
          publishableKey: 'pk_live_partial_public',
          secretKey: 'sk_live_partial_secret',
          webhookSecret: 'whsec_live_existing'
        }
      }
    })

    setStripeFactoryForTest((secretKey) => ({
      webhookEndpoints: {
        list: async () => {
          if (secretKey === 'sk_live_partial_secret') {
            throw new Error('Stripe live temporalmente no disponible')
          }
          return { data: [] }
        },
        create: async () => ({
          id: 'we_test_partial_recovered',
          secret: 'whsec_test_partial_recovered',
          status: 'enabled'
        }),
        update: async (id, payload) => ({ id, ...payload, status: 'enabled' })
      }
    }))

    await assert.rejects(
      () => reconcileStripeWebhookConfiguration({
        webhookUrl: 'https://payments.example.com/api/stripe/webhook'
      }),
      /Stripe live temporalmente no disponible/
    )

    const recoveredTest = await getStripePaymentConfig({ includeSecrets: true, mode: 'test' })
    assert.equal(recoveredTest.webhookEndpointId, 'we_test_partial_recovered')
    assert.equal(recoveredTest.webhookSecret, 'whsec_test_partial_recovered')
  })
})

test('Stripe manual: permite guardar o desconectar una modalidad sin afectar la otra', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: 'pk_test_manual_public',
          secretKey: 'sk_test_manual_secret',
          webhookSecret: 'whsec_manual_test'
        },
        live: {
          publishableKey: 'pk_live_manual_public',
          secretKey: 'sk_live_manual_secret',
          webhookSecret: 'whsec_manual_live'
        }
      }
    })
    await savePaymentSettings({ paymentMode: 'test' })

    const testOnlyUpdate = await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        test: {
          publishableKey: 'pk_test_manual_public_updated',
          secretKey: 'sk_test_manual_secret_updated',
          webhookSecret: 'whsec_manual_test_updated'
        }
      }
    })

    assert.equal(testOnlyUpdate.manualModes.test.configured, true)
    assert.equal(testOnlyUpdate.manualModes.live.configured, true)
    assert.equal(testOnlyUpdate.manualModes.test.publishableKey, 'pk_test_manual_public_updated')
    assert.equal(testOnlyUpdate.manualModes.live.publishableKey, 'pk_live_manual_public')

    const liveDisconnected = await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      manualModes: {
        live: {
          publishableKey: '',
          secretKey: '',
          webhookSecret: ''
        }
      }
    })

    assert.equal(liveDisconnected.configured, true)
    assert.equal(liveDisconnected.mode, 'test')
    assert.equal(liveDisconnected.manualModes.test.configured, true)
    assert.equal(liveDisconnected.manualModes.live.configured, false)
  })
})

test('Stripe manual: prueba conexiones test/live con una llamada mínima sin exponer keys', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    const receivedSecretKeys = []
    setStripeFactoryForTest((secretKey) => {
      receivedSecretKeys.push(secretKey)
      return {
        balance: {
          retrieve: async () => ({
            livemode: secretKey.includes('_live_'),
            available: [{ amount: 1000, currency: 'mxn' }]
          })
        }
      }
    })

    const result = await testStripePaymentConfig({
      enabled: true,
      mode: 'live',
      manualModes: {
        test: {
          publishableKey: 'pk_test_manual_public',
          secretKey: 'sk_test_manual_secret'
        },
        live: {
          publishableKey: 'pk_live_manual_public',
          secretKey: 'sk_live_manual_secret'
        }
      }
    })

    assert.equal(result.ok, true)
    assert.equal(result.connectionType, 'manual')
    assert.equal(result.mode, 'live')
    assert.equal(result.livemode, true)
    assert.equal(result.available, 1)
    assert.deepEqual(receivedSecretKeys, ['sk_test_manual_secret', 'sk_live_manual_secret'])
    assert.equal(result.modes.test.ok, true)
    assert.equal(result.modes.live.ok, true)
    assert.equal(JSON.stringify(result).includes('sk_test_manual_secret'), false)
    assert.equal(JSON.stringify(result).includes('sk_live_manual_secret'), false)
  })
})

test('Stripe manual: desconecta y elimina credenciales guardadas', async () => {
  await initializeMasterKey()

  await snapshotStripeConfig(async () => {
    await saveStripePaymentConfig({
      enabled: true,
      mode: 'test',
      publishableKey: 'pk_test_manual_public',
      secretKey: 'sk_test_manual_secret',
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

test('Stripe manual: ignora configuración legacy de Connect guardada en app_config', async () => {
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
    assert.equal(config.configurationStatus, 'not_configured')
    assert.equal(config.hasSecretKey, false)
  })
})

test('Stripe manual: la UI oficial no expone rutas ni copy de OAuth', async () => {
  const settingsPath = fileURLToPath(new URL('../../frontend/src/pages/Settings/PaymentsConfiguration.tsx', import.meta.url))
  const servicePath = fileURLToPath(new URL('../../frontend/src/services/stripePaymentsService.ts', import.meta.url))
  const settingsSource = await readFile(settingsPath, 'utf8')
  const serviceSource = await readFile(servicePath, 'utf8')
  const officialUiSource = `${settingsSource}\n${serviceSource}`

  assert.match(officialUiSource, /Secret key/)
  assert.match(officialUiSource, /Guardar configuración/)
  assert.match(officialUiSource, /Desconectar/)
  assert.doesNotMatch(officialUiSource, /Copiar URL/)
  assert.doesNotMatch(officialUiSource, /Desconectar Stripe/)
  assert.doesNotMatch(officialUiSource, /Restricted API Key/)
  assert.doesNotMatch(officialUiSource, /Stripe Connect/)
  assert.doesNotMatch(officialUiSource, /stripe_connect/)
  assert.doesNotMatch(officialUiSource, /\/api\/stripe\/connect/)
  assert.doesNotMatch(officialUiSource, /Conectar con Stripe/)
})

test('Stripe manual: muestra endpoints de Render, dominio conectado y request actual', async () => {
  await initializeMasterKey()

  const previousDomain = await db.get(
    "SELECT config_key, config_value FROM app_config WHERE config_key = 'sites_app_domain'"
  )
  const previousVerified = await db.get(
    "SELECT config_key, config_value FROM app_config WHERE config_key = 'sites_app_domain_verified'"
  )

  await snapshotStripeConfig(async () => {
    try {
      process.env.RENDER_EXTERNAL_URL = 'https://raulgomez.onrender.com'
      delete process.env.PUBLIC_APP_URL
      delete process.env.APP_PUBLIC_URL
      delete process.env.FRONTEND_URL
      delete process.env.APP_URL

      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES ('sites_app_domain', 'app.raulgomez.com.mx', CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `)
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES ('sites_app_domain_verified', '1', CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `)

      await saveStripePaymentConfig({
        enabled: true,
        mode: 'test',
        publishableKey: 'pk_test_manual_public',
        secretKey: 'sk_test_manual_secret',
        webhookSecret: 'whsec_manual_test'
      })

      const req = {
        protocol: 'https',
        headers: {
          host: 'raulgomez.onrender.com',
          'x-forwarded-host': 'test.raulgomez.com.mx',
          'x-forwarded-proto': 'https'
        }
      }
      const res = createJsonResponse()
      await getStripeConfigView(req, res)

      assert.equal(res.statusCode, 200)
      const endpoints = res.payload.data.webhookEndpoints.map((endpoint) => endpoint.url)
      assert.deepEqual(endpoints, [
        'https://raulgomez.onrender.com/api/stripe/webhook',
        'https://app.raulgomez.com.mx/api/stripe/webhook',
        'https://test.raulgomez.com.mx/api/stripe/webhook'
      ])
    } finally {
      await db.run("DELETE FROM app_config WHERE config_key IN ('sites_app_domain', 'sites_app_domain_verified')")
      if (previousDomain) {
        await db.run(
          'INSERT INTO app_config (config_key, config_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
          [previousDomain.config_key, previousDomain.config_value]
        )
      }
      if (previousVerified) {
        await db.run(
          'INSERT INTO app_config (config_key, config_value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
          [previousVerified.config_key, previousVerified.config_value]
        )
      }
    }
  })
})
