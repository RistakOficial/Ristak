import crypto from 'crypto'
import dns from 'node:dns/promises'
import fetch from 'node-fetch'
import { db, getAppConfig, setAppConfig } from '../config/database.js'
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
import { createSession, linkVisitorToContact, unifyVisitorIds } from './trackingService.js'

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
  'calendar_embed',
  'section',
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
const PUBLIC_DOMAIN_CACHE_TTL_MS = 15 * 60 * 1000
const PUBLIC_DOMAIN_FAILED_CACHE_TTL_MS = 90 * 1000
const PUBLIC_DOMAIN_VERIFY_TIMEOUT_MS = 6000
const DEFAULT_FUNNEL_PAGE_ID = 'page-1'
const SITE_META_NO_EVENT = 'none'
const SITE_META_EVENTS = new Set(['Lead', 'Schedule', 'Purchase', 'FormSubmitted', 'ViewContent', 'CompleteRegistration', 'Contact'])
const META_STANDARD_PIXEL_EVENTS = new Set(['Lead', 'Schedule', 'Purchase', 'ViewContent', 'CompleteRegistration', 'Contact'])
const SITE_META_TRIGGERS = new Set(['page_view', 'form_submit'])
const SITES_PUBLIC_DOMAIN_CONFIG_KEYS = {
  domain: 'sites_public_domain',
  verified: 'sites_public_domain_verified',
  checkedAt: 'sites_public_domain_checked_at',
  error: 'sites_public_domain_error'
}

function cleanString(value) {
  return String(value || '').trim()
}

function normalizeSiteMetaEventName(value, { allowNone = false, fallback = 'Lead' } = {}) {
  const eventName = cleanString(value)
  if (allowNone && eventName.toLowerCase() === SITE_META_NO_EVENT) return SITE_META_NO_EVENT
  return SITE_META_EVENTS.has(eventName) ? eventName : fallback
}

