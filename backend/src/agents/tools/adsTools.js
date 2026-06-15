import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { getMetaConfig } from '../../services/metaAdsService.js'

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

export const adsTools = [getAdsStatusTool, getAdsMetricsTool, listCampaignsTool]
