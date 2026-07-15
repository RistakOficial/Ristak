import { createHash } from 'crypto'
import { databaseDialect, db } from '../config/database.js'
import { buildDedupExpression } from './analyticsService.js'
import { getVisitorIdentityExpression } from './trackingService.js'
import { buildHiddenContactsCondition, getHiddenContactFilters } from '../utils/hiddenContactsFilter.js'
import { nonTestPaymentCondition, SUCCESS_PAYMENT_STATUSES } from '../utils/paymentMode.js'
import { sqliteTimezoneOffsetClause } from '../utils/dateUtils.js'
import {
  getCampaignPerformanceAccountScope,
  getCampaignPerformanceSourceRevision,
  readLatestCampaignPerformanceMaterializedPage,
  readCampaignPerformanceMaterializedPage,
  replaceCampaignPerformanceMaterializedRows
} from './campaignPerformanceMaterializationService.js'

const isPostgres = databaseDialect === 'postgres'

export const CAMPAIGN_PAGE_DEFAULT_SIZE = 50
export const CAMPAIGN_PAGE_MAX_SIZE = 100
export const CAMPAIGN_CHILDREN_MAX_SIZE = 200

const ACTIVE_APPOINTMENT_STATUSES_EXCLUDED = [
  'cancelled',
  'canceled',
  'no_show',
  'no-show',
  'noshow',
  'invalid',
  'failed',
  'missed',
  'deleted',
  'void',
  'voided'
]
const ATTENDED_APPOINTMENT_STATUSES = ['showed', 'show', 'attended', 'completed', 'complete']
const REFUND_PAYMENT_STATUSES = ['refunded', 'refund']

const sqlList = values => values.map(value => `'${String(value).replace(/'/g, "''")}'`).join(', ')

const ENTITY_LEVELS = {
  campaign: {
    id: 'campaign_id',
    name: 'campaign_name',
    parentSelect: '',
    childCount: 'COUNT(DISTINCT m.adset_id)',
    parentFilter: null
  },
  adset: {
    id: 'adset_id',
    name: 'adset_name',
    parentSelect: ', MAX(m.campaign_id) AS campaign_id, MAX(m.campaign_name) AS campaign_name',
    childCount: 'COUNT(DISTINCT m.ad_id)',
    parentFilter: { queryKey: 'campaignId', column: 'campaign_id' }
  },
  ad: {
    id: 'ad_id',
    name: 'ad_name',
    parentSelect: `,
      MAX(m.campaign_id) AS campaign_id,
      MAX(m.campaign_name) AS campaign_name,
      MAX(m.adset_id) AS adset_id,
      MAX(m.adset_name) AS adset_name,
      MAX(m.creative_id) AS creative_id,
      MAX(m.creative_type) AS creative_type,
      MAX(m.creative_thumbnail_url) AS creative_thumbnail_url,
      MAX(m.creative_image_url) AS creative_image_url,
      MAX(m.creative_video_id) AS creative_video_id,
      MAX(m.creative_video_url) AS creative_video_url,
      MAX(m.creative_preview_url) AS creative_preview_url`,
    childCount: '0',
    parentFilter: { queryKey: 'adsetId', column: 'adset_id' }
  }
}

const BASE_SORT_COLUMNS = new Set(['name', 'spend', 'reach', 'clicks', 'cpc', 'cpm', 'lastActiveDate'])
const METRIC_SORT_COLUMNS = new Set(['revenue', 'sales', 'leads', 'appointments', 'attendances', 'visitors', 'roas'])

const pageCache = new Map()
const materializationBuilds = new Map()
const PAGE_CACHE_TTL_MS = 20_000
const PAGE_CACHE_MAX_ENTRIES = 80
const MATERIALIZATION_BACKGROUND_BUILD_LIMIT = 2

function createCampaignAbortError() {
  return Object.assign(new Error('La consulta de campañas fue cancelada'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
    status: 499
  })
}

function throwIfCampaignRequestAborted(signal) {
  if (signal?.aborted) throw createCampaignAbortError()
}

