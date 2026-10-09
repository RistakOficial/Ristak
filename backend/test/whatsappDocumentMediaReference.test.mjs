import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { db } from '../src/config/database.js'
import { resolveOutboundChatMediaReference } from '../src/services/outboundMediaReferenceService.js'
import { resolveOutboundWhatsAppDocumentReference } from '../src/services/whatsappDocumentMediaReferenceService.js'

const licenseState = { allowed: true, enforced: false }
const user = { userId: 1, role: 'admin' }

async function withPrivateDocument(callback) {
  const id = `private_doc_${randomUUID()}`
  const folder = await mkdtemp(join(tmpdir(), 'ristak-private-doc-'))
  const localPath = join(folder, 'capacitacion.pdf')
  const bytes = Buffer.from('%PDF-1.4\nCapacitacion privada\n%%EOF')
  await writeFile(localPath, bytes)
  await db.run(`INSERT INTO media_assets (
    id, business_id, original_filename, public_url, mime_type, media_type,
    status, storage_provider, module, is_public, size_processed, metadata_json
  ) VALUES (?, 'default', 'capacitacion.pdf', NULL, 'application/pdf', 'document',
    'ready', 'local', 'media', 0, ?, ?)`, [id, bytes.length, JSON.stringify({ localPath })])
  const resolve = extras => resolveOutboundWhatsAppDocumentReference({ mediaAssetId: id, user, licenseState, ...extras })
  try { await callback({ id, resolve, localPath, bytes }) } finally {
    await db.run('DELETE FROM media_assets WHERE id = ?', [id])
    await rm(folder, { recursive: true, force: true })
  }
}

test('documento privado sin URL se resuelve por bytes; el resolver general de Chat permanece cerrado', async () => {
  await withPrivateDocument(async ({ id, resolve, bytes }) => {
    const result = await resolve({ legacyUrl: 'https://127.0.0.1/ignorado' })
    assert.equal(result.url, '')
    assert.equal(result.sensitive, true)
    assert.equal(result.mimeType, 'application/pdf')
    assert.deepEqual(Buffer.from(result.documentDataUrl.split(',')[1], 'base64'), bytes)
    await assert.rejects(() => resolveOutboundChatMediaReference({ mediaAssetId: id }), error => error.code === 'chat_media_asset_unavailable')
    assert.equal(Number((await db.get('SELECT is_public FROM media_assets WHERE id = ?', [id])).is_public), 0)
  })
})

test('la biblioteca privada default pertenece a la instalación y conserva su autorización y privacidad', async () => {
  await withPrivateDocument(async ({ id, resolve, bytes }) => {
    const previousTenant = process.env.RISTAK_BUSINESS_ID
    process.env.RISTAK_BUSINESS_ID = `installation_${randomUUID()}`
    try {
      const result = await resolve()
      assert.equal(result.sensitive, true)
      assert.equal(result.url, '')
      assert.deepEqual(Buffer.from(result.documentDataUrl.split(',')[1], 'base64'), bytes)
      await assert.rejects(() => resolve({ user: null }), error => error.code === 'private_media_read_access_required')
      await assert.rejects(() => resolve({ businessId: 'another-business' }), error => error.status === 404)
      await assert.rejects(() => resolveOutboundChatMediaReference({ mediaAssetId: id, user, licenseState }), error => error.status === 404)
      assert.equal(Number((await db.get('SELECT is_public FROM media_assets WHERE id = ?', [id])).is_public), 0)
    } finally {
      if (previousTenant === undefined) delete process.env.RISTAK_BUSINESS_ID
      else process.env.RISTAK_BUSINESS_ID = previousTenant
    }
  })
})

test('no permite leer documentos privados de otro negocio, eliminados, pendientes o de otro módulo/tipo', async () => {
  await withPrivateDocument(async ({ id, resolve }) => {
    await assert.rejects(() => resolve({ businessId: 'another-business' }), error => error.status === 404)
    for (const [column, invalid, original, status] of [
      ['status', 'processing', 'ready', 404],
      ['deleted_at', '2026-10-09T00:00:00.000Z', null, 404],
      ['module', 'sites', 'media', 404],
      ['media_type', 'image', 'document', 409]
    ]) {
      await db.run(`UPDATE media_assets SET ${column} = ? WHERE id = ?`, [invalid, id])
      await assert.rejects(() => resolve(), error => error.status === status)
      await db.run(`UPDATE media_assets SET ${column} = ? WHERE id = ?`, [original, id])
    }
  })
})

test('exige autenticación, lectura de Media y licencia antes de abrir el archivo privado', async () => {
  await withPrivateDocument(async ({ id, resolve }) => {
    await db.run('UPDATE media_assets SET metadata_json = ? WHERE id = ?', [JSON.stringify({ localPath: '/file-that-must-not-be-read' }), id])
    for (const options of [
      { user: null },
      { user: { role: 'admin' } },
      { user: { userId: 1, role: 'employee', access_config: { chat: 'write' } } },
      { licenseState: { allowed: false, enforced: true } }
    ]) {
      await assert.rejects(() => resolve(options), error => error.status === 403 && error.code === 'private_media_read_access_required')
    }
  })
})

test('limita el tamaño declarado y el tamaño real del documento antes de cargarlo al proveedor', async () => {
  await withPrivateDocument(async ({ id, resolve, localPath }) => {
    const tooLarge = 20 * 1024 * 1024 + 1
    await db.run('UPDATE media_assets SET size_processed = ? WHERE id = ?', [tooLarge, id])
    await assert.rejects(() => resolve(), error => error.status === 413)
    await db.run('UPDATE media_assets SET size_processed = 1 WHERE id = ?', [id])
    await writeFile(localPath, Buffer.alloc(tooLarge))
    await assert.rejects(() => resolve(), error => error.status === 413)
  })
})
