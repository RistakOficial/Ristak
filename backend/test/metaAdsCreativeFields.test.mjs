import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { API_URLS } from '../src/config/constants.js'
import { fetchMetaCreativeMediaForAds } from '../src/services/metaAdsService.js'

test('Meta Ads carga imagenes con campos validos mediante GET por objeto dentro de un lote', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, url: req.url, params: new URLSearchParams(body) })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify([{
      code: 200,
      body: JSON.stringify({
        id: 'ad-creative-fields-test',
        creative: {
          id: 'creative-fields-test',
          object_type: 'PHOTO',
          image_url: 'https://cdn.example.test/creative.jpg',
          thumbnail_url: 'https://cdn.example.test/creative-thumb.jpg'
        }
      })
    }]))
  })

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${server.address().port}`,
      configurable: true
    })

    const media = await fetchMetaCreativeMediaForAds(['ad-creative-fields-test'], 'token-test')
    assert.equal(media.get('ad-creative-fields-test')?.creative_image_url, 'https://cdn.example.test/creative.jpg')

    assert.equal(requests.length, 1)
    assert.equal(requests[0].method, 'POST')
    assert.equal(requests[0].url, '/')
    const batch = JSON.parse(requests[0].params.get('batch'))
    assert.equal(batch.length, 1)
    assert.equal(batch[0].method, 'GET')
    const requestUrl = new URL(batch[0].relative_url, 'http://127.0.0.1')
    assert.equal(requestUrl.pathname, '/ad-creative-fields-test')
    assert.equal(requestUrl.searchParams.has('ids'), false)
    const fields = requestUrl.searchParams.get('fields') || ''
    assert.match(fields, /creative\{/)
    assert.doesNotMatch(fields, /preview_url/)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})

test('Meta Ads resuelve videos compartidos y hashes de imagen sin descartar anuncios por un video inaccesible', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const batches = []
  const imageRequests = []
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.method === 'GET') {
      imageRequests.push(new URL(req.url, 'http://127.0.0.1'))
      return res.end(JSON.stringify({ data: [{ hash: 'image-hash', url: 'https://cdn.example.test/image.jpg' }] }))
    }
    let body = ''
    for await (const chunk of req) body += chunk
    const params = new URLSearchParams(body)
    const batch = JSON.parse(params.get('batch'))
    batches.push({ params, operations: batch })
    const objects = {
      'ad-video': { id: 'ad-video', creative: { id: 'creative-video', video_id: 'video-shared' } },
      'ad-shared': { id: 'ad-shared', creative: { id: 'creative-shared', video_id: 'video-shared' } },
      'ad-denied': { id: 'ad-denied', creative: { id: 'creative-denied', video_id: 'video-denied', thumbnail_url: 'https://cdn.example.test/fallback.jpg' } },
      'ad-image': { id: 'ad-image', creative: { id: 'creative-image', image_hash: 'image-hash' } },
      'video-shared': {
        id: 'video-shared', source: 'https://cdn.example.test/video.mp4', permalink_url: 'https://www.facebook.com/video-shared',
        thumbnails: { data: [{ uri: 'https://cdn.example.test/other.jpg' }, { uri: 'https://cdn.example.test/preferred.jpg', is_preferred: true }] }
      }
    }
    res.end(JSON.stringify(batch.map(operation => {
      const id = new URL(operation.relative_url, 'http://127.0.0.1').pathname.slice(1)
      return objects[id]
        ? { code: 200, body: JSON.stringify(objects[id]) }
        : { code: 403, body: JSON.stringify({ error: { message: 'Video unavailable' } }) }
    })))
  })
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${server.address().port}`, configurable: true
    })
    const media = await fetchMetaCreativeMediaForAds(
      ['ad-video', 'ad-shared', 'ad-denied', 'ad-image'], 'local-test-token', 'act_123', 'local-test-proof'
    )
    assert.equal(media.size, 4)
    assert.deepEqual(batches.map(batch => batch.operations.length), [4, 2])
    for (const id of ['ad-video', 'ad-shared']) {
      assert.equal(media.get(id).creative_type, 'video')
      assert.equal(media.get(id).creative_video_url, 'https://cdn.example.test/video.mp4')
      assert.equal(media.get(id).creative_thumbnail_url, 'https://cdn.example.test/preferred.jpg')
      assert.equal(media.get(id).creative_preview_url, 'https://www.facebook.com/video-shared')
    }
    assert.equal(media.get('ad-denied').creative_video_url, null)
    assert.equal(media.get('ad-denied').creative_thumbnail_url, 'https://cdn.example.test/fallback.jpg')
    assert.equal(media.get('ad-image').creative_image_url, 'https://cdn.example.test/image.jpg')
    const videoUrl = new URL(batches[1].operations[0].relative_url, 'http://127.0.0.1')
    assert.match(videoUrl.searchParams.get('fields'), /source,permalink_url,thumbnails/)
    assert.equal(videoUrl.searchParams.get('appsecret_proof'), 'local-test-proof')
    assert.equal(imageRequests.length, 1)
    assert.equal(imageRequests[0].pathname, '/act_123/adimages')
    assert.deepEqual(JSON.parse(imageRequests[0].searchParams.get('hashes')), ['image-hash'])
  } finally {
    await new Promise(resolve => server.close(resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', descriptor)
  }
})
