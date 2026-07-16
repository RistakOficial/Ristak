import { DateTime } from 'luxon'

import { databaseDialect } from '../config/database.js'
import { normalizeDateOnlyInTimezone, normalizeToUtcIso } from '../utils/dateUtils.js'

export const TRACKING_ANALYTICS_FAST_FACETS = Object.freeze({
  sources: ['traffic_source', 'traffic_source'],
  devices: ['device_type', 'device_type'],
  browsers: ['browser', 'browser'],
  os: ['os', 'os'],
  placements: ['placement', 'placement']
})

const FACET_COLUMNS = Object.freeze(Array.from(new Set(
  Object.values(TRACKING_ANALYTICS_FAST_FACETS).flat()
)))
const RANGE_ORIGIN = '0001-01-01'
// `contact_id = ''` sí cuenta una vez en el SQL legacy; NULL no cuenta. El
// sentinel permite conservar esa diferencia dentro de presence sin hacer el
// campo nullable ni confundir tráfico anónimo con un contacto identificado.
export const TRACKING_ANALYTICS_EMPTY_CONTACT_KEY = '__empty_contact__'
export const TRACKING_ANALYTICS_EMPTY_SESSION_KEY = '__empty_session__'
const RETURNING_REPAIR_BATCH_SIZE = 25
const RANGE_COMPILE_VISITOR_BATCH_SIZE = 25
const SQLITE_PARAMETER_BUDGET = 900
const POSTGRES_PARAMETER_BUDGET = 20_000

function parameterBudget() {
  return databaseDialect === 'postgres' ? POSTGRES_PARAMETER_BUDGET : SQLITE_PARAMETER_BUDGET
}

function chunks(rows, size) {
  const result = []
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size))
  return result
}

function textValue(value) {
  return String(value ?? '').trim()
}

function dateOnlyValue(value) {
  if (value instanceof Date) {
    return normalizeDateOnlyInTimezone(normalizeToUtcIso(value, 'UTC'), 'UTC')
  }
  return textValue(value).slice(0, 10)
}

function nextDate(date) {
  const normalized = dateOnlyValue(date)
  if (!normalized || normalized === RANGE_ORIGIN) return RANGE_ORIGIN
  const result = DateTime.fromISO(normalized, { zone: 'UTC' }).plus({ days: 1 }).toISODate()
  if (!result) throw new Error(`Fecha fuera de rango en el rollup de Analíticas: ${normalized}`)
  return result
}

function maxDate(...dates) {
  return dates.filter(Boolean).sort().at(-1) || null
}

function addPoint(points, keyParts, row, delta) {
  if (!delta) return
  const key = JSON.stringify(keyParts)
  const current = points.get(key)
  if (current) {
    current.range_delta += delta
    if (current.range_delta === 0) points.delete(key)
    return
  }
  points.set(key, { ...row, range_delta: delta })
}

/**
 * Para cada identidad, una aparición en d con aparición previa p representa
 * todos los rangos donde d es la primera aparición incluida:
 *   start in [p + 1, d] && end >= d.
 * Dos puntos de diferencia bastan para conservar el COUNT DISTINCT exacto.
 */
export function compileIdentityRangePoints(dates, entityType, target = new Map()) {
  const ordered = [...new Set([...(dates || [])].map(dateOnlyValue).filter(Boolean))].sort()
  let previous = null
  for (const occurrenceDate of ordered) {
    const startBoundary = previous ? nextDate(previous) : RANGE_ORIGIN
    addPoint(target, [entityType, startBoundary, occurrenceDate], {
      entity_type: entityType,
      start_boundary: startBoundary,
      occurrence_date: occurrenceDate
    }, 1)
    const afterOccurrence = nextDate(occurrenceDate)
    addPoint(target, [entityType, afterOccurrence, occurrenceDate], {
      entity_type: entityType,
      start_boundary: afterOccurrence,
      occurrence_date: occurrenceDate
    }, -1)
    previous = occurrenceDate
  }
  return target
}

function heapPush(heap, value) {
  heap.push(value)
  let index = heap.length - 1
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2)
    if (heap[parent].rank >= heap[index].rank) break
    ;[heap[parent], heap[index]] = [heap[index], heap[parent]]
    index = parent
  }
}

function heapPop(heap) {
  if (!heap.length) return null
  const first = heap[0]
  const last = heap.pop()
  if (heap.length && last) {
    heap[0] = last
    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let largest = index
      if (left < heap.length && heap[left].rank > heap[largest].rank) largest = left
      if (right < heap.length && heap[right].rank > heap[largest].rank) largest = right
      if (largest === index) break
      ;[heap[index], heap[largest]] = [heap[largest], heap[index]]
      index = largest
    }
  }
  return first
}

function latestOtherSessions(heap, latestBySession, excludedSession, limit = 2) {
  const removed = []
  const result = []
  while (heap.length && result.length < limit) {
    const candidate = heapPop(heap)
    if (!candidate) break
    removed.push(candidate)
    const latest = latestBySession.get(candidate.session_key)
    if (!latest || latest.rank !== candidate.rank) continue
    if (candidate.session_key === excludedSession) continue
    result.push(candidate)
  }
  for (const candidate of removed) heapPush(heap, candidate)
  return result
}

/**
 * Cuenta visitantes con dos session_key distintos, incluso cuando ocurren el
 * mismo día. Para cada start existe un único segundo session witness; sus
 * intervalos son disjuntos, por lo que el grid nunca duplica al visitante.
 */
