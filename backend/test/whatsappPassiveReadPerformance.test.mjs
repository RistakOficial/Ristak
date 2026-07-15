import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { databaseReady, db } from '../src/config/database.js'
import {
  getWhatsAppApiStatus,
  getWhatsAppApiTemplatesCatalogPage
} from '../src/services/whatsappApiService.js'
import {
  __resetWhatsAppStatusProjectionForTest,
  getWhatsAppStatusProjectionSnapshot
} from '../src/services/whatsappStatusProjectionService.js'
import { listAutomationWhatsAppTemplatesCatalog } from '../src/services/automationsService.js'

const migrationUrl = new URL('../migrations/versioned/102_whatsapp_status_projection.sqlite.sql', import.meta.url)

test.before(async () => {
  await databaseReady
  await db.exec(await readFile(migrationUrl, 'utf8'))
  __resetWhatsAppStatusProjectionForTest()
})

function delta(actual, baseline, field) {
  return Number(actual.stats[field] || 0) - Number(baseline.stats[field] || 0)
}

test('snapshot WhatsApp conserva conteos exactos con inserts, transiciones y deletes sin escanear tablas base', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const ids = {
    phone: `wa_status_phone_${suffix}`,
    apiContact: `wa_status_api_contact_${suffix}`,
    crmContact: `wa_status_crm_contact_${suffix}`,
    message: `wa_status_message_${suffix}`,
    attribution: `wa_status_attribution_${suffix}`,
    event: `wa_status_event_${suffix}`,
    template: `wa_status_template_${suffix}`,
    alert: `wa_status_alert_${suffix}`,
    send: `wa_status_send_${suffix}`,
    routeContingency: `wa_status_route_a_${suffix}`,
    routeManual: `wa_status_route_b_${suffix}`
  }
  const baseline = await getWhatsAppStatusProjectionSnapshot()
  assert.equal(baseline.source, 'projection')

  try {
    await db.run(
      'INSERT INTO contacts (id, full_name, phone, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)',
      [ids.crmContact, 'Projection contact', `+1555${suffix.slice(0, 7)}`]
    )
    await db.run(`
      INSERT INTO whatsapp_api_phone_numbers (id, provider, phone_number, status)
      VALUES (?, 'ycloud', ?, 'CONNECTED')
    `, [ids.phone, `+1666${suffix.slice(0, 7)}`])
    await db.run(`
      INSERT INTO whatsapp_api_contacts (id, contact_id, phone)
      VALUES (?, ?, ?)
    `, [ids.apiContact, ids.crmContact, `+1777${suffix.slice(0, 7)}`])
    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, whatsapp_api_contact_id, contact_id, direction, message_type, message_text
      ) VALUES (?, ?, ?, 'inbound', 'text', 'projection')
    `, [ids.message, ids.apiContact, ids.crmContact])
    await db.run(`
      INSERT INTO whatsapp_api_attribution (id, whatsapp_api_message_id, whatsapp_api_contact_id, contact_id)
      VALUES (?, ?, ?, ?)
    `, [ids.attribution, ids.message, ids.apiContact, ids.crmContact])
    await db.run(`
      INSERT INTO whatsapp_api_webhook_events (id, event_id, event_type)
      VALUES (?, ?, 'projection.test')
    `, [ids.event, ids.event])
    await db.run(`
      INSERT INTO whatsapp_api_templates (
        id, official_template_id, waba_id, name, language, status, components_json, raw_payload_json
      ) VALUES (?, ?, 'waba_projection', ?, 'es_MX', 'APPROVED', '[]', '{}')
    `, [ids.template, ids.template, `projection_${suffix}`])
    await db.run(`
      INSERT INTO whatsapp_api_alerts (id, alert_type, title, severity, status)
      VALUES (?, 'projection', 'Projection', 'critical', 'active')
    `, [ids.alert])
    await db.run(`
      INSERT INTO whatsapp_api_template_sends (id, template_id, template_name, language, status)
      VALUES (?, ?, ?, 'es_MX', 'sent')
    `, [ids.send, ids.template, `projection_${suffix}`])
    await db.run(`
      INSERT INTO whatsapp_routing_events (
        id, contact_id, previous_phone_number_id, new_phone_number_id, source, created_at
      ) VALUES (?, ?, ?, ?, 'contingency', '2098-01-01 00:00:00')
    `, [ids.routeContingency, ids.crmContact, ids.phone, ids.phone])

    const inserted = await getWhatsAppStatusProjectionSnapshot()
    for (const field of [
      'phoneNumbers', 'contacts', 'messages', 'inboundMessages',
      'attributedMessages', 'webhookEvents', 'templates', 'approvedTemplates',
      'activeAlerts', 'criticalAlerts', 'templateSends'
    ]) {
      assert.equal(delta(inserted, baseline, field), 1, field)
    }
    assert.equal(delta(inserted, baseline, 'outboundMessages'), 0)
    assert.equal(inserted.pendingRestoreCounts.get(ids.phone), 1)

    await db.run("UPDATE whatsapp_api_messages SET direction = 'outbound' WHERE id = ?", [ids.message])
    await db.run("UPDATE whatsapp_api_templates SET status = 'REJECTED' WHERE id = ?", [ids.template])
    await db.run("UPDATE whatsapp_api_alerts SET status = 'resolved' WHERE id = ?", [ids.alert])
    await db.run(`
      INSERT INTO whatsapp_routing_events (
        id, contact_id, previous_phone_number_id, new_phone_number_id, source, created_at
      ) VALUES (?, ?, ?, ?, 'manual', '2098-01-02 00:00:00')
    `, [ids.routeManual, ids.crmContact, ids.phone, ids.phone])

    const transitioned = await getWhatsAppStatusProjectionSnapshot()
    assert.equal(delta(transitioned, baseline, 'messages'), 1)
    assert.equal(delta(transitioned, baseline, 'inboundMessages'), 0)
    assert.equal(delta(transitioned, baseline, 'outboundMessages'), 1)
    assert.equal(delta(transitioned, baseline, 'approvedTemplates'), 0)
    assert.equal(delta(transitioned, baseline, 'activeAlerts'), 0)
    assert.equal(delta(transitioned, baseline, 'criticalAlerts'), 0)
    assert.equal(transitioned.pendingRestoreCounts.has(ids.phone), false)

    await db.run('DELETE FROM whatsapp_routing_events WHERE id = ?', [ids.routeManual])
    const restored = await getWhatsAppStatusProjectionSnapshot()
    assert.equal(restored.pendingRestoreCounts.get(ids.phone), 1)

    const originalAll = db.all
    const observedSql = []
    db.all = async (sql, params, options) => {
      observedSql.push(String(sql))
      return originalAll.call(db, sql, params, options)
    }
    try {
      const hot = await getWhatsAppStatusProjectionSnapshot()
      assert.equal(hot.source, 'projection')
    } finally {
      db.all = originalAll
    }
    assert.equal(observedSql.length, 1)
    assert.match(observedSql[0], /whatsapp_status_metric_counters/)
    assert.doesNotMatch(observedSql[0], /COUNT\(\*\).*whatsapp_api_messages/is)
    assert.doesNotMatch(observedSql[0], /GROUP BY\s+contact_id/is)
  } finally {
    await db.run('DELETE FROM whatsapp_routing_events WHERE contact_id = ?', [ids.crmContact]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_template_sends WHERE id = ?', [ids.send]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_alerts WHERE id = ?', [ids.alert]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_attribution WHERE id = ?', [ids.attribution]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [ids.message]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [ids.apiContact]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_templates WHERE id = ?', [ids.template]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_webhook_events WHERE id = ?', [ids.event]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [ids.phone]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [ids.crmContact]).catch(() => undefined)
  }
})

test('GET de status es read-only incluso con configuración legacy desconectada', async () => {
  const originalRun = db.run
  const writes = []
  db.run = async (sql, params, options) => {
    writes.push(String(sql))
    throw new Error('un GET pasivo no puede escribir')
  }
  try {
    const status = await getWhatsAppApiStatus()
    assert.ok(status)
    assert.equal(Array.isArray(status.phoneNumbers), true)
  } finally {
    db.run = originalRun
  }
  assert.deepEqual(writes, [])
})

test('catálogo WhatsApp de automatizaciones es local, buscable y usa cursor con scope', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const rows = [0, 1, 2].map(index => ({
    id: `wa_catalog_${suffix}_${index}`,
    name: `catalogo_${suffix}_${index}`,
    updatedAt: `2097-04-0${index + 1} 10:00:00.00000${index}`
  }))

  try {
    for (const row of rows) {
      await db.run(`
        INSERT INTO whatsapp_api_templates (
          id, official_template_id, waba_id, name, language, status,
          components_json, raw_payload_json, created_at, updated_at
        ) VALUES (?, ?, 'waba_catalog_projection', ?, 'es_MX', 'APPROVED', '[]', '{}', ?, ?)
      `, [row.id, row.id, row.name, row.updatedAt, row.updatedAt])
    }

    const originalRun = db.run
    const writes = []
    db.run = async (sql, params, options) => {
      writes.push(String(sql))
      return originalRun.call(db, sql, params, options)
    }
    let first
    try {
      first = await listAutomationWhatsAppTemplatesCatalog({
        status: 'APPROVED',
        search: suffix,
        limit: 2
      })
    } finally {
      db.run = originalRun
    }
    assert.deepEqual(writes, [])
    assert.equal(first.items.length, 2)
    assert.equal(first.pageInfo.limit, 2)
    assert.equal(first.pageInfo.hasMore, true)
    assert.ok(first.pageInfo.nextCursor)

    const second = await getWhatsAppApiTemplatesCatalogPage({
      status: 'APPROVED',
      search: suffix,
      limit: 2,
      cursor: first.pageInfo.nextCursor
    })
    assert.equal(second.items.length, 1)
    assert.equal(second.pageInfo.hasMore, false)
    assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 3)

    await assert.rejects(
      getWhatsAppApiTemplatesCatalogPage({
        status: 'PENDING',
        search: suffix,
        limit: 2,
        cursor: first.pageInfo.nextCursor
      }),
      /Cursor de plantillas WhatsApp inválido/
    )
  } finally {
    await db.run('DELETE FROM whatsapp_api_templates WHERE id LIKE ?', [`wa_catalog_${suffix}_%`])
  }
})

test('los GET de plantillas no reparan, sincronizan ni refrescan implícitamente', async () => {
  const [settingsController, whatsappController, automationsService, frontendCatalog] = await Promise.all([
    readFile(new URL('../src/controllers/messageTemplatesController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/controllers/whatsappApiController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/automationsService.js', import.meta.url), 'utf8'),
    readFile(new URL('../../frontend/src/services/automationCatalogsService.ts', import.meta.url), 'utf8')
  ])

  const settingsGet = settingsController.match(/export async function getMessageTemplatesView[\s\S]*?\n}\n/)?.[0] || ''
  const apiGet = whatsappController.match(/export async function getWhatsAppApiTemplatesView[\s\S]*?\n}\n/)?.[0] || ''
  const catalogGet = automationsService.match(/export async function listAutomationWhatsAppTemplatesCatalog[\s\S]*?\n}\n/)?.[0] || ''

  assert.doesNotMatch(settingsGet, /repairDefault|ensureDefault|submitToYCloud/)
  assert.doesNotMatch(apiGet, /ensureDefault|repairDefault|refreshWhatsApp/)
  assert.doesNotMatch(catalogGet, /syncLocalMessageTemplateSnapshots|syncWhatsApp|refreshWhatsApp/)
  assert.doesNotMatch(frontendCatalog, /await\s+whatsappApiService\.refresh\(\)/)
  assert.match(settingsController, /repairDefaultMessageTemplatesView/)
  assert.match(whatsappController, /repairDefaultWhatsAppApiTemplatesView/)
})

