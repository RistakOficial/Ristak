const CACHE_NAME = 'ristak-branding-v29'
const DEFAULT_NOTIFICATION_TITLE = 'Notificación nueva'
const DEFAULT_NOTIFICATION_BODY = 'Tienes una notificación nueva.'
const LATEST_NOTIFICATION_TAG = 'ristak-latest-notification'
const APP_NAME_TEXT_PATTERN = '(?:Ristak|Ristack|Reistak|Reistack)'
const APP_NAME_NOTIFICATION_TEXTS = new Set([
  'ristak',
  'ristak app',
  'ristak chat',
  'app ristak',
  'de ristak',
  'from ristak',
  'from ristak chat',
  'ristack',
  'ristack app',
  'ristack chat',
  'de ristack',
  'from ristack',
  'reistak',
  'reistak app',
  'reistak chat',
  'de reistak',
  'from reistak',
  'reistack',
  'reistack app',
  'reistack chat',
  'de reistack',
  'from reistack'
])
const NOTIFICATION_TITLE_EMOJI_BY_TEXT = new Map([
  ['Pago recibido', '💸'],
  ['Pago rechazado', '❌'],
  ['Pago requiere atención', '⚠️'],
  ['Pago pendiente', '⏳'],
  ['Pago parcial', '🧾'],
  ['Pago vencido', '⏰'],
  ['Pago reembolsado', '↩️'],
  ['Pago cancelado', '❌'],
  ['Pago programado', '📅'],
  ['Pago enviado', '📤'],
  ['Pago creado', '🧾'],
  ['Pago actualizado', '💳'],
  ['Cita agendada', '📅'],
  ['Cita confirmada', '✅'],
  ['Cita reprogramada', '↩️'],
  ['Cita cancelada', '❌'],
  ['Cita sin asistencia', '⚠️'],
  ['Cita actualizada', '📅']
])
const NOTIFICATION_TITLE_EMOJI_PREFIXES = Array.from(
  new Set(NOTIFICATION_TITLE_EMOJI_BY_TEXT.values())
)
const SHELL_ASSETS = [
  '/',
  '/movil/login',
  '/movil',
  '/movil/dashboard',
  '/movil/calendar',
  '/movil/payments',
  '/movil/agent-ai',
  '/manifest.webmanifest',
  '/manifest.phone.webmanifest',
  '/manifest.phone-chat.webmanifest',
  '/favicon.svg',
  '/logo-web-black-320.webp',
  '/logo-web-black-640.webp',
  '/logo-web-white-320.webp',
  '/logo-web-white-640.webp',
  '/ristak-app-mark-blue-192.webp',
  '/ristak-app-mark-blue-384.webp',
  '/ristak-app-mark-blue-768.webp',
  '/ristak-app-mark-white-192.webp',
  '/ristak-app-mark-white-384.webp',
  '/ristak-app-mark-white-768.webp',
  '/ristak-icon-192.png',
  '/ristak-icon-512.png',
  '/ristak-icon-dark-512.png',
  '/apple-touch-icon.png',
  '/ristak-chat-apple-touch-icon.png',
  '/ristak-chat-icon-192.png',
  '/ristak-chat-icon-512.png',
  '/ristak-chat-home-apple-touch-icon.png',
  '/ristak-chat-home-icon-192.png',
  '/ristak-chat-home-icon-512.png',
  '/ristak-chat-home-icon.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .catch(() => undefined)
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const requestUrl = new URL(request.url)
  const isAppAsset = requestUrl.origin === self.location.origin && requestUrl.pathname.startsWith('/assets/')
  const isNavigationRequest = request.mode === 'navigate'

  if (request.method !== 'GET') return
  if (requestUrl.pathname.startsWith('/api/')) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        const contentType = response.headers.get('content-type') || ''

        if (isAppAsset && contentType.includes('text/html')) {
          return new Response('', { status: 404, statusText: 'Static asset not found' })
        }

        if (response.ok && requestUrl.origin === self.location.origin) {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined)
        }

        return response
      })
      .catch(() => caches.match(request).then((cached) => {
        if (cached) return cached
        if (isAppAsset) return new Response('', { status: 504, statusText: 'Static asset unavailable' })
        if (isNavigationRequest) return caches.match('/')
        return new Response('', { status: 504, statusText: 'Network unavailable' })
      }))
  )
})

function cleanNotificationText(value, fallback = '') {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim()
}

