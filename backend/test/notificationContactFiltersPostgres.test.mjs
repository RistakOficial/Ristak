import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { createPostgresAdapter } from '../src/config/databasePostgresAdapter.js'
// Initialize the normal isolated SQLite test runtime before selecting the SQL dialect.
import '../src/config/database.js'

test('notification contact conditions execute against real PostgreSQL JSON and contact data', { skip: !process.env.TEST_POSTGRES_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.TEST_POSTGRES_URL })
  await client.connect()
  const database = createPostgresAdapter(client)
  const previousUrl = process.env.DATABASE_URL
  try {
    process.env.DATABASE_URL = process.env.TEST_POSTGRES_URL
    const { buildContactListWhere } = await import('../src/services/contactListFilterService.js?notification-postgres')
    const { buildNotificationFilterCondition } = await import('../src/services/notificationContactFiltersService.js')
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    // Connection-local fixtures never touch customer or shared test tables.
    await client.query(`CREATE TEMP TABLE contacts (
      id TEXT PRIMARY KEY, email TEXT, tags TEXT, custom_fields JSONB,
      assigned_user_id TEXT, deleted_at TIMESTAMP, created_at TIMESTAMP);
      CREATE TEMP TABLE appointments (id TEXT, contact_id TEXT, calendar_id TEXT);
      CREATE TEMP TABLE calendars (id TEXT, ghl_calendar_id TEXT, name TEXT, slug TEXT);`)
    for (const [id, tags] of [['a', ['vip', 'active']], ['b', ['vip_gold']], ['c', [{ id: 'vip', name: 'VIP' }]]]) {
      await database.run('INSERT INTO contacts (id, email, tags, custom_fields, assigned_user_id, created_at) VALUES (?, ?, ?, ?::jsonb, ?, ?)', [
        id, `${id}@example.test`, JSON.stringify(tags), JSON.stringify([
          { key: 'plan', value: 'Premium' }, { key: 'interests', value: ['Consultoría', 'Curso'] }, { key: 'empty_selection', value: [] }, { key: 'score', value: 25.5 },
          { key: 'accepts', value: true }, { key: 'day', value: '2026-09-25' }
        ]), 'owner', '2026-09-25 05:00:00'
      ])
    }
    await database.run("INSERT INTO appointments (id, contact_id, calendar_id) VALUES ('appointment', 'a', 'calendar')")
    const ids = async rules => {
      const { whereClause, params } = buildContactListWhere({ alias: 'c', timezone: 'America/Ciudad_Juarez', advancedFilters: { version: 1, groupMode: 'all', groups: [{ mode: 'all', rules }] } })
      return (await database.all(`SELECT c.id FROM contacts c ${whereClause} ORDER BY c.id`, params)).map(r => r.id)
    }
    assert.deepEqual(await ids([{ field: 'tags', operator: 'any', value: ['vip'] }]), ['a', 'c'])
    assert.deepEqual(await ids([{ field: 'tags', operator: 'all', value: ['vip', 'active'] }]), ['a'])
    assert.deepEqual(await ids([{ field: 'tags', operator: 'none', value: ['vip'] }]), ['b'])
    assert.deepEqual(await ids([{ field: 'tags', operator: 'any', value: ['v%'] }]), [])
    assert.deepEqual(await ids([{ field: 'assigned_user_id', operator: 'is', value: 'owner' }, { field: 'email', operator: 'contains', value: 'a@' }]), ['a'])
    for (const [customKey, valueType, operator, value] of [
      ['plan', 'select', 'is', 'Premium'], ['interests', 'select', 'is', 'Curso'], ['interests', 'select', 'is_not', 'Otro'], ['empty_selection', 'select', 'empty', undefined], ['score', 'number', 'gte', 25.4],
      ['accepts', 'boolean', 'yes', undefined], ['day', 'date', 'on', '2026-09-25'],
      ['missing', 'text', 'empty', undefined]
    ]) assert.deepEqual(await ids([{ field: 'custom_field', customKey, valueType, operator, value }]), ['a', 'b', 'c'], `${customKey} ${operator}`)
    assert.deepEqual(await ids([{ field: 'custom_field', customKey: 'interests', valueType: 'select', operator: 'is_not', value: 'Curso' }]), [])
    assert.deepEqual(await ids([{ field: 'appointment_calendar', operator: 'is', value: 'calendar' }]), ['a'])
    const eventIds = async (calendarId, mode, negate = false) => {
      const { condition, params } = buildNotificationFilterCondition({ groupMode: 'all', groups: [{ mode, negate, rules: [
        { field: 'notification_calendar_id', operator: 'is', value: 'event-calendar' },
        { field: 'tags', operator: 'any', value: ['vip'] }
      ] }] }, 'America/Ciudad_Juarez', calendarId)
      return (await database.all(`SELECT c.id FROM contacts c WHERE ${condition} ORDER BY c.id`, params)).map(row => row.id)
    }
    assert.deepEqual(await eventIds('event-calendar', 'all'), ['a', 'c'])
    assert.deepEqual(await eventIds('other-calendar', 'all'), [])
    assert.deepEqual(await eventIds('event-calendar', 'any'), ['a', 'b', 'c'])
    assert.deepEqual(await eventIds('event-calendar', 'all', true), ['b'])
    await database.run("UPDATE contacts SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'a'")
    assert.deepEqual(await ids([{ field: 'tags', operator: 'all', value: ['vip', 'active'] }]), [])
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
    await client.end()
  }
})
