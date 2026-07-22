import test from 'node:test'
import assert from 'node:assert/strict'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  buildDefaultMessageTemplateSendComponents,
  ensureDefaultAppointmentMessageTemplates,
  ensureDefaultPaymentMessageTemplates,
  ensureDefaultWhatsAppApiMessageTemplates,
  getMessageTemplateBundle,
  repairDefaultAppointmentMessageTemplatesForCurrentConnection
} from '../src/services/messageTemplatesService.js'
import {
  getWhatsAppApiConfigKeys,
  setMetaDirectFetchForTest,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'

const DEFAULT_TEMPLATE_NAMES = [
  'cita_programada',
  'recordatorio_cita_un_dia_antes',
  'confirmacion_cita_dia_anterior'
]
const DEFAULT_FOLDER_ID = 'Reminders'
const SCHEDULED_APPOINTMENT_BODY = 'Hola {{1}}.\n\nTu cita quedó agendada correctamente para la fecha y hora indicadas. Te esperamos. Si necesitas hacer algún cambio, avísanos con anticipación.\n\n¡Gracias!'
const ONE_DAY_REMINDER_BODY = '*Recordatorio de cita* ⏰\nHola {{1}}, te recordamos que tienes una cita el {{2}} a las {{3}}. Recuerda estar al pendiente. 😄'
const APPOINTMENT_CONFIRMATION_BODY = 'Hola {{1}}, queremos confirmar tu asistencia a la cita del {{2}} a las {{3}}. ¿Nos confirmas, por favor?'
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

function graphJsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
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
      assert.equal(scheduledTemplate.components[0].text, 'Cita programada para {{1}}')
      assert.equal(scheduledTemplate.components[0].example.header_text[0], 'viernes, 19 de junio de 2026 9:00')
      assert.equal(scheduledTemplate.components[1].text, SCHEDULED_APPOINTMENT_BODY)
      assert.deepEqual(scheduledTemplate.components.map((component) => component.type), ['HEADER', 'BODY'])

      const reminderTemplate = captures.find((capture) => capture.name === 'recordatorio_cita_un_dia_antes')
      assert.equal(reminderTemplate.components[0].text, ONE_DAY_REMINDER_BODY)
      const confirmationTemplate = captures.find((capture) => capture.name === 'confirmacion_cita_dia_anterior')
      assert.equal(confirmationTemplate.components[0].text, APPOINTMENT_CONFIRMATION_BODY)

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
      const localConfirmation = bundle.templates.find((template) => template.name === 'confirmacion_cita_dia_anterior')
      assert.equal(localConfirmation.variableBindings.bodyText['2'].variableKey, 'cita.fecha')
      assert.equal(localConfirmation.variableBindings.bodyText['3'].variableKey, 'cita.hora')
      assert.ok(bundle.templates
        .filter((template) => DEFAULT_TEMPLATE_NAMES.includes(template.name))
        .every((template) => template.folderId === DEFAULT_FOLDER_ID))

      const apiTemplate = await db.get(
        'SELECT status, components_json FROM whatsapp_api_templates WHERE name = ? AND language = ?',
        ['confirmacion_cita_dia_anterior', 'es_MX']
      )
      assert.equal(apiTemplate.status, 'PENDING')
      const components = JSON.parse(apiTemplate.components_json)
      assert.deepEqual(components.map((component) => component.type), ['BODY'])

      const secondRun = await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: true })
      assert.equal(secondRun.submitted, 0)
      assert.equal(captures.length, 3)
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultTemplates()
    }
  })
})

