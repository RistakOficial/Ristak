import test from 'node:test'
import assert from 'node:assert/strict'

import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import {
  createBlock,
  createSite,
  deleteSite,
  prepareSiteCheckoutInstallments,
  updateBlock
} from '../src/services/sitesService.js'
import { savePaymentSettings } from '../src/services/paymentSettingsService.js'
import {
  confirmPublicStripeInstallmentPayment,
  createStripePaymentIntent,
  createStripePaymentLink,
  getPublicStripePayment,
  preparePublicStripeInstallmentPlans,
  saveStripePaymentConfig,
  setStripeFactoryForTest
} from '../src/services/stripePaymentService.js'
import { saveAccountLocaleSettings } from '../src/utils/accountLocale.js'
import { initializeMasterKey } from '../src/utils/encryption.js'

async function snapshotPaymentConfig(callback) {
  const previousRows = await db.all(
    `SELECT config_key, config_value
     FROM app_config
     WHERE config_key LIKE 'stripe_%'
        OR config_key = 'payments_settings'
        OR config_key IN ('account_country', 'account_currency', 'account_default_dial_code')`
  )

  try {
    await db.run(
      `DELETE FROM app_config
       WHERE config_key LIKE 'stripe_%'
          OR config_key = 'payments_settings'
          OR config_key IN ('account_country', 'account_currency', 'account_default_dial_code')`
    )
    return await callback()
  } finally {
    await db.run(
      `DELETE FROM app_config
       WHERE config_key LIKE 'stripe_%'
          OR config_key = 'payments_settings'
          OR config_key IN ('account_country', 'account_currency', 'account_default_dial_code')`
    )
    for (const row of previousRows) {
      await db.run(
        `INSERT INTO app_config (config_key, config_value, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(config_key) DO UPDATE SET
           config_value = excluded.config_value,
           updated_at = CURRENT_TIMESTAMP`,
        [row.config_key, row.config_value]
      )
    }
    setStripeFactoryForTest(null)
  }
}

async function configureStripeInstallmentTest() {
  await initializeMasterKey()
  await saveAccountLocaleSettings({ countryCode: 'MX', currency: 'MXN', dialCode: '52' })
  await savePaymentSettings({ paymentMode: 'test' })
  await saveStripePaymentConfig({
    enabled: true,
    mode: 'test',
    publishableKey: 'pk_test_stripe_installments',
    secretKey: 'sk_test_stripe_installments',
    defaultCurrency: 'MXN'
  })
}

async function cleanupPublicPayments(publicPaymentIds = []) {
  const ids = publicPaymentIds.filter(Boolean)
  if (!ids.length) return
  await db.run(
    `DELETE FROM payments
     WHERE public_payment_id IN (${ids.map(() => '?').join(', ')})`,
    ids
  ).catch(() => undefined)
}

function buildPublicSiteReq(host, slug) {
  return {
    headers: { host, 'user-agent': 'node-test' },
    get(name) {
      return this.headers[String(name || '').toLowerCase()] || ''
    },
    protocol: 'https',
    hostname: host,
    path: `/${slug}`,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' }
  }
}

test('Stripe mantiene pendiente un link abandonado si el PaymentIntent no tiene fallo real', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    let intentMetadata = null
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params) => {
          intentMetadata = params.metadata
          return {
            id: 'pi_abandoned_link',
            client_secret: 'pi_abandoned_link_secret_test',
            status: 'requires_payment_method'
          }
        },
        retrieve: async (paymentIntentId) => ({
          id: paymentIntentId,
          status: 'requires_payment_method',
          amount: 60000,
          amount_received: 0,
          currency: 'mxn',
          metadata: intentMetadata
        })
      }
    }))

    const createdPublicIds = []
    try {
      const paymentLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago abandonado',
        description: 'Link que no fue pagado'
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(paymentLink.publicPaymentId)

      await createStripePaymentIntent(paymentLink.publicPaymentId, {
        savePaymentMethod: false
      })

      const synced = await getPublicStripePayment(paymentLink.publicPaymentId, {
        baseUrl: 'https://app.example.test',
        sync: true
      })
      assert.equal(synced.status, 'pending')

      const row = await db.get('SELECT status FROM payments WHERE public_payment_id = ?', [paymentLink.publicPaymentId])
      assert.equal(row.status, 'pending')
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})

