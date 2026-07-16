import { apiUrl } from './apiBaseUrl'
import { invalidateRistakApiReadCache } from './authFetch'

export interface ChatLiveMessageEvent {
  type: 'chat_message'
  contactId: string
  messageId?: string
  channel?: string
  provider?: string
  transport?: string
  direction?: string
  messageType?: string
  messageTimestamp?: string
  isNew?: boolean
  receivedAt?: string
}

export interface ChatLiveDataChangedEvent {
  type: 'chat_data_changed'
  contactId: string
  domains: string[]
  entityId?: string
  changedAt?: string
}

export type ChatLiveEvent = ChatLiveMessageEvent | ChatLiveDataChangedEvent

interface SubscribeOptions {
  onMessage: (event: ChatLiveMessageEvent) => void
  onDataChanged?: (event: ChatLiveDataChangedEvent) => void
  onError?: (error: unknown) => void
  onStatusChange?: (status: ChatLiveConnectionStatus) => void
}

export type ChatLiveConnectionStatus = 'connecting' | 'connected' | 'stale' | 'disconnected'

interface SseFrame {
  event: string
  data: string
}

const STREAM_ENDPOINT = '/api/chat-events/stream'
const VIEWING_ENDPOINT = '/api/chat-events/viewing'
const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 15_000
const STREAM_STALE_AFTER_MS = 55_000
const STREAM_WATCHDOG_INTERVAL_MS = 10_000
const CHAT_LIVE_CACHE_PATHS = [
  '/api/contacts',
  '/api/highlevel/conversations',
  '/api/dashboard',
  '/api/reports'
]
const CHAT_APPOINTMENT_CACHE_PATHS = [
  '/api/calendars',
  '/api/contacts',
  '/api/dashboard',
  '/api/reports',
  '/api/tracking/analytics'
]
const CHAT_SCHEDULED_MESSAGE_CACHE_PATHS = [
  '/api/whatsapp-api/messages/scheduled'
]

// Presencia: le avisa al backend qué contacto tiene abierto este usuario y si la
// app está al frente. Con esto, cuando llega un mensaje, NO se le manda push a
// quien ya lo está viendo (y solo a él). contactId null / foreground false =>
// deja de suprimir. Es best-effort: si falla la red, no rompemos nada.
export function reportViewing(contactId: string | null, foreground: boolean): void {
  if (typeof fetch === 'undefined') return
  const headers = new Headers()
  headers.set('Content-Type', 'application/json')
  try {
    const token = window.localStorage.getItem('auth_token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
  } catch {
    // Storage no disponible en contextos restringidos.
  }
  try {
    void fetch(apiUrl(VIEWING_ENDPOINT), {
      method: 'POST',
      headers,
      body: JSON.stringify({ contactId: contactId || '', foreground: foreground !== false }),
      keepalive: true
    }).catch(() => undefined)
  } catch {
    // Nunca romper el chat por un fallo de reporte de presencia.
  }
}

function buildStreamHeaders() {
  const headers = new Headers()
  headers.set('Accept', 'text/event-stream')

  try {
    const token = window.localStorage.getItem('auth_token')
    if (token) headers.set('Authorization', `Bearer ${token}`)
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }

  return headers
}

function parseSseFrame(frame: string): SseFrame | null {
  const lines = frame.split(/\r?\n/)
  let event = 'message'
  const data: string[] = []

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue
    const separatorIndex = line.indexOf(':')
    const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line
    const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : ''
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue

    if (field === 'event') event = value || 'message'
    if (field === 'data') data.push(value)
  }

  if (data.length === 0) return null
  return { event, data: data.join('\n') }
}

function dispatchFrame(frame: string, options: SubscribeOptions) {
  const parsed = parseSseFrame(frame)
  if (!parsed) return

  try {
    const payload = JSON.parse(parsed.data)
    if (
      parsed.event === 'chat_data_changed' &&
      payload?.type === 'chat_data_changed' &&
      typeof payload.contactId === 'string' &&
      payload.contactId.trim() &&
      Array.isArray(payload.domains)
    ) {
      if (payload.domains.includes('appointments')) {
        invalidateRistakApiReadCache({
          pathPrefixes: CHAT_APPOINTMENT_CACHE_PATHS,
          abortInflight: false
        })
      }
      if (payload.domains.includes('scheduled_messages')) {
        invalidateRistakApiReadCache({
          pathPrefixes: CHAT_SCHEDULED_MESSAGE_CACHE_PATHS,
          abortInflight: false
        })
      }
      options.onDataChanged?.(payload as ChatLiveDataChangedEvent)
      return
    }
    if (parsed.event !== 'chat_message') return
    if (payload?.type === 'chat_message' && typeof payload.contactId === 'string' && payload.contactId.trim()) {
      invalidateRistakApiReadCache({
        pathPrefixes: CHAT_LIVE_CACHE_PATHS,
        abortInflight: false
      })
      options.onMessage(payload as ChatLiveMessageEvent)
    }
  } catch (error) {
    options.onError?.(error)
  }
}

async function readEventStream(
  stream: ReadableStream<Uint8Array>,
  options: SubscribeOptions,
  onActivity: () => void
) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity()

      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split(/\r?\n\r?\n/)
      buffer = frames.pop() || ''

      for (const frame of frames) {
        dispatchFrame(frame, options)
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function subscribeToChatLiveEvents(options: SubscribeOptions) {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return () => undefined
  }

  let stopped = false
  let reconnectMs = INITIAL_RECONNECT_MS
  let reconnectTimer: number | null = null
  let watchdogTimer: number | null = null
  let controller: AbortController | null = null
  let lastActivityAt = 0
  let currentStatus: ChatLiveConnectionStatus | null = null

  const publishStatus = (status: ChatLiveConnectionStatus) => {
    if (currentStatus === status) return
    currentStatus = status
    options.onStatusChange?.(status)
  }

  const stopWatchdog = () => {
    if (watchdogTimer !== null) {
      window.clearInterval(watchdogTimer)
      watchdogTimer = null
    }
  }

  const markActivity = () => {
    lastActivityAt = Date.now()
    publishStatus('connected')
  }

  const startWatchdog = () => {
    stopWatchdog()
    watchdogTimer = window.setInterval(() => {
      if (!lastActivityAt || Date.now() - lastActivityAt <= STREAM_STALE_AFTER_MS) return
      publishStatus('stale')
      controller?.abort()
    }, STREAM_WATCHDOG_INTERVAL_MS)
  }

  const scheduleReconnect = () => {
    if (stopped) return
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, reconnectMs)
    reconnectMs = Math.min(reconnectMs * 2, MAX_RECONNECT_MS)
  }

  const connect = async () => {
    if (stopped) return

    controller = new AbortController()
    publishStatus('connecting')

    try {
      const response = await fetch(apiUrl(STREAM_ENDPOINT), {
        method: 'GET',
        headers: buildStreamHeaders(),
        signal: controller.signal
      })

      if (!response.ok || !response.body) {
        throw new Error(`Chat live stream unavailable: ${response.status}`)
      }

      reconnectMs = INITIAL_RECONNECT_MS
      markActivity()
      startWatchdog()
      await readEventStream(response.body, options, markActivity)
    } catch (error) {
      if (!stopped && !controller?.signal.aborted) {
        options.onError?.(error)
      }
    } finally {
      stopWatchdog()
      controller = null
      if (!stopped) publishStatus('disconnected')
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    stopped = true
    stopWatchdog()
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
    publishStatus('disconnected')
  }
}
