import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { API_URLS } from '../src/config/constants.js'
import { fetchMetaCreativeMediaForAds } from '../src/services/metaAdsService.js'

test('Meta Ads solicita solo campos validos al leer creatives', async () => {
  const previousMetaGraphDescriptor = Object.getOwnPropertyDescriptor(API_URLS, 'META_GRAPH')
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      'ad-creative-fields-test': {
        id: 'ad-creative-fields-test',
        creative: {
          id: 'creative-fields-test',
          object_type: 'PHOTO',
          image_url: 'https://cdn.example.test/creative.jpg',
          thumbnail_url: 'https://cdn.example.test/creative-thumb.jpg'
        }
      }
    }))
  })

  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    Object.defineProperty(API_URLS, 'META_GRAPH', {
      value: `http://127.0.0.1:${server.address().port}`,
      configurable: true
    })

    const media = await fetchMetaCreativeMediaForAds(['ad-creative-fields-test'], 'token-test')
    assert.equal(media.get('ad-creative-fields-test')?.creative_image_url, 'https://cdn.example.test/creative.jpg')

    const requestUrl = new URL(requests[0], 'http://127.0.0.1')
    const fields = requestUrl.searchParams.get('fields') || ''
    assert.match(fields, /creative\{/)
    assert.doesNotMatch(fields, /preview_url/)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (previousMetaGraphDescriptor) Object.defineProperty(API_URLS, 'META_GRAPH', previousMetaGraphDescriptor)
  }
})
