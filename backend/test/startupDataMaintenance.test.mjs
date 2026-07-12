import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  databaseReady,
  db,
  getAppConfig,
  runCoreSchemaBootstrap,
  runStartupDataMaintenance
} from '../src/config/database.js'

test('el mantenimiento histórico corre fuera del bootstrap, por lotes y una sola vez', async () => {
  await databaseReady

  const repeatedBootstrap = await runCoreSchemaBootstrap()
  assert.equal(repeatedBootstrap.skipped, true)
  assert.equal(repeatedBootstrap.version, '2026-07-12-v1')

  const suffix = randomUUID()
  const contactId = `legacy_external_${suffix}`
  const messageId = `startup_message_${suffix}`
  const phone = `+52155${Date.now().toString().slice(-8)}`
  const timestamp = '2026-07-12T12:00:00.000Z'

  await db.run("DELETE FROM app_config WHERE config_key IN ('startup_data_maintenance_version', 'whatsapp_api_first_ad_attribution_backfill_version')")

  try {
    await db.run(`
      INSERT INTO contacts (id, phone, source, created_at, updated_at)
      VALUES (?, ?, 'GoHighLevel', ?, ?)
    `, [contactId, phone, timestamp, timestamp])

    await db.run(`
      INSERT INTO whatsapp_api_messages (
        id, provider, ycloud_message_id, contact_id, phone, transport,
        direction, message_type, message_text, status, message_timestamp,
        created_at, updated_at, source_adapter
      ) VALUES (?, 'meta_direct', ?, ?, ?, 'api', 'inbound', 'text',
        'Mensaje histórico', 'received', ?, ?, ?, 'ycloud')
    `, [messageId, `legacy_meta_${suffix}`, contactId, phone, timestamp, timestamp, timestamp])

    const firstRun = await runStartupDataMaintenance()
    assert.equal(firstRun.skipped, false)

    const contact = await db.get('SELECT ghl_contact_id FROM contacts WHERE id = ?', [contactId])
    assert.equal(contact?.ghl_contact_id, contactId)

    const phoneRow = await db.get(`
      SELECT contact_id, phone, is_primary
      FROM contact_phone_numbers
      WHERE contact_id = ? AND is_primary = 1
    `, [contactId])
    assert.equal(phoneRow?.contact_id, contactId)
    assert.ok(String(phoneRow?.phone || '').length >= 10)
    assert.equal(Number(phoneRow?.is_primary), 1)

    const message = await db.get(`
      SELECT meta_message_id, ycloud_message_id, provider_message_id, source_adapter
      FROM whatsapp_api_messages
      WHERE id = ?
    `, [messageId])
    assert.equal(message?.meta_message_id, `legacy_meta_${suffix}`)
    assert.equal(message?.ycloud_message_id, null)
    assert.equal(message?.provider_message_id, `legacy_meta_${suffix}`)
    assert.equal(message?.source_adapter, 'meta_direct')
    assert.equal(await getAppConfig('startup_data_maintenance_version'), '2026-07-12-v1')

    const secondRun = await runStartupDataMaintenance()
    assert.equal(secondRun.skipped, true)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [messageId]).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
})
