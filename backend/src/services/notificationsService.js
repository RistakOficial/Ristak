import fetch from 'node-fetch'
import { db, getAppConfig } from '../config/database.js'
import { API_URLS } from '../config/constants.js'
import { getMetaConfig, getMetaSyncProgress } from './metaAdsService.js'
import { getSitesPublicDomain } from './sitesService.js'
import { logger } from '../utils/logger.js'

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
  7: 'En revision de riesgo',
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
  PENDING_REVIEW: 'en revision',
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
  IN_REVIEW: 'en revision',
  PENDING: 'pendiente'
}

function cleanString(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
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

function sortNotifications(left, right) {
  const severityDiff = (SEVERITY_RANK[right.severity] || 0) - (SEVERITY_RANK[left.severity] || 0)
  if (severityDiff !== 0) return severityDiff
  return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
}

function buildMetaGraphUrl(path, params = {}, accessToken = '') {
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

  return url
}

async function metaGraphGet(path, params = {}, accessToken = '') {
  const url = buildMetaGraphUrl(path, params, accessToken)
  const response = await fetch(url)
  const data = await response.json().catch(() => null)

  if (!response.ok || data?.error) {
    const metaError = new Error(sanitizeExternalMessage(data?.error?.message || `Meta respondio ${response.status}`))
    metaError.code = data?.error?.code
    metaError.subcode = data?.error?.error_subcode
    metaError.type = data?.error?.type
    metaError.status = response.status
    throw metaError
  }

  return data
}

async function metaGraphGetWithFieldFallback(path, fieldSets = [], params = {}, accessToken = '') {
  let lastError = null

  for (const fields of fieldSets) {
    try {
      return await metaGraphGet(path, { ...params, fields }, accessToken)
    } catch (error) {
      lastError = error
      logger.warn(`Meta notification field fallback ${path}: ${error.message}`)
    }
  }

  throw lastError || new Error('Meta no respondio')
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
    message: sanitizeExternalMessage(error?.message || 'Meta no respondio.'),
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
      ? 'El token de Meta ya expiro. La sincronizacion de anuncios y eventos puede fallar.'
      : `El token de Meta expira en ${days} dia${days === 1 ? '' : 's'}. Renovalo antes de que se corte la sincronizacion.`,
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
  ], {}, metaConfig.access_token)
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
      title: severity === 'critical' ? 'Cuenta publicitaria detenida' : 'Cuenta publicitaria requiere revision',
      message: `${accountName} esta en estado "${formatMetaAccountStatus(rawStatus)}"${disableReason > 0 ? ` y Meta reporta razon ${disableReason}` : ''}. Revisa la cuenta antes de seguir invirtiendo.`,
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
      title: percent >= 100 ? 'Limite de gasto de Meta alcanzado' : 'Limite de gasto de Meta casi lleno',
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
      title: 'Meta no muestra metodo de pago activo',
      message: `${accountName} no devolvio un metodo de pago activo. Si tus anuncios no gastan, revisa facturacion en Meta.`,
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
        message: days <= 0 ? 'Meta reporta que el acceso de usuario ya expiro.' : `Meta reporta que el acceso expira en ${days} dia${days === 1 ? '' : 's'}.`,
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

async function fetchMetaBusinessEdge(businessId, edge, fields, accessToken, limit = 25) {
  const data = await metaGraphGet(`${encodeURIComponent(businessId)}/${edge}`, { fields, limit }, accessToken)
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
    }, metaConfig.access_token)

    const businessName = business.name || extractMetaBusinessName(account) || 'Portafolio comercial'
    const verificationSeverity = getBusinessStatusSeverity(business.verification_status)
    if (verificationSeverity) {
      notifications.push(createNotification({
        id: `meta:business-verification:${businessId}`,
        source: 'Meta Business',
        severity: verificationSeverity,
        title: verificationSeverity === 'critical' ? 'Portafolio comercial detenido' : 'Portafolio comercial requiere revision',
        message: `${businessName} reporta verificacion "${formatMetaStatus(business.verification_status)}". Esto puede afectar anuncios, WhatsApp o permisos del negocio.`,
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
          title: 'Cuenta publicitaria del portafolio requiere revision',
          message: `${row.name || `act_${adAccountId}`} esta en "${formatMetaAccountStatus(row.account_status)}"${disableReason > 0 ? ` con razon ${disableReason}` : ''}.`,
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
        title: severity === 'critical' ? 'Cuenta de WhatsApp en Meta detenida' : 'Cuenta de WhatsApp en Meta requiere revision',
        message: `${waba.name || waba.id} reporta revision "${reviewStatus || 'sin dato'}" y verificacion "${verificationStatus || 'sin dato'}".`,
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

async function fetchMetaEntities(path, fields, params, accessToken) {
  const data = await metaGraphGet(path, {
    ...params,
    fields,
    limit: META_ENTITY_LIMIT
  }, accessToken)
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
    title: `${rows.length} ${rows.length === 1 ? typeConfig.singleLabel : typeConfig.pluralLabel} ${rows.length === 1 ? 'requiere' : 'requieren'} revision`,
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
      let rows = await fetchMetaEntities(config.path, config.fields, { filtering }, metaConfig.access_token)
      rows = rows.filter(shouldNotifyMetaEntity)

      if (!rows.length) {
        const unfiltered = await fetchMetaEntities(config.path, config.fields, {}, metaConfig.access_token)
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
    }, metaConfig.access_token)

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
