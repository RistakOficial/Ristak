// Migración de la taxonomía del Bunny central (Fase D), como servicio reutilizable.
//
// Re-enraíza los archivos YA existentes de la estructura vieja
//   accounts/<id-tecnico>/...  ó  businesses/<id>/...
// a la nueva, legible por cliente:  accounts/<slug>/...  (el resto de la ruta se
// conserva). Reescribe todas las referencias para que ninguna URL quede rota.
//
// SEGURO POR DISEÑO: por defecto NO borra lo viejo (deleteOld=false). Copia a la
// ruta nueva y re-apunta todo; los archivos viejos quedan como respaldo, así es
// IMPOSIBLE romper un sitio o un chat. La limpieza de huérfanos es un paso aparte.
// Idempotente: re-ejecutar no hace daño; se auto-cura si algo falló a medias.
import fetch from 'node-fetch'
import { db } from '../config/database.js'
import { logger } from '../utils/logger.js'
import {
  getStorageRuntimeConfig,
  getCurrentClientAccountContext,
  resolveBunnyObjectUrl,
  resolveBunnyPublicUrl,
  deleteBunnyObject
} from './mediaStorageService.js'

// Tablas/columnas (texto o JSON) que guardan URLs públicas de media.
export const REFERENCE_COLUMNS = [
  ['public_sites', 'theme_json'],
  ['public_site_blocks', 'settings_json'],
  ['public_site_import_assets', 'public_url'],
  ['meta_social_contacts', 'profile_picture_url'],
  ['whatsapp_api_contacts', 'profile_picture_url'],
  ['whatsapp_api_phone_numbers', 'profile_picture_url'],
  ['meta_social_messages', 'media_url'],
  ['whatsapp_api_messages', 'media_url']
]

// Re-enraíza un objectPath viejo al root destino (accounts/<slug>), conservando el
// resto de la ruta. Devuelve null si no es re-enraizable (no es accounts/ ni businesses/).
export function reRootPath(oldPath = '', targetRoot = '') {
  const segs = String(oldPath).split('/').filter(Boolean)
  if (segs.length < 3) return null
  const [root] = segs
  if (root !== 'accounts' && root !== 'businesses') return null
  const rest = segs.slice(2)
  const targetSegs = String(targetRoot).split('/').filter(Boolean)
  if (!targetSegs.length) return null
  return [...targetSegs, ...rest].join('/')
}

// Reescribe (en la DB) una URL vieja por la nueva en todas las tablas de referencia.
// REPLACE es exacto e idempotente.
export async function rewriteReferences(dbClient, pairs = []) {
  for (const [table, column] of REFERENCE_COLUMNS) {
    for (const [oldUrl, newUrl] of pairs) {
      if (!oldUrl || !newUrl || oldUrl === newUrl) continue
      await dbClient
        .run(`UPDATE ${table} SET ${column} = REPLACE(${column}, ?, ?) WHERE ${column} LIKE ?`, [oldUrl, newUrl, `%${oldUrl}%`])
        .catch(() => {})
    }
  }
}

// Actualiza la fila del propio asset (ruta, URL pública/privada y URLs dentro del
// metadata_json, incluida la miniatura). Al mover media_assets, las URLs-proxy
// (/media/assets/:id/file) siguen resolviendo solas a la ruta nueva.
export async function updateAssetRow(dbClient, move) {
  const row = await dbClient.get('SELECT metadata_json, private_url FROM media_assets WHERE id = ?', [move.id])
  const replaceAll = (text) => {
    let out = String(text || '')
    out = out.split(move.oldPath).join(move.newPath)
    out = out.split(move.oldPublic).join(move.newPublic)
    if (move.thumbOldPath && move.thumbNewPath) out = out.split(move.thumbOldPath).join(move.thumbNewPath)
    if (move.thumbOldPublic && move.thumbNewPublic) out = out.split(move.thumbOldPublic).join(move.thumbNewPublic)
    return out
  }
  const metaText = replaceAll(row?.metadata_json || '{}')
  const newPrivate = row?.private_url ? replaceAll(row.private_url) : null
  await dbClient.run(
    'UPDATE media_assets SET bunny_path = ?, public_url = ?, private_url = ?, metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [move.newPath, move.newPublic, newPrivate, metaText, move.id]
  )
}

