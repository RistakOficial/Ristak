import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  buildDefaultMessageTemplateSendComponents,
  ensureDefaultAppointmentMessageTemplates,
  ensureDefaultWhatsAppApiMessageTemplates,
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
const DEFAULT_PAYMENT_TEMPLATE_NAMES = [
  'recordatorio_pago_pendiente',
  'comprobante_pago_recibido',
  'pago_fallido_reintento'
]
const DEFAULT_PAYMENT_FOLDER_ID = 'Payments'

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
  const retryLikeClauses = DEFAULT_TEMPLATE_NAMES.map(() => 'name LIKE ?').join(' OR ')
  const retryLikeParams = DEFAULT_TEMPLATE_NAMES.map((name) => `${name}_r%`)
  const rows = await db.all(`SELECT id FROM whatsapp_message_templates WHERE name IN (${placeholders})`, DEFAULT_TEMPLATE_NAMES)
  const ids = rows.map(row => row.id).filter(Boolean)
  if (ids.length) {
    await db.run(
      `DELETE FROM whatsapp_api_alerts WHERE entity_id IN (${ids.map(() => '?').join(', ')})`,
      ids
    )
  }
  await db.run(`DELETE FROM whatsapp_message_templates WHERE name IN (${placeholders})`, DEFAULT_TEMPLATE_NAMES)
  await db.run(`
    DELETE FROM whatsapp_api_templates
    WHERE name IN (${placeholders})
      ${retryLikeClauses ? `OR ${retryLikeClauses}` : ''}
  `, [...DEFAULT_TEMPLATE_NAMES, ...retryLikeParams])
  await db.run('DELETE FROM whatsapp_template_folders WHERE id = ?', [DEFAULT_FOLDER_ID])
}

async function deleteDefaultPaymentTemplates() {
  const placeholders = DEFAULT_PAYMENT_TEMPLATE_NAMES.map(() => '?').join(', ')
  const rows = await db.all(`SELECT id FROM whatsapp_message_templates WHERE name IN (${placeholders})`, DEFAULT_PAYMENT_TEMPLATE_NAMES)
  const ids = rows.map(row => row.id).filter(Boolean)
  if (ids.length) {
    await db.run(
      `DELETE FROM whatsapp_api_alerts WHERE entity_id IN (${ids.map(() => '?').join(', ')})`,
      ids
    )
  }
  await db.run(`DELETE FROM whatsapp_message_templates WHERE name IN (${placeholders})`, DEFAULT_PAYMENT_TEMPLATE_NAMES)
  await db.run(`DELETE FROM whatsapp_api_templates WHERE name IN (${placeholders})`, DEFAULT_PAYMENT_TEMPLATE_NAMES)
  await db.run('DELETE FROM whatsapp_template_folders WHERE id = ?', [DEFAULT_PAYMENT_FOLDER_ID])
}