function normalizeSiteMetaTrigger(value) {
  const trigger = cleanString(value)
  return SITE_META_TRIGGERS.has(trigger) ? trigger : 'page_view'
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

function getDefaultRoutePrefix(siteType) {
  return siteType === 'landing_page' ? 'site' : 'form'
}

async function getNextDefaultSlug(siteType) {
  const prefix = getDefaultRoutePrefix(siteType)
  const rows = await db.all(
    'SELECT slug FROM public_sites WHERE slug LIKE ?',
    [`${prefix}-%`]
  )
  const used = new Set(rows.map(row => row.slug))
  let index = 1
  let slug = `${prefix}-${String(index).padStart(2, '0')}`

  while (used.has(slug)) {
    index += 1
    slug = `${prefix}-${String(index).padStart(2, '0')}`
  }

  return slug
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
    metaEventName: normalizeSiteMetaEventName(row.meta_event_name, { allowNone: true }),
    renderDomainVerified: Boolean(Number(row.render_domain_verified || 0)),
    renderDomainCheckedAt: row.render_domain_checked_at || null,
    renderDomainError: row.render_domain_error || null,
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submissionsCount: Number(row.submissions_count || 0),
    trackingStats: {
      views: Number(row.tracking_views || 0),
      visitors: Number(row.tracking_visitors || 0),
      sessions: Number(row.tracking_sessions || 0),
      conversions: Number(row.tracking_conversions || 0),
      conversionRate: Number(row.tracking_visitors || 0) > 0
        ? Number(((Number(row.tracking_conversions || 0) / Number(row.tracking_visitors || 0)) * 100).toFixed(1))
        : 0
    }
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

function buildDefaultBlocks(siteId, siteType, template) {
  const tpl = cleanString(template)
  const landingSpacing = {
    blockMarginLinked: false,
    blockMarginTop: 50,
    blockMarginRight: 0,
    blockMarginBottom: 50,
    blockMarginLeft: 0,
    blockPaddingLinked: true
  }
  const defaultButtonSettings = {
    buttonAlign: 'center',
    buttonRadius: 28,
    buttonHeight: 54,
    buttonPaddingX: 28
  }
  const withLandingSpacing = (settings = {}) => ({
    ...landingSpacing,
    ...settings
  })
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
  const makeLandingSection = (index, columns = 1) => {
    const dark = index % 2 === 1
    return makeBlock('section', `Franja ${index + 1}`, '', {
      sortOrder: index * 2,
      settings: {
        sectionColumns: columns,
        sectionGap: 24,
        blockBg: dark ? '#111827' : '#ffffff',
        blockText: dark ? '#ffffff' : '#111827',
        blockPaddingTop: 80,
        blockPaddingRight: 42,
        blockPaddingBottom: 80,
        blockPaddingLeft: 42,
        blockMarginTop: 0,
        blockMarginRight: 0,
        blockMarginBottom: 0,
        blockMarginLeft: 0,
        textAlign: 'center',
        blockRadius: 0,
        blockBorderWidth: 0
      }
    })
  }
  const wrapLandingBlocksInSections = (contentBlocks) => contentBlocks.flatMap((block, index) => {
    const section = makeLandingSection(index, 1)
    const settings = parseJson(block.settings_json, {})
    return [
      section,
      {
        ...block,
        sort_order: index * 2 + 1,
        settings_json: jsonString({
          ...settings,
          sectionId: section.id,
          sectionColumn: 0
        })
      }
    ]
  })

  const contactFields = (startOrder) => [
    makeBlock('short_text', 'Nombre completo', '', {
      placeholder: 'Tu nombre',
      required: true,
      settings: { internalName: 'full_name' },
      sortOrder: startOrder
    }),
    makeBlock('phone', 'Telefono / WhatsApp', '', {
      placeholder: '10 digitos',
      required: true,
      settings: { internalName: 'phone', validation: 'phone' },
      sortOrder: startOrder + 1
    }),
    makeBlock('email', 'Correo electronico', '', {
      placeholder: 'tu@email.com',
      required: true,
      settings: { internalName: 'email', validation: 'email' },
      sortOrder: startOrder + 2
    })
  ]

  if (siteType === 'landing_page') {
    if (tpl === 'vsl') {
      return wrapLandingBlocksInSections([
        makeBlock('headline', 'Titular', 'Mira esto antes de tomar una decision', {
          sortOrder: 0,
          settings: withLandingSpacing()
        }),
        makeBlock('subheading', 'Subtitulo', 'En menos de 3 minutos te explico exactamente como funciona.', {
          sortOrder: 1,
          settings: withLandingSpacing()
        }),
        makeBlock('video', 'Video', '', {
          sortOrder: 2,
          settings: withLandingSpacing({ mediaUrl: '' })
        }),
        makeBlock('cta', 'CTA final', 'Quiero empezar ahora', {
          sortOrder: 3,
          settings: withLandingSpacing({
            textAlign: 'center',
            subtitle: 'Deja tus datos y un asesor te contacta hoy mismo.',
            buttonText: 'Quiero mas informacion',
            buttonUrl: '#form',
            ...defaultButtonSettings
          })
        }),
        makeBlock('benefits', 'Lo que vas a lograr', 'Esto es lo que vas a lograr', {
          sortOrder: 4,
          settings: withLandingSpacing({
            items: [
              { title: '+ Atraer clientes de forma constante', text: 'Sin depender de recomendaciones.' },
              { title: '+ Un sistema que trabaja por ti', text: 'Automatizado de principio a fin.' },
              { title: '- Sin perder tiempo en tacticas que no funcionan', text: '' }
            ]
          })
        })
      ])
    }

    return wrapLandingBlocksInSections([
      makeBlock('hero', 'Hero', 'Agenda tu consulta', {
        sortOrder: 0,
        settings: withLandingSpacing({
          textAlign: 'center',
          kicker: 'Nuevo',
          subtitle: 'Una pagina clara para convertir visitas en leads calificados.',
          buttonText: 'Quiero una consulta',
          buttonUrl: '#form',
          ...defaultButtonSettings
        })
      }),
      makeBlock('benefits', 'Beneficios', 'Por que elegirnos', {
        sortOrder: 1,
        settings: withLandingSpacing({
          items: [
            { title: '+ Atencion rapida', text: 'Captura datos y responde sin friccion.' },
            { title: '+ Leads ordenados', text: 'Todo llega al dashboard y a la misma base de datos.' },
            { title: '+ Dominio propio', text: 'Publica solo en dominios verificados.' }
          ]
        })
      }),
      makeBlock('cta', 'CTA final', 'Listo para empezar?', {
        sortOrder: 2,
        settings: withLandingSpacing({
          textAlign: 'center',
          subtitle: 'Deja tus datos y te contactamos.',
          buttonText: 'Contactar',
          buttonUrl: '#form',
          ...defaultButtonSettings
        })
      })
    ])
  }

  if (siteType === 'standard_form' && (tpl === 'facebook' || tpl === 'instagram' || tpl === 'tiktok')) {
    return [
      makeBlock('title', 'Titulo', 'Deja tus datos y te contactamos', { sortOrder: 0 }),
      makeBlock('subtitle', 'Subtitulo', 'Completa el formulario y un asesor te contacta en minutos.', { sortOrder: 1 }),
      ...contactFields(2)
    ]
  }

  return [
    makeBlock('title', 'Titulo', siteType === 'interactive_form' ? 'Vamos paso a paso' : 'Cuentanos que necesitas', {
      sortOrder: 0
    }),
    makeBlock('subtitle', 'Subtitulo', 'Completa la informacion y nuestro equipo te contactara.', {
      sortOrder: 1
    }),
    ...contactFields(2)
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

function isCssColor(value) {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return false
  if (raw === 'transparent') return true
  if (/^#[0-9a-f]{6}$/i.test(raw)) return true
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return false
  const channels = match.slice(1, 4).map(Number)
  const alpha = match[4] === undefined ? 1 : Number(match[4])
  return channels.every(channel => channel >= 0 && channel <= 255) && alpha >= 0 && alpha <= 1
}

function isCssGradient(value) {
  const raw = cleanString(value)
  return /^(linear|radial|conic)-gradient\(/i.test(raw) && !/[;{}<>]/.test(raw)
}

function isCssPaint(value) {
  return isCssColor(value) || isCssGradient(value)
}

function normalizeCssColor(value, fallback = '') {
  const raw = cleanString(value).toLowerCase()
  if (!raw) return fallback
  if (raw === 'transparent') return 'rgba(0, 0, 0, 0)'
  if (/^#[0-9a-f]{6}$/i.test(raw)) return raw
  if (!isCssColor(raw)) return fallback
  const match = raw.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i)
  if (!match) return fallback
  const [r, g, b] = match.slice(1, 4).map(valuePart => Math.round(Number(valuePart)))
  const alpha = match[4] === undefined ? 1 : Math.round(Number(match[4]) * 100) / 100
  const toHex = channel => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0')
  return alpha >= 1 ? `#${toHex(r)}${toHex(g)}${toHex(b)}` : `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function normalizeCssPaint(value, fallback = '') {
  const raw = cleanString(value)
  if (isCssGradient(raw)) return raw
  return normalizeCssColor(raw, fallback)
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
hero, title, subtitle, text, image, video, button, benefits, testimonials, services, embed, calendar_embed, form_embed, faq, cta.

Bloques permitidos para formularios:
short_text, paragraph, number, currency, dropdown, radio, checkboxes, phone, email, date, title, subtitle, description, video, embed, calendar_embed.

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
  const allowedTypes = new Set([...FIELD_BLOCK_TYPES, 'title', 'subtitle', 'description', 'video', 'embed', 'calendar_embed'])
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
    ? new Set(['hero', 'section', 'title', 'subtitle', 'text', 'image', 'video', 'button', 'benefits', 'testimonials', 'services', 'embed', 'calendar_embed', 'form_embed', 'faq', 'cta'])
    : new Set([...FIELD_BLOCK_TYPES, 'title', 'subtitle', 'description', 'video', 'embed', 'calendar_embed'])
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
  const requestedTemplate = cleanString(aiSite.template || aiSite.plantilla)
  const aiTemplate = SITE_TEMPLATES[requestedTemplate] ? requestedTemplate : ''
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
      ...(siteType === 'landing_page' ? { pageMaxWidth: 1440 } : {}),
      ...(aiTemplate ? { template: aiTemplate } : {}),
      ...(successMessage || disqualifiedMessage
        ? {
            finalMessages: {
              ...(successMessage ? { success: successMessage } : {}),
              ...(disqualifiedMessage ? { disqualified: disqualifiedMessage } : {})
            }
          }
        : {})
    },
    metaEventName: SITE_META_NO_EVENT,
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
    normalizeSiteMetaEventName(blueprint.metaEventName, { allowNone: true })
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
      COUNT(sub.id) AS submissions_count,
      (
        SELECT COUNT(*)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.event_name IN ('native_site_view', 'session_start', 'page_view')
      ) AS tracking_views,
      (
        SELECT COUNT(DISTINCT ts.visitor_id)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.visitor_id IS NOT NULL
          AND ts.visitor_id != ''
      ) AS tracking_visitors,
      (
        SELECT COUNT(DISTINCT ts.session_id)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.session_id IS NOT NULL
          AND ts.session_id != ''
      ) AS tracking_sessions,
      (
        SELECT COUNT(DISTINCT ts.submission_id)
        FROM sessions ts
        WHERE (ts.site_id = s.id OR ts.form_site_id = s.id)
          AND ts.event_name = 'native_site_conversion'
          AND ts.submission_id IS NOT NULL
          AND ts.submission_id != ''
      ) AS tracking_conversions
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

async function getSiteTrackingStats(siteId) {
  const row = await db.get(`
    SELECT
      COUNT(CASE WHEN event_name IN ('native_site_view', 'session_start', 'page_view') THEN 1 END) AS tracking_views,
      COUNT(DISTINCT visitor_id) AS tracking_visitors,
      COUNT(DISTINCT session_id) AS tracking_sessions,
      COUNT(DISTINCT CASE WHEN event_name = 'native_site_conversion' THEN submission_id END) AS tracking_conversions
    FROM sessions
    WHERE site_id = ? OR form_site_id = ?
  `, [siteId, siteId])

  const visitors = Number(row?.tracking_visitors || 0)
  const conversions = Number(row?.tracking_conversions || 0)

  return {
    views: Number(row?.tracking_views || 0),
    visitors,
    sessions: Number(row?.tracking_sessions || 0),
    conversions,
    conversionRate: visitors > 0 ? Number(((conversions / visitors) * 100).toFixed(1)) : 0
  }
}

export async function getSite(siteId, { includeBlocks = true, includeSubmissions = false } = {}) {
  const row = await db.get('SELECT * FROM public_sites WHERE id = ?', [siteId])
  const site = mapSite(row)

  if (!site) return null

  site.trackingStats = await getSiteTrackingStats(site.id)

  if (includeBlocks) {
    site.blocks = await listSiteBlocks(site.id)
  }

  if (includeSubmissions) {
    site.submissions = await listSiteSubmissions(site.id)
  }

  return site
}

export async function getSitePreview(siteId) {
  const site = await getSite(siteId, { includeBlocks: false, includeSubmissions: false })
  if (!site) return null

  site.blocks = await hydrateEmbeddedForms(await listSiteBlocks(site.id))
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
  const slug = await ensureUniqueSlug(slugify(input.slug || await getNextDefaultSlug(siteType)))
  const title = cleanString(input.title) || name
  const description = cleanString(input.description)
  const domain = ''
  const theme = { ...DEFAULT_THEME, ...(input.theme || {}) }
  if (siteType === 'landing_page' && theme.pageMaxWidth === undefined) {
    theme.pageMaxWidth = 1440
  }
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
    normalizeSiteMetaEventName(input.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
  ])

  for (const block of buildDefaultBlocks(id, siteType, theme.template)) {
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

  const nextDomain = current.domain
  const nextStatus = input.status === undefined
    ? current.status
    : validateSiteStatus(input.status)
  const nextSiteType = input.siteType === undefined && input.site_type === undefined
    ? current.siteType
    : validateSiteType(input.siteType || input.site_type)
  const nextSlug = input.slug === undefined
    ? current.slug
    : await ensureUniqueSlug(slugify(input.slug), siteId)
  const domainChanged = false

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
    normalizeSiteMetaEventName(input.metaEventName || current.metaEventName, { allowNone: true }),
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

export async function reorderBlocks(siteId, blockIds = [], { pageId } = {}) {
  const normalizedIds = Array.isArray(blockIds) ? blockIds.map(cleanString).filter(Boolean) : []
  const existing = await listSiteBlocks(siteId)
  const normalizedPageId = cleanString(pageId)
  const pageBlocks = normalizedPageId
    ? existing.filter(block => {
        const blockPageId = cleanString(block.settings?.pageId || block.settings?.page_id)
        return blockPageId === normalizedPageId || (!blockPageId && normalizedPageId === DEFAULT_FUNNEL_PAGE_ID)
      })
    : existing
  const existingIds = new Set(pageBlocks.map(block => block.id))
  const orderedIds = [
    ...normalizedIds.filter(id => existingIds.has(id)),
    ...pageBlocks.map(block => block.id).filter(id => !normalizedIds.includes(id))
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

function shouldRefreshDomainCheck(site, force = false) {
  if (force) return true
  if (!site?.renderDomainCheckedAt) return true

  const checkedAt = Date.parse(site.renderDomainCheckedAt)
  if (!Number.isFinite(checkedAt)) return true

  const ttl = site.renderDomainVerified ? PUBLIC_DOMAIN_CACHE_TTL_MS : PUBLIC_DOMAIN_FAILED_CACHE_TTL_MS
  return Date.now() - checkedAt > ttl
}

async function getSitesPublicDomainConfig() {
  const [rawDomain, verified, checkedAt, error] = await Promise.all([
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.domain),
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.verified),
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.checkedAt),
    getAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.error)
  ])
  const domain = normalizeDomain(rawDomain)

  return {
    domain,
    renderDomainVerified: Boolean(domain && cleanString(verified) === '1'),
    renderDomainCheckedAt: cleanString(checkedAt) || null,
    renderDomainError: cleanString(error) || null
  }
}

async function saveSitesPublicDomainVerification(domain, result) {
  const checkedAt = new Date().toISOString()
  const config = {
    domain,
    renderDomainVerified: Boolean(result.verified),
    renderDomainCheckedAt: checkedAt,
    renderDomainError: result.verified ? null : result.error || 'Dominio no conectado a esta app'
  }

  await Promise.all([
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.domain, domain),
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.verified, result.verified ? '1' : '0'),
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.checkedAt, checkedAt),
    setAppConfig(SITES_PUBLIC_DOMAIN_CONFIG_KEYS.error, config.renderDomainError)
  ])

  return config
}

export async function getSitesPublicDomain() {
  return getSitesPublicDomainConfig()
}

export async function refreshSitesPublicDomain(input = {}) {
  const current = await getSitesPublicDomainConfig()
  const hasDomainCandidate = Object.prototype.hasOwnProperty.call(input, 'domain')
  const rawDomain = hasDomainCandidate ? input.domain : current.domain
  const domain = normalizeDomain(rawDomain)

  if (hasDomainCandidate && cleanString(rawDomain) && !domain) {
    const result = { verified: false, error: 'Dominio invalido' }
    return {
      ...current,
      domain: cleanString(rawDomain),
      renderDomainVerified: false,
      renderDomainCheckedAt: new Date().toISOString(),
      renderDomainError: result.error,
      verification: result
    }
  }

  if (!domain) {
    const result = { verified: false, error: 'Configura un dominio primero' }
    return {
      ...current,
      domain: '',
      renderDomainVerified: false,
      renderDomainCheckedAt: new Date().toISOString(),
      renderDomainError: result.error,
      verification: result
    }
  }

  const result = await verifyPublicDomainConnection(domain)
  const shouldPersist = result.verified || domain === current.domain || !hasDomainCandidate
  const nextConfig = shouldPersist
    ? await saveSitesPublicDomainVerification(domain, result)
    : {
        ...current,
        domain,
        renderDomainVerified: false,
        renderDomainCheckedAt: new Date().toISOString(),
        renderDomainError: result.error
      }

  return {
    ...nextConfig,
    verification: result
  }
}

async function readDomainDns(domain) {
  const [cnamesResult, ipv4Result, ipv6Result] = await Promise.allSettled([
    dns.resolveCname(domain),
    dns.resolve4(domain),
    dns.resolve6(domain)
  ])

  const cnames = cnamesResult.status === 'fulfilled'
    ? cnamesResult.value.map(normalizeDomain).filter(Boolean)
    : []
  const addresses = [
    ...(ipv4Result.status === 'fulfilled' ? ipv4Result.value : []),
    ...(ipv6Result.status === 'fulfilled' ? ipv6Result.value : [])
  ].filter(Boolean)

  return { cnames, addresses }
}

function getExpectedPublicDomainTargets() {
  return new Set([
    ...getRenderDefaultHosts(),
    normalizeDomain(process.env.SITES_PUBLIC_TARGET_HOST),
    normalizeDomain(process.env.PUBLIC_DOMAIN_TARGET_HOST)
  ].filter(Boolean))
}

function describeDnsSignal(dnsInfo) {
  if (!dnsInfo.cnames.length && !dnsInfo.addresses.length) {
    return 'No encuentro registros DNS publicos para ese dominio'
  }

  const expectedTargets = getExpectedPublicDomainTargets()
  const matchingTarget = dnsInfo.cnames.find(cname => expectedTargets.has(cname))
  if (matchingTarget) {
    return `DNS apunta a ${matchingTarget}, pero el dominio todavia no responde a esta app`
  }

  const renderTarget = dnsInfo.cnames.find(cname => cname.endsWith('.onrender.com'))
  if (renderTarget) {
    return `DNS apunta a ${renderTarget}, pero el dominio todavia no responde a esta app`
  }

  if (dnsInfo.cnames.length) {
    return `DNS apunta a ${dnsInfo.cnames.join(', ')}, pero no responde a esta app`
  }

  return 'DNS resuelve, pero el dominio todavia no responde a esta app'
}

async function checkDomainHealth(domain, protocol) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PUBLIC_DOMAIN_VERIFY_TIMEOUT_MS)
  const url = `${protocol}://${domain}/api/health`

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'RistakDomainVerifier/1.0'
      },
      redirect: 'follow',
      signal: controller.signal
    })
    const payload = await response.json().catch(() => null)

    if (response.ok && cleanString(payload?.status).toLowerCase() === 'ok') {
      return { ok: true, url }
    }

    return {
      ok: false,
      error: `${url} respondio ${response.status}, pero no parece ser el health de Ristak`
    }
  } catch (error) {
    return {
      ok: false,
      error: error.name === 'AbortError'
        ? `${url} no respondio a tiempo`
        : `${url} fallo: ${error.message}`
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function verifyPublicDomainConnection(domainValue) {
  const domain = normalizeDomain(domainValue)
  if (!domain) {
    return { verified: false, error: 'Dominio invalido' }
  }

  const httpsCheck = await checkDomainHealth(domain, 'https')
  if (httpsCheck.ok) {
    return { verified: true, error: null, method: 'https_health', url: httpsCheck.url }
  }

  const httpCheck = await checkDomainHealth(domain, 'http')
  if (httpCheck.ok) {
    return { verified: true, error: null, method: 'http_health', url: httpCheck.url }
  }

  const dnsInfo = await readDomainDns(domain)
  return {
    verified: false,
    error: describeDnsSignal(dnsInfo),
    details: {
      dns: dnsInfo,
      checks: [httpsCheck.error, httpCheck.error].filter(Boolean)
    }
  }
}

function normalizePublicRouteSlug(pathValue) {
  const path = cleanString(pathValue || '/')
  const firstSegment = path
    .split('?')[0]
    .split('#')[0]
    .split('/')
    .filter(Boolean)[0] || ''
  let decoded = firstSegment

  try {
    decoded = decodeURIComponent(firstSegment)
  } catch {
    decoded = firstSegment
  }

  return cleanString(decoded)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

async function findSiteByRoutePath(pathValue) {
  const slug = normalizePublicRouteSlug(pathValue)
  if (!slug) return null

  const row = await db.get(
    'SELECT * FROM public_sites WHERE LOWER(slug) = LOWER(?) LIMIT 1',
    [slug]
  )

  return mapSite(row)
}

export async function resolveConnectedPublicDomainForHost(hostValue, { forceRefresh = false } = {}) {
  const host = normalizeDomain(hostValue)
  if (!host) {
    return { ok: false, status: 404, reason: 'invalid_host', message: 'Dominio invalido' }
  }

  const config = await getSitesPublicDomainConfig()
  if (!config.domain || config.domain !== host) {
    return { ok: false, status: 404, reason: 'domain_not_configured', message: 'Dominio no configurado' }
  }

  if (shouldRefreshDomainCheck(config, forceRefresh)) {
    const verification = await verifyPublicDomainConnection(config.domain)
    const nextConfig = await saveSitesPublicDomainVerification(config.domain, verification)
    config.renderDomainVerified = nextConfig.renderDomainVerified
    config.renderDomainCheckedAt = nextConfig.renderDomainCheckedAt
    config.renderDomainError = nextConfig.renderDomainError
  }

  if (!config.renderDomainVerified) {
    return {
      ok: false,
      status: 404,
      reason: 'domain_unverified',
      message: config.renderDomainError || 'Dominio no conectado a esta app',
      domainConfig: config
    }
  }

  return { ok: true, domain: config.domain, domainConfig: config, host }
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

export async function resolvePublicSiteForHost(hostValue, { forceRefresh = false, path = '/' } = {}) {
  const host = normalizeDomain(hostValue)
  if (!host) {
    return { ok: false, status: 404, reason: 'invalid_host', message: 'Dominio invalido' }
  }

  const domainResolution = await resolveConnectedPublicDomainForHost(host, { forceRefresh })
  if (!domainResolution.ok) return domainResolution

  const site = await findSiteByRoutePath(path)
  if (!site) {
    return { ok: false, status: 404, reason: 'route_not_configured', message: 'Ruta publica no configurada' }
  }

  if (site.status !== 'published') {
    return { ok: false, status: 404, reason: 'site_not_published', message: 'Este site no esta publicado', site }
  }

  site.blocks = await hydrateEmbeddedForms(await listSiteBlocks(site.id))
  site.domain = domainResolution.domain || host
  return { ok: true, site, host, domain: domainResolution.domain || host, path }
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

const DEFAULT_EMBED_ALLOW = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
const EMBED_SANDBOX_URL = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox'
const EMBED_SANDBOX_HTML = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
const EMBED_MIN_HEIGHT = 180
const EMBED_MAX_HEIGHT = 900

function decodeHtmlAttribute(value) {
  return cleanString(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
}

function safeEmbedUrl(value) {
  const raw = decodeHtmlAttribute(value)
  if (!raw) return ''
  const candidate = raw.startsWith('//')
    ? `https:${raw}`
    : /^www\./i.test(raw)
      ? `https://${raw}`
      : raw

  return safeUrl(candidate)
}

function getIframeAttribute(iframeTag, attributeName) {
  const pattern = new RegExp(`\\s${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const match = String(iframeTag || '').match(pattern)
  return decodeHtmlAttribute(match?.[1] || match?.[2] || match?.[3] || '')
}

function normalizeEmbedHeight(value) {
  const match = cleanString(value).match(/(\d{2,4})/)
  if (!match) return 0
  const height = Number(match[1])
  if (!Number.isFinite(height)) return 0
  return Math.min(EMBED_MAX_HEIGHT, Math.max(EMBED_MIN_HEIGHT, height))
}

function buildEmbedSrcDoc(html) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <base target="_blank">
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { padding: 0; overflow-wrap: anywhere; }
      iframe, img, video { max-width: 100%; }
      iframe { border: 0; }
    </style>
  </head>
  <body>${html}</body>
</html>`
}

function resolveEmbedContent(value) {
  const raw = cleanString(value)
  if (!raw || raw.toLowerCase() === 'embed') return { kind: 'empty' }

  const directUrl = safeEmbedUrl(raw)
  if (directUrl) {
    return { kind: 'url', src: directUrl, title: 'Embed', allow: DEFAULT_EMBED_ALLOW, height: 0 }
  }

  const iframeTag = raw.match(/<iframe\b[\s\S]*?>/i)?.[0] || ''
  if (iframeTag) {
    const iframeUrl = safeEmbedUrl(getIframeAttribute(iframeTag, 'src'))
    if (iframeUrl) {
      return {
        kind: 'url',
        src: iframeUrl,
        title: getIframeAttribute(iframeTag, 'title') || 'Embed',
        allow: getIframeAttribute(iframeTag, 'allow') || DEFAULT_EMBED_ALLOW,
        height: normalizeEmbedHeight(getIframeAttribute(iframeTag, 'height') || getIframeAttribute(iframeTag, 'style'))
      }
    }
  }

  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return { kind: 'html', srcDoc: buildEmbedSrcDoc(raw), title: 'Codigo embed', allow: DEFAULT_EMBED_ALLOW, height: 0 }
  }

  return { kind: 'empty' }
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

function normalizeSitePages(site) {
  const rawPages = Array.isArray(site?.theme?.pages) ? site.theme.pages : []
  const seen = new Set()
  const pages = rawPages
    .map((page, index) => ({
      id: cleanString(page?.id) || `${DEFAULT_FUNNEL_PAGE_ID}-${index + 1}`,
      title: cleanString(page?.title) || `Pagina ${index + 1}`,
      sortOrder: Number.isFinite(Number(page?.sortOrder)) ? Number(page.sortOrder) : index,
      metaCapiEnabled: Boolean(normalizeBoolean(page?.metaCapiEnabled ?? page?.meta_capi_enabled)),
      metaEventName: normalizeSiteMetaEventName(page?.metaEventName || page?.meta_event_name, { allowNone: true, fallback: SITE_META_NO_EVENT }),
      metaTrigger: normalizeSiteMetaTrigger(page?.metaTrigger || page?.meta_trigger)
    }))
    .filter(page => {
      if (!page.id || seen.has(page.id)) return false
      seen.add(page.id)
      return true
    })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((page, index) => ({ ...page, sortOrder: index }))

  return pages.length ? pages : [{ id: DEFAULT_FUNNEL_PAGE_ID, title: 'Pagina 1', sortOrder: 0 }]
}

function getBlockPageId(block, pages) {
  const pageId = cleanString(block?.settings?.pageId || block?.settings?.page_id)
  return pages.some(page => page.id === pageId) ? pageId : pages[0]?.id || DEFAULT_FUNNEL_PAGE_ID
}

function getPageBlocks(site, pageId) {
  const blocks = Array.isArray(site?.blocks) ? site.blocks : []
  if (site?.siteType !== 'landing_page') return blocks

  const pages = normalizeSitePages(site)
  const activePage = pages.find(page => page.id === pageId) || pages[0]
  return blocks.filter(block => getBlockPageId(block, pages) === activePage.id)
}

function isSectionBlock(block) {
  return block && block.blockType === 'section'
}

function getSectionColumns(block) {
  const value = Number(block?.settings?.sectionColumns ?? block?.settings?.columns)
  if (!Number.isFinite(value)) return 1
  return Math.min(3, Math.max(1, Math.round(value)))
}

function getBlockSectionId(block) {
  return cleanString(block?.settings?.sectionId || block?.settings?.section_id)
}

function getBlockSectionColumn(block) {
  const value = Number(block?.settings?.sectionColumn ?? block?.settings?.section_column)
  if (!Number.isFinite(value)) return 0
  return Math.min(2, Math.max(0, Math.round(value)))
}

function makeLandingSectionLane(section, sortOrder) {
  const columns = section ? getSectionColumns(section) : 1
  return {
    id: section?.id || '__legacy-section__',
    section,
    columns,
    columnBlocks: Array.from({ length: columns }, () => []),
    sortOrder
  }
}

function buildLandingSectionLanes(pageBlocks = []) {
  const sortedBlocks = [...pageBlocks].sort((a, b) => a.sortOrder - b.sortOrder)
  const lanes = sortedBlocks
    .filter(isSectionBlock)
    .map(block => makeLandingSectionLane(block, block.sortOrder))
  const laneById = new Map(lanes.map(lane => [lane.id, lane]))
  let legacyLane = null

  const ensureLegacyLane = () => {
    if (!legacyLane) {
      legacyLane = makeLandingSectionLane(null, -1)
      lanes.unshift(legacyLane)
    }
    return legacyLane
  }

  for (const block of sortedBlocks) {
    if (isSectionBlock(block)) continue

    const explicitSectionId = getBlockSectionId(block)
    const explicitLane = explicitSectionId ? laneById.get(explicitSectionId) : null
    const previousLane = explicitLane || [...lanes]
      .filter(lane => lane.section && lane.sortOrder <= block.sortOrder)
      .sort((a, b) => b.sortOrder - a.sortOrder)[0]
    const lane = previousLane || ensureLegacyLane()
    const columnIndex = Math.min(lane.columns - 1, getBlockSectionColumn(block))
    lane.columnBlocks[columnIndex].push(block)
  }

  return lanes
    .filter(lane => lane.section || lane.columnBlocks.some(column => column.length > 0))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map(lane => ({
      ...lane,
      columnBlocks: lane.columnBlocks.map(column => [...column].sort((a, b) => a.sortOrder - b.sortOrder))
    }))
}

function getNextPage(site, pageId) {
  const pages = normalizeSitePages(site)
  const index = pages.findIndex(page => page.id === pageId)
  return index >= 0 ? pages[index + 1] || null : pages[1] || null
}

function pageHref(pageId) {
  return `?page=${encodeURIComponent(pageId)}`
}

function getSitePage(site, pageId) {
  const pages = normalizeSitePages(site)
  const requestedPageId = cleanString(pageId)
  return pages.find(page => page.id === requestedPageId) || pages[0] || null
}

function getPageMetaConfig(site, pageId) {
  if (!site || site.siteType !== 'landing_page') return null
  const page = getSitePage(site, pageId)
  if (!page || !page.metaCapiEnabled) return null
  const eventName = normalizeSiteMetaEventName(page.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
  if (eventName === SITE_META_NO_EVENT) return null

  return {
    page,
    eventName,
    trigger: normalizeSiteMetaTrigger(page.metaTrigger)
  }
}

function getFormSubmitMetaEventName(site, pageId) {
  if (site?.siteType === 'landing_page') {
    const page = getSitePage(site, pageId)
    if (page?.metaCapiEnabled && normalizeSiteMetaTrigger(page.metaTrigger) === 'form_submit') {
      return normalizeSiteMetaEventName(page.metaEventName, { allowNone: true, fallback: SITE_META_NO_EVENT })
    }
    return SITE_META_NO_EVENT
  }

  return normalizeSiteMetaEventName(site.metaEventName, { allowNone: true })
}

function resolveButtonHref(settings = {}, context = {}) {
  const action = cleanString(settings.buttonAction || settings.button_action || 'url')
  if (action === 'next_page') {
    const nextPage = getNextPage(context.site, context.pageId)
    if (nextPage) return pageHref(nextPage.id)
  }

  if (action === 'specific_page') {
    const pages = normalizeSitePages(context.site)
    const targetPageId = cleanString(settings.buttonPageId || settings.button_page_id)
    const targetPage = pages.find(page => page.id === targetPageId)
    if (targetPage) return pageHref(targetPage.id)
  }

  return safeHref(settings.buttonUrl, '#form')
}

function getFormCompletionAction(blocks = []) {
  const formBlock = blocks.find(block => block.blockType === 'form_embed')
  const action = cleanString(formBlock?.settings?.completionAction || formBlock?.settings?.completion_action)
  return ['next_page', 'next_page_if_qualified', 'form_default'].includes(action) ? action : 'form_default'
}

function getNativeFormContext(site, blocks = []) {
  if (!site || site.siteType !== 'landing_page') {
    return {
      formSiteId: site?.id || null,
      formSiteName: site?.name || null
    }
  }

  const formBlock = blocks.find(block => block.blockType === 'form_embed')
  if (!formBlock) {
    return {
      formSiteId: null,
      formSiteName: null
    }
  }

  const settings = formBlock.settings || {}
  return {
    formSiteId: cleanString(settings.embeddedSiteId || settings.formSiteId || settings.form_site_id) || `${site.id}:form_embed:${formBlock.id}`,
    formSiteName: cleanString(settings.embeddedSiteName || settings.formSiteName || settings.form_site_name) || cleanString(formBlock.label) || `Formulario de ${site.name}`
  }
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function buildNativeSiteTrackingScript(context) {
  return `
  <script>
    (() => {
      const RSTK_CONTEXT = ${scriptJson(context)};
      const ENDPOINT = '/collect';

      const readJson = (storage, key) => {
        try {
          const raw = storage.getItem(key);
          return raw ? JSON.parse(raw) : {};
        } catch (_) {
          return {};
        }
      };

      const writeJson = (storage, key, value) => {
        try {
          storage.setItem(key, JSON.stringify(value));
        } catch (_) {}
      };

      const generateId = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        for (let i = 0; i < 20; i += 1) {
          id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return id;
      };

      const generateSessionId = () => {
        if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
          const random = Math.random() * 16 | 0;
          const value = char === 'x' ? random : (random & 0x3 | 0x8);
          return value.toString(16);
        });
      };

      const getVisitorId = () => {
        const data = readJson(localStorage, 'ristak');
        if (!data.visitor_id) {
          data.visitor_id = generateId();
          data.first_visit = new Date().toISOString();
          writeJson(localStorage, 'ristak', data);
        }
        return data.visitor_id;
      };

      const getSessionId = () => {
        const data = readJson(sessionStorage, 'ristak');
        if (!data.session_id) {
          data.session_id = generateSessionId();
          data.session_start = Date.now();
          writeJson(sessionStorage, 'ristak', data);
        }
        return data.session_id;
      };

      const rememberContact = (contact) => {
        if (!contact || !contact.contactId) return;
        const data = readJson(localStorage, 'ristak');
        data.contact_id = contact.contactId;
        data.contact_email = contact.email || data.contact_email || null;
        data.contact_name = contact.fullName || data.contact_name || null;
        data.contact_synced_at = new Date().toISOString();
        writeJson(localStorage, 'ristak', data);
      };

      const getSavedContactId = () => {
        const data = readJson(localStorage, 'ristak');
        return data.contact_id || null;
      };

      const getParams = () => {
        const params = {};
        const searchParams = new URLSearchParams(window.location.search || '');
        searchParams.forEach((value, key) => {
          if (
            key.indexOf('utm_') === 0 ||
            ['gclid', 'fbclid', 'msclkid', 'ttclid', 'wbraid', 'gbraid', 'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name', 'placement', 'site_source_name', 'campaignid', 'adgroupid', 'creative', 'keyword', 'matchtype', 'network', 'device', 'target'].includes(key)
          ) {
            params[key] = value;
          }
        });
        return params;
      };

      const getFacebookCookies = () => {
        const cookies = {};
        try {
          document.cookie.split(';').forEach((part) => {
            const pieces = part.trim().split('=');
            const name = pieces[0];
            const value = pieces.slice(1).join('=');
            if (name === '_fbc') cookies.fbc = value;
            if (name === '_fbp') cookies.fbp = value;
          });
        } catch (_) {}
        return cookies;
      };

      const getDeviceType = () => {
        const ua = navigator.userAgent || '';
        if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'tablet';
        if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(ua)) return 'mobile';
        return 'desktop';
      };

      const getBrowserInfo = () => {
        const ua = navigator.userAgent || '';
        let browser = 'Unknown';
        let version = '';
        let match = null;
        if (ua.indexOf('Edg/') > -1) {
          browser = 'Edge';
          match = ua.match(/Edg\\/([\\d.]+)/);
        } else if (ua.indexOf('Chrome/') > -1 && ua.indexOf('Edg/') === -1) {
          browser = 'Chrome';
          match = ua.match(/Chrome\\/([\\d.]+)/);
        } else if (ua.indexOf('Safari/') > -1 && ua.indexOf('Chrome') === -1) {
          browser = 'Safari';
          match = ua.match(/Version\\/([\\d.]+)/);
        } else if (ua.indexOf('Firefox/') > -1) {
          browser = 'Firefox';
          match = ua.match(/Firefox\\/([\\d.]+)/);
        } else if (ua.indexOf('OPR/') > -1 || ua.indexOf('Opera/') > -1) {
          browser = 'Opera';
          match = ua.match(/(?:OPR|Opera)\\/([\\d.]+)/);
        }
        version = match ? match[1] : '';
        return { browser, browser_version: version };
      };

      const getOS = () => {
        const ua = navigator.userAgent || '';
        if (ua.indexOf('Windows NT 10.0') > -1) return 'Windows 10';
        if (ua.indexOf('Windows') > -1) return 'Windows';
        if (ua.indexOf('Mac OS X') > -1) {
          const match = ua.match(/Mac OS X ([\\d_]+)/);
          return match ? 'macOS ' + match[1].replace(/_/g, '.') : 'macOS';
        }
        if (ua.indexOf('Android') > -1) {
          const match = ua.match(/Android ([\\d.]+)/);
          return match ? 'Android ' + match[1] : 'Android';
        }
        if (ua.indexOf('iPhone') > -1 || ua.indexOf('iPad') > -1) return 'iOS';
        if (ua.indexOf('Linux') > -1) return 'Linux';
        return 'Unknown';
      };

      const buildTrackingData = (extra = {}) => {
        const browserInfo = getBrowserInfo();
        return Object.assign({
          tracking_source: 'native_site',
          site_id: RSTK_CONTEXT.siteId,
          site_slug: RSTK_CONTEXT.siteSlug,
          site_name: RSTK_CONTEXT.siteName,
          site_type: RSTK_CONTEXT.siteType,
          form_site_id: RSTK_CONTEXT.formSiteId,
          form_site_name: RSTK_CONTEXT.formSiteName,
          public_page_id: RSTK_CONTEXT.pageId,
          public_page_title: RSTK_CONTEXT.pageTitle,
          url: window.location.href,
          referrer: document.referrer || null,
          title: document.title || null,
          device_type: getDeviceType(),
          browser: browserInfo.browser,
          browser_version: browserInfo.browser_version,
          os: getOS(),
          language: navigator.language || navigator.userLanguage || null,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
          user_agent: navigator.userAgent
        }, getParams(), getFacebookCookies(), extra);
      };

      const sendEvent = (eventName, extra = {}) => {
        const payload = {
          visitor_id: getVisitorId(),
          session_id: getSessionId(),
          contact_id: extra.contact_id || getSavedContactId(),
          event_name: eventName,
          ts: Date.now(),
          data: buildTrackingData(extra)
        };
        fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true
        }).catch(() => {});
      };

      window.ristakNativeIdentity = () => ({ visitorId: getVisitorId(), sessionId: getSessionId() });
      window.ristakNativeBuildData = buildTrackingData;
      window.ristakNativeRememberContact = rememberContact;
      window.ristakNativeTrack = sendEvent;

      const emitView = () => sendEvent('native_site_view');
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(emitView, 0);
      } else {
        document.addEventListener('DOMContentLoaded', emitView, { once: true });
      }
    })();
  </script>`
}

const RSTK_ICONS = {
  check: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cross: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  verified: '<svg class="rstk-verified" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M12 2.2l2.3 1.7 2.85.05.95 2.7 2.25 1.8-.95 2.75.95 2.75-2.25 1.8-.95 2.7L14.3 18.6 12 20.3l-2.3-1.7-2.85-.05-.95-2.7-2.25-1.8.95-2.75-.95-2.75 2.25-1.8.95-2.7L9.7 3.9z"/><path d="M8.4 12.3l2.4 2.4 4.8-4.9" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5.4" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.6" cy="6.4" r="1.25" fill="currentColor"/></svg>',
  music: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M9 17.2a3.1 3.1 0 1 1-2-2.9V5l9-2v9.2a3.1 3.1 0 1 1-2-2.9V6.6L9 7.8z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><rect x="4.5" y="10.5" width="15" height="10" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'
}

function getItemTone(item) {
  const raw = String(item.title || item.text || '').trim()
  if (/^[+✓✔]/.test(raw)) return 'pro'
  if (/^[-–—✗✘x×]/i.test(raw)) return 'con'
  return 'neutral'
}

function stripToneMarker(value) {
  return String(value || '').replace(/^\s*[+\-–—✓✔✗✘x×]\s*/i, '').trim()
}

function blockSettingColor(settings, key) {
  return normalizeCssColor(settings && settings[key], '')
}

function blockSettingPaint(settings, key) {
  return normalizeCssPaint(settings && settings[key], '')
}

function blockSettingNumber(settings, key, min, max) {
  const value = Number(settings && settings[key])
  if (!Number.isFinite(value)) return null
  return Math.min(max, Math.max(min, value))
}

const SPACING_SIDES = ['Top', 'Right', 'Bottom', 'Left']

function hasSpacingSideValue(settings, base) {
  return SPACING_SIDES.some(side => settings && settings[`${base}${side}`] !== undefined)
}

function blockSpacingValue(settings, base, side, fallback, min, max) {
  const sideValue = blockSettingNumber(settings, `${base}${side}`, min, max)
  if (sideValue !== null) return sideValue

  const baseValue = blockSettingNumber(settings, base, min, max)
  if (baseValue !== null) return baseValue

  return fallback
}

function renderBlockSpacing(settings, base, fallback, min, max) {
  if (!settings || (settings[base] === undefined && !hasSpacingSideValue(settings, base))) return ''
  return SPACING_SIDES
    .map(side => `${blockSpacingValue(settings, base, side, fallback, min, max)}px`)
    .join(' ')
}

function themeNumber(theme, key, fallback, min, max) {
  const value = Number(theme && theme[key])
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function themeColor(theme, key) {
  return normalizeCssColor(theme && theme[key], '')
}

function blockHorizontalAlign(settings, key, fallback = 'left') {
  const value = cleanString(settings && settings[key])
  return ['left', 'center', 'right'].includes(value) ? value : fallback
}

function blockButtonAlign(settings, fallback = 'center') {
  const value = cleanString(settings && settings.buttonAlign)
  return ['left', 'center', 'right', 'full'].includes(value) ? value : fallback
}

function justifyForAlign(align) {
  if (align === 'center') return 'center'
  if (align === 'right') return 'end'
  if (align === 'full') return 'stretch'
  return 'start'
}

function marginForAlign(align) {
  if (align === 'center') return { left: 'auto', right: 'auto' }
  if (align === 'right') return { left: 'auto', right: '0' }
  return { left: '0', right: align === 'full' ? '0' : 'auto' }
}

function renderBlockStyleVars(block) {
  const settings = block.settings || {}
  const vars = []
  const blockBg = blockSettingPaint(settings, 'blockBg')
  const blockText = blockSettingColor(settings, 'blockText')
  const blockBorder = blockSettingColor(settings, 'blockBorderColor')
  const buttonBg = blockSettingPaint(settings, 'buttonBg')
  const buttonText = blockSettingColor(settings, 'buttonTextColor')
  const buttonBorder = blockSettingColor(settings, 'buttonBorderColor')
  const cardBg = blockSettingPaint(settings, 'cardBg')
  const cardBorder = blockSettingColor(settings, 'cardBorderColor')
  const fieldBg = blockSettingPaint(settings, 'fieldBg')
  const fieldBorder = blockSettingColor(settings, 'fieldBorder')
  const fontFamily = cleanString(settings.fontFamily)
  const fontSize = blockSettingNumber(settings, 'fontSize', 12, 72)
  const contentMaxWidth = blockSettingNumber(settings, 'contentMaxWidth', 10, 120)
  const blockPadding = renderBlockSpacing(settings, 'blockPadding', 0, 0, 160)
  const blockMargin = renderBlockSpacing(settings, 'blockMargin', 0, -80, 200)
  const blockRadius = blockSettingNumber(settings, 'blockRadius', 0, 48)
  const blockBorderWidth = blockSettingNumber(settings, 'blockBorderWidth', 0, 12)
  const buttonRadius = blockSettingNumber(settings, 'buttonRadius', 0, 80)
  const buttonHeight = blockSettingNumber(settings, 'buttonHeight', 34, 88)
  const buttonPaddingX = blockSettingNumber(settings, 'buttonPaddingX', 8, 72)
  const buttonFontSize = blockSettingNumber(settings, 'buttonFontSize', 11, 32)
  const buttonBorderWidth = blockSettingNumber(settings, 'buttonBorderWidth', 0, 8)
  const mediaWidth = blockSettingNumber(settings, 'mediaWidth', 30, 100)
  const mediaRadius = blockSettingNumber(settings, 'mediaRadius', 0, 48)
  const embedHeight = blockSettingNumber(settings, 'embedHeight', EMBED_MIN_HEIGHT, EMBED_MAX_HEIGHT)
  const cardRadius = blockSettingNumber(settings, 'cardRadius', 0, 48)
  const cardBorderWidth = blockSettingNumber(settings, 'cardBorderWidth', 0, 8)
  const listColumns = blockSettingNumber(settings, 'listColumns', 1, 4)
  const fieldRadius = blockSettingNumber(settings, 'fieldRadius', 0, 32)
  const sectionGap = blockSettingNumber(settings, 'sectionGap', 0, 80)
  const blockHasNativeBorder = ['hero', 'section', 'cta', 'benefits', 'testimonials', 'services', 'faq', 'form_embed', 'image', 'video', 'embed', 'calendar_embed'].includes(block.blockType)
  const supportsButton = ['hero', 'button', 'cta'].includes(block.blockType)

  if (blockBg) vars.push(`--rstk-block-bg:${blockBg}`)
  if (blockText) vars.push(`--rstk-block-text:${blockText}`)
  if (blockBorder) vars.push(`--rstk-block-border:${blockBorder}`)
  if (buttonBg) {
    vars.push(`--rstk-button-bg:${buttonBg}`)
    vars.push(`--rstk-button-hover-bg:${buttonBg}`)
  }
  if (buttonText) vars.push(`--rstk-button-text:${buttonText}`)
  if (buttonBorder) vars.push(`--rstk-button-border:${buttonBorder}`)
  if (cardBg) vars.push(`--rstk-card-bg:${cardBg}`)
  if (cardBorder) vars.push(`--rstk-card-border:${cardBorder}`)
  if (fieldBg) vars.push(`--rstk-field-bg:${fieldBg}`)
  if (fieldBorder) vars.push(`--rstk-field-border:${fieldBorder}`)
  if (fontFamily) vars.push(`--rstk-block-font:${fontFamily.replace(/[;"{}<>]/g, '')}`)
  if (settings.fontWeight === 'bold') vars.push('--rstk-block-weight:850')
  if (settings.textAlign !== undefined) {
    const align = blockHorizontalAlign(settings, 'textAlign', 'left')
    const margins = marginForAlign(align)
    vars.push(`--rstk-block-align:${align}`)
    vars.push(`--rstk-block-justify:${justifyForAlign(align)}`)
    vars.push(`--rstk-content-margin-left:${margins.left}`)
    vars.push(`--rstk-content-margin-right:${margins.right}`)
  }
  if (fontSize !== null) vars.push(`--rstk-block-size:${fontSize}px`)
  if (contentMaxWidth !== null) vars.push(`--rstk-content-max:${contentMaxWidth}ch`)
  if (blockPadding) vars.push(`--rstk-block-pad:${blockPadding}`)
  if (blockMargin) vars.push(`--rstk-block-margin:${blockMargin}`)
  if (blockRadius !== null) vars.push(`--rstk-block-radius:${blockRadius}px`)
  if (blockBorderWidth !== null) {
    vars.push(`--rstk-block-border-width:${blockBorderWidth}px`)
    if (!blockHasNativeBorder) vars.push(`--rstk-block-shell-border-width:${blockBorderWidth}px`)
  }
  if (supportsButton) {
    const align = blockButtonAlign(settings, 'center')
    const margins = marginForAlign(align)
    vars.push(`--rstk-button-justify:${justifyForAlign(align)}`)
    vars.push(`--rstk-button-margin-left:${margins.left}`)
    vars.push(`--rstk-button-margin-right:${margins.right}`)
    vars.push(`--rstk-button-width:${align === 'full' ? '100%' : 'fit-content'}`)
  }
  if (buttonRadius !== null) vars.push(`--rstk-block-button-radius:${buttonRadius}px`)
  if (buttonHeight !== null) vars.push(`--rstk-button-height:${buttonHeight}px`)
  if (buttonPaddingX !== null) vars.push(`--rstk-button-pad-x:${buttonPaddingX}px`)
  if (buttonFontSize !== null) vars.push(`--rstk-button-size:${buttonFontSize}px`)
  if (buttonBorderWidth !== null) vars.push(`--rstk-button-border-width:${buttonBorderWidth}px`)
  if (mediaWidth !== null) vars.push(`--rstk-media-width:${mediaWidth}%`)
  if (settings.mediaAlign !== undefined) {
    const align = blockHorizontalAlign(settings, 'mediaAlign', 'center')
    const margins = marginForAlign(align)
    vars.push(`--rstk-media-justify:${justifyForAlign(align)}`)
    vars.push(`--rstk-media-margin-left:${margins.left}`)
    vars.push(`--rstk-media-margin-right:${margins.right}`)
  }
  if (mediaRadius !== null) vars.push(`--rstk-media-radius:${mediaRadius}px`)
  if (embedHeight !== null) vars.push(`--rstk-embed-height:${embedHeight}px`)
  if (cardRadius !== null) vars.push(`--rstk-card-radius:${cardRadius}px`)
  if (cardBorderWidth !== null) vars.push(`--rstk-card-border-width:${cardBorderWidth}px`)
  if (listColumns !== null) vars.push(`--rstk-list-columns:repeat(${listColumns},minmax(0,1fr))`)
  if (settings.cardAlign !== undefined) vars.push(`--rstk-card-align:${blockHorizontalAlign(settings, 'cardAlign', 'left')}`)
  if (fieldRadius !== null) vars.push(`--rstk-field-radius:${fieldRadius}px`)
  if (block.blockType === 'section') {
    vars.push(`--rstk-section-columns:${getSectionColumns(block)}`)
    if (sectionGap !== null) vars.push(`--rstk-section-gap:${sectionGap}px`)
  }

  return vars.length ? ` style="${escapeHtml(vars.join(';'))}"` : ''
}

function renderBlockStyleClassName(block) {
  const settings = block.settings || {}
  const classes = [
    'rstk-block-style',
    cleanString(settings.fontFamily) ? 'rstkFontOverride' : '',
    settings.fontSize !== undefined ? 'rstkSizeOverride' : '',
    settings.fontWeight === 'bold' ? 'rstkWeightOverride' : ''
  ].filter(Boolean)

  return classes.join(' ')
}

function wrapRenderedBlock(block, html) {
  const style = renderBlockStyleVars(block)
  const className = renderBlockStyleClassName(block)
  return style ? `<div class="${escapeHtml(className)}"${style}>${html}</div>` : html
}

function renderPublicBlock(block, context = {}) {
  const html = FIELD_BLOCK_TYPES.has(block.blockType)
    ? renderFieldBlock(block, context.isInteractive)
    : renderContentBlock(block, context)
  return wrapRenderedBlock(block, html)
}

function renderLandingSectionLane(lane, context = {}) {
  const columnsHtml = lane.columnBlocks.map((columnBlocks, index) => `
    <div class="rstk-section-column" data-section-column="${index}">
      ${columnBlocks.map(block => renderPublicBlock(block, context)).join('\n')}
    </div>
  `).join('\n')

  if (!lane.section) {
    return `
      <section class="rstk-section-lane rstk-section-lane-legacy">
        <div class="rstk-section-inner">
          <div class="rstk-section-columns">
            ${columnsHtml}
          </div>
        </div>
      </section>
    `
  }

  const section = lane.section
  const settings = section.settings || {}
  const style = renderBlockStyleVars(section)
  const className = `${renderBlockStyleClassName(section)} rstk-section-lane`
  const hasHeading = cleanString(section.content) || cleanString(settings.subtitle)
  const heading = hasHeading
    ? `
      <div class="rstk-section-heading">
        ${cleanString(section.content) ? `<h2>${escapeHtml(section.content)}</h2>` : ''}
        ${cleanString(settings.subtitle) ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
      </div>
    `
    : ''

  return `
    <section class="${escapeHtml(className)}"${style}>
      <div class="rstk-section-inner">
        ${heading}
        <div class="rstk-section-columns">
          ${columnsHtml}
        </div>
      </div>
    </section>
  `
}

function renderContentBlock(block, context = {}) {
  const content = escapeHtml(block.content)
  const settings = block.settings || {}

  if (block.blockType === 'headline' || block.blockType === 'title') {
    return `<h1 class="rstk-headline">${content || escapeHtml(block.label)}</h1>`
  }

  if (block.blockType === 'section') {
    return `
      <section class="rstk-section-break">
        <h2>${content || escapeHtml(block.label || 'Nueva seccion')}</h2>
        ${settings.subtitle ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
      </section>
    `
  }

  if (block.blockType === 'subheading' || block.blockType === 'subtitle' || block.blockType === 'description') {
    return `<p class="rstk-subheading">${content || escapeHtml(block.label)}</p>`
  }

  if (block.blockType === 'hero') {
    const buttonUrl = resolveButtonHref(settings, context)
    return `
      <section class="rstk-hero">
        ${settings.kicker ? `<p class="rstk-kicker">${escapeHtml(settings.kicker)}</p>` : ''}
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
      : `<div class="rstk-media rstk-media-empty"><span class="rstk-play">${RSTK_ICONS.play}</span>Agrega la URL del video</div>`
  }

  if (block.blockType === 'button') {
    const buttonUrl = resolveButtonHref(settings, context)
    return `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}">${escapeHtml(settings.buttonText || block.content || block.label || 'Continuar')}</a>`
  }

  if (block.blockType === 'benefits') {
    const items = getItems(settings)
    const heading = content || escapeHtml(block.label)
    return `
      <section class="rstk-section-list rstk-checklist">
        ${heading ? `<h2>${heading}</h2>` : ''}
        <ul class="rstk-check-list">
          ${items.map(item => {
            const tone = getItemTone(item)
            const icon = tone === 'con' ? RSTK_ICONS.cross : RSTK_ICONS.check
            const title = escapeHtml(stripToneMarker(item.title))
            const text = escapeHtml(stripToneMarker(item.text))
            return `
              <li class="rstk-check rstk-check-${tone}">
                <span class="rstk-check-icon" aria-hidden="true">${icon}</span>
                <span class="rstk-check-body">
                  ${title ? `<strong>${title}</strong>` : ''}
                  ${text ? `<span>${text}</span>` : ''}
                </span>
              </li>
            `
          }).join('')}
        </ul>
      </section>
    `
  }

  if (['testimonials', 'services', 'faq'].includes(block.blockType)) {
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
    const buttonUrl = resolveButtonHref(settings, context)
    return `
      <section class="rstk-cta">
        <h2>${content || escapeHtml(block.label)}</h2>
        ${settings.subtitle ? `<p>${escapeHtml(settings.subtitle)}</p>` : ''}
        ${settings.buttonText ? `<a class="rstk-button-link" href="${escapeHtml(buttonUrl)}">${escapeHtml(settings.buttonText)}</a>` : ''}
      </section>
    `
  }

  if (block.blockType === 'calendar_embed') {
    const calendarSlug = cleanString(settings.calendarSlug || settings.calendar_slug || block.content)
    if (!calendarSlug) {
      return `<div class="rstk-embed rstk-embed-empty">Selecciona un calendario para embeber</div>`
    }

    const calendarName = cleanString(settings.calendarName || settings.calendar_name || block.label || 'Calendario')
    return `<iframe class="rstk-embed rstk-calendar-embed" src="/calendar/${encodeURIComponent(calendarSlug)}?test=1" title="${escapeHtml(calendarName)}" loading="lazy" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>`
  }

  if (block.blockType === 'embed') {
    const embed = resolveEmbedContent(block.content)
    if (embed.kind === 'empty') {
      return `<div class="rstk-embed rstk-embed-empty">Pega una URL, iframe o codigo embed/html</div>`
    }

    const heightStyle = embed.height ? ` style="min-height:${embed.height}px"` : ''
    if (embed.kind === 'url') {
      return `<iframe class="rstk-embed" src="${escapeHtml(embed.src)}" title="${escapeHtml(embed.title)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" sandbox="${EMBED_SANDBOX_URL}" allow="${escapeHtml(embed.allow || DEFAULT_EMBED_ALLOW)}" allowfullscreen${heightStyle}></iframe>`
    }

    return `<iframe class="rstk-embed rstk-embed-code" srcdoc="${escapeHtml(embed.srcDoc)}" title="${escapeHtml(embed.title)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" sandbox="${EMBED_SANDBOX_HTML}" allow="${escapeHtml(embed.allow || DEFAULT_EMBED_ALLOW)}"${heightStyle}></iframe>`
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

const RSTK_SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, 'Apple Color Emoji', 'Segoe UI Emoji', sans-serif"

const SITE_TEMPLATES = {
  ristak: {
    id: 'ristak',
    label: 'Ristak minimal',
    mode: 'light',
    chrome: 'none',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f5f6f8',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f8fafc',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '12px',
      radiusLg: '18px',
      shadow: '0 30px 60px -42px rgba(15,23,42,.4)',
      headingWeight: '800',
      btnRadius: '12px',
      btnWeight: '750'
    }
  },

  facebook: {
    id: 'facebook',
    label: 'Facebook',
    mode: 'light',
    chrome: 'facebook',
    font: RSTK_SANS,
    vars: {
      pageBg: '#f0f2f5',
      pageImage: 'none',
      ink: '#1c1e21',
      muted: '#65676b',
      surface: '#ffffff',
      surface2: '#f7f8fa',
      border: '#ced0d4',
      accent: '#1877f2',
      accentStrong: '#166fe5',
      onAccent: '#ffffff',
      ring: 'rgba(24,119,242,.22)',
      inputBg: '#ffffff',
      inputInk: '#1c1e21',
      inputBorder: '#ccd0d5',
      radius: '8px',
      radiusLg: '12px',
      shadow: '0 1px 2px rgba(0,0,0,.1), 0 22px 48px -34px rgba(0,0,0,.5)',
      headingWeight: '800',
      btnRadius: '8px',
      btnWeight: '800'
    }
  },

  instagram: {
    id: 'instagram',
    label: 'Instagram',
    mode: 'light',
    chrome: 'instagram',
    font: RSTK_SANS,
    gradient: 'linear-gradient(45deg, #feda75, #fa7e1e, #d62976, #962fbf, #4f5bd5)',
    vars: {
      pageBg: '#fafafa',
      pageImage: 'none',
      ink: '#262626',
      muted: '#8e8e8e',
      surface: '#ffffff',
      surface2: '#fafafa',
      border: '#dbdbdb',
      accent: '#0095f6',
      accentStrong: '#1877f2',
      onAccent: '#ffffff',
      ring: 'rgba(0,149,246,.2)',
      inputBg: '#ffffff',
      inputInk: '#262626',
      inputBorder: '#dbdbdb',
      radius: '12px',
      radiusLg: '16px',
      shadow: '0 24px 54px -38px rgba(0,0,0,.45)',
      headingWeight: '800',
      btnRadius: '10px',
      btnWeight: '800'
    }
  },

  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    mode: 'dark',
    chrome: 'tiktok',
    font: RSTK_SANS,
    cyan: '#25f4ee',
    vars: {
      pageBg: '#000000',
      pageImage: 'none',
      ink: '#ffffff',
      muted: '#a1a1aa',
      surface: '#161616',
      surface2: '#1f1f1f',
      border: 'rgba(255,255,255,.12)',
      accent: '#fe2c55',
      accentStrong: '#ef1f49',
      onAccent: '#ffffff',
      ring: 'rgba(254,44,85,.32)',
      inputBg: '#1f1f1f',
      inputInk: '#ffffff',
      inputBorder: 'rgba(255,255,255,.16)',
      radius: '10px',
      radiusLg: '18px',
      shadow: '0 36px 70px -42px rgba(0,0,0,.9)',
      headingWeight: '900',
      btnRadius: '10px',
      btnWeight: '800'
    }
  },

  vsl: {
    id: 'vsl',
    label: 'Carta de ventas (VSL)',
    mode: 'light',
    chrome: 'none',
    centered: true,
    font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f8fafc',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.16)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '14px',
      radiusLg: '22px',
      shadow: '0 50px 90px -46px rgba(0,0,0,.75)',
      headingWeight: '800',
      btnRadius: '14px',
      btnWeight: '800'
    }
  },

  interactive: {
    id: 'interactive',
    label: 'Interactivo',
    mode: 'light',
    chrome: 'none',
    centered: true,
    font: RSTK_SANS,
    vars: {
      pageBg: '#0a0b0d',
      pageImage: 'none',
      ink: '#0f172a',
      muted: '#64748b',
      surface: '#ffffff',
      surface2: '#f6f7f9',
      border: '#e6e8ec',
      accent: '#111827',
      accentStrong: '#000000',
      onAccent: '#ffffff',
      ring: 'rgba(17,24,39,.14)',
      inputBg: '#ffffff',
      inputInk: '#0f172a',
      inputBorder: '#dfe3e8',
      radius: '14px',
      radiusLg: '24px',
      shadow: '0 60px 100px -52px rgba(0,0,0,.8)',
      headingWeight: '800',
      btnRadius: '14px',
      btnWeight: '800'
    }
  }
}

function resolveTemplate(site) {
  const id = cleanString(site && site.theme && site.theme.template)
  if (id && SITE_TEMPLATES[id]) return SITE_TEMPLATES[id]
  if (site && site.siteType === 'interactive_form') return SITE_TEMPLATES.interactive
  return SITE_TEMPLATES.ristak
}

function getBrand(site, template) {
  const theme = (site && site.theme) || {}
  const name = cleanString(theme.brandName) || cleanString(site && site.title) || cleanString(site && site.name) || 'Tu marca'
  const subtitleDefault = template.chrome === 'instagram' ? 'Publicacion pagada' : 'Patrocinado'
  const subtitle = cleanString(theme.brandSubtitle) || subtitleDefault
  const avatarUrl = safeUrl(theme.brandAvatar)
  const followers = cleanString(theme.followers || theme.followersCount || theme.followerCount)
  const verified = theme.brandVerified === undefined ? true : normalizeBoolean(theme.brandVerified) === 1
  const handle = (slugify(name) || 'marca').replace(/-/g, '')
  const initial = (name.trim()[0] || 'R').toUpperCase()
  return { name, subtitle, avatarUrl, followers, verified, handle, initial }
}

function renderAvatar(brand) {
  if (brand.avatarUrl) {
    return `<span class="rstk-avatar"><img src="${escapeHtml(brand.avatarUrl)}" alt="${escapeHtml(brand.name)}"></span>`
  }
  return `<span class="rstk-avatar">${escapeHtml(brand.initial)}</span>`
}

function getSocialPlatformIcon(platform) {
  if (platform === 'instagram') return RSTK_ICONS.camera
  if (platform === 'tiktok') return RSTK_ICONS.music
  return ''
}

function renderBrandChrome(template, brand) {
  const platform = template.chrome
  if (platform === 'facebook' || platform === 'instagram' || platform === 'tiktok') {
    const platformLabel = platform === 'facebook' ? 'Facebook' : platform === 'instagram' ? 'Instagram' : 'TikTok'
    const secondary = brand.followers ? `${escapeHtml(brand.followers)} seguidores` : escapeHtml(brand.subtitle)
    return `
      <header class="rstk-chrome rstk-social-profile rstk-social-profile-${platform}" aria-label="Perfil de ${platformLabel}">
        <div class="rstk-social-image">
          ${renderAvatar(brand)}
          <span class="rstk-social-platform rstk-social-platform-${platform}" aria-hidden="true">${getSocialPlatformIcon(platform)}</span>
        </div>
        <div class="rstk-social-details">
          <div class="rstk-social-name">${escapeHtml(brand.name)}${brand.verified ? RSTK_ICONS.verified : ''}</div>
          <div class="rstk-social-followers">${secondary}</div>
        </div>
      </header>
    `
  }

  return ''
}

function renderLegalFooter(brand) {
  return `
    <p class="rstk-footer">
      <span class="rstk-lock" aria-hidden="true">${RSTK_ICONS.lock}</span>
      Tu informacion esta protegida. ${escapeHtml(brand.name)} no la comparte con terceros.
    </p>
  `
}

const RSTK_BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box}
  [hidden]{display:none !important}
  html{-webkit-text-size-adjust:100%}
  body{
    margin:0;min-height:100vh;
    font-family:var(--rstk-font);
    color:var(--rstk-ink);
    background-color:var(--rstk-page-bg);
    background-image:var(--rstk-page-image);
    background-position:var(--rstk-page-image-position,center top);
    background-repeat:var(--rstk-page-image-repeat,no-repeat);
    background-size:var(--rstk-page-image-size,auto);
    background-attachment:var(--rstk-page-image-attachment,scroll);
    line-height:1.5;letter-spacing:0;
    -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
  }
  img{max-width:100%;display:block}
  .rstk-frame{position:relative;isolation:isolate;overflow:hidden;min-height:100vh;padding:var(--rstk-frame-pad,clamp(10px,3vw,32px)) 16px;background-color:var(--rstk-page-bg);background-image:var(--rstk-page-image);background-position:var(--rstk-page-image-position,center top);background-repeat:var(--rstk-page-image-repeat,no-repeat);background-size:var(--rstk-page-image-size,auto);background-attachment:var(--rstk-page-image-attachment,scroll)}
  .rstk-frame::before{content:"";position:absolute;inset:0;z-index:1;background:var(--rstk-page-overlay,none);pointer-events:none}
  .rstk-bg-video{position:absolute;inset:0;z-index:0;width:100%;height:100%;object-fit:var(--rstk-page-video-fit,cover);pointer-events:none}
  .rstk-page{position:relative;z-index:2;width:100%;max-width:var(--rstk-max);margin:0 auto;border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,transparent);border-radius:var(--rstk-page-radius,0)}
  .rstk-shell{display:grid;gap:var(--rstk-gap)}
  .rstk-centered .rstk-shell{text-align:center;justify-items:center}
  .rstk-centered .rstk-subheading,.rstk-centered .rstk-text{margin-inline:auto}
  .rstk-section-lane.rstk-block-style,.rstk-section-lane{width:100%;margin:var(--rstk-block-margin,0);background:var(--rstk-block-bg,transparent);color:var(--rstk-block-text,var(--rstk-ink));border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);padding:0}
  .rstk-section-inner{width:100%;max-width:var(--rstk-max);margin:0 auto;padding:var(--rstk-block-pad,var(--rstk-frame-pad,clamp(28px,5vw,72px)));display:grid;gap:var(--rstk-section-gap,clamp(18px,3vw,30px))}
  .rstk-section-heading{display:grid;gap:10px;justify-items:var(--rstk-block-justify,stretch);text-align:var(--rstk-block-align,inherit)}
  .rstk-section-heading h2,.rstk-section-heading p{margin:0}
  .rstk-section-columns{display:grid;grid-template-columns:repeat(var(--rstk-section-columns,1),minmax(0,1fr));gap:var(--rstk-section-gap,clamp(18px,3vw,30px));align-items:start}
  .rstk-section-column{min-width:0;display:grid;align-content:start;gap:var(--rstk-gap)}
  .rstk-block-style{
    width:auto;
    min-width:0;
    margin:var(--rstk-block-margin,0);
    background:var(--rstk-block-bg,transparent);
    color:var(--rstk-block-text,var(--rstk-ink));
    font-family:var(--rstk-block-font,var(--rstk-font));
    font-size:var(--rstk-block-size,inherit);
    font-weight:var(--rstk-block-weight,inherit);
    text-align:var(--rstk-block-align,inherit);
    border:var(--rstk-block-shell-border-width,0) solid var(--rstk-block-border,transparent);
    border-radius:var(--rstk-block-radius,0);
    padding:var(--rstk-block-pad,0);
  }
  .rstk-block-style .rstk-headline,
  .rstk-block-style h2,
  .rstk-block-style .rstk-subheading,
  .rstk-block-style .rstk-text,
  .rstk-block-style .rstk-help{
    margin-left:var(--rstk-content-margin-left,0);
    margin-right:var(--rstk-content-margin-right,0);
  }
  .rstk-block-style .rstk-headline,
  .rstk-block-style h2,
  .rstk-block-style label,
  .rstk-block-style strong{color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-block-style .rstk-subheading,
  .rstk-block-style .rstk-text,
  .rstk-block-style .rstk-help,
  .rstk-block-style p{color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 68%,var(--rstk-muted) 32%)}
  .rstk-block-style .rstk-button-link,
  .rstk-block-style button{border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius))}
  .rstk-block-style input,
  .rstk-block-style textarea,
  .rstk-block-style select,
  .rstk-block-style .rstk-option{
    background:var(--rstk-field-bg,var(--rstk-input-bg));
    border-color:var(--rstk-field-border,var(--rstk-input-border));
    border-radius:var(--rstk-field-radius,var(--rstk-radius));
  }
  .rstk-block-style .rstk-media,
  .rstk-block-style .rstk-video{
    justify-self:var(--rstk-media-justify,center);
    width:var(--rstk-media-width,100%);
    margin-left:var(--rstk-media-margin-left,auto);
    margin-right:var(--rstk-media-margin-right,auto);
  }

  .rstk-kind-form .rstk-shell{
    background:var(--rstk-surface);border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));
    border-radius:var(--rstk-radius-lg);box-shadow:none;
    padding:var(--rstk-pad);overflow:hidden;
  }
  form{display:grid;gap:18px;background:transparent;border:0;box-shadow:none;padding:0;margin:0}

  .rstk-headline{margin:0;font-weight:var(--rstk-heading-weight);font-size:clamp(1.7rem,4.6vw,3rem);line-height:1.05;letter-spacing:0}
  .rstk-kind-landing .rstk-headline{font-size:clamp(2rem,5.4vw,3.6rem)}
  .rstk-subheading{margin:0;color:var(--rstk-muted);font-size:clamp(1rem,2vw,1.18rem);max-width:var(--rstk-content-max,60ch)}
  .rstk-kicker{margin:0;color:var(--rstk-accent);font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.09em}
  .rstk-text{margin:0;color:color-mix(in srgb,var(--rstk-ink) 80%,transparent);max-width:var(--rstk-content-max,66ch)}
  .rstk-hero,.rstk-section-break,.rstk-cta,.rstk-section-list,.rstk-embedded-form{display:grid;gap:14px;justify-items:var(--rstk-block-justify,stretch);text-align:var(--rstk-block-align,inherit)}
  .rstk-hero{gap:16px}
  .rstk-section-break h2,.rstk-section-list h2,.rstk-cta h2,.rstk-embedded-form h2{margin:0;font-size:clamp(1.25rem,2.6vw,1.7rem);font-weight:var(--rstk-heading-weight);letter-spacing:0}

  .rstk-button-link,.rstk-actions button{
    -webkit-appearance:none;appearance:none;cursor:pointer;
    min-height:var(--rstk-button-height,50px);display:inline-flex;align-items:center;justify-content:center;gap:8px;
    border:var(--rstk-button-border-width,1px) solid var(--rstk-button-border,var(--rstk-button-bg,var(--rstk-accent)));border-radius:var(--rstk-block-button-radius,var(--rstk-btn-radius));
    background:var(--rstk-button-bg,var(--rstk-accent));color:var(--rstk-button-text,var(--rstk-on-accent));
    font:inherit;font-weight:var(--rstk-btn-weight);font-size:var(--rstk-button-size,1.02rem);line-height:1;
    padding:0 var(--rstk-button-pad-x,22px);text-decoration:none;
    transition:background .15s ease,border-color .15s ease,transform .04s ease,box-shadow .15s ease;
  }
  .rstk-button-link{justify-self:var(--rstk-button-justify,center);width:var(--rstk-button-width,fit-content);margin-left:var(--rstk-button-margin-left,auto);margin-right:var(--rstk-button-margin-right,auto)}
  .rstk-centered .rstk-button-link{margin-inline:auto}
  .rstk-button-link:hover,.rstk-actions button:hover{background:var(--rstk-button-hover-bg,var(--rstk-accent-strong));border-color:var(--rstk-button-hover-border,var(--rstk-button-border,var(--rstk-button-hover-bg,var(--rstk-accent-strong))))}
  .rstk-actions button:active{transform:translateY(1px)}
  .rstk-actions button[disabled]{opacity:.6;cursor:not-allowed}
  .rstk-secondary{background:transparent !important;color:var(--rstk-ink) !important;border-color:var(--rstk-border) !important}

  .rstk-list-grid{display:grid;grid-template-columns:var(--rstk-list-columns,repeat(auto-fit,minmax(190px,1fr)));gap:12px}
  .rstk-list-grid article{border:var(--rstk-card-border-width,var(--rstk-block-border-width,1px)) solid var(--rstk-card-border,var(--rstk-block-border,var(--rstk-border)));border-radius:var(--rstk-card-radius,var(--rstk-radius));background:var(--rstk-card-bg,var(--rstk-block-bg,var(--rstk-surface2)));padding:16px;text-align:var(--rstk-card-align,left)}
  .rstk-list-grid strong{display:block;font-weight:750}
  .rstk-list-grid p{margin:6px 0 0;color:var(--rstk-muted);font-size:.92rem}
  .rstk-list-grid small{display:block;margin-top:8px;color:var(--rstk-muted);font-weight:700}

  .rstk-check-list{list-style:none;margin:0;padding:0;display:grid;gap:11px;text-align:left}
  .rstk-check{display:flex;align-items:flex-start;gap:11px}
  .rstk-check-icon{flex:0 0 auto;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;margin-top:1px}
  .rstk-check-pro .rstk-check-icon{background:color-mix(in srgb,#16a34a 16%,var(--rstk-surface));color:#16a34a}
  .rstk-check-con .rstk-check-icon{background:color-mix(in srgb,#dc2626 14%,var(--rstk-surface));color:#dc2626}
  .rstk-check-neutral .rstk-check-icon{background:color-mix(in srgb,var(--rstk-accent) 14%,var(--rstk-surface));color:var(--rstk-accent)}
  .rstk-check-body{display:grid;gap:2px}
  .rstk-check-body strong{font-weight:650;font-size:1rem}
  .rstk-check-body span{color:var(--rstk-muted);font-size:.92rem}

  .rstk-media,.rstk-video{width:100%;margin:0;overflow:hidden;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-media-radius,var(--rstk-block-radius,var(--rstk-radius)));background:var(--rstk-block-bg,var(--rstk-surface2))}
  .rstk-media img,.rstk-video iframe{width:100%;display:block;border:0}
  .rstk-video{aspect-ratio:16/9;position:relative}
  .rstk-video iframe{height:100%}
  .rstk-media-empty{min-height:190px;display:grid;place-items:center;gap:8px;color:var(--rstk-muted);font-size:.92rem}
  .rstk-play{display:grid;place-items:center;width:58px;height:58px;border-radius:50%;background:var(--rstk-accent);color:var(--rstk-on-accent)}

  .rstk-field{display:grid;gap:8px;text-align:left}
  .rstk-step[hidden]{display:none}
  label{font-size:.95rem;font-weight:700;color:var(--rstk-ink)}
  .rstk-required{color:#dc2626;margin-left:3px}
  .rstk-help{margin:0;color:var(--rstk-muted);font-size:.9rem}
  input,textarea,select{
    width:100%;border:1px solid var(--rstk-input-border);border-radius:var(--rstk-field-radius,var(--rstk-radius));
    background:var(--rstk-input-bg);color:var(--rstk-input-ink);font:inherit;font-size:1rem;
    padding:13px 14px;outline:none;transition:border-color .15s ease,box-shadow .15s ease;
  }
  textarea{resize:vertical;min-height:108px}
  input::placeholder,textarea::placeholder{color:color-mix(in srgb,var(--rstk-muted) 80%,transparent)}
  input:focus,textarea:focus,select:focus{border-color:var(--rstk-accent);box-shadow:0 0 0 4px var(--rstk-ring)}
  select{appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--rstk-muted) 50%),linear-gradient(135deg,var(--rstk-muted) 50%,transparent 50%);background-position:calc(100% - 20px) calc(50% - 3px),calc(100% - 15px) calc(50% - 3px);background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:42px}

  .rstk-options{display:grid;gap:10px}
  .rstk-option{display:flex;align-items:center;gap:11px;min-height:50px;border:1px solid var(--rstk-input-border);border-radius:var(--rstk-field-radius,var(--rstk-radius));padding:11px 14px;background:var(--rstk-input-bg);color:var(--rstk-input-ink);font-weight:600;cursor:pointer;transition:border-color .15s ease,background .15s ease}
  .rstk-option:hover{border-color:var(--rstk-accent)}
  .rstk-option:has(input:checked){border-color:var(--rstk-accent);background:color-mix(in srgb,var(--rstk-accent) 8%,var(--rstk-input-bg))}
  .rstk-option input{width:19px;height:19px;padding:0;flex:0 0 auto;accent-color:var(--rstk-accent)}

  .rstk-embed{width:100%;min-height:var(--rstk-embed-height,360px);display:block;border:var(--rstk-block-border-width,1px) solid var(--rstk-block-border,var(--rstk-border));border-radius:var(--rstk-block-radius,var(--rstk-radius));background:var(--rstk-block-bg,var(--rstk-surface2))}
  .rstk-calendar-embed{min-height:760px}
  iframe.rstk-embed{overflow:hidden}
  .rstk-embed-code{background:transparent}
  .rstk-embed-empty{display:grid;place-items:center;min-height:160px;color:var(--rstk-muted)}

  .rstk-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px}
  .rstk-actions [data-submit],.rstk-actions [data-next]{flex:1 1 auto}
  .rstk-actions [data-back]{flex:0 0 auto;min-width:120px}
  .rstk-error{margin:2px 0 0;color:#dc2626;font-size:.85rem;font-weight:650}
  .rstk-submit-message{margin:0;color:var(--rstk-muted);font-weight:650;text-align:center}

  .rstk-progress{display:grid;gap:8px}
  .rstk-progress-track{height:6px;border-radius:999px;background:color-mix(in srgb,var(--rstk-ink) 12%,transparent);overflow:hidden}
  .rstk-progress-fill{display:block;height:100%;width:0;border-radius:999px;background:var(--rstk-accent);transition:width .35s cubic-bezier(.4,0,.2,1)}
  .rstk-progress b{font-size:.8rem;color:var(--rstk-muted);font-weight:700}

  @media (max-width:640px){
    .rstk-list-grid{grid-template-columns:1fr}
  }

  .rstk-footer{margin:6px 0 0;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--rstk-muted);font-size:.78rem;text-align:center}
  .rstk-footer .rstk-lock{display:inline-flex}

  .rstk-chrome .rstk-avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;overflow:hidden;background:var(--rstk-accent);color:#fff;font-weight:800;font-size:1.15rem;flex:0 0 auto}
  .rstk-chrome .rstk-avatar img{width:100%;height:100%;object-fit:cover}
  .rstk-social-profile{margin:calc(-1 * var(--rstk-pad)) calc(-1 * var(--rstk-pad)) 0;padding:20px var(--rstk-pad) 14px;display:flex;align-items:center;gap:8px;background:transparent;border:0}
  .rstk-social-image{position:relative;display:inline-block;flex:0 0 auto}
  .rstk-social-profile .rstk-avatar{width:64px;height:64px;font-size:1.35rem}
  .rstk-social-platform{position:absolute;right:-1px;bottom:-1px;z-index:2;width:28px;height:28px;border-radius:50%;border:2px solid #fff;background:#fff;display:grid;place-items:center;padding:2px;color:#fff;overflow:hidden}
  .rstk-social-platform-facebook{background:#fff url('https://storage.googleapis.com/msgsndr/cAEl3p2eZROgv2GFvMZM/media/67b7bb9d7c922f0d2f3b2adf.svg') center/contain no-repeat}
  .rstk-social-platform-instagram{background:var(--rstk-gradient)}
  .rstk-social-platform-tiktok{background:#050505;box-shadow:inset 1px 0 var(--rstk-cyan),inset -1px 0 var(--rstk-accent)}
  .rstk-social-platform svg{width:16px;height:16px}
  .rstk-social-details{display:flex;flex-direction:column;min-width:0}
  .rstk-social-name{display:flex;align-items:center;gap:4px;min-width:0;font-size:18px;line-height:1.18;font-weight:800;color:var(--rstk-ink)}
  .rstk-social-name .rstk-verified{width:14px;height:14px;margin-left:0;color:#1877f2;flex:0 0 auto;position:relative;top:1px}
  .rstk-social-followers{margin-top:2px;color:var(--rstk-muted);font-size:14px;line-height:1.25;font-weight:600}
  @media (max-width:480px){
    .rstk-social-profile{padding:15px var(--rstk-pad) 12px}
    .rstk-social-profile .rstk-avatar{width:60px;height:60px}
    .rstk-social-name{font-size:18px}
    .rstk-social-followers{font-size:12px}
  }

  @media (max-width:540px){
    .rstk-actions{flex-direction:column-reverse}
    .rstk-actions button{width:100%}
    .rstk-actions [data-back]{width:100%}
  }

  /* ---------- Premium landing ---------- */
  .rstk-kind-landing .rstk-frame{padding:0}
  .rstk-kind-landing .rstk-page{max-width:none;margin:0;border-radius:var(--rstk-page-radius,0);overflow:hidden}
  .rstk-kind-landing .rstk-shell{gap:0;padding-top:0}
  .rstk-kind-landing .rstk-headline{font-family:var(--rstk-display);font-size:clamp(2.3rem,5.6vw,4rem);line-height:1.03;letter-spacing:0;background:none;color:var(--rstk-block-text,var(--rstk-ink))}
  .rstk-kind-landing .rstk-subheading{font-size:clamp(1.05rem,1.7vw,1.28rem);max-width:var(--rstk-content-max,60ch);line-height:1.6}
  .rstk-kind-landing h2{font-family:var(--rstk-display)}
  .rstk-kind-landing .rstk-text{font-size:1.06rem;line-height:1.7}

  .rstk-kind-landing .rstk-kicker{display:inline-flex;align-items:center;gap:8px;width:fit-content;padding:7px 14px 7px 12px;border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,var(--rstk-border));border-radius:999px;background:var(--rstk-block-bg,transparent);color:var(--rstk-muted);font-size:.72rem;font-weight:700;letter-spacing:0;text-transform:uppercase}
  .rstk-kind-landing .rstk-kicker::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--rstk-accent)}

  .rstk-kind-landing .rstk-hero{position:relative;isolation:isolate;overflow:hidden;gap:22px;justify-items:var(--rstk-block-justify,center);text-align:var(--rstk-block-align,center);padding:clamp(32px,4.8vw,68px) clamp(20px,3.2vw,44px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent)}
  .rstk-kind-landing .rstk-hero::before,.rstk-kind-landing .rstk-hero::after{content:none}
  .rstk-kind-landing .rstk-hero .rstk-headline{font-size:clamp(2.6rem,6.2vw,4.6rem);max-width:var(--rstk-content-max,16ch)}
  .rstk-kind-landing .rstk-hero .rstk-subheading{margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto)}

  .rstk-kind-landing .rstk-section-break{min-height:clamp(160px,24vw,360px);align-content:center;padding:clamp(28px,5vw,76px) clamp(20px,4vw,56px)}
  .rstk-kind-landing .rstk-section-break h2{font-family:var(--rstk-display);font-size:clamp(2rem,4.6vw,3.4rem);line-height:1.08}
  .rstk-kind-landing .rstk-section-break p{max-width:var(--rstk-content-max,58ch);margin:0;color:color-mix(in srgb,var(--rstk-block-text,var(--rstk-ink)) 74%,transparent)}

  .rstk-kind-landing .rstk-section-list{gap:clamp(20px,3vw,38px)}
  .rstk-kind-landing .rstk-section-list h2{text-align:var(--rstk-block-align,center);max-width:var(--rstk-content-max,20ch);margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto);font-size:clamp(1.85rem,3.4vw,2.85rem);line-height:1.08;letter-spacing:0}
  .rstk-kind-landing .rstk-list-grid{gap:16px}
  .rstk-kind-landing .rstk-list-grid article{padding:24px;border:var(--rstk-card-border-width,var(--rstk-block-border-width,0)) solid var(--rstk-card-border,var(--rstk-block-border,transparent));border-radius:var(--rstk-card-radius,0);background:var(--rstk-card-bg,var(--rstk-block-bg,transparent));transition:border-color .15s ease}
  .rstk-kind-landing .rstk-list-grid article:hover{border-color:color-mix(in srgb,var(--rstk-ink) 22%,transparent)}
  .rstk-kind-landing .rstk-list-grid strong{font-size:1.06rem}

  .rstk-kind-landing .rstk-checklist{padding:clamp(24px,3vw,40px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent);width:100%;margin-inline:auto}
  .rstk-kind-landing .rstk-checklist h2{text-align:var(--rstk-block-align,center);margin-bottom:4px}
  .rstk-kind-landing .rstk-check-body strong{font-size:1.04rem}

  .rstk-kind-landing .rstk-cta{position:relative;overflow:hidden;justify-items:var(--rstk-block-justify,center);text-align:var(--rstk-block-align,center);gap:18px;padding:clamp(30px,4.4vw,62px) clamp(20px,3.2vw,44px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent)}
  .rstk-kind-landing .rstk-cta::after{content:none}
  .rstk-kind-landing .rstk-cta > *{position:relative;z-index:1}
  .rstk-kind-landing .rstk-cta h2{font-size:clamp(2rem,4vw,3.1rem)}
  .rstk-kind-landing .rstk-cta p{font-size:1.1rem;max-width:var(--rstk-content-max,52ch);margin-left:var(--rstk-content-margin-left,auto);margin-right:var(--rstk-content-margin-right,auto)}

  .rstk-kind-landing .rstk-button-link{border-radius:var(--rstk-block-button-radius,999px);min-height:var(--rstk-button-height,54px);padding:0 var(--rstk-button-pad-x,28px);font-family:var(--rstk-display);font-weight:600;transition:transform .25s var(--rstk-ease),box-shadow .25s var(--rstk-ease),background .2s ease}
  .rstk-kind-landing .rstk-button-link:hover{transform:none;box-shadow:none}

  .rstk-kind-landing .rstk-media,.rstk-kind-landing .rstk-video,.rstk-kind-landing .rstk-embed{border-radius:var(--rstk-media-radius,var(--rstk-block-radius,clamp(16px,2vw,22px)));box-shadow:none}
  .rstk-kind-landing .rstk-embedded-form{padding:clamp(24px,3vw,40px);border:var(--rstk-block-border-width,0) solid var(--rstk-block-border,transparent);border-radius:var(--rstk-block-radius,0);background:var(--rstk-block-bg,transparent);width:100%;margin-inline:auto}
  @media (max-width:760px){.rstk-section-columns{grid-template-columns:1fr}}
  .rstkFontOverride .rstk-headline,.rstkFontOverride .rstk-subheading,.rstkFontOverride .rstk-text,.rstkFontOverride h2,.rstkFontOverride label,.rstkFontOverride .rstk-help,.rstkFontOverride .rstk-list-grid strong,.rstkFontOverride .rstk-list-grid p,.rstkFontOverride .rstk-check-body strong,.rstkFontOverride .rstk-check-body span{font-family:var(--rstk-block-font,inherit)}
  .rstkSizeOverride .rstk-headline,.rstkSizeOverride .rstk-subheading,.rstkSizeOverride .rstk-text,.rstkSizeOverride h2,.rstkSizeOverride label,.rstkSizeOverride .rstk-help,.rstkSizeOverride .rstk-list-grid strong,.rstkSizeOverride .rstk-list-grid p,.rstkSizeOverride .rstk-list-grid small,.rstkSizeOverride .rstk-check-body strong,.rstkSizeOverride .rstk-check-body span{font-size:var(--rstk-block-size)}
  .rstkWeightOverride .rstk-headline,.rstkWeightOverride .rstk-subheading,.rstkWeightOverride .rstk-text,.rstkWeightOverride h2,.rstkWeightOverride label,.rstkWeightOverride .rstk-help,.rstkWeightOverride .rstk-list-grid strong,.rstkWeightOverride .rstk-check-body strong{font-weight:var(--rstk-block-weight,850)}

  @media (max-width:640px){
    .rstk-kind-landing .rstk-hero{padding:clamp(32px,8vw,56px) 20px}
  }
`

const RSTK_TEMPLATE_EXTRAS = {
  ristak: `
    .rstk-tpl-ristak .rstk-kind-form .rstk-shell{}
  `,

  facebook: `
    .rstk-fb{position:relative;margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:14px var(--rstk-pad) 12px;border-bottom:1px solid var(--rstk-border)}
    .rstk-fb-line{position:absolute;top:0;left:0;right:0;height:4px;background:var(--rstk-accent)}
    .rstk-fb-row{display:flex;align-items:center;gap:10px}
    .rstk-fb-meta{flex:1 1 auto;min-width:0}
    .rstk-fb-name{display:flex;align-items:center;gap:5px;font-weight:700;font-size:1rem;color:var(--rstk-ink)}
    .rstk-verified{color:#1877f2;flex:0 0 auto}
    .rstk-fb-sub{display:flex;align-items:center;gap:5px;color:var(--rstk-muted);font-size:.82rem;margin-top:1px}
    .rstk-fb-mark{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--rstk-accent);color:#fff;font-weight:900;font-family:Georgia,'Times New Roman',serif;font-size:1.2rem;flex:0 0 auto}
  `,

  instagram: `
    .rstk-ig{position:relative;margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:0 var(--rstk-pad) 14px}
    .rstk-ig::before{content:'';position:absolute;top:0;left:0;right:0;height:4px;background:var(--rstk-gradient)}
    .rstk-ig-bar{display:flex;align-items:center;gap:8px;padding:12px 0 14px;border-bottom:1px solid var(--rstk-border)}
    .rstk-ig-cam{display:inline-flex;color:var(--rstk-ink)}
    .rstk-ig-word{font-weight:800;font-size:1.05rem}
    .rstk-ig-dots{margin-left:auto;color:var(--rstk-ink);font-size:1.2rem;line-height:1}
    .rstk-ig-profile{display:flex;align-items:center;gap:11px;padding-top:14px}
    .rstk-ig-ring{display:inline-grid;place-items:center;padding:2px;border-radius:50%;background:var(--rstk-gradient);flex:0 0 auto}
    .rstk-ig-ring .rstk-avatar{width:42px;height:42px;border:2px solid var(--rstk-surface)}
    .rstk-ig-name{font-weight:700;font-size:.95rem}
    .rstk-ig-sub{color:var(--rstk-muted);font-size:.8rem;margin-top:1px}
    .rstk-tpl-instagram .rstk-button-link,.rstk-tpl-instagram .rstk-actions [data-submit]{background:var(--rstk-accent)}
  `,

  tiktok: `
    .rstk-tt{margin:calc(-1 * var(--rstk-pad));margin-bottom:var(--rstk-gap);padding:14px var(--rstk-pad);border-bottom:1px solid var(--rstk-border);display:grid;gap:10px;justify-items:center}
    .rstk-tt-bar{display:flex;align-items:center;gap:8px;font-weight:800;font-size:1.05rem;letter-spacing:.2px}
    .rstk-tt-note{display:inline-flex;color:#fff;filter:drop-shadow(1.5px 0 var(--rstk-cyan)) drop-shadow(-1.5px 0 var(--rstk-accent))}
    .rstk-tt-profile{display:flex;align-items:center;gap:11px}
    .rstk-tt-name{font-weight:800}
    .rstk-tt-sub{color:var(--rstk-muted);font-size:.8rem}
    .rstk-tpl-tiktok .rstk-headline{text-shadow:1.5px 0 var(--rstk-cyan),-1.5px 0 var(--rstk-accent)}
    .rstk-tpl-tiktok ::selection{background:var(--rstk-accent);color:#fff}
  `,

  vsl: `
    .rstk-tpl-vsl .rstk-shell{background:var(--rstk-surface);border:var(--rstk-page-border-width,0) solid var(--rstk-page-border,var(--rstk-border));border-radius:var(--rstk-radius-lg);box-shadow:none;padding:clamp(20px,4vw,40px)}
    .rstk-tpl-vsl .rstk-kicker{display:inline-block}
  `,

  interactive: `
    .rstk-interactive .rstk-shell{min-height:min(72vh,560px);align-content:center;padding:clamp(22px,5vw,46px)}
    .rstk-interactive .rstk-field{gap:14px}
    .rstk-interactive label{font-size:clamp(1.3rem,3.4vw,1.9rem);font-weight:800;letter-spacing:0;line-height:1.15}
    .rstk-interactive .rstk-help{font-size:1rem}
    .rstk-interactive .rstk-options{counter-reset:rstk-opt;gap:12px}
    .rstk-interactive .rstk-option{position:relative;min-height:60px;padding:16px 18px 16px 60px;font-size:1.05rem;font-weight:600}
    .rstk-interactive .rstk-option input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
    .rstk-interactive .rstk-option::before{counter-increment:rstk-opt;content:counter(rstk-opt,upper-alpha);position:absolute;left:14px;top:50%;transform:translateY(-50%);width:32px;height:32px;border-radius:9px;display:grid;place-items:center;border:1px solid var(--rstk-border);font-weight:800;font-size:.9rem;color:var(--rstk-muted);background:var(--rstk-surface);transition:all .15s ease}
    .rstk-interactive .rstk-option:has(input:checked)::before{background:var(--rstk-accent);color:var(--rstk-on-accent);border-color:var(--rstk-accent)}
    .rstk-interactive .rstk-actions{margin-top:10px}
    .rstk-interactive input,.rstk-interactive textarea,.rstk-interactive select{font-size:1.1rem;padding:15px 16px}
  `
}

function relLuminance(hex) {
  const normalized = normalizeCssColor(hex, '#ffffff')
  let h = String(normalized || '').replace('#', '')
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) {
    const match = normalized.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i)
    if (match) {
      h = [match[1], match[2], match[3]]
        .map(channel => Math.max(0, Math.min(255, Number(channel))).toString(16).padStart(2, '0'))
        .join('')
    }
  }
  if (h.length < 6) return 1
  const toLin = (c) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  const r = toLin(parseInt(h.slice(0, 2), 16))
  const g = toLin(parseInt(h.slice(2, 4), 16))
  const b = toLin(parseInt(h.slice(4, 6), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function cssImageUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:image\//i.test(raw)) return ''
  return `url("${raw.replace(/["\\\n\r]/g, '')}")`
}

function cssMediaUrl(value) {
  const raw = cleanString(value)
  if (!raw) return ''
  if (!/^https?:\/\//i.test(raw) && !raw.startsWith('/') && !/^data:video\//i.test(raw)) return ''
  return raw.replace(/["\\\n\r]/g, '')
}

function paintLayer(paint) {
  if (!paint) return 'none'
  if (isCssGradient(paint)) return paint
  return `linear-gradient(${paint}, ${paint})`
}

function backgroundFitValue(value) {
  const raw = cleanString(value)
  if (raw === 'contain') return 'contain'
  if (raw === 'full_width') return '100% auto'
  if (raw === 'auto') return 'auto'
  return 'cover'
}

function backgroundRepeatValue(value) {
  const raw = cleanString(value)
  return ['repeat', 'repeat-x', 'repeat-y'].includes(raw) ? raw : 'no-repeat'
}

function backgroundPositionValue(value) {
  const raw = cleanString(value)
  return raw && !/[;{}<>]/.test(raw) ? raw : 'center center'
}

function backgroundAttachmentValue(value) {
  return cleanString(value) === 'fixed' ? 'fixed' : 'scroll'
}

function deriveNeutralVars(template, bg, userAccent) {
  const dark = relLuminance(bg) < 0.5
  const ink = dark ? '#f4f4f6' : '#0f172a'
  const accent = userAccent || (dark ? '#ffffff' : '#0f172a')
  const onAccent = relLuminance(accent) > 0.6 ? '#08080a' : '#ffffff'
  return {
    ...template.vars,
    pageBg: bg,
    pageImage: 'none',
    ink,
    muted: `color-mix(in srgb, ${ink} 60%, ${bg})`,
    surface: dark ? 'rgba(255,255,255,0.04)' : 'rgba(15,23,42,0.022)',
    surface2: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.04)',
    border: dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.1)',
    accent,
    accentStrong: accent,
    onAccent,
    ring: `color-mix(in srgb, ${accent} 26%, transparent)`,
    inputBg: dark ? 'rgba(255,255,255,0.04)' : '#ffffff',
    inputInk: ink,
    inputBorder: dark ? 'rgba(255,255,255,0.14)' : '#dfe3e8'
  }
}

function resolveRenderOverrides(template, theme, isLandingType) {
  if (template.chrome !== 'none') return {}
  const color = (value) => normalizeCssColor(value, '') || null
  // DEFAULT_THEME forces backgroundColor=#ffffff, so treat white as "not chosen":
  // landings default to the premium dark canvas; forms stay light until recolored.
  const rawBg = color(theme.backgroundColor)
  const userBg = rawBg && rawBg.toLowerCase() !== String(DEFAULT_THEME.backgroundColor).toLowerCase() ? rawBg : null
  const rawAccent = color(theme.accentColor)
  const userAccent = rawAccent && rawAccent.toLowerCase() !== String(DEFAULT_THEME.accentColor).toLowerCase() ? rawAccent : null
  if (isLandingType) {
    return { vars: deriveNeutralVars(template, userBg || '#08080a', userAccent) }
  }
  if (userBg) {
    return { vars: deriveNeutralVars(template, userBg, userAccent) }
  }
  return userAccent ? { accent: userAccent } : {}
}

function buildStyleSheet(template, maxWidth, overrides = {}, pageVars = {}) {
  const v = { ...template.vars, ...(overrides.vars || {}) }
  const accent = overrides.accent || v.accent
  const accentStrong = overrides.accent ? `color-mix(in srgb, ${overrides.accent} 86%, #000)` : v.accentStrong
  const ring = overrides.accent ? `color-mix(in srgb, ${overrides.accent} 22%, transparent)` : v.ring
  const baseFont = template.chrome === 'none' ? `'Inter', ${template.font}` : template.font
  const display = template.chrome === 'none' ? `'Inter Tight', 'Inter', ${template.font}` : template.font
  const pageImage = pageVars.pageImage || v.pageImage
  const pageOverlay = pageVars.pageOverlay || 'none'
  const pageBg = pageVars.pageBg || v.pageBg
  return `
  :root{
    --rstk-font:${baseFont};
    --rstk-display:${display};
    --rstk-ease:cubic-bezier(.16,.84,.44,1);
    --rstk-page-bg:${pageBg};
    --rstk-page-image:${pageImage};
    --rstk-page-overlay:${pageOverlay};
    --rstk-page-image-size:${pageImage === 'none' ? 'auto' : (pageVars.pageImageSize || 'cover')};
    --rstk-page-image-position:${pageVars.pageImagePosition || 'center center'};
    --rstk-page-image-repeat:${pageVars.pageImageRepeat || 'no-repeat'};
    --rstk-page-image-attachment:${pageVars.pageImageAttachment || 'scroll'};
    --rstk-page-video-fit:${pageVars.pageVideoFit || 'cover'};
    --rstk-ink:${v.ink};
    --rstk-muted:${v.muted};
    --rstk-surface:${v.surface};
    --rstk-surface2:${v.surface2};
    --rstk-border:${v.border};
    --rstk-accent:${accent};
    --rstk-accent-strong:${accentStrong};
    --rstk-on-accent:${v.onAccent};
    --rstk-ring:${ring};
    --rstk-input-bg:${v.inputBg};
    --rstk-input-ink:${v.inputInk};
    --rstk-input-border:${v.inputBorder};
    --rstk-radius:${v.radius};
    --rstk-radius-lg:${v.radiusLg};
    --rstk-shadow:${v.shadow};
    --rstk-heading-weight:${v.headingWeight};
    --rstk-btn-radius:${v.btnRadius};
    --rstk-btn-weight:${v.btnWeight};
    --rstk-max:${maxWidth};
    --rstk-frame-pad:${pageVars.framePad || 'clamp(10px,3vw,32px)'};
    --rstk-page-border:${pageVars.pageBorder || 'transparent'};
    --rstk-page-border-width:${pageVars.pageBorderWidth || '0px'};
    --rstk-page-radius:${pageVars.pageRadius || '0px'};
    --rstk-pad:clamp(18px,4vw,30px);
    --rstk-gap:clamp(16px,3vw,22px);
    ${template.gradient ? `--rstk-gradient:${template.gradient};` : ''}
    ${template.cyan ? `--rstk-cyan:${template.cyan};` : ''}
  }
  ${RSTK_BASE_CSS}
  ${RSTK_TEMPLATE_EXTRAS[template.id] || ''}
  `
}

async function buildMetaPixelSnippet(site, trackingEnabled, activePage = null) {
  if (!trackingEnabled || !site.metaCapiEnabled) return ''

  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer Pixel ID de Meta para snippet de Site: ${error.message}`)
    return null
  })
  const pixelId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID)
  if (!pixelId) return ''

  const submitEventName = getFormSubmitMetaEventName(site, activePage?.id)
  const pageMeta = getPageMetaConfig(site, activePage?.id)
  const pageViewEventName = pageMeta?.trigger === 'page_view' ? pageMeta.eventName : ''

  return `
  <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
    (window, document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', ${JSON.stringify(pixelId)});
    fbq('track', 'PageView');
    window.ristakMetaTrackSiteEvent = function(eventName, eventId, customData) {
      if (!window.fbq) return;
      const normalizedEventName = eventName || ${JSON.stringify(submitEventName)};
      if (!normalizedEventName || normalizedEventName === ${JSON.stringify(SITE_META_NO_EVENT)}) return;
      const method = ${JSON.stringify([...META_STANDARD_PIXEL_EVENTS])}.indexOf(normalizedEventName) >= 0 ? 'track' : 'trackCustom';
      const data = Object.assign({
        source: 'ristak_site',
        site_id: ${JSON.stringify(site.id)},
        site_name: ${JSON.stringify(site.name || '')},
        content_name: ${JSON.stringify(site.title || site.name || '')}
      }, customData || {});
      const options = eventId ? { eventID: eventId } : undefined;
      if (options) {
        window.fbq(method, normalizedEventName, data, options);
      } else {
        window.fbq(method, normalizedEventName, data);
      }
    };
    window.ristakMetaTrackSiteSubmit = function(eventId, customData, eventName) {
      window.ristakMetaTrackSiteEvent(eventName || ${JSON.stringify(submitEventName)}, eventId, customData);
    };
    window.ristakMetaSendServerEvent = function(payload) {
      fetch('/api/sites/public/meta-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(() => {});
    };
    ${pageViewEventName ? `
    try {
      const pageEventId = [
        'site_page',
        ${JSON.stringify(site.id)},
        ${JSON.stringify(activePage?.id || '')},
        Date.now(),
        Math.random().toString(16).slice(2)
      ].join('_');
      const pageData = {
        conversion_type: 'page_view',
        public_page_id: ${JSON.stringify(activePage?.id || '')},
        public_page_title: ${JSON.stringify(activePage?.title || '')}
      };
      window.ristakMetaTrackSiteEvent(${JSON.stringify(pageViewEventName)}, pageEventId, pageData);
      window.ristakMetaSendServerEvent({
        siteId: ${JSON.stringify(site.id)},
        pageId: ${JSON.stringify(activePage?.id || '')},
        eventId: pageEventId,
        eventName: ${JSON.stringify(pageViewEventName)},
        trigger: 'page_view',
        meta: {
          pageUrl: window.location.href,
          referrer: document.referrer,
          params: Object.fromEntries(new URL(window.location.href).searchParams.entries()),
          fbp: (document.cookie.match(/(?:^|; )_fbp=([^;]+)/) || [])[1] || null,
          fbc: (document.cookie.match(/(?:^|; )_fbc=([^;]+)/) || [])[1] || null
        }
      });
    } catch (error) {}
    ` : ''}
  </script>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${encodeURIComponent(pixelId)}&ev=PageView&noscript=1"/></noscript>`
}

export async function renderPublicSiteHtml(site, { pageId, trackingEnabled = true } = {}) {
  const theme = { ...DEFAULT_THEME, ...(site.theme || {}) }
  const template = resolveTemplate(site)
  const brand = getBrand(site, template)
  const pages = normalizeSitePages(site)
  const requestedPageId = cleanString(pageId)
  const activePage = pages.find(page => page.id === requestedPageId) || pages[0]
  const blocks = getPageBlocks(site, activePage?.id)
  const fieldBlocks = collectFieldBlocks(blocks)
  const nativeFormContext = getNativeFormContext(site, blocks)
  const isInteractive = site.siteType === 'interactive_form'
  const isLandingType = site.siteType === 'landing_page'
  const hasForm = fieldBlocks.length > 0
  const completionAction = isLandingType ? getFormCompletionAction(blocks) : 'form_default'
  const nextPage = isLandingType ? getNextPage(site, activePage?.id) : null
  const nextPageUrl = nextPage ? pageHref(nextPage.id) : ''
  const submitText = cleanString(theme.submitText) || 'Enviar'
  const storedPageMaxWidth = Number(theme && theme.pageMaxWidth)
  const pageMaxWidth = isLandingType && storedPageMaxWidth === 1160
    ? 1440
    : themeNumber(theme, 'pageMaxWidth', isLandingType ? 1440 : (template.id === 'interactive' ? 600 : 520), 360, 1440)
  const pagePadding = themeNumber(theme, 'pagePadding', isLandingType ? 50 : 22, 0, 120)
  const pageRadius = themeNumber(theme, 'pageRadius', isLandingType ? 0 : 24, 0, 40)
  const pageBorderWidth = themeNumber(theme, 'pageBorderWidth', 0, 0, 12)
  const pageBorder = themeColor(theme, 'pageBorderColor') || 'transparent'
  const backgroundMediaType = cleanString(theme.backgroundMediaType) === 'video' ? 'video' : 'image'
  const rawBackgroundPaint = normalizeCssPaint(theme.backgroundColor, '')
  const backgroundPaint = rawBackgroundPaint.toLowerCase() === DEFAULT_THEME.backgroundColor ? '' : rawBackgroundPaint
  const pageImage = backgroundMediaType === 'video' ? '' : cssImageUrl(theme.backgroundImage)
  const pageVideo = backgroundMediaType === 'video' ? cssMediaUrl(theme.backgroundImage) : ''
  const pageOverlay = paintLayer(backgroundPaint)
  const pageBg = backgroundPaint && isCssColor(backgroundPaint) ? normalizeCssColor(backgroundPaint, '') : ''
  const maxWidth = `${pageMaxWidth}px`
  const styleSheet = buildStyleSheet(template, maxWidth, resolveRenderOverrides(template, theme, isLandingType), {
    framePad: `${pagePadding}px`,
    pageBorder,
    pageBorderWidth: `${pageBorderWidth}px`,
    pageBg,
    pageImage,
    pageOverlay,
    pageImageSize: backgroundFitValue(theme.backgroundFit),
    pageImagePosition: backgroundPositionValue(theme.backgroundPosition),
    pageImageRepeat: backgroundRepeatValue(theme.backgroundRepeat),
    pageImageAttachment: backgroundAttachmentValue(theme.backgroundAttachment),
    pageVideoFit: backgroundFitValue(theme.backgroundFit),
    pageRadius: `${pageRadius}px`
  })
  const chrome = template.chrome && template.chrome !== 'none' ? renderBrandChrome(template, brand) : ''
  const footer = (hasForm && !isLandingType) ? renderLegalFooter(brand) : ''
  const bodyClass = [
    `rstk-tpl-${template.id}`,
    `rstk-${template.mode}`,
    `rstk-kind-${isLandingType ? 'landing' : 'form'}`,
    template.centered ? 'rstk-centered' : '',
    isInteractive ? 'rstk-interactive' : ''
  ].filter(Boolean).join(' ')

  const renderContext = { site, pageId: activePage?.id, isInteractive }
  const bodyBlocks = isLandingType
    ? buildLandingSectionLanes(blocks).map(lane => renderLandingSectionLane(lane, renderContext)).join('\n')
    : blocks.map(block => renderPublicBlock(block, renderContext)).join('\n')

  const submitArea = hasForm
    ? `
      <div class="rstk-actions">
        ${isInteractive ? '<button type="button" class="rstk-secondary" data-back hidden>Anterior</button>' : ''}
        ${isInteractive ? '<button type="button" data-next>Siguiente</button>' : ''}
        <button type="submit" ${isInteractive ? 'hidden' : ''} data-submit>${escapeHtml(submitText)}</button>
      </div>
      <p class="rstk-submit-message" data-message role="status"></p>
    `
    : ''
  const nativeTrackingScript = trackingEnabled
    ? buildNativeSiteTrackingScript({
      siteId: site.id,
      siteSlug: site.slug,
      siteName: site.name,
      siteType: site.siteType,
      formSiteId: nativeFormContext.formSiteId,
      formSiteName: nativeFormContext.formSiteName,
      pageId: activePage?.id || '',
      pageTitle: activePage?.title || ''
    })
    : ''
  const metaPixelSnippet = await buildMetaPixelSnippet(site, trackingEnabled, activePage)

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(site.title || site.name)}</title>
  <meta name="description" content="${escapeHtml(site.description || '')}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Inter+Tight:wght@500;600;700&display=swap" rel="stylesheet">
  <style>${styleSheet}</style>
</head>
<body class="${bodyClass}">
  <div class="rstk-frame">
    ${pageVideo ? `<video class="rstk-bg-video" src="${escapeHtml(pageVideo)}" autoplay muted loop playsinline aria-hidden="true"></video>` : ''}
    <main class="rstk-page">
      <div class="rstk-shell">
        ${chrome}
        ${isInteractive && hasForm ? `<div class="rstk-progress" data-progress><span class="rstk-progress-track"><span class="rstk-progress-fill" data-progress-fill></span></span><b data-progress-label>Pregunta 1 de ${fieldBlocks.length}</b></div>` : ''}
        <form data-site-form data-site-id="${escapeHtml(site.id)}" data-page-id="${escapeHtml(activePage?.id || '')}" novalidate>
          ${bodyBlocks}
          ${submitArea}
        </form>
        ${footer}
      </div>
    </main>
  </div>
  <script>
    (() => {
      const form = document.querySelector('[data-site-form]');
      if (!form) return;
      const siteId = form.getAttribute('data-site-id');
      const pageId = form.getAttribute('data-page-id') || '';
      const steps = Array.from(form.querySelectorAll('.rstk-step'));
      const nextButton = form.querySelector('[data-next]');
      const backButton = form.querySelector('[data-back]');
      const submitButton = form.querySelector('[data-submit]');
      const message = form.querySelector('[data-message]');
      const progressLabel = document.querySelector('[data-progress-label]');
      const progressFill = document.querySelector('[data-progress-fill]');
      const isInteractive = ${isInteractive ? 'true' : 'false'};
      const completionAction = ${JSON.stringify(completionAction)};
      const nextPageUrl = ${JSON.stringify(nextPageUrl)};
      let index = 0;

      const parseRule = (value) => {
        if (!value) return null;
        try { return JSON.parse(value); } catch { return null; }
      };

      const readFieldValue = (field) => {
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
        if (select && select.selectedOptions && select.selectedOptions[0]) {
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
        if (progressLabel) progressLabel.textContent = 'Pregunta ' + (index + 1) + ' de ' + steps.length;
        if (progressFill) progressFill.style.width = (((index + 1) / steps.length) * 100) + '%';
      };

      nextButton && nextButton.addEventListener('click', () => {
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
        if (jumpRule && jumpRule.targetBlockId) {
          const targetIndex = steps.findIndex(step => step.getAttribute('data-block-id') === jumpRule.targetBlockId);
          index = targetIndex >= 0 ? targetIndex : Math.min(index + 1, steps.length - 1);
        } else {
          index = Math.min(index + 1, steps.length - 1);
        }
        renderStep();
      });

      backButton && backButton.addEventListener('click', () => {
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
        const nativeIdentity = window.ristakNativeIdentity ? window.ristakNativeIdentity() : {};
        const nativeTracking = window.ristakNativeBuildData ? window.ristakNativeBuildData({ conversion_type: 'form_submit' }) : null;
        if (submitButton) submitButton.disabled = true;
        if (message) message.textContent = 'Enviando...';

        try {
          const response = await fetch('/api/sites/public/submit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteId,
              pageId,
              responses,
              meta: {
                pageId,
                pageUrl: window.location.href,
                referrer: document.referrer,
                params,
                visitorId: nativeIdentity.visitorId || null,
                sessionId: nativeIdentity.sessionId || null,
                tracking: nativeTracking,
                fbp: (document.cookie.match(/(?:^|; )_fbp=([^;]+)/) || [])[1] || null,
                fbc: (document.cookie.match(/(?:^|; )_fbc=([^;]+)/) || [])[1] || null
              }
            })
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data.success === false) {
            throw new Error(data.error || 'No se pudo enviar el formulario');
          }
          const submission = data && data.data ? data.data : {};
          const metaEventId = submission.capi && submission.capi.eventId
            ? submission.capi.eventId
            : (submission.submissionId ? 'site_' + siteId + '_' + submission.submissionId : '');
          const metaEventName = submission.capi && submission.capi.eventName
            ? submission.capi.eventName
            : '';
          if (window.ristakMetaTrackSiteSubmit) {
            window.ristakMetaTrackSiteSubmit(metaEventId, {
              status: submission.status || 'submitted',
              conversion_type: 'form_submit'
            }, metaEventName);
          }
          form.reset();
          if (window.ristakNativeRememberContact && submission.contactId) {
            window.ristakNativeRememberContact({
              contactId: submission.contactId,
              fullName: submission.contactName || '',
              email: submission.contactEmail || ''
            });
          }
          index = 0;
          renderStep();
          const qualifies = submission.status !== 'disqualified';
          if (nextPageUrl && (completionAction === 'next_page' || (completionAction === 'next_page_if_qualified' && qualifies))) {
            window.location.href = nextPageUrl;
            return;
          }
          if (message) message.textContent = (data && data.data && data.data.message) || ${JSON.stringify('Listo. Recibimos tu informacion.')};
        } catch (error) {
          if (message) message.textContent = error.message || 'No se pudo enviar el formulario';
        } finally {
          if (submitButton) submitButton.disabled = false;
        }
      });

      renderStep();
    })();
  </script>
  ${metaPixelSnippet}
  ${nativeTrackingScript}
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
  const visitorId = cleanString(meta?.visitorId || meta?.visitor_id)

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
        visitor_id = COALESCE(NULLIF(visitor_id, ''), ?),
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
      visitorId || null,
      contactId
    ])
    await finalizePreparedPhoneUpsert(phoneUpsert, contactId)
    return contactId
  }

  await db.run(`
    INSERT INTO contacts (
      id, phone, email, full_name, first_name, last_name, source,
      attribution_url, attribution_session_source, attribution_medium,
      attribution_ad_name, attribution_ad_id, visitor_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      phone = COALESCE(NULLIF(contacts.phone, ''), excluded.phone),
      email = COALESCE(NULLIF(contacts.email, ''), excluded.email),
      full_name = COALESCE(NULLIF(contacts.full_name, ''), excluded.full_name),
      first_name = COALESCE(NULLIF(contacts.first_name, ''), excluded.first_name),
      last_name = COALESCE(NULLIF(contacts.last_name, ''), excluded.last_name),
      visitor_id = COALESCE(NULLIF(contacts.visitor_id, ''), excluded.visitor_id),
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
    cleanString(params.ad_id || params.utm_ad_id) || null,
    visitorId || null
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

async function sendSiteLeadMetaEvent({ site, submissionId, submittedPageId, contactId, contact, requestMeta }) {
  if (!site.metaCapiEnabled) {
    return { sent: false, reason: 'disabled' }
  }

  const eventName = getFormSubmitMetaEventName(site, submittedPageId)
  const eventId = `site_${site.id}_${submissionId}`
  if (eventName === SITE_META_NO_EVENT) {
    return { sent: false, reason: 'no_event_configured', eventId, eventName }
  }

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
    return { sent: false, reason: 'missing_meta_config', eventId, eventName }
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
    return { sent: false, reason: 'insufficient_user_data', eventId, eventName }
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

    return { sent: true, eventId, eventName, responsePayload }
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
    return { sent: false, reason: 'meta_error', error: error.message, eventId, eventName }
  }
}

async function sendSitePageMetaEvent({ site, page, eventName, eventId, contactId, requestMeta }) {
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer configuracion Meta para evento de pagina Site: ${error.message}`)
    return null
  })
  const datasetId = cleanString(metaConfig?.pixel_id || process.env.META_PIXEL_ID || process.env.META_DATASET_ID)
  const accessToken = cleanString(metaConfig?.pixel_api_token || process.env.META_ACCESS_TOKEN || metaConfig?.access_token)

  if (!datasetId || !accessToken) {
    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'Falta Pixel/Dataset ID o Pixel API Token de Meta'
    })
    return { sent: false, reason: 'missing_meta_config', eventId, eventName }
  }

  const userData = {
    external_id: contactId ? hashValue(contactId) : undefined,
    client_ip_address: requestMeta.ip || undefined,
    client_user_agent: requestMeta.userAgent || undefined,
    fbp: cleanString(requestMeta.meta?.fbp) || undefined,
    fbc: cleanString(requestMeta.meta?.fbc) || undefined
  }

  Object.keys(userData).forEach(key => {
    if (!userData[key]) delete userData[key]
  })

  if (!userData.client_ip_address && !userData.client_user_agent && !userData.fbp && !userData.fbc && !userData.external_id) {
    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'skipped',
      errorMessage: 'user_data insuficiente para Meta'
    })
    return { sent: false, reason: 'insufficient_user_data', eventId, eventName }
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
          conversion_type: 'page_view',
          site_id: site.id,
          site_name: site.name,
          public_page_id: page?.id || '',
          public_page_title: page?.title || '',
          content_name: page?.title || site.title || site.name
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
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'success',
      requestPayload: payload,
      responsePayload
    })

    return { sent: true, eventId, eventName, responsePayload }
  } catch (error) {
    await logMetaEvent({
      contactId,
      eventType: 'site_page_view',
      metaEventName: eventName,
      eventId,
      status: 'error',
      requestPayload: payload,
      errorMessage: error.message
    })
    return { sent: false, reason: 'meta_error', error: error.message, eventId, eventName }
  }
}

