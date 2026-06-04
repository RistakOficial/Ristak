import crypto from 'crypto'
import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { getAIAgentConfig, getOpenAIApiKey } from './aiAgentService.js'
import {
  finalizePreparedPhoneUpsert,
  findContactByPhoneCandidates,
  prepareContactPhoneUpsert
} from './contactIdentityService.js'
import { getMetaConfig } from './metaAdsService.js'

export const SITE_TYPES = new Set(['standard_form', 'interactive_form', 'landing_page'])
export const SITE_STATUSES = new Set(['draft', 'published', 'archived'])
export const CONTENT_BLOCK_TYPES = new Set([
  'headline',
  'subheading',
  'title',
  'subtitle',
  'description',
  'text',
  'embed',
  'hero',
  'image',
  'video',
  'button',
  'benefits',
  'testimonials',
  'services',
  'form_embed',
  'faq',
  'cta'
])
export const FIELD_BLOCK_TYPES = new Set([
  'short_text',
  'paragraph',
  'currency',
  'number',
  'dropdown',
  'radio',
  'checkboxes',
  'phone',
  'email',
  'date'
])
export const BLOCK_TYPES = new Set([...CONTENT_BLOCK_TYPES, ...FIELD_BLOCK_TYPES])
export const OPTION_ACTIONS = new Set([
  'continue',
  'cold_lead',
  'warm_lead',
  'hot_lead',
  'disqualify',
  'show_message',
  'end_form',
  'jump',
  'tag',
  'category'
])

const DEFAULT_THEME = {
  accentColor: '#111827',
  backgroundColor: '#ffffff',
  textColor: '#111827'
}

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'
const SITES_AI_MAX_MESSAGES = 18
const SITES_AI_MAX_MESSAGE_CHARS = 5000
const RENDER_DOMAIN_CACHE_TTL_MS = 15 * 60 * 1000
const RENDER_FAILED_CACHE_TTL_MS = 90 * 1000

function cleanString(value) {
  return String(value || '').trim()
}

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function jsonString(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify(null)
  }
}

function normalizeBoolean(value) {
  if (value === true || value === 1) return 1
  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(value.trim().toLowerCase()) ? 1 : 0
  }
  return 0
}

function slugify(value) {
  const base = cleanString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return base || `site-${Date.now()}`
}

function parseHost(value) {
  const rawValue = cleanString(value)
  if (!rawValue) return ''

  const withoutProtocol = rawValue.replace(/^https?:\/\//i, '')
  const withoutPath = withoutProtocol.split('/')[0]
  const withoutUser = withoutPath.split('@').pop() || withoutPath

  if (withoutUser.startsWith('[')) {
    return withoutUser.replace(/^\[|\].*$/g, '').toLowerCase()
  }

  return withoutUser.split(':')[0].replace(/\.$/, '').toLowerCase()
}

export function normalizeDomain(value) {
  const host = parseHost(value)
  if (!host) return ''

  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
    return host
  }

  const isValid = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)
  return isValid ? host : ''
}

export function getRequestHost(req) {
  const forwardedHost = cleanString(req.headers['x-forwarded-host']).split(',')[0]
  return normalizeDomain(forwardedHost || req.headers.host || req.hostname)
}

function parseDomainList(value) {
  return cleanString(value)
    .split(',')
    .map(normalizeDomain)
    .filter(Boolean)
}

function getRenderDefaultHosts() {
  const hosts = new Set()

  for (const value of [
    process.env.RENDER_EXTERNAL_HOSTNAME,
    process.env.RENDER_EXTERNAL_URL,
    process.env.VITE_API_URL,
    process.env.PUBLIC_URL
  ]) {
    const host = normalizeDomain(value)
    if (host) hosts.add(host)
  }

  return hosts
}

export function isDashboardHost(hostValue) {
  const host = normalizeDomain(hostValue)
  if (!host) return false

  if (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return true
  }

  if (host.endsWith('.onrender.com')) {
    return true
  }

  const dashboardHosts = new Set([
    ...parseDomainList(process.env.DASHBOARD_DOMAINS),
    ...getRenderDefaultHosts()
  ])

  return dashboardHosts.has(host)
}

function mapSite(row) {
  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    siteType: row.site_type || 'standard_form',
    status: row.status || 'draft',
    domain: row.domain || '',
    title: row.title || '',
    description: row.description || '',
    theme: parseJson(row.theme_json, DEFAULT_THEME),
    metaCapiEnabled: Boolean(Number(row.meta_capi_enabled || 0)),
    metaEventName: row.meta_event_name || 'Lead',
    renderDomainVerified: Boolean(Number(row.render_domain_verified || 0)),
    renderDomainCheckedAt: row.render_domain_checked_at || null,
    renderDomainError: row.render_domain_error || null,
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submissionsCount: Number(row.submissions_count || 0)
  }
}

function mapBlock(row) {
  if (!row) return null

  return {
    id: row.id,
    siteId: row.site_id,
    blockType: row.block_type,
    label: row.label || '',
    content: row.content || '',
    placeholder: row.placeholder || '',
    required: Boolean(Number(row.required || 0)),
    options: parseJson(row.options_json, []),
    settings: parseJson(row.settings_json, {}),
    sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapSubmission(row) {
  if (!row) return null

  return {
    id: row.id,
    siteId: row.site_id,
    contactId: row.contact_id || null,
    domain: row.domain || '',
    responses: parseJson(row.response_json, {}),
    meta: parseJson(row.meta_json, {}),
    status: row.status || 'received',
    createdAt: row.created_at,
    contactName: row.contact_name || '',
    contactEmail: row.contact_email || '',
    contactPhone: row.contact_phone || ''
  }
}

function validateSiteType(value) {
  const siteType = cleanString(value) || 'standard_form'
  if (!SITE_TYPES.has(siteType)) {
    throw new Error('Tipo de site invalido')
  }
  return siteType
}

function validateSiteStatus(value) {
  const status = cleanString(value) || 'draft'
  if (!SITE_STATUSES.has(status)) {
    throw new Error('Estado de site invalido')
  }
  return status
}

function validateBlockType(value) {
  const blockType = cleanString(value)
  if (!BLOCK_TYPES.has(blockType)) {
    throw new Error('Tipo de bloque invalido')
  }
  return blockType
}

function normalizeOptionAction(value) {
  const rawAction = cleanString(value || 'continue').toLowerCase()
  const action = rawAction
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

  const aliases = {
    normal: 'continue',
    continuar: 'continue',
    continuar_normalmente: 'continue',
    lead_frio: 'cold_lead',
    frio: 'cold_lead',
    marcar_lead_frio: 'cold_lead',
    lead_tibio: 'warm_lead',
    tibio: 'warm_lead',
    marcar_lead_tibio: 'warm_lead',
    lead_caliente: 'hot_lead',
    caliente: 'hot_lead',
    marcar_lead_caliente: 'hot_lead',
    descalificar: 'disqualify',
    descalificar_contacto: 'disqualify',
    no_calificado: 'disqualify',
    mostrar_mensaje: 'show_message',
    mostrar_mensaje_especifico: 'show_message',
    terminar: 'end_form',
    terminar_formulario: 'end_form',
    finalizar: 'end_form',
    saltar: 'jump',
    saltar_pregunta: 'jump',
    etiqueta: 'tag',
    asignar_etiqueta: 'tag',
    categoria: 'category'
  }

  const resolvedAction = aliases[action] || action
  return OPTION_ACTIONS.has(resolvedAction) ? resolvedAction : 'continue'
}

async function ensureUniqueSlug(baseSlug, ignoreSiteId = null) {
  let slug = baseSlug
  let suffix = 2

  while (true) {
    const params = [slug]
    let sql = 'SELECT id FROM public_sites WHERE slug = ?'

    if (ignoreSiteId) {
      sql += ' AND id != ?'
      params.push(ignoreSiteId)
    }

    const existing = await db.get(sql, params)
    if (!existing) return slug

    slug = `${baseSlug}-${suffix}`
    suffix += 1
  }
}

function buildDefaultBlocks(siteId, siteType) {
  const makeBlock = (blockType, label, content = '', extra = {}) => ({
    id: crypto.randomUUID(),
    site_id: siteId,
    block_type: blockType,
    label,
    content,
    placeholder: extra.placeholder || '',
    required: normalizeBoolean(extra.required),
    options_json: jsonString(extra.options || []),
    settings_json: jsonString(extra.settings || {}),
    sort_order: extra.sortOrder || 0
  })

  if (siteType === 'landing_page') {
    return [
      makeBlock('hero', 'Hero', 'Agenda tu consulta', {
        sortOrder: 0,
        settings: {
          subtitle: 'Una pagina clara para convertir visitas en leads calificados.',
          buttonText: 'Quiero una consulta',
          buttonUrl: '#form'
        }
      }),
      makeBlock('benefits', 'Beneficios', 'Por que elegirnos', {
        sortOrder: 1,
        settings: {
          items: [
            { title: 'Atencion rapida', text: 'Captura datos y responde sin friccion.' },
            { title: 'Leads ordenados', text: 'Todo llega al dashboard y a la misma base de datos.' },
            { title: 'Dominio propio', text: 'Publica solo en dominios verificados.' }
          ]
        }
      }),
      makeBlock('cta', 'CTA final', 'Listo para empezar?', {
        sortOrder: 2,
        settings: {
          subtitle: 'Deja tus datos y te contactamos.',
          buttonText: 'Contactar',
          buttonUrl: '#form'
        }
      })
    ]
  }

  return [
    makeBlock('title', 'Titulo', siteType === 'interactive_form' ? 'Vamos paso a paso' : 'Cuentanos que necesitas', {
      sortOrder: 0
    }),
    makeBlock('subtitle', 'Subtitulo', 'Completa la informacion y nuestro equipo te contactara.', {
      sortOrder: 1
    }),
    makeBlock('short_text', 'Nombre completo', '', {
      placeholder: 'Tu nombre',
      required: true,
      settings: { internalName: 'full_name' },
      sortOrder: 2
    }),
    makeBlock('email', 'Correo electronico', '', {
      placeholder: 'tu@email.com',
      required: true,
      settings: { internalName: 'email', validation: 'email' },
      sortOrder: 3
    })
  ]
}

function limitString(value, limit = 1200) {
  const text = cleanString(value)
  return text.length > limit ? text.slice(0, limit).trim() : text
}

function normalizeInternalName(value, fallback = 'field') {
  return slugify(value || fallback).replace(/-/g, '_')
}

function normalizeHexColor(value, fallback) {
  const color = cleanString(value)
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback
}

function normalizeAITheme(theme = {}) {
  const input = theme && typeof theme === 'object' && !Array.isArray(theme) ? theme : {}
  return {
    accentColor: normalizeHexColor(input.accentColor || input.accent_color, DEFAULT_THEME.accentColor),
    backgroundColor: normalizeHexColor(input.backgroundColor || input.background_color, DEFAULT_THEME.backgroundColor),
    textColor: normalizeHexColor(input.textColor || input.text_color, DEFAULT_THEME.textColor)
  }
}

function normalizeSitesAIMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-SITES_AI_MAX_MESSAGES)
    .map(message => ({
      role: cleanString(message?.role) === 'assistant' ? 'assistant' : 'user',
      content: limitString(message?.content, SITES_AI_MAX_MESSAGE_CHARS)
    }))
    .filter(message => message.content)
}

