import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { migrationRunsForDialect } from '../src/startup/runMigrations.js'

const migrations = [
  '099_message_first_seen_whatsapp_version.sqlite.sql',
  '099a_message_first_seen_meta_version.sqlite.sql',
  '099b_message_first_seen_email_version.sqlite.sql',
  '099c_message_first_seen_projection.sqlite.sql',
  '099d_message_first_seen_projection.postgres.sql',
  '099e_message_first_seen_whatsapp_pending.postgres.sql',
  '099f_message_first_seen_meta_pending.postgres.sql',
  '099g_message_first_seen_email_pending.postgres.sql'
]

test('099 separa dialectos y cada indice concurrente vive solo en su migracion', async () => {
  for (const name of migrations.filter(item => item.endsWith('.sqlite.sql'))) {
    assert.equal(migrationRunsForDialect(name, 'sqlite'), true)
    assert.equal(migrationRunsForDialect(name, 'postgres'), false)
  }
  for (const name of migrations.filter(item => item.endsWith('.postgres.sql'))) {
    assert.equal(migrationRunsForDialect(name, 'postgres'), true)
    assert.equal(migrationRunsForDialect(name, 'sqlite'), false)
  }

  for (const name of migrations.filter(item => /099[e-g]_/.test(item))) {
    const sql = (await readFile(new URL(`../migrations/versioned/${name}`, import.meta.url), 'utf8')).trim()
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/gi) || []).length, 1)
    assert.equal(sql.split(';').filter(statement => statement.trim()).length, 1)
    assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/i)
  }

  const sqlite = await readFile(
    new URL('../migrations/versioned/099c_message_first_seen_projection.sqlite.sql', import.meta.url),
    'utf8'
  )
  const postgres = await readFile(
    new URL('../migrations/versioned/099d_message_first_seen_projection.postgres.sql', import.meta.url),
    'utf8'
  )
  for (const sql of [sqlite, postgres]) {
    assert.match(sql, /message_first_seen_ledger/i)
    assert.match(sql, /message_identity_first_seen_global/i)
    assert.match(sql, /message_identity_first_seen_source/i)
    assert.match(sql, /message_first_seen_projection_state/i)
    assert.match(sql, /first_seen_projection_version/i)
    assert.match(sql, /'message:'\s*\|\|\s*msg\.id/i)
  }
})
