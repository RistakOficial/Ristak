import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { DateTime } from 'luxon'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { initializeMasterKey } from '../src/utils/encryption.js'
import {
  renderTemplate,
  filtersMatch,
  evaluateConditionNode,
  handleAutomationEvent,
  handleIncomingMessage,
  processDueResumes,
  processScheduledTriggers,
  processScheduledContactEnrollments,
  enrollContactManually,
  controlAutomationEnrollment,
  resolveAutomationTemplateValue,
  testWebhookAction,
  resolveAutomationMediaAssetId,
  resolveAutomationMediaSource,
  resolveAutomationAudioDelivery,
  resolveAutomationVoicePublicUrl,
  inferAutomationDownloadedAudioMimeType,
  buildMetaSocialAutomationExternalIdBase
} from '../src/services/automationEngine.js'
import { resetCentralStorageConfigCache, uploadMediaAssetFromDataUrl } from '../src/services/mediaStorageService.js'
import { saveAutomationAsset } from '../src/services/automationsService.js'
import {
  connectEmail,
  setEmailMxResolverForTest,
  setEmailTransportFactoryForTest
} from '../src/services/emailService.js'
import { captureQrChatMessage, getWhatsAppApiConfigKeys } from '../src/services/whatsappApiService.js'
import { setAppNotificationPayloadSenderForTest } from '../src/services/pushNotificationsService.js'
import { createVariableField } from '../src/services/variableFieldsService.js'
import { upsertSystemTriggerLink } from '../src/services/triggerLinksService.js'
import { readTriggerLinkRecipientToken } from '../src/services/triggerLinkRecipientTokenService.js'
import { parseContactCustomFields } from '../src/utils/contactCustomFields.js'

const EMAIL_CONFIG_KEY = 'email_smtp_config'
const EMAIL_PASSWORD_KEY = 'email_smtp_password'
const EMAIL_SIGNATURE_CONFIG_KEY = 'email_signature_config'

const ctx = {
  contact: {
    firstName: 'María',
    lastName: 'López',
    fullName: 'María López',
    phone: '+5215511223344',
    email: 'maria@test.com',
    source: 'Facebook',
    customFields: { ciudad: 'CDMX', tags: ['cliente'] },
    tags: ['cliente']
  },
  messageText: 'Hola, quiero el precio por favor',
  channel: 'whatsapp'
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('IDs Meta de automatización son estables por reintento y cambian al reingresar', () => {
  const node = { id: 'channel-instagram-1' }
  const firstEnrollment = { id: 'enrollment-1', automationId: 'automation-1' }
  const secondEnrollment = { id: 'enrollment-2', automationId: 'automation-1' }

  const firstAttempt = buildMetaSocialAutomationExternalIdBase(node, {}, firstEnrollment)
  const retryAttempt = buildMetaSocialAutomationExternalIdBase(node, {}, firstEnrollment)
  const reentryAttempt = buildMetaSocialAutomationExternalIdBase(node, {}, secondEnrollment)

  assert.equal(firstAttempt, 'automation-1:enrollment-1:channel-instagram-1')
  assert.equal(retryAttempt, firstAttempt)
  assert.notEqual(reentryAttempt, firstAttempt)
})

async function withAppConfigValues(entries, callback) {
  const previous = {}
  for (const [key, value] of Object.entries(entries)) {
    previous[key] = await getAppConfig(key)
    await setAppConfig(key, value)
  }
  try {
    return await callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      await setAppConfig(key, value)
    }
  }
}

async function withMetaConfigSnapshot(callback) {
  const previousRows = await db.all('SELECT * FROM meta_config')
  try {
    await db.run('DELETE FROM meta_config')
    return await callback()
  } finally {
    await db.run('DELETE FROM meta_config')
    for (const row of previousRows) {
      const columns = Object.keys(row)
      await db.run(
        `INSERT INTO meta_config (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
        columns.map(column => row[column])
      )
    }
  }
}

test('renderTemplate reemplaza variables del contacto y la conversación', () => {
  assert.equal(renderTemplate('Hola {{contact.first_name}}!', ctx), 'Hola María!')
  assert.equal(renderTemplate('Dijiste: {{conversation.last_message}}', ctx), 'Dijiste: Hola, quiero el precio por favor')
  assert.equal(renderTemplate('{{contact.custom.ciudad}}', ctx), 'CDMX')
  assert.equal(renderTemplate('{{desconocida.x}}', ctx), '')
})

test('renderTemplate resuelve payloads de webhook con objetos y arrays anidados', () => {
  const payload = {
    categories: [
      { name: 'Trabajo', items: ['Reunión', 'Email'] },
      { name: 'Salud', items: ['Agua', 'Ejercicio'] }
    ],
    mixed: ['texto', { deep: { value: 7 } }]
  }
  assert.equal(renderTemplate('{{webhook.categories[0].name}}', { payload }), 'Trabajo')
  assert.equal(renderTemplate('{{webhook.categories[1].items[1]}}', { payload }), 'Ejercicio')
  assert.equal(renderTemplate('{{webhook.mixed[1].deep.value}}', { payload }), '7')
})

test('las automatizaciones convierten el enlace de ingreso de la cita en un enlace seguro', async () => {
  const suffix = randomUUID().replace(/-/g, '')
  const calendarId = `calendar_automation_meeting_${suffix}`
  const appointmentId = `appointment_automation_meeting_${suffix}`
  const contactId = `contact_automation_meeting_${suffix}`
  let triggerLink

  try {
    triggerLink = await upsertSystemTriggerLink({
      systemScope: 'calendar_meeting',
      ownerId: calendarId,
      name: `Videollamada de automatización ${suffix}`,
      destinationUrl: 'https://meet.google.com/abc-defg-hij'
    })

    const rendered = await resolveAutomationTemplateValue({
      subject: 'Enlace para tu cita',
      body: 'Ingresa aquí: {{cita.enlace_ingreso}}',
      bodyHtml: '<a href="{{cita.enlace_ingreso}}">Entrar a la videollamada</a>'
    }, {
      contact: { id: contactId, fullName: 'Contacto Videollamada' },
      appointmentId,
      calendarId,
      publicBaseUrl: 'https://app.ristak.test'
    })

    const bodyUrl = rendered.body.match(/https:\/\/app\.ristak\.test\/(pce1_[A-Za-z0-9_-]+)/)?.[0]
    assert.ok(bodyUrl, rendered.body)
    assert.equal(rendered.bodyHtml.includes(bodyUrl), true)
    assert.equal(bodyUrl.includes('meet.google.com'), false)
    assert.deepEqual(
      await readTriggerLinkRecipientToken(new URL(bodyUrl).pathname.slice(1)),
      { publicId: triggerLink.publicId, contactId, appointmentId }
    )
  } finally {
    if (triggerLink?.id) {
      await db.run('DELETE FROM trigger_link_events WHERE trigger_link_id = ?', [triggerLink.id]).catch(() => undefined)
      await db.run('DELETE FROM trigger_links WHERE id = ?', [triggerLink.id]).catch(() => undefined)
    }
  }
})

test('los adjuntos de automatización resuelven la URL pública CDN al asset interno', async () => {
  const suffix = randomUUID()
  const assetId = `rstk_media_automation_cdn_${suffix}`
  const publicUrl = `https://cdn.example.test/automations/${assetId}-foto.webp`

  try {
    await db.run(
      `INSERT INTO media_assets (id, business_id, public_url, status, storage_provider, module, metadata_json)
       VALUES (?, 'default', ?, 'ready', 'bunny', 'automations', '{}')`,
      [assetId, publicUrl]
    )

    assert.equal(await resolveAutomationMediaAssetId(publicUrl), assetId)
    assert.equal(await resolveAutomationMediaAssetId('https://files.example.test/foto.webp'), '')
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [assetId])
  }
})

test('las automatizaciones leen su audio administrado antes de entregarlo a cada canal', async () => {
  const previousProvider = process.env.MEDIA_STORAGE_PROVIDER
  const previousRequireBunny = process.env.MEDIA_STORAGE_REQUIRE_BUNNY
  const payload = Buffer.from('audio-de-automatizacion').toString('base64')
  let assetId = ''

  process.env.MEDIA_STORAGE_PROVIDER = 'local'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'false'
  resetCentralStorageConfigCache()

  try {
    const asset = await uploadMediaAssetFromDataUrl({
      fileBase64: `data:audio/mp4;base64,${payload}`,
      filename: 'nota.m4a',
      module: 'automations',
      isPublic: true,
      skipCompression: true
    })
    assetId = asset.id

    const source = await resolveAutomationMediaSource(asset.publicUrl)
    assert.equal(source.mediaAssetId, assetId)
    assert.equal(source.externalUrl, '')
    assert.equal(source.publicUrl, asset.publicUrl)
    assert.equal(source.mimeType, 'audio/mp4')
    assert.equal(source.dataUrl, `data:audio/mp4;base64,${payload}`)
  } finally {
    if (assetId) await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    if (previousProvider === undefined) delete process.env.MEDIA_STORAGE_PROVIDER
    else process.env.MEDIA_STORAGE_PROVIDER = previousProvider
    if (previousRequireBunny === undefined) delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    else process.env.MEDIA_STORAGE_REQUIRE_BUNNY = previousRequireBunny
    resetCentralStorageConfigCache()
  }
})

test('el bloque Audio conserva el MP3 original al subirlo a Automatizaciones', async () => {
  const previousProvider = process.env.MEDIA_STORAGE_PROVIDER
  const previousRequireBunny = process.env.MEDIA_STORAGE_REQUIRE_BUNNY
  const originalBytes = Buffer.from('ID3-audio-normal-de-automatizacion')
  let assetId = ''
  let localPath = ''

  process.env.MEDIA_STORAGE_PROVIDER = 'local'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'false'
  resetCentralStorageConfigCache()

  try {
    const asset = await saveAutomationAsset({
      fileBase64: `data:audio/mpeg;base64,${originalBytes.toString('base64')}`,
      filename: 'musica.mp3',
      deliveryMode: 'audio'
    })
    assetId = asset.id

    assert.equal(asset.contentType, 'audio/mpeg')
    assert.equal(asset.compression, 'disabled')
    const source = await resolveAutomationMediaSource(asset.url)
    assert.equal(source.mimeType, 'audio/mpeg')
    assert.deepEqual(Buffer.from(source.dataUrl.split(',')[1], 'base64'), originalBytes)

    const row = await db.get('SELECT metadata_json FROM media_assets WHERE id = ?', [assetId])
    localPath = JSON.parse(row?.metadata_json || '{}').localPath || ''
  } finally {
    if (assetId) await db.run('DELETE FROM media_assets WHERE id = ?', [assetId]).catch(() => undefined)
    if (localPath) await import('node:fs/promises').then(({ rm }) => rm(localPath, { force: true })).catch(() => undefined)
    if (previousProvider === undefined) delete process.env.MEDIA_STORAGE_PROVIDER
    else process.env.MEDIA_STORAGE_PROVIDER = previousProvider
    if (previousRequireBunny === undefined) delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    else process.env.MEDIA_STORAGE_REQUIRE_BUNNY = previousRequireBunny
    resetCentralStorageConfigCache()
  }
})

test('una nota de voz propia conserva URL y bytes para subirla como Media ID en YCloud', () => {
  const dataUrl = `data:audio/ogg;base64,${Buffer.from('OggS-test-OpusHead-audio').toString('base64')}`
  const publicUrl = 'https://cdn.example.test/automations/nota-validada.ogg'
  const delivery = resolveAutomationAudioDelivery({
    dataUrl,
    externalUrl: '',
    publicUrl,
    publicUrlVerified: true
  })

  assert.equal(delivery.audioDataUrl, dataUrl)
  assert.equal(delivery.audioUrl, publicUrl)
})

test('toda nota de voz administrada usa proxy .ogg aunque el asset conserve nombre MP3', () => {
  const deliveryUrl = resolveAutomationVoicePublicUrl({
    publicUrl: 'https://cdn.example.test/automations/grabacion-original.mp3',
    publicUrlVerified: true,
    mediaAssetId: 'rstk_media_voice_contract',
    ctx: { publicBaseUrl: 'https://ristak.test' }
  })

  assert.equal(
    deliveryUrl,
    'https://ristak.test/media/assets/rstk_media_voice_contract/voice.ogg'
  )
})

test('audio externo infiere MP3 aunque el CDN responda application/octet-stream', () => {
  assert.equal(inferAutomationDownloadedAudioMimeType({
    mimeType: 'application/octet-stream',
    url: 'https://cdn.example.test/audio/cancion.mp3',
    buffer: Buffer.from('ID3-audio')
  }), 'audio/mpeg')

  assert.throws(() => inferAutomationDownloadedAudioMimeType({
    mimeType: 'application/octet-stream',
    url: 'https://cdn.example.test/audio/sin-extension',
    buffer: Buffer.from('contenido-desconocido')
  }), /formato de audio reconocible/i)
})

test('una URL propia no verificada conserva los bytes para convertirlos antes del envío', () => {
  const dataUrl = `data:audio/mpeg;base64,${Buffer.from('mp3-sin-normalizar').toString('base64')}`
  const delivery = resolveAutomationAudioDelivery({
    dataUrl,
    publicUrl: 'https://cdn.example.test/automations/audio-original.mp3',
    publicUrlVerified: false
  })

  assert.equal(delivery.audioDataUrl, dataUrl)
  assert.equal(delivery.audioUrl, undefined)
})

test('una nota de voz legacy sin URL se publica desde sus bytes antes de enviarse', () => {
  const dataUrl = `data:audio/ogg;base64,${Buffer.from('legacy-audio').toString('base64')}`
  const delivery = resolveAutomationAudioDelivery({ dataUrl })

  assert.equal(delivery.audioDataUrl, dataUrl)
  assert.equal(delivery.audioUrl, undefined)
})

test('un audio externo conserva su URL para que el proveedor pueda descargarlo', () => {
  const delivery = resolveAutomationAudioDelivery({
    externalUrl: 'https://cdn.example.test/audio/externo.ogg'
  })

  assert.equal(delivery.audioDataUrl, undefined)
  assert.equal(delivery.audioUrl, 'https://cdn.example.test/audio/externo.ogg')
})

test('testWebhookAction ejecuta el POST y devuelve salida mapeable', async () => {
  let received = { headers: {}, body: {} }
  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', (chunk) => {
      rawBody += chunk
    })
    req.on('end', () => {
      received = {
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : {}
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        lead_id: 'lead_123',
        echo: received.body
      }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const result = await testWebhookAction(
      {
        url: `http://127.0.0.1:${port}/crm`,
        method: 'POST',
        headers: [{ key: 'X-Test-Token', value: '{{webhook.token}}' }],
        body: '{"email":"{{webhook.email}}","plan":"{{webhook.plan}}"}',
        timeout: 5
      },
      {
        payload: {
          email: 'lead@test.com',
          plan: 'Pro',
          token: 'tok_test'
        }
      }
    )

    assert.equal(result.ok, true)
    assert.equal(result.output.status, 'ok')
    assert.equal(result.output.status_code, 200)
    assert.equal(result.output.lead_id, 'lead_123')
    assert.deepEqual(result.output.respuesta.echo, { email: 'lead@test.com', plan: 'Pro' })
    assert.equal(received.headers['x-test-token'], 'tok_test')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('testWebhookAction resuelve campos variables y de contacto antes del contexto del webhook', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const field = await createVariableField({
    label: `Token webhook ${suffix}`,
    fieldKey: `webhook_token_${suffix}`,
    value: 'secreto-de-cuenta'
  })
  let received = { headers: {}, body: {} }
  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', chunk => { rawBody += chunk })
    req.on('end', () => {
      received = {
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : {}
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ accepted: true }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const result = await testWebhookAction({
      url: `http://127.0.0.1:${port}/variables`,
      method: 'POST',
      headers: [{ key: 'X-Account-Token', value: field.parameter }],
      bodyMode: 'fields',
      bodyFields: [
        { key: 'saludo', value: `Hola {{contact.first_name}}: ${field.parameter}` },
        { key: 'plan', value: '{{webhook.plan}}' }
      ],
      timeout: 5
    }, {
      contact: {
        firstName: 'Ana',
        phone: `+52155${Date.now().toString().slice(-8)}`
      },
      payload: { plan: 'Premium' }
    })

    assert.equal(result.ok, true)
    assert.equal(received.headers['x-account-token'], 'secreto-de-cuenta')
    assert.deepEqual(received.body, {
      saludo: 'Hola Ana: secreto-de-cuenta',
      plan: 'Premium'
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
    await db.run('DELETE FROM variable_fields WHERE id = ?', [field.id]).catch(() => undefined)
  }
})

test('testWebhookAction resuelve variables de cuenta de forma atómica sin reinterpretarlas como webhook', async () => {
  const suffix = randomUUID().replace(/-/g, '_')
  const field = await createVariableField({
    label: `Valor literal webhook ${suffix}`,
    fieldKey: `literal_webhook_${suffix}`,
    value: '{{webhook.plan}}'
  })
  let receivedBody = {}
  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', chunk => { rawBody += chunk })
    req.on('end', () => {
      receivedBody = rawBody ? JSON.parse(rawBody) : {}
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ accepted: true }))
    })
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const result = await testWebhookAction({
      url: `http://127.0.0.1:${port}/atomic-variables`,
      method: 'POST',
      bodyMode: 'fields',
      bodyFields: [{ key: 'plan', value: field.parameter }],
      timeout: 5
    }, {
      payload: { plan: 'Premium' }
    })

    assert.equal(result.ok, true)
    assert.deepEqual(receivedBody, { plan: '{{webhook.plan}}' })
  } finally {
    await new Promise(resolve => server.close(resolve))
    await db.run('DELETE FROM variable_fields WHERE id = ?', [field.id]).catch(() => undefined)
  }
})

test('testWebhookAction arma el body con campos sin escribir JSON', async () => {
  let received = { headers: {}, body: {} }
  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', (chunk) => {
      rawBody += chunk
    })
    req.on('end', () => {
      received = {
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : {}
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        accepted: true,
        received: received.body
      }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const result = await testWebhookAction(
      {
        url: `http://127.0.0.1:${port}/crm`,
        method: 'POST',
        headers: [{ key: 'X-Test-Token', value: '{{webhook.token}}' }],
        bodyMode: 'fields',
        bodyFields: [
          { key: 'email', value: '{{webhook.email}}' },
          { key: 'plan', value: '{{webhook.plan}}' },
          { key: 'origen', value: 'Ristak' }
        ],
        body: '{"ignored":true}',
        timeout: 5
      },
      {
        payload: {
          email: 'lead@test.com',
          plan: 'Pro',
          token: 'tok_test'
        }
      }
    )

    assert.equal(result.ok, true)
    assert.equal(received.headers['x-test-token'], 'tok_test')
    assert.equal(received.headers['content-type'], 'application/json')
    assert.deepEqual(received.body, { email: 'lead@test.com', plan: 'Pro', origen: 'Ristak' })
    assert.deepEqual(result.output.respuesta.received, received.body)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('un webhook con respuesta de error queda marcado en la inscripción y en el log', async () => {
  const suffix = randomUUID()
  const automationId = `automation_webhook_error_log_${suffix}`
  const contactId = `contact_webhook_error_log_${suffix}`
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.statusCode = 502
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'upstream_unavailable' }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          label: 'Cuando...',
          config: { triggers: [{ id: 'trigger-contact-created', type: 'trigger-contact-created', config: {} }] }
        },
        {
          id: 'webhook',
          type: 'action-webhook',
          label: 'Webhook de prueba',
          config: { url: `http://127.0.0.1:${port}/failure`, method: 'POST', body: '{}', timeout: 5 }
        }
      ],
      edges: [{ id: 'start-webhook', sourceNodeId: 'start', targetNodeId: 'webhook' }],
      settings: {}
    }

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+1555${Date.now().toString().slice(-8)}`, `error-${suffix}@example.com`, 'Contacto con error', 'Error', '{}']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test log webhook con error', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const enrollment = await db.get('SELECT execution_outcome, last_error, status, log FROM automation_enrollments WHERE automation_id = ?', [automationId])
    const log = JSON.parse(enrollment.log)
    const webhookLog = log.find((entry) => entry.nodeId === 'webhook')
    assert.equal(enrollment.execution_outcome, 'error')
    assert.match(enrollment.last_error, /Webhook respondi[oó] 502/)
    assert.equal(enrollment.status, 'completed')
    assert.equal(webhookLog.outcome, 'error')
    assert.equal(webhookLog.errorCode, 502)
    assert.match(webhookLog.errorMessage, /Webhook respondi[oó] 502/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})

test('testWebhookAction acepta headers en JSON cuando el usuario cambia de modo', async () => {
  let received = { headers: {}, body: {} }
  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', (chunk) => {
      rawBody += chunk
    })
    req.on('end', () => {
      received = {
        headers: req.headers,
        body: rawBody ? JSON.parse(rawBody) : {}
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const result = await testWebhookAction(
      {
        url: `http://127.0.0.1:${port}/crm`,
        method: 'POST',
        headersMode: 'json',
        headersJson: '{\n  "X-Test-Token": "{{webhook.token}}",\n  "X-Source": "Ristak"\n}',
        bodyMode: 'fields',
        bodyFields: [{ key: 'email', value: '{{webhook.email}}' }],
        timeout: 5
      },
      {
        payload: {
          email: 'lead@test.com',
          token: 'tok_test_json'
        }
      }
    )

    assert.equal(result.ok, true)
    assert.equal(received.headers['x-test-token'], 'tok_test_json')
    assert.equal(received.headers['x-source'], 'Ristak')
    assert.deepEqual(received.body, { email: 'lead@test.com' })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('webhook saliente expone respuestas como Webhook.response_01 y conserva alias legacy', async () => {
  const suffix = randomUUID()
  const automationId = `automation_webhook_response_root_${suffix}`
  const contactId = `contact_webhook_response_root_${suffix}`
  const username = `webhook-root-${suffix}@example.com`
  let userId = ''
  const sentPushes = []

  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ lead_id: `lead_${suffix}` }))
    })
  })

  setAppNotificationPayloadSenderForTest(async (payload, options) => {
    sentPushes.push({ payload, options })
    return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, 'admin', 1)`,
      [username, username, 'test-hash', 'Dueño Webhook']
    )
    userId = String(result.lastID || '')
    if (!userId) {
      const user = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = String(user.id)
    }

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `webhook-root-${suffix}@example.com`,
        'Lead Webhook',
        'Lead',
        JSON.stringify({ assignedUser: userId, assignedUserName: 'Dueño Webhook' })
      ]
    )

    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          label: 'Cuando...',
          config: {
            triggers: [{ id: 'trigger-contact-created', type: 'trigger-contact-created', config: {} }]
          }
        },
        {
          id: 'send-webhook',
          type: 'action-webhook',
          label: 'Webhook',
          config: {
            url: `http://127.0.0.1:${port}/lead`,
            method: 'POST',
            bodyMode: 'fields',
            bodyFields: [{ key: 'email', value: '{{contact.email}}' }],
            timeout: 5
          }
        },
        {
          id: 'notify-owner',
          type: 'action-system-notification',
          label: 'Notificación',
          config: {
            recipientMode: 'assigned_user',
            pushTitle: 'Lead creado',
            pushBody: 'Nuevo {{Webhook.response_01.lead_id}} / viejo {{http_request_1.lead_id}}',
            clickAction: 'phone_chat'
          }
        }
      ],
      edges: [
        { id: 'edge-start-webhook', sourceNodeId: 'start', targetNodeId: 'send-webhook' },
        { id: 'edge-webhook-notify', sourceNodeId: 'send-webhook', sourceHandle: 'out', targetNodeId: 'notify-owner' }
      ],
      settings: {}
    }

    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test respuesta webhook root', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const notification = await db.get(
      'SELECT * FROM internal_notifications WHERE automation_id = ? AND automation_node_id = ?',
      [automationId, 'notify-owner']
    )
    assert.equal(notification.message, `Nuevo lead_${suffix} / viejo lead_${suffix}`)
    assert.equal(sentPushes[0].payload.body, `Nuevo lead_${suffix} / viejo lead_${suffix}`)

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollment.status, 'completed')
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await new Promise((resolve) => server.close(resolve))
    await db.run('DELETE FROM internal_notifications WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('renderTemplate expone datos del pago para acciones posteriores', () => {
  const paymentCtx = {
    paymentId: 'pay_123',
    amount: 1499,
    currency: 'MXN',
    paymentStatus: 'paid',
    product: 'Curso',
    provider: 'stripe',
    paymentMode: 'live',
    eventId: 'evt_123',
    paymentMethod: 'card',
    reference: 'Invoice #INV-55',
    title: 'Venta curso',
    description: 'Acceso anual',
    publicPaymentId: 'pay_public_123',
    paymentUrl: 'https://app.test/pay/pay_public_123',
    invoiceId: 'inv_123',
    invoiceNumber: 'INV-55',
    stripePaymentIntentId: 'pi_123',
    stripeChargeId: 'ch_123',
    mercadoPagoPaymentId: 'mp_123',
    mercadoPagoPreferenceId: 'pref_123',
    conektaOrderId: 'ord_123',
    conektaChargeId: 'charge_123',
    conektaPaymentSourceId: 'src_123',
    paidAt: '2026-06-14T10:00:00.000Z',
    dueDate: '2026-06-20T10:00:00.000Z',
    sentAt: '2026-06-13T10:00:00.000Z',
    createdAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-14T10:05:00.000Z',
    paymentDate: '2026-06-14T10:00:00.000Z'
  }
  assert.equal(renderTemplate('{{pago_1.monto}} {{pago_1.moneda}}', paymentCtx), '1499 MXN')
  assert.equal(renderTemplate('{{payment.product}}', paymentCtx), 'Curso')
  assert.equal(renderTemplate('{{payment.invoice_number}}', paymentCtx), 'INV-55')
  assert.equal(renderTemplate('{{payment.mode}} {{payment.event_id}}', paymentCtx), 'live evt_123')
  assert.equal(renderTemplate('{{payment.reference}} {{payment.invoice_id}}', paymentCtx), 'Invoice #INV-55 inv_123')
  assert.equal(renderTemplate('{{payment.stripe_payment_intent_id}} {{payment.stripe_charge_id}}', paymentCtx), 'pi_123 ch_123')
  assert.equal(renderTemplate('{{payment.mercadopago_payment_id}} {{payment.mercadopago_preference_id}}', paymentCtx), 'mp_123 pref_123')
  assert.equal(renderTemplate('{{payment.conekta_order_id}} {{payment.conekta_payment_source_id}}', paymentCtx), 'ord_123 src_123')
  assert.equal(renderTemplate('{{payment.paid_at}} {{payment.due_date}}', paymentCtx), '2026-06-14T10:00:00.000Z 2026-06-20T10:00:00.000Z')
})

