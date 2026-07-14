import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseDialect, db } from '../src/config/database.js'
import {
  createAutomation,
  deleteAutomation,
  recordAutomationWebhookSample,
  setAutomationWebhookSampleAfterLockHookForTest,
  updateAutomation
} from '../src/services/automationsService.js'
import { handleAutomationEvent, handleIncomingMessage } from '../src/services/automationEngine.js'
import {
  AUTOMATION_STOP_ON_RESPONSE_EVENT_TYPE,
  AUTOMATION_TRIGGER_INDEX_VERSION,
  AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE,
  deriveAutomationTriggerIndexEntries,
  eventTypesForAutomationTrigger,
  getAutomationTriggerIndexState,
  listDraftAutomationRowsForWebhookEndpoint,
  listPublishedAutomationRowsForEvent,
  runAutomationTriggerIndexBootstrap,
  scheduleAutomationTriggerIndexBootstrap
} from '../src/services/automationTriggerIndexService.js'

const migrationUrl = new URL(
  databaseDialect === 'postgres'
    ? '../migrations/versioned/090a_automation_trigger_index.postgres.sql'
    : '../migrations/versioned/090_automation_trigger_index.sqlite.sql',
  import.meta.url
)

function makeFlow(triggers, { stopOnContactResponse = false } = {}) {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 120, y: 220 },
        config: { triggers }
      },
      {
        id: 'wait',
        type: 'logic-wait',
        label: 'Esperar',
        position: { x: 520, y: 220 },
        config: { mode: 'duration', amount: 1, unit: 'minutes' }
      }
    ],
    edges: [
      {
        id: 'edge-start-wait',
        sourceNodeId: 'start',
        sourceHandle: 'out',
        targetNodeId: 'wait',
        targetHandle: 'in'
      }
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { stopOnContactResponse }
  }
}

function trigger(id, type, config = {}) {
  return { id, type, config }
}

test.before(async () => {
  await db.exec(await readFile(migrationUrl, 'utf8'))
})

test('deriva todos los eventos equivalentes, deduplica y nunca indexa un webhook comodín', () => {
  for (const triggerType of [
    'trigger-whatsapp-message',
    'trigger-click-to-whatsapp',
    'trigger-instagram-message',
    'trigger-messenger-message',
    'trigger-facebook-comment',
    'trigger-instagram-comment',
    'trigger-email-message',
    'trigger-customer-replied',
    'trigger-contact-created',
    'trigger-contact-updated',
    'trigger-contact-tag',
    'trigger-form-submitted',
    'trigger-scheduler',
    'trigger-appointment-booked',
    'trigger-appointment-status',
    'trigger-payment-received',
    'trigger-refund',
    'trigger-incoming-webhook',
    'trigger-activation-link',
    'trigger-link-clicked'
  ]) {
    assert.ok(eventTypesForAutomationTrigger(triggerType).length > 0, `${triggerType} no tiene evento indexado`)
  }

  const publishedFlow = makeFlow([
    trigger('contact-change', 'trigger-contact-updated'),
    trigger('payment', 'trigger-payment-received'),
    trigger('webhook-a', 'trigger-incoming-webhook', { endpointId: 'endpoint-exacto' }),
    trigger('webhook-empty', 'trigger-incoming-webhook', { endpointId: '' }),
    trigger('message-a', 'trigger-whatsapp-message'),
    trigger('message-b', 'trigger-customer-replied')
  ], { stopOnContactResponse: true })
  const draftFlow = makeFlow([
    trigger('draft-webhook', 'trigger-incoming-webhook', { endpointId: 'endpoint-borrador' })
  ])

  const entries = deriveAutomationTriggerIndexEntries({
    status: 'published',
    flow: draftFlow,
    published_flow: publishedFlow
  })
  const keys = new Set(entries.map((entry) => `${entry.eventType}:${entry.endpointId}`))

  for (const eventType of [
    'contact-updated',
    'tag-changed',
    'appointment-booked',
    'appointment-status',
    'payment-received',
    'refund',
    'message-received'
  ]) {
    assert.ok(keys.has(`${eventType}:`), `falta ${eventType}`)
  }
  assert.ok(keys.has('webhook-received:endpoint-exacto'))
  assert.ok(keys.has(`${AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE}:endpoint-borrador`))
  assert.ok(keys.has(`${AUTOMATION_STOP_ON_RESPONSE_EVENT_TYPE}:`))
  assert.equal(keys.has('webhook-received:'), false)
  assert.equal(entries.filter((entry) => entry.eventType === 'message-received').length, 1)
})

