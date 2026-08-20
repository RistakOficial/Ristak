import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  createWhatsAppApiTemplate,
  deleteWhatsAppApiTemplate,
  editWhatsAppApiTemplate,
  getWhatsAppApiConfigKeys,
  sendWhatsAppApiTemplateMessage,
  setMetaDirectFetchForTest,
  syncMetaDirectTemplateWebhookChange,
  syncWhatsAppApiTemplatesFromMetaDirect
} from '../src/services/whatsappApiService.js'
import {
  createMessageTemplate,
  reconcileMessageTemplatesForActiveProvider,
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
    assert.equal(requests[0].path, `/v25.0/${wabaId}/message_templates`)
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
    assert.equal(deleteRequest.path, `/v25.0/${wabaId}/message_templates`)
    assert.equal(deleteRequest.query.get('name'), templateName)
    assert.equal(deleteRequest.query.get('hsm_id'), templateId)
    assert.equal(await db.get('SELECT id FROM whatsapp_api_templates WHERE id = ?', [templateId]), null)
  })
})

test('un envío recupera de Meta una plantilla aprobada ausente del catálogo local', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const wabaId = `waba_meta_recovery_${suffix}`
  const phoneNumberId = `phone_meta_recovery_${suffix}`
  const templateId = `meta_template_recovery_${suffix}`
  const templateName = `plantilla_recuperada_${suffix}`
  const messageId = `wamid_recovery_${suffix}`
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
    await setAppConfig(keys.metaPhoneNumberId, phoneNumberId)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561112244')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_recovery_test_token'))

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      const method = String(options.method || 'GET').toUpperCase()
      requests.push({ method, path: requestUrl.pathname, name: requestUrl.searchParams.get('name') })

      if (method === 'GET' && requestUrl.pathname.endsWith(`/${wabaId}/message_templates`)) {
        return graphResponse({
          data: [{
            id: templateId,
            name: templateName,
            language: 'es_MX',
            category: 'UTILITY',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'Tu cita quedó confirmada para {{1}}.' }]
          }],
          paging: {}
        })
      }
      if (method === 'POST' && requestUrl.pathname.endsWith(`/${wabaId}/subscribed_apps`)) {
        return graphResponse({ success: true })
      }
      if (method === 'POST' && requestUrl.pathname.endsWith(`/${phoneNumberId}/messages`)) {
        return graphResponse({ messages: [{ id: messageId, message_status: 'accepted' }] })
      }
      throw new Error(`Solicitud inesperada durante recuperación: ${method} ${requestUrl.pathname}`)
    })

    try {
      assert.equal(
        await db.get(
          'SELECT id FROM whatsapp_api_templates WHERE waba_id = ? AND name = ? AND language = ?',
          [wabaId, templateName, 'es_MX']
        ),
        null
      )

      const result = await sendWhatsAppApiTemplateMessage({
        to: '+526561234567',
        templateName,
        language: 'es_MX',
        variables: ['21 de agosto a las 3:00 p.m.'],
        variablesResolved: true,
        allowQrFallback: false
      })

      assert.equal(result.id, messageId)
      assert.equal(
        requests.filter(request => request.method === 'GET' && request.name === templateName).length,
        1
      )
      assert.equal(
        requests.filter(request => request.method === 'POST' && request.path.endsWith(`/${phoneNumberId}/messages`)).length,
        1
      )
      const recovered = await db.get(`
        SELECT provider, waba_id, status
        FROM whatsapp_api_templates
        WHERE waba_id = ? AND name = ? AND language = ?
      `, [wabaId, templateName, 'es_MX'])
      assert.deepEqual(recovered, {
        provider: 'meta_direct',
        waba_id: wabaId,
        status: 'APPROVED'
      })
    } finally {
      await db.run('DELETE FROM whatsapp_api_templates WHERE waba_id = ?', [wabaId])
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_name = ?', [templateName])
      await db.run(
        'DELETE FROM whatsapp_api_messages WHERE provider_message_id = ? OR wamid = ?',
        [messageId, messageId]
      )
    }
  })
})

