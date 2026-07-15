import { apiUrl } from './apiBaseUrl'
import { invalidateRistakApiReadCache } from './authFetch'

export type PaymentLiveEventScope = 'transactions' | 'payment_plans' | 'subscriptions'
export type PaymentLiveEventType = 'payment_changed' | 'subscription_changed'

export interface PaymentLiveEvent {
  type: PaymentLiveEventType
  scopes?: PaymentLiveEventScope[]
  paymentId?: string
  publicPaymentId?: string
  subscriptionId?: string
  contactId?: string
  status?: string
  previousStatus?: string
  provider?: string
  method?: string
  receivedAt?: string
}

interface SubscribeOptions {
  onEvent: (event: PaymentLiveEvent) => void
  onError?: (error: unknown) => void
}

interface SseFrame {
  event: string
  data: string
}

const STREAM_ENDPOINT = '/api/payment-events/stream'
const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 15_000
const PAYMENT_LIVE_CACHE_PATHS = [
  '/api/transactions',
  '/api/subscriptions',
  '/api/dashboard',
  '/api/reports',
  '/api/contacts'
]

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

function normalizeScopes(value: unknown): PaymentLiveEventScope[] {
  if (!Array.isArray(value)) return []
  return value.filter((scope): scope is PaymentLiveEventScope => (
    scope === 'transactions' || scope === 'payment_plans' || scope === 'subscriptions'
  ))
}

function dispatchFrame(frame: string, options: SubscribeOptions) {
  const parsed = parseSseFrame(frame)
  if (!parsed || (parsed.event !== 'payment_changed' && parsed.event !== 'subscription_changed')) return

  try {
    const payload = JSON.parse(parsed.data)
    if (payload?.type !== 'payment_changed' && payload?.type !== 'subscription_changed') return

    invalidateRistakApiReadCache({ pathPrefixes: PAYMENT_LIVE_CACHE_PATHS })
    options.onEvent({
      ...payload,
      scopes: normalizeScopes(payload.scopes)
    } as PaymentLiveEvent)
  } catch (error) {
    options.onError?.(error)
  }
}

async function readEventStream(stream: ReadableStream<Uint8Array>, options: SubscribeOptions) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

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

export function subscribeToPaymentLiveEvents(options: SubscribeOptions) {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') {
    return () => undefined
  }

  let stopped = false
  let reconnectMs = INITIAL_RECONNECT_MS
  let reconnectTimer: number | null = null
  let controller: AbortController | null = null

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

    try {
      const response = await fetch(apiUrl(STREAM_ENDPOINT), {
        method: 'GET',
        headers: buildStreamHeaders(),
        signal: controller.signal
      })

      if (!response.ok || !response.body) {
        throw new Error(`Payment live stream unavailable: ${response.status}`)
      }

      reconnectMs = INITIAL_RECONNECT_MS
      await readEventStream(response.body, options)
    } catch (error) {
      if (!stopped && !controller?.signal.aborted) {
        options.onError?.(error)
      }
    } finally {
      controller = null
      scheduleReconnect()
    }
  }

  void connect()

  return () => {
    stopped = true
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
  }
}