async function recordNativeSiteConversionEvent({ site, blocks, submittedPageId, submissionId, contactId, contact, req, meta }) {
  const visitorId = cleanString(meta?.visitorId || meta?.visitor_id) || `site_visitor_${submissionId}`
  const sessionId = cleanString(meta?.sessionId || meta?.session_id) || `site_session_${submissionId}`
  const tracking = meta?.tracking && typeof meta.tracking === 'object' ? meta.tracking : {}
  const pages = normalizeSitePages(site)
  const page = pages.find(item => item.id === submittedPageId) || pages[0] || null
  const formContext = getNativeFormContext(site, blocks)

  const data = {
    ...tracking,
    tracking_source: 'native_site',
    site_id: site.id,
    site_slug: site.slug,
    site_name: site.name,
    site_type: site.siteType,
    form_site_id: formContext.formSiteId,
    form_site_name: formContext.formSiteName,
    public_page_id: submittedPageId || page?.id || '',
    public_page_title: page?.title || '',
    conversion_type: 'form_submit',
    submission_id: submissionId,
    url: cleanString(meta?.pageUrl) || tracking.url || `https://${site.domain || cleanString(meta?.host) || ''}`,
    referrer: cleanString(meta?.referrer) || tracking.referrer || null,
    contact_name: cleanString(contact?.fullName) || undefined
  }

  await createSession({
    session_id: sessionId,
    visitor_id: visitorId,
    contact_id: contactId || null,
    full_name: cleanString(contact?.fullName) || null,
    event_name: 'native_site_conversion',
    ts: Date.now(),
    data,
    ip: getClientIp(req),
    user_agent: req.headers['user-agent'] || ''
  })

  if (contactId) {
    linkVisitorToContact(visitorId, contactId, cleanString(contact?.fullName) || 'Lead de site')
      .then(() => unifyVisitorIds(contactId))
      .catch(error => {
        logger.warn(`No se pudo vincular visitor nativo ${visitorId} con contacto ${contactId}: ${error.message}`)
      })
  }
}