test('publish, edición de borrador, pause, republish y delete mantienen el índice atómicamente', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const firstEndpoint = `webhook_live_${suffix}`
  const nextEndpoint = `webhook_next_${suffix}`
  const initialFlow = makeFlow([
    trigger('created', 'trigger-contact-created'),
    trigger('incoming', 'trigger-incoming-webhook', {
      endpointId: firstEndpoint,
      sampleResponse: { customer: { email: 'real@example.com' } }
    })
  ])
  const automation = await createAutomation({
    name: `Índice lifecycle ${suffix}`,
    flow: initialFlow
  })

  try {
    let rows = await db.all(
      'SELECT event_type, endpoint_id FROM automation_trigger_index WHERE automation_id = ? ORDER BY event_type, endpoint_id',
      [automation.id]
    )
    assert.deepEqual(rows, [{ event_type: AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE, endpoint_id: firstEndpoint }])

    await updateAutomation(automation.id, { status: 'published' })
    rows = await db.all(
      'SELECT event_type, endpoint_id FROM automation_trigger_index WHERE automation_id = ?',
      [automation.id]
    )
    assert.ok(rows.some((row) => row.event_type === 'contact-created'))
    assert.ok(rows.some((row) => row.event_type === 'webhook-received' && row.endpoint_id === firstEndpoint))

    const nextDraft = makeFlow([
      trigger('incoming-next', 'trigger-incoming-webhook', {
        endpointId: nextEndpoint,
        sampleResponse: { customer: { email: 'new@example.com' } }
      }),
      trigger('reply', 'trigger-customer-replied')
    ])
    await updateAutomation(automation.id, { flow: nextDraft })
    rows = await db.all(
      'SELECT event_type, endpoint_id FROM automation_trigger_index WHERE automation_id = ?',
      [automation.id]
    )
    assert.ok(rows.some((row) => row.event_type === AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE && row.endpoint_id === nextEndpoint))
    assert.ok(rows.some((row) => row.event_type === 'webhook-received' && row.endpoint_id === firstEndpoint))
    assert.equal(rows.some((row) => row.event_type === 'message-received'), false, 'guardar borrador no cambia el contrato vivo')

    await updateAutomation(automation.id, { status: 'paused' })
    rows = await db.all(
      'SELECT event_type, endpoint_id FROM automation_trigger_index WHERE automation_id = ?',
      [automation.id]
    )
    assert.deepEqual(rows, [{ event_type: AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE, endpoint_id: nextEndpoint }])

    await updateAutomation(automation.id, { status: 'published' })
    rows = await db.all(
      'SELECT event_type, endpoint_id FROM automation_trigger_index WHERE automation_id = ?',
      [automation.id]
    )
    assert.ok(rows.some((row) => row.event_type === 'webhook-received' && row.endpoint_id === nextEndpoint))
    assert.ok(rows.some((row) => row.event_type === 'message-received'))

    const sampleCandidates = await listDraftAutomationRowsForWebhookEndpoint(nextEndpoint)
    assert.equal(sampleCandidates.rows.some((row) => row.id === automation.id), true)

    await deleteAutomation(automation.id)
    const remaining = await db.get(
      'SELECT COUNT(*) AS total FROM automation_trigger_index WHERE automation_id = ?',
      [automation.id]
    )
    assert.equal(Number(remaining.total), 0)
  } finally {
    await db.run('DELETE FROM automation_trigger_index WHERE automation_id = ?', [automation.id]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id = ?', [automation.id]).catch(() => undefined)
  }
})

