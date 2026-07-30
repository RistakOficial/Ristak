import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'

import { publicIngestionJsonMiddleware } from '../src/middleware/publicIngestionJson.js'

async function createFixture() {
  const app = express()
  app.use(publicIngestionJsonMiddleware)
  app.use(express.json({
    limit: '35mb',
    verify: (req, _res, buffer) => {
      req.rawBody = buffer.toString('utf8')
    }
  }))
  app.post([
    '/api/sites/public/form-progress',
    '/collect',
    '/api/tracking/collect',
    '/ordinary-json'
  ], (req, res) => {
    res.json({
      success: true,
      body: req.body,
      hasRawBody: Object.prototype.hasOwnProperty.call(req, 'rawBody')
    })
  })
  const server = http.createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve))
  }
}

async function postRaw(baseUrl, path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers,
    body
  })
  return {
    status: response.status,
    json: await response.json()
  }
}

test('form-progress is strict JSON, rejects compression, and never reaches the 35 MB raw-body parser', async () => {
  const fixture = await createFixture()
  try {
    const accepted = await postRaw(
      fixture.baseUrl,
      '/api/sites/public/form-progress',
      JSON.stringify({ attemptId: 'attempt-safe', events: [] }),
      { 'content-type': 'application/json' }
    )
    assert.equal(accepted.status, 200)
    assert.equal(accepted.json.hasRawBody, false)

    const unsupported = await postRaw(
      fixture.baseUrl,
      '/api/sites/public/form-progress',
      '{}',
      { 'content-type': 'text/plain' }
    )
    assert.equal(unsupported.status, 415)
    assert.equal(unsupported.json.code, 'PUBLIC_FORM_PROGRESS_JSON_REQUIRED')

    const compressed = await postRaw(
      fixture.baseUrl,
      '/api/sites/public/form-progress',
      '{}',
      {
        'content-type': 'application/json',
        'content-encoding': 'gzip'
      }
    )
    assert.equal(compressed.status, 415)
    assert.equal(compressed.json.code, 'PUBLIC_FORM_PROGRESS_ENCODING_UNSUPPORTED')

    const primitive = await postRaw(
      fixture.baseUrl,
      '/api/sites/public/form-progress',
      '"not-an-object"',
      { 'content-type': 'application/json' }
    )
    assert.equal(primitive.status, 400)
    assert.equal(primitive.json.code, 'PUBLIC_FORM_PROGRESS_JSON_INVALID')

    const oversized = await postRaw(
      fixture.baseUrl,
      '/api/sites/public/form-progress',
      JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
      { 'content-type': 'application/json' }
    )
    assert.equal(oversized.status, 413)
    assert.equal(oversized.json.code, 'PUBLIC_FORM_PROGRESS_BODY_TOO_LARGE')
  } finally {
    await fixture.close()
  }
})

test('/collect and its mounted alias use a 50 KB JSON parser without changing valid payloads', async () => {
  const fixture = await createFixture()
  try {
    for (const path of ['/collect', '/api/tracking/collect']) {
      const accepted = await postRaw(
        fixture.baseUrl,
        path,
        JSON.stringify({ visitor_id: 'visitor-safe', data: { event_id: 'event-safe' } }),
        { 'content-type': 'application/json' }
      )
      assert.equal(accepted.status, 200)
      assert.equal(accepted.json.body.visitor_id, 'visitor-safe')
      assert.equal(accepted.json.hasRawBody, false)

      const oversized = await postRaw(
        fixture.baseUrl,
        path,
        JSON.stringify({ padding: 'x'.repeat(55 * 1024) }),
        { 'content-type': 'application/json' }
      )
      assert.equal(oversized.status, 413)
      assert.equal(oversized.json.code, 'PUBLIC_TRACKING_COLLECT_BODY_TOO_LARGE')
    }

    const ordinary = await postRaw(
      fixture.baseUrl,
      '/ordinary-json',
      JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
      { 'content-type': 'application/json' }
    )
    assert.equal(ordinary.status, 200)
    assert.equal(ordinary.json.hasRawBody, true)
  } finally {
    await fixture.close()
  }
})
