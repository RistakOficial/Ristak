import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  ensureDefaultAppointmentMessageTemplates,
  getMessageTemplateBundle,
  repairDefaultAppointmentMessageTemplatesForCurrentConnection
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
  const rows = await db.all(`SELECT id FROM whatsapp_message_templates WHERE name IN (${placeholders})`, DEFAULT_TEMPLATE_NAMES)
  const ids = rows.map(row => row.id).filter(Boolean)
  if (ids.length) {
    await db.run(
      `DELETE FROM whatsapp_api_alerts WHERE entity_id IN (${ids.map(() => '?').join(', ')})`,
      ids
    )
  }
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
      const firstRun = await repairDefaultAppointmentMessageTemplatesForCurrentConnection()
      assert.equal(firstRun.total, 3)
      assert.equal(firstRun.submitted, 3)
      assert.deepEqual(captures.map((capture) => capture.name).sort(), [...DEFAULT_TEMPLATE_NAMES].sort())

      const scheduledTemplate = captures.find((capture) => capture.name === 'cita_programada')
      assert.ok(scheduledTemplate)
      assert.equal(scheduledTemplate.components[0].type, 'HEADER')
      assert.equal(scheduledTemplate.components[0].text, 'Cita programada para {{1}}')
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

test('repara defaults existentes sin enviar y manda solo los pendientes', async () => {
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
      await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: false })
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'APPROVED', ycloud_template_id = 'official_recordatorio_cita_un_dia_antes'
        WHERE name = 'recordatorio_cita_un_dia_antes'
      `)
      await db.run(`
        UPDATE whatsapp_message_templates
        SET header_text = '🗓️ Cita programada para {{1}}'
        WHERE name = 'cita_programada'
      `)
      await db.run(`
        UPDATE whatsapp_message_templates
        SET body_text = '{{1}}, solo para confirmar tu cita mañana a las {{2}}. ¿Confirmamos?'
        WHERE name = 'confirmacion_cita_dia_anterior'
      `)

      const result = await repairDefaultAppointmentMessageTemplatesForCurrentConnection()
      assert.equal(result.submitted, 2)
      assert.deepEqual(
        captures.map((capture) => capture.name).sort(),
        ['cita_programada', 'confirmacion_cita_dia_anterior']
      )

      const scheduledTemplate = captures.find((capture) => capture.name === 'cita_programada')
      assert.equal(scheduledTemplate.components[0].text, 'Cita programada para {{1}}')
      const confirmationTemplate = captures.find((capture) => capture.name === 'confirmacion_cita_dia_anterior')
      assert.equal(confirmationTemplate.components[0].text, 'Hola {{1}}, solo para confirmar tu cita mañana a las {{2}}. ¿Confirmamos?')

      const bundle = await getMessageTemplateBundle()
      const byName = new Map(bundle.templates.map((template) => [template.name, template]))
      assert.equal(byName.get('recordatorio_cita_un_dia_antes').ycloudStatus, 'APPROVED')
      assert.equal(byName.get('cita_programada').ycloudStatus, 'PENDING')
      assert.equal(byName.get('confirmacion_cita_dia_anterior').ycloudStatus, 'PENDING')
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultTemplates()
    }
  })
})

test('recrea una plantilla default atorada en revisión después de seis horas', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const wabaId = 'waba_default_templates_retry_test'
  const targetName = 'recordatorio_cita_un_dia_antes'
  const requests = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await deleteDefaultTemplates()
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_default_templates_retry_secret'))
    await setAppConfig(keys.wabaId, wabaId)

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      requests.push({ method, path, body: options.body ? JSON.parse(options.body) : null })

      if (path === `/whatsapp/templates/${wabaId}/${targetName}/es_MX` && method === 'DELETE') {
        return ycloudJsonResponse({ deleted: true })
      }

      if (path === '/whatsapp/templates' && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        return ycloudJsonResponse({
          id: `official_retry_${body.name}`,
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
      await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: false })
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'APPROVED',
            ycloud_template_id = 'official_' || name,
            ycloud_submitted_at = datetime('now', '-1 hour'),
            ycloud_review_retry_count = 0
        WHERE name IN ('cita_programada', 'confirmacion_cita_dia_anterior')
      `)
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'PENDING',
            ycloud_template_id = ?,
            ycloud_raw_payload_json = ?,
            ycloud_submitted_at = datetime('now', '-7 hours'),
            ycloud_review_retry_count = 0,
            ycloud_review_retry_last_at = NULL
        WHERE name = ?
      `, [
        `official_old_${targetName}`,
        JSON.stringify({ wabaId, name: targetName, language: 'es_MX' }),
        targetName
      ])

      const result = await repairDefaultAppointmentMessageTemplatesForCurrentConnection()
      const targetResult = result.templates.find((template) => template.name === targetName)
      assert.equal(result.submitted, 1)
      assert.equal(targetResult.retried, true)
      assert.equal(targetResult.retryAlerted, false)
      assert.equal(targetResult.reviewRetryCount, 1)
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.path}`),
        [
          `DELETE /whatsapp/templates/${wabaId}/${targetName}/es_MX`,
          'POST /whatsapp/templates'
        ]
      )
      assert.equal(requests[1].body.name, targetName)

      const row = await db.get(
        'SELECT ycloud_status, ycloud_template_id, ycloud_review_retry_count, ycloud_review_retry_last_at FROM whatsapp_message_templates WHERE name = ?',
        [targetName]
      )
      assert.equal(row.ycloud_status, 'PENDING')
      assert.equal(row.ycloud_template_id, `official_retry_${targetName}`)
      assert.equal(row.ycloud_review_retry_count, 1)
      assert.ok(row.ycloud_review_retry_last_at)
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultTemplates()
    }
  })
})