// Construye la lista de movimientos a partir de los assets de Bunny fuera del destino.
export async function planMoves(dbClient, config, targetRoot, limit = 0) {
  const rows = await dbClient.all(
    `SELECT id, bunny_path, public_url, private_url, metadata_json
       FROM media_assets
      WHERE storage_provider = 'bunny'
        AND deleted_at IS NULL
        AND bunny_path IS NOT NULL AND bunny_path <> ''
        AND bunny_path NOT LIKE ?`,
    [`${targetRoot}/%`]
  )
  const moves = []
  for (const row of rows) {
    const newPath = reRootPath(row.bunny_path, targetRoot)
    if (!newPath || newPath === row.bunny_path) continue
    let meta = {}
    try { meta = JSON.parse(row.metadata_json || '{}') } catch { meta = {} }
    const thumbOldPath = meta?.variants?.thumbnail?.path || ''
    const thumbNewPath = thumbOldPath ? reRootPath(thumbOldPath, targetRoot) : ''
    moves.push({
      id: row.id,
      oldPath: row.bunny_path,
      newPath,
      oldPublic: row.public_url || resolveBunnyPublicUrl(config, row.bunny_path),
      newPublic: resolveBunnyPublicUrl(config, newPath),
      thumbOldPath,
      thumbNewPath: thumbNewPath || '',
      thumbOldPublic: meta?.variants?.thumbnail?.publicUrl || (thumbOldPath ? resolveBunnyPublicUrl(config, thumbOldPath) : ''),
      thumbNewPublic: thumbNewPath ? resolveBunnyPublicUrl(config, thumbNewPath) : ''
    })
  }
  return limit ? moves.slice(0, limit) : moves
}

async function bunnyGet(config, path) {
  return fetch(resolveBunnyObjectUrl(config, path), { headers: { AccessKey: config.bunnyStorageApiKey } })
}

async function copyBunnyObject(config, fromPath, toPath) {
  const getRes = await bunnyGet(config, fromPath)
  if (getRes.status === 404) throw new Error('el archivo viejo ya no existe en Bunny')
  if (!getRes.ok) throw new Error(`no se pudo descargar el viejo (${getRes.status})`)
  const buffer = Buffer.from(await getRes.arrayBuffer())
  const putRes = await fetch(resolveBunnyObjectUrl(config, toPath), {
    method: 'PUT',
    headers: {
      AccessKey: config.bunnyStorageApiKey,
      'Content-Type': getRes.headers.get('content-type') || 'application/octet-stream'
    },
    body: buffer
  })
  if (!putRes.ok) throw new Error(`no se pudo subir el nuevo (${putRes.status})`)
}