test('Stripe permite reintentar un link cuyo PaymentIntent fue cancelado sin fallo real', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    const createCalls = []
    const intentMetadata = new Map()
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params, requestOptions) => {
          const id = createCalls.length === 0 ? 'pi_canceled_old' : 'pi_canceled_retry'
          createCalls.push({ params, requestOptions })
          intentMetadata.set(id, params.metadata)
          return {
            id,
            client_secret: `${id}_secret_test`,
            status: 'requires_payment_method'
          }
        },
        retrieve: async (paymentIntentId) => ({
          id: paymentIntentId,
          status: paymentIntentId === 'pi_canceled_old' ? 'canceled' : 'requires_payment_method',
          amount: 60000,
          amount_received: 0,
          currency: 'mxn',
          metadata: intentMetadata.get(paymentIntentId) || createCalls[0]?.params?.metadata || {}
        })
      }
    }))

    const createdPublicIds = []
    try {
      const paymentLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago cancelado sin fallo',
        description: 'Link que debe permitir reintento'
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(paymentLink.publicPaymentId)

      await createStripePaymentIntent(paymentLink.publicPaymentId, {
        savePaymentMethod: false
      })

      const synced = await getPublicStripePayment(paymentLink.publicPaymentId, {
        baseUrl: 'https://app.example.test',
        sync: true
      })
      assert.equal(synced.status, 'pending')
      const canceledRow = await db.get(
        'SELECT metadata_json FROM payments WHERE public_payment_id = ?',
        [paymentLink.publicPaymentId]
      )
      assert.equal(JSON.parse(canceledRow.metadata_json).stripe.status, 'canceled')

      const retryIntent = await createStripePaymentIntent(paymentLink.publicPaymentId, {
        savePaymentMethod: false
      })
      assert.equal(retryIntent.status, 'requires_payment_method')
      assert.equal(createCalls.length, 2)
      assert.doesNotMatch(createCalls[0].requestOptions.idempotencyKey, /:replace:/)
      assert.match(createCalls[1].requestOptions.idempotencyKey, /:replace:pi_canceled_old$/)

      const row = await db.get(
        'SELECT status, stripe_payment_intent_id, metadata_json FROM payments WHERE public_payment_id = ?',
        [paymentLink.publicPaymentId]
      )
      assert.equal(row.status, 'pending')
      assert.equal(row.stripe_payment_intent_id, 'pi_canceled_retry')
      assert.equal(JSON.parse(row.metadata_json).stripe.status, 'requires_payment_method')
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})

test('Stripe mantiene pendiente un checkout MSI de Sites abandonado antes de confirmar', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    let intentMetadata = null
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params) => {
          intentMetadata = params.metadata
          return {
            id: 'pi_site_msi_abandoned',
            client_secret: 'pi_site_msi_abandoned_secret_test',
            status: 'requires_confirmation',
            payment_method_options: {
              card: {
                installments: {
                  available_plans: [
                    { type: 'fixed_count', interval: 'month', count: 3 },
                    { type: 'fixed_count', interval: 'month', count: 6 }
                  ]
                }
              }
            }
          }
        },
        retrieve: async (paymentIntentId) => ({
          id: paymentIntentId,
          status: 'requires_payment_method',
          amount: 60000,
          amount_received: 0,
          currency: 'mxn',
          metadata: intentMetadata
        })
      }
    }))

    const createdPublicIds = []
    try {
      const paymentLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Checkout Sites MSI',
        description: 'Checkout embebido con meses',
        source: 'site_checkout',
        metadata: {
          siteId: 'site_test_checkout',
          paymentGate: {
            source: 'site_checkout',
            siteId: 'site_test_checkout',
            paymentBlockId: 'block_payment_test'
          }
        },
        installments: { enabled: true, maxInstallments: 6 }
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(paymentLink.publicPaymentId)

      const prepared = await preparePublicStripeInstallmentPlans(paymentLink.publicPaymentId, {
        paymentMethodId: 'pm_site_msi',
        savePaymentMethod: false
      })
      assert.equal(prepared.paymentIntentId, 'pi_site_msi_abandoned')
      assert.deepEqual(prepared.availablePlans.map((plan) => plan.count), [3, 6])

      const synced = await getPublicStripePayment(paymentLink.publicPaymentId, {
        baseUrl: 'https://app.example.test',
        sync: true
      })
      assert.equal(synced.status, 'pending')

      const row = await db.get('SELECT status FROM payments WHERE public_payment_id = ?', [paymentLink.publicPaymentId])
      assert.equal(row.status, 'pending')
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})

