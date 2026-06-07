import { randomUUID } from 'crypto'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import { getMetaConfig } from './metaAdsService.js'

export const META_ADS_MCP_SERVER_URL = process.env.META_ADS_MCP_SERVER_URL || 'https://mcp.facebook.com/ads'
const DEFAULT_CURRENCY = process.env.META_ADS_DEFAULT_CURRENCY || 'MXN'
const DEFAULT_TIMEZONE = process.env.META_ADS_DEFAULT_TIMEZONE || 'America/Mexico_City'
const MCP_EXECUTION_ENABLED = process.env.META_ADS_MCP_EXECUTION_ENABLED === '1'
const MCP_AUTHORIZATION_TOKEN = process.env.META_ADS_MCP_AUTHORIZATION_TOKEN || ''

function safeJson(value) {
  try {
    return JSON.stringify(value ?? null)
  } catch {
    return JSON.stringify({ error: 'No se pudo serializar este dato.' })
  }
}

function parseJson(value, fallback = null) {
  if (!value) return fallback

  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function cleanString(value, maxLength = 500) {
  if (value === null || value === undefined) return ''
  return String(value).trim().slice(0, maxLength)
}

function normalizeAdAccountId(value = '') {
  return cleanString(value).replace(/^act_/i, '')
}

function normalizeStatus(value, fallback = 'PAUSED') {
  const clean = cleanString(value || fallback).toUpperCase()
  return ['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'].includes(clean) ? clean : fallback
}

function normalizeNumber(value, fallback = null) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function option(value, mode = 'user_editable', description = '') {
  return { value, mode, description }
}

function disabled(value = false, description = '') {
  return option(value, 'disabled', description)
}

function locked(value, description = '') {
  return option(value, 'locked', description)
}

function manualRequired(value = null, description = '') {
  return option(value, 'manual_required', description)
}

function editable(value, description = '') {
  return option(value, 'user_editable', description)
}

export const SYSTEM_META_CAMPAIGN_TEMPLATES = [
  {
    id: 'manual_leads_whatsapp',
    version: 1,
    name: 'Leads manuales a WhatsApp',
    description: 'Campaña manual para generar conversaciones o solicitudes por WhatsApp, sin automatizaciones creativas de Meta por defecto.',
    category: 'leads',
    mode: 'manual_strict',
    defaultObjective: 'OUTCOME_LEADS',
    lockedOptions: ['objective', 'advantagePlusCreative', 'advantageAudience', 'automaticPlacements', 'dynamicCreative'],
    editableOptions: ['budget', 'schedule', 'audience', 'placements', 'copy', 'creative', 'destination', 'status'],
    optionPolicy: {
      campaign: {
        objective: locked('OUTCOME_LEADS', 'Objetivo fijo para captar leads.'),
        buyingType: locked('AUCTION', 'Compra por subasta.'),
        status: editable('PAUSED', 'Se crea en pausa hasta revisar.'),
        specialAdCategories: editable([], 'Categorías especiales si aplican.')
      },
      adSet: {
        destinationType: locked('WHATSAPP', 'El destino principal es WhatsApp.'),
        optimizationGoal: editable('CONVERSATIONS', 'Optimización para conversaciones o leads.'),
        billingEvent: editable('IMPRESSIONS', 'Cobro por impresiones.'),
        bidStrategy: editable('LOWEST_COST_WITHOUT_CAP', 'Estrategia manual conservadora por defecto.'),
        dailyBudget: manualRequired(null, 'Presupuesto diario requerido.'),
        schedule: manualRequired(null, 'Fecha de inicio requerida.'),
        audience: editable({
          geoLocations: { countries: ['MX'] },
          ageMin: 18,
          ageMax: 65,
          genders: [],
          interests: []
        }, 'Audiencia configurable por el usuario.'),
        placements: editable({
          publisherPlatforms: ['facebook', 'instagram'],
          facebookPositions: ['feed', 'marketplace', 'video_feeds'],
          instagramPositions: ['stream', 'story', 'reels']
        }, 'Ubicaciones manuales, no automáticas.')
      },
      creative: {
        pageId: manualRequired(null, 'Página de Facebook requerida.'),
        instagramAccountId: editable(null, 'Instagram conectado si aplica.'),
        callToActionType: editable('WHATSAPP_MESSAGE', 'CTA para iniciar conversación.'),
        primaryText: manualRequired(null, 'Texto principal del anuncio.'),
        headline: manualRequired(null, 'Título del anuncio.'),
        description: editable('', 'Descripción opcional.'),
        media: editable(null, 'Imagen o video del anuncio.')
      },
      tracking: {
        pixelId: editable(null, 'Pixel o dataset si se usa evento.'),
        conversionEvent: editable('Lead', 'Evento sugerido para medir leads.'),
        urlTags: editable('', 'UTMs o etiquetas de URL.')
      },
      automation: {
        advantageCampaignBudget: disabled(false, 'Presupuesto Advantage desactivado por defecto.'),
        advantagePlusCreative: disabled(false, 'Mejoras creativas Advantage desactivadas.'),
        advantageAudience: disabled(false, 'Audiencia Advantage desactivada.'),
        automaticPlacements: disabled(false, 'Placements automáticos desactivados.'),
        dynamicCreative: disabled(false, 'Creativo dinámico desactivado.'),
        standardEnhancements: disabled(false, 'Mejoras estándar desactivadas.')
      }
    }
  },
  {
    id: 'manual_sales_conversion',
    version: 1,
    name: 'Ventas manuales con Pixel',
    description: 'Campaña manual para conversiones o compras usando pixel/dataset y tracking completo.',
    category: 'sales',
    mode: 'manual_strict',
    defaultObjective: 'OUTCOME_SALES',
    lockedOptions: ['objective', 'advantagePlusCreative', 'advantageAudience', 'automaticPlacements'],
    editableOptions: ['budget', 'schedule', 'audience', 'placements', 'copy', 'creative', 'event', 'status'],
    optionPolicy: {
      campaign: {
        objective: locked('OUTCOME_SALES', 'Objetivo fijo para ventas.'),
        buyingType: locked('AUCTION', 'Compra por subasta.'),
        status: editable('PAUSED', 'Se crea en pausa hasta revisar.'),
        specialAdCategories: editable([], 'Categorías especiales si aplican.')
      },
      adSet: {
        destinationType: editable('WEBSITE', 'Destino web por defecto.'),
        optimizationGoal: editable('OFFSITE_CONVERSIONS', 'Optimización a conversiones fuera de Meta.'),
        billingEvent: editable('IMPRESSIONS', 'Cobro por impresiones.'),
        bidStrategy: editable('LOWEST_COST_WITHOUT_CAP', 'Estrategia manual conservadora por defecto.'),
        dailyBudget: manualRequired(null, 'Presupuesto diario requerido.'),
        schedule: manualRequired(null, 'Fecha de inicio requerida.'),
        audience: editable({
          geoLocations: { countries: ['MX'] },
          ageMin: 18,
          ageMax: 65,
          genders: [],
          interests: []
        }, 'Audiencia configurable por el usuario.'),
        placements: editable({
          publisherPlatforms: ['facebook', 'instagram'],
          facebookPositions: ['feed', 'video_feeds'],
          instagramPositions: ['stream', 'story', 'reels']
        }, 'Ubicaciones manuales, no automáticas.')
      },
      creative: {
        pageId: manualRequired(null, 'Página de Facebook requerida.'),
        instagramAccountId: editable(null, 'Instagram conectado si aplica.'),
        callToActionType: editable('LEARN_MORE', 'CTA editable.'),
        primaryText: manualRequired(null, 'Texto principal del anuncio.'),
        headline: manualRequired(null, 'Título del anuncio.'),
        description: editable('', 'Descripción opcional.'),
        media: editable(null, 'Imagen o video del anuncio.')
      },
      tracking: {
        pixelId: manualRequired(null, 'Pixel o dataset requerido para conversiones.'),
        conversionEvent: editable('Purchase', 'Evento sugerido para ventas.'),
        urlTags: editable('utm_source=meta&utm_medium=paid_social', 'UTMs sugeridas.')
      },
      automation: {
        advantageCampaignBudget: disabled(false, 'Presupuesto Advantage desactivado por defecto.'),
        advantagePlusCreative: disabled(false, 'Mejoras creativas Advantage desactivadas.'),
        advantageAudience: disabled(false, 'Audiencia Advantage desactivada.'),
        automaticPlacements: disabled(false, 'Placements automáticos desactivados.'),
        dynamicCreative: disabled(false, 'Creativo dinámico desactivado.'),
        standardEnhancements: disabled(false, 'Mejoras estándar desactivadas.')
      }
    }
  },
  {
    id: 'automated_advantage_leads',
    version: 1,
    name: 'Leads con automatización preparada',
    description: 'Plantilla lista para activar opciones Advantage si el negocio decide permitir automatización después.',
    category: 'leads',
    mode: 'automation_ready',
    defaultObjective: 'OUTCOME_LEADS',
    lockedOptions: ['objective'],
    editableOptions: ['budget', 'schedule', 'audience', 'placements', 'copy', 'creative', 'destination', 'advantageOptions', 'status'],
    optionPolicy: {
      campaign: {
        objective: locked('OUTCOME_LEADS', 'Objetivo fijo para leads.'),
        buyingType: locked('AUCTION', 'Compra por subasta.'),
        status: editable('PAUSED', 'Se crea en pausa hasta revisar.'),
        specialAdCategories: editable([], 'Categorías especiales si aplican.')
      },
      adSet: {
        destinationType: editable('MESSAGING', 'Destino configurable.'),
        optimizationGoal: editable('LEADS', 'Optimización editable.'),
        billingEvent: editable('IMPRESSIONS', 'Cobro por impresiones.'),
        bidStrategy: editable('LOWEST_COST_WITHOUT_CAP', 'Estrategia base.'),
        dailyBudget: manualRequired(null, 'Presupuesto diario requerido.'),
        schedule: manualRequired(null, 'Fecha de inicio requerida.'),
        audience: editable({
          geoLocations: { countries: ['MX'] },
          ageMin: 18,
          ageMax: 65,
          genders: [],
          interests: []
        }, 'Puede operar manual o Advantage.'),
        placements: editable({
          publisherPlatforms: ['facebook', 'instagram', 'messenger'],
          facebookPositions: [],
          instagramPositions: []
        }, 'Puede cambiar a ubicaciones automáticas.')
      },
      creative: {
        pageId: manualRequired(null, 'Página de Facebook requerida.'),
        instagramAccountId: editable(null, 'Instagram conectado si aplica.'),
        callToActionType: editable('LEARN_MORE', 'CTA editable.'),
        primaryText: manualRequired(null, 'Texto principal del anuncio.'),
        headline: manualRequired(null, 'Título del anuncio.'),
        description: editable('', 'Descripción opcional.'),
        media: editable(null, 'Imagen o video del anuncio.')
      },
      tracking: {
        pixelId: editable(null, 'Pixel o dataset si se usa evento.'),
        conversionEvent: editable('Lead', 'Evento sugerido.'),
        urlTags: editable('utm_source=meta&utm_medium=paid_social', 'UTMs sugeridas.')
      },
      automation: {
        advantageCampaignBudget: editable(false, 'Disponible pero apagado por defecto.'),
        advantagePlusCreative: editable(false, 'Disponible pero apagado por defecto.'),
        advantageAudience: editable(false, 'Disponible pero apagado por defecto.'),
        automaticPlacements: editable(false, 'Disponible pero apagado por defecto.'),
        dynamicCreative: editable(false, 'Disponible pero apagado por defecto.'),
        standardEnhancements: editable(false, 'Disponible pero apagado por defecto.')
      }
    }
  }
]

function getPolicyValue(template, section, key, fallback = null) {
  return template?.optionPolicy?.[section]?.[key]?.value ?? fallback
}

function mergeObjects(...objects) {
  return objects.reduce((acc, current) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return acc
    return { ...acc, ...current }
  }, {})
}

