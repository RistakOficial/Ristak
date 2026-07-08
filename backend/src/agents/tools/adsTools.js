import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { getMetaConfig } from '../../services/metaAdsService.js'
import { DEFAULT_TIMEZONE, getAccountTimezone } from '../../utils/dateUtils.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../../utils/hiddenContactsFilter.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../../utils/paymentMode.js'

const isPostgres = Boolean(process.env.DATABASE_URL)
const SUCCESS_PAYMENT_STATUS_SQL = SUCCESS_PAYMENT_STATUSES
  .map(status => `'${String(status).replace(/'/g, "''")}'`)
  .join(', ')

function roundMoney(value) {
  const number = Number(value || 0)
  return Math.round(number * 100) / 100
}

function roundRatio(value) {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : null
}

function validateDateOnly(value, label) {
  const text = String(value || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new Error(`${label} debe venir en formato YYYY-MM-DD`)
  }
  return text
}

function maybeValidateDateOnly(value, label) {
  if (!value) return null
  return validateDateOnly(value, label)
}

function normalizeSearchEntity(value) {
  const entity = String(value || 'all').trim().toLowerCase()
  return ['campaign', 'adset', 'ad', 'all'].includes(entity) ? entity : 'all'
}

function escapeSqlLiteral(value) {
  return String(value || 'UTC').replace(/'/g, "''")
}

function validPaymentPredicate(alias = 'p') {
  const prefix = alias ? `${alias}.` : ''
  return `
    COALESCE(${prefix}amount, 0) > 0
    AND LOWER(COALESCE(${prefix}status, '')) IN (${SUCCESS_PAYMENT_STATUS_SQL})
    AND ${nonTestPaymentCondition(alias)}
  `
}

function sqlDateExpression(column, timezone = 'UTC') {
  if (!isPostgres) return `DATE(${column})`
  return `((${column})::timestamptz AT TIME ZONE '${escapeSqlLiteral(timezone)}')::date`
}

function sqlDateOnlyExpression(column) {
  return isPostgres ? `(${column})::date` : `DATE(${column})`
}

const CAMPAIGN_RETURN_GROUPS = {
  campaign: {
    key: "COALESCE(NULLIF(m.campaign_id, ''), NULLIF(m.campaign_name, ''), 'sin_campaign')",
    attributedKey: "COALESCE(NULLIF(ma.campaign_id, ''), NULLIF(ma.campaign_name, ''), 'sin_campaign')",
    name: "COALESCE(MAX(NULLIF(m.campaign_name, '')), MAX(NULLIF(m.campaign_id, '')), 'Campaña sin nombre')",
    orderBy: 'profit DESC'
  },
  adset: {
    key: "COALESCE(NULLIF(m.adset_id, ''), NULLIF(m.adset_name, ''), 'sin_adset')",
    attributedKey: "COALESCE(NULLIF(ma.adset_id, ''), NULLIF(ma.adset_name, ''), 'sin_adset')",
    name: "COALESCE(MAX(NULLIF(m.adset_name, '')), MAX(NULLIF(m.adset_id, '')), 'Conjunto sin nombre')",
    orderBy: 'profit DESC'
  },
  ad: {
    key: "COALESCE(NULLIF(m.ad_id, ''), NULLIF(m.ad_name, ''), 'sin_ad')",
    attributedKey: "COALESCE(NULLIF(ma.ad_id, ''), NULLIF(ma.ad_name, ''), 'sin_ad')",
    name: "COALESCE(MAX(NULLIF(m.ad_name, '')), MAX(NULLIF(m.ad_id, '')), 'Anuncio sin nombre')",
    orderBy: 'profit DESC'
  },
  total: {
    key: "'total'",
    attributedKey: "'total'",
    name: "'Total campañas'",
    orderBy: 'spend DESC'
  }
}

export async function getCampaignReturn({ startDate, endDate, groupBy = 'campaign', limit = 25 } = {}) {
  const safeStartDate = validateDateOnly(startDate, 'startDate')
  const safeEndDate = validateDateOnly(endDate, 'endDate')
  const safeGroupBy = CAMPAIGN_RETURN_GROUPS[groupBy] ? groupBy : 'campaign'
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25))
  const group = CAMPAIGN_RETURN_GROUPS[safeGroupBy]
  const timezone = await getAccountTimezone().catch(() => DEFAULT_TIMEZONE)
  const hiddenFilters = await getHiddenContactFilters()
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const contactWhere = [
    "c.attribution_ad_id IS NOT NULL",
    "c.attribution_ad_id != ''",
    `${sqlDateExpression('c.created_at', timezone)} >= ?`,
    `${sqlDateExpression('c.created_at', timezone)} <= ?`
  ]

  if (hiddenCondition) {
    contactWhere.push(hiddenCondition)
  }

  const metaDate = sqlDateOnlyExpression('m.date')
  const joinedMetaDate = sqlDateOnlyExpression('ma.date')
  const contactCreatedDate = sqlDateExpression('c.created_at', timezone)
  const groupByClause = safeGroupBy === 'total' ? '' : `GROUP BY ${group.key}`

  const rows = await db.all(
    `
      WITH spend AS (
        SELECT
          ${group.key} AS group_id,
          ${group.name} AS group_name,
          MAX(NULLIF(m.campaign_id, '')) AS campaign_id,
          MAX(NULLIF(m.campaign_name, '')) AS campaign_name,
          MAX(NULLIF(m.adset_id, '')) AS adset_id,
          MAX(NULLIF(m.adset_name, '')) AS adset_name,
          MAX(NULLIF(m.ad_id, '')) AS ad_id,
          MAX(NULLIF(m.ad_name, '')) AS ad_name,
          COALESCE(SUM(m.spend), 0) AS spend,
          COALESCE(SUM(m.clicks), 0) AS clicks,
          COALESCE(SUM(m.reach), 0) AS reach
        FROM meta_ads m
        WHERE ${metaDate} >= ?
          AND ${metaDate} <= ?
        ${groupByClause}
      ),
      valid_payments AS (
        SELECT
          p.contact_id,
          COUNT(*) AS payment_count,
          COALESCE(SUM(p.amount), 0) AS paid_revenue
        FROM payments p
        WHERE p.contact_id IS NOT NULL
          AND p.contact_id != ''
          AND ${validPaymentPredicate('p')}
        GROUP BY p.contact_id
      ),
      attributed_contacts AS (
        SELECT DISTINCT
          ${group.attributedKey} AS group_id,
          c.id AS contact_id,
          COALESCE(vp.payment_count, 0) AS payment_count,
          COALESCE(vp.paid_revenue, 0) AS paid_revenue
        FROM contacts c
        JOIN meta_ads ma
          ON ma.ad_id = c.attribution_ad_id
         AND ${joinedMetaDate} = ${contactCreatedDate}
        LEFT JOIN valid_payments vp ON vp.contact_id = c.id
        WHERE ${contactWhere.join(' AND ')}
      ),
      attributed_results AS (
        SELECT
          ac.group_id,
          COUNT(DISTINCT ac.contact_id) AS leads,
          COUNT(DISTINCT CASE WHEN EXISTS (
            SELECT 1 FROM appointments a WHERE a.contact_id = ac.contact_id
          ) THEN ac.contact_id END) AS appointments,
          COUNT(DISTINCT CASE WHEN
            EXISTS (
              SELECT 1
              FROM appointment_attendance_signals aas
              WHERE aas.contact_id = ac.contact_id
            )
            OR EXISTS (
              SELECT 1
              FROM appointments a2
              WHERE a2.contact_id = ac.contact_id
                AND LOWER(COALESCE(a2.appointment_status, a2.status, '')) IN ('showed', 'show', 'attended', 'completed', 'complete')
            )
            OR ac.payment_count > 0
          THEN ac.contact_id END) AS attendances,
          COUNT(DISTINCT CASE WHEN ac.payment_count > 0 THEN ac.contact_id END) AS sales,
          COALESCE(SUM(ac.payment_count), 0) AS paid_payments,
          COALESCE(SUM(ac.paid_revenue), 0) AS attributed_revenue
        FROM attributed_contacts ac
        GROUP BY ac.group_id
      )
      SELECT
        spend.group_id,
        spend.group_name,
        spend.campaign_id,
        spend.campaign_name,
        spend.adset_id,
        spend.adset_name,
        spend.ad_id,
        spend.ad_name,
        spend.spend,
        spend.clicks,
        spend.reach,
        COALESCE(attributed_results.leads, 0) AS leads,
        COALESCE(attributed_results.appointments, 0) AS appointments,
        COALESCE(attributed_results.attendances, 0) AS attendances,
        COALESCE(attributed_results.sales, 0) AS sales,
        COALESCE(attributed_results.paid_payments, 0) AS paid_payments,
        COALESCE(attributed_results.attributed_revenue, 0) AS attributed_revenue,
        COALESCE(attributed_results.attributed_revenue, 0) - spend.spend AS profit,
        CASE WHEN spend.spend > 0 THEN COALESCE(attributed_results.attributed_revenue, 0) / spend.spend ELSE NULL END AS roas,
        CASE WHEN COALESCE(attributed_results.leads, 0) > 0 THEN spend.spend / attributed_results.leads ELSE NULL END AS cost_per_lead,
        CASE WHEN COALESCE(attributed_results.sales, 0) > 0 THEN spend.spend / attributed_results.sales ELSE NULL END AS cost_per_sale
      FROM spend
      LEFT JOIN attributed_results ON attributed_results.group_id = spend.group_id
      ORDER BY ${group.orderBy}
      LIMIT ?
    `,
    [safeStartDate, safeEndDate, safeStartDate, safeEndDate, safeLimit]
  )

  const results = rows.map((row) => ({
    key: row.group_id,
    name: row.group_name || row.group_id,
    campaignId: row.campaign_id || null,
    campaignName: row.campaign_name || null,
    adsetId: row.adset_id || null,
    adsetName: row.adset_name || null,
    adId: row.ad_id || null,
    adName: row.ad_name || null,
    spend: roundMoney(row.spend),
    clicks: Number(row.clicks || 0),
    reach: Number(row.reach || 0),
    leads: Number(row.leads || 0),
    appointments: Number(row.appointments || 0),
    attendances: Number(row.attendances || 0),
    sales: Number(row.sales || 0),
    paidPayments: Number(row.paid_payments || 0),
    attributedRevenue: roundMoney(row.attributed_revenue),
    profit: roundMoney(row.profit),
    roas: roundRatio(row.roas),
    costPerLead: roundMoney(row.cost_per_lead),
    costPerSale: roundMoney(row.cost_per_sale)
  }))

  return {
    ok: true,
    startDate: safeStartDate,
    endDate: safeEndDate,
    groupBy: safeGroupBy,
    attributionModel: 'contacts.attribution_ad_id = meta_ads.ad_id first-touch de adquisición, validando que el anuncio existiera el mismo día local en que se creó el contacto; ventas/ingresos = payments exitosos en vivo del contacto atribuido, sumados como LTV y atribuidos al día de creación del contacto. Retouches posteriores se guardan en historial, pero no pisan este ad_id.',
    total: results.length,
    results
  }
}

