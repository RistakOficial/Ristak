const CACHE_NAME = 'ristak-branding-v14'
const DEFAULT_NOTIFICATION_TITLE = 'Notificación nueva'
const DEFAULT_NOTIFICATION_BODY = 'Tienes una notificación nueva.'
const SHELL_ASSETS = [
  '/',
  '/phone/chat',
  '/phone/dashboard',
  '/phone/calendar',
  '/phone/payments',
  '/phone/agent-ai',
  '/manifest.webmanifest',
  '/manifest.phone.webmanifest',
  '/manifest.phone-chat.webmanifest',
  '/favicon.svg',
  '/logo.svg',
  '/ristak-icon-192.png',
  '/ristak-icon-512.png',
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

  if (request.method !== 'GET') return
  if (new URL(request.url).pathname.startsWith('/api/')) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined)
        return response
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('/')))
  )
})

function cleanNotificationText(value, fallback = '') {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim()
}

function stripAppNameFromNotificationText(value, fallback = '') {
  return cleanNotificationText(value, fallback)
    .replace(/\s+(?:from|de)\s+Ristak(?:\s+Chat)?$/i, '')
    .replace(/^Ristak(?:\s+Chat)?\s*[:\-–]\s*/i, '')
    .trim()
}

function isAppNameNotificationText(value) {
  const text = cleanNotificationText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase()

  return text === 'ristak' || text === 'ristak chat' || text === 'from ristak' || text === 'from ristak chat'
}

function getNotificationTitle(payload) {
  const fallback = payload?.category === 'chat' ? 'WhatsApp' : DEFAULT_NOTIFICATION_TITLE
  const title = stripAppNameFromNotificationText(payload?.title, fallback)
  return title && !isAppNameNotificationText(title) ? title : fallback
}

function getNotificationBody(payload) {
  const body = stripAppNameFromNotificationText(payload?.body, DEFAULT_NOTIFICATION_BODY)
  return body && !isAppNameNotificationText(body) ? body : DEFAULT_NOTIFICATION_BODY
}

self.addEventListener('push', (event) => {
  let payload = {
    title: DEFAULT_NOTIFICATION_TITLE,
    body: DEFAULT_NOTIFICATION_BODY,
    url: '/phone/chat'
  }

  try {
    payload = {
      ...payload,
      ...(event.data ? event.data.json() : {})
    }
  } catch {
    payload.body = event.data ? event.data.text() : payload.body
  }

  event.waitUntil(
    self.registration.showNotification(getNotificationTitle(payload), {
      body: getNotificationBody(payload),
      icon: '/ristak-chat-icon-192.png',
      badge: '/ristak-chat-icon-192.png',
      tag: payload.tag || 'ristak-chat',
      renotify: true,
      data: {
        url: payload.url || '/phone/chat'
      }
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/phone/chat'
  const normalizedTarget = new URL(targetUrl, self.location.origin)

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        const clientUrl = new URL(client.url)
        if (clientUrl.pathname === normalizedTarget.pathname && 'focus' in client) {
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