function getOpenAIErrorMessage(data, fallback = 'OpenAI no pudo generar el site') {
  if (!data) return fallback
  return cleanString(data?.error?.message || data?.message || data?.error) || fallback
}

function extractOpenAIResponseText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim()
  }

  const textParts = []
  const output = Array.isArray(data?.output) ? data.output : []
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : []
    for (const part of content) {
      if (typeof part?.text === 'string') {
        textParts.push(part.text)
      }
    }
  }

  return textParts.join('\n').trim()
}

function parseSitesAIJson(text) {
  const rawText = cleanString(text)
  if (!rawText) throw new Error('La IA respondio vacia')

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1] || rawText
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  const jsonText = start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate

  try {
    return JSON.parse(jsonText)
  } catch {
    const error = new Error('La IA no devolvio JSON valido para Sites')
    error.status = 502
    throw error
  }
}

function buildSitesAIInstructions({ siteKind, agentConfig = {} }) {
  const businessContext = [
    agentConfig.business_context,
    agentConfig.market_context,
    agentConfig.ideal_customer,
    agentConfig.location_context,
    agentConfig.competitors_context,
    agentConfig.brand_voice,
    agentConfig.action_customizations
  ].map(value => limitString(value, 1200)).filter(Boolean).join('\n\n')

  return `
Eres el asistente de creacion de Sites de Ristak. Tu trabajo es hacer preguntas y, cuando haya informacion suficiente, devolver SOLO JSON valido compatible con el builder actual.

Reglas duras:
- No generes HTML, CSS, React, JavaScript ni codigo libre.
- Usa unicamente bloques y campos permitidos.
- Si falta informacion critica, responde JSON con status "needs_more_info" y una pregunta concreta en "reply".
- Si ya hay informacion suficiente, responde JSON con status "ready", "reply" y un objeto "site".
- El site creado siempre debe quedar como borrador editable en el builder.
- La respuesta completa debe ser JSON valido sin markdown.

Tipo solicitado por el usuario: ${siteKind === 'landing' ? 'landing_page' : 'formulario'}.

Bloques permitidos para landing_page:
hero, title, subtitle, text, image, video, button, benefits, testimonials, services, embed, form_embed, faq, cta.

Bloques permitidos para formularios:
short_text, paragraph, number, currency, dropdown, radio, checkboxes, phone, email, date, title, subtitle, description, video, embed.

Acciones permitidas por opcion:
continue, cold_lead, warm_lead, hot_lead, disqualify, show_message, end_form, jump, tag, category.

JSON esperado cuando falta informacion:
{
  "status": "needs_more_info",
  "reply": "Pregunta breve al usuario"
}

JSON esperado cuando esta listo:
{
  "status": "ready",
  "reply": "Ya arme un borrador editable.",
  "site": {
    "siteType": "landing_page | standard_form | interactive_form",
    "name": "Nombre interno",
    "title": "Titulo publico",
    "description": "Descripcion corta",
    "theme": { "accentColor": "#111827", "backgroundColor": "#ffffff", "textColor": "#111827" },
    "seo": { "title": "SEO title", "description": "SEO description" },
    "finalMessages": { "success": "Mensaje final", "disqualified": "Mensaje no calificado" },
    "blocks": [
      {
        "key": "identificador_opcional_para_saltos",
        "blockType": "hero | short_text | radio | etc",
        "label": "Etiqueta o pregunta",
        "content": "Texto principal cuando aplique",
        "placeholder": "Placeholder cuando aplique",
        "required": true,
        "settings": { "internalName": "nombre_interno", "helpText": "Texto de ayuda", "validation": "email" },
        "options": [
          {
            "label": "Opcion visible",
            "value": "valor",
            "action": "continue | cold_lead | warm_lead | hot_lead | disqualify | show_message | end_form | jump | tag | category",
            "targetBlockId": "key_de_bloque_destino_si_hay_salto",
            "message": "Mensaje especifico si aplica",
            "tag": "etiqueta si aplica",
            "category": "frio | tibio | caliente u otra categoria"
          }
        ]
      }
    ]
  }
}

Para landings, si el usuario quiere formulario dentro de la landing, usa un bloque form_embed con settings.embeddedBlocks usando campos permitidos.
Para formularios, propone reglas de calificacion/descalificacion cuando haya dropdown, radio o checkboxes.
Usa copy claro y estrategico, pero mantenlo editable y estructurado.

Contexto del negocio configurado en Ristak:
${businessContext || 'Sin contexto adicional configurado.'}
`.trim()
}

async function callSitesAIGenerator({ apiKey, model, siteKind, messages, agentConfig }) {
  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: cleanString(model) || 'gpt-5.5',
      instructions: buildSitesAIInstructions({ siteKind, agentConfig }),
      input: JSON.stringify({
        siteKind,
        conversation: messages
      }),
      max_output_tokens: 5200
    })
  })

  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }

  if (!response.ok) {
    const error = new Error(getOpenAIErrorMessage(data))
    error.status = response.status >= 400 && response.status < 500 ? 400 : 502
    throw error
  }

  const text = extractOpenAIResponseText(data)
  return parseSitesAIJson(text)
}

function normalizeAIOption(option = {}) {
  const label = limitString(option.label || option.value || option.text || option.name, 160)
  const action = normalizeOptionAction(option.action || option.accion || option.rule || option.regla)
  let category = limitString(option.category || option.categoria || option.leadCategory, 80)

  if (action === 'cold_lead' && !category) category = 'frio'
  if (action === 'warm_lead' && !category) category = 'tibio'
  if (action === 'hot_lead' && !category) category = 'caliente'

  return {
    id: cleanString(option.id) || slugify(label || 'opcion'),
    label,
    value: limitString(option.value || label, 160),
    action,
    targetBlockId: cleanString(option.targetBlockId || option.target_block_id || option.targetBlockKey || option.jumpTo || option.saltarA),
    message: limitString(option.message || option.mensaje, 600),
    tag: limitString(option.tag || option.etiqueta, 80),
    category
  }
}

function normalizeAIBlockOptions(blockType, options = []) {
  const normalized = (Array.isArray(options) ? options : [])
    .map(normalizeAIOption)
    .filter(option => option.label)

  if (['dropdown', 'radio', 'checkboxes'].includes(blockType) && normalized.length === 0) {
    return [
      normalizeAIOption({ label: 'Si', value: 'Si', action: 'continue' }),
      normalizeAIOption({ label: 'No', value: 'No', action: 'continue' })
    ]
  }

  return normalized
}

function normalizeAIEmbeddedBlocks(siteId, embeddedBlocks = []) {
  const allowedTypes = new Set([...FIELD_BLOCK_TYPES, 'title', 'subtitle', 'description', 'video', 'embed'])
  return (Array.isArray(embeddedBlocks) ? embeddedBlocks : [])
    .map((block, index) => normalizeAIBlock({
      block,
      siteId,
      sortOrder: index,
      allowedTypes,
      fallbackType: 'short_text'
    }))
    .filter(Boolean)
    .map(({ sourceKey, ...block }) => block)
}

function normalizeAIBlock({ block = {}, siteId, sortOrder = 0, allowedTypes = BLOCK_TYPES, fallbackType = 'text' }) {
  const rawType = cleanString(block.blockType || block.block_type || block.type || block.tipo)
  const blockType = allowedTypes.has(rawType) ? rawType : fallbackType
  const isField = FIELD_BLOCK_TYPES.has(blockType)
  const id = crypto.randomUUID()
  const label = limitString(block.label || block.question || block.pregunta || block.title || block.titulo || (isField ? 'Nueva pregunta' : 'Nuevo bloque'), 180)
  const settings = block.settings && typeof block.settings === 'object' && !Array.isArray(block.settings)
    ? { ...block.settings }
    : {}

  if (block.helpText || block.help_text || block.ayuda) {
    settings.helpText = limitString(block.helpText || block.help_text || block.ayuda, 400)
  }

  if (block.validation || block.validacion) {
    settings.validation = limitString(block.validation || block.validacion, 80)
  }

  if (isField && !settings.internalName) {
    settings.internalName = normalizeInternalName(block.internalName || block.internal_name || label)
  }

  if (blockType === 'form_embed') {
    const embeddedBlocks = settings.embeddedBlocks || settings.embedded_blocks || block.embeddedBlocks || block.embedded_blocks || block.questions || block.preguntas
    settings.embeddedBlocks = normalizeAIEmbeddedBlocks(siteId, embeddedBlocks)
  }

  return {
    sourceKey: cleanString(block.key || block.id || settings.internalName || label),
    id,
    site_id: siteId,
    block_type: blockType,
    label,
    content: limitString(block.content || block.text || block.copy || block.title || block.titulo, 1800),
    placeholder: limitString(block.placeholder, 180),
    required: normalizeBoolean(block.required || block.requerido),
    options: normalizeAIBlockOptions(blockType, block.options || block.opciones),
    settings,
    sort_order: sortOrder
  }
}

