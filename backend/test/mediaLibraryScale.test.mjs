import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import {
  createMediaFolder,
  deleteMediaSelection,
  findMediaAssetsByBunnyStreamVideoIds,
  getStorageUsage,
  listMediaAssets,
  listMediaFolders,
  mediaFolderPathFromObjectPath,
  moveMediaAssets,
  moveMediaSelection
} from '../src/services/mediaStorageService.js'
import { validateMediaArchiveEntries } from '../src/controllers/mediaController.js'

const mediaServiceSourceUrl = new URL('../src/services/mediaStorageService.js', import.meta.url)
const frontendServiceSourceUrl = new URL('../../frontend/src/services/mediaService.ts', import.meta.url)
const mediaSettingsSourceUrl = new URL('../../frontend/src/pages/Settings/MediaSettings.tsx', import.meta.url)
const sitesSourceUrl = new URL('../../frontend/src/pages/Sites/Sites.tsx', import.meta.url)

function mediaId(marker, index) {
  return `${marker}_${String(index).padStart(4, '0')}`
}

async function insertMediaRow({
  id,
  businessId,
  filename,
  folderPath,
  mediaType = 'video',
  status = 'ready',
  createdAt,
  module = 'sites',
  quotaSize = 80,
  storageProvider = 'local',
  streamVideoId = null,
  metadata = {},
  database = db
}) {
  const extension = mediaType === 'video' ? 'mp4' : mediaType === 'image' ? 'png' : 'txt'
  const mimeType = mediaType === 'video' ? 'video/mp4' : mediaType === 'image' ? 'image/png' : 'text/plain'
  const bunnyPath = `accounts/${businessId}/${folderPath}/${id}.${extension}`
  await database.run(
    `INSERT INTO media_assets (
       id, business_id, original_filename, stored_filename, bunny_path, folder_path,
       public_url, mime_type, media_type, extension,
       size_original, size_processed, quota_size, status, storage_provider,
       module, is_public, metadata_json, stream_video_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 100, 80, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      id,
      businessId,
      filename,
      `${id}.${extension}`,
      bunnyPath,
      folderPath,
      `https://media.example.test/${id}.${extension}`,
      mimeType,
      mediaType,
      extension,
      quotaSize,
      status,
      storageProvider,
      module,
      JSON.stringify(metadata),
      streamVideoId,
      createdAt,
      createdAt
    ]
  )
}

