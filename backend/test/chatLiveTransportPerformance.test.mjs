import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const readFrontend = (path) => readFile(new URL(`../../frontend/src/${path}`, import.meta.url), 'utf8')

test('el stream publica salud y se declara stale si dejan de llegar heartbeats', async () => {
  const source = await readFrontend('services/chatLiveEventsService.ts')
  assert.match(source, /onStatusChange/)
  assert.match(source, /STREAM_STALE_AFTER_MS/)
  assert.match(source, /markActivity\(\)/)
  assert.match(source, /publishStatus\('connected'\)/)
  assert.match(source, /publishStatus\('stale'\)/)
  assert.match(source, /controller\?\.abort\(\)/)
})

test('Desktop y Phone sólo reconcilian agresivamente cuando SSE no está sano', async () => {
  const [desktop, phone] = await Promise.all([
    readFrontend('pages/DesktopChat/DesktopChat.tsx'),
    readFrontend('pages/PhoneChat/PhoneChat.tsx')
  ])

  for (const source of [desktop, phone]) {
    assert.match(source, /chatLiveConnectedRef/)
    assert.match(source, /status === 'connected'/)
    assert.match(source, /CHAT_FALLBACK_REFRESH_INTERVAL_MS = 30_000/)
    assert.match(source, /CHAT_HEALTHY_RECONCILE_INTERVAL_MS = 2 \* 60_000/)
  }
  assert.doesNotMatch(phone, /CHAT_OPEN_THREAD_REFRESH_INTERVAL_MS = 4000/)
  assert.doesNotMatch(desktop, /CHAT_REFRESH_INTERVAL_MS = 12000/)
})
