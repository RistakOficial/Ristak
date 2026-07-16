import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { getMetaConfig, getMetaSyncProgress } from './metaAdsService.js'
import { getSitesPublicDomain } from './sitesService.js'
import { listAutomationReviewProblems } from './automationReferenceResolver.js'
import { canRunBackgroundJob } from './licenseService.js'
import { sendAppNotificationPayload } from './pushNotificationsService.js'
import { logger } from '../utils/logger.js'
import { createRistakId } from '../utils/idGenerator.js'
import { safeMetaGraphTransportError } from '../utils/metaGraphSecurity.js'

const STORAGE_LIMIT_GB = Number(process.env.DATABASE_STORAGE_LIMIT_GB || 1)
const STORAGE_WARNING_PERCENT = Number(process.env.DATABASE_STORAGE_WARNING_PERCENT || 80)
const RECENT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000
const META_ENTITY_LIMIT = Math.max(10, Math.min(Number(process.env.META_NOTIFICATIONS_ENTITY_LIMIT || 50), 100))
const META_ACTIVITY_LIMIT = Math.max(5, Math.min(Number(process.env.META_NOTIFICATIONS_ACTIVITY_LIMIT || 10), 50))
const META_SPEND_CAP_WARNING_PERCENT = Number(process.env.META_SPEND_CAP_WARNING_PERCENT || 90)
const META_PREPAID_BALANCE_WARNING_MINOR_UNITS = Number(process.env.META_PREPAID_BALANCE_WARNING_MINOR_UNITS || 1000)

const SEVERITY_RANK = {
  critical: 3,
  warning: 2,
  info: 1
}

const META_AD_ACCOUNT_STATUS_LABELS = {
  1: 'Activa',
  2: 'Desactivada',
  3: 'Pendiente de pago',
  7: 'En revisión de riesgo',
  8: 'Pago pendiente',
  9: 'En periodo de gracia',
  100: 'Cierre pendiente',
  101: 'Cerrada',
  201: 'Activa',
  202: 'Cerrada'
}

const META_AD_ACCOUNT_CRITICAL_STATUSES = new Set(['2', '101', '202'])
const META_ENTITY_CRITICAL_STATUSES = new Set(['WITH_ISSUES', 'DISAPPROVED', 'PENDING_BILLING_INFO'])
const META_ENTITY_WARNING_STATUSES = new Set([])
const META_PROBLEM_ACTIVITY_PATTERN = /(disable|disabled|reject|rejected|disapprov|policy|billing|payment|risk|failed|error|blocked|restricted|limit|unsettled|closure|appeal)/i
const META_BUSINESS_CRITICAL_STATUSES = new Set(['REJECTED', 'FAILED', 'DISABLED', 'BLOCKED', 'RESTRICTED'])
const META_BUSINESS_WARNING_STATUSES = new Set(['PENDING', 'PENDING_REVIEW', 'IN_REVIEW', 'NOT_VERIFIED'])
const META_STATUS_LABELS = {
  ACTIVE: 'activo',
  WITH_ISSUES: 'con problemas',
  DISAPPROVED: 'rechazado',
  PENDING_BILLING_INFO: 'falta revisar pago',
  PENDING_REVIEW: 'en revisión',
  PAUSED: 'pausado',
  CAMPAIGN_PAUSED: 'campana pausada',
  ADSET_PAUSED: 'conjunto pausado',
  ARCHIVED: 'archivado',
  DELETED: 'eliminado',
  REJECTED: 'rechazado',
  FAILED: 'fallido',
  DISABLED: 'deshabilitado',
  BLOCKED: 'bloqueado',
  RESTRICTED: 'restringido',
  VERIFIED: 'verificado',
  NOT_VERIFIED: 'sin verificar',
  IN_REVIEW: 'en revisión',
  PENDING: 'pendiente'
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function makeInternalNotificationId() {
  return createRistakId('internal_notification')
}

function normalizeUserIds(value = []) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map((item) => cleanString(item)).filter(Boolean))]
}

function sanitizeExternalMessage(value) {
  return cleanString(value)
    .replace(/access_token=[^&\s]+/gi, 'access_token=***')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***')
    .slice(0, 500)
}