function resolveAIJumpTargets(blocks = []) {
  const targets = new Map()

  for (const block of blocks) {
    for (const key of [
      block.sourceKey,
      block.id,
      block.label,
      block.settings?.internalName
    ]) {
      const normalized = normalizeInternalName(key)
      if (normalized) targets.set(normalized, block.id)
    }
  }

  return blocks.map(block => ({
    ...block,
    options: block.options.map(option => {
      if (option.action !== 'jump' || !option.targetBlockId) return option
      const normalizedTarget = normalizeInternalName(option.targetBlockId)
      return {
        ...option,
        targetBlockId: targets.get(normalizedTarget) || ''
      }
    })
  }))
}

function normalizeAISiteBlueprint(siteKind, aiSite = {}) {
  const siteTypeInput = cleanString(aiSite.siteType || aiSite.site_type || aiSite.type || aiSite.tipo)
  const siteType = siteKind === 'landing'
    ? 'landing_page'
    : siteTypeInput === 'interactive_form' || /interactivo|typeform|una_pregunta/i.test(siteTypeInput)
      ? 'interactive_form'
      : 'standard_form'

  const id = crypto.randomUUID()
  const allowedTypes = siteType === 'landing_page'
    ? new Set(['hero', 'title', 'subtitle', 'text', 'image', 'video', 'button', 'benefits', 'testimonials', 'services', 'embed', 'form_embed', 'faq', 'cta'])
    : new Set([...FIELD_BLOCK_TYPES, 'title', 'subtitle', 'description', 'video', 'embed'])
  const fallbackType = siteType === 'landing_page' ? 'text' : 'short_text'
  const blocksInput = Array.isArray(aiSite.blocks)
    ? aiSite.blocks
    : Array.isArray(aiSite.bloques)
      ? aiSite.bloques
      : []
  let blocks = blocksInput
    .map((block, index) => normalizeAIBlock({ block, siteId: id, sortOrder: index, allowedTypes, fallbackType }))
    .filter(Boolean)

  if (blocks.length === 0) {
    throw new Error('La IA no genero bloques validos para Sites')
  }

  blocks = resolveAIJumpTargets(blocks)

  const seo = aiSite.seo && typeof aiSite.seo === 'object' && !Array.isArray(aiSite.seo) ? aiSite.seo : {}
  const finalMessages = aiSite.finalMessages && typeof aiSite.finalMessages === 'object' && !Array.isArray(aiSite.finalMessages)
    ? aiSite.finalMessages
    : aiSite.final_messages && typeof aiSite.final_messages === 'object' && !Array.isArray(aiSite.final_messages)
      ? aiSite.final_messages
      : {}
  const theme = normalizeAITheme(aiSite.theme || aiSite.style || aiSite.estilo)
  const successMessage = limitString(finalMessages.success || finalMessages.exito, 600)
  const disqualifiedMessage = limitString(finalMessages.disqualified || finalMessages.descalificado, 600)
  const title = limitString(aiSite.title || seo.title || aiSite.name || (siteType === 'landing_page' ? 'Nueva landing con IA' : 'Nuevo formulario con IA'), 180)
  const name = limitString(aiSite.name || title, 100)

  return {
    id,
    name,
    siteType,
    slug: slugify(aiSite.slug || name),
    title,
    description: limitString(aiSite.description || seo.description, 600),
    theme: {
      ...theme,
      ...(successMessage || disqualifiedMessage
        ? {
            finalMessages: {
              ...(successMessage ? { success: successMessage } : {}),
              ...(disqualifiedMessage ? { disqualified: disqualifiedMessage } : {})
            }
          }
        : {})
    },
    metaEventName: 'Lead',
    blocks
  }
}

async function insertAISiteBlueprint(blueprint) {
  const slug = await ensureUniqueSlug(blueprint.slug)

  await db.run(`
    INSERT INTO public_sites (
      id, name, slug, site_type, status, domain, title, description, theme_json,
      meta_capi_enabled, meta_event_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'draft', NULL, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    blueprint.id,
    blueprint.name,
    slug,
    blueprint.siteType,
    blueprint.title,
    blueprint.description || null,
    jsonString(blueprint.theme),
    blueprint.metaEventName || 'Lead'
  ])

  for (const block of blueprint.blocks) {
    await db.run(`
      INSERT INTO public_site_blocks (
        id, site_id, block_type, label, content, placeholder, required,
        options_json, settings_json, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      block.id,
      block.site_id,
      block.block_type,
      block.label,
      block.content,
      block.placeholder,
      block.required,
      jsonString(block.options),
      jsonString(block.settings || {}),
      block.sort_order
    ])
  }

  return getSite(blueprint.id, { includeBlocks: true, includeSubmissions: true })
}

export async function listSites() {
  const rows = await db.all(`
    SELECT
      s.*,
      COUNT(sub.id) AS submissions_count
    FROM public_sites s
    LEFT JOIN public_site_submissions sub ON sub.site_id = s.id
    GROUP BY
      s.id, s.name, s.slug, s.site_type, s.status, s.domain, s.title, s.description,
      s.theme_json, s.meta_capi_enabled, s.meta_event_name, s.render_domain_verified,
      s.render_domain_checked_at, s.render_domain_error, s.published_at, s.created_at, s.updated_at
    ORDER BY s.updated_at DESC
  `)

  return rows.map(mapSite)
}

export async function getSite(siteId, { includeBlocks = true, includeSubmissions = false } = {}) {
  const row = await db.get('SELECT * FROM public_sites WHERE id = ?', [siteId])
  const site = mapSite(row)

  if (!site) return null

  if (includeBlocks) {
    site.blocks = await listSiteBlocks(site.id)
  }

  if (includeSubmissions) {
    site.submissions = await listSiteSubmissions(site.id)
  }

  return site
}

export async function listSiteBlocks(siteId) {
  const rows = await db.all(
    'SELECT * FROM public_site_blocks WHERE site_id = ? ORDER BY sort_order ASC, created_at ASC',
    [siteId]
  )
  return rows.map(mapBlock)
}

export async function listSiteSubmissions(siteId) {
  const rows = await db.all(`
    SELECT
      sub.*,
      c.full_name AS contact_name,
      c.email AS contact_email,
      c.phone AS contact_phone
    FROM public_site_submissions sub
    LEFT JOIN contacts c ON c.id = sub.contact_id
    WHERE sub.site_id = ?
    ORDER BY sub.created_at DESC
    LIMIT 250
  `, [siteId])

  return rows.map(mapSubmission)
}

