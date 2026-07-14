import { db, getAppConfig, setAppConfig } from '../config/database.js'
import { getAccountCurrency } from '../utils/accountLocale.js'
import {
  extractHighLevelInvoiceScheduleList,
  normalizeHighLevelInvoiceSchedule,
  resolveHighLevelInvoiceScheduleId
} from '../utils/highlevelInvoiceSchedule.js'
import { logger } from '../utils/logger.js'
import { normalizePhoneForStorage } from '../utils/phoneUtils.js'
import { resolveOrCreateContactForGhl } from './contactIdentityService.js'
import { getGHLClient } from './ghlClient.js'

export const HIGHLEVEL_PAYMENT_PLAN_MIRROR_CHECKPOINT_KEY = 'highlevel_payment_plan_mirror_checkpoint_v1'
export const HIGHLEVEL_PAYMENT_PLAN_MIRROR_PAGE_SIZE = 100
export const HIGHLEVEL_PAYMENT_PLAN_MIRROR_MAX_PAGES = 3

function cleanString(value) {
  return String(value || '').trim()
}

function parseJson(value, fallback = {}) {
  if (!value) return fallback
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(Math.floor(parsed), min), max)
}

async function readCheckpoint(store) {
  const value = store?.read
    ? await store.read()
    : await getAppConfig(HIGHLEVEL_PAYMENT_PLAN_MIRROR_CHECKPOINT_KEY)
  return parseJson(value, {})
}

async function writeCheckpoint(store, checkpoint) {
  if (store?.write) return store.write(checkpoint)
  return setAppConfig(HIGHLEVEL_PAYMENT_PLAN_MIRROR_CHECKPOINT_KEY, checkpoint)
}

function extractPaginationState(response = {}) {
  const sources = [
    response,
    response?.meta,
    response?.pagination,
    response?.meta?.pagination,
    response?.data?.meta,
    response?.data?.pagination
  ].filter(value => value && typeof value === 'object' && !Array.isArray(value))

  let total = null
  let hasMore = null
  for (const source of sources) {
    const rawTotal = source.totalCount ?? source.total_count ?? source.total
    const parsedTotal = Number(rawTotal)
    if (Number.isFinite(parsedTotal) && parsedTotal >= 0) total = parsedTotal

    const rawHasMore = source.hasMore ?? source.has_more ?? source.hasNextPage ?? source.has_next_page
    if (typeof rawHasMore === 'boolean') hasMore = rawHasMore
  }

  return { total, hasMore }
}

function buildPageFingerprint(items = []) {
  const ids = items.map(item => resolveHighLevelInvoiceScheduleId(item)).filter(Boolean)
  if (!ids.length) return `empty:${items.length}`
  return `${ids[0]}:${ids[ids.length - 1]}:${items.length}`
}

async function resolveLocalContactId(schedule) {
  if (!cleanString(schedule.contactId)) return null

  const result = await resolveOrCreateContactForGhl({
    ghlContactId: schedule.contactId,
    phone: schedule.phone || null,
    email: schedule.email || null,
    fullName: schedule.contactName || 'Contacto sin nombre',
    source: 'highlevel-payment-plan-mirror',
    createdAt: schedule.createdAt || null
  })
  return result?.contactId || null
}

async function upsertHighLevelPaymentPlanMirror(schedule, database = db) {
  const localContactId = await resolveLocalContactId(schedule)
  const raw = schedule.raw && typeof schedule.raw === 'object' ? schedule.raw : {}
  const scheduleConfig = schedule.scheduleConfig && typeof schedule.scheduleConfig === 'object'
    ? schedule.scheduleConfig
    : {}

  const existing = await database.get(
    `SELECT id, source
     FROM payment_plans
     WHERE id = ? OR ghl_schedule_id = ?
     ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
     LIMIT 1`,
    [schedule.id, schedule.id, schedule.id]
  )
  const existingSource = cleanString(existing?.source || 'ghl').toLowerCase()
  if (existing && !['ghl', 'webhook'].includes(existingSource)) {
    logger.warn(`[GHL planes] Se omitió espejo ${schedule.id}: el ID pertenece al proveedor local ${existingSource}`)
    return { written: false, collision: true }
  }

  if (existing?.id && existing.id !== schedule.id) {
    await database.run(
      `DELETE FROM payment_plans
       WHERE id = ? AND LOWER(COALESCE(source, 'ghl')) IN ('ghl', 'webhook')`,
      [existing.id]
    )
  }

  const result = await database.run(
    `INSERT INTO payment_plans (
      id, ghl_schedule_id, contact_id, contact_name, email, phone,
      name, title, status, total, currency, description, recurrence_label,
      start_date, next_run_at, end_date, live_mode, item_count,
      schedule_json, raw_json, source, last_synced_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ghl', CURRENT_TIMESTAMP, COALESCE(?, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      ghl_schedule_id = excluded.ghl_schedule_id,
      contact_id = excluded.contact_id,
      contact_name = excluded.contact_name,
      email = excluded.email,
      phone = excluded.phone,
      name = excluded.name,
      title = excluded.title,
      status = excluded.status,
      total = excluded.total,
      currency = excluded.currency,
      description = excluded.description,
      recurrence_label = excluded.recurrence_label,
      start_date = excluded.start_date,
      next_run_at = excluded.next_run_at,
      end_date = excluded.end_date,
      live_mode = excluded.live_mode,
      item_count = excluded.item_count,
      schedule_json = excluded.schedule_json,
      raw_json = excluded.raw_json,
      source = 'ghl',
      last_synced_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE LOWER(COALESCE(payment_plans.source, 'ghl')) IN ('ghl', 'webhook')`,
    [
      schedule.id,
      schedule.id,
      localContactId,
      schedule.contactName || null,
      schedule.email || null,
      normalizePhoneForStorage(schedule.phone) || schedule.phone || null,
      schedule.name || null,
      schedule.title || null,
      schedule.status || null,
      Number(schedule.total || 0),
      schedule.currency || null,
      schedule.description || null,
      schedule.recurrenceLabel || null,
      schedule.startDate || null,
      schedule.nextRunAt || null,
      schedule.endDate || null,
      schedule.liveMode === undefined || schedule.liveMode === null ? null : schedule.liveMode ? 1 : 0,
      Number(schedule.itemCount || 0),
      JSON.stringify(scheduleConfig),
      JSON.stringify(raw),
      schedule.createdAt || null
    ]
  )

  return { written: Number(result?.changes || 0) > 0, collision: false }
}