function limitText(value, maxLength = 420) {
  const text = cleanString(value)
  if (text.length <= maxLength) return text
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}...`
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

function internalNotificationFromRow(row = {}) {
  return createNotification({
    id: row.id,
    source: row.source || 'Ristak',
    severity: row.severity || 'info',
    title: row.title || 'Notificación interna',
    message: row.message || '',
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt || row.created_at || row.createdAt,
    actionUrl: row.action_url || row.actionUrl || '',
    actionLabel: row.action_label || row.actionLabel || 'Abrir'
  })
}

export async function createInternalNotification({
  recipientUserIds = [],
  broadcast = false,
  source = 'Automatizaciones',
  severity = 'info',
  title,
  message = '',
  actionUrl = '',
  actionLabel = 'Abrir',
  category = 'automation',
  contactId = '',
  automationId = '',
  automationNodeId = '',
  enrollmentId = '',
  metadata = {},
  pushTitle = '',
  pushBody = '',
  createBellNotification = true,
  sendPushNotification = true
} = {}) {
  const cleanTitle = limitText(title || pushTitle || 'Notificación interna', 120)
  const cleanMessage = limitText(message || pushBody || '', 700)
  const normalizedRecipients = normalizeUserIds(recipientUserIds)
  const recipientTargets = broadcast ? [null] : normalizedRecipients

  if (!broadcast && recipientTargets.length === 0) {
    return {
      created: 0,
      ids: [],
      push: { sent: 0, skipped: true, reason: 'missing_recipients' }
    }
  }

  const ids = []
  if (createBellNotification) {
    for (const recipientUserId of recipientTargets) {
      const id = makeInternalNotificationId()
      ids.push(id)
      await db.run(
        `INSERT INTO internal_notifications (
          id, recipient_user_id, source, severity, title, message, action_url, action_label,
          category, contact_id, automation_id, automation_node_id, enrollment_id, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          id,
          recipientUserId,
          cleanString(source) || 'Ristak',
          SEVERITY_RANK[severity] ? severity : 'info',
          cleanTitle,
          cleanMessage,
          cleanString(actionUrl),
          cleanString(actionLabel) || 'Abrir',
          cleanString(category) || 'internal',
          cleanString(contactId) || null,
          cleanString(automationId) || null,
          cleanString(automationNodeId) || null,
          cleanString(enrollmentId) || null,
          JSON.stringify(metadata || {})
        ]
      )
    }
  }

  let push = { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'disabled' }
  if (sendPushNotification) {
    const pushPayload = {
      title: pushTitle || cleanTitle,
      body: pushBody || cleanMessage || cleanTitle,
      url: actionUrl || '/movil',
      category,
      tag: ids[0] || `internal-${Date.now()}`,
      contactId: cleanString(contactId)
    }
    const pushOptions = broadcast ? {} : { userIds: normalizedRecipients }
    push = await sendAppNotificationPayload(pushPayload, pushOptions).catch((error) => {
      logger.warn(`[Notificaciones] No se pudo enviar push interno: ${error.message}`)
      return { sent: 0, webSent: 0, nativeSent: 0, skipped: true, reason: 'push_error' }
    })
  }

  return { created: ids.length, ids, push }
}

function sortNotifications(left, right) {
  const severityDiff = (SEVERITY_RANK[right.severity] || 0) - (SEVERITY_RANK[left.severity] || 0)
  if (severityDiff !== 0) return severityDiff
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
}

function buildMetaGraphUrl(path, params = {}, accessToken = '', appSecretProof = '') {
  const cleanPath = cleanString(path).replace(/^\//, '')
  const url = cleanPath.startsWith('http')
    ? new URL(cleanPath)
    : new URL(`${API_URLS.META_GRAPH}/${cleanPath}`)

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return
    url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value))
  })

  if (accessToken) {
    url.searchParams.set('access_token', accessToken)
  }
  if (appSecretProof) {
    url.searchParams.set('appsecret_proof', appSecretProof)
  }

  return url
}

async function metaGraphGet(path, params = {}, accessToken = '', appSecretProof = '') {
  const url = buildMetaGraphUrl(path, params, accessToken, appSecretProof)
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(safeMetaGraphTransportError(error))
  }
  const data = await response.json().catch(() => null)

  if (!response.ok || data?.error) {
    const metaError = new Error(sanitizeExternalMessage(data?.error?.message || `Meta respondió ${response.status}`))
    metaError.code = data?.error?.code
    metaError.subcode = data?.error?.error_subcode
    metaError.type = data?.error?.type
    metaError.status = response.status
    throw metaError
  }

  return data
}

async function metaGraphGetWithFieldFallback(path, fieldSets = [], params = {}, accessToken = '', appSecretProof = '') {
  let lastError = null

  for (const fields of fieldSets) {
    try {
      return await metaGraphGet(path, { ...params, fields }, accessToken, appSecretProof)
    } catch (error) {
      lastError = error
      logger.warn(`Meta notification field fallback ${path}: ${error.message}`)
    }
  }

  throw lastError || new Error('Meta no respondió')
}

function isMetaTokenError(error) {
  const message = cleanString(error?.message)
  return Number(error?.code) === 190 || /token|OAuth|permission|permissions|scope|access/i.test(message)
}

