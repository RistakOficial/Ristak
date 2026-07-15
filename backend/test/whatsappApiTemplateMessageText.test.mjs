import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import {
  getWhatsAppApiConfigKeys,
  processMetaDirectWebhookPayload,
  setMetaDirectFetchForTest
} from '../src/services/whatsappApiService.js'

function webhookEnvelope({
  wabaId,
  phoneNumberId,
  businessPhone,
  field = 'messages',
  messages = [],
  smbMessageEchoes = []
}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: wabaId,
      changes: [{
        field,
        value: {
          messaging_product: 'whatsapp',
          metadata: {
            display_phone_number: businessPhone,
            phone_number_id: phoneNumberId
          },
          messages,
          ...(smbMessageEchoes.length ? { smb_message_echoes: smbMessageEchoes } : {})
        }
      }]
    }]
  }
}

async function withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, callback) {
  await initializeMasterKey()
  const keys = getWhatsAppApiConfigKeys()
  const touchedKeys = [
    keys.provider,
    keys.metaStatus,
    keys.metaWabaId,
    keys.metaPhoneNumberId,
    keys.metaDisplayPhoneNumber,
    keys.metaSystemUserToken,
    keys.metaLastWebhookReceivedAt
  ]
  const placeholders = touchedKeys.map(() => '?').join(', ')
  const previous = await db.all(
    `SELECT config_key, config_value FROM app_config WHERE config_key IN (${placeholders})`,
    touchedKeys
  )

  try {
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, touchedKeys)
    await setAppConfig(keys.provider, 'meta_direct')
    await setAppConfig(keys.metaStatus, 'connected')
    await setAppConfig(keys.metaWabaId, wabaId)
    await setAppConfig(keys.metaPhoneNumberId, phoneNumberId)
    await setAppConfig(keys.metaDisplayPhoneNumber, businessPhone)
    await setAppConfig(keys.metaSystemUserToken, encrypt('meta-direct-template-text-token'))
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (
        id, provider, waba_id, phone_number, display_phone_number, verified_name,
        status, api_send_enabled, qr_send_enabled, qr_status, is_default_sender,
        created_at, updated_at
      ) VALUES (?, 'meta_direct', ?, ?, ?, 'Ristak Template Test', 'CONNECTED', 1, 0, 'disconnected', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [phoneNumberId, wabaId, businessPhone, businessPhone])

    return await callback()
  } finally {
    setMetaDirectFetchForTest(null)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
    await db.run(`DELETE FROM app_config WHERE config_key IN (${placeholders})`, touchedKeys)
    for (const row of previous) {
      await db.run(`
        INSERT INTO app_config (config_key, config_value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(config_key) DO UPDATE SET config_value = excluded.config_value, updated_at = CURRENT_TIMESTAMP
      `, [row.config_key, row.config_value])
    }
  }
}

async function insertTemplateSnapshot({ wabaId, name, language, bodyText }) {
  await db.run(`
    INSERT INTO whatsapp_api_templates (
      id, waba_id, name, language, status, components_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'APPROVED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(waba_id, name, language) DO UPDATE SET
      status = excluded.status,
      components_json = excluded.components_json,
      updated_at = CURRENT_TIMESTAMP
  `, [
    `tpl_${randomUUID()}`,
    wabaId,
    name,
    language,
    JSON.stringify([{ type: 'BODY', text: bodyText }])
  ])
}

