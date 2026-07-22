import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { extendedToolSpecs } from '../src/mcp/extendedTools.js'
import { ACCESS_MODULES } from '../src/utils/userAccess.js'

function tool(name) {
  const found = extendedToolSpecs.find((entry) => entry.name === name)
  assert.ok(found, `No existe la herramienta ${name}`)
  return found
}

function recorder(response = { success: true, data: {} }) {
  const calls = []
  return {
    calls,
    context: {
      user: { id: 'user_1', userId: 'user_1', role: 'admin' },
      async invoke(handler, request) {
        calls.push({ handler: handler.name, request })
        return typeof response === 'function' ? response(handler, request, calls.length) : response
      }
    }
  }
}

test('las herramientas extendidas tienen catálogo único y metadata de seguridad completa', () => {
  assert.ok(extendedToolSpecs.length >= 120)
  assert.equal(new Set(extendedToolSpecs.map((entry) => entry.name)).size, extendedToolSpecs.length)

  for (const entry of extendedToolSpecs) {
    assert.match(entry.name, /^(?:dashboard|reports|analytics|campaigns|media|settings|integrations)_[a-z0-9_]+$/)
    assert.equal(typeof entry.description, 'string')
    assert.ok(entry.description.length > 10)
    assert.equal(typeof entry.module, 'string')
    assert.ok(ACCESS_MODULES.includes(entry.module), `${entry.name} usa un módulo inexistente: ${entry.module}`)
    assert.ok(['read', 'write'].includes(entry.access))
    assert.ok(['ristak.read', 'ristak.write', 'ristak.execute', 'ristak.destructive'].includes(entry.scope))
    assert.ok(['low', 'medium', 'high', 'critical'].includes(entry.risk))
    assert.ok(Array.isArray(entry.featureKeys))
    assert.equal(typeof entry.adminOnly, 'boolean')
    assert.equal(typeof entry.confirmRequired, 'boolean')
    assert.equal(typeof entry.idempotencyRequired, 'boolean')
    assert.equal(entry.inputSchema.type, 'object')
    assert.equal(entry.inputSchema.additionalProperties, false)
    assert.equal(typeof entry.execute, 'function')

    if (entry.access === 'write') {
      assert.equal(entry.confirmRequired, true, `${entry.name} debe exigir confirmación`)
      assert.equal(entry.idempotencyRequired, true, `${entry.name} debe ser idempotente`)
      assert.equal(entry.inputSchema.properties.confirm.type, 'boolean')
      assert.equal(entry.inputSchema.properties.idempotencyKey.type, 'string')
      assert.ok(entry.inputSchema.required.includes('confirm'))
      assert.ok(entry.inputSchema.required.includes('idempotencyKey'))
    } else {
      assert.equal(entry.confirmRequired, false)
      assert.equal(entry.idempotencyRequired, false)
      assert.equal(entry.scope, 'ristak.read')
    }
  }
})

test('cada featureKey corresponde a un gate canónico usado por las rutas de Ristak', async () => {
  const routeSources = await Promise.all([
    '../src/routes/tracking.routes.js',
    '../src/routes/media.routes.js',
    '../src/routes/settings.routes.js',
    '../src/routes/subscriptions.routes.js'
  ].map((path) => readFile(new URL(path, import.meta.url), 'utf8')))
  const routedFeatureKeys = new Set(routeSources.flatMap((source) => (
    [...source.matchAll(/requireFeature\(['"]([^'"]+)['"]\)/g)].map((match) => match[1])
  )))
  const usedFeatureKeys = new Set(extendedToolSpecs.flatMap((entry) => entry.featureKeys))

  assert.deepEqual([...usedFeatureKeys].sort(), [
    'settings_media',
    'subscriptions',
    'trigger_links',
    'web_analytics',
    'whatsapp_templates'
  ])
  for (const featureKey of usedFeatureKeys) {
    assert.equal(routedFeatureKeys.has(featureKey), true, `featureKey sin gate canónico: ${featureKey}`)
  }
})