test('errores de plantillas Meta directo conservan el detalle accionable de Graph', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()

  await snapshotConfig([
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaSystemUserToken
  ], async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, `waba_meta_error_${suffix}`)
    await setAppConfig(keys.metaPhoneNumberId, `phone_meta_error_${suffix}`)
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_error_test_token'))

    setMetaDirectFetchForTest(async () => graphResponse({
      error: {
        message: 'Invalid parameter',
        code: 100,
        error_subcode: 2388293,
        error_user_msg: 'El ejemplo del botón URL debe ser una URL válida.'
      }
    }, 400))

    await assert.rejects(
      () => createWhatsAppApiTemplate({
        name: `plantilla_error_${suffix}`,
        language: 'es_MX',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Mensaje de prueba' }]
      }),
      error => {
        assert.equal(error.name, 'MetaDirectGraphError')
        assert.equal(error.graphCode, 100)
        assert.equal(error.graphSubcode, 2388293)
        assert.equal(error.graphDetails, 'El ejemplo del botón URL debe ser una URL válida.')
        assert.match(error.message, /Invalid parameter: El ejemplo del botón URL debe ser una URL válida\./)
        return true
      }
    )
  })
})

test('rechaza una plantilla de otro proveedor antes de intentar el envío', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const templateId = `ycloud_template_wrong_channel_${suffix}`
  const templateName = `plantilla_canal_incorrecto_${suffix}`

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
    await setAppConfig(keys.metaWabaId, `waba_wrong_channel_${suffix}`)
    await setAppConfig(keys.metaPhoneNumberId, `phone_wrong_channel_${suffix}`)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561112233')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_wrong_channel_token'))
    await db.run(
      `INSERT INTO whatsapp_api_templates (
        id, official_template_id, provider_template_id, provider, source_adapter,
        waba_id, name, language, status, components_json, raw_payload_json
      ) VALUES (?, ?, ?, 'ycloud', 'ycloud', ?, ?, 'es_MX', 'APPROVED', ?, '{}')`,
      [
        templateId,
        templateId,
        templateId,
        `waba_ycloud_wrong_channel_${suffix}`,
        templateName,
        JSON.stringify([{ type: 'BODY', text: 'Hola' }])
      ]
    )

    try {
      await assert.rejects(
        sendWhatsAppApiTemplateMessage({
          to: '+526561234567',
          templateId,
          variablesResolved: true
        }),
        /pertenece a YCloud.*Elige un número conectado a ese canal en lugar de Meta directo/
      )
    } finally {
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
    }
  })
})

test('rechaza una plantilla Meta que pertenece a otro WABA antes de enviar', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const templateId = `meta_template_wrong_waba_${suffix}`
  const templateName = `plantilla_waba_incorrecto_${suffix}`

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
    await setAppConfig(keys.metaWabaId, `waba_actual_${suffix}`)
    await setAppConfig(keys.metaPhoneNumberId, `phone_waba_actual_${suffix}`)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561112234')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_wrong_waba_token'))
    await db.run(`
      INSERT INTO whatsapp_api_templates (
        id, official_template_id, provider_template_id, provider, source_adapter,
        waba_id, name, language, status, components_json, raw_payload_json
      ) VALUES (?, ?, ?, 'meta_direct', 'meta_direct', ?, ?, 'es_MX', 'APPROVED', ?, '{}')
    `, [
      templateId,
      templateId,
      templateId,
      `waba_anterior_${suffix}`,
      templateName,
      JSON.stringify([{ type: 'BODY', text: 'Hola' }])
    ])
    setMetaDirectFetchForTest(async () => {
      throw new Error('Meta no debe recibir una plantilla de otro WABA')
    })

    try {
      await assert.rejects(
        sendWhatsAppApiTemplateMessage({
          to: '+526561234567',
          templateId,
          variablesResolved: true
        }),
        /pertenece a otra cuenta de WhatsApp Business.*mismo WABA/
      )
    } finally {
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
    }
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
      assert.equal(testSend.response.renderedText, 'Hola desde Meta directo')
      assert.ok(requests.some(request => request.path.endsWith(`/phone_local_${suffix}/messages`)))
    } finally {
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [local.id])
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?', [templateName, 'es_MX'])
    }
  })
})