test('renderTemplate toma el producto del item de pago cuando viene en metadata', () => {
  const paymentCtx = {
    paymentId: 'pay_456',
    amount: 2500,
    currency: 'MXN',
    paymentStatus: 'paid',
    metadata: {
      lineItems: [
        {
          name: 'Programa: Magnetismo de Pacientes',
          productId: 'prod_magnetismo',
          localProductId: 'local_magnetismo'
        }
      ]
    }
  }

  assert.equal(renderTemplate('{{payment.product}}', paymentCtx), 'Programa: Magnetismo de Pacientes')
})

test('filtersMatch: coincide / NO coincide / contiene / NO contiene', () => {
  assert.equal(filtersMatch([{ field: 'source', match: 'is', value: 'facebook' }], ctx), true)
  assert.equal(filtersMatch([{ field: 'source', match: 'not', value: 'Facebook' }], ctx), false)
  assert.equal(filtersMatch([{ field: 'message', match: 'contains', value: 'PRECIO' }], ctx), true)
  assert.equal(filtersMatch([{ field: 'message', match: 'not_contains', value: 'precio' }], ctx), false)
  assert.equal(filtersMatch([{ field: 'custom', customKey: 'ciudad', match: 'is', value: 'cdmx' }], ctx), true)
  // Un filtro incompleto (sin campo) se ignora: por sí solo no bloquea
  assert.equal(filtersMatch([{ field: '', match: 'is', value: 'x' }], ctx), true)
  // Un campo del evento sin dato en este contexto (p. ej. calendario en un
  // mensaje) no bloquea: se trata como desconocido
  assert.equal(filtersMatch([{ field: 'calendar', match: 'is', value: 'x' }], ctx), true)
  // Los objetivos terminales usan modo estricto: un dato ausente o un filtro
  // incompleto nunca puede sacar al contacto por accidente.
  assert.equal(filtersMatch([{ field: 'calendar', match: 'is', value: 'x' }], ctx, { requireKnown: true }), false)
  assert.equal(filtersMatch([{ field: 'provider', match: 'is', value: '' }], ctx, { requireKnown: true }), false)
  assert.equal(filtersMatch([{ field: 'product', match: 'is', value: 'curso' }], ctx, { requireKnown: true }), false)
  // Un campo de contacto reconocido cuyo valor no coincide sí bloquea
  assert.equal(filtersMatch([{ field: 'stage', match: 'is', value: 'x' }], ctx), false)
})

test('filtersMatch: compara etapa comercial y pertenencia real de etiquetas', () => {
  const contactCtx = {
    contact: {
      firstName: 'Ana',
      lifecycleStage: 'customer',
      tagKeys: ['tag_vip', 'vip', 'tag_newsletter']
    }
  }

  assert.equal(filtersMatch([{ field: 'stage', match: 'is', value: 'Cliente' }], contactCtx), true)
  assert.equal(filtersMatch([{ field: 'stage', match: 'not', value: 'Agendó cita' }], contactCtx), true)
  assert.equal(filtersMatch([{ field: 'tag', match: 'is', value: 'tag_vip' }], contactCtx), true)
  assert.equal(filtersMatch([{ field: 'tag', match: 'not', value: 'tag_vip' }], contactCtx), false)
  assert.equal(filtersMatch([{ field: 'first_name', match: 'is', value: 'ana' }], contactCtx), true)
})

test('filtersMatch: filtra datos completos del evento de pago', () => {
  const paymentCtx = {
    paymentId: 'pay_123',
    amount: 1499,
    currency: 'MXN',
    paymentStatus: 'refunded',
    product: 'Curso',
    metadata: {
      lineItems: [
        {
          name: 'Curso',
          priceName: 'Mensualidad',
          productId: 'prod_curso',
          localProductId: 'local_curso',
          ghlProductId: 'ghl_curso',
          priceId: 'price_curso',
          localPriceId: 'local_price_curso',
          ghlPriceId: 'ghl_price_curso',
          sku: 'CURSO-001'
        }
      ]
    },
    provider: 'stripe',
    paymentMode: 'live',
    eventId: 'evt_123',
    paymentMethod: 'card',
    reference: 'Invoice #INV-55',
    title: 'Venta curso',
    description: 'Acceso anual',
    publicPaymentId: 'pay_public_123',
    paymentUrl: 'https://app.test/pay/pay_public_123',
    invoiceId: 'inv_123',
    invoiceNumber: 'INV-55',
    stripePaymentIntentId: 'pi_123',
    stripeChargeId: 'ch_123',
    mercadoPagoPaymentId: 'mp_123',
    mercadoPagoPreferenceId: 'pref_123',
    conektaOrderId: 'ord_123',
    conektaChargeId: 'charge_123',
    conektaPaymentSourceId: 'src_123',
    paidAt: '2026-06-14T10:00:00.000Z',
    dueDate: '2026-06-20T10:00:00.000Z',
    sentAt: '2026-06-13T10:00:00.000Z',
    createdAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-14T10:05:00.000Z',
    paymentDate: '2026-06-14T10:00:00.000Z'
  }
  assert.equal(filtersMatch([{ field: 'payment_status', match: 'is', value: 'refunded' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'amount', match: 'is', value: '1499' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product', match: 'is', value: 'prod_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product', match: 'is', value: 'local_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product', match: 'contains', value: 'curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product_name', match: 'is', value: 'Curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product_id', match: 'is', value: 'prod_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'local_product_id', match: 'is', value: 'local_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'ghl_product_id', match: 'is', value: 'ghl_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product_sku', match: 'is', value: 'CURSO-001' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'price_name', match: 'contains', value: 'mensual' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'price_id', match: 'is', value: 'price_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'local_price_id', match: 'is', value: 'local_price_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'ghl_price_id', match: 'is', value: 'ghl_price_curso' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'payment_method', match: 'contains', value: 'card' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'receipt', match: 'contains', value: 'INV-55' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'product', match: 'not', value: 'prod_otro' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'provider', match: 'is', value: 'stripe' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'provider', match: 'is', value: 'paypal' }], paymentCtx), false)
  assert.equal(filtersMatch([{ field: 'payment_mode', match: 'is', value: 'live' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'event_id', match: 'is', value: 'evt_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'reference', match: 'contains', value: 'INV-55' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'title', match: 'contains', value: 'Venta' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'description', match: 'contains', value: 'anual' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'public_payment_id', match: 'is', value: 'pay_public_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'payment_url', match: 'contains', value: '/pay/pay_public_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'receipt_url', match: 'contains', value: 'receipt=1' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'invoice_id', match: 'is', value: 'inv_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'invoice_number', match: 'is', value: 'INV-55' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'stripe_payment_intent_id', match: 'is', value: 'pi_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'stripe_charge_id', match: 'is', value: 'ch_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'mercadopago_payment_id', match: 'is', value: 'mp_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'mercadopago_preference_id', match: 'is', value: 'pref_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'conekta_order_id', match: 'is', value: 'ord_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'conekta_charge_id', match: 'is', value: 'charge_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'conekta_payment_source_id', match: 'is', value: 'src_123' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'paid_at', match: 'contains', value: '2026-06-14' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'payment_date', match: 'contains', value: '2026-06-14' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'due_date', match: 'contains', value: '2026-06-20' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'sent_at', match: 'contains', value: '2026-06-13' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'payment_created_at', match: 'contains', value: '2026-06-12' }], paymentCtx), true)
  assert.equal(filtersMatch([{ field: 'payment_updated_at', match: 'contains', value: '2026-06-14T10:05' }], paymentCtx), true)
})

test('filtersMatch: formulario enviado puede ser descalificado o no descalificado', () => {
  assert.equal(filtersMatch([{ field: 'form_disqualified', match: 'is_disqualified', value: '' }], {
    formStatus: 'disqualified'
  }), true)
  assert.equal(filtersMatch([{ field: 'form_disqualified', match: 'not_disqualified', value: '' }], {
    formStatus: 'received'
  }), true)
  assert.equal(filtersMatch([{ field: 'form_disqualified', match: 'is_disqualified', value: '' }], {
    formStatus: 'received'
  }), false)
})

test('formularios exponen respuestas no guardadas para variables, filtros y condiciones', () => {
  const formCtx = {
    contact: {
      fullName: 'Lead Formulario',
      phone: '+5215555555555',
      email: 'lead-form@test.com'
    },
    formId: 'site_form_123',
    formName: 'Diagnóstico',
    submissionId: 'submission_123',
    formStatus: 'disqualified',
    formDisqualified: true,
    submittedAt: '2026-06-17T20:00:00.000Z',
    formResponses: {
      answers: [
        { id: 'field_budget', key: 'presupuesto', label: 'Presupuesto mensual', value: '3500', text: '3,500 a 5,000 pesos', type: 'radio' },
        { id: 'field_need', key: 'necesidad', label: 'Necesidad', value: 'Seguimiento por WhatsApp', type: 'text' }
      ]
    }
  }

  assert.equal(renderTemplate('{{form.answers}}', formCtx), 'Presupuesto mensual: 3,500 a 5,000 pesos\nNecesidad: Seguimiento por WhatsApp')
  assert.equal(renderTemplate('{{formulario.respuestas.presupuesto}}', formCtx), '3500')
  assert.equal(renderTemplate('{{formulario.respuestas.presupuesto.value}}', formCtx), '3500')
  assert.equal(renderTemplate('{{formulario.respuestas.presupuesto.text}}', formCtx), '3,500 a 5,000 pesos')
  assert.equal(renderTemplate('{{formulario.respuestas.presupuesto.valor}}', formCtx), '3500')
  assert.equal(renderTemplate('{{formulario.respuestas.presupuesto.texto}}', formCtx), '3,500 a 5,000 pesos')
  assert.equal(renderTemplate('{{formulario.respuestas_por_id.field_budget}}', formCtx), '3500')
  assert.equal(renderTemplate('{{formulario.respuestas_por_id.field_budget.value}}', formCtx), '3500')
  assert.equal(renderTemplate('{{formulario.respuestas_por_id.field_budget.text}}', formCtx), '3,500 a 5,000 pesos')
  assert.equal(renderTemplate('{{form.responses.presupuesto.value}}', formCtx), '3500')
  assert.equal(renderTemplate('{{form.responses.presupuesto.text}}', formCtx), '3,500 a 5,000 pesos')
  assert.equal(renderTemplate('{{form.answers_by_id.field_budget.value}}', formCtx), '3500')
  assert.equal(renderTemplate('{{form.answers_by_id.field_budget.text}}', formCtx), '3,500 a 5,000 pesos')
  assert.equal(filtersMatch([{ field: 'form-specific', match: 'is', value: 'site_form_123' }], formCtx), true)
  assert.equal(filtersMatch([{ field: 'form-specific', match: 'is', value: 'site_form_otro' }], formCtx), false)
  assert.equal(filtersMatch([{ field: 'form-field-value', customKey: 'presupuesto', match: 'is', value: '3500' }], formCtx), true)
  assert.equal(filtersMatch([{ field: 'form-field-value', match: 'contains', value: 'WhatsApp' }], formCtx), true)

  const condition = {
    branches: [
      {
        name: 'Presupuesto suficiente',
        groupsOperator: 'AND',
        groups: [{
          operator: 'AND',
          negate: false,
          rules: [{
            field: 'var:formulario.respuestas.presupuesto',
            operator: 'gte',
            value: '3000'
          }]
        }]
      }
    ]
  }
  assert.equal(evaluateConditionNode(condition, formCtx).handle, 'yes')
})

test('trigger de formulario reconoce IDs específicos de formularios embebidos', async () => {
  const suffix = randomUUID()
  const automationId = `automation_embedded_form_${suffix}`
  const contactId = `contact_embedded_form_${suffix}`
  const siteId = `landing_${suffix}`
  const formSiteId = `${siteId}:form_embed:block_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: {
          triggers: [{
            id: 'trigger-form-submitted',
            type: 'trigger-form-submitted',
            config: { form: formSiteId }
          }]
        }
      }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `embedded-form-${suffix}@example.com`,
        'Lead Formulario Embebido',
        'Lead',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test formulario embebido', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('form-submitted', {
      contactId,
      formId: formSiteId,
      formName: 'Solicitud interna',
      siteId,
      siteName: 'Landing principal',
      formSiteId,
      formSiteName: 'Solicitud interna',
      submissionId: `submission_${suffix}`,
      formStatus: 'received'
    })

    const enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.ok(enrollment)
    const context = JSON.parse(enrollment.context || '{}')
    assert.equal(context.formSiteId, formSiteId)
    assert.equal(context.siteId, siteId)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('acción de añadir etiqueta no vuelve a disparar automatizaciones si la etiqueta ya estaba aplicada', async () => {
  const suffix = randomUUID()
  const automationId = `automation_tag_loop_${suffix}`
  const contactId = `contact_tag_loop_${suffix}`
  const tagId = `tag_loop_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: {
          triggers: [{
            id: 'trigger-contact-tag',
            type: 'trigger-contact-tag',
            config: { operator: 'added', tag: tagId, tagName: 'Prueba' }
          }]
        }
      },
      {
        id: 'add-same-tag',
        type: 'action-add-contact-tag',
        label: 'Añadir / eliminar etiqueta',
        position: { x: 420, y: 220 },
        config: { tag: tagId, tagName: 'Prueba' }
      }
    ],
    edges: [{
      id: 'edge-tag-loop',
      sourceNodeId: 'start',
      sourceHandle: 'out',
      targetNodeId: 'add-same-tag',
      targetHandle: 'in',
      animated: true
    }],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'Prueba'])
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, tags, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `tag-loop-${suffix}@example.com`,
        'Contacto Loop',
        'Contacto',
        JSON.stringify([tagId]),
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test loop etiqueta existente', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('tag-changed', {
      contactId,
      tag: 'Prueba',
      tagId,
      tagAction: 'added'
    })
    await sleep(80)

    const countRow = await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Number(countRow?.total || 0), 1)

    const enrollment = await db.get(
      'SELECT log FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? LIMIT 1',
      [automationId, contactId]
    )
    const log = JSON.parse(enrollment?.log || '[]')
    assert.ok(log.some((entry) => /ya estaba aplicada/.test(entry.detail || '')))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId]).catch(() => undefined)
  }
})

