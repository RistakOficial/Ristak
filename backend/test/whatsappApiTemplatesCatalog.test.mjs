import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db, getAppConfig, setAppConfig } from '../src/config/database.js'
import { encrypt, initializeMasterKey } from '../src/utils/encryption.js'
import { getWhatsAppApiConfigKeys, getWhatsAppApiTemplates } from '../src/services/whatsappApiService.js'

test('getWhatsAppApiTemplates con status APPROVED excluye plantillas rechazadas', async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const wabaId = `waba_templates_filter_${suffix}`
  const approvedId = `wa_tpl_approved_${suffix}`
  const rejectedId = `wa_tpl_rejected_${suffix}`
  const staleId = `wa_tpl_stale_${suffix}`
  const phoneId = `phone_templates_filter_${suffix}`
  const keys = getWhatsAppApiConfigKeys()
  const configKeys = [keys.enabled, keys.apiKey, keys.provider]
  const previousConfig = await Promise.all(configKeys.map(async key => [key, await getAppConfig(key)]))

  await initializeMasterKey()
  await setAppConfig(keys.enabled, '1')
  await setAppConfig(keys.apiKey, encrypt('catalog-test-token'))
  await setAppConfig(keys.provider, 'ycloud')
  await db.run(`
    INSERT INTO whatsapp_api_phone_numbers (
      id, provider, waba_id, phone_number, status, api_send_enabled, is_default_sender
    ) VALUES (?, 'ycloud', ?, '+526560000001', 'CONNECTED', 1, 1)
  `, [phoneId, wabaId])

  await db.run(
    `INSERT INTO whatsapp_api_templates (
      id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, 'APPROVED', ?, ?)`,
    [
      approvedId,
      `official_${approvedId}`,
      wabaId,
      `recordatorio_aprobado_${suffix}`,
      'es_MX',
      JSON.stringify([{ type: 'BODY', text: 'Hola, tu cita esta confirmada.' }]),
      '{}'
    ]
  )
  await db.run(
    `INSERT INTO whatsapp_api_templates (
      id, official_template_id, waba_id, name, language, status, reason, components_json, raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, 'REJECTED', ?, ?, ?)`,
    [
      rejectedId,
      `official_${rejectedId}`,
      wabaId,
      `recordatorio_rechazado_${suffix}`,
      'es_MX',
      'Contenido rechazado por Meta',
      JSON.stringify([{ type: 'BODY', text: 'Texto rechazado.' }]),
      '{}'
    ]
  )
  await db.run(
    `INSERT INTO whatsapp_api_templates (
      id, official_template_id, provider, source_adapter, waba_id, name, language,
      status, components_json, raw_payload_json
    ) VALUES (?, ?, 'ycloud', 'ycloud', ?, ?, 'es_MX', 'APPROVED', ?, '{}')`,
    [
      staleId,
      `official_${staleId}`,
      `waba_disconnected_${suffix}`,
      `plantilla_desconectada_${suffix}`,
      JSON.stringify([{ type: 'BODY', text: 'Esta plantilla ya no pertenece a una conexión activa.' }])
    ]
  )

  try {
    const result = await getWhatsAppApiTemplates({ status: 'APPROVED', limit: 200 })
    const ids = result.items.map((template) => template.id)

    assert.ok(ids.includes(approvedId))
    assert.equal(ids.includes(rejectedId), false)
    assert.equal(ids.includes(staleId), false)
    assert.equal(result.total, 2)
    assert.equal(result.approved, 1)
  } finally {
    await db.run('DELETE FROM whatsapp_api_templates WHERE id IN (?, ?, ?)', [approvedId, rejectedId, staleId])
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneId])
    for (const [key] of previousConfig) await db.run('DELETE FROM app_config WHERE config_key = ?', [key])
    for (const [key, value] of previousConfig) {
      if (value !== null && value !== undefined) await setAppConfig(key, value)
    }
  }
})
