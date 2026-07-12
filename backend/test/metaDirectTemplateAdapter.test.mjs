import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMetaDirectTemplateCreatePayload,
  buildMetaDirectTemplateEditPayload,
  normalizeMetaDirectTemplateListResponse
} from '../src/services/whatsapp/providers/metaDirectTemplateAdapter.js'

test('Meta directo crea plantillas sin filtrar campos propios de YCloud', () => {
  const payload = buildMetaDirectTemplateCreatePayload({
    wabaId: 'waba_no_debe_ir_en_body',
    provider: 'meta_direct',
    name: 'recordatorio_cita',
    language: 'es_MX',
    category: 'utility',
    components: [{ type: 'BODY', text: 'Hola {{1}}', example: { body_text: [['Maria']] } }]
  })

  assert.deepEqual(payload, {
    name: 'recordatorio_cita',
    language: 'es_MX',
    category: 'UTILITY',
    components: [{ type: 'BODY', text: 'Hola {{1}}', example: { body_text: [['Maria']] } }]
  })
  assert.equal('wabaId' in payload, false)
  assert.equal('provider' in payload, false)
})

test('Meta directo edita por ID y usa nomenclatura Graph en el body', () => {
  const payload = buildMetaDirectTemplateEditPayload({
    components: [{ type: 'BODY', text: 'Texto actualizado' }],
    messageSendTtlSeconds: 3600,
    ctaUrlLinkTrackingOptedOut: true
  })

  assert.deepEqual(payload, {
    components: [{ type: 'BODY', text: 'Texto actualizado' }],
    cta_url_link_tracking_opted_out: true,
    message_send_ttl_seconds: 3600
  })
})

test('Meta directo no confunde header_url de YCloud con header_handle de Graph', () => {
  assert.throws(
    () => buildMetaDirectTemplateCreatePayload({
      name: 'plantilla_imagen',
      language: 'es_MX',
      category: 'MARKETING',
      components: [{
        type: 'HEADER',
        format: 'IMAGE',
        example: { header_url: ['https://cdn.example.com/imagen.jpg'] }
      }, { type: 'BODY', text: 'Oferta' }]
    }),
    (error) => error.code === 'META_TEMPLATE_HEADER_HANDLE_REQUIRED' && /header_handle/i.test(error.message)
  )

  const payload = buildMetaDirectTemplateCreatePayload({
    name: 'plantilla_imagen',
    language: 'es_MX',
    category: 'MARKETING',
    components: [{
      type: 'HEADER',
      format: 'IMAGE',
      example: { header_handle: ['4::handle_meta'] }
    }, { type: 'BODY', text: 'Oferta' }]
  })
  assert.deepEqual(payload.components[0].example.header_handle, ['4::handle_meta'])
})

test('normaliza la lista paginada de Graph sin inventar IDs YCloud', () => {
  const items = normalizeMetaDirectTemplateListResponse({
    data: [{
      id: 'meta_template_123',
      name: 'recordatorio_cita',
      language: 'es_MX',
      category: 'UTILITY',
      status: 'APPROVED',
      quality_score: { score: 'GREEN' },
      components: [{ type: 'BODY', text: 'Hola' }]
    }]
  }, { wabaId: 'waba_meta_123' })

  assert.equal(items[0].provider, 'meta_direct')
  assert.equal(items[0].providerTemplateId, 'meta_template_123')
  assert.equal(items[0].wabaId, 'waba_meta_123')
  assert.equal(items[0].qualityRating, 'GREEN')
})