test('Meta directo envía las seis plantillas aunque exista identidad previa de YCloud', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const wabaId = `waba_meta_defaults_${Date.now()}`
  const captures = []

  await snapshotAppConfig([
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaSystemUserToken
  ], async () => {
    await deleteAllDefaultTemplates()
    await setAppConfig(keys.provider, 'ycloud')
    await ensureDefaultWhatsAppApiMessageTemplates({
      submitToActiveProvider: false,
      publicBaseUrl: 'https://pagos.ristak.test'
    })
    await db.run(`
      UPDATE whatsapp_message_templates
      SET template_provider = 'ycloud',
          provider_template_id = 'ycloud_' || name,
          provider_template_name = name,
          provider_status = 'APPROVED',
          ycloud_template_id = 'ycloud_' || name,
          ycloud_template_name = name,
          ycloud_status = 'APPROVED'
      WHERE name IN (${[...DEFAULT_TEMPLATE_NAMES, ...DEFAULT_PAYMENT_TEMPLATE_NAMES].map(() => '?').join(', ')})
    `, [...DEFAULT_TEMPLATE_NAMES, ...DEFAULT_PAYMENT_TEMPLATE_NAMES])

    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, wabaId)
    await setAppConfig(keys.metaPhoneNumberId, `phone_meta_defaults_${Date.now()}`)
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_defaults_test_token'))

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const requestUrl = new URL(url)
      const method = String(options.method || 'GET').toUpperCase()
      const body = options.body ? JSON.parse(options.body) : null
      captures.push({ method, path: requestUrl.pathname, body })
      return graphJsonResponse({
        id: `meta_${body?.name || captures.length}`,
        status: 'PENDING',
        category: body?.category || 'UTILITY'
      })
    })

    try {
      const result = await ensureDefaultWhatsAppApiMessageTemplates({
        submitToActiveProvider: true,
        publicBaseUrl: 'https://pagos.ristak.test'
      })

      assert.equal(result.total, 6)
      assert.equal(result.submitted, 6)
      assert.equal(result.errors, 0)
      assert.ok(result.templates.every(template => template.provider === 'meta_direct'))
      assert.ok(result.templates.every(template => template.providerStatus === 'PENDING'))
      assert.equal(captures.length, 6)
      assert.ok(captures.every(request => request.method === 'POST'))
      assert.ok(captures.every(request => request.path.endsWith(`/${wabaId}/message_templates`)))
      assert.ok(captures.every(request => !Object.hasOwn(request.body || {}, 'wabaId')))

      const stored = await db.all(`
        SELECT template_provider, provider_status, provider_template_id, ycloud_status, ycloud_template_id
        FROM whatsapp_message_templates
        WHERE name IN (${[...DEFAULT_TEMPLATE_NAMES, ...DEFAULT_PAYMENT_TEMPLATE_NAMES].map(() => '?').join(', ')})
      `, [...DEFAULT_TEMPLATE_NAMES, ...DEFAULT_PAYMENT_TEMPLATE_NAMES])
      assert.equal(stored.length, 6)
      assert.ok(stored.every(template => template.template_provider === 'meta_direct'))
      assert.ok(stored.every(template => template.provider_status === 'PENDING'))
      assert.ok(stored.every(template => String(template.provider_template_id || '').startsWith('meta_')))
      assert.ok(stored.every(template => template.ycloud_status === 'APPROVED'))
      assert.ok(stored.every(template => String(template.ycloud_template_id || '').startsWith('ycloud_')))
    } finally {
      setMetaDirectFetchForTest(null)
      await deleteAllDefaultTemplates()
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
        submitToActiveProvider: true,
        publicBaseUrl: 'https://pagos.ristak.test'
      })
      assert.equal(result.total, 6)
      assert.equal(result.submitted, 6)

      const paymentCaptures = captures.filter((capture) => DEFAULT_PAYMENT_TEMPLATE_NAMES.includes(capture.name))
      assert.deepEqual(paymentCaptures.map((capture) => capture.name).sort(), [...DEFAULT_PAYMENT_TEMPLATE_NAMES].sort())

      const beforePayment = paymentCaptures.find((capture) => capture.name === 'recordatorio_pago_pendiente')
      assert.equal(beforePayment.components[0].type, 'BODY')
      assert.equal(beforePayment.components[0].text, '*Pago pendiente* ⏳\nHola {{1}}, tienes pendiente el pago de {{2}} por {{3}}. Toca el botón para realizarlo. 👇')
      assert.equal(beforePayment.components[1].text, 'Mensaje automático de Ristak')
      const beforeButtons = beforePayment.components.find((component) => component.type === 'BUTTONS').buttons
      assert.equal(beforeButtons[0].type, 'URL')
      assert.equal(beforeButtons[0].text, 'Realizar pago')
      assert.equal(beforeButtons[0].url, 'https://pagos.ristak.test/pay/{{1}}')
      assert.deepEqual(beforeButtons[0].example, ['pay_3NfL8dZ9xQ2aB6mP'])

      const receiptTemplate = paymentCaptures.find((capture) => capture.name === 'comprobante_pago_recibido')
      assert.equal(receiptTemplate.components[0].text, '*Pago confirmado* ✅ \nHola {{1}}, recibimos tu pago de {{2}} por {{3}}. Gracias. Puedes descargar tu comprobante desde el botón. 👇')
      const receiptButtons = receiptTemplate.components.find((component) => component.type === 'BUTTONS').buttons
      assert.equal(receiptButtons[0].text, 'Descargar comprobante')
      assert.equal(receiptButtons[0].url, 'https://pagos.ristak.test/pay/{{1}}')
      assert.deepEqual(receiptButtons[0].example, ['pay_3NfL8dZ9xQ2aB6mP?receipt=1'])

      const failedTemplate = paymentCaptures.find((capture) => capture.name === 'pago_fallido_reintento')
      assert.equal(failedTemplate.components[0].text, '❌ *Cobro fallido*\nHola {{1}}, no pudimos procesar tu pago de {{2}} por {{3}}. Puedes intentar nuevamente desde el botón.')
      const failedButtons = failedTemplate.components.find((component) => component.type === 'BUTTONS').buttons
      assert.equal(failedButtons[0].text, 'Reintentar pago')
      assert.equal(failedButtons[0].url, 'https://pagos.ristak.test/pay/{{1}}')
      assert.deepEqual(failedButtons[0].example, ['pay_3NfL8dZ9xQ2aB6mP'])

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

