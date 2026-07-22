import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  directChatCompatibilityFromRequest,
  mediaUploadRequestDescriptor,
  replaceMediaAssetHandler,
  trustedUploadContextFromRequest,
  uploadInputFromRequest
} from '../src/controllers/mediaController.js'
import mediaRouter, {
  resolveMediaUploadAccessModule,
  resolveMediaUploadModule
} from '../src/routes/media.routes.js'
import { db } from '../src/config/database.js'
import {
  resetCentralStorageConfigCache,
  softDeleteMediaAsset,
  uploadMediaAsset
} from '../src/services/mediaStorageService.js'
import { createMediaUploadRequestHash } from '../src/services/mediaUploadSafetyService.js'
import { prepareWhatsAppMediaForDirectUpload } from '../src/services/whatsappApiService.js'

async function withFakeFfmpeg(callback) {
  const previousPath = process.env.FFMPEG_PATH
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-direct-upload-ffmpeg-'))
  const scriptPath = join(folder, 'ffmpeg-fake.mjs')
  await fs.writeFile(scriptPath, [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    'const outputPath = process.argv[process.argv.length - 1];',
    'function oggPage(payload, sequence, headerType = 0) {',
    '  const body = Buffer.from(payload);',
    '  const header = Buffer.alloc(28);',
    "  header.write('OggS', 0, 'ascii');",
    '  header[4] = 0;',
    '  header[5] = headerType;',
    '  header.writeUInt32LE(1, 14);',
    '  header.writeUInt32LE(sequence, 18);',
    '  header[26] = 1;',
    '  header[27] = body.length;',
    '  return Buffer.concat([header, body]);',
    '}',
    'const opusHead = Buffer.alloc(19);',
    "opusHead.write('OpusHead', 0, 'ascii');",
    'opusHead[8] = 1;',
    'opusHead[9] = 1;',
    'opusHead.writeUInt32LE(48000, 12);',
    "const opusTags = Buffer.concat([Buffer.from('OpusTags', 'ascii'), Buffer.alloc(8)]);",
    "const output = outputPath.endsWith('.ogg')",
    '  ? Buffer.concat([oggPage(opusHead, 0, 2), oggPage(opusTags, 1, 4)])',
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
  assert.equal(resolveMediaUploadAccessModule({ mediaUploadModule: 'sites' }), 'sites')
  assert.equal(resolveMediaUploadAccessModule({ mediaUploadModule: 'forms' }), 'sites')
  assert.equal(resolveMediaUploadAccessModule({ mediaUploadModule: 'media' }), 'settings_media')
  assert.equal(resolveMediaUploadAccessModule({ directChatUpload: { enabled: true } }), 'chat')
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

test('Sites conserva el módulo autorizado del query y rechaza un body contradictorio', () => {
  const previousBusinessId = process.env.RISTAK_BUSINESS_ID
  process.env.RISTAK_BUSINESS_ID = 'tenant_sites_real'
  try {
    const context = trustedUploadContextFromRequest({
      mediaUploadModule: 'sites',
      query: { module: 'sites', businessId: 'tenant_atacante' },
      body: {
        module: 'sites',
        moduleEntityId: 'site_1',
        businessId: 'tenant_atacante',
        clientAccountId: 'cuenta_atacante',
        userId: 'usuario_atacante'
      },
      user: { userId: 'user_sites', role: 'member' },
      get: () => null
    })
    assert.equal(context.module, 'sites')
    assert.equal(context.moduleEntityId, 'site_1')
    assert.equal(context.businessId, 'tenant_sites_real')
    assert.equal(context.clientAccountId, null)
    assert.equal(context.userId, 'user_sites')
  } finally {
    if (previousBusinessId === undefined) delete process.env.RISTAK_BUSINESS_ID
    else process.env.RISTAK_BUSINESS_ID = previousBusinessId
  }

  assert.throws(
    () => trustedUploadContextFromRequest({
      mediaUploadModule: 'sites',
      query: { module: 'sites' },
      body: { module: 'settings_media' },
      user: { userId: 'user_sites' },
      get: () => null
    }),
    error => error?.status === 400 && error?.code === 'media_upload_module_mismatch'
  )
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

test('Chat sin clientAccount conserva el SHA del ledger anterior al despliegue', async () => {
  const request = {
    query: {
      module: 'chat',
      chatCompatibility: 'whatsapp',
      chatMediaKind: 'document'
    },
    body: {
      moduleEntityId: 'contact-predeploy',
      isPublic: 'true',
      deferStreamSync: 'true'
    },
    file: {
      originalname: 'contrato.pdf',
      mimetype: 'application/pdf',
      size: 24
    },
    user: { userId: 'user-predeploy' },
    get: () => null
  }
  const directChat = directChatCompatibilityFromRequest(request)
  request.directChatUpload = directChat
  const context = trustedUploadContextFromRequest(request)
  const nextDescriptor = mediaUploadRequestDescriptor(request, context, directChat)
  const legacyDescriptor = {
    businessId: context.businessId,
    userId: String(context.userId),
    module: context.module,
    moduleEntityId: context.moduleEntityId,
    isPublic: context.isPublic,
    deferStreamSync: context.deferStreamSync,
    chatCompatibility: 'whatsapp',
    chatMediaKind: 'document',
    filename: request.file.originalname,
    mimeType: request.file.mimetype,
    size: request.file.size
  }
  const bytes = Buffer.from('mismos bytes de un retry predeploy')

  assert.equal(Object.hasOwn(nextDescriptor, 'clientAccountId'), false)
  assert.equal(
    await createMediaUploadRequestHash({ descriptor: nextDescriptor, buffer: bytes }),
    await createMediaUploadRequestHash({ descriptor: legacyDescriptor, buffer: bytes })
  )
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
    user: { userId: 'usuario_autenticado', role: 'admin' },
    get: () => null
  })
  assert.equal(context.businessId, 'business_admin')
  assert.equal(context.clientAccountId, 'location_admin')
  assert.equal(context.userId, 'legacy_admin_user')
  assert.equal(context.module, 'sites')
})

test('sólo Media acepta carpeta exacta y la huella idempotente incluye el destino', async () => {
  const request = {
    mediaUploadModule: 'media',
    query: { module: 'media' },
    body: {
      module: 'media',
      folderPath: 'Clientes/ACME',
      clientUploadId: 'same-upload-different-folder'
    },
    user: { userId: 'usuario_media', role: 'admin' },
    file: {
      originalname: 'presentacion.pdf',
      mimetype: 'application/pdf',
      size: 12
    },
    get: () => null
  }
  const directChat = { enabled: false, kind: '' }
  const firstContext = trustedUploadContextFromRequest(request)
  const secondContext = trustedUploadContextFromRequest({
    ...request,
    body: { ...request.body, folderPath: 'Clientes/Otra' }
  })
  const sitesContext = trustedUploadContextFromRequest({
    ...request,
    mediaUploadModule: 'sites',
    query: { module: 'sites' },
    body: { ...request.body, module: 'sites' }
  })
  const bytes = Buffer.from('mismos bytes')

  assert.equal(firstContext.folderPath, 'Clientes/ACME')
  assert.equal(sitesContext.folderPath, null)
  assert.notEqual(
    await createMediaUploadRequestHash({
      descriptor: mediaUploadRequestDescriptor(request, firstContext, directChat),
      buffer: bytes
    }),
    await createMediaUploadRequestHash({
      descriptor: mediaUploadRequestDescriptor(request, secondContext, directChat),
      buffer: bytes
    })
  )
})

test('la huella idempotente distingue cuentas administrativas aunque compartan bytes y llave', async () => {
  const request = {
    query: {},
    body: {
      businessId: 'business_admin',
      userId: 'legacy_admin_user',
      module: 'sites',
      clientUploadId: 'legacy-shared-upload-key'
    },
    user: { userId: 'usuario_autenticado', role: 'admin' },
    file: {
      originalname: 'hero.jpg',
      mimetype: 'image/jpeg',
      size: 12
    },
    get: () => null
  }
  const directChat = { enabled: false, kind: '' }
  const firstContext = trustedUploadContextFromRequest({
    ...request,
    body: { ...request.body, clientAccountId: 'location_a' }
  })
  const secondContext = trustedUploadContextFromRequest({
    ...request,
    body: { ...request.body, clientAccountId: 'location_b' }
  })
  const bytes = Buffer.from('mismos bytes')
  const firstHash = await createMediaUploadRequestHash({
    descriptor: mediaUploadRequestDescriptor(request, firstContext, directChat),
    buffer: bytes
  })
  const secondHash = await createMediaUploadRequestHash({
    descriptor: mediaUploadRequestDescriptor(request, secondContext, directChat),
    buffer: bytes
  })

  assert.notEqual(firstHash, secondHash)
})

test('PUT replace clasifica el multipart antes del parser y limpia el temporal al completar', async () => {
  const replaceLayer = mediaRouter.stack.find(layer => (
    layer.route?.path === '/assets/:assetId/replace' && layer.route?.methods?.put
  ))
  const middlewareNames = replaceLayer?.route?.stack?.map(layer => layer.handle?.name) || []
  assert.ok(middlewareNames.indexOf('classifyMediaUpload') >= 0)
  assert.ok(
    middlewareNames.indexOf('classifyMediaUpload') < middlewareNames.indexOf('uploadSingleFile'),
    `orden inesperado: ${middlewareNames.join(', ')}`
  )

  const previousProvider = process.env.MEDIA_STORAGE_PROVIDER
  const previousRequireBunny = process.env.MEDIA_STORAGE_REQUIRE_BUNNY
  const folder = await fs.mkdtemp(join(tmpdir(), 'ristak-direct-replace-'))
  const filePath = join(folder, 'reemplazo.pdf')
  const content = Buffer.from('%PDF-1.4\nreemplazo directo')
  const accountId = `replace_account_${Date.now()}`
  let currentAssetId = ''
  let replacementAssetId = ''

  process.env.MEDIA_STORAGE_PROVIDER = 'local'
  process.env.MEDIA_STORAGE_REQUIRE_BUNNY = 'false'
  resetCentralStorageConfigCache()

  try {
    const current = await uploadMediaAsset({
      buffer: Buffer.from('documento anterior'),
      filename: 'anterior.txt',
      mimeType: 'text/plain',
      module: 'sites',
      businessId: 'default',
      clientAccountId: accountId,
      isPublic: true,
      skipCompression: true
    })
    currentAssetId = current.id
    await fs.writeFile(filePath, content)

    const response = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this },
      json(body) { this.body = body; return body }
    }
    const directChatUpload = {
      enabled: true,
      kind: 'document'
    }
    await replaceMediaAssetHandler({
      params: { assetId: currentAssetId },
      query: {
        module: 'chat',
        chatCompatibility: 'whatsapp',
        chatMediaKind: 'document'
      },
      directChatUpload,
      body: {
        moduleEntityId: 'contact-replace',
        clientUploadId: `replace-${Date.now()}`,
        isPublic: 'true'
      },
      file: {
        path: filePath,
        size: content.length,
        originalname: 'reemplazo.pdf',
        mimetype: 'application/pdf'
      },
      user: { userId: 'replace-user' },
      get: () => null
    }, response)

    assert.equal(response.statusCode, 200, JSON.stringify(response.body))
    assert.equal(response.body?.success, true)
    replacementAssetId = response.body?.data?.asset?.id || ''
    assert.ok(replacementAssetId)
    await assert.rejects(() => fs.access(filePath), error => error?.code === 'ENOENT')
  } finally {
    if (replacementAssetId) await softDeleteMediaAsset(replacementAssetId).catch(() => undefined)
    if (currentAssetId) await softDeleteMediaAsset(currentAssetId).catch(() => undefined)
    if (replacementAssetId) await db.run('DELETE FROM media_assets WHERE id = ?', [replacementAssetId]).catch(() => undefined)
    if (currentAssetId) await db.run('DELETE FROM media_assets WHERE id = ?', [currentAssetId]).catch(() => undefined)
    await fs.rm(folder, { recursive: true, force: true })
    if (previousProvider === undefined) delete process.env.MEDIA_STORAGE_PROVIDER
    else process.env.MEDIA_STORAGE_PROVIDER = previousProvider
    if (previousRequireBunny === undefined) delete process.env.MEDIA_STORAGE_REQUIRE_BUNNY
    else process.env.MEDIA_STORAGE_REQUIRE_BUNNY = previousRequireBunny
    resetCentralStorageConfigCache()
  }
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