test('evaluateConditionNode: una rama → Sí/No', () => {
  const config = {
    branches: [
      {
        name: 'Interesado',
        groupsOperator: 'AND',
        groups: [{ operator: 'AND', negate: false, rules: [{ field: 'conv-keyword', operator: 'contains', value: 'precio' }] }]
      }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { ...ctx, messageText: 'gracias' }).handle, 'no')
})

test('evaluateConditionNode: usa la respuesta recibida de un evento anterior', () => {
  const config = {
    branches: [
      {
        name: 'Respuesta con precio',
        groupsOperator: 'AND',
        groups: [{
          operator: 'AND',
          negate: false,
          rules: [{
            field: 'var:respuesta_whatsapp.cuerpo',
            fieldLabel: 'Respuesta del contacto · Cuerpo',
            fieldType: 'text',
            operator: 'contains',
            value: 'precio'
          }]
        }]
      }
    ]
  }

  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { ...ctx, messageText: 'Solo quiero saludar' }).handle, 'no')
})

test('evaluateConditionNode: usa la salida de un webhook/post anterior', () => {
  const config = {
    branches: [
      {
        name: 'Webhook exitoso',
        groupsOperator: 'AND',
        groups: [{
          operator: 'AND',
          negate: false,
          rules: [
            {
              field: 'var:http_request_1.status_code',
              fieldLabel: 'HTTP Request #1 · Código de estado',
              fieldType: 'number',
              fieldSourceId: 'node-webhook',
              fieldPath: 'status_code',
              operator: 'gte',
              value: '200'
            },
            {
              field: 'var:http_request_1.respuesta.lead_id',
              fieldLabel: 'HTTP Request #1 · Respuesta > Lead ID',
              fieldType: 'text',
              fieldSourceId: 'node-webhook',
              fieldPath: 'respuesta.lead_id',
              operator: 'not_empty',
              value: ''
            }
          ]
        }]
      }
    ]
  }
  const webhookCtx = {
    __nodeOutputs: {
      'node-webhook': {
        status: 'ok',
        status_code: 201,
        respuesta: { lead_id: 'lead_123' }
      }
    }
  }

  assert.equal(evaluateConditionNode(config, webhookCtx).handle, 'yes')
  assert.equal(evaluateConditionNode(config, { __nodeOutputs: { 'node-webhook': { status_code: 500, respuesta: {} } } }).handle, 'no')
})

test('evaluateConditionNode: multi-rama elige la primera que cumple, si no "none"', () => {
  const config = {
    branches: [
      { id: 'b1', name: 'Por email', groups: [{ operator: 'AND', rules: [{ field: 'contact-email', operator: 'contains', value: '@otro.com' }] }] },
      { id: 'b2', name: 'Facebook', groups: [{ operator: 'AND', rules: [{ field: 'contact-source', operator: 'is', value: 'facebook' }] }] }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'b2')
  const none = evaluateConditionNode(config, { ...ctx, contact: { ...ctx.contact, source: 'Google', email: 'a@b.c' } })
  assert.equal(none.handle, 'none')
})

test('evaluateConditionNode: grupo negado y operador OR', () => {
  const config = {
    branches: [
      {
        name: 'Regla',
        groupsOperator: 'AND',
        groups: [
          { operator: 'OR', negate: false, rules: [
            { field: 'contact-first-name', operator: 'is', value: 'Pedro' },
            { field: 'contact-first-name', operator: 'is', value: 'María' }
          ] },
          { operator: 'AND', negate: true, rules: [{ field: 'contact-source', operator: 'is', value: 'Google' }] }
        ]
      }
    ]
  }
  assert.equal(evaluateConditionNode(config, ctx).handle, 'yes')
})

test('filtersMatch: conector O entre filtros', () => {
  const filters = [
    { field: 'source', match: 'is', value: 'Google' },
    { field: 'message', match: 'contains', value: 'precio', connector: 'or' }
  ]
  assert.equal(filtersMatch(filters, ctx), true) // fuente falla pero mensaje sí (O)
  const andFilters = [
    { field: 'source', match: 'is', value: 'Google' },
    { field: 'message', match: 'contains', value: 'precio', connector: 'and' }
  ]
  assert.equal(filtersMatch(andFilters, ctx), false)
})

test('disparador de mensaje de WhatsApp inscribe al contacto cuando llega un mensaje', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_whatsapp_trigger_${suffix}`
  const automationId = `automation_whatsapp_trigger_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-whatsapp',
              type: 'trigger-whatsapp-message',
              config: { keywords: ['holii'], match: 'contains' }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `whatsapp-trigger-${suffix}@example.com`,
        'Contacto WhatsApp Trigger',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test mensaje WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola, holii',
      channel: 'WhatsApp API'
    })

    const enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.ok(log.some((entry) => String(entry.detail || '').includes('mensaje por whatsapp')))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('disparador de comentario de Facebook inscribe al contacto con plataforma Facebook', async () => {
  const runCase = async (platform, label) => {
    const suffix = `${label}_${randomUUID()}`
    const contactId = `rstk_contact_fb_comment_${suffix}`
    const automationId = `automation_fb_comment_${suffix}`
    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          label: 'Cuando...',
          config: {
            triggers: [
              {
                id: 'trigger-facebook-comment',
                type: 'trigger-facebook-comment',
                config: { keywords: ['precio'], match: 'contains' }
              }
            ]
          }
        },
        {
          id: 'done',
          type: 'extra-comment',
          label: 'Listo',
          config: {}
        }
      ],
      edges: [
        { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
      ],
      settings: {}
    }

    try {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `+1555${Date.now().toString().slice(-8)}${label.length}`,
          `fb-comment-${suffix}@example.com`,
          'Contacto Facebook Comment',
          'Contacto',
          '{}'
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test comentario Facebook', JSON.stringify(flow), JSON.stringify(flow)]
      )

      await handleAutomationEvent('comment-received', {
        contactId,
        platform,
        messageText: 'precio por favor',
        commentId: `comment_${suffix}`,
        postId: `post_${suffix}`
      })

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.ok(enrollment)
      assert.equal(enrollment.status, 'completed')
      assert.equal(enrollment.current_node_id, 'done')
      const log = JSON.parse(enrollment.log)
      assert.ok(log.some((entry) => String(entry.detail || '').includes('publicación de Facebook')))
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  }

  await runCase('facebook', 'facebook')
  await runCase('messenger', 'messenger_compat')
})

