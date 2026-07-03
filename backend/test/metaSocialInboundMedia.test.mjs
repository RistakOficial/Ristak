import test from 'node:test'
import assert from 'node:assert/strict'
import {
  rehostMetaSocialMedia,
  isMetaHostedMediaUrl,
  normalizeSocialMediaType,
  setMetaSocialMediaTransportForTest
} from '../src/services/metaSocialMessagingService.js'

const META_IMAGE_URL = 'https://lookaside.fbsbx.com/messaging_attachment/abc123?token=xyz'
const META_SCONTENT_URL = 'https://scontent.cdninstagram.com/v/t51/foto.jpg?oh=abc'
const BUNNY_URL = 'https://ristak.b-cdn.net/accounts/acme/chat/messenger-image-123.jpg'

test('isMetaHostedMediaUrl distingue URLs de Meta (caducan) de las ya persistidas', () => {
  assert.equal(isMetaHostedMediaUrl(META_IMAGE_URL), true)
  assert.equal(isMetaHostedMediaUrl(META_SCONTENT_URL), true)
  assert.equal(isMetaHostedMediaUrl('https://cdn.fbcdn.net/x.jpg'), true)
  assert.equal(isMetaHostedMediaUrl(BUNNY_URL), false)
  assert.equal(isMetaHostedMediaUrl(''), false)
  assert.equal(isMetaHostedMediaUrl(null), false)
})

test('normalizeSocialMediaType mapea los tipos de adjunto de Meta', () => {
  assert.equal(normalizeSocialMediaType('image'), 'image')
  assert.equal(normalizeSocialMediaType('video'), 'video')
  assert.equal(normalizeSocialMediaType('audio'), 'audio')
  assert.equal(normalizeSocialMediaType('file'), 'document')
  assert.equal(normalizeSocialMediaType('desconocido'), 'document')
})

test('rehostMetaSocialMedia descarga de Meta y sube a nuestro storage', async () => {
  const uploads = []
  setMetaSocialMediaTransportForTest({
    downloader: async (url) => {
      assert.equal(url, META_IMAGE_URL)
      return { buffer: Buffer.from('binario-de-imagen'), mimeType: 'image/jpeg' }
    },
    uploader: async (input) => {
      uploads.push(input)
      return { id: 'media_asset_1', publicUrl: BUNNY_URL, mimeType: 'image/jpeg' }
    }
  })

  try {
    const result = await rehostMetaSocialMedia({
      socialMessage: {
        platform: 'messenger',
        messageType: 'image',
        mediaUrl: META_IMAGE_URL,
        mediaMimeType: '',
        metaMessageId: 'mid.abc'
      },
      config: {}
    })

    assert.equal(result.mediaUrl, BUNNY_URL)
    assert.equal(result.mediaMimeType, 'image/jpeg')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].module, 'chat')
    assert.equal(uploads[0].isPublic, true)
    assert.equal(uploads[0].metadata.source, 'meta_social_inbound_media')
    assert.equal(uploads[0].metadata.platform, 'messenger')
    assert.match(uploads[0].filename, /^messenger-image-.*\.jpg$/)
  } finally {
    setMetaSocialMediaTransportForTest({})
  }
})

test('rehostMetaSocialMedia NO descarga si la URL ya está persistida (no es de Meta)', async () => {
  let downloaderCalls = 0
  setMetaSocialMediaTransportForTest({
    downloader: async () => { downloaderCalls += 1; return { buffer: Buffer.from('x'), mimeType: 'image/jpeg' } }
  })

  try {
    const result = await rehostMetaSocialMedia({
      socialMessage: { platform: 'instagram', messageType: 'image', mediaUrl: BUNNY_URL },
      config: {}
    })
    assert.equal(result, null)
    assert.equal(downloaderCalls, 0, 'no debe descargar una URL que no es de Meta')
  } finally {
    setMetaSocialMediaTransportForTest({})
  }
})

test('rehostMetaSocialMedia reutiliza la versión ya rehospedada (idempotente)', async () => {
  let downloaderCalls = 0
  setMetaSocialMediaTransportForTest({
    downloader: async () => { downloaderCalls += 1; return { buffer: Buffer.from('x'), mimeType: 'image/jpeg' } }
  })

  try {
    const result = await rehostMetaSocialMedia({
      socialMessage: { platform: 'messenger', messageType: 'image', mediaUrl: META_IMAGE_URL, mediaMimeType: 'image/jpeg' },
      config: {},
      existingMediaUrl: BUNNY_URL
    })
    assert.equal(result.mediaUrl, BUNNY_URL)
    assert.equal(downloaderCalls, 0, 'no debe re-descargar si ya hay una versión persistida')
  } finally {
    setMetaSocialMediaTransportForTest({})
  }
})

test('rehostMetaSocialMedia rechaza adjuntos que exceden el límite de tamaño', async () => {
  setMetaSocialMediaTransportForTest({
    downloader: async () => ({ buffer: Buffer.alloc(30 * 1024 * 1024), mimeType: 'image/jpeg' }) // 30MB > 25MB imagen
  })

  try {
    await assert.rejects(
      () => rehostMetaSocialMedia({
        socialMessage: { platform: 'messenger', messageType: 'image', mediaUrl: META_IMAGE_URL },
        config: {}
      }),
      /excede el tamaño máximo/
    )
  } finally {
    setMetaSocialMediaTransportForTest({})
  }
})