async function deleteAllDefaultTemplates() {
  await deleteDefaultTemplates()
  await deleteDefaultPaymentTemplates()
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
      assert.equal(scheduledTemplate.components[0].text, 'Cita agendada')
      assert.equal(scheduledTemplate.components[1].text, 'Hola {{1}}, tu cita quedó agendada para {{2}}. Te enviaremos recordatorios relacionados con esta cita.')
      assert.equal(scheduledTemplate.components[1].example.body_text[0][1], 'viernes, 19 de junio de 2026 9:00')
      assert.equal(scheduledTemplate.components[2].text, 'Esto es un mensaje automático.')

      const bundle = await getMessageTemplateBundle()
      const folder = bundle.folders.find((item) => item.id === DEFAULT_FOLDER_ID)
      assert.ok(folder)
      assert.equal(folder.name, 'Recordatorios')

      const localTemplate = bundle.templates.find((template) => template.name === 'recordatorio_cita_un_dia_antes')
      assert.ok(localTemplate)
      assert.equal(localTemplate.folderId, DEFAULT_FOLDER_ID)
      assert.equal(localTemplate.ycloudStatus, 'PENDING')
      assert.equal(localTemplate.footerText, 'Esto es un mensaje automático.')
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

test('crea plantillas default de pagos con botones dinamicos de pago y comprobante', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const captures = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await deleteAllDefaultTemplates()
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_payment_default_templates_secret'))
    await setAppConfig(keys.wabaId, 'waba_payment_default_templates_test')

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
      const result = await ensureDefaultWhatsAppApiMessageTemplates({
        submitToYCloud: true,
        publicBaseUrl: 'https://pagos.ristak.test'
      })
      assert.equal(result.total, 6)
      assert.equal(result.submitted, 6)

      const paymentCaptures = captures.filter((capture) => DEFAULT_PAYMENT_TEMPLATE_NAMES.includes(capture.name))
      assert.deepEqual(paymentCaptures.map((capture) => capture.name).sort(), [...DEFAULT_PAYMENT_TEMPLATE_NAMES].sort())

      const beforePayment = paymentCaptures.find((capture) => capture.name === 'recordatorio_pago_pendiente')
      assert.equal(beforePayment.components[0].text, 'Pago pendiente')
      assert.equal(beforePayment.components[1].text, 'Hola {{1}}, tienes pendiente el pago de {{2}} por {{3}}. Toca el botón para pagar de forma segura.')
      const beforeButtons = beforePayment.components.find((component) => component.type === 'BUTTONS').buttons
      assert.equal(beforeButtons[0].type, 'URL')
      assert.equal(beforeButtons[0].text, 'Pagar aquí')
      assert.equal(beforeButtons[0].url, 'https://pagos.ristak.test/pay/{{1}}')
      assert.deepEqual(beforeButtons[0].example, ['pay_3NfL8dZ9xQ2aB6mP'])

      const receiptTemplate = paymentCaptures.find((capture) => capture.name === 'comprobante_pago_recibido')
      const receiptButtons = receiptTemplate.components.find((component) => component.type === 'BUTTONS').buttons
      assert.equal(receiptButtons[0].text, 'Descargar comprobante')
      assert.equal(receiptButtons[0].url, 'https://pagos.ristak.test/pay/{{1}}')
      assert.deepEqual(receiptButtons[0].example, ['pay_3NfL8dZ9xQ2aB6mP?receipt=1'])

      const failedTemplate = paymentCaptures.find((capture) => capture.name === 'pago_fallido_reintento')
      const failedButtons = failedTemplate.components.find((component) => component.type === 'BUTTONS').buttons
      assert.equal(failedButtons[0].text, 'Intentar pago')
      assert.equal(failedButtons[0].url, 'https://pagos.ristak.test/pay/{{1}}')

      const bundle = await getMessageTemplateBundle()
      const folder = bundle.folders.find((item) => item.id === DEFAULT_PAYMENT_FOLDER_ID)
      assert.ok(folder)
      assert.equal(folder.name, 'Pagos')

      const localReceiptTemplate = bundle.templates.find((template) => template.name === 'comprobante_pago_recibido')
      assert.ok(localReceiptTemplate)
      assert.equal(localReceiptTemplate.folderId, DEFAULT_PAYMENT_FOLDER_ID)
      assert.equal(localReceiptTemplate.variableBindings.bodyText['1'].variableKey, 'contact.first_name')
      assert.equal(localReceiptTemplate.variableBindings.bodyText['2'].variableKey, 'payment.product')
      assert.equal(localReceiptTemplate.variableBindings.bodyText['3'].variableKey, 'payment.amount')
      assert.equal(localReceiptTemplate.variableBindings['buttons.0.value']['1'].variableKey, 'payment.receipt_path')

      const sendComponents = await buildDefaultMessageTemplateSendComponents({
        templateName: 'comprobante_pago_recibido',
        language: 'es_MX',
        variableOptions: {
          extraVariables: {
            'contact.first_name': 'Ana',
            'payment.product': 'Plan anual',
            'payment.amount': '$2,000 MXN',
            'payment.receipt_path': 'pay_test_123?receipt=1'
          }
        }
      })
      assert.deepEqual(sendComponents, [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: 'Plan anual' },
            { type: 'text', text: '$2,000 MXN' }
          ]
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            { type: 'text', text: 'pay_test_123?receipt=1' }
          ]
        }
      ])
    } finally {
      setYCloudFetchForTest(null)
      await deleteAllDefaultTemplates()
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
      assert.equal(scheduledTemplate.components[0].text, 'Cita agendada')
      assert.equal(scheduledTemplate.components[1].text, 'Hola {{1}}, tu cita quedó agendada para {{2}}. Te enviaremos recordatorios relacionados con esta cita.')
      const confirmationTemplate = captures.find((capture) => capture.name === 'confirmacion_cita_dia_anterior')
      assert.equal(confirmationTemplate.components[0].text, 'Hola {{1}}, tu cita es mañana a las {{2}}. Responde este mensaje para confirmar tu asistencia.')

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
  const retryName = `${targetName}_r1`
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
      assert.equal(requests[1].body.name, retryName)
      assert.equal(requests[1].body.components[1].text, 'Hola {{1}}, te recordamos tu cita de mañana {{2}} a las {{3}}. Responde si necesitas hacer algún cambio.')

      const row = await db.get(
        'SELECT name, ycloud_template_name, ycloud_status, ycloud_template_id, ycloud_review_retry_count, ycloud_review_retry_last_at FROM whatsapp_message_templates WHERE name = ?',
        [targetName]
      )
      assert.equal(row.name, targetName)
      assert.equal(row.ycloud_template_name, retryName)
      assert.equal(row.ycloud_status, 'PENDING')
      assert.equal(row.ycloud_template_id, `official_retry_${retryName}`)
      assert.equal(row.ycloud_review_retry_count, 1)
      assert.ok(row.ycloud_review_retry_last_at)
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultTemplates()
    }
  })
})

