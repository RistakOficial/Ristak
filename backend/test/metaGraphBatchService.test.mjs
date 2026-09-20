import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { API_URLS } from '../src/config/constants.js'
import { logger } from '../src/utils/logger.js'
import { fetchMetaObjectsById } from '../src/services/metaGraphBatchService.js'

async function withGraphServer(handler, run) {
  const descriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const params = new URLSearchParams(body)
    const request = {
      method: req.method,
      url: new URL(req.url, 'http://127.0.0.1'),
      headers: req.headers,
      params,
      batch: JSON.parse(params.get('batch') || '[]')
    }
    requests.push(request)
    const reply = handler(request, requests.length)
    if (reply.disconnect) return req.socket.destroy()
    res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply.data))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${server.address().port}/v25.0`, configurable: true
    })
    await run(requests)
  } finally {
    await new Promise(resolve => server.close(resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', descriptor)
  }
}

function successFor(batch) {
  return batch.map(operation => ({
    code: 200,
    body: JSON.stringify({ id: decodeURIComponent(operation.relative_url.split('?')[0]) })
  }))
}

test('Graph consulta objetos por lote sin ids, deduplica y respeta el limite de 50', async () => {
  const ids = Array.from({ length: 103 }, (_, index) => String(1000 + index))
  await withGraphServer(({ batch }) => ({ data: successFor(batch) }), async requests => {
    const result = await fetchMetaObjectsById(
      [...ids, ' 1000 ', 1001, '', null], 'id,creative{id,image_url}', 'local-test-token', 'local-test-proof'
    )
    assert.deepEqual([...result.keys()], ids)
    assert.deepEqual(requests.map(request => request.batch.length), [50, 50, 3])
    for (const request of requests) {
      assert.equal(request.method, 'POST')
      assert.equal(request.url.pathname, '/v25.0')
      assert.equal(request.url.search, '')
      assert.match(request.headers['content-type'], /application\/x-www-form-urlencoded/)
      assert.equal(request.params.get('access_token'), 'local-test-token')
      assert.equal(request.params.get('appsecret_proof'), 'local-test-proof')
      assert.equal(request.params.get('include_headers'), 'false')
      assert.equal(request.headers['if-none-match'], undefined)
      for (const key of ['ids', 'pretty', 'debug', 'date_format']) assert.equal(request.params.has(key), false)
      for (const operation of request.batch) {
        const url = new URL(operation.relative_url, 'https://graph.facebook.com/')
        assert.equal(operation.method, 'GET')
        assert.notEqual(url.pathname, '/')
        assert.equal(url.searchParams.get('fields'), 'id,creative{id,image_url}')
        assert.equal(url.searchParams.get('appsecret_proof'), 'local-test-proof')
        assert.equal(url.searchParams.has('access_token'), false)
        for (const key of ['ids', 'pretty', 'debug', 'date_format']) assert.equal(url.searchParams.has(key), false)
      }
    }
  })
})

test('Graph conserva resultados validos entre permisos denegados, timeouts y cuerpos invalidos', async t => {
  const warnings = []
  t.mock.method(logger, 'warn', message => warnings.push(message))
  await withGraphServer(() => ({ data: [
    { code: 200, body: JSON.stringify({ id: 'first' }) },
    { code: 403, body: JSON.stringify({ error: { message: 'Rejected ?access_token=private-token&appsecret_proof=private-proof' } }) },
    null,
    { code: 200, body: '{invalid JSON with private-token' },
    { code: 200, body: JSON.stringify({ error: { message: 'Object unavailable' } }) },
    { code: 200, body: JSON.stringify({ id: 'wrong-object' }) },
    { code: 200, body: 'null' },
    { code: 200, body: '[]' },
    { code: 200, body: JSON.stringify({ id: 'last' }) }
  ] }), async () => {
    const result = await fetchMetaObjectsById(
      ['first', 'denied', 'timeout', 'invalid', 'error', 'mismatch', 'null', 'array', 'last', 'missing'],
      'id', 'local-test-token'
    )
    assert.deepEqual([...result.keys()], ['first', 'last'])
    assert.equal(warnings.length, 8)
    assert.doesNotMatch(warnings.join('\n'), /private-token|private-proof/)
  })
})

test('un lote rechazado, malformado o sin conexion no impide leer los lotes restantes', async t => {
  t.mock.method(logger, 'warn', () => {})
  const ids = Array.from({ length: 151 }, (_, index) => String(2000 + index))
  await withGraphServer(({ batch }, count) => {
    if (count === 1) return { status: 503, data: { error: { message: 'Try later' } } }
    if (count === 2) return { data: { unexpected: true } }
    if (count === 3) return { disconnect: true }
    return { data: successFor(batch) }
  }, async requests => {
    const result = await fetchMetaObjectsById(ids, 'id', 'local-test-token')
    assert.deepEqual([...result.keys()], [ids[150]])
    assert.equal(requests.length, 4)
    assert.equal(requests[3].params.has('appsecret_proof'), false)
  })
})

test('Graph no hace solicitudes si no hay objetos y codifica los IDs como un solo segmento', async () => {
  await withGraphServer(({ batch }) => ({ data: successFor(batch) }), async requests => {
    assert.equal((await fetchMetaObjectsById(['', null, undefined], 'id', 'local-test-token')).size, 0)
    assert.equal(requests.length, 0)
    const id = 'object/with?reserved&characters'
    const result = await fetchMetaObjectsById([id], 'id', 'local-test-token')
    assert.equal(result.get(id)?.id, id)
    assert.ok(requests[0].batch[0].relative_url.startsWith(`${encodeURIComponent(id)}?`))
  })
})
