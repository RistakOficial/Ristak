import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  getChatLiveClientCount,
  publishChatMessageEvent,
  subscribeChatLiveEvents
} from '../src/services/chatLiveEventsService.js'

class FakeResponse extends EventEmitter {
  statusCode = 0
  headers = {}
  chunks = []
  writableEnded = false
  destroyed = false
  flushed = false

  status(code) {
    this.statusCode = code
    return this
  }

  set(headers) {
    this.headers = { ...this.headers, ...headers }
    return this
  }

  flushHeaders() {
    this.flushed = true
  }

  write(chunk) {
    this.chunks.push(String(chunk))
    return true
  }
}

test('streams chat message events to subscribed clients', () => {
  const req = new EventEmitter()
  const res = new FakeResponse()
  const cleanup = subscribeChatLiveEvents(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(getChatLiveClientCount(), 1)

  publishChatMessageEvent({
    contactId: 'contact_123',
    messageId: 'message_123',
    channel: 'whatsapp',
    direction: 'inbound',
    messageType: 'text',
    isNew: true
  })

  const output = res.chunks.join('')
  assert.match(output, /event: connected/)
  assert.match(output, /event: chat_message/)
  assert.match(output, /"contactId":"contact_123"/)
  assert.match(output, /"messageId":"message_123"/)

  cleanup()
  assert.equal(getChatLiveClientCount(), 0)
})