async function ensureSystemCampaignTemplates() {
  for (const template of SYSTEM_META_CAMPAIGN_TEMPLATES) {
    const existing = await db.get('SELECT id, template_json FROM meta_campaign_templates WHERE id = ?', [template.id])
    const templateJson = safeJson(template)

    if (!existing?.id) {
      await db.run(`
        INSERT INTO meta_campaign_templates (
          id,
          name,
          description,
          category,
          mode,
          template_version,
          template_json,
          is_system,
          is_active,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `, [
        template.id,
        template.name,
        template.description,
        template.category,
        template.mode,
        template.version,
        templateJson
      ])
      continue
    }

    const stored = parseJson(existing.template_json, {})
    if (Number(stored?.version || 0) !== Number(template.version)) {
      await db.run(`
        UPDATE meta_campaign_templates
        SET name = ?,
            description = ?,
            category = ?,
            mode = ?,
            template_version = ?,
            template_json = ?,
            is_system = 1,
            is_active = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [
        template.name,
        template.description,
        template.category,
        template.mode,
        template.version,
        templateJson,
        template.id
      ])
    }
  }
}

function normalizeTemplateRow(row) {
  if (!row) return null
  const template = parseJson(row.template_json, null)

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    mode: row.mode,
    version: row.template_version,
    isSystem: Boolean(row.is_system),
    isActive: Boolean(row.is_active),
    template
  }
}

async function getTemplateOrThrow(templateId = 'manual_leads_whatsapp') {
  await ensureSystemCampaignTemplates()
  const row = await db.get('SELECT * FROM meta_campaign_templates WHERE id = ? AND is_active = 1', [templateId])
  const normalized = normalizeTemplateRow(row)

  if (!normalized?.template) {
    throw new Error('No encontramos esa plantilla de campaña.')
  }

  return normalized.template
}

function normalizeSourceContent(input = {}) {
  const content = input.content || input.sourceContent || {}

  return {
    offer: cleanString(content.offer || input.offer || ''),
    angle: cleanString(content.angle || input.angle || ''),
    primaryText: cleanString(content.primaryText || content.text || input.primaryText || input.copy || '', 5000),
    headline: cleanString(content.headline || content.title || input.headline || input.title || '', 500),
    description: cleanString(content.description || content.subtitle || input.description || input.subtitle || '', 1000),
    callToAction: cleanString(content.callToAction || content.cta || input.callToAction || input.cta || ''),
    destinationUrl: cleanString(content.destinationUrl || content.url || input.destinationUrl || input.url || ''),
    whatsappNumber: cleanString(content.whatsappNumber || input.whatsappNumber || ''),
    notes: cleanString(content.notes || input.notes || '', 5000),
    assets: Array.isArray(content.assets) ? content.assets : Array.isArray(input.assets) ? input.assets : []
  }
}

function normalizeCampaignDraftInput(input = {}) {
  const sourceContent = normalizeSourceContent(input)
  const campaign = input.campaign || {}
  const adSet = input.adSet || input.adset || {}
  const creative = input.creative || {}
  const tracking = input.tracking || {}
  const account = input.account || {}
  const assets = input.assets && !Array.isArray(input.assets) ? input.assets : {}
  const automation = input.automation || {}
  const templateId = cleanString(input.templateId || input.template_id || campaign.templateId || 'manual_leads_whatsapp', 120) || 'manual_leads_whatsapp'

  return {
    templateId,
    sourceContent,
    account,
    campaign,
    adSet,
    creative,
    tracking,
    assets,
    automation,
    optionOverrides: input.optionOverrides || input.options || {},
    rawInput: input
  }
}

function buildConfigSnapshot(metaConfig = {}) {
  return {
    mcpServerUrl: META_ADS_MCP_SERVER_URL,
    hasAccessToken: Boolean(metaConfig?.access_token),
    adAccountId: normalizeAdAccountId(metaConfig?.ad_account_id),
    pageId: cleanString(metaConfig?.page_id),
    instagramAccountId: cleanString(metaConfig?.instagram_account_id),
    pixelId: cleanString(metaConfig?.pixel_id),
    timezoneName: cleanString(metaConfig?.timezone_name) || DEFAULT_TIMEZONE,
    timezoneId: metaConfig?.timezone_id || null,
    timezoneOffsetHoursUtc: metaConfig?.timezone_offset_hours_utc || null,
    updatedAt: metaConfig?.updated_at || null
  }
}

function buildCampaignPayload({ normalized, template, configSnapshot }) {
  const { sourceContent, account, campaign, adSet, creative, tracking, assets, automation } = normalized
  const adAccountId = normalizeAdAccountId(account.adAccountId || account.ad_account_id || configSnapshot.adAccountId)
  const pageId = cleanString(assets.pageId || creative.pageId || configSnapshot.pageId)
  const instagramAccountId = cleanString(assets.instagramAccountId || creative.instagramAccountId || configSnapshot.instagramAccountId)
  const pixelId = cleanString(tracking.pixelId || tracking.datasetId || configSnapshot.pixelId)
  const currency = cleanString(adSet.currency || campaign.currency || DEFAULT_CURRENCY, 10) || DEFAULT_CURRENCY
  const dailyBudget = normalizeNumber(adSet.dailyBudget ?? adSet.daily_budget ?? campaign.dailyBudget ?? campaign.daily_budget)
  const lifetimeBudget = normalizeNumber(adSet.lifetimeBudget ?? adSet.lifetime_budget ?? campaign.lifetimeBudget ?? campaign.lifetime_budget)
  const startTime = cleanString(adSet.startTime || adSet.start_time || campaign.startTime || campaign.start_date || campaign.startDate)
  const endTime = cleanString(adSet.endTime || adSet.end_time || campaign.endTime || campaign.end_date || campaign.endDate)
  const campaignName = cleanString(
    campaign.name ||
    campaign.campaignName ||
    sourceContent.offer ||
    sourceContent.headline ||
    `Campaña Meta ${new Date().toISOString().slice(0, 10)}`,
    220
  )
  const adSetName = cleanString(adSet.name || adSet.adSetName || `${campaignName} | Conjunto 1`, 220)
  const adName = cleanString(creative.name || creative.adName || `${campaignName} | Anuncio 1`, 220)
  const primaryText = cleanString(creative.primaryText || sourceContent.primaryText, 5000)
  const headline = cleanString(creative.headline || sourceContent.headline || campaignName, 500)
  const description = cleanString(creative.description || sourceContent.description, 1000)
  const callToActionType = cleanString(creative.callToActionType || creative.ctaType || getPolicyValue(template, 'creative', 'callToActionType', 'LEARN_MORE'), 80)
  const destinationUrl = cleanString(creative.destinationUrl || tracking.destinationUrl || sourceContent.destinationUrl)
  const destinationType = cleanString(adSet.destinationType || getPolicyValue(template, 'adSet', 'destinationType', 'WEBSITE'), 80)
  const whatsappNumber = cleanString(creative.whatsappNumber || assets.whatsappNumber || sourceContent.whatsappNumber)
  const audience = mergeObjects(getPolicyValue(template, 'adSet', 'audience', {}), adSet.audience || {})
  const placements = mergeObjects(getPolicyValue(template, 'adSet', 'placements', {}), adSet.placements || {})
  const automationPolicy = template.optionPolicy?.automation || {}
  const resolvedAutomation = Object.fromEntries(
    Object.entries(automationPolicy).map(([key, config]) => [
      key,
      {
        mode: config.mode,
        value: automation[key] ?? config.value
      }
    ])
  )

  const campaignPayload = {
    account: {
      adAccountId,
      mcpAccountPath: adAccountId ? `act_${adAccountId}` : null
    },
    campaign: {
      name: campaignName,
      objective: cleanString(campaign.objective || getPolicyValue(template, 'campaign', 'objective', template.defaultObjective), 80),
      buying_type: cleanString(campaign.buyingType || campaign.buying_type || getPolicyValue(template, 'campaign', 'buyingType', 'AUCTION'), 80),
      status: normalizeStatus(campaign.status || getPolicyValue(template, 'campaign', 'status', 'PAUSED')),
      special_ad_categories: Array.isArray(campaign.specialAdCategories)
        ? campaign.specialAdCategories
        : getPolicyValue(template, 'campaign', 'specialAdCategories', [])
    },
    adSet: {
      name: adSetName,
      status: normalizeStatus(adSet.status || campaign.status || 'PAUSED'),
      destination_type: destinationType,
      optimization_goal: cleanString(adSet.optimizationGoal || adSet.optimization_goal || getPolicyValue(template, 'adSet', 'optimizationGoal', 'LEADS'), 80),
      billing_event: cleanString(adSet.billingEvent || adSet.billing_event || getPolicyValue(template, 'adSet', 'billingEvent', 'IMPRESSIONS'), 80),
      bid_strategy: cleanString(adSet.bidStrategy || adSet.bid_strategy || getPolicyValue(template, 'adSet', 'bidStrategy', 'LOWEST_COST_WITHOUT_CAP'), 80),
      daily_budget: dailyBudget,
      lifetime_budget: lifetimeBudget,
      currency,
      start_time: startTime || null,
      end_time: endTime || null,
      targeting: audience,
      placements
    },
    creative: {
      name: cleanString(creative.creativeName || `${adName} | Creativo`, 220),
      page_id: pageId || null,
      instagram_account_id: instagramAccountId || null,
      primary_text: primaryText,
      headline,
      description,
      call_to_action_type: callToActionType,
      destination_url: destinationUrl || null,
      whatsapp_number: whatsappNumber || null,
      media: creative.media || sourceContent.assets?.[0] || null
    },
    ad: {
      name: adName,
      status: normalizeStatus(creative.status || campaign.status || 'PAUSED')
    },
    tracking: {
      pixel_id: pixelId || null,
      conversion_event: cleanString(tracking.conversionEvent || tracking.eventName || getPolicyValue(template, 'tracking', 'conversionEvent', 'Lead'), 120),
      url_tags: cleanString(tracking.urlTags || tracking.utm || getPolicyValue(template, 'tracking', 'urlTags', ''), 1000)
    },
    automation: resolvedAutomation,
    optionOverrides: normalized.optionOverrides || {}
  }

  const mcpOperations = [
    {
      order: 1,
      operation: 'create_campaign',
      target: 'Meta campaign',
      payload: campaignPayload.campaign
    },
    {
      order: 2,
      operation: 'create_ad_set',
      target: 'Meta ad set',
      dependsOn: 'campaign.id',
      payload: campaignPayload.adSet
    },
    {
      order: 3,
      operation: 'create_ad_creative',
      target: 'Meta ad creative',
      dependsOn: 'page_id and media asset',
      payload: campaignPayload.creative
    },
    {
      order: 4,
      operation: 'create_ad',
      target: 'Meta ad',
      dependsOn: 'ad_set.id and creative.id',
      payload: campaignPayload.ad
    }
  ]

  return {
    template: {
      id: template.id,
      version: template.version,
      mode: template.mode,
      name: template.name
    },
    ...campaignPayload,
    mcp: {
      serverUrl: META_ADS_MCP_SERVER_URL,
      serverLabel: 'meta_ads',
      executionMode: MCP_EXECUTION_ENABLED ? 'mcp_enabled' : 'preview_only_until_mcp_connected',
      requireHumanApproval: true,
      operations: mcpOperations
    }
  }
}

function validateCampaignPayload(payload, template, configSnapshot) {
  const blockingIssues = []
  const warnings = []
  const required = (condition, field, message) => {
    if (!condition) blockingIssues.push({ field, message })
  }
  const warn = (condition, field, message) => {
    if (!condition) warnings.push({ field, message })
  }

  required(configSnapshot.hasAccessToken, 'meta.accessToken', 'Conecta Meta Ads antes de crear campañas reales.')
  required(payload.account.adAccountId, 'account.adAccountId', 'Elige una cuenta publicitaria.')
  required(payload.campaign.name, 'campaign.name', 'Falta el nombre de la campaña.')
  required(payload.campaign.objective, 'campaign.objective', 'Falta el objetivo de campaña.')
  required(payload.adSet.daily_budget || payload.adSet.lifetime_budget, 'adSet.budget', 'Falta presupuesto diario o total.')
  required(payload.adSet.start_time, 'adSet.startTime', 'Falta fecha de inicio.')
  required(payload.creative.page_id, 'creative.pageId', 'Falta la página de Facebook que publicará el anuncio.')
  required(payload.creative.primary_text, 'creative.primaryText', 'Falta el texto principal del anuncio.')
  required(payload.creative.headline, 'creative.headline', 'Falta el título del anuncio.')

  if (template.id === 'manual_sales_conversion') {
    required(payload.tracking.pixel_id, 'tracking.pixelId', 'Esta plantilla necesita pixel o dataset para medir conversiones.')
  }

  if (payload.adSet.destination_type === 'WEBSITE') {
    required(payload.creative.destination_url, 'creative.destinationUrl', 'Falta la URL de destino.')
  }

  if (payload.adSet.destination_type === 'WHATSAPP') {
    warn(payload.creative.whatsapp_number, 'creative.whatsappNumber', 'No se indicó número de WhatsApp; Meta puede requerir resolverlo desde la página o cuenta conectada.')
  }

  warn(payload.creative.media, 'creative.media', 'No se adjuntó imagen o video; el creativo puede necesitar completarse antes de publicar.')

  return {
    readyForPreview: blockingIssues.length === 0 || blockingIssues.every(issue => issue.field === 'meta.accessToken'),
    readyForExecution: blockingIssues.length === 0,
    blockingIssues,
    warnings,
    policy: {
      manualStrict: template.mode === 'manual_strict',
      lockedOptions: template.lockedOptions || [],
      editableOptions: template.editableOptions || [],
      disabledAutomation: Object.entries(payload.automation || {})
        .filter(([, value]) => value?.mode === 'disabled')
        .map(([key]) => key)
    }
  }
}

function buildPreview(payload, validation) {
  return {
    title: payload.campaign.name,
    status: validation.readyForExecution ? 'ready' : 'needs_review',
    canExecute: validation.readyForExecution,
    account: payload.account,
    summary: {
      objective: payload.campaign.objective,
      budget: payload.adSet.daily_budget
        ? `${payload.adSet.currency} ${payload.adSet.daily_budget} diario`
        : payload.adSet.lifetime_budget
          ? `${payload.adSet.currency} ${payload.adSet.lifetime_budget} total`
          : 'Sin presupuesto',
      destination: payload.adSet.destination_type,
      optimization: payload.adSet.optimization_goal,
      startsAt: payload.adSet.start_time,
      endsAt: payload.adSet.end_time,
      status: payload.campaign.status
    },
    creative: {
      headline: payload.creative.headline,
      primaryText: payload.creative.primary_text,
      description: payload.creative.description,
      cta: payload.creative.call_to_action_type,
      hasMedia: Boolean(payload.creative.media)
    },
    automation: payload.automation,
    validation,
    mcpOperations: payload.mcp.operations
  }
}

async function logCampaignBuilderStep({
  draftId = null,
  traceId,
  step,
  status = 'completed',
  requestPayload = null,
  responsePayload = null,
  errorMessage = null
} = {}) {
  const id = `meta_log_${randomUUID()}`
  await db.run(`
    INSERT INTO meta_campaign_execution_logs (
      id,
      draft_id,
      trace_id,
      step,
      status,
      mcp_server_url,
      request_payload_json,
      response_payload_json,
      error_message,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `, [
    id,
    draftId,
    traceId,
    cleanString(step, 160),
    cleanString(status, 80),
    META_ADS_MCP_SERVER_URL,
    requestPayload === null || requestPayload === undefined ? null : safeJson(requestPayload),
    responsePayload === null || responsePayload === undefined ? null : safeJson(responsePayload),
    errorMessage ? cleanString(errorMessage, 2000) : null
  ])
}

function normalizeDraftRow(row) {
  if (!row) return null

  return {
    id: row.id,
    traceId: row.trace_id,
    templateId: row.template_id,
    name: row.name,
    status: row.status,
    executionStatus: row.execution_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    executedAt: row.executed_at,
    sourceContent: parseJson(row.source_content_json, {}),
    configSnapshot: parseJson(row.config_snapshot_json, {}),
    templateSnapshot: parseJson(row.template_snapshot_json, {}),
    payload: parseJson(row.payload_json, {}),
    validation: parseJson(row.validation_json, {}),
    preview: parseJson(row.preview_json, {})
  }
}

export async function listMetaCampaignTemplates() {
  await ensureSystemCampaignTemplates()
  const rows = await db.all(`
    SELECT *
    FROM meta_campaign_templates
    WHERE is_active = 1
    ORDER BY is_system DESC, category ASC, name ASC
  `)

  return rows.map(normalizeTemplateRow)
}

export async function getMetaCampaignTemplate(templateId) {
  await ensureSystemCampaignTemplates()
  const row = await db.get('SELECT * FROM meta_campaign_templates WHERE id = ?', [templateId])
  return normalizeTemplateRow(row)
}

export async function getMetaCampaignBuilderCapabilities() {
  await ensureSystemCampaignTemplates()
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer config de Meta para campaign builder: ${error.message}`)
    return null
  })
  const templates = await listMetaCampaignTemplates()
  const configSnapshot = buildConfigSnapshot(metaConfig || {})

  return {
    mcp: {
      serverUrl: META_ADS_MCP_SERVER_URL,
      serverLabel: 'meta_ads',
      executionEnabled: MCP_EXECUTION_ENABLED,
      hasAuthorization: Boolean(MCP_AUTHORIZATION_TOKEN),
      status: MCP_EXECUTION_ENABLED && MCP_AUTHORIZATION_TOKEN ? 'ready' : 'preview_only'
    },
    connection: configSnapshot,
    templates: templates.map(template => ({
      id: template.id,
      name: template.name,
      description: template.description,
      category: template.category,
      mode: template.mode,
      version: template.version
    })),
    supportedSections: [
      'account',
      'campaign',
      'adSet',
      'ad',
      'creative',
      'budget',
      'schedule',
      'audience',
      'placements',
      'tracking',
      'automation',
      'status'
    ],
    guardrails: {
      defaultCampaignStatus: 'PAUSED',
      requiresPreviewBeforeExecution: true,
      requiresHumanApproval: true,
      storesEveryPayload: true,
      manualTemplatesDisableAdvantageByDefault: true
    }
  }
}

export async function createMetaCampaignDraft(input = {}, { userId = null } = {}) {
  const normalized = normalizeCampaignDraftInput(input)
  const template = await getTemplateOrThrow(normalized.templateId)
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`Campaign builder sin config Meta utilizable: ${error.message}`)
    return null
  })
  const configSnapshot = buildConfigSnapshot(metaConfig || {})
  const payload = buildCampaignPayload({ normalized, template, configSnapshot })
  const validation = validateCampaignPayload(payload, template, configSnapshot)
  const preview = buildPreview(payload, validation)
  const id = `meta_draft_${randomUUID()}`
  const traceId = randomUUID()
  const status = validation.readyForExecution ? 'ready' : 'needs_review'

  await db.run(`
    INSERT INTO meta_campaign_drafts (
      id,
      template_id,
      status,
      trace_id,
      name,
      user_id,
      source_content_json,
      config_snapshot_json,
      template_snapshot_json,
      payload_json,
      validation_json,
      preview_json,
      execution_status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_executed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    id,
    template.id,
    status,
    traceId,
    payload.campaign.name,
    userId,
    safeJson(normalized.sourceContent),
    safeJson(configSnapshot),
    safeJson(template),
    safeJson(payload),
    safeJson(validation),
    safeJson(preview)
  ])

  await logCampaignBuilderStep({
    draftId: id,
    traceId,
    step: 'create_draft',
    status,
    requestPayload: normalized.rawInput,
    responsePayload: { validation, preview }
  })

  return await getMetaCampaignDraft(id)
}

export async function getMetaCampaignDraft(draftId) {
  const row = await db.get('SELECT * FROM meta_campaign_drafts WHERE id = ?', [draftId])
  return normalizeDraftRow(row)
}

export async function rebuildMetaCampaignDraftPreview(draftId) {
  const draft = await getMetaCampaignDraft(draftId)

  if (!draft?.id) {
    throw new Error('No encontramos ese borrador de campaña.')
  }

  const template = draft.templateSnapshot?.id
    ? draft.templateSnapshot
    : await getTemplateOrThrow(draft.templateId)
  const metaConfig = await getMetaConfig().catch(error => {
    logger.warn(`No se pudo leer Meta para preview de campaña: ${error.message}`)
    return null
  })
  const configSnapshot = buildConfigSnapshot(metaConfig || {})
  const validation = validateCampaignPayload(draft.payload, template, configSnapshot)
  const preview = buildPreview(draft.payload, validation)
  const status = validation.readyForExecution ? 'ready' : 'needs_review'

  await db.run(`
    UPDATE meta_campaign_drafts
    SET status = ?,
        config_snapshot_json = ?,
        validation_json = ?,
        preview_json = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    status,
    safeJson(configSnapshot),
    safeJson(validation),
    safeJson(preview),
    draftId
  ])

  await logCampaignBuilderStep({
    draftId,
    traceId: draft.traceId,
    step: 'preview_draft',
    status,
    responsePayload: { validation, preview }
  })

  return await getMetaCampaignDraft(draftId)
}

