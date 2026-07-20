import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { PRODUCT_POST_WEBHOOK_SCHEMA } from '../src/contracts/productPostWebhookContract.js'

test('el health y el emisor publican el mismo contrato de webhook de producto', () => {
  assert.equal(PRODUCT_POST_WEBHOOK_SCHEMA, 'ristak.product-payment.v1')

  const serverSource = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8')
  const serviceSource = fs.readFileSync(new URL('../src/services/productPostWebhookService.js', import.meta.url), 'utf8')
  assert.match(serverSource, /productPostWebhook:\s*PRODUCT_POST_WEBHOOK_SCHEMA/)
  assert.match(serviceSource, /X-Ristak-Webhook-Schema': PRODUCT_POST_WEBHOOK_SCHEMA/)
})