test('arma parámetros de pago fallido aunque falte el snapshot local de la plantilla', async () => {
  await deleteDefaultPaymentTemplates()

  try {
    const sendComponents = await buildDefaultMessageTemplateSendComponents({
      templateName: 'pago_fallido_reintento',
      language: 'es_MX',
      variableOptions: {
        publicBaseUrl: 'https://pagos.ristak.test',
        extraVariables: {
          'contact.first_name': 'Luis',
          'payment.product': 'Plan mensual',
          'payment.amount': '$1,499 MXN',
          'payment.public_id': 'rstk_pay_reintento_123',
          'payment.url': 'https://pagos.ristak.test/pay/rstk_pay_reintento_123'
        }
      }
    })

    assert.deepEqual(sendComponents, [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Luis' },
          { type: 'text', text: 'Plan mensual' },
          { type: 'text', text: '$1,499 MXN' }
        ]
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [
          { type: 'text', text: 'rstk_pay_reintento_123' }
        ]
      }
    ])
  } finally {
    await deleteDefaultPaymentTemplates()
  }
})

test('backfill actualiza pago fallido aprobado con binding dinamico del boton y sin doble renglon', async () => {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const wabaId = 'waba_payment_default_backfill_test'
  const requests = []

  await snapshotAppConfig([keys.enabled, keys.apiKey, keys.wabaId], async () => {
    await deleteDefaultPaymentTemplates()
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_payment_default_backfill_secret'))
    await setAppConfig(keys.wabaId, wabaId)

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      requests.push({ method, path, body: options.body ? JSON.parse(options.body) : null })

      if (path === `/whatsapp/templates/${wabaId}/pago_fallido_reintento/es_MX` && method === 'PATCH') {
        const body = JSON.parse(options.body || '{}')
        return ycloudJsonResponse({
          id: 'official_payout_failed_backfill',
          officialTemplateId: 'official_payout_failed_backfill',
          wabaId,
          name: 'pago_fallido_reintento',
          language: 'es_MX',
          category: 'UTILITY',
          status: 'PENDING',
          components: body.components
        })
      }

      return ycloudJsonResponse({ ok: true })
    })

    try {
      await ensureDefaultPaymentMessageTemplates({
        submitToActiveProvider: false,
        publicBaseUrl: 'https://pagos.ristak.test'
      })
      await db.run(`
        UPDATE whatsapp_message_templates
        SET ycloud_status = 'APPROVED',
            ycloud_template_id = 'official_' || name,
            ycloud_template_name = name,
            ycloud_raw_payload_json = ?
        WHERE name IN ('recordatorio_pago_pendiente', 'comprobante_pago_recibido', 'pago_fallido_reintento')
      `, [JSON.stringify({ wabaId, status: 'APPROVED' })])
      await db.run(`
        UPDATE whatsapp_message_templates
        SET body_text = ?,
            buttons_json = ?,
            variable_bindings_json = ?
        WHERE name = 'pago_fallido_reintento'
      `, [
        '❌ *Cobro fallido* \n\nHola {{1}}, no pudimos procesar tu pago de {{2}} por {{3}}. Puedes intentar nuevamente desde el botón.',
        JSON.stringify([{
          id: 'tmpl_btn_failed_without_binding',
          type: 'website',
          label: 'Reintentar pago',
          value: 'https://pagos.ristak.test/pay/{{1}}'
        }]),
        JSON.stringify({
          headerText: {},
          bodyText: {
            1: {
              variableKey: 'contact.first_name',
              mergeField: '{{contact.first_name}}',
              label: 'Primer nombre',
              example: 'Raúl'
            },
            2: {
              variableKey: 'payment.product',
              mergeField: '{{payment.product}}',
              label: 'Concepto del pago',
              example: 'Plan mensual'
            },
            3: {
              variableKey: 'payment.amount',
              mergeField: '{{payment.amount}}',
              label: 'Monto del pago',
              example: '$1,499 MXN'
            }
          }
        })
      ])

      const result = await ensureDefaultPaymentMessageTemplates({
        submitToActiveProvider: true,
        publicBaseUrl: 'https://pagos.ristak.test'
      })

      assert.equal(result.submitted, 1)
      assert.deepEqual(
        requests.map((request) => `${request.method} ${request.path}`),
        [`PATCH /whatsapp/templates/${wabaId}/pago_fallido_reintento/es_MX`]
      )
      const failedBody = requests[0].body.components.find((component) => component.type === 'BODY')
      assert.equal(failedBody.text, '❌ *Cobro fallido*\nHola {{1}}, no pudimos procesar tu pago de {{2}} por {{3}}. Puedes intentar nuevamente desde el botón.')
      const failedButton = requests[0].body.components.find((component) => component.type === 'BUTTONS').buttons[0]
      assert.equal(failedButton.text, 'Reintentar pago')
      assert.equal(failedButton.url, 'https://pagos.ristak.test/pay/{{1}}')
      assert.deepEqual(failedButton.example, ['pay_3NfL8dZ9xQ2aB6mP'])

      const stored = await db.get(`
        SELECT body_text, variable_bindings_json, ycloud_status
        FROM whatsapp_message_templates
        WHERE name = 'pago_fallido_reintento'
      `)
      assert.equal(stored.body_text.includes('\n\n'), false)
      assert.equal(stored.ycloud_status, 'PENDING')
      const bindings = JSON.parse(stored.variable_bindings_json)
      assert.equal(bindings['buttons.0.value']['1'].variableKey, 'payment.public_id')
    } finally {
      setYCloudFetchForTest(null)
      await deleteDefaultPaymentTemplates()
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
      await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
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
      assert.equal(scheduledTemplate.components[1].text, SCHEDULED_APPOINTMENT_BODY)
      const confirmationTemplate = captures.find((capture) => capture.name === 'confirmacion_cita_dia_anterior')
      assert.equal(confirmationTemplate.components[0].text, APPOINTMENT_CONFIRMATION_BODY)

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
      await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
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
      assert.equal(requests[1].body.components[0].text, ONE_DAY_REMINDER_BODY)

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
      await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
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
      assert.equal(requests[1].body.components[0].text, APPOINTMENT_CONFIRMATION_BODY)
      assert.equal(requests[1].body.components.length, 1)

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
      await ensureDefaultAppointmentMessageTemplates({ submitToActiveProvider: false })
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
