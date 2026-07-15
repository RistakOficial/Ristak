import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { db } from '../src/config/database.js'
import { getChatContacts } from '../src/controllers/contactsController.js'
import {
  isChatActivityProjectionReady,
  runChatActivityProjectionBackfill
} from '../src/services/chatActivityProjectionService.js'

const execFileAsync = promisify(execFile)

const sqliteMigrationUrl = new URL(
  '../migrations/versioned/096_chat_activity_projection.sqlite.sql',
  import.meta.url
)
const sqliteColumnMigrationUrls = [
  '095za_chat_activity_whatsapp_version.sqlite.sql',
  '095zb_chat_activity_meta_version.sqlite.sql',
  '095zc_chat_activity_email_version.sqlite.sql'
].map(name => new URL(`../migrations/versioned/${name}`, import.meta.url))

let migrationPromise = null

async function ensureProjectionMigration() {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const columns = await db.all("PRAGMA table_info('whatsapp_api_messages')")
      if (!columns.some(column => column.name === 'chat_projection_version')) {
        for (const migrationUrl of sqliteColumnMigrationUrls) {
          await db.exec(await readFile(migrationUrl, 'utf8'))
        }
      }
      const projectionTable = await db.get(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chat_message_activity'"
      )
      if (!projectionTable) await db.exec(await readFile(sqliteMigrationUrl, 'utf8'))
    })()
  }
  return migrationPromise
}

function createResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return payload
    }
  }
}

async function readChatContactsResponse(query = {}) {
  const response = createResponse()
  await getChatContacts({ query, user: {} }, response)
  assert.equal(response.statusCode, 200, JSON.stringify(response.body))
  assert.equal(response.body?.success, true)
  return response.body
}

async function readChatContacts(query = {}) {
  return (await readChatContactsResponse(query)).data
}

async function captureDatabaseListQueries(task) {
  const originalAll = db.all
  const queries = []
  db.all = async (sql, params = []) => {
    queries.push(String(sql || ''))
    return originalAll.call(db, sql, params)
  }
  try {
    return { value: await task(), queries }
  } finally {
    db.all = originalAll
  }
}

async function insertRow(table, values) {
  const columns = Object.keys(values)
  await db.run(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
    columns.map(column => values[column])
  )
}

async function cleanupFixture({ contactIds = [], phones = [], profileIds = [], phoneNumberIds = [] }) {
  for (const contactId of contactIds) {
    await db.run('DELETE FROM whatsapp_api_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM email_messages WHERE contact_id = ?', [contactId]).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE contact_id = ?', [contactId]).catch(() => undefined)
  }
  for (const phone of phones) {
    await db.run(
      'DELETE FROM whatsapp_api_messages WHERE phone = ? OR from_phone = ? OR to_phone = ?',
      [phone, phone, phone]
    ).catch(() => undefined)
    await db.run('DELETE FROM contact_phone_numbers WHERE phone = ?', [phone]).catch(() => undefined)
  }
  for (const profileId of profileIds) {
    await db.run('DELETE FROM whatsapp_api_messages WHERE whatsapp_api_contact_id = ?', [profileId]).catch(() => undefined)
    await db.run('DELETE FROM whatsapp_api_contacts WHERE id = ?', [profileId]).catch(() => undefined)
  }
  for (const phoneNumberId of phoneNumberIds) {
    await db.run('DELETE FROM whatsapp_api_phone_numbers WHERE id = ?', [phoneNumberId]).catch(() => undefined)
  }
  for (const contactId of contactIds) {
    await db.run('DELETE FROM contacts WHERE id = ?', [contactId]).catch(() => undefined)
  }
}