export async function createSubmissionFromRequest(req, body = {}) {
  const host = getRequestHost(req)
  const domainResolution = await resolveConnectedPublicDomainForHost(host)

  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message)
    error.status = domainResolution.status
    throw error
  }

  const submittedSiteId = cleanString(body.siteId)
  const site = submittedSiteId
    ? await getSite(submittedSiteId, { includeBlocks: false, includeSubmissions: false })
    : await findSiteByRoutePath(req.path)

  if (!site) {
    const error = new Error('Site publico no encontrado')
    error.status = 404
    throw error
  }

  if (site.status !== 'published') {
    const error = new Error('Este site no esta publicado')
    error.status = 404
    throw error
  }

  site.domain = domainResolution.domain || host
  site.blocks = await hydrateEmbeddedForms(await listSiteBlocks(site.id))

  const blocks = Array.isArray(site.blocks) && site.blocks.length
    ? site.blocks
    : await hydrateEmbeddedForms(await listSiteBlocks(site.id))
  const submittedPageId = cleanString(body.pageId || body.page_id || body.meta?.pageId || body.meta?.page_id)
  const submissionBlocks = site.siteType === 'landing_page' && submittedPageId
    ? getPageBlocks({ ...site, blocks }, submittedPageId)
    : blocks
  const { responses, errors } = normalizeSubmissionResponses(submissionBlocks, body.responses || {})
  if (errors.length) {
    const error = new Error(errors.join(', '))
    error.status = 400
    throw error
  }

  const ruleEvaluation = evaluateSubmissionRules(submissionBlocks, responses)

  const meta = {
    ...(body.meta && typeof body.meta === 'object' ? body.meta : {}),
    host,
    rules: ruleEvaluation,
    userAgent: req.headers['user-agent'] || '',
    submittedAt: new Date().toISOString()
  }
  const inferredContact = inferContactFromResponses(collectFieldBlocks(submissionBlocks), responses)
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
    submittedPageId,
    contactId,
    contact: inferredContact,
    requestMeta: {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      meta
    }
  })

  await recordNativeSiteConversionEvent({
    site,
    blocks: submissionBlocks,
    submittedPageId,
    submissionId,
    contactId,
    contact: inferredContact,
    req,
    meta
  }).catch(error => {
    logger.warn(`No se pudo registrar conversion nativa de site ${site.id}: ${error.message}`)
  })

  return {
    submissionId,
    siteId: site.id,
    contactId,
    contactName: inferredContact.fullName || '',
    contactEmail: inferredContact.email || '',
    contactPhone: inferredContact.phone || '',
    status: ruleEvaluation.status,
    message: getSiteFinalMessage(site, ruleEvaluation),
    rules: ruleEvaluation,
    capi
  }
}

