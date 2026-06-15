import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VALID_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWMwXpVGEmIY1bBqNJSMh2vSAACFAkMQ6K3QUQAAAABJRU5ErkJggg=='
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

const ENV_KEYS = [
  'DATABASE_URL',
  'MEDIA_STORAGE_PROVIDER',
  'MEDIA_STORAGE_REQUIRE_BUNNY',
  'BUNNY_STORAGE_ZONE',
  'BUNNY_STORAGE_REGION',
  'BUNNY_STORAGE_ENDPOINT',
  'BUNNY_STORAGE_API_KEY',
  'BUNNY_CDN_BASE_URL',
  'BUNNY_STREAM_LIBRARY_ID',
  'BUNNY_STREAM_API_KEY',
  'INTERNAL_INSTALLER_TOKEN',
  'LICENSE_SERVER_URL',
  'CLIENT_ID',
  'LICENSE_KEY',
  'INSTALLATION_ID',
  'APP_URL',
  'APP_VERSION',
  'MEDIA_CENTRAL_CONFIG_TIMEOUT_MS',
  'WHATSAPP_LOCAL_MEDIA_FALLBACK',
  'RENDER_EXTERNAL_URL',
  'PUBLIC_URL'
]

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = snapshot[key]
    }
  }
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args)
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().slice(-500) || `ffmpeg salió con código ${code}`))
    })
  })
}

async function hasFfmpeg() {
  try {
    await runFfmpeg(['-version'])
    return true
  } catch {
    return false
  }
}

const ffmpegAvailable = await hasFfmpeg()

test('requirePublicMediaUrl conserva URLs CDN absolutas y exige base HTTPS para paths locales', async () => {
  const previousEnv = snapshotEnv()
  try {
    delete process.env.DATABASE_URL
    process.env.RENDER_EXTERNAL_URL = 'https://app-demo.onrender.com'

    const { requirePublicMediaUrl } = await import('../src/services/whatsappApiService.js')

    assert.equal(
      requirePublicMediaUrl({ publicPath: 'https://cdn.ristak.com/businesses/default/chat/foto.webp' }, 'https://app-demo.onrender.com', 'fotos'),
      'https://cdn.ristak.com/businesses/default/chat/foto.webp'
    )
    assert.equal(
      requirePublicMediaUrl({ publicPath: '/media/assets/media_123/file' }, 'https://app-demo.onrender.com', 'fotos'),
      'https://app-demo.onrender.com/media/assets/media_123/file'
    )
    assert.throws(
      () => requirePublicMediaUrl({ publicPath: '/uploads/whatsapp-images/foto.png' }, 'http://localhost:3001', 'fotos'),
      /URL HTTPS/
    )
  } finally {
    restoreEnv(previousEnv)
  }
})