test('la proyeccion de Chats conserva un ledger sentinel y un scope canonico unico', async () => {
  const sql = (
    await Promise.all([...sqliteColumnMigrationUrls, sqliteMigrationUrl].map(url => readFile(url, 'utf8')))
  ).join('\n')

  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_message_activity/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_contact_activity/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_contact_scope_activity/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_activity_projection_state/i)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS chat_activity_identity_queue/i)
  assert.match(sql, /chat_projection_version/i)
  assert.match(sql, /'id:'\s*\|\|/i)
  assert.match(sql, /'phone:'\s*\|\|/i)

  // Un mensaje excluido o aun no resuelto debe dejar evidencia durable. Si se
  // omite del ledger, el readiness puede quedar verde mientras faltan filas.
  assert.match(sql, /resolution_status|projection_status|included/i)
  assert.match(sql, /generation\s*=\s*chat_activity_identity_queue\.generation\s*\+\s*1/i)
  assert.match(sql, /cursor_message_id\s*=\s*''/i)
})

test('sin migracion instalada readiness falla cerrado sin reconstruir el historial', async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), 'ristak-chat-projection-missing-'))
  const sqlitePath = join(tempDirectory, 'missing-projection.sqlite')
  const serviceUrl = new URL('../src/services/chatActivityProjectionService.js', import.meta.url)
  const controllerUrl = new URL('../src/controllers/contactsController.js', import.meta.url)

  try {
    const script = `
      const service = await import(${JSON.stringify(serviceUrl.href)});
      const controller = await import(${JSON.stringify(controllerUrl.href)});
      const ready = await service.isChatActivityProjectionReady();
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return payload; }
      };
      await controller.getChatContacts({ query: {}, user: {} }, response);
      process.stdout.write('CHAT_PROJECTION_READY=' + String(ready) + '\\n');
      process.stdout.write('CHAT_GET=' + JSON.stringify({
        statusCode: response.statusCode,
        rows: response.body?.data?.length,
        projection: response.body?.performance?.activityProjection
      }) + '\\n');
    `
    const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: '',
        NODE_ENV: 'test',
        RISTAK_SQLITE_PATH: sqlitePath
      },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024
    })
    assert.match(stdout, /CHAT_PROJECTION_READY=false/)
    assert.match(stdout, /CHAT_GET=\{"statusCode":200,"rows":0,"projection":"unavailable"\}/)
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
})