test('Sites prepara Stripe MSI controlado con PaymentMethod y filtra por maxInstallments', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    const previousDomain = {
      domain: await getAppConfig('sites_public_domain'),
      verified: await getAppConfig('sites_public_domain_verified'),
      checkedAt: await getAppConfig('sites_public_domain_checked_at'),
      error: await getAppConfig('sites_public_domain_error')
    }
    const createCalls = []
    let site
    const createdPublicIds = []

    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params, requestOptions) => {
          createCalls.push({ params, requestOptions })
          return {
            id: 'pi_site_controlled_msi',
            client_secret: 'pi_site_controlled_msi_secret_test',
            status: 'requires_confirmation',
            amount: params.amount,
            currency: params.currency,
            metadata: params.metadata,
            payment_method_options: {
              card: {
                installments: {
                  available_plans: [
                    { type: 'fixed_count', interval: 'month', count: 3 },
                    { type: 'fixed_count', interval: 'month', count: 6 },
                    { type: 'fixed_count', interval: 'month', count: 9 },
                    { type: 'fixed_count', interval: 'month', count: 12 },
                    { type: 'fixed_count', interval: 'month', count: 18 },
                    { type: 'fixed_count', interval: 'month', count: 24 }
                  ]
                }
              }
            }
          }
        }
      }
    }))

    try {
      await setAppConfig('sites_public_domain', 'example.test')
      await setAppConfig('sites_public_domain_verified', '1')
      await setAppConfig('sites_public_domain_checked_at', new Date().toISOString())
      await setAppConfig('sites_public_domain_error', '')

      site = await createSite({
        name: 'Checkout Sites controlled MSI',
        slug: `checkout-sites-msi-${Date.now()}`,
        siteType: 'landing_page',
        status: 'published',
        blankCanvas: true,
        theme: {
          pages: [{ id: 'page-pay', title: 'Pago', sortOrder: 0 }]
        }
      })
      const siteWithPayment = await createBlock(site.id, {
        blockType: 'payment',
        label: 'Pago Stripe MSI',
        settings: {
          pageId: 'page-pay',
          paymentGate: {
            enabled: true,
            gateway: 'stripe',
            amount: 5000,
            currency: 'MXN',
            productName: 'Pago requerido',
            buttonText: 'Completar pago',
            mode: 'test',
            msi: { enabled: true, maxInstallments: 9 }
          }
        }
      })
      const paymentBlock = siteWithPayment.blocks.find(block => block.label === 'Pago Stripe MSI')
      assert.ok(paymentBlock)

      const prepared = await prepareSiteCheckoutInstallments(
        buildPublicSiteReq('example.test', site.slug),
        { siteId: site.id, blockId: paymentBlock.id, pageId: 'page-pay', paymentMethodId: 'pm_site_controlled_msi' }
      )
      createdPublicIds.push(prepared.publicPaymentId)

      assert.equal(prepared.paymentIntentId, 'pi_site_controlled_msi')
      assert.equal(prepared.clientSecret, 'pi_site_controlled_msi_secret_test')
      assert.equal(prepared.maxInstallments, 9)
      assert.deepEqual(prepared.availablePlans.map((plan) => plan.count), [3, 6, 9])
      assert.equal(createCalls.length, 1)
      assert.equal(createCalls[0].params.payment_method, 'pm_site_controlled_msi')
      assert.equal(createCalls[0].params.amount, 500000)
      assert.equal(createCalls[0].params.automatic_payment_methods, undefined)
      assert.equal(createCalls[0].params.payment_method_options.card.installments.enabled, true)

      const row = await db.get(
        'SELECT status, stripe_payment_intent_id, metadata_json FROM payments WHERE public_payment_id = ?',
        [prepared.publicPaymentId]
      )
      assert.equal(row.status, 'pending')
      assert.equal(row.stripe_payment_intent_id, 'pi_site_controlled_msi')
      const metadata = JSON.parse(row.metadata_json)
      assert.equal(metadata.paymentGate.source, 'site_checkout')
      assert.equal(metadata.paymentGate.amount, 5000)
      assert.equal(metadata.paymentGate.msi.maxInstallments, 9)
      assert.equal(metadata.stripeInstallments.maxInstallments, 9)
    } finally {
      await cleanupPublicPayments(createdPublicIds)
      if (site?.id) await deleteSite(site.id).catch(() => undefined)
      await setAppConfig('sites_public_domain', previousDomain.domain)
      await setAppConfig('sites_public_domain_verified', previousDomain.verified)
      await setAppConfig('sites_public_domain_checked_at', previousDomain.checkedAt)
      await setAppConfig('sites_public_domain_error', previousDomain.error)
    }
  })
})

