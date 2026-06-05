import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { getMetaConfig, getMetaSyncProgress } from './metaAdsService.js'
import { getSitesPublicDomain } from './sitesService.js'
import { logger } from '../utils/logger.js'

const STORAGE_LIMIT_GB = Number(process.env.DATABASE_STORAGE_LIMIT_GB || 1)
const STORAGE_WARNING_PERCENT = Number(process.env.DATABASE_STORAGE_WARNING_PERCENT || 80)
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000

const SEVERITY_RANK = {
  critical: 3,
  warning: 2,
  info: 1
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function toIsoDate(value) {
  if (!value) return new Date().toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function createNotification({
  id,
  source,
  severity = 'info',
  title,
  message = '',
  createdAt,
  updatedAt,
  actionUrl = '',
  actionLabel = 'Revisar'
}) {
  return {
    id,
    source,
    severity: SEVERITY_RANK[severity] ? severity : 'info',
    title,
    message,
    createdAt: toIsoDate(createdAt || updatedAt),
    updatedAt: toIsoDate(updatedAt || createdAt),
    actionUrl,
    actionLabel
  }
}

function sortNotifications(left, right) {
  const severityDiff = (SEVERITY_RANK[right.severity] || 0) - (SEVERITY_RANK[left.severity] || 0)
  if (severityDiff !== 0) return severityDiff
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
}

async function tableExists(tableName) {
  try {
    if (process.env.DATABASE_URL) {
      const row = await db.get(
        `SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ?
        ) AS exists`,
        [tableName]
      )
      return Boolean(row?.exists)
    }

    const row = await db.get(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [tableName]
    )
    return Boolean(row)
  } catch {
    return false
  }
}

async function getWhatsAppNotifications() {
  if (!await tableExists('whatsapp_api_alerts')) return []

  const rows = await db.all(`
    SELECT id, severity, alert_type, title, message, entity_type, entity_id,
      created_at, updated_at
    FROM whatsapp_api_alerts
    WHERE status = 'active'
    ORDER BY
      CASE severity
        WHEN 'critical' THEN 0
        WHEN 'warning' THEN 1
        ELSE 2
      END,
      updated_at DESC
    LIMIT 20
  `)

  const notifications = rows.map((row) => createNotification({
    id: `whatsapp:${row.id}`,
    source: 'WhatsApp Business',
    severity: row.severity,
    title: row.title,
    message: row.message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actionUrl: row.entity_type === 'template' ? '/settings/whatsapp' : '/settings/whatsapp',
    actionLabel: row.entity_type === 'template' ? 'Ver plantillas' : 'Ver WhatsApp'
  }))

  if (await tableExists('whatsapp_api_messages')) {
    const since = new Date(Date.now() - RECENT_ERROR_WINDOW_MS).toISOString()
    const failed = await db.get(`
      SELECT COUNT(*) AS total, MAX(updated_at) AS latest_at,
        MAX(error_message) AS error_message, MAX(error_code) AS error_code
      FROM whatsapp_api_messages
      WHERE (LOWER(COALESCE(status, '')) IN ('failed', 'error')
        OR COALESCE(error_code, '') != ''
        OR COALESCE(error_message, '') != '')
        AND COALESCE(updated_at, created_at) >= ?
    `, [since])

    if (Number(failed?.total || 0) > 0) {
      notifications.push(createNotification({
        id: 'whatsapp:recent-message-errors',
        source: 'WhatsApp Business',
        severity: 'warning',
        title: 'Mensajes de WhatsApp con error',
        message: `${failed.total} mensaje${Number(failed.total) === 1 ? '' : 's'} fallaron en las ultimas 24 horas${failed.error_message ? `: ${failed.error_message}` : failed.error_code ? `: ${failed.error_code}` : ''}.`,
        updatedAt: failed.latest_at,
        actionUrl: '/settings/whatsapp',
        actionLabel: 'Ver WhatsApp'
      }))
    }
  }

  return notifications
}

function getTokenExpiryNotification(row) {
  if (!row?.token_expires_at) return null

  const expiresAt = new Date(row.token_expires_at)
  if (Number.isNaN(expiresAt.getTime())) return null

  const days = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
  if (days > 7) return null

  return createNotification({
    id: 'meta:token-expiry',
    source: 'Meta Ads',
    severity: days <= 0 ? 'critical' : 'warning',
    title: days <= 0 ? 'Token de Meta expirado' : 'Token de Meta por expirar',
    message: days <= 0
      ? 'El token de Meta ya expiro. La sincronizacion de anuncios y eventos puede fallar.'
      : `El token de Meta expira en ${days} dia${days === 1 ? '' : 's'}. Renovalo antes de que se corte la sincronizacion.`,
    updatedAt: row.updated_at || row.token_expires_at,
    actionUrl: '/settings/meta-ads',
    actionLabel: 'Revisar Meta'
  })
}

async function getMetaAccountNotification(metaConfig) {
  if (!metaConfig?.access_token || !metaConfig?.ad_account_id) return null

  const accountId = cleanString(metaConfig.ad_account_id).replace(/^act_/i, '')
  if (!accountId) return null

  try {
    const url = `${API_URLS.META_GRAPH}/act_${encodeURIComponent(accountId)}?fields=name,account_id,account_status,disable_reason&access_token=${encodeURIComponent(metaConfig.access_token)}`
    const response = await fetch(url)
    const data = await response.json().catch(() => null)

    if (!response.ok || data?.error) {
      const message = data?.error?.message || `Meta respondio ${response.status}`
      const isTokenError = Number(data?.error?.code) === 190 || /token|OAuth/i.test(message)
      return createNotification({
        id: 'meta:ad-account-check',
        source: 'Meta Ads',
        severity: isTokenError ? 'critical' : 'warning',
        title: isTokenError ? 'Meta no acepta el token' : 'No se pudo revisar Meta Ads',
        message,
        updatedAt: new Date().toISOString(),
        actionUrl: '/settings/meta-ads',
        actionLabel: 'Revisar Meta'
      })
    }

    const rawStatus = data?.account_status
    const statusText = cleanString(rawStatus).toUpperCase()
    const disableReason = Number(data?.disable_reason || 0)
    const isActive = rawStatus === 1 || statusText === '1' || statusText === 'ACTIVE'

    if (!isActive || disableReason > 0) {
      return createNotification({
        id: 'meta:ad-account-status',
        source: 'Meta Ads',
        severity: 'critical',
        title: 'Cuenta publicitaria de Meta requiere revision',
        message: `${data?.name || `act_${accountId}`} reporta estado ${rawStatus || 'desconocido'}${disableReason > 0 ? ` y razon ${disableReason}` : ''}. Puede estar limitada, bloqueada o pendiente de accion.`,
        updatedAt: new Date().toISOString(),
        actionUrl: '/settings/meta-ads',
        actionLabel: 'Revisar Meta'
      })
    }
  } catch (error) {
    return createNotification({
      id: 'meta:ad-account-network',
      source: 'Meta Ads',
      severity: 'warning',
      title: 'Meta no respondio',
      message: error.message || 'No se pudo revisar la cuenta publicitaria.',
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    })
  }

  return null
}

async function getMetaNotifications({ liveMetaCheck = true } = {}) {
  const notifications = []

  if (!await tableExists('meta_config')) return notifications

  const row = await db.get(`
    SELECT ad_account_id, token_expires_at, updated_at
    FROM meta_config
    LIMIT 1
  `)

  const disconnected = cleanString(await getAppConfig('meta_config_disconnected')) === '1'
  if (disconnected && !row?.ad_account_id) return notifications

  const tokenExpiry = getTokenExpiryNotification(row)
  if (tokenExpiry) notifications.push(tokenExpiry)

  const syncProgress = getMetaSyncProgress()
  if (syncProgress?.status === 'error') {
    notifications.push(createNotification({
      id: 'meta:sync-error',
      source: 'Meta Ads',
      severity: /token|invalid|expir/i.test(syncProgress.message || '') ? 'critical' : 'warning',
      title: syncProgress.step || 'Error sincronizando Meta',
      message: syncProgress.message || 'La ultima sincronizacion de Meta Ads fallo.',
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
  }

  if (await tableExists('meta_conversion_event_logs')) {
    const since = new Date(Date.now() - RECENT_ERROR_WINDOW_MS).toISOString()
    const conversionError = await db.get(`
      SELECT COUNT(*) AS total, MAX(created_at) AS latest_at, MAX(error_message) AS error_message
      FROM meta_conversion_event_logs
      WHERE LOWER(COALESCE(status, '')) = 'error'
        AND created_at >= ?
    `, [since])

    if (Number(conversionError?.total || 0) > 0) {
      notifications.push(createNotification({
        id: 'meta:capi-errors',
        source: 'Meta Ads',
        severity: 'warning',
        title: 'Eventos de Meta con error',
        message: `${conversionError.total} evento${Number(conversionError.total) === 1 ? '' : 's'} de conversion fallaron en las ultimas 24 horas${conversionError.error_message ? `: ${conversionError.error_message}` : ''}.`,
        updatedAt: conversionError.latest_at,
        actionUrl: '/settings/meta-ads',
        actionLabel: 'Revisar Meta'
      }))
    }
  }

  if (liveMetaCheck && row?.ad_account_id) {
    const metaConfig = await getMetaConfig().catch((error) => {
      logger.warn(`No se pudo leer Meta para notificaciones: ${error.message}`)
      return null
    })
    const accountNotification = await getMetaAccountNotification(metaConfig)
    if (accountNotification) notifications.push(accountNotification)
  }

  return notifications
}

async function getStorageStatus() {
  const limitGB = STORAGE_LIMIT_GB > 0 ? STORAGE_LIMIT_GB : 1

  if (process.env.DATABASE_URL) {
    const row = await db.get(`
      SELECT
        pg_database_size(current_database()) AS size_bytes,
        pg_size_pretty(pg_database_size(current_database())) AS size_pretty
    `)
    const sizeBytes = Number(row?.size_bytes || 0)
    const sizeGB = sizeBytes / (1024 * 1024 * 1024)
    const percentUsed = (sizeGB / limitGB) * 100
    return {
      sizeGB,
      sizePretty: row?.size_pretty || `${sizeGB.toFixed(2)} GB`,
      limitGB,
      percentUsed
    }
  }

  const pageCountRow = await db.get('PRAGMA page_count')
  const pageSizeRow = await db.get('PRAGMA page_size')
  const pageCount = Number(pageCountRow?.page_count || Object.values(pageCountRow || {})[0] || 0)
  const pageSize = Number(pageSizeRow?.page_size || Object.values(pageSizeRow || {})[0] || 0)
  const sizeBytes = pageCount * pageSize
  const sizeGB = sizeBytes / (1024 * 1024 * 1024)
  const percentUsed = (sizeGB / limitGB) * 100

  return {
    sizeGB,
    sizePretty: `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
    limitGB,
    percentUsed
  }
}

async function getStorageNotifications() {
  try {
    const storage = await getStorageStatus()
    if (storage.percentUsed < STORAGE_WARNING_PERCENT) return []

    return [createNotification({
      id: 'system:storage',
      source: 'Sistema',
      severity: storage.percentUsed >= 95 ? 'critical' : 'warning',
      title: 'Storage de base de datos alto',
      message: `La base esta usando ${storage.percentUsed.toFixed(1)}% (${storage.sizePretty}) de ${storage.limitGB} GB disponibles.`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/account',
      actionLabel: 'Ver cuenta'
    })]
  } catch (error) {
    logger.warn(`No se pudo calcular storage para notificaciones: ${error.message}`)
    return []
  }
}

async function getDomainNotifications() {
  const notifications = []

  try {
    const config = await getSitesPublicDomain()
    if (config?.domain && !config.renderDomainVerified && config.renderDomainError) {
      notifications.push(createNotification({
        id: `domain:global:${config.domain}`,
        source: 'Dominios',
        severity: 'warning',
        title: 'Dominio publico sin conectar',
        message: `${config.domain}: ${config.renderDomainError}`,
        updatedAt: config.renderDomainCheckedAt,
        actionUrl: '/settings/domains',
        actionLabel: 'Ver dominios'
      }))
    }
  } catch (error) {
    logger.warn(`No se pudo leer dominio global para notificaciones: ${error.message}`)
  }

  if (await tableExists('public_sites')) {
    const rows = await db.all(`
      SELECT id, name, domain, render_domain_error, render_domain_checked_at, updated_at
      FROM public_sites
      WHERE COALESCE(domain, '') != ''
        AND COALESCE(render_domain_verified, 0) = 0
        AND COALESCE(render_domain_error, '') != ''
      ORDER BY COALESCE(render_domain_checked_at, updated_at) DESC
      LIMIT 5
    `)

    rows.forEach((row) => {
      notifications.push(createNotification({
        id: `domain:site:${row.id}`,
        source: 'Dominios',
        severity: 'warning',
        title: 'Dominio de site con error',
        message: `${row.name || row.domain}: ${row.render_domain_error}`,
        updatedAt: row.render_domain_checked_at || row.updated_at,
        actionUrl: '/settings/domains',
        actionLabel: 'Ver site'
      }))
    })
  }

  return notifications
}

async function getAiNotifications() {
  if (!await tableExists('ai_agent_config')) return []

  const row = await db.get('SELECT id, openai_api_key_encrypted, updated_at FROM ai_agent_config LIMIT 1')
  if (row && !row.openai_api_key_encrypted) {
    return [createNotification({
      id: 'ai:openai-key-missing',
      source: 'Agente AI',
      severity: 'info',
      title: 'Agente AI sin llave activa',
      message: 'No hay llave de OpenAI guardada para el agente. Si lo usas, revisa la configuracion.',
      updatedAt: row.updated_at,
      actionUrl: '/settings/ai-agent',
      actionLabel: 'Ver agente'
    })]
  }

  return []
}

export async function getSystemNotifications({ liveMetaCheck = true, limit = 30 } = {}) {
  const groups = await Promise.all([
    getWhatsAppNotifications(),
    getMetaNotifications({ liveMetaCheck }),
    getStorageNotifications(),
    getDomainNotifications(),
    getAiNotifications()
  ])

  const items = groups
    .flat()
    .sort(sortNotifications)
    .slice(0, Math.max(1, Math.min(Number(limit) || 30, 100)))

  const summary = items.reduce((acc, item) => {
    acc.total += 1
    acc[item.severity] = (acc[item.severity] || 0) + 1
    if (!acc.highestSeverity || (SEVERITY_RANK[item.severity] || 0) > (SEVERITY_RANK[acc.highestSeverity] || 0)) {
      acc.highestSeverity = item.severity
    }
    return acc
  }, {
    total: 0,
    critical: 0,
    warning: 0,
    info: 0,
    highestSeverity: ''
  })

  return {
    summary,
    items,
    generatedAt: new Date().toISOString()
  }
}