test('Media pagina por created_at + id, busca en servidor y resume carpetas sin OFFSET', async () => {
  const marker = `media_scale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = marker

  try {
    if (databaseDialect === 'sqlite') {
      const usageCounters = await readFile(
        new URL('../migrations/versioned/067c_media_usage_counters.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(usageCounters)
      const folderCounters = await readFile(
        new URL('../migrations/versioned/067f_media_folder_counters.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(folderCounters)
      const streamVideoSync = await readFile(
        new URL('../migrations/versioned/069a_media_stream_video_sync.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(streamVideoSync)
      const publicUrlIndex = await readFile(
        new URL('../migrations/versioned/069h_media_public_url_active.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(publicUrlIndex)
      const indexes = await readFile(
        new URL('../migrations/versioned/065b_media_library_indexes.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(indexes)
    }

    for (let index = 0; index < 135; index += 1) {
      const day = index < 105 ? '14' : index < 125 ? '13' : '12'
      const mediaType = index < 125 ? 'video' : 'image'
      await insertMediaRow({
        id: mediaId(marker, index),
        businessId,
        filename: index === 17 ? `special-needle-${marker}.mp4` : `clip-${marker}-${index}.mp4`,
        folderPath: mediaType === 'image' ? `images/2026/07/${day}` : `sites/2026/07/${day}`,
        mediaType,
        createdAt: `2099-12-${String(Math.floor(index / 24) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00`
      })
    }

    const firstPage = await listMediaAssets({ businessId, limit: 50 })
    assert.equal(firstPage.items.length, 50)
    assert.equal(firstPage.pageInfo.hasMore, true)
    assert.ok(firstPage.pageInfo.nextCursor)
    assert.equal(firstPage.summary.totalItems, 135)
    assert.equal(firstPage.items.every((asset) => asset.deletedAt === null), true)

    const secondPage = await listMediaAssets({
      businessId,
      limit: 50,
      cursor: firstPage.pageInfo.nextCursor
    })
    assert.equal(secondPage.items.length, 50)
    assert.equal(
      secondPage.items.some((asset) => firstPage.items.some((first) => first.id === asset.id)),
      false
    )
    assert.equal(
      firstPage.items.some((asset) => Object.hasOwn(asset, 'cursor_created_at')),
      false
    )
    const decodedPageCursor = JSON.parse(
      Buffer.from(firstPage.pageInfo.nextCursor, 'base64url').toString('utf8')
    )
    assert.equal(decodedPageCursor.v, 2)
    assert.equal(typeof decodedPageCursor.scope, 'string')
    assert.ok(decodedPageCursor.scope.length > 20)

    await assert.rejects(
      () => listMediaAssets({
        businessId,
        mediaType: 'image',
        limit: 50,
        cursor: firstPage.pageInfo.nextCursor
      }),
      (error) => error?.status === 400 && error?.code === 'invalid_media_cursor'
    )

    const clampedPage = await listMediaAssets({ businessId, limit: 500 })
    assert.equal(clampedPage.items.length, 100)
    assert.equal(clampedPage.pageInfo.limit, 100)

    const searchPage = await listMediaAssets({ businessId, search: 'special needle', limit: 50 })
    assert.equal(searchPage.items.length, 1)
    assert.match(searchPage.items[0].originalFilename, /special-needle/)

    const rootFolders = await listMediaFolders({ businessId, parentPath: '' })
    assert.deepEqual(rootFolders.items.map((folder) => folder.path), ['images', 'sites'])
    assert.equal(rootFolders.items.find((folder) => folder.path === 'sites')?.filesCount, 125)

    const nestedFolders = await listMediaFolders({ businessId, parentPath: 'sites/2026/07' })
    assert.deepEqual(nestedFolders.items.map((folder) => folder.path), [
      'sites/2026/07/13',
      'sites/2026/07/14'
    ])

    const exactFolderPage = await listMediaAssets({
      businessId,
      folderPath: 'sites/2026/07/14',
      mediaType: 'video',
      limit: 50
    })
    assert.equal(exactFolderPage.summary.totalItems, 105)
    assert.equal(exactFolderPage.items.every((asset) => asset.folderPath === 'sites/2026/07/14'), true)

    const recursiveRootPage = await listMediaAssets({
      businessId,
      folderPath: '',
      recursive: true,
      limit: 10
    })
    assert.equal(recursiveRootPage.summary.totalItems, 135)

    await assert.rejects(
      () => listMediaAssets({ businessId, cursor: 'cursor-roto' }),
      (error) => error?.status === 400 && error?.code === 'invalid_media_cursor'
    )

    if (databaseDialect === 'sqlite') {
      const folderPlan = await db.all(
        `EXPLAIN QUERY PLAN
         SELECT folder_path, files_count, used_bytes
         FROM media_folder_usage_counters
         WHERE business_id = ? AND folder_path LIKE 'sites/%'`,
        [businessId]
      )
      const folderPlanText = folderPlan.map((row) => row.detail).join('\n')
      assert.match(folderPlanText, /media_folder_usage_counters|sqlite_autoindex_media_folder_usage_counters/)
      assert.doesNotMatch(folderPlanText, /media_assets/)

      const plan = await db.all(
        `EXPLAIN QUERY PLAN
         SELECT id
         FROM media_assets
         WHERE business_id = ?
           AND folder_path = ?
           AND deleted_at IS NULL
         ORDER BY COALESCE(created_at, '1970-01-01 00:00:00') DESC, id DESC
         LIMIT 50`,
        [businessId, 'sites/2026/07/14']
      )
      assert.match(plan.map((row) => row.detail).join('\n'), /idx_media_assets_library_folder_page/)
    }
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM storage_quotas WHERE business_id = ?', [businessId]).catch(() => undefined)
  }
})

test('Media conserva carpetas vacías por cuenta y permite moverlas o eliminarlas', async () => {
  const marker = `media_user_folders_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = `${marker}_a`
  const otherBusinessId = `${marker}_b`

  try {
    const rootFolder = await createMediaFolder({
      businessId,
      name: 'Campañas 2026',
      userId: 'user_media_test'
    })
    const nestedFolder = await createMediaFolder({
      businessId,
      parentPath: rootFolder.path,
      name: 'Noviembre',
      userId: 'user_media_test'
    })

    assert.equal(rootFolder.path, 'Campañas 2026')
    assert.equal(nestedFolder.path, 'Campañas 2026/Noviembre')
    assert.deepEqual(
      (await listMediaFolders({ businessId, parentPath: '' })).items.map((folder) => folder.path),
      ['Campañas 2026']
    )
    assert.deepEqual(
      (await listMediaFolders({ businessId, parentPath: rootFolder.path })).items.map((folder) => ({
        path: folder.path,
        filesCount: folder.filesCount
      })),
      [{ path: nestedFolder.path, filesCount: 0 }]
    )
    assert.equal((await listMediaFolders({ businessId: otherBusinessId, parentPath: '' })).items.length, 0)

    await assert.rejects(
      () => createMediaFolder({ businessId, name: 'campañas 2026' }),
      (error) => error?.status === 409 && error?.code === 'media_folder_exists'
    )

    const moved = await moveMediaSelection({
      businessId,
      folderPaths: [nestedFolder.path],
      targetFolderPath: 'Archivo'
    })
    assert.equal(moved.affected, 0)
    assert.equal(moved.foldersAffected, 1)
    assert.deepEqual(
      (await listMediaFolders({ businessId, parentPath: 'Archivo' })).items.map((folder) => folder.path),
      ['Archivo/Noviembre']
    )

    const deleted = await deleteMediaSelection({
      businessId,
      folderPaths: ['Archivo/Noviembre']
    })
    assert.equal(deleted.affected, 0)
    assert.equal(deleted.foldersAffected, 1)
    assert.equal((await listMediaFolders({ businessId, parentPath: 'Archivo' })).items.length, 0)
  } finally {
    await db.run('DELETE FROM media_folders WHERE business_id IN (?, ?)', [businessId, otherBusinessId]).catch(() => undefined)
    await db.run('DELETE FROM media_assets WHERE business_id IN (?, ?)', [businessId, otherBusinessId]).catch(() => undefined)
  }
})

test('Media conserva el timestamp lossless del cursor PostgreSQL en una columna privada', async () => {
  const source = await readFile(mediaServiceSourceUrl, 'utf8')
  assert.match(
    source,
    /function mediaLibraryCursorProjectionExpression[\s\S]*?databaseDialect === 'postgres'[\s\S]*?::text/
  )
  assert.match(
    source,
    /mediaLibraryCursorProjectionExpression\(sortTimestamp\)[\s\S]{0,80}AS cursor_created_at/
  )
  assert.match(
    source,
    /ORDER BY \$\{sortTimestamp\} DESC, id DESC/
  )
})

test('lookup Stream está acotado por negocio y módulos mediante columna indexable', async () => {
  const marker = `media_stream_scope_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const videoId = `${marker}_video`
  const legacyVideoId = `${marker}_legacy_video`
  const businessA = `${marker}_a`
  const businessB = `${marker}_b`
  try {
    await insertMediaRow({ id: mediaId(marker, 0), businessId: businessA, filename: 'site.mp4', folderPath: 'sites', module: 'sites', streamVideoId: videoId, metadata: { stream: { videoId } }, createdAt: '2093-01-01 00:00:00' })
    await insertMediaRow({ id: mediaId(marker, 1), businessId: businessA, filename: 'form.mp4', folderPath: 'forms', module: 'forms', streamVideoId: videoId, metadata: { stream: { videoId } }, createdAt: '2093-01-01 00:01:00' })
    await insertMediaRow({ id: mediaId(marker, 2), businessId: businessB, filename: 'other.mp4', folderPath: 'sites', module: 'sites', streamVideoId: videoId, metadata: { stream: { videoId } }, createdAt: '2093-01-01 00:02:00' })
    await insertMediaRow({
      id: mediaId(marker, 3),
      businessId: businessA,
      filename: 'legacy.mp4',
      folderPath: 'legacy',
      module: 'other',
      streamVideoId: legacyVideoId,
      metadata: { stream: { videoId: legacyVideoId, source: { module: 'sites' } } },
      createdAt: '2093-01-01 00:03:00'
    })
    // El insert SQLite no cambia module dentro de otro AFTER INSERT (eso
    // duplicaba contadores). Una actualizacion real de metadata usa el trigger
    // de UPDATE y reconcilia el modulo exactamente una vez.
    await db.run(
      'UPDATE media_assets SET metadata_json = metadata_json WHERE id = ?',
      [mediaId(marker, 3)]
    )

    const sites = await findMediaAssetsByBunnyStreamVideoIds([videoId], { businessId: businessA, modules: ['sites'] })
    assert.deepEqual(sites.map((asset) => asset.id), [mediaId(marker, 0)])
    assert.equal(sites[0].streamVideoId, videoId)
    const forms = await findMediaAssetsByBunnyStreamVideoIds([videoId], { businessId: businessA, modules: ['forms'] })
    assert.deepEqual(forms.map((asset) => asset.id), [mediaId(marker, 1)])
    const legacy = await findMediaAssetsByBunnyStreamVideoIds([legacyVideoId], { businessId: businessA, modules: ['sites'] })
    assert.deepEqual(legacy.map((asset) => asset.id), [mediaId(marker, 3)])
    assert.equal(legacy[0].module, 'sites')

    if (databaseDialect === 'sqlite') {
      const plan = await db.all(
        `EXPLAIN QUERY PLAN
         SELECT id FROM media_assets
         WHERE business_id = ? AND module IN ('sites') AND media_type = 'video'
           AND stream_video_id IN (?) AND deleted_at IS NULL AND status != 'deleted'`,
        [businessA, videoId]
      )
      assert.match(plan.map((row) => row.detail).join('\n'), /idx_media_assets_stream_video_scope/)

      const publicUrlPlan = await db.all(
        `EXPLAIN QUERY PLAN
         SELECT id FROM media_assets
         WHERE public_url IN (?) AND deleted_at IS NULL AND status != 'deleted'`,
        [`https://media.example.test/${mediaId(marker, 0)}.mp4`]
      )
      assert.match(publicUrlPlan.map((row) => row.detail).join('\n'), /idx_media_assets_public_url_active/)
    }
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id IN (?, ?)', [businessA, businessB]).catch(() => undefined)
    await db.run('DELETE FROM media_storage_usage_counters WHERE business_id IN (?, ?)', [businessA, businessB]).catch(() => undefined)
  }
})