export function compileReturningRangePoints(sessionDays, target = new Map()) {
  const ordered = [...new Map((sessionDays || [])
    .map(row => {
      const businessDate = dateOnlyValue(row.business_date)
      const sessionKey = textValue(row.session_key)
      return [`${businessDate}\u0000${sessionKey}`, { business_date: businessDate, session_key: sessionKey }]
    })
    .filter(([, row]) => row.business_date && row.session_key)).values()]
    .sort((left, right) => (
      left.business_date.localeCompare(right.business_date) || left.session_key.localeCompare(right.session_key)
    ))

  const latestBySession = new Map()
  const heap = []
  let rank = 0
  for (const row of ordered) {
    rank += 1
    const previousSame = latestBySession.get(row.session_key) || null
    const [latestOther, secondLatestOther] = latestOtherSessions(
      heap,
      latestBySession,
      row.session_key,
      2
    )
    if (latestOther) {
      const lowerAnchor = maxDate(previousSame?.business_date, secondLatestOther?.business_date)
      const startBoundary = lowerAnchor ? nextDate(lowerAnchor) : RANGE_ORIGIN
      const endBoundary = latestOther.business_date
      if (startBoundary <= endBoundary) {
        addPoint(target, ['returning', startBoundary, row.business_date], {
          entity_type: 'returning',
          start_boundary: startBoundary,
          occurrence_date: row.business_date
        }, 1)
        const afterEndBoundary = nextDate(endBoundary)
        addPoint(target, ['returning', afterEndBoundary, row.business_date], {
          entity_type: 'returning',
          start_boundary: afterEndBoundary,
          occurrence_date: row.business_date
        }, -1)
      }
    }
    const current = { ...row, rank }
    latestBySession.set(row.session_key, current)
    heapPush(heap, current)
  }
  return target
}

function compileFacetRangePoints(dates, facetType, facetValue, target) {
  const temporary = compileIdentityRangePoints(dates, 'facet')
  for (const point of temporary.values()) {
    addPoint(target, [facetType, facetValue, point.start_boundary, point.occurrence_date], {
      facet_type: facetType,
      facet_value: facetValue,
      start_boundary: point.start_boundary,
      occurrence_date: point.occurrence_date
    }, point.range_delta)
  }
}

function diffPointMaps(before, after) {
  const result = new Map()
  for (const [key, row] of before.entries()) result.set(key, { ...row, range_delta: -row.range_delta })
  for (const [key, row] of after.entries()) {
    const current = result.get(key)
    if (!current) result.set(key, { ...row })
    else {
      current.range_delta += row.range_delta
      if (current.range_delta === 0) result.delete(key)
    }
  }
  return result
}

async function bulkInsert(transaction, table, columns, rows, conflictSql) {
  if (!rows.length) return
  const chunkSize = Math.max(1, Math.floor(parameterBudget() / columns.length))
  for (const batch of chunks(rows, chunkSize)) {
    const placeholders = batch.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')
    await transaction.run(`
      INSERT INTO ${table} (${columns.join(', ')})
      VALUES ${placeholders}
      ${conflictSql}
    `, batch.flatMap(row => columns.map(column => row[column])))
  }
}

async function deleteZeroCorePoints(transaction, rows) {
  const perBatch = Math.max(1, Math.floor(parameterBudget() / 3))
  for (const batch of chunks(rows, perBatch)) {
    await transaction.run(`
      DELETE FROM tracking_analytics_range_delta
      WHERE range_delta = 0 AND (${batch.map(() => `(
        entity_type = ? AND start_boundary = ? AND occurrence_date = ?
      )`).join(' OR ')})
    `, batch.flatMap(row => [row.entity_type, row.start_boundary, row.occurrence_date]))
  }
}

async function ensureFacetValueIds(transaction, rows) {
  const values = new Map()
  for (const row of rows) {
    const key = JSON.stringify([row.facet_type, row.facet_value])
    values.set(key, { facet_type: row.facet_type, facet_value: row.facet_value })
  }
  const uniqueValues = [...values.values()]
  await bulkInsert(
    transaction,
    'tracking_analytics_facet_values',
    ['facet_type', 'facet_value'],
    uniqueValues,
    'ON CONFLICT(facet_type, facet_value) DO NOTHING'
  )

  const ids = new Map()
  const perBatch = Math.max(1, Math.floor(parameterBudget() / 2))
  for (const batch of chunks(uniqueValues, perBatch)) {
    const found = await transaction.all(`
      SELECT facet_value_id, facet_type, facet_value
      FROM tracking_analytics_facet_values
      WHERE ${batch.map(() => '(facet_type = ? AND facet_value = ?)').join(' OR ')}
    `, batch.flatMap(row => [row.facet_type, row.facet_value]))
    for (const row of found) {
      ids.set(JSON.stringify([row.facet_type, row.facet_value]), Number(row.facet_value_id))
    }
  }
  return ids
}

async function deleteZeroFacetPoints(transaction, rows) {
  const perBatch = Math.max(1, Math.floor(parameterBudget() / 3))
  for (const batch of chunks(rows, perBatch)) {
    await transaction.run(`
      DELETE FROM tracking_analytics_facet_range_delta
      WHERE range_delta = 0 AND (${batch.map(() => `(
        facet_value_id = ? AND start_boundary = ? AND occurrence_date = ?
      )`).join(' OR ')})
    `, batch.flatMap(row => [row.facet_value_id, row.start_boundary, row.occurrence_date]))
  }
}

async function applyCorePointDiff(transaction, points) {
  const rows = [...points.values()].filter(row => row.range_delta !== 0)
  await bulkInsert(
    transaction,
    'tracking_analytics_range_delta',
    ['entity_type', 'start_boundary', 'occurrence_date', 'range_delta'],
    rows,
    `ON CONFLICT(entity_type, start_boundary, occurrence_date) DO UPDATE SET
      range_delta = tracking_analytics_range_delta.range_delta + excluded.range_delta,
      updated_at = CURRENT_TIMESTAMP`
  )
  await deleteZeroCorePoints(transaction, rows)
}