test('Sites ignora publicPaymentId pendiente cuando cambia monto o maxInstallments del bloque', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    const previousDomain = {
      domain: await getAppConfig('sites_public_domain'),
      verified: await getAppConfig('sites_public_domain_verified'),
      checkedAt: await getAppConfig('sites_public_domain_checked_at'),
      error: await getAppConfig('sites_public_domain_error')
    }
    const createCalls = []
    let site
    const createdPublicIds = []

    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params, requestOptions) => {
          createCalls.push({ params, requestOptions })
          const index = createCalls.length
          return {
            id: `pi_site_stale_${index}`,
            client_secret: `pi_site_stale_${index}_secret_test`,
            status: 'requires_confirmation',
            amount: params.amount,
            currency: params.currency,
            metadata: params.metadata,
            payment_method_options: {
              card: {
                installments: {
                  available_plans: [
                    { type: 'fixed_count', interval: 'month', count: 3 },
                    { type: 'fixed_count', interval: 'month', count: 6 },
                    { type: 'fixed_count', interval: 'month', count: 9 },
                    { type: 'fixed_count', interval: 'month', count: 12 },
                    { type: 'fixed_count', interval: 'month', count: 18 },
                    { type: 'fixed_count', interval: 'month', count: 24 }
                  ]
                }
              }
            }
          }
        },
        retrieve: async (paymentIntentId) => ({
          id: paymentIntentId,
          status: 'requires_confirmation'
        })
      }
    }))

    try {
      await setAppConfig('sites_public_domain', 'example.test')
      await setAppConfig('sites_public_domain_verified', '1')
      await setAppConfig('sites_public_domain_checked_at', new Date().toISOString())
      await setAppConfig('sites_public_domain_error', '')

      site = await createSite({
        name: 'Checkout Sites stale MSI',
        slug: `checkout-sites-stale-msi-${Date.now()}`,
        siteType: 'landing_page',
        status: 'published',
        blankCanvas: true,
        theme: {
          pages: [{ id: 'page-pay', title: 'Pago', sortOrder: 0 }]
        }
      })
      const siteWithPayment = await createBlock(site.id, {
        blockType: 'payment',
        label: 'Pago Stripe MSI stale',
        settings: {
          pageId: 'page-pay',
          paymentGate: {
            enabled: true,
            gateway: 'stripe',
            amount: 500,
            currency: 'MXN',
            productName: 'Pago requerido',
            buttonText: 'Completar pago',
            mode: 'test',
            msi: { enabled: true, maxInstallments: 3 }
          }
        }
      })
      const paymentBlock = siteWithPayment.blocks.find(block => block.label === 'Pago Stripe MSI stale')
      assert.ok(paymentBlock)

      const first = await prepareSiteCheckoutInstallments(
        buildPublicSiteReq('example.test', site.slug),
        { siteId: site.id, blockId: paymentBlock.id, pageId: 'page-pay', paymentMethodId: 'pm_site_stale_first' }
      )
      createdPublicIds.push(first.publicPaymentId)
      assert.deepEqual(first.availablePlans.map((plan) => plan.count), [3])
      assert.equal(createCalls[0].params.amount, 50000)

      await updateBlock(site.id, paymentBlock.id, {
        settings: {
          pageId: 'page-pay',
          paymentGate: {
            enabled: true,
            gateway: 'stripe',
            amount: 5000,
            currency: 'MXN',
            productName: 'Pago requerido',
            buttonText: 'Completar pago',
            mode: 'test',
            msi: { enabled: true, maxInstallments: 9 }
          }
        }
      })

      const second = await prepareSiteCheckoutInstallments(
        buildPublicSiteReq('example.test', site.slug),
        {
          siteId: site.id,
          blockId: paymentBlock.id,
          pageId: 'page-pay',
          paymentPublicId: first.publicPaymentId,
          paymentMethodId: 'pm_site_stale_second'
        }
      )
      createdPublicIds.push(second.publicPaymentId)

      assert.notEqual(second.publicPaymentId, first.publicPaymentId)
      assert.equal(second.paymentIntentId, 'pi_site_stale_2')
      assert.equal(createCalls.length, 2)
      assert.equal(createCalls[1].params.payment_method, 'pm_site_stale_second')
      assert.equal(createCalls[1].params.amount, 500000)
      assert.deepEqual(second.availablePlans.map((plan) => plan.count), [3, 6, 9])

      const secondRow = await db.get(
        'SELECT amount, metadata_json FROM payments WHERE public_payment_id = ?',
        [second.publicPaymentId]
      )
      assert.equal(Number(secondRow.amount), 5000)
      const metadata = JSON.parse(secondRow.metadata_json)
      assert.equal(metadata.paymentGate.amount, 5000)
      assert.equal(metadata.paymentGate.msi.maxInstallments, 9)
      assert.equal(metadata.stripeInstallments.maxInstallments, 9)
    } finally {
      await cleanupPublicPayments(createdPublicIds)
      if (site?.id) await deleteSite(site.id).catch(() => undefined)
      await setAppConfig('sites_public_domain', previousDomain.domain)
      await setAppConfig('sites_public_domain_verified', previousDomain.verified)
      await setAppConfig('sites_public_domain_checked_at', previousDomain.checkedAt)
      await setAppConfig('sites_public_domain_error', previousDomain.error)
    }
  })
})

