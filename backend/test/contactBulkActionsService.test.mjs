import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import {
  createAutomationBulkAction,
  createWhatsAppTemplateBulkAction,
  deleteContactBulkAction,
  getContactBulkAction,
  pauseContactBulkAction,
  processDueContactBulkActions,
  rescheduleContactBulkAction
} from '../src/services/contactBulkActionsService.js'

function makeFutureIso(minutes = 30) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

function makeFlow() {
  return {
    nodes: [
      {
        id: 'start',
        type: 'start',
        category: 'trigger',
        label: 'Cuando...',
        position: { x: 100, y: 100 },
        config: {
          triggers: [{ id: 'manual_test', type: 'trigger-manual', config: {} }]
        }
      }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { allowReentry: true, preventDuplicateActiveEnrollment: true }
  }
}

async function insertPublishedAutomation(id, name) {
  const flow = makeFlow()
  await db.run(
    `INSERT INTO automations (id, name, description, status, flow, published_flow, published_at, created_at, updated_at)
     VALUES (?, ?, '', 'published', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, name, JSON.stringify(flow), JSON.stringify(flow)]
  )
}

async function insertContact(id, name, phone) {
  await db.run(
    `INSERT INTO contacts (id, full_name, first_name, phone, email, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'Test', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, name, name.split(' ')[0], phone, `${id}@test.local`]
  )
}

test('createAutomationBulkAction guarda contactos programados con goteo y permite reprogramar', async () => {
  const suffix = Date.now()
  const contactA = `bulk_auto_contact_a_${suffix}`
  const contactB = `bulk_auto_contact_b_${suffix}`
  const contactC = `bulk_auto_contact_c_${suffix}`
  const contacts = [contactA, contactB, contactC]
  let automationId = ''
  let actionId = ''

  await insertContact(contactA, 'Contacto Uno', '+5215511111111')
  await insertContact(contactB, 'Contacto Dos', '+5215522222222')
  await insertContact(contactC, 'Contacto Tres', '+5215533333333')

  try {
    automationId = `bulk_auto_${suffix}`
    await insertPublishedAutomation(automationId, `Automatización lote ${suffix}`)

    const start = makeFutureIso(45)
    const action = await createAutomationBulkAction({
      automationId,
      contactIds: contacts,
      schedule: {
        mode: 'scheduled',
        scheduledAt: start,
        drip: { enabled: true, intervalMinutes: 7 }
      },
      userId: 'test-user'
    })
    actionId = action.id

    const saved = await getContactBulkAction(action.id)
    assert.equal(saved.actionType, 'automation_enrollment')
    assert.equal(saved.totalCount, 3)
    assert.equal(saved.items.length, 3)
    assert.equal(saved.dripEnabled, true)
    assert.equal(saved.dripIntervalMinutes, 7)

    const times = saved.items.map((item) => new Date(item.scheduledAt).getTime())
    assert.equal(times[1] - times[0], 7 * 60 * 1000)
    assert.equal(times[2] - times[1], 7 * 60 * 1000)

    const paused = await pauseContactBulkAction(action.id)
    assert.equal(paused.status, 'paused')

    const rescheduled = await rescheduleContactBulkAction(action.id, {
      schedule: {
        scheduledAt: makeFutureIso(90),
        drip: { enabled: false }
      }
    })
    assert.equal(rescheduled.status, 'scheduled')
    assert.equal(rescheduled.dripEnabled, false)
    assert.equal(new Set(rescheduled.items.map((item) => item.scheduledAt)).size, 1)
  } finally {
    if (actionId) await deleteContactBulkAction(actionId).catch(() => {})
    if (automationId) await db.run('DELETE FROM automations WHERE id = ?', [automationId]).catch(() => {})
    await db.run(`DELETE FROM contacts WHERE id IN (${contacts.map(() => '?').join(', ')})`, contacts).catch(() => {})
  }
})

test('createWhatsAppTemplateBulkAction crea lote programado sin enviar mensajes inmediatos', async () => {
  const suffix = Date.now()
  const contactA = `bulk_wa_contact_a_${suffix}`
  const contactB = `bulk_wa_contact_b_${suffix}`
  const contacts = [contactA, contactB]
  let actionId = ''

  await insertContact(contactA, 'WhatsApp Uno', '+5215544444444')
  await insertContact(contactB, 'WhatsApp Dos', '+5215555555555')

  try {
    const action = await createWhatsAppTemplateBulkAction({
      contactIds: contacts,
      fromPhone: '+5215599999999',
      templateId: `tpl_${suffix}`,
      templateName: 'recordatorio_prueba',
      language: 'es_MX',
      variables: { 1: '{{contact.name}}' },
      schedule: {
        mode: 'scheduled',
        scheduledAt: makeFutureIso(60),
        drip: { enabled: false }
      },
      userId: 'test-user'
    })
    actionId = action.id

    const saved = await getContactBulkAction(action.id)
    assert.equal(saved.actionType, 'whatsapp_template')
    assert.equal(saved.status, 'scheduled')
    assert.equal(saved.totalCount, 2)
    assert.equal(saved.processedCount, 0)
    assert.equal(saved.config.templateName, 'recordatorio_prueba')
    assert.equal(saved.config.fromPhone, '+525599999999')
    assert.equal(new Set(saved.items.map((item) => item.status)).size, 1)
    assert.equal(saved.items[0].status, 'scheduled')
  } finally {
    if (actionId) await deleteContactBulkAction(actionId).catch(() => {})
    await db.run(`DELETE FROM contacts WHERE id IN (${contacts.map(() => '?').join(', ')})`, contacts).catch(() => {})
  }
})

test('processDueContactBulkActions marca items processing viejos como error visible', async () => {
  const suffix = Date.now()
  const actionId = `bulk_stale_${suffix}`
  const itemId = `bulk_stale_item_${suffix}`
  const contactId = `bulk_stale_contact_${suffix}`
  const oldDate = new Date(Date.now() - 12 * 60 * 1000).toISOString()

  await insertContact(contactId, 'Contacto Atorado', '+5215566666666')
  await db.run(
    `INSERT INTO contact_bulk_actions
       (id, action_type, title, status, total_count, processed_count, success_count, error_count,
        scheduled_at, config_json, created_at, updated_at, started_at)
     VALUES (?, 'whatsapp_template', 'Lote interrumpido', 'processing', 1, 0, 0, 0,
        ?, '{}', ?, ?, ?)`,
    [actionId, oldDate, oldDate, oldDate, oldDate]
  )
  await db.run(
    `INSERT INTO contact_bulk_action_items
       (id, bulk_action_id, contact_id, contact_name, scheduled_at, status, created_at, updated_at)
     VALUES (?, ?, ?, 'Contacto Atorado', ?, 'processing', ?, ?)`,
    [itemId, actionId, contactId, oldDate, oldDate, oldDate]
  )

  try {
    const results = await processDueContactBulkActions({ referenceDate: new Date() })
    assert.deepEqual(results, [])

    const saved = await getContactBulkAction(actionId)
    assert.equal(saved.status, 'error')
    assert.equal(saved.processedCount, 1)
    assert.equal(saved.errorCount, 1)
    assert.equal(saved.items[0].status, 'error')
    assert.match(saved.items[0].error, /interrumpida durante una actualización/)
  } finally {
    await deleteContactBulkAction(actionId).catch(() => {})
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => {})
  }
})