export async function createSite(input = {}) {
  const id = crypto.randomUUID()
  const name = cleanString(input.name) || 'Nuevo site'
  const siteType = validateSiteType(input.siteType || input.site_type)
  const slug = await ensureUniqueSlug(slugify(input.slug || name))
  const title = cleanString(input.title) || name
  const description = cleanString(input.description)
  const domain = normalizeDomain(input.domain)
  const theme = { ...DEFAULT_THEME, ...(input.theme || {}) }
  const status = validateSiteStatus(input.status || 'draft')

  await db.run(`
    INSERT INTO public_sites (
      id, name, slug, site_type, status, domain, title, description, theme_json,
      meta_capi_enabled, meta_event_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    name,
    slug,
    siteType,
    status,
    domain || null,
    title,
    description || null,
    jsonString(theme),
    normalizeBoolean(input.metaCapiEnabled),
    cleanString(input.metaEventName) || 'Lead'
  ])

  for (const block of buildDefaultBlocks(id, siteType)) {
    await db.run(`
      INSERT INTO public_site_blocks (
        id, site_id, block_type, label, content, placeholder, required,
        options_json, settings_json, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `, [
      block.id,
      block.site_id,
      block.block_type,
      block.label,
      block.content,
      block.placeholder,
      block.required,
      block.options_json,
      block.settings_json,
      block.sort_order
    ])
  }

  return getSite(id, { includeBlocks: true, includeSubmissions: true })
}

export async function createSiteWithAI(input = {}) {
  const siteKind = cleanString(input.siteKind || input.site_kind)
  if (!['landing', 'form'].includes(siteKind)) {
    const error = new Error('Tipo de creacion con IA invalido')
    error.status = 400
    throw error
  }

  const messages = normalizeSitesAIMessages(input.messages)
  if (messages.length === 0) {
    return {
      status: 'needs_more_info',
      reply: siteKind === 'landing'
        ? 'Cuentame el nicho, oferta, objetivo, cliente ideal, tono, estilo visual, CTA y si quieres formulario dentro de la landing.'
        : 'Cuentame que prospecto quieres atraer, que datos necesitas, preguntas clave, respuestas que califican o descalifican y si lo quieres de una sola pagina o interactivo.'
    }
  }

  const apiKey = await getOpenAIApiKey()
  if (!apiKey) {
    const error = new Error('Primero configura la API key de OpenAI en Configuracion.')
    error.status = 409
    throw error
  }

  const agentConfig = await getAIAgentConfig({ userId: input.userId })
  const aiPayload = await callSitesAIGenerator({
    apiKey,
    model: agentConfig?.model,
    siteKind,
    messages,
    agentConfig
  })

  const status = cleanString(aiPayload?.status)
  if (status === 'needs_more_info' || !aiPayload?.site) {
    return {
      status: 'needs_more_info',
      reply: limitString(aiPayload?.reply, 1000) || 'Me falta un dato clave para armar el borrador. Cuentame un poco mas del negocio y el objetivo.'
    }
  }

  const blueprint = normalizeAISiteBlueprint(siteKind, aiPayload.site)
  const site = await insertAISiteBlueprint(blueprint)

  return {
    status: 'created',
    reply: limitString(aiPayload?.reply, 1000) || 'Listo, cree un borrador editable en Sites.',
    site
  }
}

export async function updateSite(siteId, input = {}) {
  const current = await getSite(siteId, { includeBlocks: false })
  if (!current) return null

  const nextDomain = input.domain === undefined
    ? current.domain
    : normalizeDomain(input.domain)

  if (input.domain !== undefined && cleanString(input.domain) && !nextDomain) {
    throw new Error('Dominio invalido')
  }

  const nextStatus = input.status === undefined
    ? current.status
    : validateSiteStatus(input.status)
  const nextSiteType = input.siteType === undefined && input.site_type === undefined
    ? current.siteType
    : validateSiteType(input.siteType || input.site_type)
  const nextSlug = input.slug === undefined
    ? current.slug
    : await ensureUniqueSlug(slugify(input.slug), siteId)
  const domainChanged = nextDomain !== current.domain

  await db.run(`
    UPDATE public_sites SET
      name = ?,
      slug = ?,
      site_type = ?,
      status = ?,
      domain = ?,
      title = ?,
      description = ?,
      theme_json = ?,
      meta_capi_enabled = ?,
      meta_event_name = ?,
      render_domain_verified = CASE WHEN ? THEN 0 ELSE render_domain_verified END,
      render_domain_checked_at = CASE WHEN ? THEN NULL ELSE render_domain_checked_at END,
      render_domain_error = CASE WHEN ? THEN NULL ELSE render_domain_error END,
      published_at = CASE
        WHEN ? = 'published' AND published_at IS NULL THEN CURRENT_TIMESTAMP
        WHEN ? != 'published' THEN NULL
        ELSE published_at
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    cleanString(input.name) || current.name,
    nextSlug,
    nextSiteType,
    nextStatus,
    nextDomain || null,
    cleanString(input.title) || cleanString(input.name) || current.title || current.name,
    input.description === undefined ? current.description : cleanString(input.description) || null,
    jsonString({ ...DEFAULT_THEME, ...(input.theme || current.theme || {}) }),
    input.metaCapiEnabled === undefined ? normalizeBoolean(current.metaCapiEnabled) : normalizeBoolean(input.metaCapiEnabled),
    cleanString(input.metaEventName) || current.metaEventName || 'Lead',
    domainChanged ? 1 : 0,
    domainChanged ? 1 : 0,
    domainChanged ? 1 : 0,
    nextStatus,
    nextStatus,
    siteId
  ])

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function deleteSite(siteId) {
  const existing = await db.get('SELECT id FROM public_sites WHERE id = ?', [siteId])
  if (!existing) return false

  await db.run('DELETE FROM public_sites WHERE id = ?', [siteId])
  return true
}

export async function createBlock(siteId, input = {}) {
  const site = await getSite(siteId, { includeBlocks: false })
  if (!site) return null

  const blockType = validateBlockType(input.blockType || input.block_type)
  const last = await db.get(
    'SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM public_site_blocks WHERE site_id = ?',
    [siteId]
  )
  const id = crypto.randomUUID()
  const isField = FIELD_BLOCK_TYPES.has(blockType)
  const options = Array.isArray(input.options) ? input.options : []

  await db.run(`
    INSERT INTO public_site_blocks (
      id, site_id, block_type, label, content, placeholder, required,
      options_json, settings_json, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    siteId,
    blockType,
    cleanString(input.label) || (isField ? 'Nueva pregunta' : 'Nuevo bloque'),
    cleanString(input.content),
    cleanString(input.placeholder),
    normalizeBoolean(input.required),
    jsonString(options),
    jsonString(input.settings || {}),
    Number(last?.max_order || -1) + 1
  ])

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function updateBlock(siteId, blockId, input = {}) {
  const existing = await db.get(
    'SELECT * FROM public_site_blocks WHERE id = ? AND site_id = ?',
    [blockId, siteId]
  )
  if (!existing) return null

  const blockType = input.blockType || input.block_type
    ? validateBlockType(input.blockType || input.block_type)
    : existing.block_type

  await db.run(`
    UPDATE public_site_blocks SET
      block_type = ?,
      label = ?,
      content = ?,
      placeholder = ?,
      required = ?,
      options_json = ?,
      settings_json = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND site_id = ?
  `, [
    blockType,
    input.label === undefined ? existing.label : cleanString(input.label),
    input.content === undefined ? existing.content : cleanString(input.content),
    input.placeholder === undefined ? existing.placeholder : cleanString(input.placeholder),
    input.required === undefined ? normalizeBoolean(existing.required) : normalizeBoolean(input.required),
    input.options === undefined ? existing.options_json : jsonString(Array.isArray(input.options) ? input.options : []),
    input.settings === undefined ? existing.settings_json : jsonString(input.settings || {}),
    blockId,
    siteId
  ])

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function deleteBlock(siteId, blockId) {
  await db.run('DELETE FROM public_site_blocks WHERE id = ? AND site_id = ?', [blockId, siteId])
  await compactBlockOrder(siteId)
  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

export async function reorderBlocks(siteId, blockIds = []) {
  const normalizedIds = Array.isArray(blockIds) ? blockIds.map(cleanString).filter(Boolean) : []
  const existing = await listSiteBlocks(siteId)
  const existingIds = new Set(existing.map(block => block.id))
  const orderedIds = [
    ...normalizedIds.filter(id => existingIds.has(id)),
    ...existing.map(block => block.id).filter(id => !normalizedIds.includes(id))
  ]

  for (const [index, blockId] of orderedIds.entries()) {
    await db.run(
      'UPDATE public_site_blocks SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND site_id = ?',
      [index, blockId, siteId]
    )
  }

  return getSite(siteId, { includeBlocks: true, includeSubmissions: true })
}

async function compactBlockOrder(siteId) {
  const blocks = await listSiteBlocks(siteId)
  for (const [index, block] of blocks.entries()) {
    await db.run(
      'UPDATE public_site_blocks SET sort_order = ? WHERE id = ? AND site_id = ?',
      [index, block.id, siteId]
    )
  }
}

function shouldRefreshRenderCheck(site, force = false) {
  if (force) return true
  if (!site?.renderDomainCheckedAt) return true

  const checkedAt = Date.parse(site.renderDomainCheckedAt)
  if (!Number.isFinite(checkedAt)) return true

  const ttl = site.renderDomainVerified ? RENDER_DOMAIN_CACHE_TTL_MS : RENDER_FAILED_CACHE_TTL_MS
  return Date.now() - checkedAt > ttl
}

async function updateRenderVerification(siteId, result) {
  await db.run(`
    UPDATE public_sites SET
      render_domain_verified = ?,
      render_domain_checked_at = CURRENT_TIMESTAMP,
      render_domain_error = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    result.verified ? 1 : 0,
    result.verified ? null : result.error || 'Dominio no verificado en Render',
    siteId
  ])
}

