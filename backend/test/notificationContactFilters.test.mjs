import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { db, setUserAppConfig, setAppConfig } from '../src/config/database.js'
import { validateNotificationContactFilter, createNotificationContactFilterResolver, notificationFilterKeyForEvent, NOTIFICATION_CONTACT_FILTER_KEYS } from '../src/services/notificationContactFiltersService.js'
import { saveUserConfig, patchUserConfigAdmin } from '../src/controllers/userConfigController.js'
import { getNotificationContactFilterCatalog } from '../src/controllers/notificationContactFiltersController.js'

const config = (rules, options = {}) => ({ version: 1, groupMode: 'all', groups: [{ mode: 'all', rules }], ...options })
const email = (operator, value) => ({ field: 'email', operator, value })
const prefix = 'notification-filter-test'
let userId, otherUserId
before(async () => {
  for (const suffix of ['a', 'b']) {
    await db.run(`INSERT INTO users (username, email, password_hash, role, is_active) VALUES (?, ?, 'unused-in-non-auth-test', 'employee', 1)`, [`${prefix}-${suffix}`, `${prefix}-${suffix}@example.test`])
  }
  userId = (await db.get('SELECT id FROM users WHERE username = ?', [`${prefix}-a`])).id
  otherUserId = (await db.get('SELECT id FROM users WHERE username = ?', [`${prefix}-b`])).id
  await db.run(`INSERT INTO contacts (id, email, first_name, tags, assigned_user_id, custom_fields, created_at) VALUES (?, ?, 'Ana', ?, ?, ?, ?)`, [prefix, 'ana@example.test', JSON.stringify(['vip', 'active']), String(userId), JSON.stringify([{ key: 'plan', value: 'Premium' }, { key: 'score', value: 25 }, { key: 'accepts', value: true }, { key: 'day', value: '2026-09-25' }]), '2026-09-25T05:00:00.000Z'])
  await db.run(`INSERT INTO contacts (id, email, tags, custom_fields) VALUES (?, ?, ?, '[]')`, [`${prefix}-other`, 'other@elsewhere.test', JSON.stringify(['vip_gold'])])
})
after(async () => {
  await db.run('DELETE FROM user_app_config WHERE user_id IN (?, ?)', [userId, otherUserId])
  await db.run('DELETE FROM users WHERE id IN (?, ?)', [userId, otherUserId])
  await db.run('DELETE FROM contacts WHERE id IN (?, ?)', [prefix, `${prefix}-other`])
  for (const key of NOTIFICATION_CONTACT_FILTER_KEYS) await db.run('DELETE FROM app_config WHERE config_key = ?', [key])
})
const match = (contactIds = [prefix], enabledKey = 'chat_push_notifications_enabled') => createNotificationContactFilterResolver({ contactIds, enabledKey })
const write = async rules => setUserAppConfig(userId, 'chat_push_contact_filter', config(rules))