test('Stripe conserva failed cuando requires_payment_method trae rechazo real', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    let intentMetadata = null
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params) => {
          intentMetadata = params.metadata
          return {
            id: 'pi_declined_link',
            client_secret: 'pi_declined_link_secret_test',
            status: 'requires_payment_method'
          }
        },
        retrieve: async (paymentIntentId) => ({
          id: paymentIntentId,
          status: 'requires_payment_method',
          amount: 60000,
          amount_received: 0,
          currency: 'mxn',
          latest_charge: 'ch_declined_link',
          metadata: intentMetadata,
          last_payment_error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'generic_decline',
            message: 'Your card was declined.'
          }
        })
      }
    }))

    const createdPublicIds = []
    try {
      const paymentLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago rechazado',
        description: 'Link con rechazo real'
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(paymentLink.publicPaymentId)

      await createStripePaymentIntent(paymentLink.publicPaymentId, {
        savePaymentMethod: false
      })

      const synced = await getPublicStripePayment(paymentLink.publicPaymentId, {
        baseUrl: 'https://app.example.test',
        sync: true
      })
      assert.equal(synced.status, 'failed')

      const row = await db.get('SELECT status, stripe_charge_id FROM payments WHERE public_payment_id = ?', [paymentLink.publicPaymentId])
      assert.equal(row.status, 'failed')
      assert.equal(row.stripe_charge_id, 'ch_declined_link')
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})

test('Stripe habilita meses sin intereses en PaymentIntent cuando el link lo pide', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    const createCalls = []
    let intentSequence = 0
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params, requestOptions) => {
          intentSequence += 1
          createCalls.push({ params, requestOptions })
          return {
            id: `pi_installments_${intentSequence}`,
            client_secret: `pi_installments_${intentSequence}_secret_test`,
            status: 'requires_payment_method'
          }
        }
      }
    }))

    const createdPublicIds = []
    try {
      const msiLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago Stripe MSI',
        description: 'Pago con meses sin intereses',
        installments: { enabled: true }
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(msiLink.publicPaymentId)

      const publicPayment = await getPublicStripePayment(msiLink.publicPaymentId, {
        baseUrl: 'https://app.example.test'
      })
      assert.equal(publicPayment.stripeInstallments.enabled, true)
      assert.equal(publicPayment.stripeInstallments.minAmount, 300)
      assert.equal(publicPayment.stripeInstallments.maxInstallments, 24)
      assert.equal(publicPayment.stripeInstallments.selectionMode, 'stripe_controlled_installments')

      const msiIntent = await createStripePaymentIntent(msiLink.publicPaymentId, {
        savePaymentMethod: false
      })
      assert.equal(msiIntent.paymentIntentId, 'pi_installments_1')
      assert.equal(msiIntent.status, 'requires_payment_method')
      assert.equal(createCalls.length, 1)
      assert.equal(createCalls[0].params.payment_method_options.card.installments.enabled, true)

      const standardLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago Stripe contado',
        description: 'Pago sin meses'
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(standardLink.publicPaymentId)

      await createStripePaymentIntent(standardLink.publicPaymentId, {
        savePaymentMethod: false
      })
      assert.equal(createCalls.length, 2)
      assert.equal(createCalls[1].params.payment_method_options, undefined)
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})