test('la plantilla API guarda el mensaje renderizado, no el nombre interno', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_tpl_phone_${suffix}`
  const wabaId = `meta_tpl_waba_${suffix}`
  const businessPhone = `+1555${Date.now().toString().slice(-7)}`
  const customerPhone = `+5255${Date.now().toString().slice(-8)}`
  const outboundWamid = `wamid.meta.tpl.${suffix}`
  const templateName = 'recordatorio_cita_un_dia_antes'
  const language = 'es_MX'

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      await insertTemplateSnapshot({
        wabaId,
        name: templateName,
        language,
        bodyText: 'Hola {{1}}, te recordamos tu cita para mañana.'
      })

      const echoPayload = webhookEnvelope({
        wabaId,
        phoneNumberId,
        businessPhone,
        field: 'smb_message_echoes',
        smbMessageEchoes: [{
          id: outboundWamid,
          to: customerPhone,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'template',
          template: {
            name: templateName,
            language: { code: language },
            components: [{ type: 'body', parameters: [{ type: 'text', text: 'Juan' }] }]
          }
        }]
      })
      await processMetaDirectWebhookPayload({ payload: echoPayload, eventRowId: `evt-tpl-${suffix}` })

      const row = await db.get(
        'SELECT message_type, message_text FROM whatsapp_api_messages WHERE wamid = ?',
        [outboundWamid]
      )
      assert.ok(row)
      assert.equal(row.message_type, 'template')
      assert.equal(row.message_text, 'Hola Juan, te recordamos tu cita para mañana.')
      assert.notEqual(row.message_text, templateName)
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [outboundWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_templates WHERE waba_id = ?', [wabaId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [customerPhone.replace(/\D/g, '')]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE phone = ?', [customerPhone.replace(/\D/g, '')]).catch(() => undefined)
  }
})

test('un echo de plantilla sin parámetros no pisa el cuerpo ya guardado', async () => {
  const suffix = randomUUID()
  const phoneNumberId = `meta_tpl2_phone_${suffix}`
  const wabaId = `meta_tpl2_waba_${suffix}`
  const businessPhone = `+1555${Date.now().toString().slice(-7)}`
  const customerPhone = `+5255${Date.now().toString().slice(-8)}`
  const outboundWamid = `wamid.meta.tpl2.${suffix}`
  const templateName = 'recordatorio_cita_un_dia_antes'
  const language = 'es_MX'
  const renderedBody = 'Hola Maria, te recordamos tu cita para mañana.'

  try {
    await withMetaDirectConfig({ phoneNumberId, wabaId, businessPhone }, async () => {
      await insertTemplateSnapshot({
        wabaId,
        name: templateName,
        language,
        bodyText: 'Hola {{1}}, te recordamos tu cita para mañana.'
      })

      // Primer echo con parámetros: crea la fila con el cuerpo real renderizado.
      await processMetaDirectWebhookPayload({
        payload: webhookEnvelope({
          wabaId,
          phoneNumberId,
          businessPhone,
          field: 'smb_message_echoes',
          smbMessageEchoes: [{
            id: outboundWamid,
            to: customerPhone,
            timestamp: String(Math.floor(Date.now() / 1000)),
            type: 'template',
            template: {
              name: templateName,
              language: { code: language },
              components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }]
            }
          }]
        }),
        eventRowId: `evt-tpl2-a-${suffix}`
      })

      const afterFirst = await db.get(
        'SELECT message_text FROM whatsapp_api_messages WHERE wamid = ?',
        [outboundWamid]
      )
      assert.equal(afterFirst.message_text, renderedBody)

      // Segundo echo sin parámetros (solo el nombre): no debe sobrescribir el cuerpo.
      await processMetaDirectWebhookPayload({
        payload: webhookEnvelope({
          wabaId,
          phoneNumberId,
          businessPhone,
          field: 'smb_message_echoes',
          smbMessageEchoes: [{
            id: outboundWamid,
            to: customerPhone,
            timestamp: String(Math.floor(Date.now() / 1000) + 1),
            type: 'template',
            template: {
              name: templateName,
              language: { code: language }
            }
          }]
        }),
        eventRowId: `evt-tpl2-b-${suffix}`
      })

      const afterSecond = await db.get(
        'SELECT message_text FROM whatsapp_api_messages WHERE wamid = ?',
        [outboundWamid]
      )
      assert.equal(afterSecond.message_text, renderedBody)
      assert.notEqual(afterSecond.message_text, templateName)
    })
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE wamid = ?', [outboundWamid]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_templates WHERE waba_id = ?', [wabaId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', [customerPhone.replace(/\D/g, '')]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE phone = ?', [customerPhone.replace(/\D/g, '')]).catch(() => undefined)
  }
})