test('guardar un endpoint mientras llega su muestra no puede separar flow e índice', async () => {
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const oldEndpoint = `webhook_race_old_${suffix}`
  const nextEndpoint = `webhook_race_next_${suffix}`
  const oldFlow = makeFlow([
    trigger('incoming-old', 'trigger-incoming-webhook', { endpointId: oldEndpoint })
  ])
  const nextFlow = makeFlow([
    trigger('incoming-next', 'trigger-incoming-webhook', { endpointId: nextEndpoint })
  ])
  const automation = await createAutomation({ name: `Webhook race ${suffix}`, flow: oldFlow })
  let releaseSample
  let sampleLocked

  try {
    await runAutomationTriggerIndexBootstrap({ force: true, yieldBetweenBatches: false })
    const locked = new Promise((resolve) => { sampleLocked = resolve })
    const release = new Promise((resolve) => { releaseSample = resolve })
    setAutomationWebhookSampleAfterLockHookForTest(async ({ automationId }) => {
      if (automationId !== automation.id) return
      sampleLocked()
      await release
    })

    const samplePromise = recordAutomationWebhookSample({
      endpointId: oldEndpoint,
      method: 'POST',
      body: { customer: { email: 'race@example.com' } },
      query: {}
    })
    await locked

    const savePromise = updateAutomation(automation.id, { flow: nextFlow })
    await new Promise((resolve) => setImmediate(resolve))
    releaseSample()
    await Promise.all([samplePromise, savePromise])

    const row = await db.get('SELECT flow FROM automations WHERE id = ?', [automation.id])
    const savedFlow = typeof row.flow === 'string' ? JSON.parse(row.flow) : row.flow
    const savedTrigger = savedFlow.nodes
      .find((node) => node.type === 'start')
      ?.config?.triggers?.[0]
    assert.equal(savedTrigger?.config?.endpointId, nextEndpoint)

    const indexRows = await db.all(
      `SELECT event_type, endpoint_id
       FROM automation_trigger_index
       WHERE automation_id = ?`,
      [automation.id]
    )
    assert.deepEqual(indexRows, [
      { event_type: AUTOMATION_WEBHOOK_SAMPLE_EVENT_TYPE, endpoint_id: nextEndpoint }
    ])
  } finally {
    setAutomationWebhookSampleAfterLockHookForTest(null)
    releaseSample?.()
    await db.run('DELETE FROM automations WHERE id = ?', [automation.id]).catch(() => undefined)
  }
})

test('un index_version viejo fuerza rebuild completo antes de volver a ready', async () => {
  const marker = `automation_index_upgrade_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const flow = JSON.stringify(makeFlow([
    trigger('created', 'trigger-contact-created')
  ]))

  try {
    await db.run(
      `INSERT INTO automations (
         id, name, status, flow, published_flow, created_at, updated_at, published_at
       ) VALUES (?, ?, 'published', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [marker, 'Upgrade index', flow, flow]
    )
    await db.run(
      `INSERT INTO automation_trigger_index (automation_id, event_type, endpoint_id)
       VALUES (?, 'obsolete-event', '')
       ON CONFLICT (automation_id, event_type, endpoint_id) DO NOTHING`,
      [marker]
    )
    await db.run(
      `UPDATE automation_trigger_index_state
       SET status = 'ready', index_version = 0,
           cursor_automation_id = 'zzzz', indexed_automations = 999
       WHERE id = 1`
    )

    const rebuilt = await runAutomationTriggerIndexBootstrap({
      batchSize: 25,
      yieldBetweenBatches: false
    })
    assert.equal(rebuilt.completed, true)
    const state = await getAutomationTriggerIndexState()
    assert.equal(state.status, 'ready')
    assert.equal(state.indexVersion, AUTOMATION_TRIGGER_INDEX_VERSION)

    const rows = await db.all(
      `SELECT event_type, endpoint_id
       FROM automation_trigger_index
       WHERE automation_id = ?`,
      [marker]
    )
    assert.deepEqual(rows, [{ event_type: 'contact-created', endpoint_id: '' }])
  } finally {
    await db.run('DELETE FROM automations WHERE id = ?', [marker]).catch(() => undefined)
  }
})

