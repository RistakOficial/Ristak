import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { db } from '../src/config/database.js'
import {
  createInternalNotification,
  getSystemNotifications,
  markAllSystemNotificationsRead,
  markNotificationsRead
} from '../src/services/notificationsService.js'

const TEST_PREFIX = 'notification-center-test'
const createdUserIds = new Set()

async function createTestUser() {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const username = `${TEST_PREFIX}-${suffix}`
  await db.run(
    `INSERT INTO users (username, email, password_hash, full_name, role, is_active)
     VALUES (?, ?, ?, ?, 'admin', 1)`,
    [username, `${username}@example.com`, 'notification-test-hash', username]
  )
  const row = await db.get('SELECT id FROM users WHERE username = ?', [username])
  const userId = String(row.id)
  createdUserIds.add(userId)
  return userId
}

async function cleanup() {
  for (const userId of createdUserIds) {
    await db.run('DELETE FROM notification_read_states WHERE user_id = ?', [userId]).catch(() => undefined)
    await db.run('DELETE FROM internal_notifications WHERE recipient_user_id = ?', [userId]).catch(() => undefined)
    await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => undefined)
  }
  createdUserIds.clear()
}

afterEach(cleanup)

describe('notification center persistence', () => {
  it('deduplicates the same internal event before it reaches the bell or push', async () => {
    const userId = await createTestUser()
    const eventIdentity = `contact-${Date.now()}`
    const payload = {
      recipientUserIds: [userId],
      source: 'Prueba de notificaciones',
      severity: 'warning',
      title: 'Revisión pendiente',
      message: 'Este aviso sólo debe existir una vez.',
      actionUrl: '/contacts',
      category: 'notification_test',
      contactId: eventIdentity,
      sendPushNotification: false
    }

    const first = await createInternalNotification(payload)
    const duplicate = await createInternalNotification(payload)
    const rows = await db.all(
      `SELECT id, dedupe_key
       FROM internal_notifications
       WHERE recipient_user_id = ? AND category = 'notification_test'`,
      [userId]
    )

    assert.equal(first.inserted, 1)
    assert.equal(duplicate.inserted, 0)
    assert.equal(duplicate.deduplicated, 1)
    assert.deepEqual(duplicate.ids, first.ids)
    assert.equal(rows.length, 1)
    assert.ok(rows[0].dedupe_key)
  })

  it('keeps read state per user and only reopens a materially changed alert', async () => {
    const userId = await createTestUser()
    const eventIdentity = `contact-${Date.now()}`
    const basePayload = {
      recipientUserIds: [userId],
      source: 'Prueba de notificaciones',
      severity: 'warning',
      title: 'Revisión pendiente',
      message: 'Detalle original',
      actionUrl: '/contacts',
      category: 'notification_test',
      contactId: eventIdentity,
      sendPushNotification: false
    }

    await createInternalNotification(basePayload)
    const initial = await getSystemNotifications({ liveMetaCheck: false, limit: 100, userId })
    const initialItem = initial.items.find((item) => item.source === basePayload.source)
    assert.ok(initialItem)
    assert.equal(initialItem.isRead, false)

    await markNotificationsRead({ userId, notifications: [initialItem] })
    const afterRead = await getSystemNotifications({ liveMetaCheck: false, limit: 100, userId })
    const readItem = afterRead.items.find((item) => item.readKey === initialItem.readKey)
    assert.equal(readItem?.isRead, true)
    assert.equal(afterRead.summary.unread, afterRead.items.filter((item) => !item.isRead).length)

    await createInternalNotification({ ...basePayload, message: 'Detalle actualizado sin cambiar la alerta' })
    const afterDetailUpdate = await getSystemNotifications({ liveMetaCheck: false, limit: 100, userId })
    const detailUpdatedItem = afterDetailUpdate.items.find((item) => item.readKey === initialItem.readKey)
    assert.equal(detailUpdatedItem?.isRead, true)

    await createInternalNotification({
      ...basePayload,
      severity: 'critical',
      title: 'Revisión crítica pendiente',
      message: 'La alerta escaló.'
    })
    const afterEscalation = await getSystemNotifications({ liveMetaCheck: false, limit: 100, userId })
    const escalatedItem = afterEscalation.items.find((item) => item.readKey === initialItem.readKey)
    assert.equal(escalatedItem?.isRead, false)
    assert.notEqual(escalatedItem?.version, initialItem.version)
  })

  it('marks the full internal history even when it is larger than the dropdown preview', async () => {
    const userId = await createTestUser()
    const total = 105

    for (let index = 0; index < total; index += 1) {
      await createInternalNotification({
        recipientUserIds: [userId],
        source: 'Historial de prueba',
        severity: 'info',
        title: `Aviso histórico ${index + 1}`,
        actionUrl: '/dashboard',
        category: 'notification_history_test',
        contactId: `history-contact-${index + 1}`,
        sendPushNotification: false
      })
    }

    const preview = await getSystemNotifications({ liveMetaCheck: false, limit: 30, userId })
    assert.equal(preview.items.filter((item) => item.source === 'Historial de prueba').length < total, true)

    await markAllSystemNotificationsRead({ userId })
    const stateCount = await db.get(
      `SELECT COUNT(*) AS total
       FROM notification_read_states
       WHERE user_id = ? AND notification_key LIKE 'internal:%'`,
      [userId]
    )
    assert.equal(Number(stateCount.total), total)
  })
})
