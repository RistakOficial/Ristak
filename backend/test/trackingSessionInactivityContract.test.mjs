import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const readSource = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8')

test('public tracking runtimes only inherit a shared session cookie with fresh activity', async () => {
  const [trackingController, sitesService] = await Promise.all([
    readSource('../src/controllers/trackingController.js'),
    readSource('../src/services/sitesService.js')
  ])

  assert.match(trackingController, /SESSION_ACTIVITY_COOKIE_NAME = 'ristak_sid_at'/)
  assert.match(trackingController, /SESSION_INACTIVITY_MS = 30 \* 60 \* 1000/)
  assert.match(trackingController, /cookieLastActivity > 0[\s\S]{0,180}SESSION_INACTIVITY_MS/)
  assert.match(trackingController, /writeCookie\(SESSION_ACTIVITY_COOKIE_NAME, String\(now\)\)/)
  assert.doesNotMatch(trackingController, /sessionData\.session_id = cookieSessionId \|\|/)

  assert.equal((sitesService.match(/SESSION_ACTIVITY_COOKIE_NAME = 'ristak_sid_at'/g) || []).length, 2)
  assert.equal((sitesService.match(/cookieLastActivity > 0/g) || []).length, 2)
  assert.equal((sitesService.match(/writeCookie\(SESSION_ACTIVITY_COOKIE_NAME, String\(now\)\)/g) || []).length, 2)
  assert.doesNotMatch(sitesService, /(?:data|session)\.session_id = (?:!expired && )?cookieSessionId \|\|/)
})