async function applyFacetPointDiff(transaction, points) {
  const sourceRows = [...points.values()].filter(row => row.range_delta !== 0)
  if (!sourceRows.length) return
  const valueIds = await ensureFacetValueIds(transaction, sourceRows)
  const rows = sourceRows.map(row => ({
    facet_value_id: valueIds.get(JSON.stringify([row.facet_type, row.facet_value])),
    start_boundary: row.start_boundary,
    occurrence_date: row.occurrence_date,
    range_delta: row.range_delta
  }))
  if (rows.some(row => !Number.isFinite(row.facet_value_id))) {
    throw new Error('El rollup de Analíticas no pudo resolver un valor de distribución')
  }
  await bulkInsert(
    transaction,
    'tracking_analytics_facet_range_delta',
    ['facet_value_id', 'start_boundary', 'occurrence_date', 'range_delta'],
    rows,
    `ON CONFLICT(facet_value_id, start_boundary, occurrence_date) DO UPDATE SET
      range_delta = tracking_analytics_facet_range_delta.range_delta + excluded.range_delta,
      updated_at = CURRENT_TIMESTAMP`
  )
  await deleteZeroFacetPoints(transaction, rows)
}

async function applyDailyPageViewDeltas(transaction, presenceRows) {
  const byDate = new Map()
  for (const row of presenceRows || []) {
    const businessDate = dateOnlyValue(row.business_date)
    const delta = Number(row.view_count || 0)
    if (!businessDate || !delta) continue
    const current = byDate.get(businessDate) || { page_views: 0, anonymous_views: 0 }
    current.page_views += delta
    if (!textValue(row.contact_key)) current.anonymous_views += delta
    byDate.set(businessDate, current)
  }
  const rows = [...byDate.entries()]
    .filter(([, counters]) => counters.page_views !== 0 || counters.anonymous_views !== 0)
    .map(([businessDate, counters]) => ({ business_date: businessDate, ...counters }))
  await bulkInsert(
    transaction,
    'tracking_analytics_daily_rollup',
    ['business_date', 'page_views', 'anonymous_views'],
    rows,
    `ON CONFLICT(business_date) DO UPDATE SET
      page_views = tracking_analytics_daily_rollup.page_views + excluded.page_views,
      anonymous_views = tracking_analytics_daily_rollup.anonymous_views + excluded.anonymous_views,
      updated_at = CURRENT_TIMESTAMP`
  )
  if (rows.length) {
    await transaction.run(`
      DELETE FROM tracking_analytics_daily_rollup
      WHERE page_views = 0 AND anonymous_views = 0
        AND business_date IN (${rows.map(() => '?').join(', ')})
    `, rows.map(row => row.business_date))
    const invalid = await transaction.get(`
      SELECT business_date, page_views, anonymous_views
      FROM tracking_analytics_daily_rollup
      WHERE page_views < 0 OR anonymous_views < 0 OR anonymous_views > page_views
      LIMIT 1
    `)
    if (invalid) throw new Error(`Rollup diario negativo en ${dateOnlyValue(invalid.business_date)}`)
  }
}

function addCounterDelta(target, keyParts, row, delta) {
  if (!delta) return
  const key = JSON.stringify(keyParts)
  const current = target.get(key)
  if (current) {
    current.ref_delta += delta
    if (current.ref_delta === 0) target.delete(key)
    return
  }
  target.set(key, { ...row, ref_delta: delta })
}

function addIdentityOccurrence(points, entityType, occurrenceDate, previousDate, multiplier) {
  if (!occurrenceDate || !multiplier) return
  const startBoundary = previousDate ? nextDate(previousDate) : RANGE_ORIGIN
  addPoint(points, [entityType, startBoundary, occurrenceDate], {
    entity_type: entityType,
    start_boundary: startBoundary,
    occurrence_date: occurrenceDate
  }, multiplier)
  const afterOccurrence = nextDate(occurrenceDate)
  addPoint(points, [entityType, afterOccurrence, occurrenceDate], {
    entity_type: entityType,
    start_boundary: afterOccurrence,
    occurrence_date: occurrenceDate
  }, -multiplier)
}

function addFacetOccurrence(points, facetType, facetValue, occurrenceDate, previousDate, multiplier) {
  if (!occurrenceDate || !multiplier) return
  const startBoundary = previousDate ? nextDate(previousDate) : RANGE_ORIGIN
  addPoint(points, [facetType, facetValue, startBoundary, occurrenceDate], {
    facet_type: facetType,
    facet_value: facetValue,
    start_boundary: startBoundary,
    occurrence_date: occurrenceDate
  }, multiplier)
  const afterOccurrence = nextDate(occurrenceDate)
  addPoint(points, [facetType, facetValue, afterOccurrence, occurrenceDate], {
    facet_type: facetType,
    facet_value: facetValue,
    start_boundary: afterOccurrence,
    occurrence_date: occurrenceDate
  }, -multiplier)
}

