import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  directChatCompatibilityFromRequest,
  trustedUploadContextFromRequest,
  uploadInputFromRequest
} from '../src/controllers/mediaController.js'
import { resolveMediaUploadModule } from '../src/routes/media.routes.js'
import { prepareWhatsAppMediaForDirectUpload } from '../src/services/whatsappApiService.js'

async function withFakeFfmpeg(callback) {
  const previousPath = process.env.FFMPEG_PATH
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-direct-upload-ffmpeg-'))
  const scriptPath = join(folder, 'ffmpeg-fake.mjs')
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'const outputPath = process.argv[process.argv.length - 1];',
    "const output = outputPath.endsWith('.ogg')",
    "  ? Buffer.from('OggS-direct-upload-opus')",
    "  : Buffer.from('direct-upload-h264-mp4');",
    'fs.writeFileSync(outputPath, output);',
    ''
  ].join('\n'))
  await fs.chmod(scriptPath, 0o755)
  process.env.FFMPEG_PATH = scriptPath

  try {
    return await callback()
  } finally {
    if (previousPath === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = previousPath
    await fs.rm(folder, { recursive: true, force: true })
  }
}

async function withCountingFakeFfmpeg(callback) {
  const previousPath = process.env.FFMPEG_PATH
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-counting-ffmpeg-'))
  const scriptPath = join(folder, 'ffmpeg-counting.mjs')
  const logPath = join(folder, 'events.log')
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    `const logPath = ${JSON.stringify(logPath)};`,
    'const outputPath = process.argv[process.argv.length - 1];',
    "fs.appendFileSync(logPath, `start ${process.pid}\\n`);",
    'setTimeout(() => {',
    "  fs.writeFileSync(outputPath, Buffer.from('direct-upload-h264-mp4'));",
    "  fs.appendFileSync(logPath, `end ${process.pid}\\n`);",
    '}, 140);',
    ''
  ].join('\n'))
  await fs.chmod(scriptPath, 0o755)
  process.env.FFMPEG_PATH = scriptPath

  try {
    return await callback(logPath)
  } finally {
    if (previousPath === undefined) delete process.env.FFMPEG_PATH
    else process.env.FFMPEG_PATH = previousPath
    await fs.rm(folder, { recursive: true, force: true })
  }
}

test('el query de upload manda sobre el body y autoriza media de chat como chat', () => {
  assert.equal(resolveMediaUploadModule({
    query: { module: 'chat' },
    body: { module: 'settings_media' }
  }), 'chat')
  assert.equal(resolveMediaUploadModule({ query: {}, body: { module: 'sites' } }), 'sites')
  assert.equal(directChatCompatibilityFromRequest({
    query: {
      module: 'chat',
      chatCompatibility: 'whatsapp',
      chatMediaKind: 'image'
    },
    body: {}
  }).enabled, true)
  assert.equal(directChatCompatibilityFromRequest({
    query: { module: 'chat' },
    body: {}
  }).enabled, false, 'module=chat sin el contrato directo no debe saltarse settings_media')
  assert.equal(directChatCompatibilityFromRequest({
    query: {},
    body: {
      module: 'chat',
      chatCompatibility: 'whatsapp',
      chatMediaKind: 'video'
    }
  }).enabled, false, 'el multipart no puede activar después el parser directo de 25 MB')
})

test('la identidad y la cuota del upload directo de Chat provienen del servidor y la sesión', () => {
  const previousBusinessId = process.env.RISTAK_BUSINESS_ID
  process.env.RISTAK_BUSINESS_ID = 'tenant_real'
  try {
    const context = trustedUploadContextFromRequest({
      query: {
        module: 'chat',
        chatCompatibility: 'whatsapp',
        chatMediaKind: 'document',
        businessId: 'tenant_atacante'
      },
      body: {
        businessId: 'tenant_atacante',
        clientAccountId: 'cuenta_atacante',
        userId: 'usuario_atacante',
        module: 'settings_media'
      },
      user: { userId: 'usuario_autenticado' },
      get: () => null
    })
    assert.equal(context.businessId, 'tenant_real')
    assert.equal(context.clientAccountId, null)
    assert.equal(context.userId, 'usuario_autenticado')
    assert.equal(context.module, 'chat')
  } finally {
    if (previousBusinessId === undefined) delete process.env.RISTAK_BUSINESS_ID
    else process.env.RISTAK_BUSINESS_ID = previousBusinessId
  }
})