test('reintento de respuesta a comentario conserva contexto de Facebook', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_fb_comment_retry_${suffix}`
  const automationId = `automation_fb_comment_retry_${suffix}`
  const commentId = `comment_retry_${suffix}`
  const postId = `post_retry_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-facebook-comment',
              type: 'trigger-facebook-comment',
              config: { allowedComments: 'all' }
            }
          ]
        }
      },
      {
        id: 'reply',
        type: 'channel-comment-public-reply',
        label: 'Responder comentario',
        config: {
          commentReplyTarget: 'facebook_public_comment',
          replyType: 'public',
          messageBlocks: [
            { id: 'reply-text', type: 'text', compiledText: 'Test' }
          ]
        }
      }
    ],
    edges: [
      { id: 'edge-start-reply', sourceNodeId: 'start', targetNodeId: 'reply' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `fb-comment-retry-${suffix}@example.com`,
        'Contacto Facebook Retry',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test retry comentario Facebook', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await withMetaConfigSnapshot(async () => {
      await withAppConfigValues({ meta_facebook_comments_enabled: '1' }, async () => {
        await handleAutomationEvent('comment-received', {
          contactId,
          platform: 'facebook',
          messageText: 'precio',
          commentId,
          postId,
          parentCommentId: postId,
          permalink: 'https://facebook.test/reel/retry'
        })
      })
    })

    const enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'retry')
    assert.equal(enrollment.current_node_id, 'reply')

    const storedContext = JSON.parse(enrollment.context)
    assert.equal(storedContext.platform, 'facebook')
    assert.equal(storedContext.commentId, commentId)
    assert.equal(storedContext.postId, postId)
    assert.equal(storedContext.parentCommentId, postId)
    assert.equal(storedContext.permalink, 'https://facebook.test/reel/retry')
    assert.equal(storedContext.__retryNodeId, 'reply')
    assert.equal(storedContext.__retryAttempts, 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('acción de correo en automatizaciones envía email al contacto y registra salida', async () => {
  await initializeMasterKey()

  const suffix = randomUUID()
  const contactId = `rstk_contact_email_action_${suffix}`
  const automationId = `automation_email_action_${suffix}`
  const sentMessages = []
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-whatsapp',
              type: 'trigger-whatsapp-message',
              config: { keywords: ['correo'], match: 'contains' }
            }
          ]
        }
      },
      {
        id: 'email',
        type: 'channel-email',
        label: 'Correo',
        config: {
          toEmail: '{{contact.email}}',
          subject: 'Hola {{contact.first_name}}',
          body: 'Te escribo por correo sobre: {{conversation.last_message}}',
          bodyHtml: '<p><strong>Te escribo por correo</strong> sobre: {{conversation.last_message}}</p>',
          includeSignature: false
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-email', sourceNodeId: 'start', targetNodeId: 'email' },
      { id: 'edge-email-done', sourceNodeId: 'email', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: {}
  }

  await withAppConfigValues({
    [EMAIL_CONFIG_KEY]: null,
    [EMAIL_PASSWORD_KEY]: null,
    [EMAIL_SIGNATURE_CONFIG_KEY]: null
  }, async () => {
    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `automation-smtp-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))

    try {
      await connectEmail({
        fromEmail: 'ventas@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo',
        inbound: { enabled: false }
      })
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `+1555${Date.now().toString().slice(-8)}`,
          `email-action-${suffix}@example.com`,
          'María Correo',
          'María',
          '{}'
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test enviar correo', JSON.stringify(flow), JSON.stringify(flow)]
      )

      await handleAutomationEvent('message-received', {
        contactId,
        messageText: 'quiero correo con detalles',
        channel: 'WhatsApp API'
      })

      const emailMessage = await db.get(
        'SELECT * FROM email_messages WHERE contact_id = ? AND subject = ?',
        [contactId, 'Hola María']
      )
      assert.ok(emailMessage)
      assert.equal(emailMessage.status, 'sent')
      assert.equal(emailMessage.to_email, `email-action-${suffix}@example.com`)
      assert.match(emailMessage.message_text, /quiero correo con detalles/)
      assert.match(emailMessage.html_body, /<strong>Te escribo por correo<\/strong>/)
      assert.match(emailMessage.html_body, /quiero correo con detalles/)
      assert.equal(sentMessages.length, 2)
      assert.match(sentMessages[1].html, /<strong>Te escribo por correo<\/strong>/)

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.ok(enrollment)
      assert.equal(enrollment.status, 'completed')
      const log = JSON.parse(enrollment.log)
      assert.ok(log.some((entry) => String(entry.detail || '').includes('Correo enviado')))
    } finally {
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId])
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})

test('mensaje entrante por QR dispara automatizaciones de WhatsApp', async () => {
  const suffix = randomUUID()
  const keys = getWhatsAppApiConfigKeys()
  const phoneNumberId = `qr_phone_${suffix}`
  const businessPhone = `+5215500${Date.now().toString().slice(-6)}`
  const contactPhone = `+5215511${Date.now().toString().slice(-6)}`
  const contactId = `rstk_contact_qr_trigger_${suffix}`
  const automationId = `automation_qr_trigger_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-whatsapp',
              type: 'trigger-whatsapp-message',
              config: { keywords: [], match: 'contains' }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: {}
  }

  await withAppConfigValues({
    [keys.enabled]: '0',
    [keys.apiKey]: '',
    [keys.phoneNumberId]: '',
    [keys.senderPhone]: '',
    [keys.wabaId]: ''
  }, async () => {
    try {
      await db.run(
        `INSERT INTO whatsapp_api_phone_numbers (
          id, phone_number, display_phone_number, verified_name, label,
          is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 0, 1, 'connected', 'CONNECTED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [phoneNumberId, businessPhone, businessPhone, 'QR Test', 'QR Test']
      )
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          contactPhone,
          `qr-trigger-${suffix}@example.com`,
          'Contacto QR Trigger',
          'Contacto',
          '{}'
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test QR WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
      )

      const result = await captureQrChatMessage({
        phoneNumberId,
        businessPhone,
        direction: 'inbound',
        wamid: `wamid_qr_trigger_${suffix}`,
        messageType: 'text',
        text: 'hola desde QR',
        profileName: 'Contacto QR Trigger',
        contactPhone,
        timestamp: new Date().toISOString(),
        raw: { test: true }
      })

      assert.equal(result.skipped, false)
      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.ok(enrollment)
      assert.equal(enrollment.status, 'completed')
      assert.equal(enrollment.current_node_id, 'done')
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ?', [contactPhone]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [contactPhone]).catch(() => undefined)
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})

test('logic-wait por duración respeta segundos', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_wait_seconds_${suffix}`
  const automationId = `automation_wait_seconds_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'wait-seconds',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'duration',
          amount: 10,
          unit: 'seconds'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-seconds' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-seconds', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `wait-seconds-${suffix}@example.com`,
        'Contacto Segundos',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test espera segundos', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const before = Date.now()
    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola',
      channel: 'whatsapp'
    })
    const after = Date.now()

    const enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    const resumeAt = new Date(enrollment.resume_at).getTime()
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'duration')
    assert.equal(enrollment.current_node_id, 'wait-seconds')
    assert.ok(resumeAt >= before + 10_000)
    assert.ok(resumeAt <= after + 11_000)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('logic-drip libera por lotes y reanuda cuando vence el intervalo', async () => {
  const suffix = randomUUID()
  const automationId = `automation_drip_${suffix}`
  const contactIds = [1, 2, 3].map((index) => `rstk_contact_drip_${index}_${suffix}`)
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'drip',
        type: 'logic-drip',
        label: 'Goteo',
        config: {
          batchSize: 2,
          intervalAmount: 1,
          intervalUnit: 'minutes'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-drip', sourceNodeId: 'start', targetNodeId: 'drip' },
      { id: 'edge-drip-done', sourceNodeId: 'drip', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    for (const [index, contactId] of contactIds.entries()) {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `+1666${Date.now().toString().slice(-7)}${index}`,
          `drip-${index}-${suffix}@example.com`,
          `Contacto Goteo ${index + 1}`,
          'Contacto',
          '{}'
        ]
      )
    }
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test goteo', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const before = Date.now()
    for (const contactId of contactIds) {
      await handleAutomationEvent('message-received', {
        contactId,
        messageText: 'hola',
        channel: 'whatsapp'
      })
    }
    const after = Date.now()

    const entries = await db.all(
      'SELECT position, batch_index, scheduled_for FROM automation_drip_entries WHERE automation_id = ? ORDER BY position',
      [automationId]
    )
    assert.deepEqual(entries.map((entry) => Number(entry.position)), [1, 2, 3])
    assert.deepEqual(entries.map((entry) => Number(entry.batch_index)), [0, 0, 1])

    const firstEnrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactIds[0]]
    )
    const secondEnrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactIds[1]]
    )
    const thirdEnrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactIds[2]]
    )

    assert.equal(firstEnrollment.status, 'completed')
    assert.equal(secondEnrollment.status, 'completed')
    assert.equal(thirdEnrollment.status, 'waiting')
    assert.equal(thirdEnrollment.wait_kind, 'drip')
    assert.equal(thirdEnrollment.current_node_id, 'drip')

    const resumeAt = new Date(thirdEnrollment.resume_at).getTime()
    assert.ok(resumeAt >= before + 60_000)
    assert.ok(resumeAt <= after + 61_000)

    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), thirdEnrollment.id]
    )
    await processDueResumes()

    const resumedEnrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [thirdEnrollment.id])
    assert.equal(resumedEnrollment.status, 'completed')
    const log = JSON.parse(resumedEnrollment.log)
    assert.ok(log.some((entry) => entry.label === 'Goteo' && String(entry.detail || '').includes('lote 2')))
  } finally {
    await db.run('DELETE FROM automation_drip_entries WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    for (const contactId of contactIds) {
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  }
})

test('logic-wait por clic de disparo reanuda cuando llega el trigger link configurado', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_trigger_wait_${suffix}`
  const automationId = `automation_trigger_wait_${suffix}`
  const matchingTriggerLinkId = `trigger_link_${suffix}`
  const otherTriggerLinkId = `trigger_link_other_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'wait-click',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'action',
          expectedAction: 'click_link',
          actionResource: matchingTriggerLinkId,
          actionResourceName: 'Promo demo'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-click' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-click', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `trigger-${suffix}@example.com`,
        'Contacto Trigger',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test clic de disparo', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola',
      channel: 'whatsapp'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'trigger-link-click')
    assert.equal(enrollment.current_node_id, 'wait-click')
    assert.equal(JSON.parse(enrollment.context).waitActionResource, matchingTriggerLinkId)

    await handleAutomationEvent('trigger-link-clicked', {
      contactId,
      triggerLinkId: otherTriggerLinkId,
      triggerLinkPublicId: 'otro-publico',
      triggerLinkName: 'Otro link'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')

    await handleAutomationEvent('trigger-link-clicked', {
      contactId,
      triggerLinkId: matchingTriggerLinkId,
      triggerLinkPublicId: 'promo-publica',
      triggerLinkName: 'Promo demo'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Clic de disparo recibido')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('logic-wait por respuesta a mensaje queda esperando y reanuda con el siguiente mensaje', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_reply_wait_${suffix}`
  const automationId = `automation_reply_wait_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-message',
              type: 'trigger-customer-replied',
              config: { channel: 'any' }
            }
          ]
        }
      },
      {
        id: 'wait-reply',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'action',
          expectedAction: 'reply_message',
          actionResource: 'msg-whatsapp-1',
          actionResourceName: 'WhatsApp de bienvenida'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-reply' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-reply', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: false }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1666${Date.now().toString().slice(-8)}`,
        `reply-${suffix}@example.com`,
        'Contacto Reply',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test respuesta a mensaje', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('message-received', {
      contactId,
      messageText: 'hola',
      channel: 'whatsapp'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.wait_kind, 'reply')
    assert.equal(enrollment.current_node_id, 'wait-reply')
    assert.equal(JSON.parse(enrollment.context).waitActionResource, 'msg-whatsapp-1')

    await handleIncomingMessage({
      contactId,
      text: 'sí me interesa',
      channel: 'whatsapp'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('respondió a "WhatsApp de bienvenida"')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger Pagos distingue acción del pago y filtros del recibo', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_payment_trigger_${suffix}`
  const automationId = `automation_payment_trigger_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-payment',
              type: 'trigger-payment-received',
              config: {
                paymentAction: 'refunded',
                filters: [{ field: 'provider', match: 'is', value: 'stripe' }]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `payment-trigger-${suffix}@example.com`,
        'Contacto Pago',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test pagos refund', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentStatus: 'failed',
      provider: 'stripe',
      amount: 1200,
      currency: 'MXN'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Boolean(enrollment), false)

    await handleAutomationEvent('refund', {
      contactId,
      paymentStatus: 'refunded',
      provider: 'paypal',
      amount: 1200,
      currency: 'MXN'
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Boolean(enrollment), false)

    await handleAutomationEvent('refund', {
      contactId,
      paymentId: `pay_${suffix}`,
      paymentStatus: 'refunded',
      provider: 'stripe',
      paymentMethod: 'card',
      product: 'Curso',
      amount: 1200,
      currency: 'MXN',
      invoiceNumber: `INV-${suffix.slice(0, 6)}`
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger Pagos con Todos acepta cualquier tipo de evento de pago por default', async () => {
  const suffix = randomUUID()
  const cases = [
    { paymentAction: 'any', label: 'any' },
    { paymentAction: '', label: 'legacy-empty' }
  ]
  const created = []

  try {
    for (const item of cases) {
      const contactId = `rstk_contact_payment_any_${item.label}_${suffix}`
      const automationId = `automation_payment_any_${item.label}_${suffix}`
      created.push({ contactId, automationId })

      const flow = {
        nodes: [
          {
            id: 'start',
            type: 'start',
            label: 'Cuando...',
            config: {
              triggers: [
                {
                  id: 'trigger-payment',
                  type: 'trigger-payment-received',
                  config: { paymentAction: item.paymentAction }
                }
              ]
            }
          },
          {
            id: 'done',
            type: 'extra-comment',
            label: 'Listo',
            config: {}
          }
        ],
        edges: [
          { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
        ],
        settings: {}
      }

      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `+1555${Date.now().toString().slice(-8)}`,
          `payment-any-${item.label}-${suffix}@example.com`,
          'Contacto Pago Todos',
          'Contacto',
          '{}'
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, `Test pagos todos ${item.label}`, JSON.stringify(flow), JSON.stringify(flow)]
      )

      await handleAutomationEvent('refund', {
        contactId,
        paymentId: `pay_any_${item.label}_${suffix}`,
        paymentStatus: 'refunded',
        provider: 'stripe',
        amount: 1200,
        currency: 'MXN'
      })

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'completed')
      assert.equal(enrollment.current_node_id, 'done')
    }
  } finally {
    for (const item of created) {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [item.automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [item.automationId])
      await db.run('DELETE FROM contacts WHERE id = ?', [item.contactId])
    }
  }
})

test('webhook encuentra contacto por valor mapeado y asigna usuario', async () => {
  const suffix = randomUUID()
  const contactId = `rstk_contact_webhook_find_${suffix}`
  const automationId = `automation_webhook_find_${suffix}`
  const endpointId = `hook_${suffix}`
  const email = `webhook-find-${suffix}@example.com`
  const assignedUser = `user_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-webhook',
              type: 'trigger-incoming-webhook',
              config: { endpointId }
            }
          ]
        }
      },
      {
        id: 'find-contact',
        type: 'action-find-contact',
        label: 'Encontrar contacto',
        config: {
          searchBy: 'email',
          lookupValue: '{{webhook.contacts[0].email}}',
          notFound: 'stop'
        }
      },
      {
        id: 'assign-user',
        type: 'action-contact-user',
        label: 'Añadir / eliminar usuario asignado',
        config: {
          userAction: 'assign',
          user: assignedUser,
          userName: 'Ventas'
        }
      }
    ],
    edges: [
      { id: 'edge-start-find', sourceNodeId: 'start', targetNodeId: 'find-contact' },
      { id: 'edge-find-assign', sourceNodeId: 'find-contact', sourceHandle: 'out', targetNodeId: 'assign-user' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        email,
        'Contacto Webhook',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test webhook find', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('webhook-received', {
      endpointId,
      payload: {
        contacts: [
          {
            email,
            categories: [
              { name: 'Trabajo', items: ['Reunión', 'Email'] }
            ]
          }
        ]
      }
    })

    const contact = await db.get('SELECT custom_fields FROM contacts WHERE id = ?', [contactId])
    const customFields = new Map(
      parseContactCustomFields(contact.custom_fields).map(field => [field.fieldKey, field.value])
    )
    assert.equal(customFields.get('assignedUser'), assignedUser)
    assert.equal(customFields.get('assignedUserName'), 'Ventas')

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.contact_id, contactId)
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Contacto encontrado')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('notificación interna desde automatización crea aviso y push para usuario asignado', async () => {
  const suffix = randomUUID()
  const automationId = `automation_internal_notification_${suffix}`
  const contactId = `contact_internal_notification_${suffix}`
  const username = `notifier-${suffix}@example.com`
  let userId = ''
  const sentPushes = []

  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-created',
              type: 'trigger-contact-created',
              config: {}
            }
          ]
        }
      },
      {
        id: 'notify-owner',
        type: 'action-system-notification',
        label: 'Notificaciones',
        config: {
          recipientMode: 'assigned_user',
          contactId: `legacy-wrong-contact-${suffix}`,
          pushTitle: 'Nuevo lead: {{contact.first_name}}',
          pushBody: 'Revisa a {{contact.full_name}} en Ristak',
          clickAction: 'phone_chat'
        }
      }
    ],
    edges: [
      { id: 'edge-start-notify', sourceNodeId: 'start', targetNodeId: 'notify-owner' }
    ],
    settings: {}
  }

  setAppNotificationPayloadSenderForTest(async (payload, options) => {
    sentPushes.push({ payload, options })
    return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
  })

  try {
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, 'admin', 1)`,
      [username, username, 'test-hash', 'Dueño Notificación']
    )
    userId = String(result.lastID || '')
    if (!userId) {
      const user = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = String(user.id)
    }

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `internal-notification-${suffix}@example.com`,
        'Lead Notificación',
        'Lead',
        JSON.stringify({ assignedUser: userId, assignedUserName: 'Dueño Notificación' })
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test notificación interna', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const notification = await db.get(
      'SELECT * FROM internal_notifications WHERE automation_id = ? AND automation_node_id = ?',
      [automationId, 'notify-owner']
    )
    assert.equal(notification.recipient_user_id, userId)
    assert.equal(notification.title, 'Nuevo lead: Lead')
    assert.equal(notification.message, 'Revisa a Lead Notificación en Ristak')
    assert.equal(notification.action_url, `/movil?contact=${encodeURIComponent(contactId)}`)

    assert.equal(sentPushes.length, 1)
    assert.deepEqual(sentPushes[0].options.userIds, [userId])
    assert.equal(sentPushes[0].payload.title, 'Nuevo lead: Lead')
    assert.equal(sentPushes[0].payload.body, 'Revisa a Lead Notificación en Ristak')

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollment.status, 'completed')
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM internal_notifications WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('esperar una cita conserva la identidad de la cita que disparó la ejecución', async () => {
  const suffix = randomUUID()
  const automationId = `automation_trigger_appointment_context_${suffix}`
  const contactId = `contact_trigger_appointment_context_${suffix}`
  const triggerAppointmentId = `appointment_trigger_context_${suffix}`
  const otherAppointmentId = `appointment_other_context_${suffix}`
  const initialStart = new Date(Date.now() + (4 * 60 * 60 * 1000)).toISOString()
  const otherStart = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString()
  const rescheduledStart = new Date(Date.now() + (6 * 60 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const waitTarget = (start) => new Date(new Date(start).getTime() - oneHour).toISOString()

  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-appointment-booked',
              type: 'trigger-appointment-booked',
              config: {}
            }
          ]
        }
      },
      {
        id: 'wait-trigger-appointment',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'appointment',
          calendar: 'legacy-calendar-that-must-not-override-trigger',
          appointmentType: 'legacy-type-that-must-not-override-trigger',
          appointmentStatus: 'booked',
          appointmentOffset: 'before',
          offsetAmount: 1,
          offsetUnit: 'hours'
        }
      },
      {
        id: 'appointment-time-reached',
        type: 'logic-condition',
        label: 'Momento de la cita',
        config: { conditions: [] }
      }
    ],
    edges: [
      {
        id: 'edge-start-wait',
        sourceNodeId: 'start',
        targetNodeId: 'wait-trigger-appointment'
      },
      {
        id: 'edge-wait-time',
        sourceNodeId: 'wait-trigger-appointment',
        sourceHandle: 'out',
        targetNodeId: 'appointment-time-reached'
      }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `appointment-context-${suffix}@example.com`,
        'Contacto Cita Contextual',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contexto de cita', JSON.stringify(flow), JSON.stringify(flow)]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES
         (?, 'calendar-trigger', ?, 'Cita original', 'booked', 'booked', ?, ?),
         (?, 'calendar-trigger', ?, 'Cita reemplazo', 'confirmed', 'confirmed', ?, ?)`,
      [
        triggerAppointmentId,
        contactId,
        initialStart,
        new Date(new Date(initialStart).getTime() + oneHour).toISOString(),
        otherAppointmentId,
        contactId,
        otherStart,
        new Date(new Date(otherStart).getTime() + oneHour).toISOString()
      ]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId: triggerAppointmentId,
      calendarId: 'calendar-trigger',
      status: 'booked',
      startTime: initialStart
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.resume_at, waitTarget(initialStart))
    let storedContext = JSON.parse(enrollment.context)
    assert.equal(storedContext.appointmentId, triggerAppointmentId)
    assert.equal(storedContext.startTime, initialStart)
    assert.equal(storedContext.waitAppointmentId, triggerAppointmentId)

    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId: otherAppointmentId,
      calendarId: 'calendar-other',
      status: 'confirmed',
      startTime: otherStart
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.resume_at, waitTarget(initialStart))
    storedContext = JSON.parse(enrollment.context)
    assert.equal(storedContext.waitAppointmentId, triggerAppointmentId)

    await db.run(
      `UPDATE appointments
       SET status = 'confirmed', appointment_status = 'confirmed', start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        rescheduledStart,
        new Date(new Date(rescheduledStart).getTime() + oneHour).toISOString(),
        triggerAppointmentId
      ]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId: triggerAppointmentId,
      calendarId: 'calendar-trigger',
      status: 'confirmed',
      startTime: rescheduledStart
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.resume_at, waitTarget(rescheduledStart))
    storedContext = JSON.parse(enrollment.context)
    assert.equal(storedContext.waitAppointmentId, triggerAppointmentId)
    assert.equal(storedContext.startTime, rescheduledStart)

    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId: otherAppointmentId,
      replacesAppointmentId: triggerAppointmentId,
      calendarId: 'calendar-trigger',
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: otherStart
    })

    const preservedEnrollmentId = enrollment.id
    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE id = ?',
      [preservedEnrollmentId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.resume_at, waitTarget(otherStart))
    storedContext = JSON.parse(enrollment.context)
    assert.equal(storedContext.waitAppointmentId, otherAppointmentId)
    assert.equal(storedContext.appointmentId, otherAppointmentId)
    assert.equal(storedContext.appointmentLifecycleAppointmentId, otherAppointmentId)
    const rescheduledLog = JSON.parse(enrollment.log)
    assert.ok(rescheduledLog.some(entry => entry.detail.includes('conservó su progreso')))
    const enrollmentCount = await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Number(enrollmentCount.total), 1)

    await db.run(
      `UPDATE appointments
       SET status = 'cancelled', appointment_status = 'cancelled'
       WHERE id = ?`,
      [otherAppointmentId]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId: otherAppointmentId,
      calendarId: 'calendar-trigger',
      status: 'cancelled',
      appointmentChange: 'cancelled',
      startTime: otherStart
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'exited', JSON.stringify({
      context: JSON.parse(enrollment.context),
      log: JSON.parse(enrollment.log)
    }, null, 2))
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some(entry => entry.nodeId === 'appointment-time-reached'), false)
    assert.ok(log.some(entry => (
      entry.nodeId === 'wait-trigger-appointment' &&
      entry.detail.includes('salió automáticamente del flujo')
    )))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id IN (?, ?)', [triggerAppointmentId, otherAppointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('Esperar antes de una cita aplica la ruta elegida cuando el contacto llega tarde', async () => {
  const cases = [
    { action: 'continue', expectedNodeId: 'downstream-wait', expectedStatus: 'waiting', runsIntermediate: true },
    { action: 'next_wait', expectedNodeId: 'downstream-wait', expectedStatus: 'waiting', runsIntermediate: false },
    { action: 'auto', expectedNodeId: 'downstream-wait', expectedStatus: 'waiting', runsIntermediate: false },
    {
      action: 'auto',
      caseId: 'auto-without-wait',
      expectedNodeId: 'normal-next',
      expectedStatus: 'completed',
      runsIntermediate: true,
      hasDownstreamWait: false
    },
    { action: 'specific_node', expectedNodeId: 'late-target', expectedStatus: 'waiting', runsIntermediate: false },
    { action: 'exit', expectedNodeId: 'appointment-wait', expectedStatus: 'exited', runsIntermediate: false }
  ]

  for (const scenario of cases) {
    const suffix = randomUUID()
    const caseId = scenario.caseId || scenario.action
    const automationId = `automation_late_appointment_${caseId}_${suffix}`
    const contactId = `contact_late_appointment_${caseId}_${suffix}`
    const appointmentId = `appointment_late_${caseId}_${suffix}`
    const calendarId = `calendar_late_${caseId}_${suffix}`
    const appointmentStart = new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString()
    const flow = {
      nodes: [
        {
          id: 'start',
          type: 'start',
          config: {
            triggers: [{
              id: 'trigger-booked',
              type: 'trigger-appointment-booked',
              config: { calendar: calendarId }
            }]
          }
        },
        {
          id: 'appointment-wait',
          type: 'logic-wait',
          label: 'Esperar antes de la cita',
          config: {
            mode: 'appointment',
            appointmentOffset: 'before',
            offsetAmount: 3,
            offsetUnit: 'days',
            appointmentPastDueAction: scenario.action,
            appointmentPastDueTargetNodeId: scenario.action === 'specific_node' ? 'late-target' : ''
          }
        },
        {
          id: 'normal-next',
          type: 'logic-condition',
          label: 'Evento intermedio',
          config: { conditions: [] }
        },
        ...(scenario.hasDownstreamWait === false
          ? []
          : [{
              id: 'downstream-wait',
              type: 'logic-wait',
              label: 'Siguiente evento de espera',
              config: { mode: 'duration', amount: 1, unit: 'days' }
            }]),
        {
          id: 'late-target',
          type: 'logic-wait',
          label: 'Evento especial por llegada tarde',
          config: { mode: 'duration', amount: 1, unit: 'days' }
        }
      ],
      edges: [
        { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'appointment-wait' },
        {
          id: 'edge-wait-normal',
          sourceNodeId: 'appointment-wait',
          sourceHandle: 'out',
          targetNodeId: 'normal-next'
        },
        ...(scenario.hasDownstreamWait === false
          ? []
          : [{
              id: 'edge-normal-downstream-wait',
              sourceNodeId: 'normal-next',
              sourceHandle: 'no',
              targetNodeId: 'downstream-wait'
            }])
      ],
      settings: {}
    }

    try {
      await db.run(
        `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
         VALUES (?, ?, 'Contacto cita vencida', 'Contacto', '{}')`,
        [contactId, `+1570${Date.now().toString().slice(-8)}`]
      )
      await db.run(
        `INSERT INTO appointments
           (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
         VALUES (?, ?, ?, 'Cita cercana', 'booked', 'booked', ?, ?)`,
        [
          appointmentId,
          calendarId,
          contactId,
          appointmentStart,
          new Date(new Date(appointmentStart).getTime() + (60 * 60 * 1000)).toISOString()
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [
          automationId,
          `Cita vencida ${scenario.action}`,
          JSON.stringify(flow),
          JSON.stringify(flow)
        ]
      )

      await handleAutomationEvent('appointment-booked', {
        contactId,
        appointmentId,
        calendarId,
        status: 'booked',
        startTime: appointmentStart
      })

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, scenario.expectedStatus)
      assert.equal(enrollment.current_node_id, scenario.expectedNodeId)
      const log = JSON.parse(enrollment.log)
      assert.ok(log.some((entry) => entry.nodeId === 'appointment-wait' && entry.detail.includes('ya había pasado')))
      assert.equal(
        log.some((entry) => entry.nodeId === 'normal-next'),
        scenario.runsIntermediate
      )
      assert.equal(
        log.some((entry) => entry.nodeId === 'late-target'),
        scenario.action === 'specific_node'
      )
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  }
})

test('cancelar la cita ligada expulsa la ejecución aunque esté en una espera anterior', async () => {
  const suffix = randomUUID()
  const automationId = `automation_cancel_before_appointment_wait_${suffix}`
  const contactId = `contact_cancel_before_appointment_wait_${suffix}`
  const appointmentId = `appointment_cancel_before_wait_${suffix}`
  const otherAppointmentId = `appointment_unrelated_cancel_${suffix}`
  const startTime = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString()
  const endTime = new Date(new Date(startTime).getTime() + (60 * 60 * 1000)).toISOString()
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{ id: 'trigger-appointment', type: 'trigger-appointment-booked', config: {} }]
        }
      },
      {
        id: 'pre-wait',
        type: 'logic-wait',
        label: 'Espera previa',
        config: { mode: 'duration', amount: 4, unit: 'hours' }
      },
      {
        id: 'must-not-run',
        type: 'logic-condition',
        label: 'No debe ejecutarse',
        config: { conditions: [] }
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'pre-wait' },
      { id: 'edge-wait-end', sourceNodeId: 'pre-wait', sourceHandle: 'out', targetNodeId: 'must-not-run' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Cancelación', 'Contacto', '{}')`,
      [contactId, `+1555${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-cancel', ?, 'Cita a cancelar', 'confirmed', 'confirmed', ?, ?)`,
      [appointmentId, contactId, startTime, endTime]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Cancelación antes de espera de cita', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-cancel',
      status: 'confirmed',
      startTime,
      endTime
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.current_node_id, 'pre-wait')
    const initialResumeAt = enrollment.resume_at
    const initialContext = JSON.parse(enrollment.context)
    assert.equal(initialContext.appointmentLifecycleAppointmentId, appointmentId)

    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId: otherAppointmentId,
      status: 'cancelled',
      appointmentChange: 'cancelled',
      startTime
    })
    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.resume_at, initialResumeAt)

    await db.run(
      `UPDATE appointments
       SET status = 'cancelled', appointment_status = 'cancelled'
       WHERE id = ?`,
      [appointmentId]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      status: 'cancelled',
      appointmentChange: 'cancelled',
      startTime
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'exited')
    assert.equal(enrollment.resume_at, null)
    assert.equal(enrollment.wait_kind, null)
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some(entry => entry.nodeId === 'must-not-run'), false)
    assert.ok(log.some(entry => entry.detail.includes('salió automáticamente del flujo')))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('una automatización disparada por cancelación sí puede ejecutar sus propios pasos', async () => {
  const suffix = randomUUID()
  const automationId = `automation_started_by_cancellation_${suffix}`
  const contactId = `contact_started_by_cancellation_${suffix}`
  const appointmentId = `appointment_started_by_cancellation_${suffix}`
  const startTime = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString()
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [
            {
              id: 'trigger-cancelled',
              type: 'trigger-appointment-status',
              config: { status: 'cancelled' }
            }
          ]
        }
      },
      {
        id: 'short-wait',
        type: 'logic-wait',
        label: 'Espera del flujo de cancelación',
        config: { mode: 'duration', amount: -1, unit: 'seconds' }
      },
      {
        id: 'after-cancellation',
        type: 'logic-condition',
        label: 'Atender cancelación',
        config: { conditions: [] }
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'short-wait' },
      { id: 'edge-wait-action', sourceNodeId: 'short-wait', sourceHandle: 'out', targetNodeId: 'after-cancellation' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Flujo Cancelación', 'Contacto', '{}')`,
      [contactId, `+1558${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-cancel-trigger', ?, 'Cita ya cancelada', 'cancelled', 'cancelled', ?, ?)`,
      [
        appointmentId,
        contactId,
        startTime,
        new Date(new Date(startTime).getTime() + (60 * 60 * 1000)).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Flujo iniciado por cancelación', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId: 'calendar-cancel-trigger',
      status: 'cancelled',
      appointmentChange: 'cancelled',
      startTime
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(JSON.parse(enrollment.context).appointmentLifecycleTerminalAtEntry, true)

    await processDueResumes()
    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'after-cancellation')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('reprogramar durante una espera anterior conserva el progreso y usa la hora nueva', async () => {
  const suffix = randomUUID()
  const automationId = `automation_reschedule_before_appointment_wait_${suffix}`
  const contactId = `contact_reschedule_before_appointment_wait_${suffix}`
  const appointmentId = `appointment_reschedule_before_wait_${suffix}`
  const originalStart = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString()
  const rescheduledStart = new Date(Date.now() + (12 * 60 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [
            { id: 'trigger-appointment', type: 'trigger-appointment-booked', config: {} },
            {
              id: 'trigger-rescheduled',
              type: 'trigger-appointment-status',
              config: { status: 'rescheduled' }
            }
          ]
        }
      },
      {
        id: 'pre-wait',
        type: 'logic-wait',
        label: 'Espera previa',
        config: { mode: 'duration', amount: 1, unit: 'hours' }
      },
      {
        id: 'appointment-wait',
        type: 'logic-wait',
        label: 'Esperar cita',
        config: {
          mode: 'appointment',
          appointmentOffset: 'before',
          offsetAmount: 1,
          offsetUnit: 'hours'
        }
      }
    ],
    edges: [
      { id: 'edge-start-pre', sourceNodeId: 'start', targetNodeId: 'pre-wait' },
      { id: 'edge-pre-appointment', sourceNodeId: 'pre-wait', sourceHandle: 'out', targetNodeId: 'appointment-wait' }
    ],
    settings: { allowReentry: false }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Reprogramación', 'Contacto', '{}')`,
      [contactId, `+1556${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-reschedule', ?, 'Cita reprogramable', 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        contactId,
        originalStart,
        new Date(new Date(originalStart).getTime() + oneHour).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Reprogramación antes de espera de cita', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule',
      status: 'confirmed',
      startTime: originalStart
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    const preservedEnrollmentId = enrollment.id
    const preservedDurationResumeAt = enrollment.resume_at

    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        rescheduledStart,
        new Date(new Date(rescheduledStart).getTime() + oneHour).toISOString(),
        appointmentId
      ]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule',
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: rescheduledStart
    })

    enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE id = ?',
      [preservedEnrollmentId]
    )
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.current_node_id, 'pre-wait')
    assert.equal(enrollment.resume_at, preservedDurationResumeAt)
    let context = JSON.parse(enrollment.context)
    assert.equal(context.startTime, rescheduledStart)
    assert.equal(context.appointmentLifecycleAppointmentId, appointmentId)
    const preservedLog = JSON.parse(enrollment.log)
    assert.equal(preservedLog.filter(entry => entry.nodeId === 'start').length, 1)
    assert.ok(preservedLog.some(entry => entry.detail.includes('conservó su progreso')))
    const enrollmentCount = await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Number(enrollmentCount.total), 1)

    await db.run(
      `UPDATE automation_enrollments
       SET resume_at = ?
       WHERE id = ?`,
      [new Date(Date.now() - 1000).toISOString(), enrollment.id]
    )
    await processDueResumes()

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.current_node_id, 'appointment-wait')
    assert.equal(
      enrollment.resume_at,
      new Date(new Date(rescheduledStart).getTime() - oneHour).toISOString()
    )
    context = JSON.parse(enrollment.context)
    assert.equal(context.startTime, rescheduledStart)
    assert.equal(context.waitAppointmentId, appointmentId)
    const log = JSON.parse(enrollment.log)
    assert.equal(log.filter(entry => entry.nodeId === 'start').length, 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('reprogramar una cita recalcula la espera aunque la ejecución esté pausada', async () => {
  const suffix = randomUUID()
  const automationId = `automation_reschedule_paused_${suffix}`
  const contactId = `contact_reschedule_paused_${suffix}`
  const appointmentId = `appointment_reschedule_paused_${suffix}`
  const originalStart = new Date(Date.now() + (5 * 60 * 60 * 1000)).toISOString()
  const rescheduledStart = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{ id: 'trigger-booked', type: 'trigger-appointment-booked', config: {} }]
        }
      },
      {
        id: 'appointment-wait',
        type: 'logic-wait',
        label: 'Esperar cita pausada',
        config: {
          mode: 'appointment',
          appointmentOffset: 'before',
          offsetAmount: 1,
          offsetUnit: 'hours'
        }
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'appointment-wait' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Reprogramado Pausado', 'Contacto', '{}')`,
      [contactId, `+1560${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-reschedule-paused', ?, 'Cita pausada', 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        contactId,
        originalStart,
        new Date(new Date(originalStart).getTime() + oneHour).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Reprogramación de espera pausada', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule-paused',
      status: 'confirmed',
      startTime: originalStart
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    const enrollmentId = enrollment.id

    await controlAutomationEnrollment({
      automationId,
      enrollmentId,
      action: 'pause'
    })
    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        rescheduledStart,
        new Date(new Date(rescheduledStart).getTime() + oneHour).toISOString(),
        appointmentId
      ]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule-paused',
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: rescheduledStart
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollmentId])
    const expectedResumeAt = new Date(new Date(rescheduledStart).getTime() - oneHour).toISOString()
    assert.equal(enrollment.status, 'paused')
    assert.equal(enrollment.current_node_id, 'appointment-wait')
    assert.equal(enrollment.resume_at, expectedResumeAt)
    const pausedContext = JSON.parse(enrollment.context)
    assert.equal(pausedContext.startTime, rescheduledStart)
    assert.equal(pausedContext.__pausedResumeAt, expectedResumeAt)
    assert.equal(pausedContext.__pausedWaitKind, 'appointment')
    assert.ok(JSON.parse(enrollment.log).some(entry => (
      entry.detail.includes('conserva su pausa manual')
    )))

    await controlAutomationEnrollment({
      automationId,
      enrollmentId,
      action: 'resume'
    })
    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollmentId])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.resume_at, expectedResumeAt)
    const enrollmentCount = await db.get(
      'SELECT COUNT(*) AS total FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(Number(enrollmentCount.total), 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('una reprogramación tardía pausada salta a la siguiente espera al reanudar', async () => {
  const suffix = randomUUID()
  const automationId = `automation_reschedule_paused_late_${suffix}`
  const contactId = `contact_reschedule_paused_late_${suffix}`
  const appointmentId = `appointment_reschedule_paused_late_${suffix}`
  const originalStart = new Date(Date.now() + (5 * 60 * 60 * 1000)).toISOString()
  const lateStart = new Date(Date.now() + (30 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{ id: 'trigger-booked', type: 'trigger-appointment-booked', config: {} }]
        }
      },
      {
        id: 'appointment-wait',
        type: 'logic-wait',
        label: 'Esperar cita pausada',
        config: {
          mode: 'appointment',
          appointmentOffset: 'before',
          offsetAmount: 1,
          offsetUnit: 'hours',
          appointmentPastDueAction: 'next_wait'
        }
      },
      {
        id: 'normal-next',
        type: 'logic-wait',
        label: 'Ruta normal',
        config: { mode: 'duration', amount: 1, unit: 'days' }
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'appointment-wait' },
      {
        id: 'edge-wait-normal',
        sourceNodeId: 'appointment-wait',
        sourceHandle: 'out',
        targetNodeId: 'normal-next'
      }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Reprogramado Tarde', 'Contacto', '{}')`,
      [contactId, `+1561${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-reschedule-paused-late', ?, 'Cita pausada tardía', 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        contactId,
        originalStart,
        new Date(new Date(originalStart).getTime() + oneHour).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Reprogramación tardía pausada', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule-paused-late',
      status: 'confirmed',
      startTime: originalStart
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )

    await controlAutomationEnrollment({
      automationId,
      enrollmentId: enrollment.id,
      action: 'pause'
    })
    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        lateStart,
        new Date(new Date(lateStart).getTime() + oneHour).toISOString(),
        appointmentId
      ]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule-paused-late',
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: lateStart
    })

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'paused')
    assert.equal(enrollment.current_node_id, 'appointment-wait')
    const pausedContext = JSON.parse(enrollment.context)
    assert.equal(pausedContext.__pendingWaitCompletion.nextWaitMode, 'required')

    await controlAutomationEnrollment({
      automationId,
      enrollmentId: enrollment.id,
      action: 'resume'
    })
    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.current_node_id, 'normal-next')
    const log = JSON.parse(enrollment.log)
    assert.ok(log.some((entry) => entry.nodeId === 'normal-next'))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('reprogramar una cita crea una vuelta nueva sólo cuando la anterior ya terminó', async () => {
  const suffix = randomUUID()
  const automationId = `automation_reschedule_after_completion_${suffix}`
  const contactId = `contact_reschedule_after_completion_${suffix}`
  const appointmentId = `appointment_reschedule_after_completion_${suffix}`
  const originalStart = new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString()
  const rescheduledStart = new Date(Date.now() + (12 * 60 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{ id: 'trigger-booked', type: 'trigger-appointment-booked', config: {} }]
        }
      },
      {
        id: 'finish',
        type: 'logic-condition',
        label: 'Finalizar vuelta',
        config: { conditions: [] }
      }
    ],
    edges: [
      { id: 'edge-start-finish', sourceNodeId: 'start', targetNodeId: 'finish' }
    ],
    settings: { allowReentry: false }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Reprogramado Terminado', 'Contacto', '{}')`,
      [contactId, `+1559${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-reschedule-completed', ?, 'Cita con vuelta terminada', 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        contactId,
        originalStart,
        new Date(new Date(originalStart).getTime() + oneHour).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Reprogramación después de terminar', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule-completed',
      status: 'confirmed',
      startTime: originalStart
    })

    let enrollments = await db.all(
      `SELECT * FROM automation_enrollments
       WHERE automation_id = ? AND contact_id = ?
       ORDER BY entered_at ASC, id ASC`,
      [automationId, contactId]
    )
    assert.equal(enrollments.length, 1)
    assert.equal(enrollments[0].status, 'completed')
    const originalEnrollmentId = enrollments[0].id

    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        rescheduledStart,
        new Date(new Date(rescheduledStart).getTime() + oneHour).toISOString(),
        appointmentId
      ]
    )
    await handleAutomationEvent('appointment-status', {
      contactId,
      appointmentId,
      calendarId: 'calendar-reschedule-completed',
      status: 'confirmed',
      appointmentChange: 'rescheduled',
      startTime: rescheduledStart
    })

    enrollments = await db.all(
      `SELECT * FROM automation_enrollments
       WHERE automation_id = ? AND contact_id = ?
       ORDER BY entered_at ASC, id ASC`,
      [automationId, contactId]
    )
    assert.equal(enrollments.length, 2)
    assert.equal(enrollments.filter(row => row.id === originalEnrollmentId).length, 1)
    const newEnrollment = enrollments.find(row => row.id !== originalEnrollmentId)
    assert.equal(newEnrollment.status, 'completed')
    const context = JSON.parse(newEnrollment.context)
    assert.equal(context.startTime, rescheduledStart)
    assert.equal(context.appointmentLifecycleAppointmentId, appointmentId)
    const log = JSON.parse(newEnrollment.log)
    assert.equal(log.filter(entry => entry.nodeId === 'start').length, 1)
    assert.ok(log.some(entry => entry.detail.includes('reprogramó una cita')))
    assert.equal(log.some(entry => entry.detail.includes('reinició')), false)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('una espera vencida relee la cita canónica antes de continuar', async () => {
  const suffix = randomUUID()
  const automationId = `automation_due_appointment_recheck_${suffix}`
  const contactId = `contact_due_appointment_recheck_${suffix}`
  const appointmentId = `appointment_due_recheck_${suffix}`
  const initialStart = new Date(Date.now() + (2 * 60 * 60 * 1000)).toISOString()
  const movedStart = new Date(Date.now() + (5 * 60 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{ id: 'trigger-appointment', type: 'trigger-appointment-booked', config: {} }]
        }
      },
      {
        id: 'appointment-wait',
        type: 'logic-wait',
        label: 'Esperar cita',
        config: {
          mode: 'appointment',
          appointmentOffset: 'before',
          offsetAmount: 1,
          offsetUnit: 'hours'
        }
      },
      { id: 'normal-path', type: 'logic-condition', label: 'Ruta normal', config: { conditions: [] } }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'appointment-wait' },
      { id: 'edge-wait-normal', sourceNodeId: 'appointment-wait', sourceHandle: 'out', targetNodeId: 'normal-path' }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Revalidación', 'Contacto', '{}')`,
      [contactId, `+1557${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-recheck', ?, 'Cita canónica', 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        contactId,
        initialStart,
        new Date(new Date(initialStart).getTime() + oneHour).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Revalidación canónica de cita', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-recheck',
      status: 'confirmed',
      startTime: initialStart
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )

    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        movedStart,
        new Date(new Date(movedStart).getTime() + oneHour).toISOString(),
        appointmentId
      ]
    )
    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), enrollment.id]
    )
    await processDueResumes()

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(
      enrollment.resume_at,
      new Date(new Date(movedStart).getTime() - oneHour).toISOString()
    )
    let context = JSON.parse(enrollment.context)
    assert.equal(context.startTime, movedStart)

    await db.run(
      `UPDATE appointments
       SET status = 'cancelled', appointment_status = 'cancelled'
       WHERE id = ?`,
      [appointmentId]
    )
    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), enrollment.id]
    )
    await processDueResumes()

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'exited')
    assert.equal(enrollment.current_node_id, 'appointment-wait')
    context = JSON.parse(enrollment.context)
    assert.equal(context.appointmentStatus, 'cancelled')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some(entry => entry.nodeId === 'normal-path'), false)
    assert.ok(log.some(entry => entry.detail.includes('salió automáticamente antes de continuar')))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('el scheduler aplica la ruta tardía si descubre una reprogramación perdida', async () => {
  const suffix = randomUUID()
  const automationId = `automation_due_appointment_late_${suffix}`
  const contactId = `contact_due_appointment_late_${suffix}`
  const appointmentId = `appointment_due_late_${suffix}`
  const initialStart = new Date(Date.now() + (5 * 60 * 60 * 1000)).toISOString()
  const lateStart = new Date(Date.now() + (30 * 60 * 1000)).toISOString()
  const oneHour = 60 * 60 * 1000
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{ id: 'trigger-appointment', type: 'trigger-appointment-booked', config: {} }]
        }
      },
      {
        id: 'appointment-wait',
        type: 'logic-wait',
        label: 'Esperar cita',
        config: {
          mode: 'appointment',
          appointmentOffset: 'before',
          offsetAmount: 1,
          offsetUnit: 'hours',
          appointmentPastDueAction: 'specific_node',
          appointmentPastDueTargetNodeId: 'late-target'
        }
      },
      {
        id: 'normal-path',
        type: 'logic-wait',
        label: 'Ruta normal',
        config: { mode: 'duration', amount: 1, unit: 'days' }
      },
      {
        id: 'late-target',
        type: 'logic-wait',
        label: 'Ruta tardía',
        config: { mode: 'duration', amount: 1, unit: 'days' }
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'appointment-wait' },
      {
        id: 'edge-wait-normal',
        sourceNodeId: 'appointment-wait',
        sourceHandle: 'out',
        targetNodeId: 'normal-path'
      }
    ],
    settings: {}
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, full_name, first_name, custom_fields)
       VALUES (?, ?, 'Contacto Scheduler Tardío', 'Contacto', '{}')`,
      [contactId, `+1558${Date.now().toString().slice(-8)}`]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, 'calendar-recheck-late', ?, 'Cita reprogramada sin evento', 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        contactId,
        initialStart,
        new Date(new Date(initialStart).getTime() + oneHour).toISOString()
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, 'Revalidación tardía de cita', 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId: 'calendar-recheck-late',
      status: 'confirmed',
      startTime: initialStart
    })
    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )

    await db.run(
      `UPDATE appointments
       SET start_time = ?, end_time = ?
       WHERE id = ?`,
      [
        lateStart,
        new Date(new Date(lateStart).getTime() + oneHour).toISOString(),
        appointmentId
      ]
    )
    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), enrollment.id]
    )
    await processDueResumes()

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.current_node_id, 'late-target')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => entry.nodeId === 'normal-path'), false)
    assert.ok(log.some((entry) => entry.nodeId === 'late-target'))
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('el contexto de pago sobrevive una espera y alimenta acciones posteriores', async () => {
  const suffix = randomUUID()
  const automationId = `automation_payment_context_resume_${suffix}`
  const contactId = `contact_payment_context_resume_${suffix}`
  const paymentId = `payment_context_resume_${suffix}`
  const username = `payment-context-${suffix}@example.com`
  let userId = ''
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-payment-received',
              type: 'trigger-payment-received',
              config: { paymentAction: 'successful' }
            }
          ]
        }
      },
      {
        id: 'wait-payment-context',
        type: 'logic-wait',
        label: 'Esperar',
        config: {
          mode: 'duration',
          amount: -1,
          unit: 'seconds'
        }
      },
      {
        id: 'notify-payment-context',
        type: 'action-system-notification',
        label: 'Notificaciones',
        config: {
          recipientMode: 'specific_user',
          user: '',
          deliverToBell: true,
          deliverToPush: false,
          deliverToEmail: false,
          pushTitle: 'Pago {{payment.id}}',
          pushBody: '{{payment.amount}} {{payment.currency}}',
          clickAction: 'desktop_contacts'
        }
      }
    ],
    edges: [
      {
        id: 'edge-start-wait',
        sourceNodeId: 'start',
        targetNodeId: 'wait-payment-context',
        sourceHandle: 'out',
        targetHandle: 'in'
      },
      {
        id: 'edge-wait-notify',
        sourceNodeId: 'wait-payment-context',
        targetNodeId: 'notify-payment-context',
        sourceHandle: 'out',
        targetHandle: 'in'
      }
    ],
    settings: {}
  }

  try {
    const userResult = await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, 'admin', 1)`,
      [username, username, 'test-hash', 'Usuario Contexto Pago']
    )
    userId = String(userResult.lastID || '')
    if (!userId) {
      const user = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = String(user.id)
    }
    flow.nodes[2].config.user = userId

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `payment-context-${suffix}@example.com`,
        'Contacto Pago Contextual',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contexto de pago', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentId,
      amount: 725.5,
      currency: 'EUR',
      paymentStatus: 'paid',
      product: 'Servicio contextual'
    })

    let enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.equal(enrollment.status, 'waiting')
    const storedContext = JSON.parse(enrollment.context)
    assert.equal(storedContext.payment.id, paymentId)
    assert.equal(storedContext.payment.amount, '725.5')
    assert.equal(storedContext.payment.currency, 'EUR')

    await processDueResumes()

    enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(enrollment.status, 'completed')
    const notification = await db.get(
      `SELECT * FROM internal_notifications
       WHERE automation_id = ? AND automation_node_id = ?
       ORDER BY id ASC
       LIMIT 1`,
      [automationId, 'notify-payment-context']
    )
    assert.ok(notification)
    assert.equal(notification.title, `Pago ${paymentId}`)
    assert.equal(notification.message, '725.5 EUR')
    assert.equal(
      notification.action_url,
      `/contacts?open=contact&id=${encodeURIComponent(contactId)}`
    )
  } finally {
    await db.run('DELETE FROM internal_notifications WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId])
  }
})

test('notificación interna puede quedarse solo en campanita sin enviar push', async () => {
  const suffix = randomUUID()
  const automationId = `automation_bell_only_notification_${suffix}`
  const contactId = `contact_bell_only_notification_${suffix}`
  const username = `bell-only-${suffix}@example.com`
  let userId = ''
  const sentPushes = []

  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-created',
              type: 'trigger-contact-created',
              config: {}
            }
          ]
        }
      },
      {
        id: 'notify-owner',
        type: 'action-system-notification',
        label: 'Notificaciones',
        config: {
          recipientMode: 'assigned_user',
          deliverToBell: true,
          deliverToPush: false,
          deliverToEmail: false,
          pushTitle: 'Solo campanita',
          pushBody: 'Este aviso no debe salir como push',
          clickAction: 'phone_chat'
        }
      }
    ],
    edges: [
      { id: 'edge-start-notify', sourceNodeId: 'start', targetNodeId: 'notify-owner' }
    ],
    settings: {}
  }

  setAppNotificationPayloadSenderForTest(async (payload, options) => {
    sentPushes.push({ payload, options })
    return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
  })

  try {
    const result = await db.run(
      `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, ?, 'admin', 1)`,
      [username, username, 'test-hash', 'Dueño Campanita']
    )
    userId = String(result.lastID || '')
    if (!userId) {
      const user = await db.get('SELECT id FROM users WHERE username = ?', [username])
      userId = String(user.id)
    }

    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+1555${Date.now().toString().slice(-8)}`,
        `bell-only-${suffix}@example.com`,
        'Lead Campanita',
        'Lead',
        JSON.stringify({ assignedUser: userId, assignedUserName: 'Dueño Campanita' })
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test notificación solo campanita', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const notification = await db.get(
      'SELECT * FROM internal_notifications WHERE automation_id = ? AND automation_node_id = ?',
      [automationId, 'notify-owner']
    )
    assert.equal(notification.recipient_user_id, userId)
    assert.equal(notification.title, 'Solo campanita')
    assert.equal(sentPushes.length, 0)

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollment.status, 'completed')
  } finally {
    setAppNotificationPayloadSenderForTest(null)
    await db.run('DELETE FROM internal_notifications WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
    if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
  }
})