export async function verifyRenderCustomDomain(domainValue) {
  const domain = normalizeDomain(domainValue)
  if (!domain) {
    return { verified: false, error: 'Dominio invalido' }
  }

  const token = cleanString(process.env.RENDER_API_KEY || process.env.RENDER_TOKEN)
  const serviceId = cleanString(process.env.RENDER_SERVICE_ID)

  if (!token || !serviceId) {
    return {
      verified: false,
      error: 'Faltan RENDER_API_KEY y RENDER_SERVICE_ID para validar Custom Domains en Render'
    }
  }

  try {
    const params = new URLSearchParams({
      limit: '20',
      verificationStatus: 'verified'
    })
    params.append('name', domain)

    const response = await fetch(
      `https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/custom-domains?${params.toString()}`,
      {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`
        }
      }
    )

    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      const message = payload?.message || payload?.error || `Render API ${response.status}`
      return { verified: false, error: `Render no pudo validar el dominio: ${message}` }
    }

    const verifiedDomain = Array.isArray(payload)
      ? payload.some(item => {
          const customDomain = item.customDomain || item
          return normalizeDomain(customDomain?.name) === domain &&
            cleanString(customDomain?.verificationStatus).toLowerCase() === 'verified'
        })
      : false

    return verifiedDomain
      ? { verified: true, error: null }
      : { verified: false, error: 'El dominio no existe como Custom Domain verificado en Render para este servicio' }
  } catch (error) {
    logger.warn(`No se pudo validar Custom Domain en Render (${domain}): ${error.message}`)
    return { verified: false, error: `Error consultando Render: ${error.message}` }
  }
}

export async function refreshSiteRenderDomain(siteId) {
  const site = await getSite(siteId, { includeBlocks: false })
  if (!site) return null

  if (!site.domain) {
    const result = { verified: false, error: 'Configura un dominio primero' }
    await updateRenderVerification(site.id, result)
    return { site: await getSite(site.id), verification: result }
  }

  const result = await verifyRenderCustomDomain(site.domain)
  await updateRenderVerification(site.id, result)

  return { site: await getSite(site.id), verification: result }
}

async function findSiteByDomain(hostValue) {
  const host = normalizeDomain(hostValue)
  if (!host) return null

  const row = await db.get(
    "SELECT * FROM public_sites WHERE LOWER(domain) = LOWER(?) AND COALESCE(domain, '') != '' LIMIT 1",
    [host]
  )

  return mapSite(row)
}

async function hydrateEmbeddedForms(blocks = []) {
  const hydrated = []

  for (const block of blocks) {
    if (block.blockType !== 'form_embed') {
      hydrated.push(block)
      continue
    }

    const settings = block.settings || {}
    const formSiteId = cleanString(settings.formSiteId || settings.form_site_id)

    if (!formSiteId || Array.isArray(settings.embeddedBlocks)) {
      hydrated.push(block)
      continue
    }

    const embeddedSite = await getSite(formSiteId, { includeBlocks: true, includeSubmissions: false })
    const embeddedBlocks = embeddedSite?.blocks || []
    hydrated.push({
      ...block,
      settings: {
        ...settings,
        embeddedSiteId: embeddedSite?.id || formSiteId,
        embeddedSiteName: embeddedSite?.name || '',
        embeddedBlocks
      }
    })
  }

  return hydrated
}

export async function resolvePublicSiteForHost(hostValue, { forceRefresh = false } = {}) {
  const host = normalizeDomain(hostValue)
  if (!host) {
    return { ok: false, status: 404, reason: 'invalid_host', message: 'Dominio invalido' }
  }

  const site = await findSiteByDomain(host)
  if (!site) {
    return { ok: false, status: 404, reason: 'domain_not_configured', message: 'Dominio no configurado' }
  }

  if (site.status !== 'published') {
    return { ok: false, status: 404, reason: 'site_not_published', message: 'Este site no esta publicado', site }
  }

  if (shouldRefreshRenderCheck(site, forceRefresh)) {
    const verification = await verifyRenderCustomDomain(host)
    await updateRenderVerification(site.id, verification)
    site.renderDomainVerified = verification.verified
    site.renderDomainCheckedAt = new Date().toISOString()
    site.renderDomainError = verification.error
  }

  if (!site.renderDomainVerified) {
    return {
      ok: false,
      status: 404,
      reason: 'render_domain_unverified',
      message: site.renderDomainError || 'Dominio no verificado en Render',
      site
    }
  }

  site.blocks = await hydrateEmbeddedForms(await listSiteBlocks(site.id))
  return { ok: true, site, host }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function safeUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''

  try {
    const parsed = new URL(raw)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : ''
  } catch {
    return ''
  }
}

function safeHref(value, fallback = '#') {
  const raw = cleanString(value)
  if (!raw) return fallback
  if (raw.startsWith('#') || raw.startsWith('/')) return raw
  return safeUrl(raw) || fallback
}

function normalizeOption(option) {
  if (option && typeof option === 'object') {
    const label = cleanString(option.label || option.value || option.text)
    return {
      id: cleanString(option.id) || slugify(label || 'opcion'),
      label,
      value: cleanString(option.value) || label,
      action: normalizeOptionAction(option.action),
      targetBlockId: cleanString(option.targetBlockId || option.target_block_id),
      message: cleanString(option.message),
      tag: cleanString(option.tag),
      category: cleanString(option.category)
    }
  }

  const label = cleanString(option)
  return {
    id: slugify(label || 'opcion'),
    label,
    value: label,
    action: 'continue',
    targetBlockId: '',
    message: '',
    tag: '',
    category: ''
  }
}

function getBlockOptions(block) {
  return Array.isArray(block.options)
    ? block.options.map(normalizeOption).filter(option => option.label)
    : []
}

function optionRuleAttributes(option) {
  const rule = {
    action: option.action || 'continue',
    targetBlockId: option.targetBlockId || '',
    message: option.message || '',
    tag: option.tag || '',
    category: option.category || ''
  }

  return `data-rule="${escapeHtml(JSON.stringify(rule))}"`
}

function getItems(settings = {}, fallback = []) {
  const items = Array.isArray(settings.items) ? settings.items : fallback
  return items
    .map(item => {
      if (item && typeof item === 'object') {
        return {
          title: cleanString(item.title || item.label || item.name),
          text: cleanString(item.text || item.content || item.description),
          author: cleanString(item.author || item.role)
        }
      }

      return { title: cleanString(item), text: '', author: '' }
    })
    .filter(item => item.title || item.text)
}

function collectFieldBlocks(blocks = []) {
  const fields = []

  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (FIELD_BLOCK_TYPES.has(block.blockType)) {
      fields.push(block)
      continue
    }

    if (block.blockType === 'form_embed' && Array.isArray(block.settings?.embeddedBlocks)) {
      fields.push(...collectFieldBlocks(block.settings.embeddedBlocks))
    }
  }

  return fields
}

function renderContentBlock(block) {
  const content = escapeHtml(block.content)
  const settings = block.settings || {}

  if (block.blockType === 'headline' || block.blockType === 'title') {
    return `<h1 class="rstk-headline">${content || escapeHtml(block.label)}</h1>`
  }

  if (block.blockType === 'subheading' || block.blockType === 'subtitle' || block.blockType === 'description') {
    return `<p class="rstk-subheading">${content || escapeHtml(block.label)}</p>`
  }

  if (block.blockType === 'hero') {
    const buttonUrl = safeHref(settings.buttonUrl, '#form')
    return `
      <section class="rstk-hero">
        <p class="rstk-kicker">${escapeHtml(settings.kicker || '')}</p>
        <h1 class="rstk-headline">${content || escapeHtml(block.label)}</h1>
        ${settings.subtitle ? `<p class="rstk-subheading">${escapeHtml(settings.subtitle)}</p>` : ''}
        ${settings.buttonText ? `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}">${escapeHtml(settings.buttonText)}</a>` : ''}
      </section>
    `
  }

  if (block.blockType === 'image') {
    const imageUrl = safeUrl(settings.mediaUrl || block.content)
    return imageUrl
      ? `<figure class="rstk-media"><img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(block.label || 'Imagen')}" loading="lazy"></figure>`
      : `<div class="rstk-media rstk-media-empty">Imagen sin URL</div>`
  }

  if (block.blockType === 'video') {
    const videoUrl = safeUrl(settings.mediaUrl || block.content)
    return videoUrl
      ? `<div class="rstk-video"><iframe src="${escapeHtml(videoUrl)}" loading="lazy" allowfullscreen sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe></div>`
      : `<div class="rstk-media rstk-media-empty">Video sin URL</div>`
  }

  if (block.blockType === 'button') {
    const buttonUrl = safeHref(settings.buttonUrl)
    return `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}">${escapeHtml(settings.buttonText || block.content || block.label || 'Continuar')}</a>`
  }

  if (['benefits', 'testimonials', 'services', 'faq'].includes(block.blockType)) {
    const items = getItems(settings)
    return `
      <section class="rstk-section-list">
        <h2>${content || escapeHtml(block.label)}</h2>
        <div class="rstk-list-grid">
          ${items.map(item => `
            <article>
              ${item.title ? `<strong>${escapeHtml(item.title)}</strong>` : ''}
              ${item.text ? `<p>${escapeHtml(item.text)}</p>` : ''}
              ${item.author ? `<small>${escapeHtml(item.author)}</small>` : ''}
            </article>
          `).join('')}
        </div>
      </section>
    `
  }

  if (block.blockType === 'form_embed') {
    const embeddedBlocks = Array.isArray(settings.embeddedBlocks) ? settings.embeddedBlocks : []
    const fields = collectFieldBlocks(embeddedBlocks)
    return `
      <section class="rstk-embedded-form" id="form">
        <h2>${content || escapeHtml(block.label || 'Formulario')}</h2>
        ${settings.description ? `<p class="rstk-help">${escapeHtml(settings.description)}</p>` : ''}
        ${fields.length
          ? fields.map(field => renderFieldBlock(field, false)).join('\n')
          : '<p class="rstk-help">Selecciona o crea un formulario embebido para capturar respuestas.</p>'}
      </section>
    `
  }

  if (block.blockType === 'cta') {
    const buttonUrl = safeHref(settings.buttonUrl, '#form')
    return `
      <section class="rstk-cta">
        <h2>${content || escapeHtml(block.label)}</h2>
        ${settings.subtitle ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
        ${settings.buttonText ? `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}">${escapeHtml(settings.buttonText)}</a>` : ''}
      </section>
    `
  }

  if (block.blockType === 'embed') {
    const embedUrl = safeUrl(block.content)
    if (!embedUrl) {
      return `<div class="rstk-embed rstk-embed-empty">Embed sin URL valida</div>`
    }

    return `<iframe class="rstk-embed" src="${escapeHtml(embedUrl)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`
  }

  return `<div class="rstk-text">${content.replace(/\n/g, '<br>')}</div>`
}