test('SQLite no duplica contadores cuando Stream trae un módulo distinto al insertado', async () => {
  if (databaseDialect !== 'sqlite') return
  const marker = `media_stream_counter_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  try {
    await insertMediaRow({
      id: mediaId(marker, 0),
      businessId: marker,
      filename: 'counter.mp4',
      folderPath: 'sites/counter',
      module: 'other',
      quotaSize: 123,
      metadata: { stream: { videoId: `${marker}_video`, source: { module: 'sites' } } },
      createdAt: '2091-01-01 00:00:00'
    })

    const usage = await db.get(
      `SELECT COALESCE(SUM(files_count), 0) AS files_count,
              COALESCE(SUM(used_bytes), 0) AS used_bytes
       FROM media_storage_usage_counters WHERE business_id = ?`,
      [marker]
    )
    const folders = await db.get(
      `SELECT COALESCE(SUM(files_count), 0) AS files_count,
              COALESCE(SUM(used_bytes), 0) AS used_bytes
       FROM media_folder_usage_counters WHERE business_id = ?`,
      [marker]
    )
    assert.deepEqual([Number(usage.files_count), Number(usage.used_bytes)], [1, 123])
    assert.deepEqual([Number(folders.files_count), Number(folders.used_bytes)], [1, 123])
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [marker]).catch(() => undefined)
  }
})

test('carpetas remotas grandes se rechazan antes de iniciar red', async () => {
  const marker = `media_remote_cap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = marker
  try {
    for (let index = 0; index < 26; index += 1) {
      await insertMediaRow({
        id: mediaId(marker, index),
        businessId,
        filename: `remote-${index}.mp4`,
        folderPath: 'remote/source',
        storageProvider: 'bunny',
        createdAt: `2092-01-01 00:${String(index).padStart(2, '0')}:00`
      })
    }
    const remoteIds = Array.from({ length: 26 }, (_, index) => mediaId(marker, index))
    await assert.rejects(
      () => moveMediaAssets({ businessId, assetIds: remoteIds, targetFolderPath: 'archive' }),
      (error) => error?.status === 413 && error?.code === 'media_remote_selection_requires_smaller_batch'
    )
    await assert.rejects(
      () => moveMediaSelection({ businessId, folderPaths: ['remote/source'], targetFolderPath: 'archive' }),
      (error) => error?.status === 413 && error?.code === 'media_remote_selection_requires_smaller_batch'
    )
    assert.equal(Number((await db.get(
      `SELECT COUNT(*) AS total FROM media_assets
       WHERE business_id = ? AND folder_path = 'remote/source'`,
      [businessId]
    )).total), 26)
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM media_storage_usage_counters WHERE business_id = ?', [businessId]).catch(() => undefined)
  }
})

