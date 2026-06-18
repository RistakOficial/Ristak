import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  createMessageTemplate,
  deleteMessageTemplate,
  getMessageTemplateBundle
} from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  getWhatsAppApiTemplates,
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

async function cleanupTemplate(name, language = 'es_MX') {
  await db.run('DELETE FROM whatsapp_message_templates WHERE name = ? AND language = ?', [name, language])
  await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_name = ? AND language = ?', [name, language])
  await db.run('DELETE FROM whatsapp_api_templates WHERE name = ? AND language = ?', [name, language])
}

async function createSyncedTemplate({ name, wabaId = 'waba_delete_templates_test', language = 'es_MX' }) {
  await cleanupTemplate(name, language)
  const template = await createMessageTemplate({
    name,
    language,
    category: 'utility',
    status: 'active',
    bodyText: 'Hola {{1}}, esta plantilla se puede borrar.',
    variableBindings: {
      headerText: {},
      bodyText: {
        1: {
          variableKey: 'contact.first_name',
          mergeField: '{{contact.first_name}}',
          label: 'Primer nombre',
          example: 'María'
        }
      }
    },
    ycloudTemplateId: `official_${name}`,
    ycloudStatus: 'APPROVED',
    ycloudRawPayload: { wabaId, name, language }
  })

  await db.run(`
    INSERT INTO whatsapp_api_templates (
      id, official_template_id, waba_id, name, language, category, status,
      components_json, raw_payload_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'UTILITY', 'APPROVED', ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(waba_id, name, language) DO UPDATE SET
      id = excluded.id,
      official_template_id = excluded.official_template_id,
      status = excluded.status,
      components_json = excluded.components_json,
      raw_payload_json = excluded.raw_payload_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    `api_${name}`,
    `official_${name}`,
    wabaId,
    name,
    language,
    JSON.stringify([{ type: 'BODY', text: 'Hola {{1}}, esta plantilla se puede borrar.' }]),
    JSON.stringify({ wabaId, name, language })
  ])

  return template
}

test('elimina plantilla en YCloud y limpia listas locales', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const captures = []
  const templateName = 'delete_template_remote_success'
  const wabaId = 'waba_delete_templates_test'

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_delete_templates_secret'))
    await setAppConfig(keys.wabaId, wabaId)

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      captures.push({ method, path })

      if (path === `/whatsapp/templates/${wabaId}/${templateName}/es_MX` && method === 'DELETE') {
        return ycloudJsonResponse({ deleted: true })
      }

      return ycloudJsonResponse({ error: { message: 'not found' } }, { status: 404, statusText: 'Not Found' })
    })

    try {
      const template = await createSyncedTemplate({ name: templateName, wabaId })
      const result = await deleteMessageTemplate(template.id)
      assert.equal(result.deleted, true)
      assert.equal(result.ycloud.deleted, true)
      assert.equal(result.snapshot.deleted, 1)
      assert.deepEqual(captures, [{
        method: 'DELETE',
        path: `/whatsapp/templates/${wabaId}/${templateName}/es_MX`
      }])

      const bundle = await getMessageTemplateBundle()
      assert.equal(bundle.templates.some((item) => item.name === templateName), false)
      const apiTemplates = await getWhatsAppApiTemplates()
      assert.equal(apiTemplates.items.some((item) => item.name === templateName), false)
    } finally {
      setYCloudFetchForTest(null)
      await cleanupTemplate(templateName)
    }
  })
})

test('limpia Ristak aunque YCloud responda 404 porque la plantilla ya no existe', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const templateName = 'delete_template_remote_missing'
  const wabaId = 'waba_delete_templates_test'

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_delete_templates_secret'))
    await setAppConfig(keys.wabaId, wabaId)

    setYCloudFetchForTest(async () => ycloudJsonResponse(
      { error: { message: 'template not found' } },
      { status: 404, statusText: 'Not Found' }
    ))

    try {
      const template = await createSyncedTemplate({ name: templateName, wabaId })
      const result = await deleteMessageTemplate(template.id)
      assert.equal(result.deleted, true)
      assert.equal(result.ycloud.deleted, false)
      assert.equal(result.ycloud.notFound, true)

      const local = await db.get(
        'SELECT id FROM whatsapp_message_templates WHERE name = ? AND language = ?',
        [templateName, 'es_MX']
      )
      const snapshot = await db.get(
        'SELECT id FROM whatsapp_api_templates WHERE name = ? AND language = ?',
        [templateName, 'es_MX']
      )
      assert.equal(local, null)
      assert.equal(snapshot, null)
    } finally {
      setYCloudFetchForTest(null)
      await cleanupTemplate(templateName)
    }
  })
})
