import test from 'node:test'
import assert from 'node:assert/strict'
import { getHighLevelResponseStatus } from '../src/controllers/highlevelController.js'

test('HighLevel accepted outbound responses remain pending without a durable receipt', () => {
  assert.equal(getHighLevelResponseStatus({ messageId: 'msg_123' }), 'pending')
  assert.equal(getHighLevelResponseStatus({ data: { messageId: 'msg_456' } }), 'pending')
  assert.equal(getHighLevelResponseStatus({ status: 'sent' }), 'pending')
})

test('HighLevel provider queue states remain pending until a durable receipt arrives', () => {
  assert.equal(getHighLevelResponseStatus({ status: 'pending' }), 'pending')
  assert.equal(getHighLevelResponseStatus({ data: { status: 'queued' } }), 'pending')
  assert.equal(getHighLevelResponseStatus({ msg: 'Message queued for delivery' }), 'pending')
})

test('HighLevel terminal delivery states are preserved', () => {
  assert.equal(getHighLevelResponseStatus({ messageStatus: 'delivered' }), 'delivered')
  assert.equal(getHighLevelResponseStatus({ deliveryStatus: 'read' }), 'read')
  assert.equal(getHighLevelResponseStatus({ status: 'failed' }), 'failed')
})