test('mover y eliminar carpetas resuelve todo el alcance en backend, incluso más de una página', async () => {
  const marker = `media_scope_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = marker

  try {
    await db.run(
      `INSERT INTO storage_quotas (business_id, quota_gb, quota_bytes, used_bytes, storage_enabled)
       VALUES (?, 5, 5368709120, 0, 1)
       ON CONFLICT (business_id) DO NOTHING`,
      [businessId]
    )
    for (let index = 0; index < 105; index += 1) {
      await insertMediaRow({
        id: mediaId(marker, index),
        businessId,
        filename: `scope-${index}.mp4`,
        folderPath: 'move/source/nested',
        createdAt: `2098-10-${String(Math.floor(index / 24) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00`
      })
    }
    for (let index = 105; index < 108; index += 1) {
      await insertMediaRow({
        id: mediaId(marker, index),
        businessId,
        filename: `delete-${index}.mp4`,
        folderPath: 'delete/source',
        createdAt: `2098-11-01 00:0${index - 105}:00`
      })
    }

    const moved = await moveMediaSelection({
      businessId,
      folderPaths: ['move/source'],
      targetFolderPath: 'archive'
    })
    assert.equal(moved.attempted, 105)
    assert.equal(moved.affected, 105)
    const movedRows = await db.all(
      `SELECT folder_path FROM media_assets
       WHERE business_id = ? AND id LIKE ?`,
      [businessId, `${marker}_%`]
    )
    assert.equal(
      movedRows.filter((row) => row.folder_path === 'archive/source/nested').length,
      105
    )

    const movedToRoot = await moveMediaSelection({
      businessId,
      assetIds: [mediaId(marker, 0)],
      targetFolderPath: ''
    })
    assert.equal(movedToRoot.affected, 1)
    const rootRow = await db.get('SELECT folder_path FROM media_assets WHERE id = ?', [mediaId(marker, 0)])
    assert.equal(rootRow.folder_path, '')

    await assert.rejects(
      () => moveMediaSelection({
        businessId,
        folderPaths: ['archive/source'],
        targetFolderPath: 'archive/source/inside'
      }),
      (error) => error?.status === 400 && error?.code === 'invalid_media_move_target'
    )

    const deleted = await deleteMediaSelection({
      businessId,
      folderPaths: ['delete/source']
    })
    assert.equal(deleted.affected, 3)
    const activeDeletedFolder = await db.get(
      `SELECT COUNT(*) AS total
       FROM media_assets
       WHERE business_id = ? AND folder_path = 'delete/source' AND deleted_at IS NULL`,
      [businessId]
    )
    assert.equal(Number(activeDeletedFolder.total), 0)
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM storage_quotas WHERE business_id = ?', [businessId]).catch(() => undefined)
  }
})

test('Media conserva filtros en carpetas, valida IDs explícitos y acota operaciones sin job', async () => {
  const marker = `media_scope_guard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = marker
  const folderPath = 'filtered/source'
  const videoReadyId = mediaId(marker, 0)
  const imageReadyId = mediaId(marker, 1)
  const videoFailedId = mediaId(marker, 2)
  const largeFolder = 'too-large/source'

  try {
    await insertMediaRow({ id: videoReadyId, businessId, filename: 'ready.mp4', folderPath, mediaType: 'video', status: 'ready', createdAt: '2097-01-01 00:00:00' })
    await insertMediaRow({ id: imageReadyId, businessId, filename: 'ready.png', folderPath, mediaType: 'image', status: 'ready', createdAt: '2097-01-01 00:01:00' })
    await insertMediaRow({ id: videoFailedId, businessId, filename: 'failed.mp4', folderPath, mediaType: 'video', status: 'failed', createdAt: '2097-01-01 00:02:00' })

    const moved = await moveMediaSelection({
      businessId,
      folderPaths: [folderPath],
      mediaType: 'video',
      status: 'ready',
      targetFolderPath: 'archive'
    })
    assert.equal(moved.affected, 1)
    assert.equal((await db.get('SELECT folder_path FROM media_assets WHERE id = ?', [videoReadyId])).folder_path, 'archive/source')
    assert.equal((await db.get('SELECT folder_path FROM media_assets WHERE id = ?', [imageReadyId])).folder_path, folderPath)
    assert.equal((await db.get('SELECT folder_path FROM media_assets WHERE id = ?', [videoFailedId])).folder_path, folderPath)

    await assert.rejects(
      () => moveMediaSelection({
        businessId,
        assetIds: [imageReadyId],
        mediaType: 'video',
        targetFolderPath: 'wrong-scope'
      }),
      (error) => error?.status === 404 && error?.code === 'media_selection_assets_missing'
    )
    assert.equal((await db.get('SELECT folder_path FROM media_assets WHERE id = ?', [imageReadyId])).folder_path, folderPath)

    const deleted = await deleteMediaSelection({
      businessId,
      folderPaths: [folderPath],
      mediaType: 'video',
      status: 'failed'
    })
    assert.equal(deleted.affected, 1)
    assert.equal(Number((await db.get('SELECT COUNT(*) AS total FROM media_assets WHERE id = ? AND deleted_at IS NULL', [imageReadyId])).total), 1)

    await db.transaction(async (transaction) => {
      for (let index = 0; index < 2001; index += 1) {
        await insertMediaRow({
          id: `${marker}_large_${String(index).padStart(4, '0')}`,
          businessId,
          filename: `large-${index}.mp4`,
          folderPath: largeFolder,
          createdAt: `2096-01-01 00:${String(index % 60).padStart(2, '0')}:00`,
          database: transaction
        })
      }
    })
    await assert.rejects(
      () => deleteMediaSelection({ businessId, folderPaths: [largeFolder] }),
      (error) => error?.status === 413 && error?.code === 'media_selection_requires_background_job'
    )
    assert.equal(Number((await db.get(
      'SELECT COUNT(*) AS total FROM media_assets WHERE business_id = ? AND folder_path = ? AND deleted_at IS NULL',
      [businessId, largeFolder]
    )).total), 2001)
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM media_storage_usage_counters WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM storage_quotas WHERE business_id = ?', [businessId]).catch(() => undefined)
  }
})

test('uso de Media lee contadores durables sin recalcular ni escribir la cuota', async () => {
  const marker = `media_usage_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = marker
  try {
    await db.run(
      `INSERT INTO storage_quotas (business_id, quota_gb, quota_bytes, used_bytes, storage_enabled, updated_at)
       VALUES (?, 5, 5368709120, 0, 1, '2000-01-01 00:00:00')`,
      [businessId]
    )
    await insertMediaRow({
      id: mediaId(marker, 0),
      businessId,
      filename: 'usage.mp4',
      folderPath: 'usage',
      createdAt: '2095-01-01 00:00:00'
    })
    await moveMediaAssets({ businessId, assetIds: [mediaId(marker, 0)], targetFolderPath: 'usage-moved' })
    await db.run(
      `UPDATE storage_quotas SET used_bytes = 777, updated_at = '2000-01-01 00:00:00' WHERE business_id = ?`,
      [businessId]
    )
    const usage = await getStorageUsage({ businessId })
    assert.equal(usage.used_bytes, 80)
    assert.equal(usage.files_count, 1)
    assert.equal(usage.by_media_type.videos, 80)
    const quotaAfterRead = await db.get(
      'SELECT used_bytes, updated_at FROM storage_quotas WHERE business_id = ?',
      [businessId]
    )
    assert.equal(Number(quotaAfterRead.used_bytes), 777)
    assert.equal(new Date(quotaAfterRead.updated_at).getUTCFullYear(), 2000)
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM media_storage_usage_counters WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM storage_quotas WHERE business_id = ?', [businessId]).catch(() => undefined)
  }
})

test('Media consulta varios módulos con un cursor y el ZIP exige un presupuesto verificable', async () => {
  const marker = `media_modules_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const businessId = marker
  try {
    await insertMediaRow({ id: mediaId(marker, 0), businessId, filename: 'site.mp4', folderPath: 'sites', module: 'sites', createdAt: '2094-01-01 00:00:00' })
    await insertMediaRow({ id: mediaId(marker, 1), businessId, filename: 'form.mp4', folderPath: 'forms', module: 'forms', createdAt: '2094-01-01 00:01:00' })
    await insertMediaRow({ id: mediaId(marker, 2), businessId, filename: 'chat.mp4', folderPath: 'chat', module: 'chat', createdAt: '2094-01-01 00:02:00' })

    const combined = await listMediaAssets({ businessId, modules: ['sites', 'forms', 'sites'], includeFolders: false })
    assert.deepEqual(new Set(combined.items.map((asset) => asset.module)), new Set(['sites', 'forms']))
    const exactWins = await listMediaAssets({ businessId, module: 'chat', modules: ['sites', 'forms'], includeFolders: false })
    assert.equal(exactWins.items.length, 1)
    assert.equal(exactWins.items[0].module, 'chat')
    await assert.rejects(
      () => listMediaAssets({
        businessId,
        modules: ['chat', 'products', 'sites', 'forms', 'courses', 'appointments', 'landing', 'documents', 'automations']
      }),
      (error) => error?.status === 400 && error?.code === 'invalid_media_modules'
    )

    assert.equal(validateMediaArchiveEntries([{ sizeBytes: 512 * 1024 * 1024 }]), 512 * 1024 * 1024)
    assert.throws(
      () => validateMediaArchiveEntries([{ sizeBytes: 512 * 1024 * 1024 + 1 }]),
      (error) => error?.status === 413 && error?.code === 'media_archive_bytes_too_large'
    )
    assert.throws(
      () => validateMediaArchiveEntries([{ sizeBytes: 0 }]),
      (error) => error?.status === 409 && error?.code === 'media_archive_size_unknown'
    )
  } finally {
    await db.run('DELETE FROM media_assets WHERE business_id = ?', [businessId]).catch(() => undefined)
    await db.run('DELETE FROM media_storage_usage_counters WHERE business_id = ?', [businessId]).catch(() => undefined)
  }
})

test('Media separa el drop externo de mover assets y conserva carpetas del Finder', async () => {
  const mediaSettings = await readFile(mediaSettingsSourceUrl, 'utf8')
  const externalDetection = mediaSettings.slice(
    mediaSettings.indexOf('function dataTransferHasExternalFiles'),
    mediaSettings.indexOf('function directoryPathFromRelativeFilePath')
  )
  const externalDrop = mediaSettings.slice(
    mediaSettings.indexOf('const handleExternalDrop ='),
    mediaSettings.indexOf('const handleCopyLink =')
  )

  assert.match(externalDetection, /dataTransferHasMediaPayload\(dataTransfer\)/)
  assert.match(externalDetection, /includes\('Files'\)/)
  assert.match(mediaSettings, /webkitGetAsEntry/)
  assert.match(mediaSettings, /while \(true\)/)
  assert.match(mediaSettings, /collectDragEntryFiles\(child, relativePath\)/)
  assert.match(mediaSettings, /joinFolderPath\(destinationPath, upload\.relativeFolderPath\)/)
  assert.match(mediaSettings, /event\.dataTransfer\.dropEffect = 'copy'/)
  assert.match(externalDrop, /readExternalDroppedFiles\(event\.dataTransfer\)/)
  assert.match(externalDrop, /uploadLocalFiles\(uploads, destinationPath/)
  assert.match(mediaSettings, /data-media-folder-path=/)
  assert.match(mediaSettings, /Suelta para subir/)
})

test('el backfill SQLite conserva la ruta visible y el contrato frontend no descarga la biblioteca completa', async () => {
  assert.equal(
    mediaFolderPathFromObjectPath('accounts/cliente/sites/2026/07/14/video.mp4'),
    'sites/2026/07/14'
  )
  assert.equal(
    mediaFolderPathFromObjectPath('businesses/default/documents/2026/07/file.pdf'),
    'documents/2026/07'
  )
  assert.equal(
    mediaFolderPathFromObjectPath('accounts/acme/root.mp4', 'sites'),
    'sites'
  )

  if (databaseDialect === 'sqlite') {
    const marker = `media_backfill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    try {
      await db.run(
        `INSERT INTO media_assets (
           id, business_id, original_filename, bunny_path, folder_path,
           media_type, module, status, storage_provider, metadata_json
         ) VALUES (?, ?, 'video.mp4', ?, '', 'video', 'sites', 'ready', 'local', '{}')`,
        [marker, marker, `accounts/${marker}/sites/2026/07/14/video.mp4`]
      )
      const backfill = await readFile(
        new URL('../migrations/versioned/065a_media_library_folder_backfill.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(backfill)
      const row = await db.get('SELECT folder_path FROM media_assets WHERE id = ?', [marker])
      assert.equal(row.folder_path, 'sites/2026/07/14')
    } finally {
      await db.run('DELETE FROM media_assets WHERE id = ?', [marker]).catch(() => undefined)
    }
  }

  const [backendSource, frontendService, mediaSettings, sites, sqliteFolderCounters, pgFolderCounters, pgFolderBackfill] = await Promise.all([
    readFile(mediaServiceSourceUrl, 'utf8'),
    readFile(frontendServiceSourceUrl, 'utf8'),
    readFile(mediaSettingsSourceUrl, 'utf8'),
    readFile(sitesSourceUrl, 'utf8'),
    readFile(new URL('../migrations/versioned/067f_media_folder_counters.sqlite.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/067gc_media_folder_counter_backfill_cleanup.postgres.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/versioned/067_media_folder_backfill_procedure.postgres.sql', import.meta.url), 'utf8')
  ])
  const listFunction = backendSource.slice(
    backendSource.indexOf('export async function listMediaAssets'),
    backendSource.indexOf('export async function getStorageUsage')
  )
  const folderListFunction = backendSource.slice(
    backendSource.indexOf('export async function listMediaFolders'),
    backendSource.indexOf('export async function listMediaAssets')
  )
  const loadMoreCurrentFolders = mediaSettings.slice(
    mediaSettings.indexOf('const loadMoreCurrentFolders'),
    mediaSettings.indexOf('const loadMoreRootFolders')
  )
  const loadMoreRootFolders = mediaSettings.slice(
    mediaSettings.indexOf('const loadMoreRootFolders'),
    mediaSettings.indexOf('const isMoveTargetDisabled')
  )
  const loadMoveFolders = mediaSettings.slice(
    mediaSettings.indexOf('const loadMoveFolders'),
    mediaSettings.indexOf('const openMoveDialog')
  )
  const closeMoveDialog = mediaSettings.slice(
    mediaSettings.indexOf('const closeMoveDialog'),
    mediaSettings.indexOf('const openMoveFolderPath')
  )
  assert.match(listFunction, /safeLimit \+ 1/)
  assert.match(listFunction, /cursor_created_at/)
  assert.match(listFunction, /ORDER BY \$\{sortTimestamp\} DESC, id DESC/)
  assert.doesNotMatch(listFunction, /SELECT \*/)
  assert.doesNotMatch(listFunction, /OFFSET/)
  assert.doesNotMatch(listFunction, /GROUP BY media_type|COUNT\(\*\) AS total_items/)
  assert.doesNotMatch(listFunction, /listMediaFolders\(/)
  assert.match(folderListFunction, /media_folder_usage_counters/)
  assert.doesNotMatch(folderListFunction, /FROM media_assets/)
  assert.doesNotMatch(sqliteFolderCounters, /DELETE FROM media_folder_usage_counters\s+WHERE files_count = 0/)
  assert.doesNotMatch(pgFolderCounters, /DELETE FROM media_folder_usage_counters\s+WHERE files_count = 0/)
  assert.match(pgFolderBackfill, /BEFORE INSERT ON media_assets/)
  assert.doesNotMatch(pgFolderBackfill, /BEFORE INSERT OR UPDATE/)
  assert.doesNotMatch(frontendService, /listAllAssets/)
  assert.match(mediaSettings, /MEDIA_LIBRARY_PAGE_SIZE = 50/)
  assert.match(mediaSettings, /search: normalizedQuery \|\| undefined/)
  assert.match(mediaSettings, /moveSelection/)
  assert.match(mediaSettings, /deleteSelection/)
  assert.match(mediaSettings, /folderRequestVersionRef/)
  assert.match(mediaSettings, /rootFolderRequestVersionRef/)
  assert.match(mediaSettings, /moveFolderRequestVersionRef/)
  assert.match(loadMoreCurrentFolders, /requestVersion !== folderRequestVersionRef\.current/)
  assert.match(loadMoreRootFolders, /requestVersion !== rootFolderRequestVersionRef\.current/)
  assert.match(loadMoveFolders, /requestVersion !== moveFolderRequestVersionRef\.current/)
  assert.match(loadMoveFolders, /requestVersion === moveFolderRequestVersionRef\.current/)
  assert.match(closeMoveDialog, /moveFolderRequestVersionRef\.current \+= 1/)
  assert.match(mediaSettings, /void loadCurrentFolders\(\)/)
  assert.match(mediaSettings, /includeFolders: false/)
  assert.match(mediaSettings, /libraryItemsCountIsLowerBound/)
  assert.match(mediaSettings, /mediaType: mediaTypeFilter/)
  assert.match(backendSource, /MEDIA_SELECTION_MAX_RESOLVED_ITEMS = 2_000/)
  assert.match(backendSource, /mimeType: thumbnail\.mimeType \|\| 'image\/webp',\s+deadlineAt: operationDeadlineAt/)
  const controllerSource = await readFile(new URL('../src/controllers/mediaController.js', import.meta.url), 'utf8')
  assert.match(controllerSource, /generateNodeStream/)
  assert.match(controllerSource, /lazyBoundedArchiveStream/)
  assert.doesNotMatch(controllerSource.slice(
    controllerSource.indexOf('export async function downloadMediaAssetsArchiveHandler'),
    controllerSource.indexOf('export async function moveMediaAssetsHandler')
  ), /getMediaAssetBuffer/)
  assert.match(sites, /mediaPickerPageSize = 50/)
  assert.match(sites, /includeMeta: false/)
  assert.doesNotMatch(sites, /listAllAssets/)
})
