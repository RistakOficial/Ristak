import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { db } from '../src/config/database.js'
import { runVersionedMigrations } from '../src/startup/runMigrations.js'
import {
  cleanupAbandonedAutomationReviewRuns,
  listAutomationReviewProblems,
  rebuildAutomationReviewProjection
} from '../src/services/automationReferenceResolver.js'
import { createAutomationReviewProjectionScheduler } from '../src/jobs/automationReviewProjection.cron.js'

await runVersionedMigrations()

function tagFlow(tagId, tagName) {
  return {
    nodes: [{
      id: 'start',
      type: 'start',
      config: {
        triggers: [{
          id: 'tag-trigger',
          type: 'trigger-contact-tag',
          config: { tag: tagId, tagName }
        }]
      }
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: {}
  }
}

test('la proyección detecta referencias borradas sin escanear grafos desde Header', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const tagId = `tag_projection_${suffix}`
  const automationId = `auto_projection_${suffix}`
  const flow = tagFlow(tagId, 'Etiqueta temporal')

  await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'Etiqueta temporal'])
  await db.run(
    `INSERT INTO automations (
       id, name, description, status, flow, published_flow,
       published_at, created_at, updated_at
     ) VALUES (?, ?, '', 'published', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [automationId, 'Proyección rota', JSON.stringify(flow), JSON.stringify(flow)]
  )

  try {
    const initial = await rebuildAutomationReviewProjection()
    assert.equal(initial.ready, true)
    assert.equal((await listAutomationReviewProblems({ limit: 5 })).length, 0)

    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId])
    const pending = await db.get(
      'SELECT status FROM automation_review_projection_state WHERE singleton = 1'
    )
    assert.equal(pending.status, 'pending')

    const rebuilt = await rebuildAutomationReviewProjection()
    assert.equal(rebuilt.ready, true)
    assert.equal(rebuilt.problems, 1)

    const problems = await listAutomationReviewProblems({ limit: 5 })
    assert.equal(problems.length, 1)
    assert.equal(problems[0].automation.id, automationId)
    assert.equal(problems[0].reviewStatus.state, 'requires_review')
    assert.match(problems[0].reviewStatus.summary, /Etiqueta temporal/)
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId]).catch(() => undefined)
    await rebuildAutomationReviewProjection().catch(() => undefined)
  }
})

test('la lectura de notificaciones consulta sólo la proyección indexada y aplica LIMIT en SQL', async () => {
  const source = await readFile(
    new URL('../src/services/automationReferenceResolver.js', import.meta.url),
    'utf8'
  )
  const reader = source
    .split('export async function listAutomationReviewProblems')[1]
    .split('export const AUTOMATION_REVIEW_OK')[0]

  assert.match(reader, /FROM automation_review_projection/)
  assert.match(reader, /LIMIT \?/)
  assert.doesNotMatch(reader, /FROM automations/)
  assert.doesNotMatch(reader, /published_flow|JSON\.parse|loadAutomationReferenceCatalogs/)
  assert.doesNotMatch(reader, /readAutomationReviewProjectionState|scheduleAutomationReviewProjectionBackfill/)
  assert.doesNotMatch(reader, /automation_review_projection_state/)
})

test('listAutomationReviewProblems es una lectura pura también en runtime', async () => {
  const originalGet = db.get
  const originalRun = db.run
  let getCalls = 0
  let writeCalls = 0

  db.get = (...args) => {
    getCalls += 1
    return originalGet(...args)
  }
  db.run = (...args) => {
    writeCalls += 1
    return originalRun(...args)
  }

  try {
    await listAutomationReviewProblems({ limit: 3 })
  } finally {
    db.get = originalGet
    db.run = originalRun
  }

  assert.equal(getCalls, 0)
  assert.equal(writeCalls, 0)
})

test('el rebuild pagina automations por keyset y nunca excede 100 flows por lote', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const prefix = `auto_review_scale_${suffix}_`
  const flow = JSON.stringify({ nodes: [], edges: [], settings: {} })

  await db.transaction(async (tx) => {
    for (let index = 0; index < 105; index += 1) {
      const id = `${prefix}${String(index).padStart(3, '0')}`
      await tx.run(
        `INSERT INTO automations (
           id, name, description, status, flow, published_flow,
           published_at, created_at, updated_at
         ) VALUES (?, ?, '', 'published', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [id, `Automation ${index}`, flow, flow]
      )
    }
  })

  try {
    const pageSizes = []
    const result = await rebuildAutomationReviewProjection({
      batchSize: 10_000,
      onBatch: ({ rows }) => pageSizes.push(rows)
    })

    assert.equal(result.ready, true)
    assert.ok(result.scanned >= 105)
    assert.ok(pageSizes.length >= 2)
    assert.ok(pageSizes.every((size) => size > 0 && size <= 100))
  } finally {
    await db.run('DELETE FROM automations WHERE id LIKE ?', [`${prefix}%`])
    await rebuildAutomationReviewProjection().catch(() => undefined)
  }
})