test('bootstrap batched conserva fallback y convierte miles de grafos en lookup indexado', {
  skip: databaseDialect !== 'sqlite'
}, async () => {
  const marker = `automation_index_scale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const targetEndpoint = `${marker}_endpoint`
  const contactId = `${marker}_contact`
  const rowsToInsert = 3_000
  const schedulerFlow = JSON.stringify(makeFlow([
    trigger('scheduler', 'trigger-scheduler', { recurrence: 'daily' })
  ]))
  const targetFlow = JSON.stringify(makeFlow([
    trigger('created', 'trigger-contact-created'),
    trigger('message', 'trigger-whatsapp-message'),
    trigger('webhook', 'trigger-incoming-webhook', {
      endpointId: targetEndpoint,
      sampleResponse: { ok: true }
    })
  ], { stopOnContactResponse: true }))

  try {
    await db.transaction(async (tx) => {
      for (let offset = 0; offset < rowsToInsert; offset += 100) {
        const batchSize = Math.min(100, rowsToInsert - offset)
        const values = []
        const params = []
        for (let index = 0; index < batchSize; index += 1) {
          const absoluteIndex = offset + index
          const id = `${marker}_${String(absoluteIndex).padStart(5, '0')}`
          const flow = absoluteIndex === rowsToInsert - 1 ? targetFlow : schedulerFlow
          values.push("(?, ?, 'published', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)")
          params.push(id, `Automatización ${absoluteIndex}`, flow, flow)
        }
        await tx.run(
          `INSERT INTO automations (
             id, name, status, flow, published_flow, created_at, updated_at, published_at
           ) VALUES ${values.join(', ')}`,
          params
        )
      }
      await tx.run('DELETE FROM automation_trigger_index')
      await tx.run(
        `UPDATE automation_trigger_index_state
         SET status = 'pending', cursor_automation_id = NULL,
             indexed_automations = 0, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`
      )
    })

    const fallback = await listPublishedAutomationRowsForEvent('contact-created')
    assert.equal(fallback.indexed, false)
    assert.equal(fallback.rows.filter((row) => String(row.id).startsWith(marker)).length, rowsToInsert)

    // Si el test de lifecycle dejó un bootstrap ya tomado, primero esperamos
    // ese candado y luego forzamos una pasada limpia sobre las 3,000 filas.
    await scheduleAutomationTriggerIndexBootstrap()
    const bootstrap = await runAutomationTriggerIndexBootstrap({
      force: true,
      batchSize: 75,
      yieldBetweenBatches: true
    })
    assert.equal(bootstrap.completed, true)
    const state = await getAutomationTriggerIndexState()
    assert.equal(state.status, 'ready')
    assert.ok(state.indexedAutomations >= rowsToInsert)

    const exact = await listPublishedAutomationRowsForEvent('contact-created')
    assert.equal(exact.indexed, true)
    assert.deepEqual(
      exact.rows.filter((row) => String(row.id).startsWith(marker)).map((row) => row.id),
      [`${marker}_${String(rowsToInsert - 1).padStart(5, '0')}`]
    )

    const webhook = await listPublishedAutomationRowsForEvent('webhook-received', {
      endpointId: targetEndpoint
    })
    assert.equal(webhook.indexed, true)
    assert.equal(webhook.rows.filter((row) => String(row.id).startsWith(marker)).length, 1)

    const sampleLookup = await listDraftAutomationRowsForWebhookEndpoint(targetEndpoint)
    assert.equal(sampleLookup.indexed, true)
    assert.equal(sampleLookup.rows.filter((row) => String(row.id).startsWith(marker)).length, 1)

    await db.run(
      `INSERT INTO contacts (id, full_name, first_name, email, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [contactId, 'Contacto índice', 'Contacto', `${contactId}@example.com`]
    )
    await handleAutomationEvent('contact-created', { contactId })
    const enrollmentCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM automation_enrollments
       WHERE automation_id LIKE ? AND contact_id = ?`,
      [`${marker}%`, contactId]
    )
    assert.equal(Number(enrollmentCount.total), 1, 'el motor sólo debe abrir el flujo candidato')

    await handleIncomingMessage({
      contactId,
      text: 'Hola',
      channel: 'whatsapp'
    })
    const enrollmentStatuses = await db.all(
      `SELECT status
       FROM automation_enrollments
       WHERE automation_id LIKE ? AND contact_id = ?
       ORDER BY entered_at, id`,
      [`${marker}%`, contactId]
    )
    assert.deepEqual(
      enrollmentStatuses.map((row) => row.status).sort(),
      ['exited', 'waiting'],
      'el índice debe conservar salida al responder y el trigger del mensaje'
    )

    const plan = await db.all(
      `EXPLAIN QUERY PLAN
       SELECT automation_id
       FROM automation_trigger_index
       WHERE event_type = ? AND endpoint_id = ?
       ORDER BY automation_id`,
      ['contact-created', '']
    )
    assert.match(
      plan.map((row) => row.detail).join('\n'),
      /idx_automation_trigger_event_endpoint_automation/
    )
  } finally {
    await db.run('DELETE FROM automation_enrollments WHERE automation_id LIKE ?', [`${marker}%`]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM automations WHERE id LIKE ?', [`${marker}%`]).catch(() => undefined)
    await db.run('DELETE FROM automation_trigger_index WHERE automation_id LIKE ?', [`${marker}%`]).catch(() => undefined)
  }
})

test('el motor conserva license gate, lookup por evento y webhook exacto', async () => {
  const engine = await readFile(new URL('../src/services/automationEngine.js', import.meta.url), 'utf8')
  const source = engine.slice(
    engine.indexOf('async function listPublishedAutomations'),
    engine.indexOf('async function getPublishedAutomation')
  )
  assert.match(source, /listPublishedAutomationRowsForEvent\(eventType, \{ endpointId \}\)/)
  assert.match(source, /await canRunAutomationFlow\(flow\)/)
  assert.match(engine, /return Boolean\(endpointId\) && endpointId === str\(ctx\.endpointId\)/)
  assert.doesNotMatch(engine, /const automations = await listPublishedAutomations\(\)/)
})