test('notificación interna puede enviarse por correo interno sin campanita ni push', async () => {
  const suffix = randomUUID()
  const automationId = `automation_email_only_notification_${suffix}`
  const contactId = `contact_email_only_notification_${suffix}`
  const username = `email-only-${suffix}@example.com`
  let userId = ''
  const sentMessages = []
  const sentPushes = []

  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-created',
              type: 'trigger-contact-created',
              config: {}
            }
          ]
        }
      },
      {
        id: 'notify-user',
        type: 'action-system-notification',
        label: 'Notificaciones',
        config: {
          recipientMode: 'specific_user',
          user: '',
          deliverToBell: false,
          deliverToPush: false,
          deliverToEmail: true,
          pushTitle: 'Correo interno para {{contact.first_name}}',
          pushBody: 'Revisa a {{contact.full_name}} desde Ristak',
          clickAction: 'desktop_contacts'
        }
      }
    ],
    edges: [
      { id: 'edge-start-notify', sourceNodeId: 'start', targetNodeId: 'notify-user' }
    ],
    settings: {}
  }

  await withAppConfigValues({
    [EMAIL_CONFIG_KEY]: null,
    [EMAIL_PASSWORD_KEY]: null,
    [EMAIL_SIGNATURE_CONFIG_KEY]: null
  }, async () => {
    setEmailMxResolverForTest(async () => [
      { exchange: 'aspmx.l.google.com.', priority: 1 }
    ])
    setEmailTransportFactoryForTest(() => ({
      verify: async () => true,
      sendMail: async (message) => {
        sentMessages.push(message)
        return {
          messageId: `internal-notification-${sentMessages.length}`,
          accepted: [message.to],
          rejected: []
        }
      }
    }))
    setAppNotificationPayloadSenderForTest(async (payload, options) => {
      sentPushes.push({ payload, options })
      return { sent: 1, webSent: 1, nativeSent: 0, skipped: false }
    })

    try {
      await connectEmail({
        fromEmail: 'avisos@clinicademo.com',
        fromName: 'Clínica Demo',
        password: 'app-password-demo',
        inbound: { enabled: false }
      })

      const result = await db.run(
        `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
         VALUES (?, ?, ?, ?, 'admin', 1)`,
        [username, username, 'test-hash', 'Dueño Correo']
      )
      userId = String(result.lastID || '')
      if (!userId) {
        const user = await db.get('SELECT id FROM users WHERE username = ?', [username])
        userId = String(user.id)
      }
      flow.nodes[1].config.user = userId

      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `+1555${Date.now().toString().slice(-8)}`,
          `email-only-contact-${suffix}@example.com`,
          'Lead Correo',
          'Lead',
          '{}'
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test notificación solo correo', JSON.stringify(flow), JSON.stringify(flow)]
      )

      await handleAutomationEvent('contact-created', { contactId })

      const notification = await db.get(
        'SELECT * FROM internal_notifications WHERE automation_id = ? AND automation_node_id = ?',
        [automationId, 'notify-user']
      )
      assert.equal(notification, null)
      assert.equal(sentPushes.length, 0)
      assert.equal(sentMessages.length, 2)
      assert.equal(sentMessages[1].to, username)
      assert.equal(sentMessages[1].subject, 'Correo interno para Lead')
      assert.match(sentMessages[1].text, /Revisa a Lead Correo desde Ristak/)
      assert.match(sentMessages[1].text, /Abrir contacto: .*\/contacts\?open=contact&id=/)

      const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
      assert.equal(enrollment.status, 'completed')
    } finally {
      setAppNotificationPayloadSenderForTest(null)
      setEmailTransportFactoryForTest(null)
      setEmailMxResolverForTest(null)
      await db.run('DELETE FROM internal_notifications WHERE automation_id = ?', [automationId]).catch(() => {})
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId]).catch(() => {})
      await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
      if (userId) await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {})
    }
  })
})