test('global y scopes son exactos entre WhatsApp, Meta y email sin doble conteo', async () => {
  await ensureProjectionMigration()
  const suffix = randomUUID().replaceAll('-', '')
  const contactId = `chat_projection_multi_${suffix}`
  const customerPhone = `52155${suffix.slice(0, 8)}`
  const businessPhone = '+52 656 100 0000'
  const normalizedBusinessPhone = '526561000000'
  const phoneNumberId = `wa_business_${suffix}`
  const ids = {
    whatsappId: `wa_projection_${suffix}`,
    whatsappPhone: `wa_projection_phone_${suffix}`,
    metaId: `meta_projection_${suffix}`,
    emailId: `email_projection_${suffix}`,
    statusId: `status_projection_${suffix}`,
    unresolvedId: `unresolved_projection_${suffix}`
  }

  await cleanupFixture({ contactIds: [contactId], phones: [customerPhone], phoneNumberIds: [phoneNumberId] })

  try {
    await insertRow('contacts', {
      id: contactId,
      phone: customerPhone,
      full_name: 'Proyeccion Multicanal',
      created_at: '2100-01-01T10:00:00.000Z',
      updated_at: '2100-01-01T10:00:00.000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: ids.whatsappId,
      contact_id: contactId,
      phone: customerPhone,
      from_phone: customerPhone,
      to_phone: businessPhone,
      business_phone_number_id: phoneNumberId,
      business_phone: businessPhone,
      direction: 'inbound',
      message_type: 'text',
      message_text: 'WhatsApp por id',
      message_timestamp: '2100-01-01T10:01:00.123456Z',
      created_at: '2100-01-01T10:01:00.123456Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: ids.whatsappPhone,
      contact_id: contactId,
      phone: customerPhone,
      from_phone: customerPhone,
      to_phone: normalizedBusinessPhone,
      business_phone: normalizedBusinessPhone,
      direction: 'outbound',
      message_type: 'text',
      message_text: 'WhatsApp por telefono',
      message_timestamp: '2100-01-01T10:02:00.223456Z',
      created_at: '2100-01-01T10:02:00.223456Z'
    })
    const phoneOnlyBeforeCatalog = await db.get(`
      SELECT scope_key
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp' AND source_message_id = ?
    `, [ids.whatsappPhone])
    assert.equal(phoneOnlyBeforeCatalog.scope_key, `phone:+${normalizedBusinessPhone}`)

    // El catálogo puede conectarse después de años de historial. Esa mutación
    // debe ensuciar y reproyectar phone:* -> id:* sin bloquear el write.
    await insertRow('whatsapp_api_phone_numbers', {
      id: phoneNumberId,
      provider: 'ycloud',
      phone_number: `+${normalizedBusinessPhone}`,
      display_phone_number: businessPhone,
      qr_connected_phone: businessPhone,
      status: 'CONNECTED'
    })
    await insertRow('meta_social_messages', {
      id: ids.metaId,
      platform: 'instagram',
      contact_id: contactId,
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_text: 'Meta intermedio',
      message_timestamp: '2100-01-01T10:03:00.323456Z',
      created_at: '2100-01-01T10:03:00.323456Z'
    })
    await insertRow('email_messages', {
      id: ids.emailId,
      contact_id: contactId,
      direction: 'inbound',
      status: 'received',
      subject: 'Email mas reciente',
      message_text: 'Contenido',
      message_timestamp: '2100-01-01T10:04:00.423456Z',
      created_at: '2100-01-01T10:04:00.423456Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: ids.statusId,
      contact_id: contactId,
      phone: customerPhone,
      business_phone_number_id: phoneNumberId,
      business_phone: businessPhone,
      direction: 'inbound',
      message_type: 'status',
      message_text: 'No cuenta',
      message_timestamp: '2100-01-01T10:05:00.523456Z',
      created_at: '2100-01-01T10:05:00.523456Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: ids.unresolvedId,
      phone: `999${suffix.slice(0, 8)}`,
      direction: 'inbound',
      message_type: 'text',
      message_text: 'Aun sin identidad',
      message_timestamp: '2100-01-01T10:06:00.623456Z',
      created_at: '2100-01-01T10:06:00.623456Z'
    })

    await runChatActivityProjectionBackfill()
    assert.equal(await isChatActivityProjectionReady(), true)

    const ledgerRows = await db.all(`
      SELECT source_kind, source_message_id, contact_id, scope_key, included
      FROM chat_message_activity
      WHERE source_message_id IN (?, ?, ?, ?, ?, ?)
      ORDER BY source_message_id
    `, Object.values(ids))
    assert.equal(ledgerRows.length, 6, 'incluidos, status y no-resueltos deben converger en el ledger')

    const idScope = ledgerRows.find(row => row.source_message_id === ids.whatsappId)
    const phoneScope = ledgerRows.find(row => row.source_message_id === ids.whatsappPhone)
    assert.equal(idScope.scope_key, `id:${phoneNumberId}`)
    assert.equal(
      phoneScope.scope_key,
      idScope.scope_key,
      'un telefono ya catalogado debe canonizar al mismo scope id aunque el mensaje no traiga el id'
    )
    assert.equal(Number(ledgerRows.find(row => row.source_message_id === ids.statusId).included), 0)
    assert.equal(Number(ledgerRows.find(row => row.source_message_id === ids.unresolvedId).included), 0)

    const global = await db.get(`
      SELECT message_count, last_source_kind, last_source_message_id
      FROM chat_contact_activity
      WHERE contact_id = ?
    `, [contactId])
    assert.equal(Number(global.message_count), 4)
    assert.equal(`${global.last_source_kind}:${global.last_source_message_id}`, `email:${ids.emailId}`)

    await runChatActivityProjectionBackfill()
    assert.equal(await isChatActivityProjectionReady(), true)

    const globalRequest = await captureDatabaseListQueries(() => (
      readChatContacts({ q: `Proyeccion Multicanal`, limit: '10' })
    ))
    const allChats = globalRequest.value
    const globalChat = allChats.find(row => row.id === contactId)
    assert.ok(globalChat)
    assert.equal(globalChat.messageCount, 4)
    assert.equal(globalChat.lastMessageChannel, 'email')
    const globalInboxSql = globalRequest.queries.find(sql => sql.includes('ranked_chats')) || ''
    assert.match(globalInboxSql, /chat_contact_activity/)
    assert.match(globalInboxSql, /chat_message_activity/)
    assert.doesNotMatch(globalInboxSql, /GROUP BY\s+msg\.contact_id/i)
    assert.doesNotMatch(
      globalInboxSql,
      /SUM\(message_count\)\s+OVER/i,
      'global tiene una fila por contacto y debe llegar al LIMIT por el indice page, sin window total'
    )

    const scopedRequest = await captureDatabaseListQueries(() => readChatContacts({
        q: 'Proyeccion Multicanal',
        businessPhoneNumberId: phoneNumberId,
        businessPhone,
        limit: '10'
      }))
    const scopedChats = scopedRequest.value
    const scopedChat = scopedChats.find(row => row.id === contactId)
    assert.ok(scopedChat)
    assert.equal(scopedChat.messageCount, 2, 'ID + telefono relacionados no deben sumar el mismo mensaje dos veces')
    const scopedInboxSql = scopedRequest.queries.find(sql => sql.includes('ranked_chats')) || ''
    assert.match(scopedInboxSql, /chat_contact_scope_activity/)
    assert.match(scopedInboxSql, /projected_scope_candidates/)
    assert.match(scopedInboxSql, /projected_candidate_contacts/)
    assert.doesNotMatch(scopedInboxSql, /GROUP BY\s+msg\.contact_id/i)
  } finally {
    await db.run(
      `DELETE FROM whatsapp_api_messages WHERE id IN (?, ?, ?, ?)`,
      [ids.whatsappId, ids.whatsappPhone, ids.statusId, ids.unresolvedId]
    ).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE id = ?', [ids.metaId]).catch(() => undefined)
    await db.run('DELETE FROM email_messages WHERE id = ?', [ids.emailId]).catch(() => undefined)
    await cleanupFixture({ contactIds: [contactId], phones: [customerPhone], phoneNumberIds: [phoneNumberId] })
  }
})

