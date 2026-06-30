import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  beginDeployDrainWork,
  formatDeployDrainSnapshot,
  getDeployDrainSnapshot
} from '../src/utils/deployDrainTracker.js'
import {
  classifyDeployDrainRequest,
  isHealthRequest,
  shouldAllowDuringDeployDrain
} from '../src/utils/deployDrainPolicy.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function req(method, path) {
  return { method, path, originalUrl: path }
}

test('deploy drain policy allows public reads needed by sites and tracking', () => {
  assert.equal(classifyDeployDrainRequest(req('GET', '/snip.js')), 'http:public-read')
  assert.equal(classifyDeployDrainRequest(req('GET', '/api/tracking/snip.js')), 'http:public-read')
  assert.equal(classifyDeployDrainRequest(req('GET', '/landing-demo')), 'http:public-read')
  assert.equal(classifyDeployDrainRequest(req('HEAD', '/assets/index.js')), 'http:public-read')
})

test('deploy drain policy protects conversion and tracking writes', () => {
  assert.equal(classifyDeployDrainRequest(req('POST', '/collect')), 'http:tracking')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/tracking/video-event')), 'http:tracking')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/sites/public/submit')), 'http:tracking')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/sites/public/meta-event')), 'http:tracking')
})

test('deploy drain policy protects payment and webhook callbacks', () => {
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/stripe/webhook')), 'http:payment-webhook')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/mercadopago/webhook')), 'http:payment-webhook')
  assert.equal(classifyDeployDrainRequest(req('POST', '/webhook/payment')), 'http:webhook')
  assert.equal(classifyDeployDrainRequest(req('POST', '/webhooks/appointment')), 'http:webhook')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/stripe/public/payments/pay_123/intent')), 'http:public-payment')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/conekta/public/payments/pay_123/card')), 'http:public-payment')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/transactions/pay_123/record-payment')), 'http:business-mutation')
})

test('deploy drain policy protects appointments, integration reads, callbacks, and generic api mutations', () => {
  assert.equal(classifyDeployDrainRequest(req('GET', '/api/calendars/public/demo/free-slots')), 'http:appointments-read')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/calendars/public/demo/appointments')), 'http:appointments')
  assert.equal(classifyDeployDrainRequest(req('GET', '/api/meta/ad-accounts')), 'http:integration-read')
  assert.equal(classifyDeployDrainRequest(req('GET', '/api/highlevel/products')), 'http:integration-read')
  assert.equal(classifyDeployDrainRequest(req('GET', '/api/mercadopago/connect/callback')), 'http:integration-callback')
  assert.equal(classifyDeployDrainRequest(req('POST', '/api/meta/sync')), 'http:api-mutation')
  assert.equal(classifyDeployDrainRequest(req('PUT', '/api/sites/site_123')), 'http:api-mutation')
})

test('deploy drain policy keeps health special and keeps private traffic available during shutdown', () => {
  assert.equal(isHealthRequest(req('GET', '/api/health')), true)
  assert.equal(classifyDeployDrainRequest(req('GET', '/api/dashboard/stats')), 'http:api-read')
  assert.equal(shouldAllowDuringDeployDrain(req('GET', '/api/dashboard/stats')), true)
  assert.equal(shouldAllowDuringDeployDrain(req('POST', '/api/dashboard/recalculate')), true)
  assert.equal(shouldAllowDuringDeployDrain(req('GET', '/api/health')), false)
  assert.equal(shouldAllowDuringDeployDrain(req('GET', '/settings')), true)
})

test('deploy shutdown path does not expose a deploy blocker to user traffic', async () => {
  const source = await readFile(join(__dirname, '..', 'src', 'server.js'), 'utf8')
  assert.doesNotMatch(source, /Aplicación actualizándose/)
  assert.doesNotMatch(source, /startupState\.ready\s*=\s*false/)
  assert.match(source, /if \(shuttingDown && !isHealthRequest\(req\)\) \{\s+res\.set\('Connection', 'close'\)\s+\}/)
})

test('deploy drain tracker counts and formats active critical work', () => {
  const finishTracking = beginDeployDrainWork('http:tracking', 'POST /collect')
  const finishPayments = beginDeployDrainWork('cron:payment-automations', 'interval')

  let snapshot = getDeployDrainSnapshot()
  assert.equal(snapshot.total, 2)
  assert.equal(snapshot.byKind['http:tracking'], 1)
  assert.equal(snapshot.byKind['cron:payment-automations'], 1)
  assert.match(formatDeployDrainSnapshot(snapshot), /http:tracking:1/)
  assert.match(formatDeployDrainSnapshot(snapshot), /cron:payment-automations:1/)

  finishTracking()
  finishPayments()

  snapshot = getDeployDrainSnapshot()
  assert.equal(snapshot.total, 0)
  assert.equal(formatDeployDrainSnapshot(snapshot), 'sin trabajo critico activo')
})

test('deploy-sensitive crons keep distributed locks across deploy overlaps', async () => {
  const criticalCrons = [
    ['scheduledChatMessages.cron.js', "withCronLock('scheduled-chat-messages'"],
    ['contactBulkActions.cron.js', "withCronLock('contact-bulk-actions'"],
    ['paymentAutomations.cron.js', "withCronLock('payment-automations'"]
  ]

  for (const [file, expected] of criticalCrons) {
    const source = await readFile(join(__dirname, '..', 'src', 'jobs', file), 'utf8')
    assert.match(source, /trackDeployDrainWork\('cron:/)
    assert.ok(source.includes(expected), `${file} debe usar lock distribuido`)
  }
})
