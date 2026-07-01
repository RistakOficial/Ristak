import test from 'node:test'
import assert from 'node:assert/strict'

import { getMetaWebhookInfo } from '../src/controllers/metaController.js'
import {
  resolvePublicServiceBaseUrl,
  resolvePublicServiceHost
} from '../src/utils/publicUrl.js'

const ENV_KEYS = ['RENDER_EXTERNAL_URL', 'PUBLIC_URL']

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function createRequest({
  host = 'cliente.onrender.com',
  protocol = 'http',
  forwardedHost = '',
  forwardedProto = 'https'
} = {}) {
  const headers = {
    host,
    ...(forwardedHost ? { 'x-forwarded-host': forwardedHost } : {}),
    ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {})
  }

  return {
    headers,
    protocol,
    get(name) {
      return headers[String(name || '').toLowerCase()]
    }
  }
}

function createJsonResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.payload = payload
      return this
    }
  }
}

test('public service URL prefers the current public request host over configured fallbacks', () => {
  const previousEnv = snapshotEnv()

  try {
    process.env.RENDER_EXTERNAL_URL = 'https://stale-service.onrender.com'
    const req = createRequest({ host: 'cliente-real.onrender.com' })

    assert.equal(
      resolvePublicServiceBaseUrl(req, [process.env.RENDER_EXTERNAL_URL]),
      'https://cliente-real.onrender.com'
    )
    assert.equal(
      resolvePublicServiceHost(req, [process.env.RENDER_EXTERNAL_URL]),
      'cliente-real.onrender.com'
    )
  } finally {
    restoreEnv(previousEnv)
  }
})

test('public service URL falls back to Render when request host is local', () => {
  const previousEnv = snapshotEnv()

  try {
    process.env.RENDER_EXTERNAL_URL = 'https://cliente-real.onrender.com'
    const req = createRequest({
      host: 'localhost:3001',
      forwardedProto: '',
      protocol: 'http'
    })

    assert.equal(
      resolvePublicServiceBaseUrl(req, [process.env.RENDER_EXTERNAL_URL]),
      'https://cliente-real.onrender.com'
    )
  } finally {
    restoreEnv(previousEnv)
  }
})

test('Meta webhook info uses the detected service host for the callback URL', async () => {
  const previousEnv = snapshotEnv()

  try {
    process.env.RENDER_EXTERNAL_URL = 'https://stale-service.onrender.com'
    const req = createRequest({ host: 'cliente-real.onrender.com' })
    const res = createJsonResponse()

    await getMetaWebhookInfo(req, res)

    assert.equal(res.statusCode, 200)
    assert.equal(res.payload.success, true)
    assert.equal(res.payload.data.webhookUrl, 'https://cliente-real.onrender.com/webhook/meta')
  } finally {
    restoreEnv(previousEnv)
  }
})
