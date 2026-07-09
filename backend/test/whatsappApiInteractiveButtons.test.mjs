import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  sendWhatsAppApiInteractiveMessage,
  sendWhatsAppApiTextMessage,
  sendWhatsAppApiTemplateMessage,
  setMetaDirectFetchForTest,
  setYCloudFetchForTest
} from '../src/services/whatsappApiService.js'
import {
  handleAutomationEvent,
  handleIncomingMessage
} from '../src/services/automationEngine.js'

function ycloudJsonResponse(body, { status = 200, statusText = 'OK' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
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

async function withYCloudMessageCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const businessPhone = '+526561234567'
  const phoneNumberId = 'phone_ycloud_buttons_test'
  const configKeys = [
    keys.enabled,
    keys.apiKey,
    keys.senderPhone,
    keys.phoneNumberId,
    keys.wabaId,
    keys.provider,
    keys.lastError
  ]
  const captures = []
  captures.openReplyWindow = async (phone, existingContactId = '') => {
    const now = new Date().toISOString()
    const suffix = String(phone || '').replace(/\D/g, '') || randomUUID().replace(/-/g, '')
    const contactId = existingContactId || `ycloud_buttons_contact_${suffix}`
    const messageId = `ycloud_buttons_inbound_${suffix}`

    if (!existingContactId) {
      await db.run(`
        INSERT INTO contacts (
          id, phone, full_name, first_name, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          phone = excluded.phone,
          updated_at = excluded.updated_at
      `, [
        contactId,
        phone,
        'Cliente Botones',
        'Cliente',
        'WhatsApp_API',
        now,
        now
      ])
    }

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, contact_id, phone, from_phone, to_phone,
        business_phone, business_phone_number_id, transport, direction, message_type,
        message_text, status, message_timestamp, created_at, updated_at
      ) VALUES (?, 'ycloud', ?, ?, ?, ?, ?, ?, ?, 'api', 'inbound', 'text', ?, 'received', ?, ?, ?)
    `, [
      messageId,
      messageId,
      contactId,
      phone,
      phone,
      businessPhone,
      businessPhone,
      phoneNumberId,
      'Respuesta reciente del cliente',
      now,
      now,
      now
    ])
  }

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.enabled, '1')
    await setAppConfig(keys.apiKey, encrypt('ycloud_test_secret'))
    await setAppConfig(keys.senderPhone, businessPhone)
    await setAppConfig(keys.phoneNumberId, phoneNumberId)
    await setAppConfig(keys.wabaId, 'waba_ycloud_buttons_test')
    await setAppConfig(keys.provider, 'ycloud')
    await setAppConfig(keys.lastError, '')

    setYCloudFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const path = parsed.pathname.replace(/^\/v2/, '')
      const method = String(options.method || 'GET').toUpperCase()
      if (path === '/whatsapp/messages' && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          id: `ycloud_msg_${captures.length}`,
          from: body.from,
          to: body.to,
          type: body.type,
          status: 'sent',
          [body.type]: body[body.type]
        })
      }
      return ycloudJsonResponse({ ok: true })
    })

    try {
      return await callback(captures)
    } finally {
      setYCloudFetchForTest(null)
    }
  })
}

async function withMetaDirectMessageCapture(callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken,
    keys.metaLastError
  ]
  const captures = []

  return snapshotAppConfig(configKeys, async () => {
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, 'waba_meta_direct_buttons_test')
    await setAppConfig(keys.metaPhoneNumberId, 'phone_meta_direct_buttons_test')
    await setAppConfig(keys.metaDisplayPhoneNumber, '+526561234567')
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta_direct_test_token'))
    await setAppConfig(keys.metaLastError, '')

    setMetaDirectFetchForTest(async (url, options = {}) => {
      const parsed = new URL(String(url))
      const method = String(options.method || 'GET').toUpperCase()
      if (parsed.pathname.endsWith('/phone_meta_direct_buttons_test/messages') && method === 'POST') {
        const body = JSON.parse(options.body || '{}')
        captures.push(body)
        return ycloudJsonResponse({
          messaging_product: 'whatsapp',
          contacts: [{ input: body.to, wa_id: body.to.replace(/\D/g, '') }],
          messages: [{ id: `wamid.meta_direct_${captures.length}` }]
        })
      }
      return ycloudJsonResponse({ ok: true })
    })

    try {
      return await callback(captures)
    } finally {
      setMetaDirectFetchForTest(null)
    }
  })
}

test('mensaje manual pedido por QR usa API oficial si la ventana de 24h sigue abierta', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const to = '+5215500012400'
    try {
      await captures.openReplyWindow(to)

      const result = await sendWhatsAppApiTextMessage({
        to,
        text: 'Seguimos por API',
        transport: 'qr',
        phoneNumberId: 'phone_ycloud_buttons_test',
        preferOfficialApiWhenReplyWindowOpen: true
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.equal(captures[0].text.body, 'Seguimos por API')
      assert.ok(result.localMessageId)

      const row = await db.get(
        `SELECT transport, message_text
         FROM whatsapp_api_messages
         WHERE id = ?`,
        [result.localMessageId]
      )
      assert.equal(row.transport, 'api')
      assert.equal(row.message_text, 'Seguimos por API')
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('envía botones interactivos de respuesta por YCloud', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const to = '+5215511112222'
    try {
      await captures.openReplyWindow(to)

      await sendWhatsAppApiInteractiveMessage({
        to,
        body: 'Elige una opción',
        buttons: [
          { id: 'interesado', title: 'Me interesa' },
          { id: 'despues', title: 'Luego' }
        ]
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'interactive')
      assert.equal(captures[0].interactive.type, 'button')
      assert.deepEqual(captures[0].interactive.action.buttons.map(button => button.reply), [
        { id: 'interesado', title: 'Me interesa' },
        { id: 'despues', title: 'Luego' }
      ])
    } finally {
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('agrega payloads a quick replies de plantillas al enviarlas por YCloud', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_buttons_${suffix}`
    const to = '+5215522223333'
    const components = [
      {
        type: 'BODY',
        text: 'Hola, elige una opción'
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Sí quiero' },
          { type: 'QUICK_REPLY', text: 'Después' }
        ]
      }
    ]

    try {
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          `official_${suffix}`,
          'waba_ycloud_buttons_test',
          `botones_${suffix.replace(/-/g, '_')}`,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )

      await sendWhatsAppApiTemplateMessage({
        to,
        templateId
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      const buttonComponents = captures[0].template.components.filter(component => component.type === 'button')
      assert.equal(buttonComponents.length, 2)
      assert.deepEqual(buttonComponents.map(component => component.sub_type), ['quick_reply', 'quick_reply'])
      assert.deepEqual(buttonComponents.map(component => component.index), ['0', '1'])
      assert.equal(buttonComponents.every(component => component.parameters?.[0]?.type === 'payload'), true)
      assert.equal(buttonComponents[0].parameters[0].payload.includes(':button:0:si_quiero'), true)
    } finally {
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE phone = ? OR to_phone = ?', [to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('guarda en el chat el texto renderizado de plantillas enviadas por YCloud', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_history_${suffix}`
    const templateName = `recordatorio_${suffix.replace(/-/g, '_')}`
    const to = `+52155${Date.now().toString().slice(-8)}`
    let ycloudMessageId = ''
    const components = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, tu cita es {{2}}.'
      },
      {
        type: 'FOOTER',
        text: 'Gracias'
      },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Confirmar' }
        ]
      }
    ]

    try {
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          `official_${suffix}`,
          'waba_ycloud_buttons_test',
          templateName,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )

      await sendWhatsAppApiTemplateMessage({
        to,
        templateId,
        variables: {
          1: 'Ana',
          2: 'mañana'
        }
      })
      assert.equal(captures.length, 1)
      ycloudMessageId = `ycloud_msg_${captures.length}`

      const row = await db.get(
        `SELECT message_type, message_text
         FROM whatsapp_api_messages
         WHERE ycloud_message_id = ?
         ORDER BY updated_at DESC
         LIMIT 1`,
        [ycloudMessageId]
      )

      assert.equal(row.message_type, 'template')
      assert.equal(row.message_text, 'Hola Ana, tu cita es mañana.\n\nGracias\n\n- Confirmar')
      assert.notEqual(row.message_text, templateName)

      const sendRow = await db.get(
        'SELECT raw_payload_json FROM whatsapp_api_template_sends WHERE template_id = ? LIMIT 1',
        [templateId]
      )
      const sendPayload = JSON.parse(sendRow.raw_payload_json)
      assert.equal(sendPayload.template.id, templateId)
      assert.equal(sendPayload.template.renderedText, row.message_text)
      assert.deepEqual(sendPayload.template.components, components)
    } finally {
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE ycloud_message_id = ? OR phone = ? OR to_phone = ?', [ycloudMessageId, to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('guarda en el chat el texto renderizado de plantillas enviadas por Meta Direct', async () => {
  await withMetaDirectMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_meta_history_${suffix}`
    const templateName = `seguimiento_meta_${suffix.replace(/-/g, '_')}`
    const to = `+52156${Date.now().toString().slice(-8)}`
    const components = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, tu pago de {{2}} está listo.'
      },
      {
        type: 'FOOTER',
        text: 'Gracias'
      }
    ]

    try {
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          `official_${suffix}`,
          'waba_meta_direct_buttons_test',
          templateName,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )

      await sendWhatsAppApiTemplateMessage({
        to,
        templateId,
        variables: {
          1: 'Ana',
          2: 'Plan mensual'
        }
      })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      assert.deepEqual(captures[0].template.components, [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Ana' },
            { type: 'text', text: 'Plan mensual' }
          ]
        }
      ])

      const row = await db.get(
        `SELECT provider, message_type, message_text, wamid, status
         FROM whatsapp_api_messages
         WHERE wamid = ?
         LIMIT 1`,
        ['wamid.meta_direct_1']
      )

      assert.equal(row.provider, 'meta_direct')
      assert.equal(row.message_type, 'template')
      assert.equal(row.message_text, 'Hola Ana, tu pago de Plan mensual está listo.\n\nGracias')
      assert.equal(row.status, 'sent')

      const sendRow = await db.get(
        'SELECT raw_payload_json FROM whatsapp_api_template_sends WHERE template_id = ? LIMIT 1',
        [templateId]
      )
      const sendPayload = JSON.parse(sendRow.raw_payload_json)
      assert.equal(sendPayload.request.provider, 'meta_direct')
      assert.equal(sendPayload.template.renderedText, row.message_text)
    } finally {
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ? OR phone = ? OR to_phone = ?', ['wamid.meta_direct_1', to, to])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [to])
      await db.run('DELETE FROM contacts WHERE phone = ?', [to])
    }
  })
})

test('automatización usa parámetros predeterminados de la plantilla y no variables editadas en el bloque', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const templateId = `template_automation_defaults_${suffix}`
    const templateName = `seguimiento_defaults_${suffix.replace(/-/g, '_')}`
    const contactId = `contact_template_defaults_${suffix}`
    const automationId = `automation_template_defaults_${suffix}`
    const phone = `+52157${Date.now().toString().slice(-8)}`
    const components = [
      {
        type: 'BODY',
        text: 'Hola {{1}}, ya tenemos tu información.'
      }
    ]
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
          id: 'send-whatsapp-template',
          type: 'channel-whatsapp',
          label: 'WhatsApp',
          config: {
            sender: 'default',
            messageType: 'template',
            templateId,
            templateName,
            messageBlocks: [
              {
                id: 'template-block',
                type: 'template',
                templateId,
                templateName,
                templateVariables: {
                  1: 'Valor viejo que ya no debe usarse'
                }
              }
            ]
          }
        }
      ],
      edges: [
        { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp-template' }
      ],
      settings: { allowReentry: true }
    }

    try {
      await db.run(
        `INSERT INTO whatsapp_message_templates (
          id, name, description, category, language, status,
          header_enabled, header_type, body_text, footer_text, buttons_json,
          variables_json, variable_examples_json, variable_bindings_json,
          ycloud_template_id, ycloud_status, ycloud_raw_payload_json,
          created_at, updated_at
        ) VALUES (?, ?, '', 'utility', 'es_MX', 'active', 0, 'none', ?, '', '[]', ?, ?, ?, ?, 'APPROVED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        `local_${templateId}`,
        templateName,
        'Hola {{1}}, ya tenemos tu información.',
        JSON.stringify(['{{1}}']),
        JSON.stringify({ '{{1}}': 'Ana' }),
        JSON.stringify({ bodyText: { 1: { variableKey: 'contact.first_name', mergeField: '{{contact.first_name}}', label: 'Nombre', example: 'Ana' } } }),
        templateId,
        JSON.stringify({ id: templateId, name: templateName, status: 'APPROVED' })
      ])
      await db.run(
        `INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
        ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
        [
          templateId,
          templateId,
          'waba_ycloud_buttons_test',
          templateName,
          'es_MX',
          JSON.stringify(components),
          JSON.stringify({ components })
        ]
      )
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, phone, `template-defaults-${suffix}@example.com`, 'Claudia Plantilla', 'Claudia', '{}']
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test plantilla WhatsApp defaults', JSON.stringify(flow), JSON.stringify(flow)]
      )

      await handleAutomationEvent('contact-created', { contactId })

      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'template')
      const bodyComponent = captures[0].template.components.find(component => component.type === 'body')
      assert.equal(bodyComponent.parameters[0].text, 'Claudia')
      assert.equal(JSON.stringify(captures[0]).includes('Valor viejo que ya no debe usarse'), false)

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'completed')
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_template_sends WHERE template_id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [templateId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ? OR to_phone = ?', [contactId, phone, phone])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
      await db.run('DELETE FROM whatsapp_message_templates WHERE id = ?', [`local_${templateId}`])
    }
  })
})

test('automatización de WhatsApp queda esperando botón y continúa por la salida elegida', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const contactId = `contact_button_wait_${suffix}`
    const automationId = `automation_button_wait_${suffix}`
    const phone = `+52155${Date.now().toString().slice(-8)}`
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
          id: 'send-whatsapp',
          type: 'channel-whatsapp',
          label: 'WhatsApp',
          config: {
            sender: 'default',
            messageType: 'text',
            messageBlocks: [
              {
                id: 'block-buttons',
                type: 'text',
                compiledText: '¿Te interesa?',
                buttons: [
                  { id: 'interesado', label: 'Me interesa', action: 'branch' },
                  { id: 'despues', label: 'Luego', action: 'branch' }
                ]
              }
            ]
          }
        },
        { id: 'done-interesado', type: 'extra-comment', label: 'Interesado', config: {} },
        { id: 'done-despues', type: 'extra-comment', label: 'Después', config: {} }
      ],
      edges: [
        { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp' },
        { id: 'edge-button-interesado', sourceNodeId: 'send-whatsapp', sourceHandle: 'btn_interesado', targetNodeId: 'done-interesado' },
        { id: 'edge-button-despues', sourceNodeId: 'send-whatsapp', sourceHandle: 'btn_despues', targetNodeId: 'done-despues' }
      ],
      settings: { allowReentry: true }
    }

    try {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, phone, `button-wait-${suffix}@example.com`, 'Contacto Botón', 'Contacto', '{}']
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test botón WhatsApp', JSON.stringify(flow), JSON.stringify(flow)]
      )
      await captures.openReplyWindow(phone, contactId)

      await handleAutomationEvent('contact-created', { contactId })

      let enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'waiting')
      assert.equal(enrollment.wait_kind, 'button_reply')
      assert.equal(enrollment.current_node_id, 'send-whatsapp')
      assert.deepEqual(JSON.parse(enrollment.context).waitButtons, [
        { id: 'interesado', label: 'Me interesa' },
        { id: 'despues', label: 'Luego' }
      ])
      assert.equal(captures[0].interactive.type, 'button')

      await handleIncomingMessage({
        contactId,
        phone,
        text: 'Me interesa',
        buttonId: 'interesado',
        buttonPayload: 'interesado',
        buttonTitle: 'Me interesa',
        buttonReplyType: 'button_reply',
        channel: 'whatsapp'
      })

      enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(enrollment.status, 'completed')
      assert.equal(enrollment.current_node_id, 'done-interesado')
      const log = JSON.parse(enrollment.log)
      assert.equal(log.some(entry => String(entry.detail || '').includes('Botón "Me interesa" recibido')), true)
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})

test('automatización con respaldo QR usa WhatsApp API primero cuando está disponible', async () => {
  await withYCloudMessageCapture(async (captures) => {
    const suffix = randomUUID()
    const contactId = `contact_qr_mode_${suffix}`
    const automationId = `automation_qr_mode_${suffix}`
    const phone = `+52156${Date.now().toString().slice(-8)}`
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
          id: 'send-whatsapp',
          type: 'channel-whatsapp',
          label: 'WhatsApp',
          config: {
            sender: 'default',
            messageType: 'text',
            sendViaQr: true,
            transport: 'qr',
            messageBlocks: [
              {
                id: 'block-text',
                type: 'text',
                compiledText: 'Hola por QR'
              }
            ]
          }
        }
      ],
      edges: [
        { id: 'edge-start-send', sourceNodeId: 'start', targetNodeId: 'send-whatsapp' }
      ],
      settings: { allowReentry: true }
    }

    try {
      await db.run(
        `INSERT INTO contacts (id, phone, email, full_name, first_name, custom_fields)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [contactId, phone, `qr-mode-${suffix}@example.com`, 'Contacto QR', 'Contacto', '{}']
      )
      await db.run(
        `INSERT INTO automations (id, name, status, flow, published_flow, published_at)
         VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP)`,
        [automationId, 'Test WhatsApp QR mode', JSON.stringify(flow), JSON.stringify(flow)]
      )
      await captures.openReplyWindow(phone, contactId)

      await handleAutomationEvent('contact-created', { contactId })

      const enrollment = await db.get(
        'SELECT * FROM automation_enrollments WHERE automation_id = ? AND contact_id = ?',
        [automationId, contactId]
      )
      assert.equal(captures.length, 1)
      assert.equal(captures[0].type, 'text')
      assert.equal(captures[0].text.body, 'Hola por QR')
      assert.equal(enrollment.status, 'completed')
      const log = JSON.parse(enrollment.log)
      assert.equal(log.some(entry => String(entry.detail || '').includes('WhatsApp API')), true)
      assert.equal(log.some(entry => String(entry.detail || '').includes('conectado por QR')), false)
    } finally {
      await db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [automationId])
      await db.run('DELETE FROM automations WHERE id = ?', [automationId])
      await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM whatsapp_api_contacts WHERE contact_id = ? OR phone = ?', [contactId, phone])
      await db.run('DELETE FROM contacts WHERE id = ?', [contactId])
    }
  })
})