test('identidad WhatsApp respeta direct > profile > MIN(phone) y repara cambios posteriores', async () => {
  await ensureProjectionMigration()
  const suffix = randomUUID().replaceAll('-', '')
  const directId = `chat_identity_direct_${suffix}`
  const profileId = `chat_identity_profile_${suffix}`
  const minId = `chat_identity_a_${suffix}`
  const otherId = `chat_identity_z_${suffix}`
  const unresolvedId = `chat_identity_unresolved_${suffix}`
  const sharedPhone = `52181${suffix.slice(0, 8)}`
  const repairPhone = `52182${suffix.slice(0, 8)}`
  const profileRowId = `wa_profile_${suffix}`
  const messages = {
    direct: `wa_direct_${suffix}`,
    profile: `wa_profile_message_${suffix}`,
    phone: `wa_phone_message_${suffix}`,
    repair: `wa_repair_message_${suffix}`
  }
  const contactIds = [directId, profileId, minId, otherId, unresolvedId]

  await cleanupFixture({ contactIds, phones: [sharedPhone, repairPhone], profileIds: [profileRowId] })

  try {
    for (const [id, phone] of [
      [directId, `52111${suffix.slice(0, 8)}`],
      [profileId, `52112${suffix.slice(0, 8)}`],
      [minId, sharedPhone],
      [otherId, `52114${suffix.slice(0, 8)}`],
      [unresolvedId, `52113${suffix.slice(0, 8)}`]
    ]) {
      await insertRow('contacts', {
        id,
        phone,
        full_name: id,
        created_at: '2100-01-02T10:00:00.000Z',
        updated_at: '2100-01-02T10:00:00.000Z'
      })
    }
    await insertRow('contact_phone_numbers', {
      id: `contact_phone_competing_${suffix}`,
      contact_id: otherId,
      phone: sharedPhone,
      is_primary: 0,
      source: 'test'
    })
    await insertRow('whatsapp_api_contacts', {
      id: profileRowId,
      contact_id: profileId,
      phone: sharedPhone,
      profile_name: 'Profile precedence'
    })

    await insertRow('whatsapp_api_messages', {
      id: messages.direct,
      contact_id: directId,
      whatsapp_api_contact_id: profileRowId,
      phone: sharedPhone,
      direction: 'inbound',
      message_type: 'text',
      message_timestamp: '2100-01-02T10:01:00.100000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: messages.profile,
      whatsapp_api_contact_id: profileRowId,
      phone: sharedPhone,
      direction: 'inbound',
      message_type: 'text',
      message_timestamp: '2100-01-02T10:02:00.200000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: messages.phone,
      phone: sharedPhone,
      direction: 'inbound',
      message_type: 'text',
      message_timestamp: '2100-01-02T10:03:00.300000Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: messages.repair,
      phone: repairPhone,
      direction: 'inbound',
      message_type: 'text',
      message_timestamp: '2100-01-02T10:04:00.400000Z'
    })

    const projected = await db.all(`
      SELECT source_message_id, contact_id
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp'
        AND source_message_id IN (?, ?, ?, ?)
    `, Object.values(messages))
    const byMessage = new Map(projected.map(row => [row.source_message_id, row.contact_id]))
    assert.equal(byMessage.get(messages.direct), directId)
    assert.equal(byMessage.get(messages.profile), profileId)
    assert.equal(byMessage.get(messages.phone), minId)
    assert.equal(byMessage.get(messages.repair) || '', '')

    await insertRow('contact_phone_numbers', {
      id: `contact_phone_repair_${suffix}`,
      contact_id: unresolvedId,
      phone: repairPhone,
      is_primary: 0,
      source: 'test'
    })

    assert.equal(await isChatActivityProjectionReady(), false, 'el cambio de identidad debe ensuciar readiness antes de reparar')
    const warmingResponse = await readChatContactsResponse({ q: unresolvedId, limit: '10' })
    assert.equal(warmingResponse.performance?.activityProjection, 'warming')
    assert.equal(warmingResponse.performance?.complete, false)
    assert.equal(
      warmingResponse.data.some(row => row.id === unresolvedId),
      false,
      'el snapshot parcial no debe fingir que una identidad pendiente ya convergio'
    )

    await runChatActivityProjectionBackfill({ batchSize: 2, yieldMs: 0 })
    const repaired = await db.get(`
      SELECT contact_id
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp' AND source_message_id = ?
    `, [messages.repair])
    assert.equal(repaired.contact_id, unresolvedId)
    assert.equal(await isChatActivityProjectionReady(), true)

    await db.run('UPDATE whatsapp_api_contacts SET contact_id = ? WHERE id = ?', [otherId, profileRowId])
    assert.equal(await isChatActivityProjectionReady(), false)
    await runChatActivityProjectionBackfill({ batchSize: 2, yieldMs: 0 })
    const profileRepaired = await db.get(`
      SELECT contact_id
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp' AND source_message_id = ?
    `, [messages.profile])
    assert.equal(profileRepaired.contact_id, otherId)
  } finally {
    await db.run(
      `DELETE FROM whatsapp_api_messages WHERE id IN (?, ?, ?, ?)`,
      Object.values(messages)
    ).catch(() => undefined)
    await cleanupFixture({ contactIds, phones: [sharedPhone, repairPhone], profileIds: [profileRowId] })
  }
})

