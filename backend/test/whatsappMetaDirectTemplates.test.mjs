import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  createWhatsAppApiTemplate,
  deleteWhatsAppApiTemplate,
  editWhatsAppApiTemplate,
  getWhatsAppApiConfigKeys,
  setMetaDirectFetchForTest,
  syncMetaDirectTemplateWebhookChange,
  syncWhatsAppApiTemplatesFromMetaDirect
} from '../src/services/whatsappApiService.js'
import {
  createMessageTemplate,
  sendMessageTemplateTest,
  submitMessageTemplateToActiveProvider
} from '../src/services/messageTemplatesService.js'

function graphResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

async function snapshotConfig(keys, callback) {
  const unique = [...new Set(keys)]
  const placeholders = unique.map(() => '?').join(', ')
  const rows = await db.all(`SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`, unique)
  try {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, unique)
    return await callback()
  } finally {
    setMetaDirectFetchForTest(null)
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, unique)
    for (const row of rows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

test('CRUD y sincronización de plantillas Meta directo usan Graph e identidad neutral', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const wabaId = `waba_meta_templates_${suffix}`
  const templateId = `meta_template_${suffix}`
  const templateName = `recordatorio_meta_${suffix}`
  const requests = []
  let listStatus = 'APPROVED'

  await snapshotConfig([
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken
  ], async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, wabaId)
    await setAppConfig(keys.metaPhoneNumberId, `phone_${suffix}`)
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_template_test_token'))

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      const body = options.body ? JSON.parse(options.body) : null
      requests.push({ method: options.method || 'GET', path: requestUrl.pathname, query: requestUrl.searchParams, body })

      if ((options.method || 'GET') === 'POST' && requestUrl.pathname.endsWith(`/${wabaId}/message_templates`)) {
        return graphResponse({ id: templateId, status: 'PENDING', category: 'UTILITY' })
      }
      if ((options.method || 'GET') === 'POST' && requestUrl.pathname.endsWith(`/${templateId}`)) {
        return graphResponse({ success: true })
      }
      if ((options.method || 'GET') === 'DELETE') return graphResponse({ success: true })
      return graphResponse({
        data: [{
          id: templateId,
          name: templateName,
          language: 'es_MX',
          category: 'UTILITY',
          status: listStatus,
          quality_score: { score: 'GREEN' },
          components: [{ type: 'BODY', text: 'Hola {{1}}' }]
        }],
        paging: {}
      })
    })

    const created = await createWhatsAppApiTemplate({
      name: templateName,
      language: 'es_MX',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Hola {{1}}', example: { body_text: [['Maria']] } }]
    })
    assert.equal(created.provider, 'meta_direct')
    assert.equal(created.providerTemplateId, templateId)
    assert.equal(requests[0].path, `/v22.0/${wabaId}/message_templates`)
    assert.equal('wabaId' in requests[0].body, false)

    const createdSnapshot = await db.get(
      'SELECT provider, source_adapter, provider_template_id, ycloud_create_time FROM whatsapp_api_templates WHERE id = ?',
      [templateId]
    )
    assert.deepEqual(createdSnapshot, {
      provider: 'meta_direct',
      source_adapter: 'meta_direct',
      provider_template_id: templateId,
      ycloud_create_time: null
    })

    await editWhatsAppApiTemplate({
      provider: 'meta_direct',
      providerTemplateId: templateId,
      name: templateName,
      language: 'es_MX',
      category: 'UTILITY',
      components: [{ type: 'BODY', text: 'Texto actualizado' }]
    })
    const editRequest = requests.find(request => request.method === 'POST' && request.path.endsWith(`/${templateId}`))
    assert.ok(editRequest)
    assert.equal(editRequest.body.name, templateName)

    listStatus = 'APPROVED'
    await syncWhatsAppApiTemplatesFromMetaDirect({ wabaId })
    const synced = await db.get('SELECT provider, status, quality_rating FROM whatsapp_api_templates WHERE id = ?', [templateId])
    assert.deepEqual(synced, { provider: 'meta_direct', status: 'APPROVED', quality_rating: 'GREEN' })

    await deleteWhatsAppApiTemplate({
      provider: 'meta_direct',
      wabaId,
      name: templateName,
      language: 'es_MX',
      providerTemplateId: templateId
    })
    const deleteRequest = requests.find(request => request.method === 'DELETE')
    assert.equal(deleteRequest.path, `/v22.0/${wabaId}/message_templates`)
    assert.equal(deleteRequest.query.get('name'), templateName)
    assert.equal(deleteRequest.query.get('hsm_id'), templateId)
    assert.equal(await db.get('SELECT id FROM whatsapp_api_templates WHERE id = ?', [templateId]), null)
  })
})

