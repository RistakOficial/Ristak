import test, { after } from 'node:test'
import assert from 'node:assert/strict'

delete process.env.DATABASE_URL

const [{ db }, migration] = await Promise.all([
  import('../src/config/database.js'),
  import('../scripts/reorganize-storage-taxonomy.mjs')
])
const { reRootPath, planMoves, updateAssetRow, rewriteReferences } = migration

const CONFIG = { bunnyCdnBaseUrl: 'https://cdn.test' }
const TARGET_ROOT = 'accounts/new-slug'

test('reRootPath re-enraíza accounts/* y businesses/* conservando el resto', () => {
  assert.equal(
    reRootPath('accounts/loc_old/sites/2026/07/01/rstk_media_abc-video.mp4', TARGET_ROOT),
    'accounts/new-slug/sites/2026/07/01/rstk_media_abc-video.mp4'
  )
  assert.equal(
    reRootPath('businesses/default/chat/2026/07/01/foto.jpg', TARGET_ROOT),
    'accounts/new-slug/chat/2026/07/01/foto.jpg'
  )
  // No re-enraizable: root desconocido o ruta demasiado corta.
  assert.equal(reRootPath('otracosa/x/y.jpg', TARGET_ROOT), null)
  assert.equal(reRootPath('accounts/x', TARGET_ROOT), null)
})

test('planMoves + updateAssetRow + rewriteReferences reescriben asset y referencias', async () => {
  const oldPath = 'accounts/loc_old/sites/2026/07/01/rstk_media_abc-video.mp4'
  const oldPublic = `https://cdn.test/${oldPath}`
  const thumbOldPath = 'accounts/loc_old/sites/2026/07/01/rstk_media_abc-video-thumb.jpg'
  const thumbOldPublic = `https://cdn.test/${thumbOldPath}`
  const newPublic = 'https://cdn.test/accounts/new-slug/sites/2026/07/01/rstk_media_abc-video.mp4'

  await db.run('DELETE FROM media_assets WHERE id = ?', ['asset_mig_1']).catch(() => {})
  await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', ['+52999migtest']).catch(() => {})

  await db.run(
    `INSERT INTO media_assets (id, business_id, bunny_path, public_url, storage_provider, module, metadata_json)
     VALUES (?, 'default', ?, ?, 'bunny', 'sites', ?)`,
    [
      'asset_mig_1',
      oldPath,
      oldPublic,
      JSON.stringify({ variants: { thumbnail: { path: thumbOldPath, publicUrl: thumbOldPublic } } })
    ]
  )
  // Una referencia externa (avatar de contacto) apuntando a la URL vieja.
  await db.run(
    'INSERT INTO whatsapp_api_contacts (id, phone, profile_picture_url) VALUES (?, ?, ?)',
    ['wac_mig_1', '+52999migtest', oldPublic]
  )

  const moves = await planMoves(db, CONFIG, TARGET_ROOT)
  const move = moves.find((m) => m.id === 'asset_mig_1')
  assert.ok(move, 'el asset viejo debe entrar en el plan')
  assert.equal(move.newPath, 'accounts/new-slug/sites/2026/07/01/rstk_media_abc-video.mp4')
  assert.equal(move.newPublic, newPublic)
  assert.equal(move.thumbNewPath, 'accounts/new-slug/sites/2026/07/01/rstk_media_abc-video-thumb.jpg')

  await rewriteReferences(db, [
    [move.oldPublic, move.newPublic],
    [move.thumbOldPublic, move.thumbNewPublic]
  ])
  await updateAssetRow(db, move)

  // El asset quedó re-enraizado (ruta, URL y metadata de miniatura).
  const asset = await db.get('SELECT bunny_path, public_url, metadata_json FROM media_assets WHERE id = ?', ['asset_mig_1'])
  assert.equal(asset.bunny_path, move.newPath)
  assert.equal(asset.public_url, newPublic)
  assert.ok(asset.metadata_json.includes('accounts/new-slug/'), 'metadata reescrita')
  assert.ok(!asset.metadata_json.includes('loc_old'), 'no debe quedar rastro del root viejo')

  // La referencia externa se reescribió a la URL nueva.
  const contact = await db.get('SELECT profile_picture_url FROM whatsapp_api_contacts WHERE phone = ?', ['+52999migtest'])
  assert.equal(contact.profile_picture_url, newPublic)

  // Idempotencia: correr planMoves de nuevo ya NO incluye el asset (ya migrado).
  const moves2 = await planMoves(db, CONFIG, TARGET_ROOT)
  assert.equal(moves2.find((m) => m.id === 'asset_mig_1'), undefined)
})

after(async () => {
  await db.run('DELETE FROM media_assets WHERE id = ?', ['asset_mig_1']).catch(() => {})
  await db.run('DELETE FROM whatsapp_api_contacts WHERE phone = ?', ['+52999migtest']).catch(() => {})
})
