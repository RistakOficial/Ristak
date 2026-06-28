import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldRunHighLevelConversationsInBackground } from '../src/services/highlevelSyncService.js'

test('HighLevel manual sync moves heavy conversations to background', () => {
  assert.equal(
    shouldRunHighLevelConversationsInBackground({
      triggerSource: 'manual',
      estimate: { total: 101, unit: 'messages', useConversationBackfill: false }
    }),
    true
  )
  assert.equal(
    shouldRunHighLevelConversationsInBackground({
      triggerSource: 'manual',
      estimate: { total: 20, unit: 'conversations', useConversationBackfill: true }
    }),
    true
  )
  assert.equal(
    shouldRunHighLevelConversationsInBackground({
      triggerSource: 'manual',
      estimate: { total: 100, unit: 'messages', useConversationBackfill: false }
    }),
    false
  )
})

test('HighLevel cron sync keeps conversations silent and inline', () => {
  assert.equal(
    shouldRunHighLevelConversationsInBackground({
      triggerSource: 'cron',
      estimate: { total: 500, unit: 'messages', useConversationBackfill: false }
    }),
    false
  )
})
