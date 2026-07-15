import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  createMessageTemplate,
  createTemplateFolder,
  deleteTemplateFolder,
  submitMessageTemplateToActiveProvider,
  updateMessageTemplate
} from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => JSON.stringify(body)
  }
}

async function snapshotAppConfig(keys = [], callback) {
  const uniqueKeys = [...new Set(keys)]
  const placeholders = uniqueKeys.map(() => '?').join(', ')
  const previousRows = placeholders
    ? await db.all(
        `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
        uniqueKeys
      )
    : []

  try {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    return await callback()
  } finally {
    if (placeholders) {
      await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, uniqueKeys)
    }
    for (const row of previousRows) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET
          config_value = excluded.config_value,
          updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

function buildReviewableTemplatePayload(templateName, overrides = {}) {
  return {
    folderId: null,
    name: templateName,
    description: 'Plantilla editable',
    category: 'utility',
    language: 'es_MX',
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { latitude: '', longitude: '', name: '', address: '' },
    bodyText: 'Hola {{1}}, recibimos tu pago.',
    footerText: 'Mensaje automático de Ristak',
    buttons: [],
    variableExamples: {},
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'Maria'
        }
      }
    },
    ...overrides
  }
}

test('bloquea edición de plantillas en revisión y permite moverlas de carpeta', async () => {
  const suffix = Date.now()
  const templateName = `pending_review_lock_${suffix}`
  let folder = null

  const basePayload = {
    folderId: null,
    name: templateName,
    description: 'Plantilla pendiente de revisión',
    category: 'utility',
    language: 'es_MX',
    status: 'active',
    headerEnabled: false,
    headerType: 'none',
    headerText: '',
    headerMediaUrl: '',
    headerLocation: { latitude: '', longitude: '', name: '', address: '' },
    bodyText: 'Hola {{1}}, tu cita es mañana.',
    footerText: '',
    buttons: [],
    variableExamples: {},
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'Maria'
        }
      }
    },
    ycloudTemplateId: `official_${templateName}`,
    ycloudStatus: 'PENDING'
  }

  try {
    folder = await createTemplateFolder({ name: `Revision lock ${suffix}` })
    const template = await createMessageTemplate(basePayload)

    await assert.rejects(
      () => updateMessageTemplate(template.id, {
        ...basePayload,
        bodyText: 'Hola {{1}}, esta edición no debe pasar.'
      }),
      (error) => {
        assert.equal(error.statusCode, 409)
        assert.match(error.message, /en revisión/i)
        return true
      }
    )

    const moved = await updateMessageTemplate(template.id, {
      ...basePayload,
      folderId: folder.id
    })
    assert.equal(moved.folderId, folder.id)
    assert.equal(moved.bodyText, basePayload.bodyText)
    assert.equal(moved.ycloudStatus, 'PENDING')
  } finally {
    await db.run('DELETE FROM whatsapp_message_templates WHERE name = ?', [templateName])
    await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [templateName])
    if (folder) await deleteTemplateFolder(folder.id)
  }
})

test('rechaza enviar a revisión cuando una variable no tiene ejemplo para Meta', async () => {
  const suffix = Date.now()
  const templateName = `missing_meta_example_${suffix}`

  try {
    const template = await createMessageTemplate({
      folderId: null,
      name: templateName,
      description: 'Plantilla con ejemplo faltante',
      category: 'utility',
      language: 'es_MX',
      status: 'active',
      headerEnabled: false,
      headerType: 'none',
      headerText: '',
      headerMediaUrl: '',
      headerLocation: { latitude: '', longitude: '', name: '', address: '' },
      bodyText: 'Hola {{1}}, tu cita es mañana.',
      footerText: '',
      buttons: [],
      variableExamples: {},
      variableBindings: {
        headerText: {},
        bodyText: {
          1: {
            variableKey: 'contact.first_name',
            mergeField: '{{contact.first_name}}',
            label: 'Primer nombre',
            example: ''
          }
        }
      }
    })

    await assert.rejects(
      () => submitMessageTemplateToActiveProvider(template.id),
      /ejemplo que Meta revisara para \{\{1\}\} en el cuerpo/i
    )
  } finally {
    await db.run('DELETE FROM whatsapp_message_templates WHERE name = ?', [templateName])
    await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [templateName])
  }
})

test('edita en YCloud una plantilla existente en vez de crear otra con el mismo nombre', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const templateName = `edit_existing_template_${suffix}`
  const officialTemplateId = `official_${templateName}`
  const requests = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_edit_existing_secret'))
    await setAppConfig(keys.wabaId, 'waba_edit_existing_test')

    setYCloudFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      const body = options.body ? JSON.parse(options.body) : null
      requests.push({
        method: options.method || 'GET',
        path: requestUrl.pathname,
        body
      })

      if ((options.method || 'GET') !== 'PATCH') {
        return ycloudJsonResponse({ message: 'Expected PATCH for existing template' }, { status: 500, statusText: 'Unexpected method' })
      }

      return ycloudJsonResponse({ success: true })
    })

    try {
      const payload = buildReviewableTemplatePayload(templateName, {
        ycloudTemplateName: templateName,
        ycloudTemplateId: officialTemplateId,
        ycloudStatus: 'APPROVED'
      })
      const template = await createMessageTemplate(payload)
      const saved = await updateMessageTemplate(template.id, {
        ...payload,
        bodyText: 'Hola {{1}}, ya puedes descargar tu comprobante.'
      })
      const result = await submitMessageTemplateToActiveProvider(saved.id)

      assert.equal(requests.length, 1)
      assert.equal(requests[0].method, 'PATCH')
      assert.ok(requests[0].path.endsWith(`/whatsapp/templates/waba_edit_existing_test/${templateName}/es_MX`))
      assert.equal(requests[0].body.name, undefined)
      assert.equal(requests[0].body.language, undefined)
      assert.equal(requests[0].body.wabaId, undefined)
      assert.equal(requests[0].body.components.find((component) => component.type === 'BODY').text, 'Hola {{1}}, ya puedes descargar tu comprobante.')
      assert.equal(result.template.ycloudTemplateId, officialTemplateId)
      assert.equal(result.template.ycloudTemplateName, templateName)
      assert.equal(result.template.ycloudStatus, 'PENDING')
      assert.match(result.message, /actualizada/i)
    } finally {
      setYCloudFetchForTest(null)
      await db.run('DELETE FROM whatsapp_message_templates WHERE name = ?', [templateName])
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [templateName])
    }
  })
})

test('si YCloud dice que la plantilla ya existe, reintenta como edición por nombre e idioma', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const suffix = Date.now()
  const templateName = `fallback_existing_template_${suffix}`
  const requests = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_duplicate_fallback_secret'))
    await setAppConfig(keys.wabaId, 'waba_duplicate_fallback_test')

    setYCloudFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      const body = options.body ? JSON.parse(options.body) : null
      requests.push({
        method: options.method || 'GET',
        path: requestUrl.pathname,
        body
      })

      if ((options.method || 'GET') === 'POST') {
        return ycloudJsonResponse(
          { message: `A template with name ${templateName} and language es_MX in WABA waba_duplicate_fallback_test already exists.` },
          { status: 409, statusText: 'Conflict' }
        )
      }

      if ((options.method || 'GET') === 'PATCH') {
        return ycloudJsonResponse({ success: true })
      }

      return ycloudJsonResponse({ message: 'Unexpected method' }, { status: 500, statusText: 'Unexpected method' })
    })

    try {
      const template = await createMessageTemplate(buildReviewableTemplatePayload(templateName))
      const result = await submitMessageTemplateToActiveProvider(template.id)

      assert.deepEqual(requests.map((request) => request.method), ['POST', 'PATCH'])
      assert.ok(requests[0].path.endsWith('/whatsapp/templates'))
      assert.ok(requests[1].path.endsWith(`/whatsapp/templates/waba_duplicate_fallback_test/${templateName}/es_MX`))
      assert.equal(requests[1].body.components.find((component) => component.type === 'BODY').text, 'Hola {{1}}, recibimos tu pago.')
      assert.equal(result.template.ycloudTemplateName, templateName)
      assert.equal(result.template.ycloudStatus, 'PENDING')
      assert.match(result.message, /ya existía/i)
    } finally {
      setYCloudFetchForTest(null)
      await db.run('DELETE FROM whatsapp_message_templates WHERE name = ?', [templateName])
      await db.run('DELETE FROM whatsapp_api_templates WHERE name = ?', [templateName])
    }
  })
})