test('trigger fecha programada recupera un deploy tardío y se inscribe una sola vez', async () => {
  const suffix = randomUUID()
  const automationId = `automation_schedule_trigger_${suffix}`
  const now = DateTime.now().setZone('America/Mexico_City').startOf('minute')
  const scheduledAt = now.toFormat("yyyy-LL-dd'T'HH:mm")
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: `trigger-schedule-${suffix}`,
              type: 'trigger-scheduler',
              config: {
                scheduleMode: 'once',
                datetime: scheduledAt,
                recurrence: 'none',
                weekdays: []
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { timezone: 'America/Mexico_City' }
  }

  try {
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test fecha programada', JSON.stringify(flow), JSON.stringify(flow)]
    )

    // Simula un deploy/reinicio que terminó cinco minutos después de la hora.
    await processScheduledTriggers(now.plus({ minutes: 5 }).toUTC().toJSDate())
    await processScheduledTriggers(now.plus({ minutes: 6 }).toUTC().toJSDate())

    const enrollments = await db.all('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    assert.equal(enrollments.length, 1)
    assert.equal(enrollments[0].status, 'completed')
    assert.equal(enrollments[0].current_node_id, 'done')

    const runs = await db.all('SELECT * FROM automation_schedule_runs WHERE automation_id = ?', [automationId])
    assert.equal(runs.length, 1)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_schedule_runs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
  }
})

test('trigger fecha programada no revive campañas que llevan más de un día vencidas', async () => {
  const suffix = randomUUID()
  const automationId = `automation_schedule_expired_${suffix}`
  const now = DateTime.now().setZone('America/Mexico_City').startOf('minute')
  const scheduledAt = now.minus({ hours: 24, minutes: 1 }).toFormat("yyyy-LL-dd'T'HH:mm")
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [{
            id: `trigger-schedule-expired-${suffix}`,
            type: 'trigger-scheduler',
            config: { scheduleMode: 'once', datetime: scheduledAt, recurrence: 'none', weekdays: [] }
          }]
        }
      },
      { id: 'done', type: 'action-update-contact', config: {} }
    ],
    edges: [{ source: 'start', target: 'done' }]
  }

  try {
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test fecha programada expirada', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await processScheduledTriggers(now.toUTC().toJSDate())

    const enrollments = await db.all('SELECT * FROM automation_enrollments WHERE automation_id = ?', [automationId])
    const runs = await db.all('SELECT * FROM automation_schedule_runs WHERE automation_id = ?', [automationId])
    assert.equal(enrollments.length, 0)
    assert.equal(runs.length, 0)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_schedule_runs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
  }
})