test('saveWhatsAppImageDataUrl recupera configuración Bunny desde Installer cuando el runtime no trae env vars', async () => {
  const previousEnv = snapshotEnv()
  let server = null
  let baseUrl = ''
  let db = null
  let previousSettings = null
  let mediaAssetId = ''
  const uploads = []

  try {
    server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/license/storage-config') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          const payload = body ? JSON.parse(body) : {}
          assert.equal(payload.client_id, 'cli_1')
          assert.equal(payload.license_key, 'RSTK-TEST-0000')
          assert.equal(payload.installation_id, 'inst_1')
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({
            success: true,
            config: {
              media_storage_provider: 'bunny',
              media_storage_require_bunny: 'true',
              media_compression_enabled: 'true',
              default_storage_quota_gb: '5',
              internal_installer_token: 'internal-token',
              bunny_storage_zone: 'central-zone',
              bunny_storage_region: 'la',
              bunny_storage_endpoint: `${baseUrl}/storage`,
              bunny_storage_api_key: 'central-storage-secret',
              bunny_cdn_base_url: `${baseUrl}/cdn`
            }
          }))
        })
        return
      }

      if (req.method === 'PUT' && req.url?.startsWith('/storage/central-zone/')) {
        uploads.push(req.url)
        req.resume()
        req.on('end', () => {
          res.statusCode = 201
          res.end('ok')
        })
        return
      }

      res.statusCode = 404
      res.end('not found')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`

    delete process.env.DATABASE_URL
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    delete process.env.BUNNY_STREAM_LIBRARY_ID
    delete process.env.BUNNY_STREAM_API_KEY
    delete process.env.INTERNAL_INSTALLER_TOKEN
    delete process.env.WHATSAPP_LOCAL_MEDIA_FALLBACK
    process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
    process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
    process.env.LICENSE_SERVER_URL = baseUrl
    process.env.CLIENT_ID = 'cli_1'
    process.env.LICENSE_KEY = 'RSTK-TEST-0000'
    process.env.INSTALLATION_ID = 'inst_1'
    process.env.APP_URL = 'https://demo.onrender.com'
    process.env.APP_VERSION = '1.0.0'
    process.env.MEDIA_CENTRAL_CONFIG_TIMEOUT_MS = '2000'

    const [whatsappApiService, mediaStorageService, database] = await Promise.all([
      import('../src/services/whatsappApiService.js'),
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db
    previousSettings = await db.get(`
      SELECT bunny_storage_zone, bunny_storage_region, bunny_cdn_base_url, bunny_stream_library_id
      FROM storage_settings
      WHERE id = 1
    `)
    await db.run(`
      UPDATE storage_settings SET
        bunny_storage_zone = NULL,
        bunny_storage_region = NULL,
        bunny_cdn_base_url = NULL,
        bunny_stream_library_id = NULL
      WHERE id = 1
    `)

    const savedImage = await whatsappApiService.saveWhatsAppImageDataUrl(VALID_PNG_DATA_URL)
    mediaAssetId = savedImage.mediaAssetId

    assert.match(savedImage.publicPath, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cdn/`))
    assert.match(savedImage.publicPath, /\.jpg$/)
    assert.equal(savedImage.mimeType, 'image/jpeg')
    assert.ok(uploads.length >= 1)
    assert.ok(
      uploads.some(url => decodeURIComponent(url).endsWith('-whatsapp-image.jpg')),
      'la foto principal de WhatsApp API debe subirse como JPEG, no WebP'
    )
    assert.ok(
      uploads.every(url => !decodeURIComponent(url).endsWith('-whatsapp-image.webp')),
      'la foto principal no debe convertirse a WebP porque Meta/YCloud no la aceptan como imagen normal'
    )
    const row = await db.get('SELECT mime_type, extension, stored_filename, metadata_json FROM media_assets WHERE id = ?', [mediaAssetId])
    assert.equal(row.mime_type, 'image/jpeg')
    assert.equal(row.extension, 'jpg')
    assert.match(row.stored_filename, /\.jpg$/)
    const metadata = JSON.parse(row.metadata_json || '{}')
    assert.equal(metadata.whatsappApiCompatible, true)
    assert.equal(metadata.whatsappImageCompression, 'whatsapp_jpeg')
    assert.equal(metadata.originalMimeType, 'image/png')
    assert.equal(process.env.INTERNAL_INSTALLER_TOKEN, 'internal-token')
  } finally {
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    if (db && previousSettings) {
      await db.run(`
        UPDATE storage_settings SET
          bunny_storage_zone = ?,
          bunny_storage_region = ?,
          bunny_cdn_base_url = ?,
          bunny_stream_library_id = ?
        WHERE id = 1
      `, [
        previousSettings.bunny_storage_zone,
        previousSettings.bunny_storage_region,
        previousSettings.bunny_cdn_base_url,
        previousSettings.bunny_stream_library_id
      ]).catch(() => undefined)
    }
    server?.closeAllConnections?.()
    server?.close()
    restoreEnv(previousEnv)
  }
})

