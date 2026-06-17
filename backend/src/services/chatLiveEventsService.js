import { randomUUID } from 'crypto'

const HEARTBEAT_INTERVAL_MS = 25_000
const clients = new Map()

let eventSequence = 0

function cleanString(value) {
  return String(value || '').trim()
}

function nextEventId() {
  eventSequence += 1
  return String(eventSequence)
}

function writeSseEvent(res, event, data = {}) {
  if (res.writableEnded || res.destroyed) return false

  res.write(`id: ${nextEventId()}\n`)
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
  return true
}

function cleanupClient(clientId) {
  const client = clients.get(clientId)
  if (!client) return

  clearInterval(client.heartbeatId)
  clients.delete(clientId)
}

export function subscribeChatLiveEvents(req, res) {
  const clientId = randomUUID()

  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.flushHeaders?.()

  const heartbeatId = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanupClient(clientId)
      return
    }
    res.write(`: heartbeat ${Date.now()}\n\n`)
  }, HEARTBEAT_INTERVAL_MS)

  clients.set(clientId, { res, heartbeatId })
  writeSseEvent(res, 'connected', {
    connected: true,
    serverTime: new Date().toISOString()
  })

  const cleanup = () => cleanupClient(clientId)
  req.on('close', cleanup)
  res.on('close', cleanup)

  return cleanup
}

export function publishChatMessageEvent(input = {}) {
  const contactId = cleanString(input.contactId)
  if (!contactId || clients.size === 0) return

  const payload = {
    type: 'chat_message',
    contactId,
    messageId: cleanString(input.messageId),
    channel: cleanString(input.channel),
    provider: cleanString(input.provider),
    transport: cleanString(input.transport),
    direction: cleanString(input.direction),
    messageType: cleanString(input.messageType),
    messageTimestamp: cleanString(input.messageTimestamp),
    isNew: input.isNew !== false,
    receivedAt: new Date().toISOString()
  }

  for (const [clientId, client] of clients.entries()) {
    try {
      writeSseEvent(client.res, 'chat_message', payload)
    } catch {
      cleanupClient(clientId)
    }
  }
}

export function getChatLiveClientCount() {
  return clients.size
}