function renderFieldInput(block) {
  const id = escapeHtml(block.id)
  const placeholder = escapeHtml(block.placeholder)
  const required = block.required ? 'required' : ''
  const options = getBlockOptions(block)

  if (block.blockType === 'paragraph') {
    return `<textarea id="${id}" name="${id}" rows="5" placeholder="${placeholder}" ${required}></textarea>`
  }

  if (block.blockType === 'currency') {
    return `<input id="${id}" name="${id}" type="number" inputmode="decimal" min="0" step="0.01" placeholder="${placeholder || '0.00'}" ${required}>`
  }

  if (block.blockType === 'number') {
    return `<input id="${id}" name="${id}" type="number" inputmode="decimal" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'email') {
    return `<input id="${id}" name="${id}" type="email" inputmode="email" autocomplete="email" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'phone') {
    return `<input id="${id}" name="${id}" type="tel" inputmode="tel" autocomplete="tel" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'date') {
    return `<input id="${id}" name="${id}" type="date" placeholder="${placeholder}" ${required}>`
  }

  if (block.blockType === 'dropdown') {
    return `
      <select id="${id}" name="${id}" ${required}>
        <option value="">Selecciona una opcion</option>
        ${options.map(option => `<option value="${escapeHtml(option.value)}" ${optionRuleAttributes(option)}>${escapeHtml(option.label)}</option>`).join('')}
      </select>
    `
  }

  if (block.blockType === 'radio') {
    return `
      <div class="rstk-options">
        ${options.map((option, index) => `
          <label class="rstk-option">
            <input type="radio" name="${id}" value="${escapeHtml(option.value)}" ${required && index === 0 ? 'required' : ''} ${optionRuleAttributes(option)}>
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join('')}
      </div>
    `
  }

  if (block.blockType === 'checkboxes') {
    return `
      <div class="rstk-options">
        ${options.map(option => `
          <label class="rstk-option">
            <input type="checkbox" name="${id}" value="${escapeHtml(option.value)}" data-checkbox-group="${id}" ${optionRuleAttributes(option)}>
            <span>${escapeHtml(option.label)}</span>
          </label>
        `).join('')}
      </div>
    `
  }

  return `<input id="${id}" name="${id}" type="text" placeholder="${placeholder}" ${required}>`
}

function renderFieldBlock(block, interactive = false) {
  const label = escapeHtml(block.label || 'Pregunta')
  const required = block.required ? '<span class="rstk-required">*</span>' : ''

  return `
    <section class="rstk-field ${interactive ? 'rstk-step' : ''}" data-block-id="${escapeHtml(block.id)}" data-required="${block.required ? 'true' : 'false'}" data-field-type="${escapeHtml(block.blockType)}">
      <label for="${escapeHtml(block.id)}">${label}${required}</label>
      ${block.content ? `<p class="rstk-help">${escapeHtml(block.content)}</p>` : ''}
      ${renderFieldInput(block)}
      <p class="rstk-error" hidden>Esta respuesta es requerida.</p>
    </section>
  `
}

export function renderPublicSiteHtml(site) {
  const theme = { ...DEFAULT_THEME, ...(site.theme || {}) }
  const blocks = Array.isArray(site.blocks) ? site.blocks : []
  const fieldBlocks = collectFieldBlocks(blocks)
  const isInteractive = site.siteType === 'interactive_form'
  const hasForm = fieldBlocks.length > 0

  const bodyBlocks = blocks.map(block => (
    FIELD_BLOCK_TYPES.has(block.blockType)
      ? renderFieldBlock(block, isInteractive)
      : renderContentBlock(block)
  )).join('\n')

  const submitArea = hasForm
    ? `
      <div class="rstk-actions">
        ${isInteractive ? '<button type="button" class="rstk-secondary" data-back hidden>Anterior</button>' : ''}
        ${isInteractive ? '<button type="button" data-next>Siguiente</button>' : ''}
        <button type="submit" ${isInteractive ? 'hidden' : ''} data-submit>Enviar</button>
      </div>
      <p class="rstk-submit-message" data-message role="status"></p>
    `
    : ''

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(site.title || site.name)}</title>
  <meta name="description" content="${escapeHtml(site.description || '')}">
  <style>
    :root {
      --rstk-accent: ${escapeHtml(theme.accentColor || DEFAULT_THEME.accentColor)};
      --rstk-bg: ${escapeHtml(theme.backgroundColor || DEFAULT_THEME.backgroundColor)};
      --rstk-text: ${escapeHtml(theme.textColor || DEFAULT_THEME.textColor)};
      --rstk-muted: #64748b;
      --rstk-border: #d7dde8;
      --rstk-surface: rgba(255, 255, 255, 0.88);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(180deg, rgba(15, 23, 42, 0.04), transparent 340px),
        var(--rstk-bg);
      color: var(--rstk-text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.5;
      letter-spacing: 0;
    }
    .rstk-page {
      width: min(760px, calc(100% - 32px));
      margin: 0 auto;
      padding: clamp(32px, 6vw, 76px) 0;
    }
    .rstk-shell {
      display: grid;
      gap: 24px;
    }
    .rstk-headline {
      margin: 0;
      font-size: clamp(2rem, 5vw, 4rem);
      line-height: 0.98;
      letter-spacing: 0;
      max-width: 12ch;
    }
    .rstk-subheading {
      margin: 0;
      color: var(--rstk-muted);
      font-size: clamp(1.05rem, 2vw, 1.3rem);
      max-width: 62ch;
    }
    .rstk-hero,
    .rstk-cta,
    .rstk-section-list,
    .rstk-embedded-form {
      display: grid;
      gap: 16px;
    }
    .rstk-kicker {
      margin: 0;
      color: var(--rstk-accent);
      font-size: 0.82rem;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .rstk-text {
      color: color-mix(in srgb, var(--rstk-text) 82%, white 18%);
      font-size: 1rem;
      max-width: 68ch;
    }
    .rstk-button-link {
      width: fit-content;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--rstk-accent);
      border-radius: 8px;
      background: var(--rstk-accent);
      color: #fff;
      font-weight: 800;
      padding: 0 18px;
      text-decoration: none;
    }
    .rstk-list-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .rstk-list-grid article {
      border: 1px solid var(--rstk-border);
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.7);
      padding: 16px;
    }
    .rstk-list-grid p,
    .rstk-cta p {
      margin: 6px 0 0;
      color: var(--rstk-muted);
    }
    .rstk-list-grid small {
      color: var(--rstk-muted);
      font-weight: 700;
    }
    .rstk-media,
    .rstk-video {
      width: 100%;
      margin: 0;
      overflow: hidden;
      border: 1px solid var(--rstk-border);
      border-radius: 8px;
      background: #fff;
    }
    .rstk-media img,
    .rstk-video iframe {
      width: 100%;
      display: block;
      border: 0;
    }
    .rstk-media img {
      height: auto;
    }
    .rstk-video {
      aspect-ratio: 16 / 9;
    }
    .rstk-video iframe {
      height: 100%;
    }
    .rstk-media-empty {
      min-height: 180px;
      display: grid;
      place-items: center;
      color: var(--rstk-muted);
    }
    form {
      display: grid;
      gap: 18px;
      padding: 24px;
      background: var(--rstk-surface);
      border: 1px solid var(--rstk-border);
      border-radius: 8px;
      box-shadow: 0 24px 70px -46px rgba(15, 23, 42, 0.65);
    }
    .rstk-field {
      display: grid;
      gap: 8px;
    }
    .rstk-step[hidden] { display: none; }
    label {
      font-size: 0.96rem;
      font-weight: 700;
      color: var(--rstk-text);
    }
    .rstk-required { color: #dc2626; margin-left: 4px; }
    .rstk-help {
      margin: 0;
      color: var(--rstk-muted);
      font-size: 0.92rem;
    }
    input, textarea, select {
      width: 100%;
      border: 1px solid var(--rstk-border);
      border-radius: 8px;
      background: #fff;
      color: #111827;
      font: inherit;
      padding: 12px 13px;
      outline: none;
    }
    input:focus, textarea:focus, select:focus {
      border-color: var(--rstk-accent);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--rstk-accent) 18%, transparent);
    }
    .rstk-options {
      display: grid;
      gap: 8px;
    }
    .rstk-option {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      border: 1px solid var(--rstk-border);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fff;
      font-weight: 600;
      color: #111827;
    }
    .rstk-option input {
      width: 18px;
      height: 18px;
      padding: 0;
      accent-color: var(--rstk-accent);
    }
    .rstk-embed {
      width: 100%;
      min-height: 360px;
      border: 1px solid var(--rstk-border);
      border-radius: 8px;
      background: #fff;
    }
    .rstk-embed-empty {
      display: grid;
      place-items: center;
      min-height: 160px;
      color: var(--rstk-muted);
    }
    .rstk-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    button {
      min-height: 44px;
      border: 1px solid var(--rstk-accent);
      border-radius: 8px;
      background: var(--rstk-accent);
      color: #fff;
      font: inherit;
      font-weight: 800;
      padding: 0 18px;
      cursor: pointer;
    }
    button[hidden] { display: none; }
    button:disabled { opacity: 0.62; cursor: not-allowed; }
    .rstk-secondary {
      background: #fff;
      color: var(--rstk-accent);
    }
    .rstk-error {
      margin: 0;
      color: #b91c1c;
      font-size: 0.86rem;
    }
    .rstk-submit-message {
      margin: 0;
      color: var(--rstk-muted);
      font-weight: 650;
    }
    .rstk-progress {
      color: var(--rstk-muted);
      font-size: 0.9rem;
      font-weight: 700;
    }
    @media (max-width: 640px) {
      .rstk-page { width: min(100% - 24px, 760px); }
      form { padding: 18px; }
      .rstk-actions { justify-content: stretch; }
      button { flex: 1; }
    }
  </style>
</head>
<body>
  <main class="rstk-page">
    <div class="rstk-shell">
      ${isInteractive && hasForm ? `<div class="rstk-progress" data-progress>Pregunta 1 de ${fieldBlocks.length}</div>` : ''}
      <form data-site-form data-site-id="${escapeHtml(site.id)}" novalidate>
        ${bodyBlocks}
        ${submitArea}
      </form>
    </div>
  </main>
  <script>
    (() => {
      const form = document.querySelector('[data-site-form]');
      if (!form) return;
      const siteId = form.getAttribute('data-site-id');
      const steps = Array.from(form.querySelectorAll('.rstk-step'));
      const nextButton = form.querySelector('[data-next]');
      const backButton = form.querySelector('[data-back]');
      const submitButton = form.querySelector('[data-submit]');
      const message = form.querySelector('[data-message]');
      const progress = document.querySelector('[data-progress]');
      const isInteractive = ${isInteractive ? 'true' : 'false'};
      let index = 0;

      const parseRule = (value) => {
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
      };

      const readFieldValue = (field) => {
        const id = field.getAttribute('data-block-id');
        const type = field.getAttribute('data-field-type');
        if (type === 'checkboxes') {
          return Array.from(field.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
        }
        const checked = field.querySelector('input[type="radio"]:checked');
        if (checked) return checked.value;
        const input = field.querySelector('input, textarea, select');
        return input ? input.value : '';
      };

      const readSelectedRules = (field) => {
        const type = field.getAttribute('data-field-type');
        if (type === 'checkboxes') {
          return Array.from(field.querySelectorAll('input[type="checkbox"]:checked'))
            .map(input => parseRule(input.dataset.rule))
            .filter(Boolean);
        }
        const checked = field.querySelector('input[type="radio"]:checked');
        if (checked) return [parseRule(checked.dataset.rule)].filter(Boolean);
        const select = field.querySelector('select');
        if (select && select.selectedOptions?.[0]) {
          return [parseRule(select.selectedOptions[0].dataset.rule)].filter(Boolean);
        }
        return [];
      };

      const validateField = (field) => {
        const required = field.getAttribute('data-required') === 'true';
        const value = readFieldValue(field);
        const valid = !required || (Array.isArray(value) ? value.length > 0 : String(value || '').trim() !== '');
        const error = field.querySelector('.rstk-error');
        if (error) error.hidden = valid;
        return valid;
      };

      const renderStep = () => {
        if (!isInteractive || steps.length === 0) return;
        steps.forEach((step, stepIndex) => { step.hidden = stepIndex !== index; });
        if (backButton) backButton.hidden = index === 0;
        if (nextButton) nextButton.hidden = index >= steps.length - 1;
        if (submitButton) submitButton.hidden = index < steps.length - 1;
        if (progress) progress.textContent = 'Pregunta ' + (index + 1) + ' de ' + steps.length;
      };

      nextButton?.addEventListener('click', () => {
        const current = steps[index];
        if (current && !validateField(current)) return;
        const rules = current ? readSelectedRules(current).filter(item => item.action && item.action !== 'continue') : [];
        const blockingRule = rules.find(item => item.action === 'show_message' || item.action === 'disqualify' || item.action === 'end_form');
        if (blockingRule) {
          if (message) message.textContent = blockingRule.message || 'Gracias. Tu informacion fue recibida.';
          form.requestSubmit();
          return;
        }
        const jumpRule = rules.find(item => item.action === 'jump' && item.targetBlockId);
        if (jumpRule?.targetBlockId) {
          const targetIndex = steps.findIndex(step => step.getAttribute('data-block-id') === jumpRule.targetBlockId);
          index = targetIndex >= 0 ? targetIndex : Math.min(index + 1, steps.length - 1);
        } else {
          index = Math.min(index + 1, steps.length - 1);
        }
        renderStep();
      });

      backButton?.addEventListener('click', () => {
        index = Math.max(index - 1, 0);
        renderStep();
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const fields = Array.from(form.querySelectorAll('.rstk-field'));
        const valid = fields.every(validateField);
        if (!valid) return;

        const responses = {};
        fields.forEach((field) => {
          responses[field.getAttribute('data-block-id')] = readFieldValue(field);
        });

        const url = new URL(window.location.href);
        const params = Object.fromEntries(url.searchParams.entries());
        if (submitButton) submitButton.disabled = true;
        if (message) message.textContent = 'Enviando...';

        try {
          const response = await fetch('/api/sites/public/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteId,
              responses,
              meta: {
                pageUrl: window.location.href,
                referrer: document.referrer,
                params,
                fbp: document.cookie.match(/(?:^|; )_fbp=([^;]+)/)?.[1] || null,
                fbc: document.cookie.match(/(?:^|; )_fbc=([^;]+)/)?.[1] || null
              }
            })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.success === false) {
            throw new Error(data.error || 'No se pudo enviar el formulario');
          }
          form.reset();
          index = 0;
          renderStep();
          if (message) message.textContent = data?.data?.message || ${JSON.stringify('Listo. Recibimos tu informacion.')};
        } catch (error) {
          if (message) message.textContent = error.message || 'No se pudo enviar el formulario';
        } finally {
          if (submitButton) submitButton.disabled = false;
        }
      });

      renderStep();
    })();
  </script>
