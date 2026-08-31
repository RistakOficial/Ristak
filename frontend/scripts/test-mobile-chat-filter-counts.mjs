import assert from 'node:assert/strict'
import test from 'node:test'

import {
  countLoadedArchivedChatConversations,
  countUnreadChatConversations
} from '../src/utils/chatInboxCounts.ts'

test('los chips cuentan las conversaciones que realmente renderiza cada filtro', () => {
  const chats = [
    { id: 'unread-1', unreadCount: 1 },
    { id: 'unread-40', unreadCount: 40 },
    { id: 'archived-visible', unreadCount: 8 },
    { id: 'read', unreadCount: 0 },
  ]
  const archived = new Set([
    'archived-visible',
    'archived-stale-1',
    'archived-stale-2',
  ])

  assert.equal(
    countUnreadChatConversations(chats, archived, (contact) => contact.unreadCount),
    2
  )
  assert.equal(countLoadedArchivedChatConversations(chats, archived), 1)
  assert.equal(
    chats.reduce((total, contact) => (
      archived.has(contact.id) ? total : total + contact.unreadCount
    ), 0),
    41
  )
})

test('los registros que la bandeja normal excluye tampoco inflan sus contadores', () => {
  const chats = [
    { id: 'direct-message', unreadCount: 1, commentOnly: false },
    { id: 'comment-only', unreadCount: 5, commentOnly: true },
  ]
  const visible = (contact) => !contact.commentOnly

  assert.equal(
    countUnreadChatConversations(chats, new Set(), (contact) => contact.unreadCount, visible),
    1
  )
})