export async function createMetaPageEventFromRequest(req, body = {}) {
  const host = getRequestHost(req)
  const domainResolution = await resolveConnectedPublicDomainForHost(host)

  if (!domainResolution.ok) {
    const error = new Error(domainResolution.message)
    error.status = domainResolution.status
    throw error
  }

  const siteId = cleanString(body.siteId || body.site_id)
  if (!siteId) {
    const error = new Error('Site requerido')
    error.status = 400
    throw error
  }

  const site = await getSite(siteId, { includeBlocks: false, includeSubmissions: false })
  if (!site) {
    const error = new Error('Site publico no encontrado')
    error.status = 404
    throw error
  }

  if (site.status !== 'published') {
    const error = new Error('Este site no esta publicado')
    error.status = 404
    throw error
  }

  site.domain = domainResolution.domain || host

  if (!site.metaCapiEnabled) {
    return { sent: false, reason: 'site_disabled' }
  }

  const pageId = cleanString(body.pageId || body.page_id)
  const pageMeta = getPageMetaConfig(site, pageId)
  if (!pageMeta || pageMeta.trigger !== 'page_view') {
    return { sent: false, reason: 'page_event_disabled' }
  }

  const meta = body.meta && typeof body.meta === 'object' ? body.meta : {}
  const eventId = cleanString(body.eventId || body.event_id) || `site_page_${site.id}_${pageMeta.page.id}_${crypto.randomUUID()}`
  const contactId = cleanString(body.contactId || body.contact_id)

  return sendSitePageMetaEvent({
    site,
    page: pageMeta.page,
    eventName: pageMeta.eventName,
    eventId,
    contactId,
    requestMeta: {
      ip: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      meta
    }
  })
}