</body>
</html>`
}

export function renderDomainErrorHtml({ host, message }) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Dominio no configurado</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f8fafc;
      color: #111827;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    main {
      width: min(540px, calc(100% - 32px));
      border: 1px solid #dbe3ef;
      border-radius: 8px;
      background: #fff;
      padding: 28px;
      box-shadow: 0 22px 60px -42px rgba(15, 23, 42, 0.7);
    }
    h1 { margin: 0 0 10px; font-size: 1.45rem; }
    p { margin: 0; color: #64748b; line-height: 1.6; }
    code {
      display: inline-block;
      margin-top: 18px;
      padding: 8px 10px;
      border-radius: 6px;
      background: #f1f5f9;
      color: #334155;
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>Dominio no configurado</h1>
    <p>${escapeHtml(message || 'Este dominio no esta asociado a un site publicado y verificado en Ristak.')}</p>
    ${host ? `<code>${escapeHtml(host)}</code>` : ''}
  </main>
</body>
</html>`
}

function getClientIp(req) {
  const forwarded = cleanString(req.headers['x-forwarded-for']).split(',')[0]
  return forwarded || req.ip || req.socket?.remoteAddress || ''
}

function normalizeEmail(value) {
  const email = cleanString(value).toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function splitName(fullName) {
  const parts = cleanString(fullName).split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : ''
  }
}

function inferContactFromResponses(blocks, responseEntries) {
  const contact = {
    fullName: '',
    email: '',
    phone: ''
  }

  for (const block of blocks) {
    if (!FIELD_BLOCK_TYPES.has(block.blockType)) continue

    const label = cleanString(block.label).toLowerCase()
    const value = responseEntries[block.id]
    const normalizedValue = Array.isArray(value) ? value.join(', ') : cleanString(value)

    if (!normalizedValue) continue

    if (!contact.email && (
      block.blockType === 'email' ||
      label.includes('email') ||
      label.includes('correo') ||
      label.includes('mail')
    )) {
      contact.email = normalizeEmail(normalizedValue)
      continue
    }

    if (!contact.phone && (
      block.blockType === 'phone' ||
      label.includes('telefono') ||
      label.includes('teléfono') ||
      label.includes('celular') ||
      label.includes('whatsapp')
    )) {
      contact.phone = normalizePhoneForStorage(normalizedValue) || normalizedValue
      continue
    }

    if (!contact.fullName && (label.includes('nombre') || label.includes('name'))) {
      contact.fullName = normalizedValue
    }
  }

  return contact
}

async function findExistingContact({ email, phone }) {
  if (email) {
    const byEmail = await db.get(
      'SELECT id, phone, email, full_name, first_name, last_name FROM contacts WHERE LOWER(email) = LOWER(?) LIMIT 1',
      [email]
    )
    if (byEmail) return byEmail
  }

  if (phone) {
    const byPhone = await findContactByPhoneCandidates(phone)
    if (byPhone) return byPhone
  }

  return null
}