function formatMetaStatus(status) {
  const normalized = cleanString(status).replace(/[\s-]+/g, '_').toUpperCase()
  return META_STATUS_LABELS[normalized] || cleanString(status).replace(/_/g, ' ').toLowerCase()
}

function formatMetaAccountStatus(status) {
  const key = cleanString(status)
  return META_AD_ACCOUNT_STATUS_LABELS[key] || META_AD_ACCOUNT_STATUS_LABELS[Number(key)] || (key ? `Estado ${key}` : 'Estado desconocido')
}

function getObjectId(value) {
  if (!value) return ''
  if (typeof value === 'string' || typeof value === 'number') return cleanString(value)
  return cleanString(value.id || value.account_id || value.name)
}

function getArrayValue(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (Array.isArray(value.data)) return value.data
  if (typeof value === 'object' && Object.keys(value).length > 0) return [value]
  return []
}

function summarizeMetaObject(value, fallback = '') {
  if (!value) return fallback
  if (typeof value === 'string') return sanitizeExternalMessage(value)
  if (Array.isArray(value)) {
    return value.map((item) => summarizeMetaObject(item)).filter(Boolean).join(', ')
  }
  if (typeof value === 'object') {
    const direct = value.message || value.error_message || value.error_user_msg || value.title || value.description || value.summary || value.reason || value.code
    if (direct) return sanitizeExternalMessage(direct)

    const parts = Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined && typeof item !== 'object')
      .map(([key, item]) => `${key}: ${item}`)
      .slice(0, 3)
    return sanitizeExternalMessage(parts.join(', '))
  }

  return sanitizeExternalMessage(value)
}

function summarizeMetaIssues(entity) {
  const sources = [
    ...getArrayValue(entity?.issues_info),
    ...getArrayValue(entity?.failed_delivery_checks),
    ...getArrayValue(entity?.recommendations),
    ...getArrayValue(entity?.ad_review_feedback),
    ...getArrayValue(entity?.review_feedback)
  ]

  const details = sources
    .map((item) => summarizeMetaObject(item))
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)

  return details.slice(0, 2).join(' ')
}

function normalizeMetaEntityStatus(entity) {
  return cleanString(entity?.effective_status || entity?.configured_status || entity?.status).toUpperCase()
}

function shouldNotifyMetaEntity(entity) {
  const status = normalizeMetaEntityStatus(entity)
  const hasIssueDetails = Boolean(summarizeMetaIssues(entity))
  return META_ENTITY_CRITICAL_STATUSES.has(status) || META_ENTITY_WARNING_STATUSES.has(status) || hasIssueDetails
}

function getMetaEntitySeverity(entity) {
  const status = normalizeMetaEntityStatus(entity)
  if (META_ENTITY_CRITICAL_STATUSES.has(status)) return 'critical'
  return 'warning'
}

function createMetaApiNotification(error, id = 'meta:api-error', title = 'No se pudo revisar Meta') {
  return createNotification({
    id,
    source: 'Meta Ads',
    severity: isMetaTokenError(error) ? 'critical' : 'warning',
    title: isMetaTokenError(error) ? 'Meta necesita reconexion' : title,
      message: sanitizeExternalMessage(error?.message || 'Meta no respondió.'),
    updatedAt: new Date().toISOString(),
    actionUrl: '/settings/meta-ads',
    actionLabel: 'Revisar Meta'
  })
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
      ? 'El token de Meta ya expiro. La sincronización de anuncios y eventos puede fallar.'
      : `El token de Meta expira en ${days} día${days === 1 ? '' : 's'}. Renuévalo antes de que se corte la sincronización.`,
    updatedAt: row.updated_at || row.token_expires_at,
    actionUrl: '/settings/meta-ads',
    actionLabel: 'Revisar Meta'
  })
}

function formatMinorCurrency(value, currency = '') {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return ''

  const normalized = amount / 100
  const currencyCode = cleanString(currency).toUpperCase()

  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency: currencyCode || 'USD'
    }).format(normalized)
  } catch {
    return `${normalized.toFixed(2)}${currencyCode ? ` ${currencyCode}` : ''}`
  }
}

function extractMetaBusinessId(account) {
  return getObjectId(account?.business)
}

function extractMetaBusinessName(account) {
  const business = account?.business
  if (!business || typeof business !== 'object') return ''
  return cleanString(business.name)
}

async function fetchMetaAccountOverview(metaConfig) {
  if (!metaConfig?.access_token || !metaConfig?.ad_account_id) return null

  const accountId = cleanString(metaConfig.ad_account_id).replace(/^act_/i, '')
  if (!accountId) return null

  return await metaGraphGetWithFieldFallback(`act_${encodeURIComponent(accountId)}`, [
    'id,name,account_id,account_status,disable_reason,currency,balance,amount_spent,spend_cap,is_prepay_account,failed_delivery_checks,funding_source,funding_source_details,user_access_expire_time,is_notifications_enabled,business',
    'id,name,account_id,account_status,disable_reason,currency,balance,amount_spent,spend_cap,is_prepay_account,failed_delivery_checks,business',
    'id,name,account_id,account_status,disable_reason,currency,business'
  ], {}, metaConfig.access_token, metaConfig.oauth_appsecret_proof || '')
}

