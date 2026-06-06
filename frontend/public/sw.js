const CACHE_NAME = 'ristak-chat-v4'
const SHELL_ASSETS = [
  '/',
  '/phone/chat',
  '/phone/dashboard',
  '/phone/calendar',
  '/phone/payments',
  '/phone/agent-ai',
  '/manifest.webmanifest',
  '/logo.svg',
  '/ristak-chat-icon.svg',
  '/apple-touch-icon.png',
  '/ristak-chat-icon-192.png',
  '/ristak-chat-icon-512.png'
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

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Ristak',
    body: 'Tienes un aviso nuevo.',
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
    self.registration.showNotification(payload.title || 'Ristak', {
      body: payload.body || 'Tienes un aviso nuevo.',
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