test('reintenta una plantilla default rechazada con nombre técnico nuevo sin duplicar la fila local', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const wabaId = 'waba_default_templates_rejected_retry_test'
  const targetName = 'confirmacion_cita_dia_anterior'
  const retryName = `${targetName}_r1`
  const requests = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await deleteDefaultTemplates()
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_default_templates_rejected_retry_secret'))
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
            ycloud_template_name = name,
            ycloud_submitted_at = datetime('now', '-1 hour')
        WHERE name IN ('cita_programada', 'recordatorio_cita_un_dia_antes')
      `)
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'REJECTED',
            ycloud_template_id = ?,
            ycloud_template_name = ?,
            ycloud_raw_payload_json = ?,
            ycloud_submitted_at = datetime('now', '-1 hour'),
            ycloud_review_retry_count = 0,
            ycloud_review_retry_last_at = NULL
        WHERE name = ?
      `, [
        `official_old_${targetName}`,
        targetName,
        JSON.stringify({ wabaId, name: targetName, language: 'es_MX', status: 'REJECTED' }),
        targetName
      ])

      const result = await repairDefaultAppointmentMessageTemplatesForCurrentConnection()
      const targetResult = result.templates.find((template) => template.name === targetName)
      assert.equal(result.submitted, 1)
      assert.equal(targetResult.retried, true)
      assert.equal(targetResult.reviewRetryCount, 1)
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.path}`),
        [
          `DELETE /whatsapp/templates/${wabaId}/${targetName}/es_MX`,
          'POST /whatsapp/templates'
        ]
      )
      assert.equal(requests[1].body.name, retryName)
      assert.equal(requests[1].body.components[0].text, 'Hola {{1}}, tu cita es mañana a las {{2}}. Responde este mensaje para confirmar tu asistencia.')
      assert.equal(requests[1].body.components[1].text, 'Esto es un mensaje automático.')

      const localRows = await db.all(
        'SELECT name, ycloud_template_name, ycloud_status, ycloud_template_id FROM whatsapp_message_templates WHERE name = ?',
        [targetName]
      )
      assert.equal(localRows.length, 1)
      assert.equal(localRows[0].ycloud_template_name, retryName)
      assert.equal(localRows[0].ycloud_status, 'PENDING')
      assert.equal(localRows[0].ycloud_template_id, `official_retry_${retryName}`)

      const apiTemplate = await db.get(
        'SELECT name, status FROM whatsapp_api_templates WHERE name = ? AND language = ?',
        [retryName, 'es_MX']
      )
      assert.equal(apiTemplate.name, retryName)
      assert.equal(apiTemplate.status, 'PENDING')
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