async function applyIdentityDayDeltas(transaction, deltas, corePoints) {
  const ordered = [...deltas.values()].sort((left, right) => (
    left.entity_type.localeCompare(right.entity_type) ||
    left.identity_key.localeCompare(right.identity_key) ||
    left.business_date.localeCompare(right.business_date)
  ))
  for (const row of ordered) {
    const current = await transaction.get(`
      SELECT ref_count
      FROM tracking_analytics_identity_day
      WHERE entity_type = ? AND identity_key = ? AND business_date = ?
    `, [row.entity_type, row.identity_key, row.business_date])
    const before = Number(current?.ref_count || 0)
    const after = before + Number(row.ref_delta || 0)
    if (after < 0) throw new Error(`Membresia negativa ${row.entity_type}/${row.identity_key}/${row.business_date}`)
    if (before > 0 && after > 0) {
      await transaction.run(`
        UPDATE tracking_analytics_identity_day
        SET ref_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE entity_type = ? AND identity_key = ? AND business_date = ?
      `, [after, row.entity_type, row.identity_key, row.business_date])
      continue
    }
    if (before === 0 && after === 0) continue

    const [previous, successor] = await Promise.all([
      transaction.get(`
        SELECT business_date
        FROM tracking_analytics_identity_day
        WHERE entity_type = ? AND identity_key = ? AND business_date < ?
        ORDER BY business_date DESC LIMIT 1
      `, [row.entity_type, row.identity_key, row.business_date]),
      transaction.get(`
        SELECT business_date
        FROM tracking_analytics_identity_day
        WHERE entity_type = ? AND identity_key = ? AND business_date > ?
        ORDER BY business_date ASC LIMIT 1
      `, [row.entity_type, row.identity_key, row.business_date])
    ])
    const previousDate = dateOnlyValue(previous?.business_date)
    const successorDate = dateOnlyValue(successor?.business_date)
    if (before === 0) {
      if (successorDate) addIdentityOccurrence(corePoints, row.entity_type, successorDate, previousDate, -1)
      addIdentityOccurrence(corePoints, row.entity_type, row.business_date, previousDate, 1)
      if (successorDate) addIdentityOccurrence(corePoints, row.entity_type, successorDate, row.business_date, 1)
      await transaction.run(`
        INSERT INTO tracking_analytics_identity_day(
          entity_type, identity_key, business_date, ref_count, updated_at
        ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [row.entity_type, row.identity_key, row.business_date, after])
    } else {
      addIdentityOccurrence(corePoints, row.entity_type, row.business_date, previousDate, -1)
      if (successorDate) {
        addIdentityOccurrence(corePoints, row.entity_type, successorDate, row.business_date, -1)
        addIdentityOccurrence(corePoints, row.entity_type, successorDate, previousDate, 1)
      }
      await transaction.run(`
        DELETE FROM tracking_analytics_identity_day
        WHERE entity_type = ? AND identity_key = ? AND business_date = ?
      `, [row.entity_type, row.identity_key, row.business_date])
    }
  }
}

async function applyFacetDayDeltas(transaction, deltas, facetPoints) {
  const ordered = [...deltas.values()].sort((left, right) => (
    left.facet_type.localeCompare(right.facet_type) ||
    left.facet_value.localeCompare(right.facet_value) ||
    left.visitor_key.localeCompare(right.visitor_key) ||
    left.business_date.localeCompare(right.business_date)
  ))
  for (const row of ordered) {
    const keyParams = [row.facet_type, row.facet_value, row.visitor_key, row.business_date]
    const current = await transaction.get(`
      SELECT ref_count
      FROM tracking_analytics_facet_identity_day
      WHERE facet_type = ? AND facet_value = ? AND visitor_key = ? AND business_date = ?
    `, keyParams)
    const before = Number(current?.ref_count || 0)
    const after = before + Number(row.ref_delta || 0)
    if (after < 0) throw new Error(`Membresia negativa de faceta ${row.facet_type}/${row.facet_value}`)
    if (before > 0 && after > 0) {
      await transaction.run(`
        UPDATE tracking_analytics_facet_identity_day
        SET ref_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE facet_type = ? AND facet_value = ? AND visitor_key = ? AND business_date = ?
      `, [after, ...keyParams])
      continue
    }
    if (before === 0 && after === 0) continue

    const neighborParams = [row.facet_type, row.facet_value, row.visitor_key, row.business_date]
    const [previous, successor] = await Promise.all([
      transaction.get(`
        SELECT business_date
        FROM tracking_analytics_facet_identity_day
        WHERE facet_type = ? AND facet_value = ? AND visitor_key = ? AND business_date < ?
        ORDER BY business_date DESC LIMIT 1
      `, neighborParams),
      transaction.get(`
        SELECT business_date
        FROM tracking_analytics_facet_identity_day
        WHERE facet_type = ? AND facet_value = ? AND visitor_key = ? AND business_date > ?
        ORDER BY business_date ASC LIMIT 1
      `, neighborParams)
    ])
    const previousDate = dateOnlyValue(previous?.business_date)
    const successorDate = dateOnlyValue(successor?.business_date)
    if (before === 0) {
      if (successorDate) addFacetOccurrence(facetPoints, row.facet_type, row.facet_value, successorDate, previousDate, -1)
      addFacetOccurrence(facetPoints, row.facet_type, row.facet_value, row.business_date, previousDate, 1)
      if (successorDate) addFacetOccurrence(facetPoints, row.facet_type, row.facet_value, successorDate, row.business_date, 1)
      await transaction.run(`
        INSERT INTO tracking_analytics_facet_identity_day(
          facet_type, facet_value, visitor_key, business_date, ref_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [...keyParams, after])
    } else {
      addFacetOccurrence(facetPoints, row.facet_type, row.facet_value, row.business_date, previousDate, -1)
      if (successorDate) {
        addFacetOccurrence(facetPoints, row.facet_type, row.facet_value, successorDate, row.business_date, -1)
        addFacetOccurrence(facetPoints, row.facet_type, row.facet_value, successorDate, previousDate, 1)
      }
      await transaction.run(`
        DELETE FROM tracking_analytics_facet_identity_day
        WHERE facet_type = ? AND facet_value = ? AND visitor_key = ? AND business_date = ?
      `, keyParams)
    }
  }
}

async function readFacetDimensions(transaction, presenceRows) {
  const keys = [...new Set((presenceRows || [])
    .filter(row => Number(row.event_count || 0) !== 0)
    .map(row => textValue(row.dimension_key))
    .filter(Boolean))]
  const result = new Map()
  for (const batch of chunks(keys, parameterBudget())) {
    const rows = await transaction.all(`
      SELECT dimension_key, ${FACET_COLUMNS.join(', ')}
      FROM tracking_analytics_dimensions
      WHERE dimension_key IN (${batch.map(() => '?').join(', ')})
    `, batch)
    for (const row of rows) result.set(textValue(row.dimension_key), row)
  }
  return result
}

function tupleIsAfter(leftDate, leftSession, rightDate, rightSession) {
  if (!rightDate) return true
  return leftDate > rightDate || (leftDate === rightDate && leftSession > rightSession)
}

function addReturningContribution(returningPoints, corePoints, visitorKey, occurrenceDate, context, multiplier = 1) {
  const latestOther = context.latestOther
  if (!latestOther) return
  const lowerAnchor = maxDate(
    dateOnlyValue(context.previousSame),
    dateOnlyValue(context.secondLatestOther?.business_date)
  )
  const startBoundary = lowerAnchor ? nextDate(lowerAnchor) : RANGE_ORIGIN
  const endBoundary = dateOnlyValue(latestOther.business_date)
  if (!endBoundary || startBoundary > endBoundary) return
  const add = (boundary, delta) => {
    addPoint(returningPoints, [visitorKey, boundary, occurrenceDate], {
      visitor_key: visitorKey,
      start_boundary: boundary,
      occurrence_date: occurrenceDate
    }, delta * multiplier)
    addPoint(corePoints, ['returning', boundary, occurrenceDate], {
      entity_type: 'returning',
      start_boundary: boundary,
      occurrence_date: occurrenceDate
    }, delta * multiplier)
  }
  add(startBoundary, 1)
  add(nextDate(endBoundary), -1)
}

async function enqueueReturningDirty(transaction, visitorKey) {
  await transaction.run(`
    INSERT INTO tracking_analytics_returning_dirty_queue(visitor_key, revision, enqueued_at)
    VALUES (?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(visitor_key) DO UPDATE SET
      revision = tracking_analytics_returning_dirty_queue.revision + 1,
      enqueued_at = CURRENT_TIMESTAMP
  `, [visitorKey])
}

async function applyReturningPointDiff(transaction, points) {
  const rows = [...points.values()].filter(row => Number(row.range_delta || 0) !== 0)
  await bulkInsert(
    transaction,
    'tracking_analytics_returning_point',
    ['visitor_key', 'start_boundary', 'occurrence_date', 'range_delta'],
    rows,
    `ON CONFLICT(visitor_key, start_boundary, occurrence_date) DO UPDATE SET
      range_delta = tracking_analytics_returning_point.range_delta + excluded.range_delta,
      updated_at = CURRENT_TIMESTAMP`
  )
  const perBatch = Math.max(1, Math.floor(parameterBudget() / 3))
  for (const batch of chunks(rows, perBatch)) {
    await transaction.run(`
      DELETE FROM tracking_analytics_returning_point
      WHERE range_delta = 0 AND (${batch.map(() => `(
        visitor_key = ? AND start_boundary = ? AND occurrence_date = ?
      )`).join(' OR ')})
    `, batch.flatMap(row => [row.visitor_key, row.start_boundary, row.occurrence_date]))
  }
}

async function applyVisitorSessionDayDeltas(transaction, deltas, returningPoints, corePoints) {
  const ordered = [...deltas.values()].sort((left, right) => (
    left.visitor_key.localeCompare(right.visitor_key) ||
    left.business_date.localeCompare(right.business_date) ||
    left.session_key.localeCompare(right.session_key)
  ))
  for (const row of ordered) {
    const keyParams = [row.visitor_key, row.business_date, row.session_key]
    const current = await transaction.get(`
      SELECT ref_count
      FROM tracking_analytics_visitor_session_day
      WHERE visitor_key = ? AND business_date = ? AND session_key = ?
    `, keyParams)
    const before = Number(current?.ref_count || 0)
    const after = before + Number(row.ref_delta || 0)
    if (after < 0) throw new Error(`Membresia returning negativa ${row.visitor_key}/${row.session_key}`)
    if (before > 0 && after > 0) {
      await transaction.run(`
        UPDATE tracking_analytics_visitor_session_day
        SET ref_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE visitor_key = ? AND business_date = ? AND session_key = ?
      `, [after, ...keyParams])
      continue
    }
    if (before === 0 && after === 0) continue

    if (before === 0) {
      const [tail, previousSame, latestOthers, dirty] = await Promise.all([
        transaction.get(`
          SELECT business_date, session_key
          FROM tracking_analytics_visitor_session_day
          WHERE visitor_key = ?
          ORDER BY business_date DESC, session_key DESC LIMIT 1
        `, [row.visitor_key]),
        transaction.get(`
          SELECT MAX(business_date) AS business_date
          FROM tracking_analytics_visitor_session_day
          WHERE visitor_key = ? AND session_key = ?
        `, [row.visitor_key, row.session_key]),
        transaction.all(`
          SELECT session_key, MAX(business_date) AS business_date
          FROM tracking_analytics_visitor_session_day
          WHERE visitor_key = ? AND session_key != ?
          GROUP BY session_key
          ORDER BY business_date DESC, session_key DESC
          LIMIT 2
        `, [row.visitor_key, row.session_key]),
        transaction.get(`
          SELECT revision FROM tracking_analytics_returning_dirty_queue WHERE visitor_key = ?
        `, [row.visitor_key])
      ])
      await transaction.run(`
        INSERT INTO tracking_analytics_visitor_session_day(
          visitor_key, business_date, session_key, ref_count, updated_at
        ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `, [...keyParams, after])
      const appendOnly = !dirty && tupleIsAfter(
        row.business_date,
        row.session_key,
        dateOnlyValue(tail?.business_date),
        textValue(tail?.session_key)
      )
      if (appendOnly) {
        addReturningContribution(returningPoints, corePoints, row.visitor_key, row.business_date, {
          previousSame: dateOnlyValue(previousSame?.business_date),
          latestOther: latestOthers[0] || null,
          secondLatestOther: latestOthers[1] || null
        })
      } else {
        await enqueueReturningDirty(transaction, row.visitor_key)
      }
    } else {
      await transaction.run(`
        DELETE FROM tracking_analytics_visitor_session_day
        WHERE visitor_key = ? AND business_date = ? AND session_key = ?
      `, keyParams)
      await enqueueReturningDirty(transaction, row.visitor_key)
    }
  }
}

function normalizeReturningPointMap(rows) {
  const points = new Map()
  for (const row of rows || []) {
    const startBoundary = dateOnlyValue(row.start_boundary)
    const occurrenceDate = dateOnlyValue(row.occurrence_date)
    addPoint(points, [startBoundary, occurrenceDate], {
      entity_type: 'returning',
      start_boundary: startBoundary,
      occurrence_date: occurrenceDate
    }, Number(row.range_delta || 0))
  }
  return points
}

async function replaceReturningVisitor(transaction, visitorKey, revision = null) {
  const [oldRows, membershipRows] = await Promise.all([
    transaction.all(`
      SELECT start_boundary, occurrence_date, range_delta
      FROM tracking_analytics_returning_point
      WHERE visitor_key = ?
    `, [visitorKey]),
    transaction.all(`
      SELECT business_date, session_key
      FROM tracking_analytics_visitor_session_day
      WHERE visitor_key = ?
      ORDER BY business_date ASC, session_key ASC
    `, [visitorKey])
  ])
  const before = normalizeReturningPointMap(oldRows)
  const compiled = compileReturningRangePoints(membershipRows)
  const after = normalizeReturningPointMap([...compiled.values()])
  await applyCorePointDiff(transaction, diffPointMaps(before, after))
  await transaction.run('DELETE FROM tracking_analytics_returning_point WHERE visitor_key = ?', [visitorKey])
  const rows = [...after.values()].map(row => ({ ...row, visitor_key: visitorKey }))
  await bulkInsert(
    transaction,
    'tracking_analytics_returning_point',
    ['visitor_key', 'start_boundary', 'occurrence_date', 'range_delta'],
    rows,
    'ON CONFLICT(visitor_key, start_boundary, occurrence_date) DO UPDATE SET range_delta = excluded.range_delta, updated_at = CURRENT_TIMESTAMP'
  )
  if (revision !== null) {
    await transaction.run(`
      DELETE FROM tracking_analytics_returning_dirty_queue
      WHERE visitor_key = ? AND revision = ?
    `, [visitorKey, revision])
  }
  return membershipRows.length
}

export async function repairTrackingAnalyticsReturningVisitors(
  transaction,
  limit = RETURNING_REPAIR_BATCH_SIZE
) {
  const rows = await transaction.all(`
    SELECT visitor_key, revision
    FROM tracking_analytics_returning_dirty_queue
    ORDER BY enqueued_at ASC, visitor_key ASC
    LIMIT ?
  `, [Math.max(1, Number(limit) || RETURNING_REPAIR_BATCH_SIZE)])
  let membershipsRead = 0
  for (const row of rows) {
    membershipsRead += await replaceReturningVisitor(
      transaction,
      textValue(row.visitor_key),
      Number(row.revision || 0)
    )
  }
  const pending = await transaction.get('SELECT visitor_key FROM tracking_analytics_returning_dirty_queue LIMIT 1')
  return { processed: rows.length, membershipsRead, empty: !pending }
}

function facetMembershipSelects() {
  return Object.entries(TRACKING_ANALYTICS_FAST_FACETS).map(([facetType, [column]]) => `
    SELECT '${facetType}' AS facet_type, d.${column} AS facet_value,
      p.visitor_key, p.business_date, SUM(p.event_count) AS ref_count
    FROM tracking_analytics_presence p
    INNER JOIN tracking_analytics_dimensions d ON d.dimension_key = p.dimension_key
    WHERE p.event_count > 0 AND p.visitor_key != '' AND COALESCE(d.${column}, '') != ''
    GROUP BY d.${column}, p.visitor_key, p.business_date
  `).join('\nUNION ALL\n')
}

function compileIdentitySql() {
  const previousPlusOne = databaseDialect === 'postgres'
    ? "COALESCE((previous_date + INTERVAL '1 day')::date, DATE '0001-01-01')"
    : "COALESCE(date(previous_date, '+1 day'), '0001-01-01')"
  const occurrencePlusOne = databaseDialect === 'postgres'
    ? "(business_date + INTERVAL '1 day')::date"
    : "date(business_date, '+1 day')"
  return `
    WITH ordered AS (
      SELECT entity_type, identity_key, business_date,
        LAG(business_date) OVER (
          PARTITION BY entity_type, identity_key ORDER BY business_date
        ) AS previous_date
      FROM tracking_analytics_identity_day
    ), points AS (
      SELECT entity_type, ${previousPlusOne} AS start_boundary,
        business_date AS occurrence_date, 1 AS range_delta
      FROM ordered
      UNION ALL
      SELECT entity_type, ${occurrencePlusOne} AS start_boundary,
        business_date AS occurrence_date, -1 AS range_delta
      FROM ordered
    )
    INSERT INTO tracking_analytics_range_delta(
      entity_type, start_boundary, occurrence_date, range_delta, updated_at
    )
    SELECT entity_type, start_boundary, occurrence_date, SUM(range_delta), CURRENT_TIMESTAMP
    FROM points
    GROUP BY entity_type, start_boundary, occurrence_date
    HAVING SUM(range_delta) != 0
  `
}

function compileFacetSql() {
  const previousPlusOne = databaseDialect === 'postgres'
    ? "COALESCE((previous_date + INTERVAL '1 day')::date, DATE '0001-01-01')"
    : "COALESCE(date(previous_date, '+1 day'), '0001-01-01')"
  const occurrencePlusOne = databaseDialect === 'postgres'
    ? "(business_date + INTERVAL '1 day')::date"
    : "date(business_date, '+1 day')"
  return `
    WITH ordered AS (
      SELECT facet_type, facet_value, visitor_key, business_date,
        LAG(business_date) OVER (
          PARTITION BY facet_type, facet_value, visitor_key ORDER BY business_date
        ) AS previous_date
      FROM tracking_analytics_facet_identity_day
    ), points AS (
      SELECT facet_type, facet_value, ${previousPlusOne} AS start_boundary,
        business_date AS occurrence_date, 1 AS range_delta
      FROM ordered
      UNION ALL
      SELECT facet_type, facet_value, ${occurrencePlusOne} AS start_boundary,
        business_date AS occurrence_date, -1 AS range_delta
      FROM ordered
    )
    INSERT INTO tracking_analytics_facet_range_delta(
      facet_value_id, start_boundary, occurrence_date, range_delta, updated_at
    )
    SELECT values_table.facet_value_id, points.start_boundary, points.occurrence_date,
      SUM(points.range_delta), CURRENT_TIMESTAMP
    FROM points
    INNER JOIN tracking_analytics_facet_values values_table
      ON values_table.facet_type = points.facet_type
     AND values_table.facet_value = points.facet_value
    GROUP BY values_table.facet_value_id, points.start_boundary, points.occurrence_date
    HAVING SUM(points.range_delta) != 0
  `
}

export function trackingAnalyticsIdentityMembershipSql() {
  return `
    INSERT INTO tracking_analytics_identity_day(
      entity_type, identity_key, business_date, ref_count, updated_at
    )
    SELECT 'visitor', visitor_key, business_date, SUM(view_count), CURRENT_TIMESTAMP
    FROM tracking_analytics_presence
    WHERE view_count > 0 AND visitor_key != ''
    GROUP BY visitor_key, business_date
    UNION ALL
    SELECT 'session', session_key, business_date, SUM(view_count), CURRENT_TIMESTAMP
    FROM tracking_analytics_presence
    WHERE view_count > 0 AND session_key != ''
    GROUP BY session_key, business_date
    UNION ALL
    SELECT 'contact', contact_key, business_date, SUM(view_count), CURRENT_TIMESTAMP
    FROM tracking_analytics_presence
    WHERE view_count > 0 AND contact_key != ''
    GROUP BY contact_key, business_date
  `
}

async function prepareRangeCompilation(transaction) {
  await transaction.run('DELETE FROM tracking_analytics_returning_dirty_queue')
  await transaction.run('DELETE FROM tracking_analytics_returning_point')
  await transaction.run('DELETE FROM tracking_analytics_visitor_session_day')
  await transaction.run('DELETE FROM tracking_analytics_facet_identity_day')
  await transaction.run('DELETE FROM tracking_analytics_identity_day')
  await transaction.run('DELETE FROM tracking_analytics_facet_range_delta')
  await transaction.run('DELETE FROM tracking_analytics_facet_values')
  await transaction.run('DELETE FROM tracking_analytics_range_delta')

  await transaction.run(trackingAnalyticsIdentityMembershipSql())
  await transaction.run(`
    INSERT INTO tracking_analytics_facet_identity_day(
      facet_type, facet_value, visitor_key, business_date, ref_count, updated_at
    )
    SELECT facet_type, facet_value, visitor_key, business_date, ref_count, CURRENT_TIMESTAMP
    FROM (${facetMembershipSelects()}) memberships
  `)
  await transaction.run(`
    INSERT INTO tracking_analytics_visitor_session_day(
      visitor_key, business_date, session_key, ref_count, updated_at
    )
    SELECT visitor_key, business_date, session_key, SUM(view_count), CURRENT_TIMESTAMP
    FROM tracking_analytics_presence
    WHERE view_count > 0 AND visitor_key != '' AND session_key != ''
    GROUP BY visitor_key, business_date, session_key
  `)
  await transaction.run(`
    INSERT INTO tracking_analytics_facet_values(facet_type, facet_value)
    SELECT DISTINCT facet_type, facet_value
    FROM tracking_analytics_facet_identity_day
    WHERE 1 = 1
    ON CONFLICT(facet_type, facet_value) DO NOTHING
  `)
  await transaction.run(compileIdentitySql())
  await transaction.run(compileFacetSql())
  await transaction.run(`
    UPDATE tracking_analytics_projection_state_v4
    SET range_status = 'compiling_ranges', range_compile_cursor = NULL,
        range_backfill_complete = ?, status = 'backfilling',
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `, [databaseDialect === 'postgres' ? false : 0])
}

export async function runTrackingAnalyticsRangeCompilationBatch(
  transaction,
  { visitorLimit = RANGE_COMPILE_VISITOR_BATCH_SIZE } = {}
) {
  const state = await transaction.get(`
    SELECT range_status, range_compile_cursor, range_backfill_complete
    FROM tracking_analytics_projection_state_v4
    WHERE singleton_id = 1
  `)
  if (!state) return { unavailable: true, complete: false, processedVisitors: 0 }
  if (state.range_status === 'ready' && (
    state.range_backfill_complete === true || Number(state.range_backfill_complete) === 1
  )) return { complete: true, processedVisitors: 0, published: false }
  if (state.range_status !== 'compiling_ranges') await prepareRangeCompilation(transaction)

  const refreshed = await transaction.get(`
    SELECT range_compile_cursor FROM tracking_analytics_projection_state_v4 WHERE singleton_id = 1
  `)
  const cursor = textValue(refreshed?.range_compile_cursor)
  const visitorRows = await transaction.all(`
    SELECT DISTINCT visitor_key
    FROM tracking_analytics_visitor_session_day
    ${cursor ? 'WHERE visitor_key > ?' : ''}
    ORDER BY visitor_key ASC
    LIMIT ?
  `, cursor ? [cursor, Math.max(1, Number(visitorLimit) || RANGE_COMPILE_VISITOR_BATCH_SIZE)] : [
    Math.max(1, Number(visitorLimit) || RANGE_COMPILE_VISITOR_BATCH_SIZE)
  ])

  for (const row of visitorRows) {
    await replaceReturningVisitor(transaction, textValue(row.visitor_key))
  }
  const lastVisitor = visitorRows.length ? textValue(visitorRows.at(-1).visitor_key) : cursor
  const nextVisitor = lastVisitor
    ? await transaction.get(`
        SELECT visitor_key
        FROM tracking_analytics_visitor_session_day
        WHERE visitor_key > ?
        ORDER BY visitor_key ASC LIMIT 1
      `, [lastVisitor])
    : null
  const complete = !nextVisitor
  await transaction.run(`
    UPDATE tracking_analytics_projection_state_v4
    SET range_compile_cursor = ?,
        range_status = ?,
        range_backfill_complete = ?,
        status = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE singleton_id = 1
  `, [
    lastVisitor || null,
    complete ? 'ready' : 'compiling_ranges',
    databaseDialect === 'postgres' ? complete : (complete ? 1 : 0),
    complete ? 'replaying' : 'backfilling'
  ])
  return {
    complete,
    published: complete,
    processedVisitors: visitorRows.length,
    cursor: lastVisitor || null
  }
}

export async function applyTrackingAnalyticsDailyMutation(transaction, presenceRows) {
  await applyDailyPageViewDeltas(transaction, presenceRows)
}

// Compatibilidad de transición para callers 113 ya cargados: la captura vieja
// recorría todo el historial. Ahora sólo conserva el lote O(1); el trabajo real
// se hace después de aplicar presence mediante las membresías 119.
export async function captureTrackingAnalyticsRangeMutation(_transaction, presenceRows) {
  return { presenceRows: [...(presenceRows || [])] }
}

export async function applyTrackingAnalyticsRangeMutation(
  transaction,
  capturedOrPresenceRows,
  legacyPresenceRows = null
) {
  const presenceRows = legacyPresenceRows || capturedOrPresenceRows?.presenceRows || capturedOrPresenceRows || []
  await applyDailyPageViewDeltas(transaction, presenceRows)
  const identityDeltas = new Map()
  const facetDeltas = new Map()
  const visitorSessionDeltas = new Map()
  const dimensions = await readFacetDimensions(transaction, presenceRows)

  for (const row of presenceRows || []) {
    const businessDate = dateOnlyValue(row.business_date)
    const visitorKey = textValue(row.visitor_key)
    const sessionKey = textValue(row.session_key)
    const contactKey = textValue(row.contact_key)
    const viewDelta = Number(row.view_count || 0)
    const eventDelta = Number(row.event_count || 0)
    if (businessDate && visitorKey && viewDelta) {
      for (const [entityType, identityKey] of [
        ['visitor', visitorKey],
        ...(contactKey ? [['contact', contactKey]] : []),
        ...(sessionKey ? [['session', sessionKey]] : [])
      ]) {
        addCounterDelta(identityDeltas, [entityType, identityKey, businessDate], {
          entity_type: entityType,
          identity_key: identityKey,
          business_date: businessDate
        }, viewDelta)
      }
      if (sessionKey) {
        addCounterDelta(visitorSessionDeltas, [visitorKey, businessDate, sessionKey], {
          visitor_key: visitorKey,
          business_date: businessDate,
          session_key: sessionKey
        }, viewDelta)
      }
    }
    if (businessDate && visitorKey && eventDelta) {
      const dimension = dimensions.get(textValue(row.dimension_key)) || {}
      for (const [facetType, [column]] of Object.entries(TRACKING_ANALYTICS_FAST_FACETS)) {
        const facetValue = textValue(dimension[column])
        if (!facetValue) continue
        addCounterDelta(facetDeltas, [facetType, facetValue, visitorKey, businessDate], {
          facet_type: facetType,
          facet_value: facetValue,
          visitor_key: visitorKey,
          business_date: businessDate
        }, eventDelta)
      }
    }
  }

  const corePoints = new Map()
  const facetPoints = new Map()
  const returningPoints = new Map()
  await applyIdentityDayDeltas(transaction, identityDeltas, corePoints)
  await applyFacetDayDeltas(transaction, facetDeltas, facetPoints)
  await applyVisitorSessionDayDeltas(transaction, visitorSessionDeltas, returningPoints, corePoints)
  await applyReturningPointDiff(transaction, returningPoints)
  await applyCorePointDiff(transaction, corePoints)
  await applyFacetPointDiff(transaction, facetPoints)
  return {
    identityMemberships: identityDeltas.size,
    facetMemberships: facetDeltas.size,
    returningMemberships: visitorSessionDeltas.size
  }
}

export const TRACKING_ANALYTICS_RANGE_ROLLUP_LIMITS = Object.freeze({
  rangeOrigin: RANGE_ORIGIN,
  fastFacets: Object.keys(TRACKING_ANALYTICS_FAST_FACETS),
  storesPerIdentityMembership: true,
  exactDistinctCounts: true,
  hotIdentityNeighborUpdates: true,
  returningAppendFastPath: true,
  returningRepairBatchSize: RETURNING_REPAIR_BATCH_SIZE,
  rangeCompileVisitorBatchSize: RANGE_COMPILE_VISITOR_BATCH_SIZE
})
