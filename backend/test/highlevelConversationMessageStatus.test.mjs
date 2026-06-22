import test from 'node:test'
import assert from 'node:assert/strict'
import { getHighLevelResponseStatus } from '../src/controllers/highlevelController.js'

test('HighLevel accepted outbound responses are stored as sent by default', () => {
  assert.equal(getHighLevelResponseStatus({ messageId: 'msg_123' }), 'sent')
  assert.equal(getHighLevelResponseStatus({ data: { messageId: 'msg_456' } }), 'sent')
})

test('HighLevel provider queue states do not keep local chat bubbles pending', () => {
  assert.equal(getHighLevelResponseStatus({ status: 'pending' }), 'sent')
  assert.equal(getHighLevelResponseStatus({ data: { status: 'queued' } }), 'sent')
  assert.equal(getHighLevelResponseStatus({ msg: 'Message queued for delivery' }), 'sent')
})

test('HighLevel terminal delivery states are preserved', () => {
  assert.equal(getHighLevelResponseStatus({ messageStatus: 'delivered' }), 'delivered')
  assert.equal(getHighLevelResponseStatus({ deliveryStatus: 'read' }), 'read')
  assert.equal(getHighLevelResponseStatus({ status: 'failed' }), 'failed')
})