function stripAppNameFromNotificationText(value, fallback = '') {
  return cleanNotificationText(value, fallback)
    .replace(new RegExp(`\\s+(?:from|de)\\s+${APP_NAME_TEXT_PATTERN}(?:\\s+(?:Chat|App))?$`, 'i'), '')
    .replace(new RegExp(`^${APP_NAME_TEXT_PATTERN}(?:\\s+(?:Chat|App))?\\s*[:\\-–]\\s*`, 'i'), '')
    .trim()
}

function isAppNameNotificationText(value) {
  const text = cleanNotificationText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()

  return APP_NAME_NOTIFICATION_TEXTS.has(text)
}

function titleStartsWithNotificationEmoji(value) {
  const text = cleanNotificationText(value)
  return NOTIFICATION_TITLE_EMOJI_PREFIXES.some((emoji) => text.startsWith(`${emoji} `))
}

function addNotificationTitleEmoji(value) {
  const title = cleanNotificationText(value)
  if (!title || titleStartsWithNotificationEmoji(title)) return title
  const emoji = NOTIFICATION_TITLE_EMOJI_BY_TEXT.get(title)
  return emoji ? `${emoji} ${title}` : title
}

function getNotificationTitle(payload) {
  const fallback = payload?.category === 'chat' ? 'Mensaje nuevo' : DEFAULT_NOTIFICATION_TITLE
  const title = stripAppNameFromNotificationText(payload?.title, fallback)
  const safeTitle = title && !isAppNameNotificationText(title) ? title : fallback
  return addNotificationTitleEmoji(safeTitle)
}

function getNotificationBody(payload) {
  const body = stripAppNameFromNotificationText(payload?.body, DEFAULT_NOTIFICATION_BODY)
  return body && !isAppNameNotificationText(body) ? body : DEFAULT_NOTIFICATION_BODY
}

function getNotificationData(payload) {
  const imageUrl = getNotificationImageUrl(payload)
  return {
    url: payload?.url || '/movil',
    category: payload?.category || 'ristak',
    tag: payload?.tag || 'ristak-chat',
    sourceTag: payload?.tag || '',
    messageId: payload?.messageId || '',
    contactId: payload?.contactId || '',
    contactAvatarUrl: imageUrl,
    notificationImageUrl: imageUrl
  }
}

function getNotificationImageUrl(payload) {
  const raw = String(
    payload?.contactAvatarUrl ||
    payload?.notificationImageUrl ||
    ''
  ).trim()
  if (!raw || /^data:/i.test(raw) || /^file:/i.test(raw)) return ''
  try {
    const parsed = new URL(raw, self.location.origin)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') ? parsed.href : ''
  } catch {
    return ''
  }
}

function notifyOpenClients(payload) {
  const data = getNotificationData(payload)
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
    clientList.forEach((client) => {
      client.postMessage({
        type: 'ristak:push-notification',
        payload: data
      })
    })
  }).catch(() => undefined)
}

self.addEventListener('push', (event) => {
  let payload = {
    title: DEFAULT_NOTIFICATION_TITLE,
    body: DEFAULT_NOTIFICATION_BODY,
    url: '/movil'
  }

  try {
    payload = {
      ...payload,
      ...(event.data ? event.data.json() : {})
    }
  } catch {
    payload.body = event.data ? event.data.text() : payload.body
  }

  const notificationData = getNotificationData(payload)
  const notificationImageUrl = getNotificationImageUrl(payload)

  event.waitUntil(
    Promise.all([
      notifyOpenClients(payload),
      self.registration.showNotification(getNotificationTitle(payload), {
        body: getNotificationBody(payload),
        icon: notificationImageUrl || '/ristak-chat-icon-192.png',
        ...(notificationImageUrl ? { image: notificationImageUrl } : {}),
        badge: '/ristak-chat-icon-192.png',
        tag: LATEST_NOTIFICATION_TAG,
        renotify: true,
        data: notificationData
      })
    ])
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const notificationData = event.notification.data || {}
  const targetUrl = notificationData.url || '/movil'
  const normalizedTarget = new URL(targetUrl, self.location.origin)

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const clientUrl = new URL(client.url)
        if (clientUrl.pathname === normalizedTarget.pathname && 'focus' in client) {
          client.postMessage({
            type: 'ristak:push-notification',
            payload: notificationData
          })
          if ('navigate' in client && clientUrl.href !== normalizedTarget.href) {
            return client.navigate(normalizedTarget.href).then(() => client.focus())
          }
          return client.focus()
        }
      }

      if (self.clients.openWindow) {
        return self.clients.openWindow(normalizedTarget.href)
      }

      return undefined
    })
  )
})
