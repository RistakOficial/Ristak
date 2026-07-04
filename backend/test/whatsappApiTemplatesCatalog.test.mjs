import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { db } from '../src/config/database.js'
import { getWhatsAppApiTemplates } from '../src/services/whatsappApiService.js'

test('getWhatsAppApiTemplates con status APPROVED excluye plantillas rechazadas', async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
  const wabaId = `waba_templates_filter_${suffix}`
  const approvedId = `wa_tpl_approved_${suffix}`
  const rejectedId = `wa_tpl_rejected_${suffix}`

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

  try {
    const result = await getWhatsAppApiTemplates({ status: 'APPROVED', limit: 200 })
    const ids = result.items.map((template) => template.id)

    assert.ok(ids.includes(approvedId))
    assert.equal(ids.includes(rejectedId), false)
  } finally {
    await db.run('DELETE FROM whatsapp_api_templates WHERE id IN (?, ?)', [approvedId, rejectedId])
  }
})