test('una revisión concurrente descarta staging y conserva el snapshot publicado anterior', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const tagId = `tag_review_cas_${suffix}`
  const automationId = `auto_review_cas_${suffix}`
  const flow = tagFlow(tagId, 'Etiqueta CAS')

  await db.run(
    `INSERT INTO automations (
       id, name, description, status, flow, published_flow,
       published_at, created_at, updated_at
     ) VALUES (?, 'Snapshot CAS', '', 'published', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [automationId, JSON.stringify(flow), JSON.stringify(flow)]
  )

  try {
    assert.equal((await rebuildAutomationReviewProjection()).ready, true)
    assert.ok(
      (await listAutomationReviewProblems({ limit: 100 }))
        .some((problem) => problem.automation.id === automationId)
    )

    // La referencia vuelve a ser válida, pero el snapshot viejo debe seguir
    // visible mientras el candidato nuevo vive únicamente en staging.
    await db.run('INSERT INTO contact_tags (id, name) VALUES (?, ?)', [tagId, 'Etiqueta CAS'])
    let changedDuringRun = false
    const stale = await rebuildAutomationReviewProjection({
      batchSize: 1,
      onBatch: async () => {
        if (changedDuringRun) return
        changedDuringRun = true
        const visible = await listAutomationReviewProblems({ limit: 100 })
        assert.ok(visible.some((problem) => problem.automation.id === automationId))
        await db.run(
          "UPDATE contact_tags SET name = name || ' actualizada' WHERE id = ?",
          [tagId]
        )
      }
    })

    assert.equal(stale.ready, false)
    assert.equal(stale.stale, true)
    assert.ok(
      (await listAutomationReviewProblems({ limit: 100 }))
        .some((problem) => problem.automation.id === automationId)
    )

    const final = await rebuildAutomationReviewProjection()
    assert.equal(final.ready, true)
    assert.equal(
      (await listAutomationReviewProblems({ limit: 100 }))
        .some((problem) => problem.automation.id === automationId),
      false
    )
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => undefined)
    await db.run('DELETE FROM contact_tags WHERE id = ?', [tagId]).catch(() => undefined)
    await rebuildAutomationReviewProjection().catch(() => undefined)
  }
})

test('el cleanup de staging abandonado está indexado y limitado a 200 filas', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2)}`
  const runToken = `abandoned_${suffix}`
  const liveToken = `live_${suffix}`
  const oldProjectedAt = '2020-01-01T00:00:00.000Z'
  const now = Date.parse('2026-07-14T12:00:00.000Z')

  await db.transaction(async (tx) => {
    for (let index = 0; index < 205; index += 1) {
      await tx.run(
        `INSERT INTO automation_review_projection_staging (
           run_token, automation_id, automation_name, automation_status,
           issue_count, summary, issues_json, projected_at
         ) VALUES (?, ?, 'Vieja', 'published', 1, 'vieja', '[]', ?)`,
        [runToken, `old_${String(index).padStart(3, '0')}`, oldProjectedAt]
      )
    }
    await tx.run(
      `INSERT INTO automation_review_projection_staging (
         run_token, automation_id, automation_name, automation_status,
         issue_count, summary, issues_json, projected_at
       ) VALUES (?, 'live', 'Viva', 'published', 1, 'viva', '[]', ?)`,
      [liveToken, new Date(now).toISOString()]
    )
  })

  try {
    assert.equal(await cleanupAbandonedAutomationReviewRuns({ now, olderThanMs: 60_000, limit: 999 }), 200)
    assert.equal(await cleanupAbandonedAutomationReviewRuns({ now, olderThanMs: 60_000, limit: 999 }), 5)
    const live = await db.get(
      'SELECT automation_id FROM automation_review_projection_staging WHERE run_token = ?',
      [liveToken]
    )
    assert.equal(live.automation_id, 'live')
  } finally {
    await db.run(
      'DELETE FROM automation_review_projection_staging WHERE run_token IN (?, ?)',
      [runToken, liveToken]
    )
  }
})

test('el scheduler detecta pending con una lectura O(1) y sólo encola el worker', async () => {
  let state = { source_revision: 8, projected_revision: 7, status: 'pending' }
  let reads = 0
  let scheduled = 0
  let cleanups = 0
  const scheduler = createAutomationReviewProjectionScheduler({
    readState: async () => {
      reads += 1
      return state
    },
    scheduleWorker: () => {
      scheduled += 1
      return { scheduled: true, state: 'queued' }
    },
    cleanupRuns: async () => {
      cleanups += 1
      return 0
    },
    shuttingDown: () => false,
    now: () => 1_000
  })

  const pending = await scheduler.tick()
  assert.equal(pending.scheduled, true)
  assert.equal(scheduled, 1)
  assert.equal(cleanups, 1)

  state = { source_revision: 8, projected_revision: 8, status: 'ready' }
  const ready = await scheduler.tick()
  assert.equal(ready.pending, false)
  assert.equal(scheduled, 1)
  assert.equal(cleanups, 1)
  assert.equal(reads, 2)
})