async function upsertContactFromSubmission({ site, contact, meta }) {
  const email = normalizeEmail(contact.email)
  const phone = normalizePhoneForStorage(contact.phone) || cleanString(contact.phone)
  const fullName = cleanString(contact.fullName) || email || phone || 'Lead de site'

  if (!email && !phone && !fullName) return null

  const existing = await findExistingContact({ email, phone })
  const contactId = existing?.id || `site_contact_${crypto.randomUUID()}`
  const phoneUpsert = await prepareContactPhoneUpsert({ contactId, phone })
  const names = splitName(fullName)
  const params = meta?.params || {}

  if (existing) {
    await db.run(`
      UPDATE contacts SET
        phone = COALESCE(NULLIF(phone, ''), ?),
        email = COALESCE(NULLIF(email, ''), ?),
        full_name = COALESCE(NULLIF(full_name, ''), ?),
        first_name = COALESCE(NULLIF(first_name, ''), ?),
        last_name = COALESCE(NULLIF(last_name, ''), ?),
        source = COALESCE(NULLIF(source, ''), ?),
        attribution_url = COALESCE(NULLIF(attribution_url, ''), ?),
        attribution_session_source = COALESCE(NULLIF(attribution_session_source, ''), ?),
        attribution_medium = COALESCE(NULLIF(attribution_medium, ''), ?),
        attribution_ad_name = COALESCE(NULLIF(attribution_ad_name, ''), ?),
        attribution_ad_id = COALESCE(NULLIF(attribution_ad_id, ''), ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [
      phoneUpsert.phone || phone || null,
      email || null,
      fullName || null,
      names.firstName || null,
      names.lastName || null,
      `ristak_site:${site.slug}`,
      cleanString(meta?.pageUrl) || null,
      cleanString(params.utm_source || params.source) || null,
      cleanString(params.utm_medium) || null,
      cleanString(params.utm_content || params.ad_name) || null,
      cleanString(params.ad_id || params.utm_ad_id) || null,
      contactId
    ])
    await finalizePreparedPhoneUpsert(phoneUpsert, contactId)
    return contactId
  }

  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source,
      attribution_url, attribution_session_source, attribution_medium,
      attribution_ad_name, attribution_ad_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      email = COALESCE(NULLIF(contacts.email, ''), excluded.email),
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      updated_at = CURRENT_TIMESTAMP
  `, [
    contactId,
    phoneUpsert.phone || phone || null,
    email || null,
    fullName,
    names.firstName || null,
    names.lastName || null,
    `ristak_site:${site.slug}`,
    cleanString(meta?.pageUrl) || null,
    cleanString(params.utm_source || params.source) || null,
    cleanString(params.utm_medium) || null,
    cleanString(params.utm_content || params.ad_name) || null,
    cleanString(params.ad_id || params.utm_ad_id) || null
  ])

  await finalizePreparedPhoneUpsert(phoneUpsert, contactId)
  return contactId
}

function normalizeSubmissionResponses(blocks, responses = {}) {
  const normalized = {}
  const errors = []

  for (const block of collectFieldBlocks(blocks)) {
    if (!FIELD_BLOCK_TYPES.has(block.blockType)) continue

    const rawValue = responses?.[block.id]
    let value = rawValue

    if (block.blockType === 'checkboxes') {
      value = Array.isArray(rawValue) ? rawValue.map(cleanString).filter(Boolean) : []
    } else {
      value = cleanString(rawValue)
    }

    const missing = Array.isArray(value) ? value.length === 0 : !value
    if (block.required && missing) {
      errors.push(`${block.label || 'Pregunta'} es requerida`)
    }

    if (!missing) {
      if (block.blockType === 'email' && !normalizeEmail(value)) {
        errors.push(`${block.label || 'Email'} debe ser un correo valido`)
      }

      if (block.blockType === 'phone' && cleanString(value).replace(/[^\d]/g, '').length < 7) {
        errors.push(`${block.label || 'Telefono'} debe tener un telefono valido`)
      }

      if ((block.blockType === 'number' || block.blockType === 'currency') && !Number.isFinite(Number(value))) {
        errors.push(`${block.label || 'Numero'} debe ser numerico`)
      }

      if (block.blockType === 'date' && Number.isNaN(Date.parse(value))) {
        errors.push(`${block.label || 'Fecha'} debe tener una fecha valida`)
      }
    }

    if (['dropdown', 'radio', 'checkboxes'].includes(block.blockType)) {
      const optionValues = new Set(getBlockOptions(block).map(option => option.value))
      const selectedValues = Array.isArray(value) ? value : [value].filter(Boolean)
      for (const selectedValue of selectedValues) {
        if (optionValues.size > 0 && !optionValues.has(selectedValue)) {
          errors.push(`${block.label || 'Pregunta'} tiene una opcion invalida`)
          break
        }
      }
    }

    normalized[block.id] = value
  }

  return { responses: normalized, errors }
}

function evaluateSubmissionRules(blocks, responses = {}) {
  const fields = collectFieldBlocks(blocks)
  const tags = new Set()
  const categories = new Set()
  const actions = []
  let disqualified = false
  let message = ''

  for (const block of fields) {
    if (!['dropdown', 'radio', 'checkboxes'].includes(block.blockType)) continue

    const selectedValues = Array.isArray(responses[block.id])
      ? responses[block.id]
      : [responses[block.id]].filter(Boolean)

    if (selectedValues.length === 0) continue

    for (const option of getBlockOptions(block)) {
      if (!selectedValues.includes(option.value)) continue

      const action = option.action || 'continue'
      if (option.tag) tags.add(option.tag)
      if (option.category) categories.add(option.category)
      if (action === 'cold_lead') categories.add(option.category || 'frio')
      if (action === 'warm_lead') categories.add(option.category || 'tibio')
      if (action === 'hot_lead') categories.add(option.category || 'caliente')

      if (action !== 'continue' || option.tag || option.category) {
        actions.push({
          blockId: block.id,
          blockLabel: block.label,
          option: option.label,
          action,
          targetBlockId: option.targetBlockId || '',
          message: option.message || '',
          tag: option.tag || '',
          category: option.category || ''
        })
      }

      if (action === 'disqualify' || action === 'show_message') {
        disqualified = true
        if (!message) {
          message = option.message || 'Gracias. Tu informacion fue recibida.'
        }
      }

      if (action === 'end_form' && !message) {
        message = option.message || 'Gracias. Tu informacion fue recibida.'
      }
    }
  }

  return {
    status: disqualified ? 'disqualified' : 'received',
    disqualified,
    message,
    tags: Array.from(tags),
    categories: Array.from(categories),
    actions
  }
}

function normalizeForHash(value) {
  const normalized = cleanString(value).toLowerCase()
  return normalized || null
}

function normalizePhoneForHash(value) {
  const digits = cleanString(value).replace(/[^\d]/g, '')
  return digits || null
}

function hashValue(value, normalizer = normalizeForHash) {
  const normalized = normalizer(value)
  if (!normalized) return null
  return crypto.createHash('sha256').update(normalized).digest('hex')
}

function getSiteFinalMessage(site, ruleEvaluation) {
  if (ruleEvaluation.message) return ruleEvaluation.message

  const finalMessages = site?.theme?.finalMessages || site?.theme?.final_messages || {}
  if (ruleEvaluation.disqualified && finalMessages.disqualified) {
    return cleanString(finalMessages.disqualified)
  }

  return cleanString(finalMessages.success) || 'Listo. Recibimos tu informacion.'
}

async function logMetaEvent({ contactId, eventType, metaEventName, eventId, status, requestPayload, responsePayload, errorMessage }) {
  await db.run(`
    INSERT INTO meta_conversion_event_logs (
      contact_id, event_type, meta_event_name, event_id, status,
      request_payload, response_payload, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    contactId || null,
    eventType,
    metaEventName,
    eventId,
    status,
    requestPayload ? jsonString(requestPayload) : null,
    responsePayload ? jsonString(responsePayload) : null,
    errorMessage || null
  ])
}

async function sendSiteLeadMetaEvent({ site, submissionId, contactId, contact, requestMeta }) {
  if (!site.metaCapiEnabled) {
    return { sent: false, reason: 'disabled' }
  }

  const eventName = cleanString(site.metaEventName) || 'Lead'
  const eventId = `site_${site.id}_${submissionId}`
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuracion Meta para Sites CAPI: ${error.message}`)
    return null
  })
  const datasetId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID)
  const accessToken = cleanString(metaConfig?.pixel_api_token || process.env.META_ACCESS_TOKEN || metaConfig?.access_token)

  if (!datasetId || !accessToken) {
    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Falta Pixel/Dataset ID o Pixel API Token de Meta'
    })
    return { sent: false, reason: 'missing_meta_config' }
  }

  const names = splitName(contact.fullName)
  const userData = {
    em: hashValue(contact.email),
    ph: hashValue(contact.phone, normalizePhoneForHash),
    fn: hashValue(names.firstName),
    ln: hashValue(names.lastName),
    external_id: hashValue(contactId),
    client_ip_address: requestMeta.ip || undefined,
    client_user_agent: requestMeta.userAgent || undefined,
    fbp: cleanString(requestMeta.meta?.fbp) || undefined,
    fbc: cleanString(requestMeta.meta?.fbc) || undefined
  }

  Object.keys(userData).forEach(key => {
    if (!userData[key]) delete userData[key]
  })

  if (!userData.em && !userData.ph && !userData.external_id) {
    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'user_data insuficiente para Meta'
    })
    return { sent: false, reason: 'insufficient_user_data' }
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'website',
        event_source_url: cleanString(requestMeta.meta?.pageUrl) || `https://${site.domain}`,
        event_id: eventId,
        user_data: userData,
        custom_data: {
          source: 'ristak_site',
          site_id: site.id,
          site_name: site.name,
          content_name: site.title || site.name
        }
      }
    ]
  }

  const testEventCode = cleanString(await getAppConfig('meta_test_event_code') || process.env.META_TEST_EVENT_CODE)
  if (testEventCode) {
    payload.test_event_code = testEventCode
  }

  try {
    const response = await fetch(`${API_URLS.META_GRAPH}/${encodeURIComponent(datasetId)}/events?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const responsePayload = await response.json().catch(() => ({}))

    if (!response.ok || responsePayload?.error) {
      throw new Error(responsePayload?.error?.message || `Meta CAPI ${response.status}`)
    }

    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    return { sent: true, eventId, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType: 'site_form_submission',
      metaEventName: eventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      errorMessage: error.message
    })
    return { sent: false, reason: 'meta_error', error: error.message }
  }
}

export async function createSubmissionFromRequest(req, body = {}) {
  const host = getRequestHost(req)
  const resolution = await resolvePublicSiteForHost(host)

  if (!resolution.ok) {
    const error = new Error(resolution.message)
    error.status = resolution.status
    throw error
  }

  const site = resolution.site
  if (body.siteId && body.siteId !== site.id) {
    const error = new Error('El site no corresponde a este dominio')
    error.status = 403
    throw error
  }

  const blocks = Array.isArray(site.blocks) && site.blocks.length
    ? site.blocks
    : await hydrateEmbeddedForms(await listSiteBlocks(site.id))
  const { responses, errors } = normalizeSubmissionResponses(blocks, body.responses || {})
  if (errors.length) {
    const error = new Error(errors.join(', '))
    error.status = 400
    throw error
  }

  const ruleEvaluation = evaluateSubmissionRules(blocks, responses)

  const meta = {
    ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
    host,
    rules: ruleEvaluation,
    userAgent: req.headers['user-agent'] || '',
    submittedAt: new Date().toISOString()
  }
  const inferredContact = inferContactFromResponses(collectFieldBlocks(blocks), responses)
  const contactId = await upsertContactFromSubmission({ site, contact: inferredContact, meta })
  const submissionId = crypto.randomUUID()

  await db.run(`
    INSERT INTO public_site_submissions (
      id, site_id, contact_id, domain, response_json, meta_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    submissionId,
    site.id,
    contactId,
    host,
    jsonString(responses),
    jsonString(meta),
    ruleEvaluation.status
  ])

  const capi = await sendSiteLeadMetaEvent({
    site,
    submissionId,
    contactId,
    contact: inferredContact,
    requestMeta: {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      meta
    }
  })

  return {
    submissionId,
    siteId: site.id,
    contactId,
    status: ruleEvaluation.status,
    message: getSiteFinalMessage(site, ruleEvaluation),
    rules: ruleEvaluation,
    capi
  }
}
