import { randomUUID } from 'crypto'
import { clearPresence } from './presenceService.js'

const HEARTBEAT_INTERVAL_MS = 25_000
const clients = new Map()

function userHasOtherClients(userId, exceptClientId) {
  if (!userId) return false
  for (const [id, client] of clients.entries()) {
    if (id !== exceptClientId && client.userId === userId) return true
  }
  return false
}

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
  res.flush?.()
  return true
}

function cleanupClient(clientId) {
  const client = clients.get(clientId)
  if (!client) return

  clearInterval(client.heartbeatId)
  clients.delete(clientId)

  // Respaldo de vida: si al usuario ya no le queda ninguna conexión viva,
  // limpiamos su presencia (aunque nunca haya llegado el "blur"). Con multi-tab
  // no la borramos si aún tiene otra pestaña abierta.
  if (client.userId && !userHasOtherClients(client.userId, clientId)) {
    clearPresence(client.userId)
  }
}

export function subscribeChatLiveEvents(req, res) {
  const clientId = randomUUID()
  const userId = cleanString(req.user?.userId)

  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.socket?.setNoDelay?.(true)
  res.flushHeaders?.()

  const heartbeatId = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      cleanupClient(clientId)
      return
    }
    res.write(`: heartbeat ${Date.now()}\n\n`)
    res.flush?.()
  }, HEARTBEAT_INTERVAL_MS)

  clients.set(clientId, { res, heartbeatId, userId })
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

export function publishChatDataChangedEvent(input = {}) {
  const contactId = cleanString(input.contactId)
  const domains = [...new Set((Array.isArray(input.domains) ? input.domains : [])
    .map(cleanString)
    .filter(domain => domain === 'appointments'))]
  if (!contactId || domains.length === 0 || clients.size === 0) return

  const payload = {
    type: 'chat_data_changed',
    contactId,
    domains,
    entityId: cleanString(input.entityId),
    changedAt: new Date().toISOString()
  }

  for (const [clientId, client] of clients.entries()) {
    try {
      writeSseEvent(client.res, 'chat_data_changed', payload)
    } catch {
      cleanupClient(clientId)
    }
  }
}

export function getChatLiveClientCount() {
  return clients.size
}
