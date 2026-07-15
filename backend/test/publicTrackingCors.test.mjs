import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import cors from 'cors'
import {
  isPublicTrackingBrowserOrigin,
  isPublicTrackingCorsPath,
  publicTrackingCorsMiddleware
} from '../src/middleware/publicTrackingCors.js'

async function startTrackingServer(t) {
  const app = express()
  // Replica la allowlist privada global de server.js: el origen de la landing no
  // pertenece a ella, así que debe continuar hasta el CORS público del pixel.
  app.use(cors({
    origin: (origin, callback) => {
      callback(null, !origin || origin === 'https://raulgomez.onrender.com')
    },
    credentials: true
  }))
  app.use(publicTrackingCorsMiddleware)
  app.use(express.json())
  app.post('/collect', (_req, res) => res.json({ ok: true }))
  app.get('/sessions', (_req, res) => res.json({ private: true }))

  const server = createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

test('public tracking accepts normal http(s) page origins and rejects non-web origins', () => {
  assert.equal(isPublicTrackingBrowserOrigin('https://www.raulgomez.com.mx'), true)
  assert.equal(isPublicTrackingBrowserOrigin('https://raulgomez.com.mx'), true)
  assert.equal(isPublicTrackingBrowserOrigin('http://localhost:5173'), true)
  assert.equal(isPublicTrackingBrowserOrigin(undefined), true)
  assert.equal(isPublicTrackingBrowserOrigin('null'), false)
  assert.equal(isPublicTrackingBrowserOrigin('chrome-extension://abc123'), false)
  assert.equal(isPublicTrackingBrowserOrigin('https://example.com/path'), false)
})

test('public tracking CORS is scoped to exact public paths', () => {
  assert.equal(isPublicTrackingCorsPath('/collect'), true)
  assert.equal(isPublicTrackingCorsPath('/collect/'), true)
  assert.equal(isPublicTrackingCorsPath('/meta-param-builder-ip'), true)
  assert.equal(isPublicTrackingCorsPath('/sessions'), false)
  assert.equal(isPublicTrackingCorsPath('/analytics/summary'), false)
  assert.equal(isPublicTrackingCorsPath('/collect-attacker'), false)
})

test('public tracking preflight reflects the external page origin without credentials', async (t) => {
  const baseUrl = await startTrackingServer(t)
  const origin = 'https://www.raulgomez.com.mx'
  const response = await fetch(`${baseUrl}/collect`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  })

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.equal(response.headers.get('access-control-allow-credentials'), null)
  assert.match(response.headers.get('access-control-allow-methods') || '', /POST/)
  assert.match(response.headers.get('access-control-allow-headers') || '', /Content-Type/i)
  assert.match(response.headers.get('vary') || '', /Origin/i)
})

test('public tracking POST keeps CORS headers so the browser can complete collection', async (t) => {
  const baseUrl = await startTrackingServer(t)
  const origin = 'https://www.raulgomez.com.mx'
  const response = await fetch(`${baseUrl}/collect`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ visitor_id: 'visitor', session_id: 'session' })
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  assert.deepEqual(await response.json(), { ok: true })
})

test('public tracking does not grant browser CORS to extension origins', async (t) => {
  const baseUrl = await startTrackingServer(t)
  const response = await fetch(`${baseUrl}/collect`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'chrome-extension://abc123',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
  })

  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('private tracking routes never inherit public CORS headers', async (t) => {
  const baseUrl = await startTrackingServer(t)
  const response = await fetch(`${baseUrl}/sessions`, {
    headers: { Origin: 'https://www.raulgomez.com.mx' }
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})