export async function executeMetaCampaignDraft(draftId, { dryRun = false, confirmation = false } = {}) {
  const draft = await rebuildMetaCampaignDraftPreview(draftId)

  if (!draft?.id) {
    throw new Error('No encontramos ese borrador de campaña.')
  }

  if (!draft.validation?.readyForExecution) {
    await logCampaignBuilderStep({
      draftId,
      traceId: draft.traceId,
      step: dryRun ? 'dry_run_blocked' : 'execute_blocked',
      status: 'blocked',
      responsePayload: draft.validation,
      errorMessage: 'El borrador todavía necesita datos antes de ejecutarse.'
    })

    await db.run(`
      UPDATE meta_campaign_drafts
      SET execution_status = 'blocked',
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, ['El borrador todavía necesita datos antes de ejecutarse.', draftId])

    return {
      ok: false,
      status: 'needs_review',
      message: 'A esta campaña todavía le faltan datos antes de poder enviarla a Meta.',
      draft,
      validation: draft.validation
    }
  }

  if (dryRun) {
    await logCampaignBuilderStep({
      draftId,
      traceId: draft.traceId,
      step: 'dry_run',
      status: 'completed',
      requestPayload: draft.payload?.mcp,
      responsePayload: { ready: true, operations: draft.payload?.mcp?.operations || [] }
    })

    return {
      ok: true,
      status: 'ready_to_execute',
      message: 'La campaña ya está lista para enviarse a Meta cuando confirmes y el MCP esté conectado.',
      draft,
      mcp: draft.payload?.mcp || null
    }
  }

  if (!confirmation) {
    await logCampaignBuilderStep({
      draftId,
      traceId: draft.traceId,
      step: 'execute_confirmation_required',
      status: 'waiting_user',
      responsePayload: { requiresHumanApproval: true }
    })

    return {
      ok: false,
      status: 'confirmation_required',
      message: 'Antes de tocar Meta, confirma que quieres crear esta campaña con el preview actual.',
      draft,
      requiresConfirmation: true
    }
  }

  if (!MCP_EXECUTION_ENABLED || !MCP_AUTHORIZATION_TOKEN) {
    const message = 'El builder ya armó y validó el payload, pero la ejecución real por MCP todavía no está conectada en este entorno.'

    await logCampaignBuilderStep({
      draftId,
      traceId: draft.traceId,
      step: 'execute_mcp_not_connected',
      status: 'blocked',
      requestPayload: draft.payload?.mcp,
      responsePayload: {
        mcpServerUrl: META_ADS_MCP_SERVER_URL,
        executionEnabled: MCP_EXECUTION_ENABLED,
        hasAuthorization: Boolean(MCP_AUTHORIZATION_TOKEN)
      },
      errorMessage: message
    })

    await db.run(`
      UPDATE meta_campaign_drafts
      SET execution_status = 'mcp_not_connected',
          last_error = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [message, draftId])

    return {
      ok: false,
      status: 'mcp_not_connected',
      message,
      draft,
      mcp: draft.payload?.mcp || null
    }
  }

  const message = 'Adaptador MCP listo para conectarse: falta enlazar el runtime que ejecuta tools remotas de Meta Ads con aprobación humana.'

  await logCampaignBuilderStep({
    draftId,
    traceId: draft.traceId,
    step: 'execute_mcp_adapter_missing',
    status: 'blocked',
    requestPayload: draft.payload?.mcp,
    errorMessage: message
  })

  await db.run(`
    UPDATE meta_campaign_drafts
    SET execution_status = 'adapter_missing',
        last_error = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [message, draftId])

  return {
    ok: false,
    status: 'adapter_missing',
    message,
    draft,
    mcp: draft.payload?.mcp || null
  }
}

export async function listMetaCampaignDraftLogs(draftId) {
  return await db.all(`
    SELECT *
    FROM meta_campaign_execution_logs
    WHERE draft_id = ?
    ORDER BY created_at ASC
  `, [draftId])
}