test('acción cambia el número de WhatsApp preferido del contacto', async () => {
  const suffix = randomUUID()
  const automationId = `automation_whatsapp_number_action_${suffix}`
  const contactId = `contact_whatsapp_number_action_${suffix}`
  const oldPhoneId = `wa_old_${suffix}`
  const newPhoneId = `wa_new_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
          ]
        }
      },
      {
        id: 'change-number',
        type: 'action-change-whatsapp-number',
        label: 'Cambiar número de WhatsApp',
        config: {
          phoneNumberId: newPhoneId,
          phoneNumberIdName: 'Soporte',
          reason: 'Asignado desde {{automation.name}}'
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-change', sourceNodeId: 'start', targetNodeId: 'change-number' },
      { id: 'edge-change-done', sourceNodeId: 'change-number', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, preferred_whatsapp_phone_number_id, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `wa-action-${suffix}@test.com`, 'Contacto WhatsApp', 'Contacto', oldPhoneId, '{}']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (id, phone_number, display_phone_number, verified_name, label)
       VALUES (?, ?, ?, ?, ?)`,
      [oldPhoneId, '525511111111', '+52 55 1111 1111', 'Ventas Meta', 'Ventas']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (id, phone_number, display_phone_number, verified_name, label)
       VALUES (?, ?, ?, ?, ?)`,
      [newPhoneId, '525522222222', '+52 55 2222 2222', 'Soporte Meta', 'Soporte']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test cambio número WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    const updated = await db.get('SELECT preferred_whatsapp_phone_number_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(updated.preferred_whatsapp_phone_number_id, newPhoneId)
    const routingEvent = await db.get('SELECT * FROM whatsapp_routing_events WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1', [contactId])
    assert.equal(routingEvent.previous_phone_number_id, oldPhoneId)
    assert.equal(routingEvent.new_phone_number_id, newPhoneId)
    assert.equal(routingEvent.reason, 'Asignado desde Test cambio número WhatsApp')
    assert.equal(routingEvent.source, 'automation')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Número de WhatsApp cambiado a Soporte')), true)
  } finally {
    await db.run('DELETE FROM whatsapp_routing_events WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id IN (?, ?)', [oldPhoneId, newPhoneId])
  }
})

test('acción define WhatsApp y un número conectado como respuesta predeterminada', async () => {
  const suffix = randomUUID()
  const automationId = `automation_default_reply_whatsapp_${suffix}`
  const contactId = `contact_default_reply_whatsapp_${suffix}`
  const phoneId = `wa_default_reply_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [
            { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
          ]
        }
      },
      {
        id: 'default-reply',
        type: 'action-set-default-reply-channel',
        label: 'Cambiar canal de respuesta predeterminado',
        config: {
          channel: 'whatsapp',
          whatsappPhoneNumberId: phoneId,
          whatsappPhoneNumberIdName: 'Soporte',
          reason: 'Ruta elegida por {{automation.name}}'
        }
      }
    ],
    edges: [
      { id: 'edge-start-reply', sourceNodeId: 'start', targetNodeId: 'default-reply' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, preferred_whatsapp_phone_number_id, custom_fields)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      [contactId, `+524${Date.now().toString().slice(-10)}`, `reply-wa-${suffix}@test.com`, 'Contacto WhatsApp', '{}']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (
        id, phone_number, display_phone_number, verified_name, label, api_send_enabled
      ) VALUES (?, ?, ?, ?, ?, 1)`,
      [phoneId, '525533333333', '+52 55 3333 3333', 'Soporte Meta', 'Soporte']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test canal predeterminado', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const contact = await db.get('SELECT preferred_whatsapp_phone_number_id FROM contacts WHERE id = ?', [contactId])
    const preference = await db.get('SELECT * FROM contact_reply_channel_preferences WHERE contact_id = ?', [contactId])
    const routingEvent = await db.get('SELECT * FROM whatsapp_routing_events WHERE contact_id = ? ORDER BY created_at DESC LIMIT 1', [contactId])
    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])

    assert.equal(enrollment.status, 'completed')
    assert.equal(contact.preferred_whatsapp_phone_number_id, phoneId)
    assert.equal(preference.channel, 'whatsapp')
    assert.equal(preference.route_id, phoneId)
    assert.equal(preference.selection_source, 'automation')
    assert.equal(routingEvent.new_phone_number_id, phoneId)
    assert.equal(routingEvent.reason, 'Ruta elegida por Test canal predeterminado')
    assert.equal(
      JSON.parse(enrollment.log).some((entry) => String(entry.detail || '').includes('Canal de respuesta cambiado a Soporte')),
      true
    )
  } finally {
    await db.run('DELETE FROM whatsapp_routing_events WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contact_reply_channel_preferences WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
  }
})

test('acción define Instagram como respuesta sólo cuando el contacto tiene conversación enlazada', async () => {
  const suffix = randomUUID()
  const automationId = `automation_default_reply_instagram_${suffix}`
  const contactId = `contact_default_reply_instagram_${suffix}`
  const socialProfileId = `meta_social_default_reply_${suffix}`
  const instagramAccountId = `ig_business_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        config: {
          triggers: [
            { id: 'trigger-contact-created', type: 'trigger-contact-created', config: { source: '' } }
          ]
        }
      },
      {
        id: 'default-reply',
        type: 'action-set-default-reply-channel',
        label: 'Cambiar canal de respuesta predeterminado',
        config: { channel: 'instagram' }
      }
    ],
    edges: [
      { id: 'edge-start-reply', sourceNodeId: 'start', targetNodeId: 'default-reply' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, custom_fields)
       VALUES (?, ?, ?, ?, ?)`,
      [contactId, `+525${Date.now().toString().slice(-10)}`, `reply-ig-${suffix}@test.com`, 'Contacto Instagram', '{}']
    )
    await db.run(
      `INSERT INTO meta_social_contacts (
        id, contact_id, platform, sender_id, recipient_id, page_id, instagram_account_id
      ) VALUES (?, ?, 'instagram', ?, ?, ?, ?)`,
      [socialProfileId, contactId, `igsid_${suffix}`, instagramAccountId, `page_${suffix}`, instagramAccountId]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test canal Instagram', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-created', { contactId })

    const preference = await db.get('SELECT * FROM contact_reply_channel_preferences WHERE contact_id = ?', [contactId])
    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.equal(enrollment.status, 'completed')
    assert.equal(preference.channel, 'instagram')
    assert.equal(preference.route_id, instagramAccountId)
    assert.equal(
      JSON.parse(enrollment.log).some((entry) => String(entry.detail || '').includes('Canal de respuesta cambiado a Instagram Direct')),
      true
    )
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contact_reply_channel_preferences WHERE contact_id = ?', [contactId])
    await db.run('DELETE FROM meta_social_contacts WHERE id = ?', [socialProfileId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger contacto modificado filtra número de WhatsApp asignado', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_whatsapp_${suffix}`
  const contactId = `contact_change_whatsapp_${suffix}`
  const phoneId = `wa_contact_change_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'preferredWhatsAppPhoneNumberId',
                    valueLabel: 'Número de WhatsApp asignado'
                  },
                  {
                    field: 'preferred_whatsapp_number',
                    match: 'is',
                    value: phoneId,
                    valueLabel: 'Soporte'
                  }
                ]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, preferred_whatsapp_phone_number_id, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `wa-change-${suffix}@test.com`, 'Contacto Cambio WhatsApp', 'Contacto', phoneId, '{}']
    )
    await db.run(
      `INSERT INTO whatsapp_api_phone_numbers (id, phone_number, display_phone_number, verified_name, label)
       VALUES (?, ?, ?, ?, ?)`,
      [phoneId, '525533333333', '+52 55 3333 3333', 'Soporte Meta', 'Soporte']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('contact-updated', {
      contactId,
      changedFields: ['preferredWhatsAppPhoneNumberId']
    })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => {
      const detail = String(entry.detail || '')
      return detail.includes('cambió') && detail.includes('preferredWhatsAppPhoneNumberId')
    }), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
  }
})

test('trigger contacto modificado filtra etapa de cliente y totales de pago', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_payment_${suffix}`
  const contactId = `contact_change_payment_${suffix}`
  const paymentId = `payment_contact_change_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'stage',
                    valueLabel: 'Pipeline / etapa'
                  },
                  {
                    field: 'stage',
                    match: 'is',
                    value: 'customer',
                    valueLabel: 'Cliente'
                  },
                  {
                    field: 'total_paid',
                    match: 'gte',
                    value: '100'
                  },
                  {
                    field: 'payments_count',
                    match: 'gte',
                    value: '1'
                  }
                ]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `payment-change-${suffix}@test.com`, 'Contacto Cambio Pago', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, payment_mode, reference, title, date)
       VALUES (?, ?, ?, 'MXN', 'paid', 'card', 'live', ?, ?, ?)`,
      [paymentId, contactId, 150, `INV-${suffix}`, 'Compra prueba', '2026-06-16T12:00:00.000Z']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado pagos', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentId,
      amount: 150,
      paymentStatus: 'paid',
      product: 'Compra prueba'
    })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('pago exitoso')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger contacto modificado filtra cita activa y cantidad de citas', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_appointment_${suffix}`
  const contactId = `contact_change_appointment_${suffix}`
  const appointmentId = `appointment_contact_change_${suffix}`
  const calendarId = `calendar_contact_change_${suffix}`
  const assignedUserId = `user_contact_change_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'activeAppointment',
                    valueLabel: 'Cita activa'
                  },
                  {
                    field: 'has_active_appointment',
                    match: 'yes',
                    value: ''
                  },
                  {
                    field: 'stage',
                    match: 'is',
                    value: 'appointment',
                    valueLabel: 'Agendó cita'
                  },
                  {
                    field: 'appointments_count',
                    match: 'gte',
                    value: '1'
                  },
                  {
                    field: 'active_appointment_status',
                    match: 'is',
                    value: 'confirmed'
                  },
                  {
                    field: 'active_appointment_calendar',
                    match: 'is',
                    value: calendarId
                  },
                  {
                    field: 'active_appointment_assigned',
                    match: 'is',
                    value: assignedUserId
                  }
                ]
              }
            }
          ]
        }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+523${Date.now().toString().slice(-10)}`, `appointment-change-${suffix}@test.com`, 'Contacto Cambio Cita', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO appointments (id, calendar_id, contact_id, title, status, appointment_status, assigned_user_id, start_time, end_time)
       VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?, ?)`,
      [
        appointmentId,
        calendarId,
        contactId,
        'Cita prueba',
        assignedUserId,
        '2026-06-18T16:00:00.000Z',
        '2026-06-18T17:00:00.000Z'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado citas', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed'
    })

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?', [automationId, contactId])
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('agendó una cita')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('trigger contacto modificado reacciona a una etiqueta y al nombre final del contacto', async () => {
  const suffix = randomUUID()
  const automationId = `automation_contact_change_tag_${suffix}`
  const contactId = `contact_change_tag_${suffix}`
  const tagId = `tag_vip_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: {
          triggers: [
            {
              id: 'trigger-contact-updated',
              type: 'trigger-contact-updated',
              config: {
                filters: [
                  {
                    field: 'changed_detail',
                    match: 'is',
                    value: 'tags',
                    valueLabel: 'Etiquetas'
                  },
                  {
                    field: 'tag',
                    match: 'is',
                    value: tagId,
                    valueLabel: 'VIP'
                  },
                  {
                    field: 'first_name',
                    match: 'is',
                    value: 'Ana'
                  }
                ]
              }
            }
          ]
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      'INSERT INTO contact_tags (id, name) VALUES (?, ?)',
      [tagId, 'VIP']
    )
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, tags, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+523${Date.now().toString().slice(-10)}`,
        `tag-change-${suffix}@test.com`,
        'Ana Prueba',
        'Ana',
        JSON.stringify([tagId]),
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test contacto modificado etiqueta', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await handleAutomationEvent('tag-changed', {
      contactId,
      tagId,
      tag: 'VIP',
      tagAction: 'added'
    })

    const enrollment = await db.get(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    assert.ok(enrollment)
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.current_node_id, 'done')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId])
  }
})

test('inscripción manual mete un contacto publicado al flujo seleccionado', async () => {
  const suffix = randomUUID()
  const automationId = `automation_manual_${suffix}`
  const contactId = `contact_manual_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+521${Date.now().toString().slice(-10)}`, `manual-${suffix}@test.com`, 'Contacto Manual', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test manual', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const result = await enrollContactManually({ automationId, contactId })

    assert.equal(result.automationId, automationId)
    assert.equal(result.contactId, contactId)
    assert.equal(result.status, 'completed')
    assert.equal(result.currentNodeId, 'done')

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [result.id])
    const log = JSON.parse(enrollment.log)
    assert.equal(log.some((entry) => String(entry.detail || '').includes('Agregado manualmente')), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_contact_enrollment_jobs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('inscripción manual programada se ejecuta cuando llega su fecha', async () => {
  const suffix = randomUUID()
  const automationId = `automation_manual_scheduled_${suffix}`
  const contactId = `contact_manual_scheduled_${suffix}`
  const jobId = `autojob_${suffix}`
  const scheduledAt = new Date(Date.now() - 1000).toISOString()
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'done',
        type: 'extra-comment',
        label: 'Listo',
        config: {}
      }
    ],
    edges: [
      { id: 'edge-start-done', sourceNodeId: 'start', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [contactId, `+522${Date.now().toString().slice(-10)}`, `manual-scheduled-${suffix}@test.com`, 'Contacto Programado', 'Contacto', '{}']
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test manual programada', JSON.stringify(flow), JSON.stringify(flow)]
    )
    await db.run(
      `INSERT INTO automation_contact_enrollment_jobs
         (id, automation_id, contact_id, contact_name, scheduled_at, status)
       VALUES (?, ?, ?, ?, ?, 'scheduled')`,
      [jobId, automationId, contactId, 'Contacto Programado', scheduledAt]
    )

    await processScheduledContactEnrollments(new Date())

    const job = await db.get('SELECT * FROM automation_contact_enrollment_jobs WHERE id = ?', [jobId])
    assert.equal(job.status, 'completed')
    assert.ok(job.enrollment_id)
    const jobLog = JSON.parse(job.log || '[]')
    assert.equal(jobLog.some((entry) => entry.outcome === 'success' && /Inscripción creada correctamente/.test(entry.detail || '')), true)

    const enrollment = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [job.enrollment_id])
    assert.equal(enrollment.status, 'completed')
    assert.equal(enrollment.contact_id, contactId)
    assert.equal(enrollment.execution_outcome, 'success')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automation_contact_enrollment_jobs WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('cada reingreso crea una ejecución nueva y exige un clic posterior', async () => {
  const suffix = randomUUID()
  const automationId = `automation_reentry_click_${suffix}`
  const contactId = `contact_reentry_click_${suffix}`
  const triggerLinkId = `trigger_link_reentry_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'wait-click',
        type: 'logic-wait',
        label: 'Esperar clic',
        config: {
          mode: 'action',
          expectedAction: 'click_link',
          actionResource: triggerLinkId,
          actionResourceName: 'Confirmación'
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-click' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-click', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+521${Date.now().toString().slice(-10)}`,
        `reentry-click-${suffix}@test.com`,
        'Contacto Reingreso',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test reingreso clic', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await enrollContactManually({ automationId, contactId })
    let rows = await db.all(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY entered_at, id',
      [automationId, contactId]
    )
    assert.equal(rows.length, 1)
    assert.equal(rows[0].status, 'waiting')
    const firstEnrollmentId = rows[0].id

    await handleAutomationEvent('trigger-link-clicked', {
      contactId,
      triggerLinkId,
      triggerLinkName: 'Confirmación',
      eventId: `click_first_${suffix}`
    })
    rows = await db.all(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY entered_at, id',
      [automationId, contactId]
    )
    assert.equal(rows.find((row) => row.id === firstEnrollmentId)?.status, 'completed')

    await enrollContactManually({ automationId, contactId })
    rows = await db.all(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY entered_at, id',
      [automationId, contactId]
    )
    assert.equal(rows.length, 2)
    const secondEnrollment = rows.find((row) => row.id !== firstEnrollmentId)
    assert.ok(secondEnrollment)
    assert.equal(secondEnrollment.status, 'waiting')
    assert.equal(secondEnrollment.current_node_id, 'wait-click')

    await handleAutomationEvent('trigger-link-clicked', {
      contactId,
      triggerLinkId,
      triggerLinkName: 'Confirmación',
      eventId: `click_second_${suffix}`
    })
    rows = await db.all(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY entered_at, id',
      [automationId, contactId]
    )
    assert.equal(rows.every((row) => row.status === 'completed'), true)
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('objetivo de cita usa el evento de cada ejecución y no el historial del contacto', async () => {
  const suffix = randomUUID()
  const automationId = `automation_reentry_goal_${suffix}`
  const contactId = `contact_reentry_goal_${suffix}`
  const calendarId = `calendar_reentry_goal_${suffix}`
  const appointmentId = `appointment_reentry_goal_${suffix}`
  const flow = {
    nodes: [
      {
        id: 'start',
        type: 'start',
        label: 'Cuando...',
        config: { triggers: [] }
      },
      {
        id: 'long-wait',
        type: 'logic-wait',
        label: 'Secuencia activa',
        config: { mode: 'duration', amount: 30, unit: 'days' }
      },
      {
        id: 'appointment-goal',
        type: 'logic-goal',
        label: 'Evento objetivo',
        config: {
          name: 'Agendó consulta',
          goalType: 'appointment',
          appointmentStatus: 'booked',
          calendar: calendarId,
          evaluate: 'during-automation',
          onMet: 'end-automation',
          onNotMet: 'continue',
          windowMode: 'none'
        }
      }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'long-wait' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+522${Date.now().toString().slice(-10)}`,
        `reentry-goal-${suffix}@test.com`,
        'Contacto Meta',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test objetivo por ejecución', JSON.stringify(flow), JSON.stringify(flow)]
    )

    await enrollContactManually({ automationId, contactId })
    const firstEnrollment = await db.get(
      'SELECT id FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
      [automationId, contactId]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        calendarId,
        contactId,
        'Consulta previa',
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date(Date.now() + 90_000_000).toISOString()
      ]
    )
    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId,
      calendarId,
      status: 'confirmed'
    })

    await enrollContactManually({ automationId, contactId })
    let rows = await db.all(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY entered_at, id',
      [automationId, contactId]
    )
    assert.equal(rows.length, 2)
    const firstRow = rows.find((row) => row.id === firstEnrollment.id)
    const secondRow = rows.find((row) => row.id !== firstEnrollment.id)
    assert.equal(firstRow?.status, 'completed')
    assert.equal(secondRow?.status, 'waiting')

    await handleAutomationEvent('appointment-booked', {
      contactId,
      appointmentId: `${appointmentId}_second`,
      calendarId,
      status: 'confirmed'
    })
    rows = await db.all(
      'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ? ORDER BY entered_at, id',
      [automationId, contactId]
    )
    assert.equal(rows.every((row) => row.status === 'completed'), true)
    const completedSecondRow = rows.find((row) => row.id === secondRow.id)
    const secondLog = JSON.parse(completedSecondRow?.log || '[]')
    assert.equal(
      secondLog.some((entry) => /Objetivo cumplido en esta ejecución/.test(entry.detail || '')),
      true
    )
  } finally {
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('todos los eventos objetivo candidatos se cumplen sólo en la ejecución activa', async () => {
  const suffix = randomUUID()
  const created = []
  const cases = [
    {
      key: 'tag-received',
      goal: { goalType: 'tag', tagOperator: 'received', tag: `tag_${suffix}` },
      eventType: 'tag-changed',
      eventData: { tagId: `tag_${suffix}`, tagAction: 'added' }
    },
    {
      key: 'tag-lost',
      goal: { goalType: 'tag', tagOperator: 'lost', tag: `tag_${suffix}` },
      eventType: 'tag-changed',
      eventData: { tagId: `tag_${suffix}`, tagAction: 'removed' }
    },
    {
      key: 'payment-success',
      goal: {
        goalType: 'payment',
        paymentEvent: 'received',
        amountOperator: 'gte',
        amount: 500,
        product: `product_${suffix}`
      },
      eventType: 'payment-received',
      eventData: {
        paymentStatus: 'paid',
        amount: 750,
        product: `product_${suffix}`
      }
    },
    {
      key: 'payment-failed',
      goal: { goalType: 'payment', paymentEvent: 'failed', amountOperator: 'any' },
      eventType: 'payment-received',
      eventData: { paymentStatus: 'failed', amount: 750 }
    },
    {
      key: 'refund',
      goal: { goalType: 'payment', paymentEvent: 'refund', amountOperator: 'any' },
      eventType: 'refund',
      eventData: { paymentStatus: 'refunded', amount: 750 }
    },
    {
      key: 'appointment-status',
      goal: {
        goalType: 'appointment',
        appointmentStatus: 'confirmed',
        calendar: `calendar_${suffix}`
      },
      eventType: 'appointment-status',
      eventData: {
        status: 'confirmed',
        calendarId: `calendar_${suffix}`
      }
    },
    {
      key: 'form',
      goal: { goalType: 'form', form: `form_${suffix}` },
      eventType: 'form-submitted',
      eventData: { formId: `form_${suffix}`, formName: 'Registro' }
    },
    {
      key: 'form-legacy-name',
      goal: { goalType: 'form', formName: `Registro ${suffix}` },
      eventType: 'form-submitted',
      eventData: { formId: `form_legacy_${suffix}`, formName: `Registro ${suffix}` }
    },
    {
      key: 'trigger-link',
      goal: { goalType: 'link', link: `link_${suffix}` },
      eventType: 'trigger-link-clicked',
      eventData: { triggerLinkId: `link_${suffix}` }
    },
    {
      key: 'conversation-keyword',
      goal: {
        goalType: 'conversation',
        conversationEvent: 'keyword',
        conversationChannel: 'whatsapp',
        keyword: 'confirmo'
      },
      incoming: {
        text: 'Sí, confirmo la cita',
        channel: 'whatsapp'
      }
    },
    {
      key: 'contact-field',
      goal: {
        goalType: 'contact',
        contactEvent: 'field_contains',
        contactField: 'stage',
        contactFieldValue: 'cliente'
      },
      prepare: async (contactId) => {
        await db.run(
          'UPDATE contacts SET custom_fields = ? WHERE id = ?',
          [JSON.stringify({ stage: 'cliente' }), contactId]
        )
      },
      eventType: 'contact-updated',
      eventData: { changedFields: ['stage'] }
    },
    {
      key: 'contact-assigned',
      goal: { goalType: 'contact', contactEvent: 'assigned' },
      eventType: 'contact-updated',
      eventData: { changedFields: ['assignedUser'] }
    },
    {
      key: 'ctwa',
      goal: { goalType: 'ads', adsEvent: 'ctwa' },
      incoming: {
        text: 'Vengo del anuncio',
        channel: 'whatsapp',
        adId: `ad_${suffix}`,
        adReferral: true
      }
    },
    {
      key: 'facebook-ad',
      goal: { goalType: 'ads', adsEvent: 'fb_click' },
      incoming: {
        text: 'Quiero información',
        channel: 'messenger',
        adId: `ad_${suffix}`,
        adReferral: true
      }
    },
    {
      key: 'custom',
      goal: { goalType: 'custom', customEventName: `event_${suffix}` },
      eventType: 'webhook-received',
      eventData: {
        endpointId: `event_${suffix}`,
        payload: { status: 'ok' }
      }
    },
    {
      key: 'advanced',
      goal: {
        goalType: 'advanced',
        advancedCondition: {
          branches: [
            {
              name: 'Cliente',
              groupsOperator: 'AND',
              groups: [
                {
                  operator: 'AND',
                  negate: false,
                  rules: [
                    { field: 'contact-stage', operator: 'is', value: 'cliente' }
                  ]
                }
              ]
            }
          ]
        }
      },
      prepare: async (contactId) => {
        await db.run(
          'UPDATE contacts SET custom_fields = ? WHERE id = ?',
          [JSON.stringify({ stage: 'cliente' }), contactId]
        )
      },
      eventType: 'contact-updated',
      eventData: { changedFields: ['stage'] }
    }
  ]

  try {
    for (const item of cases) {
      const contactId = `contact_goal_${item.key}_${suffix}`
      const automationId = `automation_goal_${item.key}_${suffix}`
      created.push({ contactId, automationId })
      const flow = {
        nodes: [
          { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
          {
            id: 'active-sequence',
            type: 'logic-wait',
            label: 'Secuencia activa',
            config: { mode: 'duration', amount: 30, unit: 'days' }
          },
          {
            id: 'goal',
            type: 'logic-goal',
            label: 'Evento objetivo',
            config: {
              name: `Objetivo ${item.key}`,
              evaluate: 'during-automation',
              onMet: 'end-automation',
              onNotMet: 'continue',
              windowMode: 'none',
              ...item.goal
            }
          }
        ],
        edges: [
          { id: 'edge-start-active', sourceNodeId: 'start', targetNodeId: 'active-sequence' }
        ],
        settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
      }

      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `+526${Date.now().toString().slice(-9)}`,
          `goal-${item.key}-${suffix}@test.com`,
          `Contacto ${item.key}`,
          'Contacto',
          JSON.stringify({ stage: 'prospecto' })
        ]
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, `Test objetivo ${item.key}`, JSON.stringify(flow), JSON.stringify(flow)]
      )

      const enrollment = await enrollContactManually({ automationId, contactId })
      assert.equal(enrollment.status, 'waiting', item.key)
      await item.prepare?.(contactId)

      if (item.incoming) {
        await handleIncomingMessage({ contactId, ...item.incoming })
      } else {
        await handleAutomationEvent(item.eventType, {
          contactId,
          ...item.eventData
        })
      }

      const row = await db.get(
        'SELECT * FROM automation_enrollments WHERE id = ?',
        [enrollment.id]
      )
      assert.equal(row.status, 'completed', item.key)
      const log = JSON.parse(row.log || '[]')
      assert.equal(
        log.some((entry) => /Objetivo cumplido en esta ejecución/.test(entry.detail || '')),
        true,
        item.key
      )
    }
  } finally {
    for (const item of created) {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [item.automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [item.automationId])
      await db.run('DELETE FROM contacts WHERE id = ?', [item.contactId])
    }
  }
})