/**
 * Materializa un tramo acotado del catálogo de schedules de HighLevel.
 *
 * Cada página se confirma antes de mover el checkpoint. Si el proceso cae entre
 * ambos pasos, la página se repite y el UPSERT la vuelve idempotente. Nunca se
 * borran planes ausentes: el endpoint no ofrece un snapshot ordenado/cursor que
 * permita convertir una ausencia en eliminación con certeza.
 */
export async function syncHighLevelPaymentPlanMirrors(options = {}) {
  const client = options.client || await getGHLClient()
  const locationId = cleanString(options.locationId || client?.locationId)
  if (!locationId) throw new Error('No hay locationId para materializar planes de HighLevel')

  const pageSize = clampInteger(
    options.pageSize,
    HIGHLEVEL_PAYMENT_PLAN_MIRROR_PAGE_SIZE,
    1,
    HIGHLEVEL_PAYMENT_PLAN_MIRROR_PAGE_SIZE
  )
  const maxPages = clampInteger(
    options.maxPages,
    HIGHLEVEL_PAYMENT_PLAN_MIRROR_MAX_PAGES,
    1,
    HIGHLEVEL_PAYMENT_PLAN_MIRROR_MAX_PAGES
  )
  const fallbackCurrency = cleanString(options.accountCurrency || await getAccountCurrency()).toUpperCase()
  const checkpointStore = options.checkpointStore
  const stored = await readCheckpoint(checkpointStore)
  let checkpoint = stored.locationId === locationId
    ? {
        ...stored,
        nextOffset: clampInteger(stored.nextOffset, 0, 0, Number.MAX_SAFE_INTEGER)
      }
    : { locationId, nextOffset: 0, lastPageFingerprint: '' }

  const result = {
    locationId,
    pages: 0,
    fetched: 0,
    saved: 0,
    skipped: 0,
    nextOffset: checkpoint.nextOffset,
    cycleCompleted: false,
    paginationStalled: false,
    stopped: false
  }

  for (let page = 0; page < maxPages; page += 1) {
    if (options.shouldContinue && !options.shouldContinue()) {
      result.stopped = true
      break
    }

    const offset = checkpoint.nextOffset
    const response = await client.listInvoiceSchedules({ limit: pageSize, offset })
    const rawSchedules = extractHighLevelInvoiceScheduleList(response)
    const fingerprint = buildPageFingerprint(rawSchedules)

    if (offset > 0 && checkpoint.lastPageFingerprint && checkpoint.lastPageFingerprint === fingerprint) {
      checkpoint = {
        ...checkpoint,
        nextOffset: 0,
        lastPageFingerprint: '',
        paginationStalledAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
      await writeCheckpoint(checkpointStore, checkpoint)
      result.nextOffset = 0
      result.paginationStalled = true
      logger.warn('[GHL planes] El proveedor repitió la misma página para otro offset; se reinició el checkpoint sin barrer en bucle')
      break
    }

    const uniqueSchedules = []
    const seenIds = new Set()
    for (const rawSchedule of rawSchedules) {
      const normalized = normalizeHighLevelInvoiceSchedule(rawSchedule, { fallbackCurrency })
      if (!normalized.id || seenIds.has(normalized.id)) {
        result.skipped += 1
        continue
      }
      seenIds.add(normalized.id)
      uniqueSchedules.push(normalized)
    }

    let written = 0
    let collisions = 0
    await db.transaction(async (transaction) => {
      for (const schedule of uniqueSchedules) {
        const persisted = await upsertHighLevelPaymentPlanMirror(schedule, transaction)
        if (persisted.written) written += 1
        if (persisted.collision) collisions += 1
      }
    })

    result.pages += 1
    result.fetched += rawSchedules.length
    result.saved += written
    result.skipped += collisions

    const pagination = extractPaginationState(response)
    const reachedEnd = rawSchedules.length < pageSize ||
      pagination.hasMore === false ||
      (pagination.total !== null && offset + rawSchedules.length >= pagination.total)
    const now = new Date().toISOString()

    checkpoint = reachedEnd
      ? {
          locationId,
          nextOffset: 0,
          lastPageFingerprint: '',
          lastCompletedAt: now,
          updatedAt: now
        }
      : {
          locationId,
          nextOffset: offset + rawSchedules.length,
          lastPageFingerprint: fingerprint,
          updatedAt: now
        }
    await writeCheckpoint(checkpointStore, checkpoint)

    result.nextOffset = checkpoint.nextOffset
    if (reachedEnd) {
      result.cycleCompleted = true
      break
    }
  }

  return result
}