export const getAdsStatusTool = tool({
  name: 'get_ads_connection_status',
  description: 'Verifica si Meta Ads está conectado y qué cuenta publicitaria se usa. Llámala primero si las métricas salen vacías.',
  parameters: z.object({}),
  execute: async () => {
    try {
      const config = await getMetaConfig()
      return {
        ok: true,
        connected: Boolean(config?.adAccountId || config?.ad_account_id),
        adAccountId: config?.adAccountId || config?.ad_account_id || null,
        pixelId: config?.pixelId || config?.pixel_id || null
      }
    } catch {
      return { ok: true, connected: false }
    }
  }
})

export const getAdsMetricsTool = tool({
  name: 'get_ads_metrics',
  description: 'Obtiene métricas de Meta Ads (gasto, clics, alcance, CPC y CTR promedio) en un rango de fechas, agrupadas por campaña, conjunto de anuncios, anuncio o día.',
  parameters: z.object({
    startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
    endDate: z.string().describe('Fecha final YYYY-MM-DD'),
    groupBy: z.enum(['campaign', 'adset', 'ad', 'date', 'total']).describe('Agrupación de las métricas'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de filas (default 25)')
  }),
  execute: async ({ startDate, endDate, groupBy, limit }) => {
    const groupColumn = {
      campaign: 'campaign_name',
      adset: 'adset_name',
      ad: 'ad_name',
      date: 'date'
    }[groupBy]

    const selectKey = groupColumn ? `${groupColumn} AS group_key,` : `'total' AS group_key,`
    const groupClause = groupColumn ? `GROUP BY ${groupColumn}` : ''

    const rows = await db.all(
      `SELECT ${selectKey}
              SUM(spend) AS spend,
              SUM(clicks) AS clicks,
              SUM(reach) AS reach,
              AVG(ctr) AS avg_ctr
       FROM meta_ads
       WHERE date >= ? AND date <= ?
       ${groupClause}
       ORDER BY spend DESC
       LIMIT ?`,
      [startDate, endDate, limit || 25]
    )

    const metrics = rows.map((row) => {
      const spend = Number(row.spend || 0)
      const clicks = Number(row.clicks || 0)
      return {
        group: row.group_key,
        spend: Math.round(spend * 100) / 100,
        clicks,
        reach: Number(row.reach || 0),
        cpc: clicks > 0 ? Math.round((spend / clicks) * 100) / 100 : null,
        avgCtr: row.avg_ctr !== null && row.avg_ctr !== undefined ? Math.round(Number(row.avg_ctr) * 100) / 100 : null
      }
    })

    return { ok: true, startDate, endDate, groupBy, total: metrics.length, metrics }
  }
})

export const getCampaignReturnTool = tool({
  name: 'get_campaign_return',
  description: 'Mide el retorno real de campañas/anuncios cruzando Meta Ads con la atribución de contactos. Úsala para ROAS, retorno, rentabilidad, leads, citas, asistencias, ventas e ingresos atribuidos; no usa los "resultados" declarados por Meta.',
  parameters: z.object({
    startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
    endDate: z.string().describe('Fecha final YYYY-MM-DD'),
    groupBy: z.enum(['campaign', 'adset', 'ad', 'total']).describe('Agrupación del retorno real'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de filas (default 25)')
  }),
  execute: async ({ startDate, endDate, groupBy, limit }) => getCampaignReturn({
    startDate,
    endDate,
    groupBy,
    limit
  })
})

export async function searchAds({ query = '', startDate = null, endDate = null, entity = 'all', limit = 25 } = {}) {
  const safeQuery = String(query || '').trim().toLowerCase()
  const safeStartDate = maybeValidateDateOnly(startDate, 'startDate')
  const safeEndDate = maybeValidateDateOnly(endDate, 'endDate')
  const safeEntity = normalizeSearchEntity(entity)
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25))
  const like = `%${safeQuery}%`

  const buildDateClause = (params) => {
    const conditions = []
    if (safeStartDate) {
      conditions.push('date >= ?')
      params.push(safeStartDate)
    }
    if (safeEndDate) {
      conditions.push('date <= ?')
      params.push(safeEndDate)
    }
    return conditions.length ? `AND ${conditions.join(' AND ')}` : ''
  }

  const unions = []
  const params = []

  if (safeEntity === 'all' || safeEntity === 'campaign') {
    const localParams = [like, like]
    const dateClause = buildDateClause(localParams)
    unions.push(`
      SELECT
        'campaign' AS entity_type,
        campaign_id AS entity_id,
        campaign_name AS entity_name,
        campaign_id AS campaign_id,
        campaign_name AS campaign_name,
        NULL AS adset_id,
        NULL AS adset_name,
        NULL AS ad_id,
        NULL AS ad_name,
        SUM(spend) AS spend,
        SUM(clicks) AS clicks,
        SUM(reach) AS reach,
        MIN(date) AS first_date,
        MAX(date) AS last_date
      FROM meta_ads
      WHERE (LOWER(COALESCE(campaign_name, '')) LIKE ? OR LOWER(COALESCE(campaign_id, '')) LIKE ?)
        ${dateClause}
      GROUP BY campaign_id, campaign_name
    `)
    params.push(...localParams)
  }

  if (safeEntity === 'all' || safeEntity === 'adset') {
    const localParams = [like, like]
    const dateClause = buildDateClause(localParams)
    unions.push(`
      SELECT
        'adset' AS entity_type,
        adset_id AS entity_id,
        adset_name AS entity_name,
        MAX(campaign_id) AS campaign_id,
        MAX(campaign_name) AS campaign_name,
        adset_id AS adset_id,
        adset_name AS adset_name,
        NULL AS ad_id,
        NULL AS ad_name,
        SUM(spend) AS spend,
        SUM(clicks) AS clicks,
        SUM(reach) AS reach,
        MIN(date) AS first_date,
        MAX(date) AS last_date
      FROM meta_ads
      WHERE (LOWER(COALESCE(adset_name, '')) LIKE ? OR LOWER(COALESCE(adset_id, '')) LIKE ?)
        ${dateClause}
      GROUP BY adset_id, adset_name
    `)
    params.push(...localParams)
  }

  if (safeEntity === 'all' || safeEntity === 'ad') {
    const localParams = [like, like]
    const dateClause = buildDateClause(localParams)
    unions.push(`
      SELECT
        'ad' AS entity_type,
        ad_id AS entity_id,
        ad_name AS entity_name,
        MAX(campaign_id) AS campaign_id,
        MAX(campaign_name) AS campaign_name,
        MAX(adset_id) AS adset_id,
        MAX(adset_name) AS adset_name,
        ad_id AS ad_id,
        ad_name AS ad_name,
        SUM(spend) AS spend,
        SUM(clicks) AS clicks,
        SUM(reach) AS reach,
        MIN(date) AS first_date,
        MAX(date) AS last_date
      FROM meta_ads
      WHERE (LOWER(COALESCE(ad_name, '')) LIKE ? OR LOWER(COALESCE(ad_id, '')) LIKE ?)
        ${dateClause}
      GROUP BY ad_id, ad_name
    `)
    params.push(...localParams)
  }

  const rows = await db.all(
    `SELECT *
     FROM (${unions.join('\nUNION ALL\n')}) matches
     WHERE COALESCE(entity_id, '') != ''
     ORDER BY spend DESC, last_date DESC
     LIMIT ?`,
    [...params, safeLimit]
  )

  return {
    ok: true,
    query: safeQuery,
    entity: safeEntity,
    startDate: safeStartDate,
    endDate: safeEndDate,
    total: rows.length,
    results: rows.map((row) => ({
      entityType: row.entity_type,
      id: row.entity_id,
      name: row.entity_name || row.entity_id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      adsetId: row.adset_id,
      adsetName: row.adset_name,
      adId: row.ad_id,
      adName: row.ad_name,
      spend: roundMoney(row.spend),
      clicks: Number(row.clicks || 0),
      reach: Number(row.reach || 0),
      firstDate: row.first_date,
      lastDate: row.last_date
    }))
  }
}

