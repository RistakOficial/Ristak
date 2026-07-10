import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { db } from '../src/config/database.js'
import {
  assertSafeOutboundMediaUrl,
  downloadSafeOutboundMediaUrl,
  isBlockedOutboundMediaAddress,
  resolveOutboundChatMediaReference
} from '../src/services/outboundMediaReferenceService.js'

test('bloquea loopback, link-local, redes privadas e IPv6 local', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.1.1', '192.168.0.1', '169.254.169.254', '::1', '::ffff:7f00:1', 'fd00::1', 'fe80::1']) {
    assert.equal(isBlockedOutboundMediaAddress(address), true, address)
  }
  assert.equal(isBlockedOutboundMediaAddress('8.8.8.8'), false)

  await assert.rejects(
    () => assertSafeOutboundMediaUrl('https://127.0.0.1/secreto'),
    error => error?.status === 400 && error?.code === 'unsafe_media_url'
  )
  await assert.rejects(
    () => assertSafeOutboundMediaUrl('http://8.8.8.8/archivo'),
    error => error?.status === 400 && /HTTPS/i.test(error.message)
  )
  await assert.rejects(
    () => downloadSafeOutboundMediaUrl('https://169.254.169.254/latest/meta-data'),
    error => error?.status === 400 && error?.code === 'unsafe_media_url'
  )
})

test('mediaAssetId manda sobre la URL del cliente y exige asset chat listo del tenant', async () => {
  const id = `media_security_${randomUUID()}`
  const publicUrl = `https://8.8.8.8/chat/${id}.m4a`
  await db.run(
    `INSERT INTO media_assets (
      id, business_id, original_filename, public_url, mime_type, media_type,
      status, module, is_public, created_at, updated_at
    ) VALUES (?, 'default', 'nota.m4a', ?, 'audio/mp4', 'audio',
      'ready', 'chat', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [id, publicUrl]
  )

  try {
    const resolved = await resolveOutboundChatMediaReference({
      mediaAssetId: id,
      legacyUrl: 'https://127.0.0.1/no-debe-ganar',
      expectedMediaTypes: ['audio']
    })
    assert.equal(resolved.url, publicUrl)
    assert.equal(resolved.mediaAssetId, id)
    assert.equal(resolved.mimeType, 'audio/mp4')

    await assert.rejects(
      () => resolveOutboundChatMediaReference({
        mediaAssetId: id,
        expectedMediaTypes: ['image']
      }),
      error => error?.status === 409 && error?.code === 'chat_media_asset_type_mismatch'
    )
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [id])
  }
})