test('saveWhatsAppAudioDataUrl convierte grabaciones MP4 a nota de voz Ogg Opus antes de Bunny', {
  skip: ffmpegAvailable ? false : 'ffmpeg no está instalado en este entorno'
}, async () => {
  const previousEnv = snapshotEnv()
  let server = null
  let baseUrl = ''
  let db = null
  let mediaAssetId = ''
  const uploads = []
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-whatsapp-audio-test-'))

  try {
    const mp4Path = join(folder, 'voice.mp4')
    await runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1.2',
      '-vn',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', '+faststart',
      mp4Path
    ])
    const mp4Buffer = await fs.readFile(mp4Path)
    const audioDataUrl = `data:video/mp4;base64,${mp4Buffer.toString('base64')}`

    server = http.createServer((req, res) => {
      if (req.method === 'PUT' && req.url?.startsWith('/storage/voice-zone/')) {
        let size = 0
        req.on('data', chunk => { size += chunk.length })
        req.on('end', () => {
          uploads.push({
            url: req.url,
            contentType: req.headers['content-type'],
            size
          })
          res.statusCode = 201
          res.end('ok')
        })
        return
      }

      res.statusCode = 404
      res.end('not found')
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}`

    delete process.env.DATABASE_URL
    delete process.env.WHATSAPP_LOCAL_MEDIA_FALLBACK
    process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
    process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'
    process.env.BUNNY_STORAGE_ZONE = 'voice-zone'
    process.env.BUNNY_STORAGE_REGION = ''
    process.env.BUNNY_STORAGE_ENDPOINT = `${baseUrl}/storage`
    process.env.BUNNY_STORAGE_API_KEY = 'voice-storage-secret'
    process.env.BUNNY_CDN_BASE_URL = `${baseUrl}/cdn`

    const [whatsappApiService, mediaStorageService, database] = await Promise.all([
      import('../src/services/whatsappApiService.js'),
      import('../src/services/mediaStorageService.js'),
      import('../src/config/database.js')
    ])
    mediaStorageService.resetCentralStorageConfigCache()
    db = database.db

    const savedAudio = await whatsappApiService.saveWhatsAppAudioDataUrl(audioDataUrl)
    mediaAssetId = savedAudio.mediaAssetId

    assert.equal(savedAudio.mimeType, 'audio/ogg; codecs=opus')
    assert.equal(savedAudio.originalMimeType, 'video/mp4')
    assert.match(savedAudio.publicPath, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cdn/`))
    assert.match(savedAudio.filename, /\.ogg$/)
    assert.ok(uploads.length >= 1)
    assert.ok(
      uploads.some(upload => decodeURIComponent(upload.url).endsWith('-whatsapp-audio.ogg')),
      'la nota de voz debe subirse a Bunny como .ogg'
    )
    assert.ok(
      uploads.every(upload => !decodeURIComponent(upload.url).endsWith('-whatsapp-audio.mp4')),
      'la nota de voz no debe llegar a Bunny como .mp4'
    )
    assert.equal(uploads[0].contentType, 'audio/ogg')

    const row = await db.get('SELECT mime_type, media_type, extension, stored_filename, metadata_json FROM media_assets WHERE id = ?', [mediaAssetId])
    assert.equal(row.mime_type, 'audio/ogg')
    assert.equal(row.media_type, 'audio')
    assert.equal(row.extension, 'ogg')
    assert.match(row.stored_filename, /\.ogg$/)
    const metadata = JSON.parse(row.metadata_json || '{}')
    assert.equal(metadata.whatsappApiCompatible, true)
    assert.equal(metadata.whatsappVoiceNote, true)
    assert.equal(metadata.whatsappAudioCompression, 'whatsapp_ogg_opus')
    assert.equal(metadata.originalMimeType, 'video/mp4')
  } finally {
    if (db && mediaAssetId) {
      await db.run('DELETE FROM media_assets WHERE id = ?', [mediaAssetId]).catch(() => undefined)
    }
    server?.closeAllConnections?.()
    server?.close()
    await fs.rm(folder, { recursive: true, force: true }).catch(() => undefined)
    restoreEnv(previousEnv)
  }
})

test('saveWhatsAppImageDataUrl falla claro cuando Bunny es obligatorio y no está configurado', async () => {
  const previousEnv = snapshotEnv()
  let db = null
  let previousSettings = null

  try {
    delete process.env.DATABASE_URL
    delete process.env.BUNNY_STORAGE_ZONE
    delete process.env.BUNNY_STORAGE_REGION
    delete process.env.BUNNY_STORAGE_ENDPOINT
    delete process.env.BUNNY_STORAGE_API_KEY
    delete process.env.BUNNY_CDN_BASE_URL
    delete process.env.BUNNY_STREAM_LIBRARY_ID
    delete process.env.BUNNY_STREAM_API_KEY
    delete process.env.WHATSAPP_LOCAL_MEDIA_FALLBACK
    process.env.MEDIA_STORAGE_PROVIDER = 'bunny'
    process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'true'

    const whatsappApiService = await import('../src/services/whatsappApiService.js')
    const database = await import('../src/config/database.js')
    db = database.db
    previousSettings = await db.get(`
      SELECT bunny_storage_zone, bunny_storage_region, bunny_cdn_base_url, bunny_stream_library_id
      FROM storage_settings
      WHERE id = 1
    `)
    await db.run(`
      UPDATE storage_settings SET
        bunny_storage_zone = NULL,
        bunny_storage_region = NULL,
        bunny_cdn_base_url = NULL,
        bunny_stream_library_id = NULL
      WHERE id = 1
    `)

    await assert.rejects(
      () => whatsappApiService.saveWhatsAppImageDataUrl(VALID_PNG_DATA_URL),
      (error) => {
        assert.equal(error.code, 'bunny_not_configured')
        assert.match(error.message, /Bunny\.net está activo/)
        return true
      }
    )
  } finally {
    if (db && previousSettings) {
      await db.run(`
        UPDATE storage_settings SET
          bunny_storage_zone = ?,
          bunny_storage_region = ?,
          bunny_cdn_base_url = ?,
          bunny_stream_library_id = ?
        WHERE id = 1
      `, [
        previousSettings.bunny_storage_zone,
        previousSettings.bunny_storage_region,
        previousSettings.bunny_cdn_base_url,
        previousSettings.bunny_stream_library_id
      ]).catch(() => undefined)
    }
    restoreEnv(previousEnv)
  }
})