test('un objetivo terminal sólo saca al contacto cuando todos sus filtros quedan comprobados', async () => {
  const suffix = randomUUID()
  const automationId = `automation_goal_filters_${suffix}`
  const contactId = `contact_goal_filters_${suffix}`
  const flow = {
    nodes: [
      { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
      {
        id: 'active-sequence',
        type: 'logic-wait',
        label: 'Secuencia activa',
        config: { mode: 'duration', amount: 30, unit: 'days' }
      },
      {
        id: 'payment-goal',
        type: 'logic-goal',
        label: 'Evento objetivo',
        config: {
          name: 'Pago Stripe en USD',
          goalType: 'payment',
          paymentEvent: 'received',
          amountOperator: 'any',
          evaluate: 'during-automation',
          onMet: 'remove',
          onNotMet: 'continue',
          windowMode: 'none',
          filters: [
            { field: 'provider', match: 'is', value: 'stripe', connector: 'and' },
            { field: 'product', match: 'is', value: `product_${suffix}`, connector: 'and' },
            { field: 'currency', match: 'is', value: 'USD', connector: 'and' },
            { field: 'source', match: 'is', value: 'facebook', connector: 'and' }
          ]
        }
      }
    ],
    edges: [
      { id: 'edge-start-active', sourceNodeId: 'start', targetNodeId: 'active-sequence' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, source, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+528${Date.now().toString().slice(-9)}`,
        `goal-filters-${suffix}@test.com`,
        'Contacto con filtros',
        'Contacto',
        'facebook',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test objetivo con filtros', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const enrollment = await enrollContactManually({ automationId, contactId })
    assert.equal(enrollment.status, 'waiting')

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentStatus: 'paid',
      amount: 500,
      currency: 'USD'
    })
    let row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'waiting', 'un dato de filtro ausente no puede sacar al contacto')

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentStatus: 'paid',
      amount: 500,
      currency: 'USD',
      provider: 'paypal',
      product: `product_${suffix}`
    })
    row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'waiting', 'un filtro que no coincide mantiene al contacto dentro')

    await handleAutomationEvent('payment-received', {
      contactId,
      paymentStatus: 'paid',
      amount: 500,
      currency: 'USD',
      provider: 'stripe',
      product: `product_${suffix}`
    })
    row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'completed')
    assert.equal(row.execution_outcome, 'success')
    assert.equal(row.wait_kind, null)
    assert.equal(row.resume_at, null)
    assert.equal(
      JSON.parse(row.log || '[]').some((entry) => /Objetivo cumplido en esta ejecución/.test(entry.detail || '')),
      true
    )
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('un objetivo inmediato respeta sus filtros antes de terminar la automatización', async () => {
  const suffix = randomUUID()
  const automationId = `automation_immediate_goal_filters_${suffix}`
  const advancedAutomationId = `automation_immediate_advanced_filters_${suffix}`
  const tagId = `tag_immediate_goal_${suffix}`
  const nonMatchingContactId = `contact_immediate_goal_no_${suffix}`
  const matchingContactId = `contact_immediate_goal_yes_${suffix}`
  const flow = {
    nodes: [
      { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
      {
        id: 'tag-goal',
        type: 'logic-goal',
        label: 'Evento objetivo',
        config: {
          name: 'VIP de Facebook',
          goalType: 'tag',
          tagOperator: 'has',
          tag: tagId,
          evaluate: 'immediate',
          onMet: 'end-automation',
          onNotMet: 'continue',
          windowMode: 'none',
          filters: [{ field: 'source', match: 'is', value: 'facebook', connector: 'and' }]
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Sigue en el flujo', config: {} }
    ],
    edges: [
      { id: 'edge-start-goal', sourceNodeId: 'start', targetNodeId: 'tag-goal' },
      { id: 'edge-goal-done', sourceNodeId: 'tag-goal', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'VIP inmediato'])
    for (const [contactId, source, phonePrefix] of [
      [nonMatchingContactId, 'organic', '+528'],
      [matchingContactId, 'facebook', '+529']
    ]) {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, source, tags, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          contactId,
          `${phonePrefix}${Date.now().toString().slice(-9)}`,
          `${contactId}@test.com`,
          `Contacto ${source}`,
          'Contacto',
          source,
          JSON.stringify([tagId]),
          JSON.stringify({ stage: 'cliente' })
        ]
      )
    }
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test objetivo inmediato filtrado', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const advancedFlow = {
      ...flow,
      nodes: flow.nodes.map((node) => node.id !== 'tag-goal'
        ? node
        : {
            ...node,
            id: 'advanced-goal',
            config: {
              ...node.config,
              goalType: 'advanced',
              advancedCondition: {
                branches: [{
                  name: 'Cliente',
                  groupsOperator: 'AND',
                  groups: [{
                    operator: 'AND',
                    negate: false,
                    rules: [{ field: 'contact-stage', operator: 'is', value: 'cliente' }]
                  }]
                }]
              }
            }
          }),
      edges: flow.edges.map((edge) => ({
        ...edge,
        sourceNodeId: edge.sourceNodeId === 'tag-goal' ? 'advanced-goal' : edge.sourceNodeId,
        targetNodeId: edge.targetNodeId === 'tag-goal' ? 'advanced-goal' : edge.targetNodeId
      }))
    }
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [
        advancedAutomationId,
        'Test objetivo avanzado inmediato filtrado',
        JSON.stringify(advancedFlow),
        JSON.stringify(advancedFlow)
      ]
    )

    const nonMatching = await enrollContactManually({ automationId, contactId: nonMatchingContactId })
    assert.equal(nonMatching.status, 'completed')
    assert.equal(nonMatching.currentNodeId, 'done')

    const matching = await enrollContactManually({ automationId, contactId: matchingContactId })
    assert.equal(matching.status, 'completed')
    assert.equal(matching.executionOutcome, 'success')
    assert.equal(matching.currentNodeId, 'tag-goal')

    const nonMatchingAdvanced = await enrollContactManually({
      automationId: advancedAutomationId,
      contactId: nonMatchingContactId
    })
    assert.equal(nonMatchingAdvanced.status, 'completed')
    assert.equal(nonMatchingAdvanced.currentNodeId, 'done')

    const matchingAdvanced = await enrollContactManually({
      automationId: advancedAutomationId,
      contactId: matchingContactId
    })
    assert.equal(matchingAdvanced.status, 'completed')
    assert.equal(matchingAdvanced.currentNodeId, 'advanced-goal')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id IN (?, ?)', [automationId, advancedAutomationId])
    await db.run('DELETE FROM automations WHERE id IN (?, ?)', [automationId, advancedAutomationId])
    await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [nonMatchingContactId, matchingContactId])
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId])
  }
})

test('un objetivo de pago inmediato respeta el comparador y el producto seleccionado', async () => {
  const suffix = randomUUID()
  const contactId = `contact_immediate_payment_amount_${suffix}`
  const paymentId = `payment_immediate_amount_${suffix}`
  const greaterAutomationId = `automation_immediate_payment_gt_${suffix}`
  const greaterOrEqualAutomationId = `automation_immediate_payment_gte_${suffix}`
  const differentProductAutomationId = `automation_immediate_payment_product_${suffix}`
  const flowFor = (amountOperator, overrides = {}) => ({
    nodes: [
      { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
      {
        id: 'payment-goal',
        type: 'logic-goal',
        label: 'Evento objetivo',
        config: {
          name: 'Pago acumulado',
          goalType: 'payment',
          paymentEvent: 'received',
          amountOperator,
          amount: 500,
          evaluate: 'immediate',
          onMet: 'end-automation',
          onNotMet: 'continue',
          windowMode: 'none',
          ...overrides
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Sigue en el flujo', config: {} }
    ],
    edges: [
      { id: 'edge-start-goal', sourceNodeId: 'start', targetNodeId: 'payment-goal' },
      { id: 'edge-goal-done', sourceNodeId: 'payment-goal', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  })
  const greaterFlow = flowFor('gt')
  const greaterOrEqualFlow = flowFor('gte')
  const differentProductFlow = flowFor('any', { product: `another_product_${suffix}` })

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+527${Date.now().toString().slice(-9)}`,
        `immediate-payment-${suffix}@test.com`,
        'Contacto pago inmediato',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, payment_mode, reference, title, date)
       VALUES (?, ?, 500, 'USD', 'paid', 'card', 'live', ?, ?, ?)`,
      [paymentId, contactId, `ref_${suffix}`, 'Pago exacto', new Date().toISOString()]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [greaterAutomationId, 'Test pago mayor', JSON.stringify(greaterFlow), JSON.stringify(greaterFlow)]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [
        greaterOrEqualAutomationId,
        'Test pago mayor o igual',
        JSON.stringify(greaterOrEqualFlow),
        JSON.stringify(greaterOrEqualFlow)
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [
        differentProductAutomationId,
        'Test pago de otro producto',
        JSON.stringify(differentProductFlow),
        JSON.stringify(differentProductFlow)
      ]
    )

    const greater = await enrollContactManually({ automationId: greaterAutomationId, contactId })
    assert.equal(greater.status, 'completed')
    assert.equal(greater.currentNodeId, 'done')

    const greaterOrEqual = await enrollContactManually({ automationId: greaterOrEqualAutomationId, contactId })
    assert.equal(greaterOrEqual.status, 'completed')
    assert.equal(greaterOrEqual.currentNodeId, 'payment-goal')

    const differentProduct = await enrollContactManually({
      automationId: differentProductAutomationId,
      contactId
    })
    assert.equal(differentProduct.status, 'completed')
    assert.equal(differentProduct.currentNodeId, 'done')
  } finally {
    await db.run(
      'DELETE FROM automation_enrollments WHERE automation_id IN (?, ?, ?)',
      [greaterAutomationId, greaterOrEqualAutomationId, differentProductAutomationId]
    )
    await db.run(
      'DELETE FROM automations WHERE id IN (?, ?, ?)',
      [greaterAutomationId, greaterOrEqualAutomationId, differentProductAutomationId]
    )
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('los objetivos que dependen de un evento nuevo no se autocumplen con historial en modo inmediato', async () => {
  const suffix = randomUUID()
  const contactId = `contact_immediate_event_only_${suffix}`
  const tagId = `tag_immediate_event_only_${suffix}`
  const paymentId = `payment_immediate_event_only_${suffix}`
  const appointmentId = `appointment_immediate_event_only_${suffix}`
  const calendarId = `calendar_immediate_event_only_${suffix}`
  const cases = [
    {
      key: 'tag-lost',
      goal: { goalType: 'tag', tagOperator: 'lost', tag: tagId }
    },
    {
      key: 'payment-refund',
      goal: { goalType: 'payment', paymentEvent: 'refund', amountOperator: 'any' }
    },
    {
      key: 'appointment-cancelled',
      goal: { goalType: 'appointment', appointmentStatus: 'cancelled' }
    },
    {
      key: 'appointment-other-calendar',
      goal: {
        goalType: 'appointment',
        appointmentStatus: 'booked',
        calendar: `another_calendar_${suffix}`
      }
    }
  ]

  try {
    await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'Evento pendiente'])
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, tags, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+527${Date.now().toString().slice(-9)}`,
        `immediate-event-only-${suffix}@test.com`,
        'Contacto con historial',
        'Contacto',
        JSON.stringify([tagId]),
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO payments (id, contact_id, amount, currency, status, payment_method, payment_mode, reference, title, date)
       VALUES (?, ?, ?, 'USD', 'paid', 'card', 'live', ?, ?, ?)`,
      [paymentId, contactId, 500, `REF-${suffix}`, 'Pago previo', new Date().toISOString()]
    )
    await db.run(
      `INSERT INTO appointments
         (id, calendar_id, contact_id, title, status, appointment_status, start_time, end_time)
       VALUES (?, ?, ?, ?, 'confirmed', 'confirmed', ?, ?)`,
      [
        appointmentId,
        calendarId,
        contactId,
        'Cita activa previa',
        new Date(Date.now() + 86_400_000).toISOString(),
        new Date(Date.now() + 90_000_000).toISOString()
      ]
    )

    for (const item of cases) {
      const automationId = `automation_immediate_event_only_${item.key}_${suffix}`
      const flow = {
        nodes: [
          { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
          {
            id: 'goal',
            type: 'logic-goal',
            label: 'Evento objetivo',
            config: {
              name: `Objetivo ${item.key}`,
              evaluate: 'immediate',
              onMet: 'end-automation',
              onNotMet: 'continue',
              windowMode: 'none',
              ...item.goal
            }
          },
          { id: 'done', type: 'extra-comment', label: 'Continúa', config: {} }
        ],
        edges: [
          { id: 'edge-start-goal', sourceNodeId: 'start', targetNodeId: 'goal' },
          { id: 'edge-goal-done', sourceNodeId: 'goal', sourceHandle: 'out', targetNodeId: 'done' }
        ],
        settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
      }
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, `Test inmediato ${item.key}`, JSON.stringify(flow), JSON.stringify(flow)]
      )

      const enrollment = await enrollContactManually({ automationId, contactId })
      assert.equal(enrollment.status, 'completed', item.key)
      assert.equal(enrollment.currentNodeId, 'done', item.key)
    }
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id LIKE ?', [`automation_immediate_event_only_%_${suffix}`])
    await db.run('DELETE FROM automations WHERE id LIKE ?', [`automation_immediate_event_only_%_${suffix}`])
    await db.run('DELETE FROM appointments WHERE id = ?', [appointmentId])
    await db.run('DELETE FROM payments WHERE id = ?', [paymentId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId])
  }
})

test('objetivo sin respuesta vence por ejecución y una respuesta nueva lo descarta', async () => {
  const suffix = randomUUID()
  const automationId = `automation_no_reply_goal_${suffix}`
  const contactId = `contact_no_reply_goal_${suffix}`
  const flow = {
    nodes: [
      { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
      {
        id: 'goal-no-reply',
        type: 'logic-goal',
        label: 'Sin respuesta',
        config: {
          name: 'No respondió',
          goalType: 'conversation',
          conversationEvent: 'no_reply',
          conversationChannel: 'any',
          evaluate: 'immediate',
          onMet: 'end-automation',
          onNotMet: 'continue',
          windowMode: 'duration',
          windowAmount: 1,
          windowUnit: 'days',
          filters: [{ field: 'source', match: 'is', value: 'facebook', connector: 'and' }]
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [
      { id: 'edge-start-goal', sourceNodeId: 'start', targetNodeId: 'goal-no-reply' },
      { id: 'edge-goal-done', sourceNodeId: 'goal-no-reply', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, source, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+527${Date.now().toString().slice(-9)}`,
        `no-reply-goal-${suffix}@test.com`,
        'Contacto Sin Respuesta',
        'Contacto',
        'facebook',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test objetivo sin respuesta', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const first = await enrollContactManually({ automationId, contactId })
    assert.equal(first.status, 'waiting')
    assert.equal(first.waitKind, 'goal')
    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), first.id]
    )
    await processDueResumes()

    let row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [first.id])
    assert.equal(row.status, 'completed')
    assert.equal(row.execution_outcome, 'success')
    assert.equal(
      JSON.parse(row.log || '[]').some((entry) => /no respondió dentro del tiempo/.test(entry.detail || '')),
      true
    )

    const second = await enrollContactManually({ automationId, contactId })
    assert.equal(second.status, 'waiting')
    await handleIncomingMessage({
      contactId,
      text: 'Aquí estoy de nuevo',
      channel: 'whatsapp'
    })

    row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [second.id])
    assert.equal(row.status, 'completed')
    assert.equal(row.current_node_id, 'done')
    assert.equal(
      JSON.parse(row.log || '[]').some((entry) => /objetivo de no respuesta no se cumplió/.test(entry.detail || '')),
      true
    )

    await db.run('UPDATE contacts SET source = ? WHERE id = ?', ['organic', contactId])
    const third = await enrollContactManually({ automationId, contactId })
    assert.equal(third.status, 'waiting')
    await db.run(
      'UPDATE automation_enrollments SET resume_at = ? WHERE id = ?',
      [new Date(Date.now() - 1000).toISOString(), third.id]
    )
    await processDueResumes()

    row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [third.id])
    assert.equal(row.status, 'completed')
    assert.equal(row.current_node_id, 'done')
    assert.equal(
      JSON.parse(row.log || '[]').some((entry) => /ya no cumple los filtros del objetivo/.test(entry.detail || '')),
      true
    )
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('Esperar reanuda formularios, pagos, citas y eventos personalizados de la ejecución activa', async () => {
  const suffix = randomUUID()
  const contactId = `contact_event_waits_${suffix}`
  const formId = `form_event_waits_${suffix}`
  const calendarId = `calendar_event_waits_${suffix}`
  const customEventName = `custom_event_waits_${suffix}`
  const cases = [
    {
      key: 'form',
      expectedAction: 'submit_form',
      actionResource: formId,
      eventType: 'form-submitted',
      eventData: { formId, formName: 'Registro' }
    },
    {
      key: 'payment',
      expectedAction: 'purchase',
      actionResource: '',
      eventType: 'payment-received',
      eventData: { paymentStatus: 'paid', amount: 500, currency: 'USD' }
    },
    {
      key: 'appointment',
      expectedAction: 'book_appointment',
      actionResource: calendarId,
      eventType: 'appointment-booked',
      eventData: { calendarId, status: 'confirmed' }
    },
    {
      key: 'custom',
      expectedAction: 'custom_event',
      actionResource: customEventName,
      eventType: 'custom-event',
      eventData: { customEventName, payload: { status: 'ok' } }
    }
  ]
  const automationIds = cases.map((entry) => `automation_wait_${entry.key}_${suffix}`)

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+523${Date.now().toString().slice(-10)}`,
        `event-waits-${suffix}@test.com`,
        'Contacto Esperas',
        'Contacto',
        '{}'
      ]
    )

    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index]
      const automationId = automationIds[index]
      const flow = {
        nodes: [
          { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
          {
            id: 'wait-action',
            type: 'logic-wait',
            label: `Esperar ${entry.key}`,
            config: {
              mode: 'action',
              expectedAction: entry.expectedAction,
              actionResource: entry.actionResource
            }
          },
          { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
        ],
        edges: [
          { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-action' },
          { id: 'edge-wait-done', sourceNodeId: 'wait-action', sourceHandle: 'out', targetNodeId: 'done' }
        ],
        settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
      }
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, `Test espera ${entry.key}`, JSON.stringify(flow), JSON.stringify(flow)]
      )
      const enrollment = await enrollContactManually({ automationId, contactId })
      assert.equal(enrollment.status, 'waiting')

      await handleAutomationEvent(entry.eventType, {
        contactId,
        ...entry.eventData
      })
      const row = await db.get(
        'SELECT * FROM automation_enrollments WHERE id = ?',
        [enrollment.id]
      )
      assert.equal(row.status, 'completed', entry.key)
      assert.equal(row.current_node_id, 'done', entry.key)
    }
  } finally {
    for (const automationId of automationIds) {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    }
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('Esperar condiciones sólo se cumple con un cambio nuevo dentro de la ejecución', async () => {
  const suffix = randomUUID()
  const automationId = `automation_condition_wait_${suffix}`
  const contactId = `contact_condition_wait_${suffix}`
  const flow = {
    nodes: [
      { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
      {
        id: 'wait-condition',
        type: 'logic-wait',
        label: 'Esperar condición',
        config: {
          mode: 'conditions',
          evaluation: 'continuous',
          conditions: {
            branches: [
              {
                name: 'Ya es cliente',
                groupsOperator: 'AND',
                groups: [
                  {
                    operator: 'AND',
                    negate: false,
                    rules: [
                      { field: 'contact-stage', operator: 'is', value: 'cliente' }
                    ]
                  }
                ]
              }
            ]
          }
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-condition' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-condition', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts
         (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+524${Date.now().toString().slice(-10)}`,
        `condition-wait-${suffix}@test.com`,
        'Contacto Condición',
        'Contacto',
        JSON.stringify({ stage: 'prospecto' })
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test espera condición', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const enrollment = await enrollContactManually({ automationId, contactId })
    assert.equal(enrollment.status, 'waiting')
    assert.equal(enrollment.waitKind, 'condition')

    await handleAutomationEvent('contact-updated', {
      contactId,
      changedFields: ['email']
    })
    let row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'waiting')

    await db.run(
      'UPDATE contacts SET custom_fields = ? WHERE id = ?',
      [JSON.stringify({ stage: 'cliente' }), contactId]
    )
    await handleAutomationEvent('contact-updated', {
      contactId,
      changedFields: ['stage']
    })
    row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'completed')
    assert.equal(row.current_node_id, 'done')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})

test('un evento cumplido mientras la ejecución está pausada se aplica al reanudar', async () => {
  const suffix = randomUUID()
  const automationId = `automation_paused_event_${suffix}`
  const contactId = `contact_paused_event_${suffix}`
  const formId = `form_paused_event_${suffix}`
  const flow = {
    nodes: [
      { id: 'start', type: 'start', label: 'Cuando...', config: { triggers: [] } },
      {
        id: 'wait-form',
        type: 'logic-wait',
        label: 'Esperar formulario',
        config: {
          mode: 'action',
          expectedAction: 'submit_form',
          actionResource: formId
        }
      },
      { id: 'done', type: 'extra-comment', label: 'Listo', config: {} }
    ],
    edges: [
      { id: 'edge-start-wait', sourceNodeId: 'start', targetNodeId: 'wait-form' },
      { id: 'edge-wait-done', sourceNodeId: 'wait-form', sourceHandle: 'out', targetNodeId: 'done' }
    ],
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }

  try {
    await db.run(
      `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        `+525${Date.now().toString().slice(-10)}`,
        `paused-event-${suffix}@test.com`,
        'Contacto Pausado',
        'Contacto',
        '{}'
      ]
    )
    await db.run(
      `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
       VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
      [automationId, 'Test evento pausado', JSON.stringify(flow), JSON.stringify(flow)]
    )

    const enrollment = await enrollContactManually({ automationId, contactId })
    await controlAutomationEnrollment({
      automationId,
      enrollmentId: enrollment.id,
      action: 'pause'
    })
    await handleAutomationEvent('form-submitted', {
      contactId,
      formId,
      formName: 'Registro pausado'
    })

    let row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'paused')
    assert.ok(JSON.parse(row.context || '{}').__pendingWaitCompletion)

    await controlAutomationEnrollment({
      automationId,
      enrollmentId: enrollment.id,
      action: 'resume'
    })
    row = await db.get('SELECT * FROM automation_enrollments WHERE id = ?', [enrollment.id])
    assert.equal(row.status, 'completed')
    assert.equal(row.current_node_id, 'done')
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
    await db.run('DELETE FROM automations WHERE id = ?', [automationId])
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
  }
})
