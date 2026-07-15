import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import pg from 'pg'

const connectionString = process.env.RISTAK_TEST_POSTGRES_URL || ''

test('109 despliega O(1), cubre contactos nuevos y 108 invalida sin depender del backfill', {
  skip: !connectionString
}, async () => {
  const client = new pg.Client({ connectionString })
  const schema = `ristak_contact_coverage_${randomUUID().replaceAll('-', '')}`
  await client.connect()

  try {
    await client.query(`CREATE SCHEMA "${schema}"`)
    await client.query(`SET search_path TO "${schema}", public`)
    await client.query(`
      CREATE TABLE contacts (
        id TEXT PRIMARY KEY,
        full_name TEXT, first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
        source TEXT, attribution_session_source TEXT,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE payments (id TEXT PRIMARY KEY, contact_id TEXT);
      CREATE INDEX idx_payments_contact ON payments(contact_id);
      CREATE TABLE contact_phone_numbers (id TEXT PRIMARY KEY, contact_id TEXT, phone TEXT);
      CREATE TABLE contact_list_activity (
        contact_id TEXT PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
        priority INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE crm_list_projection_state (
        projection_key TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'backfilling',
        processed_count BIGINT NOT NULL DEFAULT 0,
        generation BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE payment_list_activity (
        payment_id TEXT PRIMARY KEY,
        contact_id TEXT,
        contact_name_sort TEXT NOT NULL DEFAULT '',
        contact_email_sort TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE payment_list_revisions (
        scope TEXT PRIMARY KEY,
        revision BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO payment_list_revisions(scope) VALUES ('transactions');
      INSERT INTO crm_list_projection_state(projection_key, status)
      VALUES ('payment_list', 'ready');

      INSERT INTO contacts(id, full_name, email, created_at, updated_at)
      SELECT
        'contact-' || value,
        'Contact ' || value,
        'contact-' || value || '@local.invalid',
        TIMESTAMPTZ '2099-01-01 00:00:00+00' - (value * INTERVAL '1 second'),
        TIMESTAMPTZ '2099-01-01 00:00:00+00' - (value * INTERVAL '1 second')
      FROM generate_series(1, 100000) value;
    `)

    const migration109 = await readFile(
      new URL('../migrations/versioned/109a_contact_list_full_coverage.postgres.sql', import.meta.url),
      'utf8'
    )
    assert.doesNotMatch(migration109, /\b(?:LOCK|SELECT)\s+(?:TABLE|\*|.+\s+FROM\s+contacts)/i)
    await client.query(migration109)

    // La migración no congela ni copia las 100k filas históricas.
    const afterDeploy = await client.query('SELECT COUNT(*)::int AS count FROM contact_list_activity')
    assert.equal(afterDeploy.rows[0].count, 0)

    await client.query("INSERT INTO contacts(id, full_name) VALUES ('contact-live', 'Live')")
    const liveRow = await client.query("SELECT contact_id FROM contact_list_activity WHERE contact_id = 'contact-live'")
    assert.equal(liveRow.rows[0].contact_id, 'contact-live')

    // Simula el resultado del worker keyset y valida el hot path que queda una
    // vez publicada la cobertura durable.
    await client.query(`
      INSERT INTO contact_list_activity(contact_id)
      SELECT id FROM contacts
      ON CONFLICT (contact_id) DO NOTHING;
      CREATE INDEX idx_contact_list_activity_priority
      ON contact_list_activity(priority, contact_id);
      CREATE INDEX idx_contacts_cursor_created
      ON contacts(created_at, id) WHERE deleted_at IS NULL;
      ANALYZE contacts;
      ANALYZE contact_list_activity;
    `)
    const activityPlan = JSON.stringify((await client.query(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT c.id, cla.priority
      FROM contact_list_activity cla
      INNER JOIN contacts c ON c.id = cla.contact_id
      WHERE c.deleted_at IS NULL
      ORDER BY cla.priority DESC, cla.contact_id DESC
      LIMIT 51
    `)).rows[0]['QUERY PLAN'])
    assert.match(activityPlan, /idx_contact_list_activity_priority/i)

    const migration108 = await readFile(
      new URL('../migrations/versioned/108a_transaction_summary_contact_revision.postgres.sql', import.meta.url),
      'utf8'
    )
    await client.query(migration108)
    await client.query("INSERT INTO payments(id, contact_id) VALUES ('payment-1', 'contact-1')")
    await client.query("UPDATE contacts SET first_name = 'Nuevo' WHERE id = 'contact-1'")
    let revision = await client.query("SELECT revision::int FROM payment_list_revisions WHERE scope = 'transactions'")
    assert.equal(revision.rows[0].revision, 1)

    await client.query("INSERT INTO contact_phone_numbers(id, contact_id, phone) VALUES ('phone-1', 'contact-1', '5550000000')")
    revision = await client.query("SELECT revision::int FROM payment_list_revisions WHERE scope = 'transactions'")
    assert.equal(revision.rows[0].revision, 2)
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    await client.end()
  }
})