test('rejects malformed, incomplete and unsupported conditions instead of dropping them', () => {
  for (const raw of ['oops', null, [], { version: 1, groupMode: 'all', groups: [{ mode: 'all', rules: [] }] }, config([email('contains', '')]), config([{ field: 'invented', operator: 'yes' }]), config([email('gt', 5)]), config([{ field: 'custom_field', valueType: 'text', operator: 'is', value: 'x' }]), config([{ field: 'created_at', operator: 'on', value: '2026-02-31' }]), config([{ field: 'payments_count', operator: 'between', value: 1 }]), config(Array.from({ length: 51 }, () => email('contains', 'a')))]) {
    assert.throws(() => validateNotificationContactFilter(raw), { statusCode: 400 })
  }
  assert.deepEqual(validateNotificationContactFilter({ version: 1, groupMode: 'all', groups: [] }).groups, [])
})
test('per-user defaults, exact tag membership, user assignment and live contact updates', async () => {
  assert.equal(await match()(userId), true)
  await write([{ field: 'tags', operator: 'any', value: ['vip'] }, { field: 'assigned_user_id', operator: 'is', value: String(userId) }])
  assert.equal(await match()(userId), true)
  assert.equal(await match([`${prefix}-other`])(userId), false)
  assert.equal(await match([`${prefix}-other`])(otherUserId), true)
  await db.run('UPDATE contacts SET tags = ? WHERE id = ?', [JSON.stringify(['vip_gold']), prefix])
  assert.equal(await match()(userId), false)
  await db.run('UPDATE contacts SET tags = ? WHERE id = ?', [JSON.stringify(['vip', 'active']), prefix])
  await write([{ field: 'tags', operator: 'any', value: ['v%'] }])
  assert.equal(await match()(userId), false)
})
test('text conditions, all/any blocks and exclusion', async () => {
  for (const [operator, value, expected] of [['contains', '@example', true], ['not_contains', '@example', false], ['is', 'ANA@EXAMPLE.TEST', true], ['is_not', 'other', true], ['empty', undefined, false], ['not_empty', undefined, true], ['starts_with', 'ana', true], ['ends_with', '.test', true]]) {
    await write([email(operator, value)])
    assert.equal(await match()(userId), expected, operator)
  }
  await setUserAppConfig(userId, 'chat_push_contact_filter', config([], { groupMode: 'any', groups: [{ mode: 'all', negate: true, rules: [email('contains', 'elsewhere')] }, { mode: 'any', rules: [email('is', 'none'), email('is', 'other')] }] }))
  assert.equal(await match()(userId), true)
  assert.equal(await match([`${prefix}-other`])(userId), false)
})
test('custom form values, numeric/date/boolean and absent fields', async () => {
  for (const [customKey, valueType, operator, value, expected] of [['plan', 'select', 'is', 'Premium', true], ['score', 'number', 'gte', 25, true], ['score', 'number', 'lt', 20, false], ['accepts', 'boolean', 'yes', undefined, true], ['accepts', 'boolean', 'no', undefined, false], ['missing', 'text', 'empty', undefined, true], ['missing', 'text', 'not_empty', undefined, false], ['day', 'date', 'on', '2026-09-25', true]]) {
    const rule = { field: 'custom_field', customKey, valueType, operator, value }
    validateNotificationContactFilter(config([rule]))
    await write([rule])
    assert.equal(await match()(userId), expected, `${customKey} ${operator}`)
  }
})
test('global contact filter intersects event filter, preserves other event types and checks every contact', async () => {
  await write([email('contains', 'example')])
  await setUserAppConfig(userId, 'contact_push_notification_filter', config([{ field: 'tags', operator: 'none', value: ['blocked'] }]))
  assert.equal(await match()(userId), true)
  assert.equal(await match([prefix, `${prefix}-other`])(userId), false)
  assert.equal(await match([])(userId), false)
  assert.equal(await match([`${prefix}-other`], 'payment_push_notifications_enabled')(userId), true)
  assert.equal(await createNotificationContactFilterResolver({ category: 'system' })(userId), true)
  await setUserAppConfig(userId, 'contact_push_notification_filter', config([email('is', 'no-match')]))
  assert.equal(await match()(userId), false)
  await setUserAppConfig(userId, 'contact_push_notification_filter', { version: 1, groupMode: 'all', groups: [] })
  assert.equal(await match()(userId), true)
})
test('unknown/corrupt persisted rule fails closed, and removal restores prior delivery', async () => {
  await setUserAppConfig(userId, 'chat_push_contact_filter', 'corrupt')
  assert.equal(await match()(userId), false)
  assert.equal(await match()(otherUserId), true)
  await setUserAppConfig(userId, 'chat_push_contact_filter', { version: 1, groupMode: 'all', groups: [] })
  assert.equal(await match()(userId), true)
  assert.equal(await match([])(userId), true)
})
test('global defaults also restrict legacy subscriptions without an owner', async () => {
  await setAppConfig('chat_push_contact_filter', config([email('contains', 'example')]))
  assert.equal(await match()(''), true)
  assert.equal(await match([`${prefix}-other`])(''), false)
  await db.run('DELETE FROM app_config WHERE config_key = ?', ['chat_push_contact_filter'])
})
const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this }, json(body) { this.body = body; return this } })
test('self API rejects the entire invalid batch and cannot write another user', async () => {
  const res = response()
  await saveUserConfig({ user: { userId }, body: { userId: otherUserId, config: { chat_push_notifications_enabled: false, chat_push_contact_filter: config([email('contains', '')]) } } }, res)
  assert.equal(res.code, 400)
  assert.equal(await db.get('SELECT * FROM user_app_config WHERE user_id = ? AND config_key = ?', [userId, 'chat_push_notifications_enabled']), null)
  const good = response()
  await saveUserConfig({ user: { userId }, body: { userId: otherUserId, key: 'chat_push_contact_filter', value: config([email('is', 'ana@example.test')]) } }, good)
  assert.equal(good.code, 200)
  assert.equal(await match()(userId), true)
  assert.equal(await match([`${prefix}-other`])(otherUserId), true)
})
test('admin reset clears only requested override', async () => {
  const res = response()
  await patchUserConfigAdmin({ params: { userId }, user: { userId: otherUserId, role: 'admin' }, body: { config: { chat_push_contact_filter: null } } }, res)
  assert.equal(res.code, 200)
  assert.equal(await match([`${prefix}-other`])(userId), true)
})
test('catalog is available to employees with real local labels', async () => {
  const res = response()
  await getNotificationContactFilterCatalog({ user: { userId, role: 'employee' } }, res)
  assert.equal(res.code, 200)
  const fields = res.body.data.groups.flatMap(g => g.fields)
  assert.ok(fields.some(f => f.key === 'tags'))
  assert.ok(fields.find(f => f.key === 'assigned_user_id').options.some(o => o.value === String(userId)))
  assert.deepEqual(fields.find(f => f.key === 'assigned_user_id').operators.map(o => o.value), ['is', 'is_not', 'empty', 'not_empty'])
  assert.deepEqual(fields.find(f => f.key === 'priority').operators.map(o => o.value), ['is', 'is_not'])
})
test('event routing includes reminders, confirmations, payments and agent priority', () => {
  for (const [category, key] of [['chat', 'chat'], ['agent_priority', 'chat'], ['appointment_reminders', 'calendar'], ['appointment_confirmed', 'appointment_confirmation'], ['payment', 'payment']]) assert.equal(notificationFilterKeyForEvent('', category), `${key}_push_contact_filter`)
})