export const searchAdsTool = tool({
  name: 'search_ads',
  description: 'Busca campañas, conjuntos de anuncios o anuncios de Meta por nombre o ID en la tabla meta_ads. Úsala cuando el usuario diga "busca este anuncio/campaña" antes de comparar rendimiento.',
  parameters: z.object({
    query: z.string().describe('Texto del nombre o ID a buscar'),
    startDate: z.string().nullable().describe('Fecha inicial YYYY-MM-DD para limitar la búsqueda'),
    endDate: z.string().nullable().describe('Fecha final YYYY-MM-DD para limitar la búsqueda'),
    entity: z.enum(['campaign', 'adset', 'ad', 'all']).nullable().describe('Tipo de entidad a buscar; default all'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de resultados (default 25)')
  }),
  execute: async ({ query, startDate, endDate, entity, limit }) => searchAds({ query, startDate, endDate, entity: entity || 'all', limit })
})

export const listCampaignsTool = tool({
  name: 'list_ad_campaigns',
  description: 'Lista las campañas de Meta Ads con actividad en un rango de fechas, con su gasto total y última fecha con datos.',
  parameters: z.object({
    startDate: z.string().describe('Fecha inicial YYYY-MM-DD'),
    endDate: z.string().describe('Fecha final YYYY-MM-DD'),
    limit: z.number().int().min(1).max(100).nullable().describe('Máximo de campañas (default 25)')
  }),
  execute: async ({ startDate, endDate, limit }) => {
    const rows = await db.all(
      `SELECT campaign_id, campaign_name,
              SUM(spend) AS spend,
              SUM(clicks) AS clicks,
              MAX(date) AS last_active_date
       FROM meta_ads
       WHERE date >= ? AND date <= ?
       GROUP BY campaign_id, campaign_name
       ORDER BY spend DESC
       LIMIT ?`,
      [startDate, endDate, limit || 25]
    )
    return {
      ok: true,
      total: rows.length,
      campaigns: rows.map((row) => ({
        campaignId: row.campaign_id,
        name: row.campaign_name,
        spend: Math.round(Number(row.spend || 0) * 100) / 100,
        clicks: Number(row.clicks || 0),
        lastActiveDate: row.last_active_date
      }))
    }
  }
})

export const adsTools = [getAdsStatusTool, searchAdsTool, getAdsMetricsTool, getCampaignReturnTool, listCampaignsTool]