function waitForCampaignBuild(build, signal) {
  if (!signal) return build
  throwIfCampaignRequestAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(createCampaignAbortError())
    signal.addEventListener('abort', onAbort, { once: true })
    build.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

function cloneResult(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

function prunePageCache(now = Date.now()) {
  for (const [key, entry] of pageCache) {
    if (!entry || entry.expiresAt <= now) pageCache.delete(key)
  }

  while (pageCache.size > PAGE_CACHE_MAX_ENTRIES) {
    const oldestKey = pageCache.keys().next().value
    if (oldestKey === undefined) break
    pageCache.delete(oldestKey)
  }
}

function materializedCacheKey(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function invalidateCampaignPerformanceCache() {
  pageCache.clear()
}

function normalizePositiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function normalizeLevel(value) {
  const level = String(value || 'campaign').trim().toLowerCase()
  return Object.hasOwn(ENTITY_LEVELS, level) ? level : 'campaign'
}

function normalizeSortBy(value) {
  const sortBy = String(value || 'lastActiveDate').trim()
  return BASE_SORT_COLUMNS.has(sortBy) || METRIC_SORT_COLUMNS.has(sortBy)
    ? sortBy
    : 'lastActiveDate'
}

function normalizeSortOrder(value) {
  return String(value || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC'
}

function timestampDateExpression(column, timezone = 'UTC', referenceDate = new Date()) {
  if (!isPostgres) return `DATE(datetime(${column}, ${sqliteTimezoneOffsetClause(timezone, referenceDate)}))`
  const safeTimezone = String(timezone || 'UTC').replace(/'/g, "''")
  return `((${column})::timestamptz AT TIME ZONE '${safeTimezone}')::date`
}

function metaDateExpression(column) {
  return isPostgres ? `(${column})::date` : `DATE(${column})`
}

function buildEntityRollupSql(config, parentId) {
  const conditions = [
    'm.date >= ?',
    'm.date <= ?',
    `m.${config.id} IS NOT NULL`,
    `m.${config.id} != ''`
  ]
  const params = []

  if (config.parentFilter && parentId) {
    conditions.push(`m.${config.parentFilter.column} = ?`)
    params.push(parentId)
  }

  return {
    sql: `
      SELECT
        m.${config.id} AS id,
        MAX(m.${config.name}) AS name,
        COALESCE(SUM(m.spend), 0) AS spend,
        COALESCE(SUM(m.reach), 0) AS reach,
        COALESCE(SUM(m.clicks), 0) AS clicks,
        COALESCE(AVG(m.cpc), 0) AS cpc,
        COALESCE(AVG(m.cpm), 0) AS cpm,
        MAX(m.date) AS last_active_date,
        ${config.childCount} AS child_count
        ${config.parentSelect}
      FROM meta_ads m
      WHERE ${conditions.join('\n        AND ')}
      GROUP BY m.${config.id}
    `,
    parentParams: params
  }
}

function buildSearchClause(search) {
  const normalized = String(search || '').trim().slice(0, 160).toLowerCase()
  if (!normalized) return { sql: '', params: [] }
  const pattern = `%${normalized}%`
  return {
    sql: `WHERE (LOWER(COALESCE(name, '')) LIKE ? OR LOWER(COALESCE(id, '')) LIKE ?)`,
    params: [pattern, pattern]
  }
}

function baseOrderExpression(sortBy, sortOrder, alias = '') {
  const prefix = alias ? `${alias}.` : ''
  const column = sortBy === 'lastActiveDate' ? 'last_active_date' : sortBy
  return `${prefix}${column} ${sortOrder}, ${prefix}id ${sortOrder}`
}

function metricOrderExpression(sortBy, sortOrder) {
  if (sortBy === 'roas') {
    return `(CASE WHEN spend > 0 THEN revenue / spend ELSE 0 END) ${sortOrder}, id ${sortOrder}`
  }
  const column = sortBy === 'lastActiveDate' ? 'last_active_date' : sortBy
  return `${column} ${sortOrder}, id ${sortOrder}`
}

async function getAttributionCalendarIds() {
  const row = await db.get(
    'SELECT config_value FROM app_config WHERE config_key = ?',
    ['attribution_calendar_ids']
  )
  if (!row?.config_value) return null

  try {
    const values = JSON.parse(row.config_value)
    return Array.isArray(values) && values.length > 0
      ? [...new Set(values.map(value => String(value).trim()).filter(Boolean))]
      : null
  } catch {
    return null
  }
}

function normalizeEntityRow(row, level) {
  const spend = Number(row.spend || 0)
  const revenue = Number(row.revenue || 0)
  const childCount = Number(row.child_count || 0)
  const item = {
    id: String(row.id),
    name: row.name || String(row.id),
    spend,
    reach: Number(row.reach || 0),
    impressions: 0,
    clicks: Number(row.clicks || 0),
    cpc: Number(row.cpc || 0),
    cpm: Number(row.cpm || 0),
    revenue,
    roas: spend > 0 ? revenue / spend : 0,
    sales: Number(row.sales || 0),
    leads: Number(row.leads || 0),
    appointments: Number(row.appointments || 0),
    attendances: Number(row.attendances || 0),
    visitors: Number(row.visitors || 0),
    childCount,
    hasChildren: childCount > 0,
    lastActiveDate: row.last_active_date || null
  }

  if (level === 'campaign') {
    return { ...item, platform: 'Meta', adsets: [], adSets: [] }
  }

  if (level === 'adset') {
    return {
      ...item,
      campaignId: row.campaign_id ? String(row.campaign_id) : null,
      campaignName: row.campaign_name || null,
      ads: []
    }
  }

  return {
    ...item,
    campaignId: row.campaign_id ? String(row.campaign_id) : null,
    campaignName: row.campaign_name || null,
    adSetId: row.adset_id ? String(row.adset_id) : null,
    adsetId: row.adset_id ? String(row.adset_id) : null,
    adSetName: row.adset_name || null,
    adsetName: row.adset_name || null,
    creativeId: row.creative_id || null,
    creativeType: row.creative_type || null,
    creativeThumbnailUrl: row.creative_thumbnail_url || null,
    creativeImageUrl: row.creative_image_url || null,
    creativeVideoId: row.creative_video_id || null,
    creativeVideoUrl: row.creative_video_url || null,
    creativePreviewUrl: row.creative_preview_url || null
  }
}

/**
 * Contrato acotado para Publicidad.
 *
 * La ruta caliente pagina primero `meta_ads` y después calcula contactos,
 * pagos, citas y visitantes únicamente para esas entidades. Los órdenes por
 * conversión se resuelven contra un snapshot exacto persistente y revisionado:
 * el cruce pesado se materializa una vez y las páginas posteriores sólo leen
 * el índice del snapshot.
 */
export async function getCampaignPerformancePage({
  range,
  level: requestedLevel = 'campaign',
  page: requestedPage = 1,
  pageSize: requestedPageSize = CAMPAIGN_PAGE_DEFAULT_SIZE,
  search = '',
  sortBy: requestedSortBy = 'lastActiveDate',
  sortOrder: requestedSortOrder = 'desc',
  campaignId = '',
  adsetId = '',
  includeVisitors = false,
  onlyWithResults = false,
  signal
} = {}) {
  throwIfCampaignRequestAborted(signal)
  if (!range?.startZoned || !range?.endZoned || !range?.startUtc || !range?.endUtc) {
    const error = new Error('Rango de fechas inválido')
    error.status = 400
    throw error
  }

  const level = normalizeLevel(requestedLevel)
  const config = ENTITY_LEVELS[level]
  const page = normalizePositiveInteger(requestedPage, 1, 1_000_000)
  const requestedMax = config.parentFilter ? CAMPAIGN_CHILDREN_MAX_SIZE : CAMPAIGN_PAGE_MAX_SIZE
  const pageSize = normalizePositiveInteger(requestedPageSize, CAMPAIGN_PAGE_DEFAULT_SIZE, requestedMax)
  const sortBy = normalizeSortBy(requestedSortBy)
  const sortOrder = normalizeSortOrder(requestedSortOrder)
  const parentId = level === 'adset'
    ? String(campaignId || '').trim()
    : level === 'ad'
      ? String(adsetId || '').trim()
      : ''
  const adsStart = range.startZoned.toISODate()
  const adsEnd = range.endZoned.toISODate()
  const normalizedSearch = String(search || '').trim().slice(0, 160)
  const metricSort = METRIC_SORT_COLUMNS.has(sortBy) || Boolean(onlyWithResults)

  const cacheKey = JSON.stringify({
    adsStart,
    adsEnd,
    startUtc: range.startUtc,
    endUtc: range.endUtc,
    timezone: range.appliedTimezone,
    level,
    page,
    pageSize,
    search: normalizedSearch,
    sortBy,
    sortOrder,
    parentId,
    includeVisitors: Boolean(includeVisitors),
    onlyWithResults: Boolean(onlyWithResults)
  })
  const now = Date.now()
  prunePageCache(now)
  const cached = pageCache.get(cacheKey)
  if (!metricSort && cached?.expiresAt > now) return cloneResult(cached.value)

  const rollup = buildEntityRollupSql(config, parentId)
  const searchClause = buildSearchClause(normalizedSearch)
  const rollupParams = [adsStart, adsEnd, ...rollup.parentParams]
  let totalItems = 0
  let totalPages = 1
  let safePage = page
  if (!metricSort) {
    const totalRow = await db.get(`
      WITH entity_rollups AS (${rollup.sql})
      SELECT COUNT(*) AS total
      FROM entity_rollups
      ${searchClause.sql}
    `, [...rollupParams, ...searchClause.params], { signal })
    throwIfCampaignRequestAborted(signal)
    totalItems = Number(totalRow?.total || 0)
    totalPages = Math.max(Math.ceil(totalItems / pageSize), 1)
    safePage = Math.min(page, totalPages)
  }
  let offset = (safePage - 1) * pageSize

  const hiddenFilters = await getHiddenContactFilters()
  throwIfCampaignRequestAborted(signal)
  const hiddenCondition = buildHiddenContactsCondition(hiddenFilters, 'c', false)
  const dedupExpression = buildDedupExpression('c')
  const appointmentCalendars = await getAttributionCalendarIds()
  throwIfCampaignRequestAborted(signal)
  const calendarCondition = appointmentCalendars?.length
    ? `AND a.calendar_id IN (${appointmentCalendars.map(() => '?').join(', ')})`
    : ''
  const visitorIdentity = getVisitorIdentityExpression('s')
  const visitorCte = includeVisitors
    ? `,
      visitor_metrics AS (
        SELECT
          s.${config.id} AS entity_id,
          COUNT(DISTINCT ${visitorIdentity}) AS visitors
        FROM sessions s
        INNER JOIN selected_entities se ON se.id = s.${config.id}
        WHERE s.${config.id} IS NOT NULL
          AND s.started_at >= ?
          AND s.started_at <= ?
        GROUP BY s.${config.id}
      )`
    : ''
  const visitorJoin = includeVisitors
    ? 'LEFT JOIN visitor_metrics vm ON vm.entity_id = se.id'
    : ''
  const visitorSelect = includeVisitors ? 'COALESCE(vm.visitors, 0)' : '0'

  const selectedEntitiesSql = metricSort
    ? `SELECT * FROM filtered_entities`
    : `SELECT * FROM filtered_entities ORDER BY ${baseOrderExpression(sortBy, sortOrder)} LIMIT ? OFFSET ?`

  const entityMetricsCte = `
    WITH
      entity_rollups AS (${rollup.sql}),
      filtered_entities AS (
        SELECT * FROM entity_rollups
        ${searchClause.sql}
      ),
      selected_entities AS (
        ${selectedEntitiesSql}
      ),
      entity_ad_dates AS (
        SELECT DISTINCT
          se.id AS entity_id,
          m.ad_id,
          ${metaDateExpression('m.date')} AS ad_date
        FROM meta_ads m
        INNER JOIN selected_entities se ON se.id = m.${config.id}
        WHERE m.date >= ? AND m.date <= ?
      ),
      candidate_contacts AS (
        SELECT DISTINCT
          e.entity_id,
          c.id AS contact_id,
          ${dedupExpression} AS person_key,
          COALESCE(c.purchases_count, 0) AS purchases_count,
          COALESCE(c.total_paid, 0) AS total_paid,
          CASE WHEN c.appointment_date IS NOT NULL THEN 1 ELSE 0 END AS has_contact_appointment
        FROM entity_ad_dates e
        INNER JOIN contacts c
          ON c.attribution_ad_id = e.ad_id
          AND ${timestampDateExpression('c.created_at', range.appliedTimezone, range.startUtc)} = e.ad_date
        WHERE c.created_at >= ?
          AND c.created_at <= ?
          ${hiddenCondition ? `AND ${hiddenCondition}` : ''}
      ),
      payment_facts AS (
        SELECT
          cc.entity_id,
          cc.contact_id,
          COALESCE(SUM(CASE
            WHEN ${nonTestPaymentCondition('p')}
              AND LOWER(COALESCE(p.status, '')) IN (${sqlList(SUCCESS_PAYMENT_STATUSES)})
              THEN COALESCE(p.amount, 0)
            WHEN ${nonTestPaymentCondition('p')}
              AND LOWER(COALESCE(p.status, '')) IN (${sqlList(REFUND_PAYMENT_STATUSES)})
              THEN -COALESCE(p.amount, 0)
            ELSE 0
          END), 0) AS payment_total
        FROM candidate_contacts cc
        LEFT JOIN payments p ON p.contact_id = cc.contact_id
        GROUP BY cc.entity_id, cc.contact_id
      ),
      appointment_facts AS (
        SELECT
          cc.entity_id,
          cc.contact_id,
          MAX(CASE
            WHEN a.contact_id IS NOT NULL
              AND LOWER(COALESCE(a.appointment_status, a.status, '')) NOT IN (${sqlList(ACTIVE_APPOINTMENT_STATUSES_EXCLUDED)})
              THEN 1 ELSE 0
          END) AS has_appointment,
          MAX(CASE
            WHEN LOWER(COALESCE(a.appointment_status, a.status, '')) IN (${sqlList(ATTENDED_APPOINTMENT_STATUSES)})
              THEN 1 ELSE 0
          END) AS has_attendance
        FROM candidate_contacts cc
        LEFT JOIN appointments a ON a.contact_id = cc.contact_id ${calendarCondition}
        GROUP BY cc.entity_id, cc.contact_id
      ),
      attendance_facts AS (
        SELECT cc.entity_id, cc.contact_id, 1 AS has_signal
        FROM candidate_contacts cc
        INNER JOIN appointment_attendance_signals signals ON signals.contact_id = cc.contact_id
        GROUP BY cc.entity_id, cc.contact_id
      ),
      person_metrics AS (
        SELECT
          cc.entity_id,
          cc.person_key,
          MAX(CASE WHEN cc.purchases_count > 0 THEN 1 ELSE 0 END) AS is_sale,
          MAX(CASE
            WHEN cc.has_contact_appointment > 0 OR COALESCE(af.has_appointment, 0) > 0 THEN 1
            ELSE 0
          END) AS has_appointment,
          MAX(CASE
            WHEN COALESCE(af.has_attendance, 0) > 0 OR COALESCE(atf.has_signal, 0) > 0 THEN 1
            ELSE 0
          END) AS has_attendance,
          MAX(cc.total_paid) AS stored_ltv,
          SUM(COALESCE(pf.payment_total, 0)) AS successful_payments
        FROM candidate_contacts cc
        LEFT JOIN payment_facts pf
          ON pf.entity_id = cc.entity_id AND pf.contact_id = cc.contact_id
        LEFT JOIN appointment_facts af
          ON af.entity_id = cc.entity_id AND af.contact_id = cc.contact_id
        LEFT JOIN attendance_facts atf
          ON atf.entity_id = cc.entity_id AND atf.contact_id = cc.contact_id
        GROUP BY cc.entity_id, cc.person_key
      ),
      contact_metrics AS (
        SELECT
          entity_id,
          COUNT(*) AS leads,
          COALESCE(SUM(is_sale), 0) AS sales,
          COALESCE(SUM(has_appointment), 0) AS appointments,
          COALESCE(SUM(has_attendance), 0) AS attendances,
          COALESCE(SUM(CASE
            WHEN stored_ltv > successful_payments THEN stored_ltv
            ELSE successful_payments
          END), 0) AS revenue
        FROM person_metrics
        GROUP BY entity_id
      )
      ${visitorCte},
      entity_metrics AS (
        SELECT
          se.*,
          COALESCE(cm.leads, 0) AS leads,
          COALESCE(cm.sales, 0) AS sales,
          COALESCE(cm.appointments, 0) AS appointments,
          COALESCE(cm.attendances, 0) AS attendances,
          COALESCE(cm.revenue, 0) AS revenue,
          ${visitorSelect} AS visitors
        FROM selected_entities se
        LEFT JOIN contact_metrics cm ON cm.entity_id = se.id
        ${visitorJoin}
      )
  `
  const query = `
    ${entityMetricsCte}
    SELECT *, COUNT(*) OVER() AS matched_total
    FROM entity_metrics
    ${onlyWithResults
      ? 'WHERE revenue > 0 OR sales > 0 OR appointments > 0 OR attendances > 0 OR leads > 0'
      : ''}
    ORDER BY ${metricSort
      ? metricOrderExpression(sortBy, sortOrder)
      : baseOrderExpression(sortBy, sortOrder)}
    ${metricSort ? 'LIMIT ? OFFSET ?' : ''}
  `

  const queryParams = [
    ...rollupParams,
    ...searchClause.params,
    ...(!metricSort ? [pageSize, offset] : []),
    adsStart,
    adsEnd,
    range.startUtc,
    range.endUtc,
    ...(appointmentCalendars || []),
    ...(includeVisitors ? [range.startUtc, range.endUtc] : []),
    ...(metricSort ? [pageSize, offset] : [])
  ]
  let effectivePage = safePage
  let items
  let materializedAt = null
  let materializedRevision = null
  let materializationStale = false

  if (metricSort) {
    const accountScope = await getCampaignPerformanceAccountScope()
    const persistentCacheKey = materializedCacheKey({
      adsStart,
      adsEnd,
      startUtc: range.startUtc,
      endUtc: range.endUtc,
      timezone: range.appliedTimezone,
      level,
      parentId,
      includeVisitors: Boolean(includeVisitors),
      search: normalizedSearch,
      hiddenFilters,
      appointmentCalendars: appointmentCalendars || []
    })
    const materializationParams = queryParams.slice(0, -2)
    const readPage = sourceRevision => readCampaignPerformanceMaterializedPage({
      accountScope,
      cacheKey: persistentCacheKey,
      sourceRevision,
      search: '',
      onlyWithResults,
      sortBy,
      sortOrder,
      pageSize,
      offset
    })
    const readLatestPage = () => readLatestCampaignPerformanceMaterializedPage({
      accountScope,
      cacheKey: persistentCacheKey,
      search: '',
      onlyWithResults,
      sortBy,
      sortOrder,
      pageSize,
      offset
    })
    const startBuild = (sourceRevision, { background = false } = {}) => {
      const buildKey = `${accountScope}:${persistentCacheKey}:${sourceRevision}`
      const existing = materializationBuilds.get(buildKey)
      if (existing) return existing
      if (background && materializationBuilds.size >= MATERIALIZATION_BACKGROUND_BUILD_LIMIT) return null

      const build = (async () => {
        // Un SELECT conserva un snapshot consistente del motor. Aunque la
        // revisión cambie mientras corre, se guarda como snapshot histórico y
        // sólo se marca "actual" si la revisión sigue siendo la misma.
        const allRows = await db.all(`${entityMetricsCte}\nSELECT * FROM entity_metrics`, materializationParams)
        const exactItems = allRows.map(row => normalizeEntityRow(row, level))
        await replaceCampaignPerformanceMaterializedRows({
          accountScope,
          cacheKey: persistentCacheKey,
          sourceRevision,
          level,
          items: exactItems
        })
        return (await getCampaignPerformanceSourceRevision({ includeVisitors })) === sourceRevision
      })().finally(() => {
        materializationBuilds.delete(buildKey)
      })
      materializationBuilds.set(buildKey, build)
      return build
    }

    let sourceRevision = await getCampaignPerformanceSourceRevision({ includeVisitors })
    let materializedPage = await readPage(sourceRevision)
    let revisionAfterRead = await getCampaignPerformanceSourceRevision({ includeVisitors })
    if (revisionAfterRead !== sourceRevision) {
      sourceRevision = revisionAfterRead
      materializedPage = null
    }

    if (!materializedPage) {
      const lastConsistentPage = await readLatestPage()
      if (lastConsistentPage) {
        materializedPage = lastConsistentPage
        materializationStale = lastConsistentPage.sourceRevision !== sourceRevision
        const backgroundBuild = startBuild(sourceRevision, { background: true })
        if (backgroundBuild) void backgroundBuild.catch(() => undefined)
      } else {
        const build = startBuild(sourceRevision)
        if (build) await waitForCampaignBuild(build, signal)
        throwIfCampaignRequestAborted(signal)

        const currentRevision = await getCampaignPerformanceSourceRevision({ includeVisitors })
        const currentPage = await readPage(currentRevision)
        const revisionAfterCurrentRead = await getCampaignPerformanceSourceRevision({ includeVisitors })
        if (currentPage && revisionAfterCurrentRead === currentRevision) {
          materializedPage = currentPage
          sourceRevision = currentRevision
        } else {
          materializedPage = await readLatestPage()
          materializationStale = Boolean(materializedPage)
        }
      }
    }

    if (!materializedPage) {
      const error = new Error('No se pudo construir un snapshot consistente de campañas')
      error.status = 503
      throw error
    }

    totalItems = materializedPage.totalItems
    totalPages = Math.max(Math.ceil(totalItems / pageSize), 1)
    effectivePage = Math.min(page, totalPages)
    if (effectivePage !== page) {
      offset = (effectivePage - 1) * pageSize
      materializedPage = await readCampaignPerformanceMaterializedPage({
        accountScope,
        cacheKey: persistentCacheKey,
        sourceRevision: materializedPage.sourceRevision,
        search: '',
        onlyWithResults,
        sortBy,
        sortOrder,
        pageSize,
        offset
      })
      if (!materializedPage) {
        const error = new Error('El snapshot materializado de campañas ya no está disponible')
        error.status = 503
        throw error
      }
    }
    const latestRevision = await getCampaignPerformanceSourceRevision({ includeVisitors })
    materializationStale = materializationStale || latestRevision !== materializedPage.sourceRevision
    items = materializedPage.items
    materializedAt = materializedPage.builtAt
    materializedRevision = materializedPage.sourceRevision
  } else {
    const rows = await db.all(query, queryParams, { signal })
    throwIfCampaignRequestAborted(signal)
    items = rows.map(row => normalizeEntityRow(row, level))
  }
  const result = {
    items,
    pagination: {
      page: effectivePage,
      pageSize,
      totalItems,
      totalPages,
      hasMore: effectivePage < totalPages
    },
    level,
    parentId: parentId || null,
    limits: {
      pageSizeMax: requestedMax,
      hierarchyLoadedLazily: true
    },
    materialization: metricSort
      ? {
          exact: !materializationStale,
          exactAtBuiltAt: true,
          stale: materializationStale,
          builtAt: materializedAt,
          sourceRevision: materializedRevision
        }
      : null
  }

  if (!metricSort) {
    pageCache.set(cacheKey, { value: cloneResult(result), expiresAt: now + PAGE_CACHE_TTL_MS })
    prunePageCache(now)
  }
  throwIfCampaignRequestAborted(signal)
  return result
}