test('el catálogo cubre dominios faltantes sin SQL, proxies ni administración de credenciales', async () => {
  const names = new Set(extendedToolSpecs.map((entry) => entry.name))
  for (const required of [
    'dashboard_metrics',
    'reports_summary',
    'analytics_summary',
    'analytics_tracking_status',
    'analytics_attribution_fallback_preview',
    'analytics_attribution_fallback_execute',
    'campaigns_overview',
    'media_list_assets',
    'settings_tags_catalog',
    'settings_custom_fields_list',
    'settings_trigger_links_list',
    'settings_costs_list',
    'settings_message_templates_list',
    'settings_products_list',
    'settings_product_create',
    'settings_subscriptions_list',
    'settings_subscription_cancel',
    'settings_user_preferences_get',
    'settings_analytics_preferences_get',
    'integrations_status'
  ]) {
    assert.equal(names.has(required), true, `falta ${required}`)
  }

  for (const forbidden of [
    'query_sql',
    'database_query',
    'rest_proxy',
    'integration_connect',
    'integration_disconnect',
    'integration_reveal_token',
    'settings_config_set'
  ]) {
    assert.equal(names.has(forbidden), false)
  }

  const source = await readFile(new URL('../src/mcp/extendedTools.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.\/config\/database\.js['"]/)
  assert.doesNotMatch(source, /\bSELECT\s+.+\s+FROM\b/i)
  assert.doesNotMatch(source, /ghl_api_request|query_data_table|revealToken/)
})

test('productos usa el catálogo local, no sincroniza al leer y compacta datos del proveedor', async () => {
  const listRecorder = recorder({
    success: true,
    products: [{
      id: 'ghl_product_private',
      localId: 'product_1',
      ghlProductId: 'ghl_product_private',
      locationId: 'location_private',
      name: 'Mentoría',
      currency: 'USD',
      postWebhooks: [{ url: 'https://private.example/hook', authorization: 'Bearer secret' }],
      rawJson: { apiToken: 'secret' },
      prices: [{ id: 'ghl_price_private', localId: 'price_1', name: 'Base', amount: 250 }]
    }],
    total: 1,
    summary: { total: 1 },
    source: 'ristak'
  })

  const result = await tool('settings_products_list').execute(listRecorder.context, {
    includePrices: false,
    limit: 25
  })

  assert.equal(listRecorder.calls[0].handler, 'listProducts')
  assert.equal(listRecorder.calls[0].request.query.sync, 'false')
  assert.equal(listRecorder.calls[0].request.query.includePrices, 'false')
  assert.equal(result.products[0].id, 'product_1')
  assert.equal(result.products[0].ghlProductId, undefined)
  assert.equal(result.products[0].locationId, undefined)
  assert.equal(result.products[0].postWebhooks, undefined)
  assert.equal(result.products[0].rawJson, undefined)
  assert.equal(result.products[0].prices[0].id, 'price_1')
})

test('crear producto exige confirmación y no propaga controles MCP al controller', async () => {
  const createTool = tool('settings_product_create')
  const args = {
    name: 'Curso premium',
    productType: 'DIGITAL',
    prices: [{ name: 'Precio base', amount: 100, type: 'one_time' }],
    idempotencyKey: 'product-create-001'
  }
  const blocked = recorder()
  await assert.rejects(
    () => createTool.execute(blocked.context, args),
    (error) => error.code === 'confirmation_required'
  )
  assert.equal(blocked.calls.length, 0)

  const created = recorder({ success: true, product: { localId: 'product_1', name: args.name } })
  await createTool.execute(created.context, { ...args, confirm: true })
  assert.equal(created.calls[0].handler, 'createProduct')
  assert.equal(created.calls[0].request.headers['idempotency-key'], args.idempotencyKey)
  assert.equal(created.calls[0].request.body.confirm, undefined)
  assert.equal(created.calls[0].request.body.idempotencyKey, undefined)
  assert.equal(created.calls[0].request.body.name, args.name)
  assert.equal(created.calls[0].request.body.currency, undefined)
})

test('suscripciones oculta datos de pasarela y delega cancelación al flujo canónico', async () => {
  const listRecorder = recorder({
    success: true,
    data: {
      subscriptions: [{
        id: 'sub_1',
        contactId: 'contact_1',
        name: 'Plan mensual',
        amount: 900,
        currency: 'MXN',
        stripeSubscriptionId: 'sub_provider_private',
        stripePaymentMethodId: 'pm_private',
        rebillPaymentLinkUrl: 'https://checkout.private',
        metadata: { clientSecret: 'secret' },
        raw: { providerPayload: true }
      }],
      summary: { total: 1, monthlyRevenue: 900 },
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNext: false, nextCursor: null }
    }
  })
  const listed = await tool('settings_subscriptions_list').execute(listRecorder.context, { limit: 20 })
  assert.equal(listRecorder.calls[0].request.query.refresh, 'false')
  assert.equal(listed.data.subscriptions[0].id, 'sub_1')
  assert.equal(listed.data.subscriptions[0].stripeSubscriptionId, undefined)
  assert.equal(listed.data.subscriptions[0].stripePaymentMethodId, undefined)
  assert.equal(listed.data.subscriptions[0].rebillPaymentLinkUrl, undefined)
  assert.equal(listed.data.subscriptions[0].metadata, undefined)
  assert.equal(listed.data.pagination.total, 1)

  const cancelRecorder = recorder({ success: true, data: { id: 'sub_1', status: 'cancelled' } })
  const cancelled = await tool('settings_subscription_cancel').execute(cancelRecorder.context, {
    subscriptionId: 'sub_1',
    confirm: true,
    idempotencyKey: 'subscription-cancel-001'
  })
  assert.equal(cancelRecorder.calls[0].handler, 'actionSubscriptionView')
  assert.deepEqual(cancelRecorder.calls[0].request.body, { action: 'cancel', payload: {} })
  assert.equal(cancelRecorder.calls[0].request.headers['idempotency-key'], 'subscription-cancel-001')
  assert.equal(cancelled.data.status, 'cancelled')
})

test('preferencias sólo permiten claves conocidas y serializan valores como espera el controller', async () => {
  const preferencesRecorder = recorder({ success: true })
  await tool('settings_user_preferences_update').execute(preferencesRecorder.context, {
    chatPushNotificationsEnabled: true,
    calendarPushNotificationCalendarIds: ['calendar_1', 'calendar_2'],
    mobileChatAppointmentEntryMode: 'calendar',
    confirm: true,
    idempotencyKey: 'user-preferences-001'
  })
  assert.equal(preferencesRecorder.calls[0].handler, 'saveUserConfig')
  assert.deepEqual(preferencesRecorder.calls[0].request.body, {
    config: {
      chat_push_notifications_enabled: 'true',
      calendar_push_notification_calendar_ids: '["calendar_1","calendar_2"]',
      mobile_chat_appointment_entry_mode: 'calendar'
    }
  })

  const emptyRecorder = recorder()
  await assert.rejects(
    () => tool('settings_user_preferences_update').execute(emptyRecorder.context, {
      confirm: true,
      idempotencyKey: 'user-preferences-002'
    }),
    (error) => error.code === 'invalid_arguments'
  )
  assert.equal(emptyRecorder.calls.length, 0)

  const preferenceSchema = tool('settings_user_preferences_update').inputSchema
  assert.equal(preferenceSchema.additionalProperties, false)
  assert.equal(preferenceSchema.properties.apiToken, undefined)
  assert.equal(preferenceSchema.properties.config, undefined)
})

test('búsqueda de Analytics traduce query a q sin dejar campos fantasma', async () => {
  const analyticsRecorder = recorder({ success: true, data: { items: [] } })
  await tool('analytics_search_sessions').execute(analyticsRecorder.context, {
    start: '2026-07-01T00:00:00.000Z',
    end: '2026-07-22T00:00:00.000Z',
    query: 'campaña verano',
    limit: 25
  })
  assert.deepEqual(analyticsRecorder.calls[0].request.body, {
    start: '2026-07-01T00:00:00.000Z',
    end: '2026-07-22T00:00:00.000Z',
    limit: 25,
    q: 'campaña verano'
  })
})

test('tracking y fallback de atribución entregan estado y muestras acotadas, no infraestructura', async () => {
  const trackingRecorder = recorder({
    trackingDomain: 'track.private.example',
    serviceBaseUrl: 'https://api.private.example',
    trackingSnippet: '<script>private</script>',
    metaPixelId: 'pixel_private',
    trackingDomainVerified: true,
    isConfigured: true,
    hasHighLevel: true,
    showAnalytics: true,
    visitorSource: 'tracking',
    hasMetaPixel: true,
    hasPublicSites: true,
    includeMetaPixel: true
  })
  const status = await tool('analytics_tracking_status').execute(trackingRecorder.context, {})
  assert.deepEqual(status, {
    success: true,
    data: {
      trackingDomainVerified: true,
      isConfigured: true,
      hasHighLevel: true,
      showAnalytics: true,
      visitorSource: 'tracking',
      hasMetaPixel: true,
      hasPublicSites: true,
      includeMetaPixel: true
    }
  })
  assert.doesNotMatch(JSON.stringify(status), /track\.private|api\.private|script|pixel_private/)

  const updateCandidates = Array.from({ length: 65 }, (_, index) => ({
    name: `Contacto ${index}`,
    url: `https://private.example/${index}`,
    current_ad_id: '',
    new_ad_id: `ad_${index}`,
    confidence: '90%',
    revenue: index
  }))
  const previewRecorder = recorder({
    success: true,
    summary: { total_candidates: 65, would_update_count: 65, would_skip_count: 0 },
    contacts_to_update: updateCandidates,
    contacts_to_skip: []
  })
  const preview = await tool('analytics_attribution_fallback_preview').execute(previewRecorder.context, {})
  assert.equal(preview.data.updateSample.length, 50)
  assert.equal(preview.data.samplesTruncated, true)
  assert.equal(preview.data.updateSample[0].url, undefined)

  const executeRecorder = recorder({
    success: true,
    stats: { successful_updates: 1, revenue_recovered: 100 },
    updated_contacts: [{ id: 'contact_1', name: 'Ana', url: 'https://private', old_ad_id: '', new_ad_id: 'ad_1' }]
  })
  await assert.rejects(
    () => tool('analytics_attribution_fallback_execute').execute(executeRecorder.context, {
      idempotencyKey: 'attribution-fallback-001'
    }),
    (error) => error.code === 'confirmation_required'
  )
  assert.equal(executeRecorder.calls.length, 0)

  const executed = await tool('analytics_attribution_fallback_execute').execute(executeRecorder.context, {
    confirm: true,
    idempotencyKey: 'attribution-fallback-001'
  })
  assert.equal(executeRecorder.calls[0].handler, 'executeFallback')
  assert.equal(executed.data.updatedSample[0].id, 'contact_1')
  assert.equal(executed.data.updatedSample[0].url, undefined)
})

test('estado de integraciones es local y jamás entrega credenciales ni metadata cruda', async () => {
  const statusRecorder = recorder({
    highlevel: {
      configured: true,
      connected: true,
      locationId: 'location_1',
      locationData: { name: 'Cuenta privada' },
      accessToken: 'top-secret'
    },
    stripe: {
      configured: true,
      connected: true,
      mode: 'live',
      publicKey: 'pk_live_private',
      secretKey: 'sk_live_private',
      accountLabel: 'Cuenta principal'
    }
  })
  const result = await tool('integrations_status').execute(statusRecorder.context, {})
  assert.equal(statusRecorder.calls[0].request.query.verify, '0')
  assert.deepEqual(result, {
    success: true,
    data: {
      providers: {
        highlevel: { configured: true, connected: true, locationId: 'location_1' },
        stripe: { configured: true, connected: true, mode: 'live', accountLabel: 'Cuenta principal' }
      }
    }
  })
  assert.doesNotMatch(JSON.stringify(result), /top-secret|pk_live|sk_live|locationData|accessToken|secretKey/)
})

test('schemas comerciales no aceptan moneda, credenciales ni payloads arbitrarios', () => {
  const createProduct = tool('settings_product_create').inputSchema.properties
  assert.equal(createProduct.currency, undefined)
  assert.equal(createProduct.postWebhooks, undefined)
  assert.equal(createProduct.metadata, undefined)

  const subscriptionChanges = tool('settings_subscription_update').inputSchema.properties.changes.properties
  for (const forbidden of [
    'currency', 'status', 'paymentProvider', 'paymentMethod', 'paymentMethodId',
    'stripePaymentMethodId', 'metadata', 'raw', 'providerId', 'checkoutUrl'
  ]) {
    assert.equal(subscriptionChanges[forbidden], undefined, `${forbidden} no debe estar expuesto`)
  }
})
