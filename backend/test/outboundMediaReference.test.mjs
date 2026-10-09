import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { db } from '../src/config/database.js'
import {
  assertSafeOutboundMediaUrl,
  downloadSafeOutboundMediaUrl,
  isBlockedOutboundMediaAddress,
  resolveOutboundChatMediaReference
} from '../src/services/outboundMediaReferenceService.js'

test('bloquea loopback, link-local, redes privadas, NAT64 e IPv6 reservado', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.20.1.1',
    '192.168.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:7f00:1',
    '::ffff:0:7f00:1',
    '::ffff:0:a00:1',
    'fd00::1',
    'fe80::1',
    'fec0::1',
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '64:ff9b:1::7f00:1',
    '100::1',
    '100:0:0:1::1',
    '2001:2::1',
    '2001:10::1',
    '3fff::1',
    '5f00::1'
  ]) {
    assert.equal(isBlockedOutboundMediaAddress(address), true, address)
  }
  assert.equal(isBlockedOutboundMediaAddress('8.8.8.8'), false)
  assert.equal(isBlockedOutboundMediaAddress('2001:4860:4860::8888'), false)

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
  await assert.rejects(
    () => assertSafeOutboundMediaUrl('https://[64:ff9b::7f00:1]/metadata'),
    error => error?.status === 400 && error?.code === 'unsafe_media_url'
  )
})

test('bloquea prefijos NAT64 específicos de red configurados por el operador', () => {
  const previous = process.env.OUTBOUND_MEDIA_NAT64_PREFIXES
  process.env.OUTBOUND_MEDIA_NAT64_PREFIXES = '2001:4860:64::/96, inválido'
  try {
    assert.equal(isBlockedOutboundMediaAddress('2001:4860:64::7f00:1'), true)
    assert.equal(isBlockedOutboundMediaAddress('2001:4860:64::a00:1'), true)
    assert.equal(isBlockedOutboundMediaAddress('2001:4860:4860::8888'), false)
  } finally {
    if (previous === undefined) delete process.env.OUTBOUND_MEDIA_NAT64_PREFIXES
    else process.env.OUTBOUND_MEDIA_NAT64_PREFIXES = previous
  }
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

test('Media pública exige permiso y licencia, y puede entregar bytes sin depender del URL de preview', async () => {
  const id = `library_media_${randomUUID()}`
  const folder = await mkdtemp(join(tmpdir(), 'ristak-public-media-'))
  const localPath = join(folder, 'foto.webp')
  const bytes = Buffer.from('stored-image-bytes')
  await writeFile(localPath, bytes)
  await db.run(`INSERT INTO media_assets (
    id, business_id, original_filename, public_url, mime_type, media_type,
    status, storage_provider, module, is_public, size_processed, metadata_json
  ) VALUES (?, 'default', 'foto.webp', ?, 'image/webp', 'image',
    'ready', 'local', 'media', 1, ?, ?)`, [id, `/media/assets/${id}/file`, bytes.length, JSON.stringify({ localPath })])
  const options = { mediaAssetId: id, expectedMediaTypes: ['image'], readBinary: true, user: { id: 1, role: 'employee', access_config: { settings_media: 'read' } }, licenseState: { allowed: true, enforced: false } }
  try {
    for (const denied of [
      { user: null }, { user: { role: 'admin' } },
      { user: { id: 1, role: 'employee', access_config: { chat: 'write' } } },
      { licenseState: { allowed: false, enforced: true } }
    ]) {
      await assert.rejects(() => resolveOutboundChatMediaReference({ ...options, ...denied }), error => error.status === 403 && error.code === 'media_read_access_required')
    }
    const result = await resolveOutboundChatMediaReference(options)
    assert.equal(result.url, '')
    assert.equal(result.mediaAssetId, id)
    assert.deepEqual(Buffer.from(result.dataUrl.split(',')[1], 'base64'), bytes)
    await assert.rejects(() => resolveOutboundChatMediaReference({ ...options, businessId: 'another-account' }), error => error.status === 404)
    for (const [column, invalid, original] of [['module', 'automations', 'media'], ['status', 'pending', 'ready'], ['is_public', 0, 1]]) {
      await db.run(`UPDATE media_assets SET ${column} = ? WHERE id = ?`, [invalid, id])
      await assert.rejects(() => resolveOutboundChatMediaReference(options), error => error.status === 404)
      await db.run(`UPDATE media_assets SET ${column} = ? WHERE id = ?`, [original, id])
    }
    await writeFile(localPath, Buffer.alloc(25 * 1024 * 1024 + 1))
    await assert.rejects(() => resolveOutboundChatMediaReference(options), error => error.status === 413 && error.code === 'media_download_too_large')
  } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [id])
    await rm(folder, { recursive: true, force: true })
  }
})

test('la instalación resuelve su biblioteca default sin admitir Chat legacy ni otro negocio', async () => {
  const id = `library_scope_${randomUUID()}`
  const folder = await mkdtemp(join(tmpdir(), 'ristak-library-scope-'))
  const localPath = join(folder, 'foto.webp')
  const bytes = Buffer.from('same-installation-library')
  await writeFile(localPath, bytes)
  await db.run(`INSERT INTO media_assets (
    id, business_id, original_filename, public_url, mime_type, media_type,
    status, storage_provider, module, is_public, size_processed, metadata_json
  ) VALUES (?, 'default', 'foto.webp', ?, 'image/webp', 'image',
    'ready', 'local', 'media', 1, ?, ?)`, [id, `/media/assets/${id}/file`, bytes.length, JSON.stringify({ localPath })])
  const previousTenant = process.env.RISTAK_BUSINESS_ID
  process.env.RISTAK_BUSINESS_ID = `installation_${randomUUID()}`
  const options = { mediaAssetId: id, readBinary: true, expectedMediaTypes: ['image'], user: { id: 1, role: 'admin' }, licenseState: { allowed: true, enforced: false } }
  try {
    const result = await resolveOutboundChatMediaReference(options)
    assert.deepEqual(Buffer.from(result.dataUrl.split(',')[1], 'base64'), bytes)
    const byUrl = await resolveOutboundChatMediaReference({ ...options, mediaAssetId: '', legacyUrl: `/media/assets/${id}/file` })
    assert.equal(byUrl.mediaAssetId, id)
    await assert.rejects(() => resolveOutboundChatMediaReference({ ...options, user: null }), error => error.status === 403)
    await assert.rejects(() => resolveOutboundChatMediaReference({ ...options, businessId: 'another-business' }), error => error.status === 404)
    for (const module of ['chat', 'sites', 'automations']) {
      await db.run('UPDATE media_assets SET module = ? WHERE id = ?', [module, id])
      await assert.rejects(() => resolveOutboundChatMediaReference(options), error => error.status === 404)
    }
    await db.run("UPDATE media_assets SET module = 'media', business_id = 'foreign-business' WHERE id = ?", [id])
    await assert.rejects(() => resolveOutboundChatMediaReference(options), error => error.status === 404)
  } finally {
    if (previousTenant === undefined) delete process.env.RISTAK_BUSINESS_ID
    else process.env.RISTAK_BUSINESS_ID = previousTenant
    await db.run('DELETE FROM media_assets WHERE id = ?', [id])
    await rm(folder, { recursive: true, force: true })
  }
})