test('el flujo local envía a Meta directo sin escribir el ID en columnas YCloud', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const wabaId = `waba_meta_local_${suffix}`
  const templateId = `meta_local_${suffix}`
  const templateName = `plantilla_local_meta_${suffix}`
  const requests = []

  await snapshotConfig([
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken
  ], async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, wabaId)
    await setAppConfig(keys.metaPhoneNumberId, `phone_local_${suffix}`)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561112233')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_local_template_token'))
    setMetaDirectFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      requests.push({ path: requestUrl.pathname, method: options.method || 'GET' })
      if (requestUrl.pathname.endsWith(`/phone_local_${suffix}/messages`)) {
        return graphResponse({ messages: [{ id: `wamid_test_${suffix}`, message_status: 'accepted' }] })
      }
      return graphResponse({ id: templateId, status: 'PENDING', category: 'UTILITY' })
    })

    const local = await createMessageTemplate({
      name: templateName,
      description: 'Prueba Meta directo',
      category: 'utility',
      language: 'es_MX',
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      bodyText: 'Hola desde Meta directo',
      footerText: '',
      buttons: [],
      variableExamples: {},
      variableBindings: { headerText: {}, bodyText: {} }
    })
    assert.equal(local.templateProvider, 'meta_direct')
    assert.equal(local.ycloudTemplateId, null)
    assert.equal(local.ycloudStatus, null)

    try {
      const result = await submitMessageTemplateToActiveProvider(local.id)
      assert.equal(result.provider, 'meta_direct')
      assert.equal(result.template.templateProvider, 'meta_direct')
      assert.equal(result.template.providerTemplateId, templateId)
      assert.equal(result.template.providerStatus, 'PENDING')
      assert.equal(result.template.ycloudTemplateId, null)
      assert.equal(result.template.ycloudStatus, null)

      await db.run(
        "UPDATE whatsapp_message_templates SET provider_status = 'APPROVED' WHERE id = ?",
        [local.id]
      )
      await db.run(
        "UPDATE whatsapp_api_templates SET status = 'APPROVED' WHERE provider = 'meta_direct' AND provider_template_id = ?",
        [templateId]
      )
      const testSend = await sendMessageTemplateTest(local.id, { to: '+526561234567' })
      assert.equal(testSend.sent, true)
      assert.ok(requests.some(request => request.path.endsWith(`/phone_local_${suffix}/messages`)))
    } finally {
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [local.id])
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?', [templateName, 'es_MX'])
    }
  })
})

test('webhook Meta actualiza estado y calidad sin tocar columnas YCloud', async () => {
  const suffix = Date.now()
  const wabaId = `waba_meta_webhook_${suffix}`
  const templateId = `meta_webhook_${suffix}`
  const templateName = `plantilla_webhook_meta_${suffix}`
  const local = await createMessageTemplate({
    name: templateName,
    description: 'Prueba webhook Meta',
    category: 'utility',
    language: 'es_MX',
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    bodyText: 'Hola desde webhook',
    footerText: '',
    buttons: [],
    variableExamples: {},
    variableBindings: { headerText: {}, bodyText: {} }
  })

  try {
    await db.run(`
      UPDATE whatsapp_message_templates
      SET template_provider = 'meta_direct', provider_template_id = ?, provider_template_name = ?, provider_status = 'PENDING'
      WHERE id = ?
    `, [templateId, templateName, local.id])

    await syncMetaDirectTemplateWebhookChange({
      entry: { id: wabaId },
      eventRowId: `event_${suffix}`,
      change: {
        field: 'message_template_status_update',
        value: {
          message_template_id: templateId,
          message_template_name: templateName,
          message_template_language: 'es_MX',
          event: 'APPROVED',
          quality_score: { score: 'GREEN' }
        }
      }
    })

    const updated = await db.get(`
      SELECT template_provider, provider_status, provider_quality_rating, ycloud_status, ycloud_template_id
      FROM whatsapp_message_templates WHERE id = ?
    `, [local.id])
    assert.deepEqual(updated, {
      template_provider: 'meta_direct',
      provider_status: 'APPROVED',
      provider_quality_rating: 'GREEN',
      ycloud_status: null,
      ycloud_template_id: null
    })
  } finally {
    await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [local.id])
    await db.run('DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?', [templateName, 'es_MX'])
  }
})