test('cola generacional reproyecta mas de un batch sin ackear historicos pendientes', {
  timeout: 60_000
}, async () => {
  await ensureProjectionMigration()
  const suffix = randomUUID().replaceAll('-', '')
  const contactId = `chat_identity_batch_${suffix}`
  const profileRowId = `chat_identity_batch_profile_${suffix}`
  const profilePhone = `52183${suffix.slice(0, 8)}`
  const lookupPhone = `52184${suffix.slice(0, 8)}`
  const messageIds = []

  await cleanupFixture({ contactIds: [contactId], phones: [profilePhone, lookupPhone], profileIds: [profileRowId] })

  try {
    await insertRow('whatsapp_api_contacts', {
      id: profileRowId,
      phone: profilePhone,
      profile_name: 'Batch profile'
    })

    // SQLite procesa 180 por lote. 205 en cada identidad obliga a conservar el
    // cursor y a visitar una segunda pagina antes de borrar la cola.
    for (let index = 0; index < 205; index += 1) {
      const padded = String(index).padStart(3, '0')
      const profileMessageId = `chat_batch_profile_${suffix}_${padded}`
      const phoneMessageId = `chat_batch_phone_${suffix}_${padded}`
      messageIds.push(profileMessageId, phoneMessageId)
      await insertRow('whatsapp_api_messages', {
        id: profileMessageId,
        whatsapp_api_contact_id: profileRowId,
        phone: profilePhone,
        direction: 'inbound',
        message_type: 'text',
        message_timestamp: `2100-01-04T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.100000Z`
      })
      await insertRow('whatsapp_api_messages', {
        id: phoneMessageId,
        phone: lookupPhone,
        direction: 'inbound',
        message_type: 'text',
        message_timestamp: `2100-01-04T11:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.200000Z`
      })
    }

    await insertRow('contacts', {
      id: contactId,
      phone: lookupPhone,
      full_name: 'Batch identity target',
      created_at: '2100-01-04T09:00:00.000000Z',
      updated_at: '2100-01-04T09:00:00.000000Z'
    })
    await db.run('UPDATE whatsapp_api_contacts SET contact_id = ? WHERE id = ?', [contactId, profileRowId])

    const worker = runChatActivityProjectionBackfill()
    await new Promise(resolve => setImmediate(resolve))

    // Re-ensucia las mismas llaves mientras el worker esta vivo. El ack de una
    // generacion vieja no puede borrar la nueva ni conservar su cursor parcial.
    await db.run('UPDATE whatsapp_api_contacts SET contact_id = NULL WHERE id = ?', [profileRowId])
    await db.run('UPDATE whatsapp_api_contacts SET contact_id = ? WHERE id = ?', [contactId, profileRowId])
    await db.run('UPDATE contacts SET phone = ? WHERE id = ?', [`52185${suffix.slice(0, 8)}`, contactId])
    await db.run('UPDATE contacts SET phone = ? WHERE id = ?', [lookupPhone, contactId])
    await worker
    await runChatActivityProjectionBackfill()

    const coverage = await db.get(`
      SELECT
        COUNT(*) AS ledger_count,
        SUM(CASE WHEN included = 1 AND contact_id = ? THEN 1 ELSE 0 END) AS included_count
      FROM chat_message_activity
      WHERE source_kind = 'whatsapp'
        AND source_message_id LIKE ?
    `, [contactId, `chat_batch_%_${suffix}_%`])
    assert.equal(Number(coverage.ledger_count), 410)
    assert.equal(Number(coverage.included_count), 410)

    const summary = await db.get(
      'SELECT message_count FROM chat_contact_activity WHERE contact_id = ?',
      [contactId]
    )
    assert.equal(Number(summary.message_count), 410)
    const pending = await db.get(`
      SELECT 1
      FROM chat_activity_identity_queue
      WHERE (identity_kind = 'profile' AND identity_value = ?)
         OR (identity_kind = 'phone' AND identity_value IN (?, ?))
      LIMIT 1
    `, [profileRowId, lookupPhone, `52185${suffix.slice(0, 8)}`])
    assert.ok(!pending)
    assert.equal(await isChatActivityProjectionReady(), true)
  } finally {
    for (let index = 0; index < messageIds.length; index += 200) {
      const batch = messageIds.slice(index, index + 200)
      await db.run(
        `DELETE FROM whatsapp_api_messages WHERE id IN (${batch.map(() => '?').join(', ')})`,
        batch
      ).catch(() => undefined)
    }
    await cleanupFixture({ contactIds: [contactId], phones: [profilePhone, lookupPhone], profileIds: [profileRowId] })
  }
})