function createMetaAccountHealthNotifications(account, accountId) {
  if (!account) return []

  const notifications = []
  const accountName = account.name || `act_${accountId}`
  const rawStatus = account.account_status
  const statusKey = cleanString(rawStatus)
  const statusText = cleanString(rawStatus).toUpperCase()
  const disableReason = Number(account.disable_reason || 0)
  const isActive = rawStatus === 1 || statusKey === '1' || statusKey === '201' || statusText === 'ACTIVE'

  if (!isActive || disableReason > 0) {
    const severity = META_AD_ACCOUNT_CRITICAL_STATUSES.has(statusKey) || disableReason > 0 ? 'critical' : 'warning'
    notifications.push(createNotification({
      id: `meta:ad-account-status:${account.account_id || accountId}`,
      source: 'Meta Ads',
      severity,
      title: severity === 'critical' ? 'Cuenta publicitaria detenida' : 'Cuenta publicitaria requiere revisión',
      message: `${accountName} está en estado "${formatMetaAccountStatus(rawStatus)}"${disableReason > 0 ? ` y Meta reporta razón ${disableReason}` : ''}. Revisa la cuenta antes de seguir invirtiendo.`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
  }

  const failedDeliveryChecks = getArrayValue(account.failed_delivery_checks)
  if (failedDeliveryChecks.length > 0) {
    notifications.push(createNotification({
      id: `meta:ad-account-delivery:${account.account_id || accountId}`,
      source: 'Meta Ads',
      severity: 'warning',
      title: 'Meta detecto problemas de entrega',
      message: `${accountName}: ${failedDeliveryChecks.map((check) => summarizeMetaObject(check)).filter(Boolean).slice(0, 2).join(' ') || 'hay revisiones de entrega pendientes.'}`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/campaigns',
      actionLabel: 'Ver publicidad'
    }))
  }

  const spendCap = Number(account.spend_cap || 0)
  const amountSpent = Number(account.amount_spent || 0)
  if (spendCap > 0 && amountSpent >= spendCap * (META_SPEND_CAP_WARNING_PERCENT / 100)) {
    const percent = (amountSpent / spendCap) * 100
    notifications.push(createNotification({
      id: `meta:ad-account-spend-cap:${account.account_id || accountId}`,
      source: 'Meta Ads',
      severity: percent >= 100 ? 'critical' : 'warning',
      title: percent >= 100 ? 'Límite de gasto de Meta alcanzado' : 'Límite de gasto de Meta casi lleno',
      message: `${accountName} lleva ${formatMinorCurrency(amountSpent, account.currency)} de ${formatMinorCurrency(spendCap, account.currency)} (${percent.toFixed(0)}%).`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
  }

  const isPrepay = account.is_prepay_account === true || cleanString(account.is_prepay_account).toLowerCase() === 'true'
  const balance = Number(account.balance)
  if (isPrepay && Number.isFinite(balance) && balance <= META_PREPAID_BALANCE_WARNING_MINOR_UNITS) {
    notifications.push(createNotification({
      id: `meta:ad-account-balance:${account.account_id || accountId}`,
      source: 'Meta Ads',
      severity: balance <= 0 ? 'critical' : 'warning',
      title: balance <= 0 ? 'Meta Ads sin saldo' : 'Saldo de Meta Ads bajo',
      message: `${accountName} tiene ${formatMinorCurrency(balance, account.currency)} disponibles en una cuenta prepago.`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
  }

  if (Object.prototype.hasOwnProperty.call(account, 'funding_source') && !account.funding_source && !isPrepay) {
    notifications.push(createNotification({
      id: `meta:ad-account-funding:${account.account_id || accountId}`,
      source: 'Meta Ads',
      severity: 'warning',
      title: 'Meta no muestra método de pago activo',
      message: `${accountName} no devolvio un método de pago activo. Si tus anuncios no gastan, revisa facturacion en Meta.`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
  }

  if (account.user_access_expire_time) {
    const expiresAt = new Date(Number(account.user_access_expire_time) * 1000)
    const days = Math.ceil((expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    if (!Number.isNaN(expiresAt.getTime()) && days <= 7) {
      notifications.push(createNotification({
        id: `meta:user-access-expiry:${account.account_id || accountId}`,
        source: 'Meta Ads',
        severity: days <= 0 ? 'critical' : 'warning',
        title: days <= 0 ? 'Acceso de Meta expirado' : 'Acceso de Meta por expirar',
        message: days <= 0 ? 'Meta reporta que el acceso de usuario ya expiró.' : `Meta reporta que el acceso expira en ${days} día${days === 1 ? '' : 's'}.`,
        updatedAt: new Date().toISOString(),
        actionUrl: '/settings/meta-ads',
        actionLabel: 'Revisar Meta'
      }))
    }
  }

  if (account.is_notifications_enabled === false) {
    notifications.push(createNotification({
      id: `meta:ad-account-native-notifications:${account.account_id || accountId}`,
      source: 'Meta Ads',
      severity: 'info',
      title: 'Avisos de Meta apagados',
      message: `${accountName} reporta avisos nativos apagados. Ristak seguira revisando lo que la API permita.`,
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
  }

  return notifications
}

async function getMetaAccountNotifications(metaConfig) {
  if (!metaConfig?.access_token || !metaConfig?.ad_account_id) return { account: null, notifications: [] }

  const accountId = cleanString(metaConfig.ad_account_id).replace(/^act_/i, '')
  if (!accountId) return { account: null, notifications: [] }

  try {
    const account = await fetchMetaAccountOverview(metaConfig)
    return {
      account,
      notifications: createMetaAccountHealthNotifications(account, accountId)
    }
  } catch (error) {
    return {
      account: null,
      notifications: [createMetaApiNotification(error, 'meta:ad-account-check', 'No se pudo revisar Meta Ads')]
    }
  }
}

async function fetchMetaBusinessEdge(businessId, edge, fields, accessToken, appSecretProof = '', limit = 25) {
  const data = await metaGraphGet(`${encodeURIComponent(businessId)}/${edge}`, { fields, limit }, accessToken, appSecretProof)
  return data?.data || []
}

function getBusinessStatusSeverity(status) {
  const normalized = cleanString(status).replace(/[\s-]+/g, '_').toUpperCase()
  if (META_BUSINESS_CRITICAL_STATUSES.has(normalized)) return 'critical'
  if (META_BUSINESS_WARNING_STATUSES.has(normalized)) return 'warning'
  return ''
}

async function getMetaBusinessPortfolioNotifications(account, metaConfig) {
  const businessId = extractMetaBusinessId(account)
  if (!businessId || !metaConfig?.access_token) return []

  const notifications = []
  const selectedAccountId = cleanString(metaConfig.ad_account_id).replace(/^act_/i, '')

  try {
    const business = await metaGraphGet(`${encodeURIComponent(businessId)}`, {
      fields: 'id,name,verification_status'
    }, metaConfig.access_token, metaConfig.oauth_appsecret_proof || '')

    const businessName = business.name || extractMetaBusinessName(account) || 'Portafolio comercial'
    const verificationSeverity = getBusinessStatusSeverity(business.verification_status)
    if (verificationSeverity) {
      notifications.push(createNotification({
        id: `meta:business-verification:${businessId}`,
        source: 'Meta Business',
        severity: verificationSeverity,
        title: verificationSeverity === 'critical' ? 'Portafolio comercial detenido' : 'Portafolio comercial requiere revisión',
        message: `${businessName} reporta verificación "${formatMetaStatus(business.verification_status)}". Esto puede afectar anuncios, WhatsApp o permisos del negocio.`,
        updatedAt: new Date().toISOString(),
        actionUrl: '/settings/meta-ads',
        actionLabel: 'Revisar Meta'
      }))
    }
  } catch (error) {
    notifications.push(createMetaApiNotification(error, `meta:business-check:${businessId}`, 'No se pudo revisar el portafolio comercial'))
    return notifications
  }

  const edgeErrors = []

  for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
    try {
      const accounts = await fetchMetaBusinessEdge(
        businessId,
        edge,
        'id,name,account_id,account_status,disable_reason',
        metaConfig.access_token,
        metaConfig.oauth_appsecret_proof || '',
        50
      )

      accounts.forEach((row) => {
        const adAccountId = cleanString(row.account_id || row.id).replace(/^act_/i, '')
        if (!adAccountId || adAccountId === selectedAccountId) return

        const statusKey = cleanString(row.account_status)
        const disableReason = Number(row.disable_reason || 0)
        const active = statusKey === '1' || statusKey === '201' || cleanString(row.account_status).toUpperCase() === 'ACTIVE'
        if (active && disableReason <= 0) return

        const severity = META_AD_ACCOUNT_CRITICAL_STATUSES.has(statusKey) || disableReason > 0 ? 'critical' : 'warning'
        notifications.push(createNotification({
          id: `meta:business-ad-account:${adAccountId}`,
          source: 'Meta Business',
          severity,
          title: 'Cuenta publicitaria del portafolio requiere revisión',
          message: `${row.name || `act_${adAccountId}`} está en "${formatMetaAccountStatus(row.account_status)}"${disableReason > 0 ? ` con razón ${disableReason}` : ''}.`,
          updatedAt: new Date().toISOString(),
          actionUrl: '/settings/meta-ads',
          actionLabel: 'Revisar Meta'
        }))
      })
    } catch (error) {
      edgeErrors.push(error)
    }
  }

  try {
    const wabas = await fetchMetaBusinessEdge(
      businessId,
      'owned_whatsapp_business_accounts',
      'id,name,account_review_status,business_verification_status',
      metaConfig.access_token,
      metaConfig.oauth_appsecret_proof || '',
      25
    )

    wabas.forEach((waba) => {
      const reviewStatus = cleanString(waba.account_review_status).replace(/[\s-]+/g, '_').toUpperCase()
      const verificationStatus = cleanString(waba.business_verification_status).replace(/[\s-]+/g, '_').toUpperCase()
      const reviewSeverity = reviewStatus && reviewStatus !== 'APPROVED' ? getBusinessStatusSeverity(reviewStatus) || 'warning' : ''
      const verificationSeverity = verificationStatus && verificationStatus !== 'VERIFIED' ? getBusinessStatusSeverity(verificationStatus) || 'warning' : ''
      const severity = reviewSeverity === 'critical' || verificationSeverity === 'critical' ? 'critical' : (reviewSeverity || verificationSeverity ? 'warning' : '')

      if (!severity) return

      notifications.push(createNotification({
        id: `meta:waba:${waba.id}`,
        source: 'WhatsApp Business',
        severity,
        title: severity === 'critical' ? 'Cuenta de WhatsApp en Meta detenida' : 'Cuenta de WhatsApp en Meta requiere revisión',
        message: `${waba.name || waba.id} reporta revisión "${reviewStatus || 'sin dato'}" y verificación "${verificationStatus || 'sin dato'}".`,
        updatedAt: new Date().toISOString(),
        actionUrl: '/settings/whatsapp',
        actionLabel: 'Ver WhatsApp'
      }))
    })
  } catch (error) {
    edgeErrors.push(error)
  }

  if (edgeErrors.length > 0) {
    notifications.push(createMetaApiNotification(edgeErrors[0], `meta:business-assets:${businessId}`, 'Meta no dejo revisar todos los activos'))
  }

  return notifications
}

async function fetchMetaEntities(path, fields, params, accessToken, appSecretProof = '') {
  const data = await metaGraphGet(path, {
    ...params,
    fields,
    limit: META_ENTITY_LIMIT
  }, accessToken, appSecretProof)
  return data?.data || []
}

function createMetaEntitySummaryNotification(typeConfig, rows) {
  if (!rows.length) return null

  const severity = rows.some((row) => getMetaEntitySeverity(row) === 'critical') ? 'critical' : 'warning'
  const preview = rows
    .slice(0, 3)
    .map((row) => {
      const status = normalizeMetaEntityStatus(row)
      const issue = limitText(summarizeMetaIssues(row), 180)
      return `${row.name || row.id} (${formatMetaStatus(status)}${issue ? `: ${issue}` : ''})`
    })
    .join('; ')

  return createNotification({
    id: `meta:${typeConfig.id}:issues`,
    source: 'Meta Ads',
    severity,
    title: `${rows.length} ${rows.length === 1 ? typeConfig.singleLabel : typeConfig.pluralLabel} ${rows.length === 1 ? 'requiere' : 'requieren'} revisión`,
    message: limitText(preview, 620),
    updatedAt: rows[0]?.updated_time || new Date().toISOString(),
    actionUrl: '/campaigns',
    actionLabel: 'Ver publicidad'
  })
}

function getMetaActivityUpdatedAt(eventTime) {
  if (!eventTime) return new Date().toISOString()

  const numeric = Number(eventTime)
  if (Number.isFinite(numeric)) {
    const millis = numeric > 9999999999 ? numeric : numeric * 1000
    return new Date(millis).toISOString()
  }

  return toIsoDate(eventTime)
}

async function getMetaDeliveryNotifications(metaConfig) {
  if (!metaConfig?.access_token || !metaConfig?.ad_account_id) return []

  const accountId = cleanString(metaConfig.ad_account_id).replace(/^act_/i, '')
  if (!accountId) return []

  const entityConfigs = [
    {
      id: 'campaigns',
      path: `act_${encodeURIComponent(accountId)}/campaigns`,
      singleLabel: 'campana',
      pluralLabel: 'campanas',
      fields: 'id,name,status,configured_status,effective_status,issues_info,recommendations,updated_time',
      statuses: ['WITH_ISSUES']
    },
    {
      id: 'adsets',
      path: `act_${encodeURIComponent(accountId)}/adsets`,
      singleLabel: 'conjunto de anuncios',
      pluralLabel: 'conjuntos de anuncios',
      fields: 'id,name,campaign_id,status,configured_status,effective_status,issues_info,recommendations,review_feedback,updated_time',
      statuses: ['WITH_ISSUES']
    },
    {
      id: 'ads',
      path: `act_${encodeURIComponent(accountId)}/ads`,
      singleLabel: 'anuncio',
      pluralLabel: 'anuncios',
      fields: 'id,name,campaign_id,adset_id,status,configured_status,effective_status,issues_info,recommendations,failed_delivery_checks,ad_review_feedback,updated_time',
      statuses: ['WITH_ISSUES', 'DISAPPROVED', 'PENDING_BILLING_INFO']
    }
  ]

  const notifications = []

  for (const config of entityConfigs) {
    try {
      const filtering = JSON.stringify([{ field: 'effective_status', operator: 'IN', value: config.statuses }])
      let rows = await fetchMetaEntities(config.path, config.fields, { filtering }, metaConfig.access_token, metaConfig.oauth_appsecret_proof || '')
      rows = rows.filter(shouldNotifyMetaEntity)

      if (!rows.length) {
        const unfiltered = await fetchMetaEntities(config.path, config.fields, {}, metaConfig.access_token, metaConfig.oauth_appsecret_proof || '')
        rows = unfiltered.filter(shouldNotifyMetaEntity)
      }

      const notification = createMetaEntitySummaryNotification(config, rows)
      if (notification) notifications.push(notification)
    } catch (error) {
      logger.warn(`No se pudo revisar ${config.id} de Meta para notificaciones: ${error.message}`)
      if (isMetaTokenError(error)) {
        notifications.push(createMetaApiNotification(error, `meta:${config.id}:api-error`, `No se pudieron revisar ${config.pluralLabel}`))
        break
      }
    }
  }

  return notifications
}

async function getMetaActivityNotifications(metaConfig) {
  if (!metaConfig?.access_token || !metaConfig?.ad_account_id) return []

  const accountId = cleanString(metaConfig.ad_account_id).replace(/^act_/i, '')
  if (!accountId) return []

  try {
    const since = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000)
    const data = await metaGraphGetWithFieldFallback(`act_${encodeURIComponent(accountId)}/activities`, [
      'event_time,event_type,object_name,object_id,translated_event_type,extra_data',
      'event_time,event_type,object_name,object_id,extra_data',
      'event_time,event_type,object_name,object_id'
    ], {
      since,
      limit: META_ACTIVITY_LIMIT
    }, metaConfig.access_token, metaConfig.oauth_appsecret_proof || '')

    const problemActivities = (data?.data || [])
      .filter((activity) => META_PROBLEM_ACTIVITY_PATTERN.test(JSON.stringify(activity)))
      .slice(0, 5)

    if (!problemActivities.length) return []

    const preview = problemActivities.map((activity) => {
      const label = activity.translated_event_type || activity.event_type || 'Cambio en Meta'
      return `${label}${activity.object_name ? `: ${activity.object_name}` : ''}`
    }).join('; ')

    return [createNotification({
      id: `meta:recent-activities:${accountId}`,
      source: 'Meta Ads',
      severity: 'warning',
      title: 'Meta tuvo cambios recientes importantes',
      message: limitText(preview, 620),
      updatedAt: getMetaActivityUpdatedAt(problemActivities[0]?.event_time),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    })]
  } catch (error) {
    logger.warn(`No se pudo leer actividad de Meta para notificaciones: ${error.message}`)
    return isMetaTokenError(error)
      ? [createMetaApiNotification(error, `meta:activities:api-error`, 'No se pudo revisar actividad de Meta')]
      : []
  }
}

async function getMetaNotifications({ liveMetaCheck = true } = {}) {
  const notifications = []

  if (!await tableExists('meta_config')) return notifications

  const row = await getMetaConfig().catch(() => null)

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
      message: syncProgress.message || 'La ultima sincronización de Meta Ads fallo.',
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
    notifications.push(...await getLiveMetaNotifications())
  }

  return notifications
}

// Los chequeos en vivo contra la API de Meta (cuenta, portafolio, entrega,
// actividad) son varios requests por llamada y el Header los pide en cada
// montaje/intervalo: sin caché, Meta regresa "User request limit reached".
const LIVE_META_TTL_MS = 5 * 60 * 1000
let liveMetaCache = { fetchedAt: 0, promise: null }

function getLiveMetaNotifications() {
  const now = Date.now()
  if (liveMetaCache.promise && now - liveMetaCache.fetchedAt < LIVE_META_TTL_MS) {
    return liveMetaCache.promise
  }

  const promise = fetchLiveMetaNotifications().catch((error) => {
    logger.warn(`No se pudieron obtener notificaciones en vivo de Meta: ${error.message}`)
    liveMetaCache = { fetchedAt: 0, promise: null }
    return []
  })

  liveMetaCache = { fetchedAt: now, promise }
  return promise
}

async function fetchLiveMetaNotifications() {
  const notifications = []

  const metaConfig = await getMetaConfig().catch((error) => {
    logger.warn(`No se pudo leer Meta para notificaciones: ${error.message}`)
    notifications.push(createNotification({
      id: 'meta:config-token-read',
      source: 'Meta Ads',
      severity: 'critical',
      title: 'Meta necesita reconexion',
      message: 'No se pudo leer el token guardado de Meta. Vuelve a conectar Meta para que Ristak pueda revisar anuncios, portafolio y eventos.',
      updatedAt: new Date().toISOString(),
      actionUrl: '/settings/meta-ads',
      actionLabel: 'Revisar Meta'
    }))
    return null
  })

  if (metaConfig?.access_token) {
    const { account, notifications: accountNotifications } = await getMetaAccountNotifications(metaConfig)
    notifications.push(...accountNotifications)

    if (account) {
      const [businessNotifications, deliveryNotifications, activityNotifications] = await Promise.all([
        getMetaBusinessPortfolioNotifications(account, metaConfig),
        getMetaDeliveryNotifications(metaConfig),
        getMetaActivityNotifications(metaConfig)
      ])

      notifications.push(...businessNotifications, ...deliveryNotifications, ...activityNotifications)
    }
  }

  return notifications
}

export async function getStorageStatus() {
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
      sizeBytes,
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
    sizeBytes,
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
      message: `La base está usando ${storage.percentUsed.toFixed(1)}% (${storage.sizePretty}) de ${storage.limitGB} GB disponibles.`,
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
        title: 'Dominio público sin conectar',
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
      message: 'No hay llave de OpenAI guardada para el agente. Si lo usas, revisa la configuración.',
      updatedAt: row.updated_at,
      actionUrl: '/settings/ai-agent',
      actionLabel: 'Ver agente'
    })]
  }

  return []
}

async function getAutomationReviewNotifications() {
  try {
    if (!(await canRunBackgroundJob('automations'))) return []
    const problems = await listAutomationReviewProblems({ limit: 5 })
    if (!problems.length) return []

    const preview = problems
      .map((item) => {
        const name = cleanString(item.automation?.name) || 'Automatización'
        const summary = cleanString(item.reviewStatus?.summary)
        return summary ? `${name}: ${summary}` : name
      })
      .join('; ')
    const latest = problems
      .map((item) => item.automation?.updated_at || item.automation?.published_at)
      .filter(Boolean)
      .sort()
      .at(-1)

    return [createNotification({
      id: 'automations:requires-review',
      source: 'Automatizaciones',
      severity: 'warning',
      title: problems.length === 1
        ? 'Automatización requiere revisión'
        : `${problems.length} automatizaciones requieren revisión`,
      message: limitText(preview, 620),
      updatedAt: latest || new Date().toISOString(),
      actionUrl: '/automations',
      actionLabel: 'Revisar automatizaciones'
    })]
  } catch (error) {
    logger.warn(`No se pudieron revisar automatizaciones para notificaciones: ${error.message}`)
    return []
  }
}

async function getInternalNotifications({ userId = null, limit = 30 } = {}) {
  try {
    const cleanUserId = cleanString(userId)
    const max = Math.max(1, Math.min(Number(limit) || 30, 100))
    const rows = cleanUserId
      ? await db.all(
          `SELECT id, source, severity, title, message, action_url, action_label, created_at, updated_at
           FROM internal_notifications
           WHERE recipient_user_id IS NULL OR recipient_user_id = ?
           ORDER BY updated_at DESC
           LIMIT ?`,
          [cleanUserId, max]
        )
      : await db.all(
          `SELECT id, source, severity, title, message, action_url, action_label, created_at, updated_at
           FROM internal_notifications
           WHERE recipient_user_id IS NULL
           ORDER BY updated_at DESC
           LIMIT ?`,
          [max]
        )

    return rows.map(internalNotificationFromRow)
  } catch (error) {
    logger.warn(`No se pudieron leer notificaciones internas: ${error.message}`)
    return []
  }
}

export async function getSystemNotifications({ liveMetaCheck = true, limit = 30, userId = null } = {}) {
  const groups = await Promise.all([
    getInternalNotifications({ userId, limit }),
    getWhatsAppNotifications(),
    getMetaNotifications({ liveMetaCheck }),
    getStorageNotifications(),
    getDomainNotifications(),
    getAutomationReviewNotifications(),
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
