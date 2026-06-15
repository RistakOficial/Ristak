import { tool } from '@openai/agents'
import { z } from 'zod'
import { db } from '../../config/database.js'
import { getConnectedMetaSocialProfiles } from '../../services/metaSocialProfilesService.js'

export const listSocialProfilesTool = tool({
  name: 'list_social_profiles',
  description: 'Lista los perfiles de redes sociales conectados (página de Facebook e Instagram) con sus seguidores. Úsala para saber qué hay conectado antes de analizar mensajes.',
  parameters: z.object({}),
  execute: async () => {
    try {
      const result = await getConnectedMetaSocialProfiles()
      return {
        ok: true,
        connected: Boolean(result?.connected),
        message: result?.message || null,
        profiles: (result?.profiles || []).map((profile) => ({
          platform: profile.platform || profile.type,
          id: profile.id,
          name: profile.name || profile.username,
          username: profile.username || null,
          followers: profile.followersCount ?? profile.followers_count ?? profile.fanCount ?? null
        }))
      }
    } catch (error) {
      return { ok: false, error: `No pude consultar los perfiles sociales: ${error.message}` }
    }
  }
})

export const getSocialInboxStatsTool = tool({
  name: 'get_social_inbox_stats',
  description: 'Resumen de la bandeja social (Facebook/Instagram): mensajes y conversaciones por plataforma en un rango de fechas, separando recibidos y enviados.',
  parameters: z.object({
    startDate: z.string().describe('Fecha inicial ISO 8601 o YYYY-MM-DD'),
    endDate: z.string().describe('Fecha final ISO 8601 o YYYY-MM-DD')
  }),
  execute: async ({ startDate, endDate }) => {
    const rows = await db.all(
      `SELECT platform,
              direction,
              COUNT(*) AS message_count,
              COUNT(DISTINCT meta_social_contact_id) AS conversation_count
       FROM meta_social_messages
       WHERE message_timestamp >= ? AND message_timestamp <= ?
       GROUP BY platform, direction
       ORDER BY platform`,
      [startDate, endDate]
    )
    return {
      ok: true,
      startDate,
      endDate,
      stats: rows.map((row) => ({
        platform: row.platform,
        direction: row.direction,
        messages: Number(row.message_count || 0),
        conversations: Number(row.conversation_count || 0)
      }))
    }
  }
})

export const listSocialConversationsTool = tool({
  name: 'list_social_conversations',
  description: 'Lista las conversaciones sociales más recientes (quién escribió, plataforma, último mensaje y si ya está vinculado a un contacto).',
  parameters: z.object({
    platform: z.string().nullable().describe('Filtrar por plataforma: facebook | instagram'),
    limit: z.number().int().min(1).max(50).nullable().describe('Máximo de conversaciones (default 15)')
  }),
  execute: async ({ platform, limit }) => {
    const params = []
    let sql = `
      SELECT sc.id, sc.platform, sc.profile_name, sc.username, sc.contact_id,
             sc.last_seen_at, sc.message_count, c.full_name AS contact_name
      FROM meta_social_contacts sc
      LEFT JOIN contacts c ON c.id = sc.contact_id
      WHERE 1 = 1`
    if (platform) {
      sql += ' AND sc.platform = ?'
      params.push(String(platform).toLowerCase())
    }
    sql += ' ORDER BY sc.last_seen_at DESC LIMIT ?'
    params.push(limit || 15)

    const rows = await db.all(sql, params)
    return {
      ok: true,
      total: rows.length,
      conversations: rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        profileName: row.profile_name || row.username,
        username: row.username,
        linkedContactId: row.contact_id,
        linkedContactName: row.contact_name,
        lastSeenAt: row.last_seen_at,
        messageCount: Number(row.message_count || 0)
      }))
    }
  }
})

export const socialTools = [listSocialProfilesTool, getSocialInboxStatsTool, listSocialConversationsTool]