test('insert/update/delete y backfill concurrente son exactos e idempotentes', async () => {
  await ensureProjectionMigration()
  const suffix = randomUUID().replaceAll('-', '')
  const firstContactId = `chat_mutation_a_${suffix}`
  const secondContactId = `chat_mutation_b_${suffix}`
  const firstMessageId = `chat_mutation_old_${suffix}`
  const latestMessageId = `chat_mutation_latest_${suffix}`
  const historicalMetaId = `chat_backfill_meta_${suffix}`
  const contactIds = [firstContactId, secondContactId]

  await cleanupFixture({ contactIds })

  try {
    for (const id of contactIds) {
      await insertRow('contacts', {
        id,
        full_name: id,
        created_at: '2100-01-03T10:00:00.000Z',
        updated_at: '2100-01-03T10:00:00.000Z'
      })
    }
    await insertRow('whatsapp_api_messages', {
      id: firstMessageId,
      contact_id: firstContactId,
      direction: 'inbound',
      message_type: 'text',
      message_timestamp: '2100-01-03T10:01:00.111111Z',
      created_at: '2100-01-03T10:01:00.111111Z'
    })
    await insertRow('whatsapp_api_messages', {
      id: latestMessageId,
      contact_id: firstContactId,
      direction: 'outbound',
      message_type: 'text',
      // El timestamp visible empata; created_at debe decidir igual que el
      // contrato legacy de latest_messages.
      message_timestamp: '2100-01-03T10:01:00.111111Z',
      created_at: '2100-01-03T10:02:00.222222Z'
    })

    let firstSummary = await db.get(
      'SELECT message_count, last_source_kind, last_source_message_id FROM chat_contact_activity WHERE contact_id = ?',
      [firstContactId]
    )
    assert.equal(Number(firstSummary.message_count), 2)
    assert.equal(`${firstSummary.last_source_kind}:${firstSummary.last_source_message_id}`, `whatsapp:${latestMessageId}`)

    await db.run(
      'UPDATE whatsapp_api_messages SET contact_id = ?, message_timestamp = ? WHERE id = ?',
      [secondContactId, '2100-01-03T10:03:00.333333Z', latestMessageId]
    )
    firstSummary = await db.get(
      'SELECT message_count, last_source_kind, last_source_message_id FROM chat_contact_activity WHERE contact_id = ?',
      [firstContactId]
    )
    const secondSummary = await db.get(
      'SELECT message_count, last_source_kind, last_source_message_id FROM chat_contact_activity WHERE contact_id = ?',
      [secondContactId]
    )
    assert.equal(Number(firstSummary.message_count), 1)
    assert.equal(`${firstSummary.last_source_kind}:${firstSummary.last_source_message_id}`, `whatsapp:${firstMessageId}`)
    assert.equal(Number(secondSummary.message_count), 1)
    assert.equal(`${secondSummary.last_source_kind}:${secondSummary.last_source_message_id}`, `whatsapp:${latestMessageId}`)

    await db.run('DELETE FROM whatsapp_api_messages WHERE id = ?', [latestMessageId])
    assert.ok(!(await db.get('SELECT 1 FROM chat_contact_activity WHERE contact_id = ?', [secondContactId])))

    await insertRow('meta_social_messages', {
      id: historicalMetaId,
      platform: 'facebook',
      contact_id: firstContactId,
      direction: 'inbound',
      status: 'received',
      message_type: 'text',
      message_timestamp: '2100-01-03T10:04:00.444444Z'
    })
    await db.run(
      "DELETE FROM chat_message_activity WHERE source_kind = 'meta' AND source_message_id = ?",
      [historicalMetaId]
    )
    await db.run(
      'UPDATE meta_social_messages SET chat_projection_version = 0 WHERE id = ?',
      [historicalMetaId]
    )

    await Promise.all([
      runChatActivityProjectionBackfill({ batchSize: 1, yieldMs: 0 }),
      runChatActivityProjectionBackfill({ batchSize: 1, yieldMs: 0 })
    ])
    await runChatActivityProjectionBackfill({ batchSize: 1, yieldMs: 0 })

    const ledgerCount = await db.get(`
      SELECT COUNT(*) AS total
      FROM chat_message_activity
      WHERE source_kind = 'meta' AND source_message_id = ?
    `, [historicalMetaId])
    assert.equal(Number(ledgerCount.total), 1)
    const finalSummary = await db.get(
      'SELECT message_count, last_source_kind, last_source_message_id FROM chat_contact_activity WHERE contact_id = ?',
      [firstContactId]
    )
    assert.equal(Number(finalSummary.message_count), 2)
    assert.equal(`${finalSummary.last_source_kind}:${finalSummary.last_source_message_id}`, `meta:${historicalMetaId}`)
    assert.equal(await isChatActivityProjectionReady(), true)
  } finally {
    await db.run('DELETE FROM whatsapp_api_messages WHERE id IN (?, ?)', [firstMessageId, latestMessageId]).catch(() => undefined)
    await db.run('DELETE FROM meta_social_messages WHERE id = ?', [historicalMetaId]).catch(() => undefined)
    await cleanupFixture({ contactIds })
  }
})