test('Stripe MSI controlado filtra planes por maxInstallments y confirma el plazo elegido', async () => {
  await snapshotPaymentConfig(async () => {
    await configureStripeInstallmentTest()

    const createCalls = []
    const confirmCalls = []
    let preparedIntent = null
    setStripeFactoryForTest(() => ({
      paymentIntents: {
        create: async (params, requestOptions) => {
          createCalls.push({ params, requestOptions })
          preparedIntent = {
            id: 'pi_controlled_msi',
            client_secret: 'pi_controlled_msi_secret_test',
            status: 'requires_confirmation',
            amount: params.amount,
            currency: params.currency,
            metadata: params.metadata,
            payment_method_options: {
              card: {
                installments: {
                  available_plans: [
                    { type: 'fixed_count', interval: 'month', count: 3 },
                    { type: 'fixed_count', interval: 'month', count: 6 },
                    { type: 'fixed_count', interval: 'month', count: 12 },
                    { type: 'fixed_count', interval: 'month', count: 24 }
                  ]
                }
              }
            }
          }
          return preparedIntent
        },
        retrieve: async () => preparedIntent,
        confirm: async (paymentIntentId, params, requestOptions) => {
          confirmCalls.push({ paymentIntentId, params, requestOptions })
          return {
            ...preparedIntent,
            status: 'succeeded',
            amount_received: preparedIntent.amount,
            latest_charge: 'ch_controlled_msi'
          }
        }
      }
    }))

    const createdPublicIds = []
    try {
      const msiLink = await createStripePaymentLink({
        amount: 600,
        currency: 'MXN',
        applyTax: false,
        title: 'Pago Stripe MSI controlado',
        description: 'Pago con meses limitados por Ristak',
        installments: { enabled: true, maxInstallments: 6 }
      }, { baseUrl: 'https://app.example.test' })
      createdPublicIds.push(msiLink.publicPaymentId)

      const publicPayment = await getPublicStripePayment(msiLink.publicPaymentId, {
        baseUrl: 'https://app.example.test'
      })
      assert.equal(publicPayment.stripeInstallments.enabled, true)
      assert.equal(publicPayment.stripeInstallments.maxInstallments, 6)
      assert.deepEqual(publicPayment.stripeInstallments.allowedCounts, [3, 6])

      const plans = await preparePublicStripeInstallmentPlans(msiLink.publicPaymentId, {
        paymentMethodId: 'pm_controlled_msi',
        savePaymentMethod: false
      })
      assert.equal(plans.paymentIntentId, 'pi_controlled_msi')
      assert.deepEqual(plans.availablePlans.map((plan) => plan.count), [3, 6])
      assert.equal(createCalls[0].params.payment_method, 'pm_controlled_msi')
      assert.equal(createCalls[0].params.payment_method_options.card.installments.enabled, true)

      await assert.rejects(
        () => confirmPublicStripeInstallmentPayment(msiLink.publicPaymentId, {
          paymentIntentId: plans.paymentIntentId,
          selectedInstallments: 12
        }),
        /máximo 6 meses/
      )
      assert.equal(confirmCalls.length, 0)

      const confirmed = await confirmPublicStripeInstallmentPayment(msiLink.publicPaymentId, {
        paymentIntentId: plans.paymentIntentId,
        selectedInstallments: 6
      })
      assert.equal(confirmed.status, 'succeeded')
      assert.equal(confirmCalls.length, 1)
      assert.equal(confirmCalls[0].params.payment_method_options.card.installments.plan.count, 6)

      const row = await db.get('SELECT status, stripe_payment_intent_id, stripe_charge_id FROM payments WHERE public_payment_id = ?', [msiLink.publicPaymentId])
      assert.equal(row.status, 'paid')
      assert.equal(row.stripe_payment_intent_id, 'pi_controlled_msi')
      assert.equal(row.stripe_charge_id, 'ch_controlled_msi')
    } finally {
      await cleanupPublicPayments(createdPublicIds)
    }
  })
})