// Corre la migración. Opciones:
//  - dryRun: solo planifica y reporta, no toca nada.
//  - deleteOld: si true, borra el archivo viejo tras verificar (por defecto NO).
//  - limit / log.
export async function runStorageTaxonomyMigration({ dryRun = true, deleteOld = false, limit = 0, log = () => {} } = {}) {
  const config = await getStorageRuntimeConfig()
  if (config.provider !== 'bunny' || !config.bunnyConfigured) {
    return { skipped: true, reason: 'bunny_no_configurado', planned: 0, migrated: 0, failed: 0 }
  }
  const account = await getCurrentClientAccountContext()
  const targetRoot = account.rootPath

  const moves = await planMoves(db, config, targetRoot, limit)
  log(`Cuenta ${account.label || account.id} → destino ${targetRoot}/ · archivos a re-enraizar: ${moves.length}`)
  if (!moves.length) return { skipped: false, targetRoot, planned: 0, migrated: 0, failed: 0 }

  if (dryRun) {
    for (const m of moves.slice(0, 8)) log(`  ${m.oldPath} → ${m.newPath}`)
    return { skipped: false, dryRun: true, targetRoot, planned: moves.length, migrated: 0, failed: 0, moves }
  }

  let migrated = 0
  let failed = 0
  let gone = 0
  for (const m of moves) {
    try {
      await copyBunnyObject(config, m.oldPath, m.newPath)
      if (m.thumbOldPath && m.thumbNewPath) await copyBunnyObject(config, m.thumbOldPath, m.thumbNewPath).catch(() => {})
      const check = await bunnyGet(config, m.newPath)
      if (!check.ok) throw new Error('el archivo nuevo no quedó accesible')
      await rewriteReferences(db, [
        [m.oldPublic, m.newPublic],
        [m.thumbOldPublic, m.thumbNewPublic]
      ])
      await updateAssetRow(db, m)
      if (deleteOld) {
        await deleteBunnyObject(config, m.oldPath)
        if (m.thumbOldPath) await deleteBunnyObject(config, m.thumbOldPath)
      }
      migrated++
      log(`✓ ${m.id} ${m.oldPath} → ${m.newPath}`)
    } catch (err) {
      // Si el archivo viejo ya no existe, no es un fallo reintentable: se marca
      // como ausente para no bloquear el cierre de la migración (bucle infinito).
      if (/ya no existe/i.test(err?.message || '')) {
        gone++
        log(`· ${m.id} ${m.oldPath} — viejo ausente en Bunny, se omite`)
      } else {
        failed++
        log(`✗ ${m.id} ${m.oldPath} — ${err.message} (viejo intacto)`)
      }
    }
  }
  return { skipped: false, targetRoot, planned: moves.length, migrated, gone, failed, deletedOld: deleteOld }
}

// Disparador de arranque: corre la migración UNA sola vez por instalación, en
// segundo plano, sin borrar lo viejo (respaldo intacto). Se apaga solo al terminar.
// Controlable con STORAGE_TAXONOMY_AUTOMIGRATE=off para desactivarlo.
export async function scheduleStartupStorageTaxonomyMigration() {
  try {
    if (/^(0|false|off|no)$/i.test(cleanEnv(process.env.STORAGE_TAXONOMY_AUTOMIGRATE))) return
    const row = await db.get('SELECT taxonomy_migrated_at FROM storage_settings WHERE id = 1').catch(() => null)
    if (row?.taxonomy_migrated_at) return // ya corrió en esta instalación

    // En segundo plano: nunca bloquea el arranque del servidor.
    setTimeout(() => {
      runStorageTaxonomyMigration({ dryRun: false, deleteOld: false, log: (m) => logger.info(`[TaxonomyMigration] ${m}`) })
        .then(async (res) => {
          const note = res.skipped
            ? `omitida (${res.reason})`
            : `migrados ${res.migrated}/${res.planned}, ausentes ${res.gone || 0}, fallidos ${res.failed} (sin borrar lo viejo)`
          logger.info(`[TaxonomyMigration] ${note}`)
          // Marcar como corrida solo si no quedó nada pendiente por reintentar.
          if (res.skipped || res.failed === 0) {
            await db
              .run("UPDATE storage_settings SET taxonomy_migrated_at = CURRENT_TIMESTAMP, taxonomy_migration_note = ? WHERE id = 1", [note])
              .catch(() => {})
          } else {
            logger.warn(`[TaxonomyMigration] quedaron ${res.failed} pendientes; se reintentará en el próximo arranque`)
          }
        })
        .catch((err) => logger.warn(`[TaxonomyMigration] error: ${err?.message || err}`))
    }, 15_000) // pequeño delay para no competir con el arranque
  } catch (err) {
    logger.warn(`[TaxonomyMigration] no se pudo agendar: ${err?.message || err}`)
  }
}

function cleanEnv(value = '') {
  return String(value || '').trim()
}