test('el fast path de Chats no vuelve a agrupar historiales raw completos', async () => {
  const [controller, service] = await Promise.all([
    readFile(new URL('../src/controllers/contactsController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/chatActivityProjectionService.js', import.meta.url), 'utf8')
  ])
  const chatHandler = controller.slice(
    controller.indexOf('export const getChatContacts'),
    controller.indexOf('export const markChatContactRead')
  )

  assert.match(chatHandler, /getChatActivityProjectionStatus/)
  assert.match(chatHandler, /chat_contact_activity/)
  assert.match(chatHandler, /chat_contact_scope_activity/)
  assert.match(chatHandler, /chat_message_activity/)
  assert.doesNotMatch(chatHandler, /legacyMessageStatsRowsSql|legacySelectedMessageRowsSql|legacyResolutionCtesSql/)
  assert.doesNotMatch(chatHandler, /scheduleChatActivityProjectionBackfill/)
  assert.doesNotMatch(chatHandler, /FROM\s+whatsapp_api_messages[\s\S]{0,700}GROUP BY\s+(?:msg\.)?contact_id/i)
  assert.match(chatHandler, /performance:\s*chatProjectionMetadata/)

  // Ranking e hidratacion salen siempre de las proyecciones, tambien mientras
  // el scheduler converge un rolling deploy.
  assert.match(service, /chat_projection_version/)
  assert.match(service, /BATCH_SIZE|batchSize|batch_size/)
  assert.match(service, /WORKER_YIELD_MS|yieldMs|yield_ms/)
  assert.match(service, /WHERE id = \? AND generation = \?/)
  assert.match(
    service,
    /catch \(error\)[\s\S]{0,800}DATABASE_ADVISORY_LOCK_BUSY[\s\S]{0,800}return[\s\S]{0,1200}status = 'failed'/,
    'un lock ocupado debe terminar como already-running antes de la rama failed'
  )
  assert.doesNotMatch(service, /SELECT\s+\*\s+FROM\s+whatsapp_api_messages\s*$/im)
})