test('crea alerta y no reintenta cuando la plantilla default ya agotó dos reintentos', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const wabaId = 'waba_default_templates_retry_exhausted_test'
  const targetName = 'recordatorio_cita_un_dia_antes'
  const requests = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await deleteDefaultTemplates()
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_default_templates_retry_exhausted_secret'))
    await setAppConfig(keys.wabaId, wabaId)

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      requests.push({ method, path })
      return ycloudJsonResponse({ ok: true })
    })

    try {
      await ensureDefaultAppointmentMessageTemplates({ submitToYCloud: false })
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'APPROVED',
            ycloud_template_id = 'official_' || name,
            ycloud_submitted_at = datetime('now', '-1 hour')
        WHERE name IN ('cita_programada', 'confirmacion_cita_dia_anterior')
      `)
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'PENDING',
            ycloud_template_id = ?,
            ycloud_raw_payload_json = ?,
            ycloud_submitted_at = datetime('now', '-7 hours'),
            ycloud_review_retry_count = 2,
            ycloud_review_retry_last_at = datetime('now', '-7 hours')
        WHERE name = ?
      `, [
        `official_old_${targetName}`,
        JSON.stringify({ wabaId, name: targetName, language: 'es_MX' }),
        targetName
      ])

      const result = await repairDefaultAppointmentMessageTemplatesForCurrentConnection()
      const targetResult = result.templates.find((template) => template.name === targetName)
      assert.equal(result.submitted, 0)
      assert.equal(targetResult.retried, false)
      assert.equal(targetResult.retryAlerted, true)
      assert.deepEqual(requests, [])

      const target = await db.get('SELECT id FROM whatsapp_message_templates WHERE name = ?', [targetName])
      const alert = await db.get(`
        SELECT severity, alert_type, title, message, entity_type, entity_id, status
        FROM whatsapp_api_alerts
        WHERE alert_type = 'template_review_retry_exhausted'
          AND entity_id = ?
      `, [target.id])
      assert.equal(alert.status, 'active')
      assert.equal(alert.severity, 'warning')
      assert.equal(alert.entity_type, 'template')
      assert.match(alert.title, /Plantilla de recordatorio/)
      assert.match(alert.message, /2 reintentos/)
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultTemplates()
    }
  })
})