test('enviar una plantilla usa el WABA del número seleccionado y no la identidad vieja', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const selectedWabaId = `waba_selected_${suffix}`
  const staleWabaId = `waba_stale_${suffix}`
  const phoneNumberId = `phone_selected_${suffix}`
  const templateName = `plantilla_numero_seleccionado_${suffix}`
  const staleTemplateId = `template_stale_${suffix}`
  const selectedTemplateId = `template_selected_${suffix}`
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
    await setAppConfig(keys.metaWabaId, selectedWabaId)
    await setAppConfig(keys.metaPhoneNumberId, phoneNumberId)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561112255')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_selected_phone_template_token'))
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
      ) VALUES (?, 'meta_direct', ?, '+526561112255', '+52 656 111 2255',
        'Selected Phone Test', 0, 1, 0, 'disconnected', 'CONNECTED')
    `, [phoneNumberId, selectedWabaId])

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      requests.push({
        method: options.method || 'GET',
        path: requestUrl.pathname,
        body: options.body ? JSON.parse(options.body) : null
      })
      return graphResponse({ id: selectedTemplateId, status: 'PENDING', category: 'UTILITY' })
    })

    const local = await createMessageTemplate({
      name: templateName,
      description: 'Prueba de ruteo por número',
      category: 'utility',
      language: 'es_MX',
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      bodyText: 'Esta plantilla pertenece al número seleccionado',
      footerText: '',
      buttons: [],
      variableExamples: {},
      variableBindings: { headerText: {}, bodyText: {} }
    })

    try {
      await db.run(`
        UPDATE whatsapp_message_templates
        SET template_provider = 'meta_direct',
            provider_template_id = ?,
            provider_template_name = ?,
            provider_status = 'REJECTED',
            provider_raw_payload_json = ?
        WHERE id = ?
      `, [
        staleTemplateId,
        templateName,
        JSON.stringify({ wabaId: staleWabaId, id: staleTemplateId }),
        local.id
      ])

      const result = await submitMessageTemplateToActiveProvider(local.id, { phoneNumberId })
      assert.equal(result.provider, 'meta_direct')
      assert.equal(result.targetPhoneNumberId, phoneNumberId)
      assert.equal(result.template.providerTemplateId, selectedTemplateId)
      assert.equal(result.template.providerRawPayload.wabaId, selectedWabaId)
      assert.ok(requests.some((request) => (
        request.method === 'POST' &&
        request.path === `/v25.0/${selectedWabaId}/message_templates`
      )))
      assert.equal(requests.some((request) => request.path.endsWith(`/${staleTemplateId}`)), false)
    } finally {
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [local.id])
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?', [templateName, 'es_MX'])
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
    }
  })
})

test('una fila QR seleccionada no puede administrar plantillas oficiales', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const phoneNumberId = `phone_qr_template_${suffix}`
  const templateName = `plantilla_qr_rechazada_${suffix}`

  await db.run(`
    INSERT INTO whatsapp_api_phone_numbers (
      id, provider, phone_number, display_phone_number, verified_name,
      is_default_sender, api_send_enabled, qr_send_enabled, qr_status, status
    ) VALUES (?, 'qr', '+526561119988', '+52 656 111 9988',
      'QR Template Test', 0, 0, 1, 'ready', 'CONNECTED')
  `, [phoneNumberId])

  const local = await createMessageTemplate({
    name: templateName,
    description: 'Prueba de rechazo QR',
    category: 'utility',
    language: 'es_MX',
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    bodyText: 'Esta plantilla no se debe enviar por QR',
    footerText: '',
    buttons: [],
    variableExamples: {},
    variableBindings: { headerText: {}, bodyText: {} }
  })

  try {
    await assert.rejects(
      () => submitMessageTemplateToActiveProvider(local.id, { phoneNumberId }),
      /WhatsApp QR.*no administra plantillas oficiales/
    )
  } finally {
    await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [local.id])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId])
  }
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

test('al pasar de YCloud a Meta adopta las existentes, envía las faltantes y no revive aprobaciones viejas', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const wabaId = `waba_meta_migration_${suffix}`
  const phoneId = `phone_meta_migration_${suffix}`
  const existingName = `migracion_existente_${suffix}`
  const missingName = `migracion_faltante_${suffix}`
  const failingName = `migracion_fallida_${suffix}`
  const candidateRows = [
    [`tmpl_existing_${suffix}`, existingName, `ycloud_existing_${suffix}`],
    [`tmpl_missing_${suffix}`, missingName, `ycloud_missing_${suffix}`],
    [`tmpl_failing_${suffix}`, failingName, `ycloud_failing_${suffix}`]
  ]
  const requests = []

  await snapshotConfig([
    keys.enabled,
    keys.provider,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken
  ], async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.senderPhone, '+526144640000')
    await setAppConfig(keys.phoneNumberId, phoneId)
    await setAppConfig(keys.wabaId, wabaId)
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, wabaId)
    await setAppConfig(keys.metaPhoneNumberId, phoneId)
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526144640000')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_migration_test_token'))

    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number,
        status, api_send_enabled, is_default_sender
      ) VALUES (?, 'meta_direct', ?, '+526144640000', '+52 614 464 0000', 'CONNECTED', 1, 1)
    `, [phoneId, wabaId])
    for (const [id, name, ycloudId] of candidateRows) {
      await db.run(`
        INSERT INTO whatsapp_message_templates (
          id, name, language, status, body_text, template_provider,
          provider_template_name, provider_template_id, provider_status,
          provider_raw_payload_json, ycloud_template_name, ycloud_template_id,
          ycloud_status, ycloud_raw_payload_json
        ) VALUES (?, ?, 'es_MX', 'active', 'Hola desde YCloud', 'ycloud', ?, ?, 'APPROVED', ?, ?, ?, 'APPROVED', ?)
      `, [
        id,
        name,
        name,
        ycloudId,
        JSON.stringify({ wabaId: `waba_ycloud_old_${suffix}`, name }),
        name,
        ycloudId,
        JSON.stringify({ wabaId: `waba_ycloud_old_${suffix}`, name })
      ])
    }

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      const method = String(options.method || 'GET').toUpperCase()
      const body = options.body ? JSON.parse(options.body) : null
      requests.push({ method, path: requestUrl.pathname, body })

      if (method === 'GET' && requestUrl.pathname.endsWith(`/${wabaId}/message_templates`)) {
        return graphResponse({
          data: [{
            id: `meta_existing_${suffix}`,
            name: existingName,
            language: 'es_MX',
            category: 'UTILITY',
            status: 'APPROVED',
            components: [{ type: 'BODY', text: 'Hola desde YCloud' }]
          }],
          paging: {}
        })
      }

      if (method === 'POST' && requestUrl.pathname.endsWith(`/${wabaId}/message_templates`)) {
        if (body?.name === failingName) {
          return graphResponse({
            error: {
              message: 'Invalid custom template',
              code: 100,
              error_user_msg: 'El contenido necesita corrección.'
            }
          }, 400)
        }
        return graphResponse({
          id: `meta_${body.name}_${suffix}`,
          status: 'PENDING',
          category: body.category
        })
      }

      throw new Error(`Unexpected Meta migration request ${method} ${requestUrl.pathname}`)
    })

    try {
      const result = await reconcileMessageTemplatesForActiveProvider({
        publicBaseUrl: 'https://pagos.ristak.test'
      })

      assert.equal(result.skipped, false)
      assert.equal(result.adopted, 1)
      assert.equal(result.submitted, 1, JSON.stringify(result))
      assert.equal(result.failed, 1)
      assert.equal(requests.filter(request => request.method === 'POST' && request.body?.name === existingName).length, 0)
      assert.equal(requests.filter(request => request.method === 'POST' && request.body?.name === missingName).length, 1)
      assert.equal(requests.filter(request => request.method === 'POST' && request.body?.name === failingName).length, 1)

      const existing = await db.get(`
        SELECT template_provider, provider_template_id, provider_status,
          ycloud_template_id, ycloud_status
        FROM whatsapp_message_templates WHERE id = ?
      `, [candidateRows[0][0]])
      assert.deepEqual(existing, {
        template_provider: 'meta_direct',
        provider_template_id: `meta_existing_${suffix}`,
        provider_status: 'APPROVED',
        ycloud_template_id: `ycloud_existing_${suffix}`,
        ycloud_status: 'APPROVED'
      })

      const missing = await db.get(`
        SELECT template_provider, provider_template_id, provider_status,
          ycloud_template_id, ycloud_status
        FROM whatsapp_message_templates WHERE id = ?
      `, [candidateRows[1][0]])
      assert.equal(missing.template_provider, 'meta_direct')
      assert.equal(missing.provider_template_id, `meta_${missingName}_${suffix}`)
      assert.equal(missing.provider_status, 'PENDING')
      assert.equal(missing.ycloud_template_id, `ycloud_missing_${suffix}`)
      assert.equal(missing.ycloud_status, 'APPROVED')

      const failing = await db.get(`
        SELECT template_provider, provider_template_id, provider_status,
          ycloud_template_id, ycloud_status, last_error
        FROM whatsapp_message_templates WHERE id = ?
      `, [candidateRows[2][0]])
      assert.equal(failing.template_provider, 'meta_direct')
      assert.equal(failing.provider_template_id, null)
      assert.equal(failing.provider_status, null)
      assert.equal(failing.ycloud_template_id, `ycloud_failing_${suffix}`)
      assert.equal(failing.ycloud_status, 'APPROVED')
      assert.match(failing.last_error, /Invalid custom template/)
      assert.equal(
        await db.get('SELECT id FROM whatsapp_api_templates WHERE waba_id = ? AND name = ?', [wabaId, failingName]),
        null
      )

      const scheduledRequest = requests.find(request => (
        request.method === 'POST' && request.body?.name === 'cita_programada'
      ))
      assert.ok(scheduledRequest)
      const scheduledHeader = scheduledRequest.body.components.find(component => component.type === 'HEADER')
      assert.equal(scheduledHeader.text, 'Cita programada para el {{1}}')
      assert.equal(scheduledHeader.text.includes('🗓'), false)
    } finally {
      const candidateIds = candidateRows.map(([id]) => id)
      await db.run(
        `DELETE FROM whatsapp_message_templates WHERE id IN (${candidateIds.map(() => '?').join(', ')})`,
        candidateIds
      )
      await db.run('DELETE FROM whatsapp_api_templates WHERE waba_id = ?', [wabaId])
      await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
      await db.run(`
        DELETE FROM whatsapp_message_templates
        WHERE name IN (
          'cita_programada',
          'recordatorio_cita_una_hora_simple',
          'recordatorio_cita_un_dia_antes',
          'confirmacion_cita_dia_anterior',
          'recordatorio_pago_pendiente',
          'comprobante_pago_recibido',
          'pago_fallido_reintento'
        )
      `)
      await db.run(`
        DELETE FROM app_config
        WHERE config_key LIKE 'whatsapp_default_template_provider_revision_meta_direct_%'
      `)
    }
  })
})
