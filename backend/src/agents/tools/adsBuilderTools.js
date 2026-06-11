import { tool } from '@openai/agents'
import { z } from 'zod'
import { API_URLS } from '../../config/constants.js'
import { getMetaConfig } from '../../services/metaAdsService.js'

/**
 * Herramientas de CREACIÓN de publicidad en Meta (campañas, conjuntos, anuncios,
 * creativos y públicos) sobre el Marketing API, con el token y la cuenta
 * publicitaria que Ristak ya tiene conectados. Espejo del toolset del MCP
 * oficial de Facebook Ads (mcp.facebook.com/ads), que requiere su propio OAuth.
 *
 * Seguridad: todo se crea en PAUSED; activar exige confirmación explícita.
 */

async function getMetaContext() {
  const config = await getMetaConfig().catch(() => null)
  const accessToken = config?.access_token || config?.accessToken || null
  const adAccountId = String(config?.ad_account_id || config?.adAccountId || '').replace(/^act_/, '')
  if (!accessToken || !adAccountId) {
    return { error: 'Meta Ads no está conectado. Conecta el token y la cuenta publicitaria en Configuración > Publicidad.' }
  }
  return {
    accessToken,
    adAccountId,
    pixelId: config?.pixel_id || config?.pixelId || null,
    pageId: config?.page_id || config?.pageId || null
  }
}

