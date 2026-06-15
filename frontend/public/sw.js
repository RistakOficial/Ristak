const CACHE_NAME = 'ristak-branding-v20'
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
  '/logo-web-black-320.webp',
  '/logo-web-black-640.webp',
  '/logo-web-white-320.webp',
  '/logo-web-white-640.webp',
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

function getNotificationData(payload) {
  return {
    url: payload?.url || '/phone/chat',
    category: payload?.category || 'ristak',
    tag: payload?.tag || 'ristak-chat',
    messageId: payload?.messageId || '',
    contactId: payload?.contactId || ''
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

  const notificationData = getNotificationData(payload)

  event.waitUntil(
    Promise.all([
      notifyOpenClients(payload),
      self.registration.showNotification(getNotificationTitle(payload), {
        body: getNotificationBody(payload),
        icon: '/ristak-chat-icon-192.png',
        badge: '/ristak-chat-icon-192.png',
        tag: notificationData.tag,
        renotify: true,
        data: notificationData
      })
    ])
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const notificationData = event.notification.data || {}
  const targetUrl = notificationData.url || '/phone/chat'
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