test('Media/Sites conserva el ruteo administrativo multi-cuenta existente', () => {
  const context = trustedUploadContextFromRequest({
    query: {},
    body: {
      businessId: 'business_admin',
      clientAccountId: 'location_admin',
      userId: 'legacy_admin_user',
      module: 'sites'
    },
    user: { userId: 'usuario_autenticado' },
    get: () => null
  })
  assert.equal(context.businessId, 'business_admin')
  assert.equal(context.clientAccountId, 'location_admin')
  assert.equal(context.userId, 'legacy_admin_user')
  assert.equal(context.module, 'sites')
})

test('upload multipart de documento conserva bytes, idempotencia y metadata de chat', async () => {
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-direct-document-'))
  const filePath = join(folder, 'contrato.pdf')
  const content = Buffer.from('%PDF-1.4\ncontenido de prueba')
  await fs.writeFile(filePath, content)

  try {
    const prepared = await uploadInputFromRequest({
      query: {
        module: 'chat',
        chatCompatibility: 'whatsapp',
        chatMediaKind: 'document'
      },
      body: {
        clientUploadId: 'ios-chat-fixed-retry',
        moduleEntityId: 'contact-1',
        isPublic: 'true'
      },
      file: {
        path: filePath,
        size: content.length,
        originalname: 'contrato.pdf',
        mimetype: 'application/pdf'
      },
      user: { userId: 'user-1' },
      get: () => null
    })

    assert.equal(prepared.mode, 'buffer')
    assert.deepEqual(prepared.input.buffer, content)
    assert.equal(prepared.input.module, 'chat')
    assert.equal(prepared.input.moduleEntityId, 'contact-1')
    assert.equal(prepared.input.clientUploadId, 'ios-chat-fixed-retry')
    assert.equal(prepared.input.skipCompression, true)
    assert.equal(prepared.input.metadata.source, 'ios_direct_chat_upload')
    assert.equal(prepared.input.metadata.whatsappDocument, true)
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
  }
})

test('upload directo normaliza audio a OGG Opus y video a MP4 antes del CDN', async () => {
  await withFakeFfmpeg(async () => {
    const audio = await prepareWhatsAppMediaForDirectUpload({
      buffer: Buffer.from('audio-m4a-de-prueba'),
      mimeType: 'audio/mp4',
      filename: 'nota.m4a',
      kind: 'audio'
    })
    assert.equal(audio.mimeType, 'audio/ogg; codecs=opus')
    assert.equal(audio.filename, 'whatsapp-audio.ogg')
    assert.equal(audio.buffer.subarray(0, 4).toString('latin1'), 'OggS')
    assert.equal(audio.metadata.whatsappVoiceNote, true)

    const video = await prepareWhatsAppMediaForDirectUpload({
      buffer: Buffer.from('video-mov-de-prueba'),
      mimeType: 'video/quicktime',
      filename: 'captura.mov',
      kind: 'video'
    })
    assert.equal(video.mimeType, 'video/mp4')
    assert.equal(video.filename, 'whatsapp-video.mp4')
    assert.equal(video.buffer.toString(), 'direct-upload-h264-mp4')
    assert.equal(video.metadata.whatsappApiCompatible, true)
  })
})

test('la transcodificación limita procesos ffmpeg concurrentes', async () => {
  await withCountingFakeFfmpeg(async (logPath) => {
    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      prepareWhatsAppMediaForDirectUpload({
        buffer: Buffer.from(`video-${index}`),
        mimeType: 'video/quicktime',
        filename: `captura-${index}.mov`,
        kind: 'video'
      })
    ))

    const events = (await fs.readFile(logPath, 'utf8')).trim().split('\n')
    let active = 0
    let maximum = 0
    for (const event of events) {
      if (event.startsWith('start ')) active += 1
      if (event.startsWith('end ')) active -= 1
      maximum = Math.max(maximum, active)
      assert.ok(active >= 0)
    }
    assert.equal(active, 0)
    const configured = Math.min(4, Math.max(1, Number(process.env.WHATSAPP_FFMPEG_MAX_CONCURRENCY || 2) || 2))
    assert.ok(maximum <= configured, `ffmpeg concurrente observado: ${maximum}, límite: ${configured}`)
  })
})