async function metaApi(path, { method = 'GET', params = {}, body = null, accessToken } = {}) {
  const search = new URLSearchParams({ access_token: accessToken })
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value))
  }

  const response = await fetch(`${API_URLS.META_GRAPH}/${path}?${search.toString()}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })

  const json = await response.json().catch(() => null)
  if (!response.ok || json?.error) {
    const err = json?.error
    const detail = err ? `${err.message}${err.error_user_msg ? ` — ${err.error_user_msg}` : ''} (código ${err.code}${err.error_subcode ? `/${err.error_subcode}` : ''})` : `HTTP ${response.status}`
    return { ok: false, error: `Meta API: ${detail}` }
  }
  return { ok: true, data: json }
}

function requireConfirm(confirm, action) {
  if (!confirm) {
    return { ok: false, error: `Falta confirmación del usuario. Resume ${action} (nombre, presupuesto, segmentación) y pide aprobación antes de llamar con confirm=true.` }
  }
  return null
}

const mxnToCents = (amount) => Math.round(Number(amount) * 100)

export const listMetaPagesTool = tool({
  name: 'list_meta_pages',
  description: 'Lista las páginas de Facebook que administra el token conectado (con su Instagram vinculado). Necesitas un pageId para crear creativos de anuncios.',
  parameters: z.object({}),
  execute: async () => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi('me/accounts', {
      accessToken: ctx.accessToken,
      params: { fields: 'id,name,category,instagram_business_account{id,username}', limit: 50 }
    })
    if (!result.ok) return result
    return {
      ok: true,
      pages: (result.data?.data || []).map((page) => ({
        id: page.id,
        name: page.name,
        category: page.category,
        instagram: page.instagram_business_account ? { id: page.instagram_business_account.id, username: page.instagram_business_account.username } : null
      }))
    }
  }
})

export const listLiveCampaignsTool = tool({
  name: 'list_campaigns',
  description: 'Lista las campañas reales de la cuenta publicitaria en Meta (en vivo, no la copia local): id, nombre, estatus, objetivo y presupuesto.',
  parameters: z.object({
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de campañas (default 25)')
  }),
  execute: async ({ limit }) => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(`act_${ctx.adAccountId}/campaigns`, {
      accessToken: ctx.accessToken,
      params: { fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time', limit: limit || 25 }
    })
    if (!result.ok) return result
    return {
      ok: true,
      campaigns: (result.data?.data || []).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.effective_status || c.status,
        objective: c.objective,
        dailyBudgetMxn: c.daily_budget ? Number(c.daily_budget) / 100 : null,
        lifetimeBudgetMxn: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
        createdTime: c.created_time
      }))
    }
  }
})

export const createCampaignTool = tool({
  name: 'create_campaign',
  description: 'Crea una campaña nueva en Meta Ads. SIEMPRE se crea en PAUSED (no gasta hasta activarla). Antes de llamar, resume nombre y objetivo al usuario y pide aprobación.',
  parameters: z.object({
    name: z.string().describe('Nombre de la campaña'),
    objective: z.enum(['OUTCOME_LEADS', 'OUTCOME_SALES', 'OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS', 'OUTCOME_ENGAGEMENT', 'OUTCOME_APP_PROMOTION']).describe('Objetivo de la campaña'),
    specialAdCategories: z.array(z.enum(['HOUSING', 'EMPLOYMENT', 'CREDIT', 'ISSUES_ELECTIONS_POLITICS', 'FINANCIAL_PRODUCTS_SERVICES'])).nullable().describe('Solo si aplica una categoría especial regulada; normalmente null'),
    confirm: z.boolean().describe('true solo si el usuario ya aprobó la creación')
  }),
  execute: async ({ name, objective, specialAdCategories, confirm }) => {
    const blocked = requireConfirm(confirm, 'la campaña a crear')
    if (blocked) return blocked
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(`act_${ctx.adAccountId}/campaigns`, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body: {
        name,
        objective,
        status: 'PAUSED',
        buying_type: 'AUCTION',
        special_ad_categories: specialAdCategories || []
      }
    })
    if (!result.ok) return result
    return { ok: true, campaignId: result.data?.id, status: 'PAUSED', note: 'Campaña creada en pausa; no gasta hasta activarla.' }
  }
})

export const listAdSetsTool = tool({
  name: 'list_ad_sets',
  description: 'Lista los conjuntos de anuncios de la cuenta o de una campaña específica, con presupuesto, optimización y estatus.',
  parameters: z.object({
    campaignId: z.string().nullable().describe('Filtrar por campaña'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo (default 25)')
  }),
  execute: async ({ campaignId, limit }) => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const path = campaignId ? `${campaignId}/adsets` : `act_${ctx.adAccountId}/adsets`
    const result = await metaApi(path, {
      accessToken: ctx.accessToken,
      params: { fields: 'id,name,status,effective_status,campaign_id,daily_budget,optimization_goal,billing_event,targeting', limit: limit || 25 }
    })
    if (!result.ok) return result
    return {
      ok: true,
      adSets: (result.data?.data || []).map((s) => ({
        id: s.id,
        name: s.name,
        status: s.effective_status || s.status,
        campaignId: s.campaign_id,
        dailyBudgetMxn: s.daily_budget ? Number(s.daily_budget) / 100 : null,
        optimizationGoal: s.optimization_goal,
        targetingSummary: s.targeting ? {
          countries: s.targeting.geo_locations?.countries || null,
          ageMin: s.targeting.age_min,
          ageMax: s.targeting.age_max,
          interests: (s.targeting.flexible_spec?.[0]?.interests || s.targeting.interests || []).map((i) => i.name)
        } : null
      }))
    }
  }
})

export const createAdSetTool = tool({
  name: 'create_ad_set',
  description: 'Crea un conjunto de anuncios en una campaña, con presupuesto diario, optimización y segmentación (países, edades, intereses, públicos personalizados). SIEMPRE se crea en PAUSED. Resume presupuesto y segmentación al usuario y pide aprobación antes de llamar.',
  parameters: z.object({
    name: z.string().describe('Nombre del conjunto'),
    campaignId: z.string().describe('ID de la campaña (usa list_campaigns o create_campaign)'),
    dailyBudgetMxn: z.number().positive().describe('Presupuesto diario en MXN (ej. 150 = $150/día)'),
    optimizationGoal: z.enum(['LINK_CLICKS', 'LANDING_PAGE_VIEWS', 'REACH', 'IMPRESSIONS', 'LEAD_GENERATION', 'OFFSITE_CONVERSIONS', 'CONVERSATIONS']).describe('Qué optimiza Meta'),
    countries: z.array(z.string()).describe('Códigos de país ISO-2, ej. ["MX"]'),
    ageMin: z.number().int().min(18).max(65).nullable().describe('Edad mínima (default 18)'),
    ageMax: z.number().int().min(18).max(65).nullable().describe('Edad máxima (default 65)'),
    interestIds: z.array(z.string()).nullable().describe('IDs de intereses (usa search_targeting_interests)'),
    customAudienceIds: z.array(z.string()).nullable().describe('IDs de públicos personalizados a incluir'),
    pixelId: z.string().nullable().describe('Pixel para OFFSITE_CONVERSIONS (si la cuenta tiene uno configurado se usa solo)'),
    confirm: z.boolean().describe('true solo si el usuario ya aprobó presupuesto y segmentación')
  }),
  execute: async ({ name, campaignId, dailyBudgetMxn, optimizationGoal, countries, ageMin, ageMax, interestIds, customAudienceIds, pixelId, confirm }) => {
    const blocked = requireConfirm(confirm, 'el conjunto de anuncios')
    if (blocked) return blocked
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }

    const targeting = {
      geo_locations: { countries },
      age_min: ageMin || 18,
      age_max: ageMax || 65
    }
    if (interestIds?.length) targeting.flexible_spec = [{ interests: interestIds.map((id) => ({ id })) }]
    if (customAudienceIds?.length) targeting.custom_audiences = customAudienceIds.map((id) => ({ id }))

    const body = {
      name,
      campaign_id: campaignId,
      daily_budget: mxnToCents(dailyBudgetMxn),
      billing_event: 'IMPRESSIONS',
      optimization_goal: optimizationGoal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting,
      status: 'PAUSED'
    }

    const effectivePixel = pixelId || ctx.pixelId
    if (optimizationGoal === 'OFFSITE_CONVERSIONS') {
      if (!effectivePixel) return { ok: false, error: 'Para optimizar a conversiones necesito el pixelId (no hay pixel configurado en la cuenta).' }
      body.promoted_object = { pixel_id: effectivePixel, custom_event_type: 'LEAD' }
    }

    const result = await metaApi(`act_${ctx.adAccountId}/adsets`, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body
    })
    if (!result.ok) return result
    return { ok: true, adSetId: result.data?.id, status: 'PAUSED', dailyBudgetMxn }
  }
})

export const listAdsTool = tool({
  name: 'list_ads',
  description: 'Lista los anuncios de la cuenta o de un conjunto específico, con su estatus y creativo.',
  parameters: z.object({
    adSetId: z.string().nullable().describe('Filtrar por conjunto de anuncios'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo (default 25)')
  }),
  execute: async ({ adSetId, limit }) => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const path = adSetId ? `${adSetId}/ads` : `act_${ctx.adAccountId}/ads`
    const result = await metaApi(path, {
      accessToken: ctx.accessToken,
      params: { fields: 'id,name,status,effective_status,adset_id,creative{id}', limit: limit || 25 }
    })
    if (!result.ok) return result
    return {
      ok: true,
      ads: (result.data?.data || []).map((ad) => ({
        id: ad.id,
        name: ad.name,
        status: ad.effective_status || ad.status,
        adSetId: ad.adset_id,
        creativeId: ad.creative?.id || null
      }))
    }
  }
})

export const createAdCreativeTool = tool({
  name: 'create_ad_creative',
  description: 'Crea el creativo de un anuncio (texto, link, título, imagen y botón) asociado a una página de Facebook. No gasta dinero. Necesitas pageId (usa list_meta_pages).',
  parameters: z.object({
    name: z.string().describe('Nombre interno del creativo'),
    pageId: z.string().describe('ID de la página de Facebook que firma el anuncio'),
    message: z.string().describe('Texto principal del anuncio'),
    link: z.string().describe('URL de destino'),
    headline: z.string().nullable().describe('Título corto del anuncio'),
    description: z.string().nullable().describe('Descripción secundaria'),
    imageUrl: z.string().nullable().describe('URL pública de la imagen del anuncio'),
    callToAction: z.enum(['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'GET_OFFER', 'SUBSCRIBE', 'BOOK_NOW', 'GET_QUOTE']).nullable().describe('Botón del anuncio (default LEARN_MORE)')
  }),
  execute: async ({ name, pageId, message, link, headline, description, imageUrl, callToAction }) => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }

    const linkData = {
      message,
      link,
      ...(headline ? { name: headline } : {}),
      ...(description ? { description } : {}),
      ...(imageUrl ? { picture: imageUrl } : {}),
      call_to_action: { type: callToAction || 'LEARN_MORE', value: { link } }
    }

    const result = await metaApi(`act_${ctx.adAccountId}/adcreatives`, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body: {
        name,
        object_story_spec: { page_id: pageId, link_data: linkData }
      }
    })
    if (!result.ok) return result
    return { ok: true, creativeId: result.data?.id }
  }
})

export const createAdTool = tool({
  name: 'create_ad',
  description: 'Crea un anuncio dentro de un conjunto usando un creativo ya creado (create_ad_creative). SIEMPRE se crea en PAUSED. Pide aprobación antes de llamar.',
  parameters: z.object({
    name: z.string().describe('Nombre del anuncio'),
    adSetId: z.string().describe('ID del conjunto de anuncios'),
    creativeId: z.string().describe('ID del creativo (de create_ad_creative)'),
    confirm: z.boolean().describe('true solo si el usuario ya aprobó')
  }),
  execute: async ({ name, adSetId, creativeId, confirm }) => {
    const blocked = requireConfirm(confirm, 'el anuncio a crear')
    if (blocked) return blocked
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(`act_${ctx.adAccountId}/ads`, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body: { name, adset_id: adSetId, creative: { creative_id: creativeId }, status: 'PAUSED' }
    })
    if (!result.ok) return result
    return { ok: true, adId: result.data?.id, status: 'PAUSED', note: 'Anuncio creado en pausa; actívalo con update_entity_status cuando el usuario confirme.' }
  }
})

export const updateEntityStatusTool = tool({
  name: 'update_entity_status',
  description: 'Activa, pausa o archiva una campaña, conjunto o anuncio. ACTIVAR EMPIEZA A GASTAR DINERO: exige confirmación explícita del usuario con el presupuesto a la vista.',
  parameters: z.object({
    entityId: z.string().describe('ID de la campaña, conjunto o anuncio'),
    status: z.enum(['ACTIVE', 'PAUSED', 'ARCHIVED']).describe('Nuevo estatus'),
    confirm: z.boolean().describe('true solo si el usuario ya confirmó (obligatorio para ACTIVE)')
  }),
  execute: async ({ entityId, status, confirm }) => {
    if (status === 'ACTIVE') {
      const blocked = requireConfirm(confirm, 'la activación (va a empezar a gastar)')
      if (blocked) return blocked
    }
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(entityId, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body: { status }
    })
    if (!result.ok) return result
    return { ok: true, entityId, status }
  }
})

export const updateAdSetBudgetTool = tool({
  name: 'update_ad_set_budget',
  description: 'Cambia el presupuesto diario de un conjunto de anuncios. Resume el cambio (de cuánto a cuánto) y pide aprobación antes de llamar.',
  parameters: z.object({
    adSetId: z.string().describe('ID del conjunto'),
    dailyBudgetMxn: z.number().positive().describe('Nuevo presupuesto diario en MXN'),
    confirm: z.boolean().describe('true solo si el usuario ya aprobó el nuevo presupuesto')
  }),
  execute: async ({ adSetId, dailyBudgetMxn, confirm }) => {
    const blocked = requireConfirm(confirm, 'el cambio de presupuesto')
    if (blocked) return blocked
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(adSetId, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body: { daily_budget: mxnToCents(dailyBudgetMxn) }
    })
    if (!result.ok) return result
    return { ok: true, adSetId, dailyBudgetMxn }
  }
})

export const listCustomAudiencesTool = tool({
  name: 'list_custom_audiences',
  description: 'Lista los públicos personalizados y similares (lookalike) de la cuenta publicitaria, con su tipo y tamaño aproximado.',
  parameters: z.object({
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo (default 25)')
  }),
  execute: async ({ limit }) => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(`act_${ctx.adAccountId}/customaudiences`, {
      accessToken: ctx.accessToken,
      params: { fields: 'id,name,subtype,description,approximate_count_lower_bound,delivery_status', limit: limit || 25 }
    })
    if (!result.ok) return result
    return {
      ok: true,
      audiences: (result.data?.data || []).map((a) => ({
        id: a.id,
        name: a.name,
        subtype: a.subtype,
        description: a.description || null,
        approximateSize: a.approximate_count_lower_bound ?? null,
        deliveryStatus: a.delivery_status?.description || null
      }))
    }
  }
})

export const createCustomAudienceTool = tool({
  name: 'create_custom_audience',
  description: 'Crea un público personalizado: "website" (visitantes del sitio vía pixel, con días de retención y filtro de URL opcional) o "customer_list" (lista de clientes para subir después desde el administrador de anuncios).',
  parameters: z.object({
    name: z.string().describe('Nombre del público'),
    type: z.enum(['website', 'customer_list']).describe('Tipo de público'),
    description: z.string().nullable().describe('Descripción opcional'),
    retentionDays: z.number().int().min(1).max(180).nullable().describe('Solo website: días de retención (default 30)'),
    urlContains: z.string().nullable().describe('Solo website: incluir solo visitantes de URLs que contengan este texto'),
    pixelId: z.string().nullable().describe('Solo website: pixel a usar (si la cuenta tiene uno configurado se usa solo)'),
    confirm: z.boolean().describe('true solo si el usuario ya aprobó')
  }),
  execute: async ({ name, type, description, retentionDays, urlContains, pixelId, confirm }) => {
    const blocked = requireConfirm(confirm, 'el público a crear')
    if (blocked) return blocked
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }

    let body
    if (type === 'website') {
      const effectivePixel = pixelId || ctx.pixelId
      if (!effectivePixel) return { ok: false, error: 'Para públicos de sitio web necesito el pixelId (no hay pixel configurado en la cuenta).' }
      const rule = {
        inclusions: {
          operator: 'or',
          rules: [{
            event_sources: [{ id: effectivePixel, type: 'pixel' }],
            retention_seconds: (retentionDays || 30) * 86400,
            filter: {
              operator: 'and',
              filters: [
                urlContains
                  ? { field: 'url', operator: 'i_contains', value: urlContains }
                  : { field: 'event', operator: 'eq', value: 'PageView' }
              ]
            }
          }]
        }
      }
      body = { name, description: description || undefined, rule: JSON.stringify(rule), prefill: true }
    } else {
      body = { name, description: description || undefined, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY' }
    }

    const result = await metaApi(`act_${ctx.adAccountId}/customaudiences`, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body
    })
    if (!result.ok) return result
    return { ok: true, audienceId: result.data?.id, type }
  }
})

export const createLookalikeAudienceTool = tool({
  name: 'create_lookalike_audience',
  description: 'Crea un público similar (lookalike) a partir de un público personalizado existente. ratio 1 = el 1% más parecido (más preciso), 10 = el 10% (más alcance).',
  parameters: z.object({
    name: z.string().describe('Nombre del público similar'),
    originAudienceId: z.string().describe('ID del público origen (usa list_custom_audiences)'),
    country: z.string().describe('País ISO-2 donde buscar similares, ej. MX'),
    ratio: z.number().int().min(1).max(10).describe('Porcentaje de similitud 1-10'),
    confirm: z.boolean().describe('true solo si el usuario ya aprobó')
  }),
  execute: async ({ name, originAudienceId, country, ratio, confirm }) => {
    const blocked = requireConfirm(confirm, 'el público similar')
    if (blocked) return blocked
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi(`act_${ctx.adAccountId}/customaudiences`, {
      method: 'POST',
      accessToken: ctx.accessToken,
      body: {
        name,
        subtype: 'LOOKALIKE',
        origin_audience_id: originAudienceId,
        lookalike_spec: JSON.stringify({ ratio: ratio / 100, country })
      }
    })
    if (!result.ok) return result
    return { ok: true, audienceId: result.data?.id }
  }
})

export const searchTargetingInterestsTool = tool({
  name: 'search_targeting_interests',
  description: 'Busca intereses de segmentación en Meta por palabra clave (ej. "odontología", "fitness") y devuelve sus IDs y tamaño de audiencia, para usarlos en create_ad_set.',
  parameters: z.object({
    query: z.string().describe('Palabra clave del interés'),
    limit: z.number().int().min(1).max(25).nullable().describe('Máximo (default 10)')
  }),
  execute: async ({ query, limit }) => {
    const ctx = await getMetaContext()
    if (ctx.error) return { ok: false, error: ctx.error }
    const result = await metaApi('search', {
      accessToken: ctx.accessToken,
      params: { type: 'adinterest', q: query, limit: limit || 10 }
    })
    if (!result.ok) return result
    return {
      ok: true,
      interests: (result.data?.data || []).map((i) => ({
        id: i.id,
        name: i.name,
        audienceSizeLower: i.audience_size_lower_bound ?? null,
        audienceSizeUpper: i.audience_size_upper_bound ?? null,
        path: Array.isArray(i.path) ? i.path.join(' > ') : null
      }))
    }
  }
})

export const adsBuilderTools = [
  listMetaPagesTool,
  listLiveCampaignsTool,
  createCampaignTool,
  listAdSetsTool,
  createAdSetTool,
  listAdsTool,
  createAdCreativeTool,
  createAdTool,
  updateEntityStatusTool,
  updateAdSetBudgetTool,
  listCustomAudiencesTool,
  createCustomAudienceTool,
  createLookalikeAudienceTool,
  searchTargetingInterestsTool
]
