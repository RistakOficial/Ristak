import {
  WHATSAPP_PROVIDER_META_DIRECT,
  WHATSAPP_SOURCE_ADAPTER_META_DIRECT
} from './providerRegistry.js'

function cleanString(value) {
  return String(value || '').trim()
}

function cloneComponents(components = []) {
  return JSON.parse(JSON.stringify(Array.isArray(components) ? components : []))
}

function normalizeHeaderExamples(components = []) {
  return cloneComponents(components).map((component) => {
    if (cleanString(component?.type).toUpperCase() !== 'HEADER') return component
    if (!['IMAGE', 'VIDEO', 'DOCUMENT'].includes(cleanString(component?.format).toUpperCase())) return component

    const headerHandle = component?.example?.header_handle
    if (Array.isArray(headerHandle) && headerHandle.some(cleanString)) return component

    if (Array.isArray(component?.example?.header_url) && component.example.header_url.some(cleanString)) {
      const error = new Error(
        'Meta directo necesita un header_handle subido a Graph para revisar encabezados multimedia; una header_url de YCloud no es intercambiable.'
      )
      error.code = 'META_TEMPLATE_HEADER_HANDLE_REQUIRED'
      throw error
    }

    const error = new Error('Meta directo necesita un header_handle de ejemplo para el encabezado multimedia de la plantilla.')
    error.code = 'META_TEMPLATE_HEADER_HANDLE_REQUIRED'
    throw error
  })
}

export function buildMetaDirectTemplateCreatePayload(template = {}) {
  const name = cleanString(template.name)
  const language = cleanString(template.language)
  const category = cleanString(template.category).toUpperCase()
  const components = normalizeHeaderExamples(template.components)

  if (!name) throw new Error('Falta el nombre de la plantilla')
  if (!language) throw new Error('Falta el idioma de la plantilla')
  if (!category) throw new Error('Falta la categoría de la plantilla')
  if (!components.length) throw new Error('Faltan los componentes de la plantilla')

  return {
    name,
    language,
    category,
    components,
    ...(Number.isFinite(Number(template.messageSendTtlSeconds))
      ? { message_send_ttl_seconds: Number(template.messageSendTtlSeconds) }
      : {}),
    ...(typeof template.allowCategoryChange === 'boolean'
      ? { allow_category_change: template.allowCategoryChange }
      : {})
  }
}

export function buildMetaDirectTemplateEditPayload(template = {}) {
  const components = normalizeHeaderExamples(template.components)
  if (!components.length) throw new Error('Faltan los componentes de la plantilla')

  return {
    ...(cleanString(template.name) ? { name: cleanString(template.name) } : {}),
    components,
    ...(cleanString(template.category) ? { category: cleanString(template.category).toUpperCase() } : {}),
    ...(typeof template.ctaUrlLinkTrackingOptedOut === 'boolean'
      ? { cta_url_link_tracking_opted_out: template.ctaUrlLinkTrackingOptedOut }
      : {}),
    ...(Number.isFinite(Number(template.messageSendTtlSeconds))
      ? { message_send_ttl_seconds: Number(template.messageSendTtlSeconds) }
      : {})
  }
}

export function normalizeMetaDirectTemplateRecord(record = {}, { wabaId = '' } = {}) {
  const id = cleanString(record.id || record.officialTemplateId || record.providerTemplateId)
  const status = cleanString(record.status || record.event).toUpperCase()
  const language = cleanString(record.language || record.message_template_language)
  const name = cleanString(record.name || record.message_template_name)

  return {
    ...record,
    id,
    officialTemplateId: id,
    providerTemplateId: id,
    provider: WHATSAPP_PROVIDER_META_DIRECT,
    sourceAdapter: WHATSAPP_SOURCE_ADAPTER_META_DIRECT,
    wabaId: cleanString(record.wabaId || record.waba_id || wabaId),
    name,
    language,
    category: cleanString(record.category).toUpperCase(),
    status,
    qualityRating: cleanString(record.quality_score?.score || record.quality_rating || record.qualityRating).toUpperCase(),
    reason: cleanString(record.reason || record.rejection_reason),
    statusUpdateEvent: cleanString(record.statusUpdateEvent || record.event).toUpperCase(),
    components: Array.isArray(record.components) ? record.components : []
  }
}

export function normalizeMetaDirectTemplateListResponse(response = {}, options = {}) {
  const rows = Array.isArray(response?.data) ? response.data : []
  return rows.map((row) => normalizeMetaDirectTemplateRecord(row, options))
}
