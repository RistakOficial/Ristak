import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  ensureDefaultAppointmentMessageTemplates,
  getMessageTemplateBundle
} from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'

const DEFAULT_TEMPLATE_NAMES = [
  'cita_programada',
  'recordatorio_cita_un_dia_antes',
  'confirmacion_cita_dia_anterior'
]
const DEFAULT_FOLDER_ID = 'Reminders'

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

async function deleteDefaultTemplates() {
  const placeholders = DEFAULT_TEMPLATE_NAMES.map(() => '?').join(', ')
  await db.run(`DELETE FROM whatsapp_message_templates WHERE name IN (${placeholders})`, DEFAULT_TEMPLATE_NAMES)
  await db.run(`DELETE FROM whatsapp_api_templates WHERE name IN (${placeholders})`, DEFAULT_TEMPLATE_NAMES)
  await db.run('DELETE FROM whatsapp_template_folders WHERE id = ?', [DEFAULT_FOLDER_ID])
}

test('crea plantillas default de citas y las manda a revisión una sola vez', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const captures = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await deleteDefaultTemplates()
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_default_templates_secret'))
    await setAppConfig(keys.wabaId, 'waba_default_templates_test')

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()

      if (path === '/whatsapp/templates' && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          id: `official_${body.name}`,
          wabaId: body.wabaId,
          name: body.name,
          language: body.language,
          category: body.category,
          status: 'PENDING',
          components: body.components
        })
      }

      return ycloudJsonResponse({ ok: true })
    })

    try {
      const firstRun = await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: true })
      assert.equal(firstRun.total, 3)
      assert.equal(firstRun.submitted, 3)
      assert.deepEqual(captures.map((capture) => capture.name).sort(), [...DEFAULT_TEMPLATE_NAMES].sort())

      const scheduledTemplate = captures.find((capture) => capture.name === 'cita_programada')
      assert.ok(scheduledTemplate)
      assert.equal(scheduledTemplate.components[0].type, 'HEADER')
      assert.equal(scheduledTemplate.components[0].text, '🗓️ Cita programada para {{1}}')
      assert.equal(scheduledTemplate.components[0].example.header_text[0], 'viernes, 19 de junio de 2026 9:00')
      assert.match(scheduledTemplate.components[1].text, /Te llegarán \*varios\* recordatorios/)

      const bundle = await getMessageTemplateBundle()
      const folder = bundle.folders.find((item) => item.id === DEFAULT_FOLDER_ID)
      assert.ok(folder)
      assert.equal(folder.name, 'Recordatorios')

      const localTemplate = bundle.templates.find((template) => template.name === 'recordatorio_cita_un_dia_antes')
      assert.ok(localTemplate)
      assert.equal(localTemplate.folderId, DEFAULT_FOLDER_ID)
      assert.equal(localTemplate.ycloudStatus, 'PENDING')
      assert.equal(localTemplate.footerText, 'Esto es un mensaje automático')
      assert.equal(localTemplate.variableBindings.bodyText['1'].variableKey, 'contact.first_name')
      assert.equal(localTemplate.variableBindings.bodyText['2'].variableKey, 'cita.fecha')
      assert.equal(localTemplate.variableBindings.bodyText['3'].variableKey, 'cita.hora')
      assert.ok(bundle.templates
        .filter((template) => DEFAULT_TEMPLATE_NAMES.includes(template.name))
        .every((template) => template.folderId === DEFAULT_FOLDER_ID))

      const apiTemplate = await db.get(
        'SELECT status, components_json FROM whatsapp_api_templates WHERE name = ? AND language = ?',
        ['confirmacion_cita_dia_anterior', 'es_MX']
      )
      assert.equal(apiTemplate.status, 'PENDING')
      const components = JSON.parse(apiTemplate.components_json)
      assert.deepEqual(components.map((component) => component.type), ['BODY', 'FOOTER'])

      const secondRun = await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: true })
      assert.equal(secondRun.submitted, 0)
      assert.equal(captures.length, 3)
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultTemplates()
    }
  })
})
