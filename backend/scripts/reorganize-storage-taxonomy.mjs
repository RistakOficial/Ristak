// Fase D — Migración de la taxonomía del Bunny central.
//
// Re-enraíza los archivos YA existentes de la estructura vieja
//   accounts/<id-tecnico>/...  ó  businesses/<id>/...
// a la nueva, legible por cliente:
//   accounts/<slug>/...   (el resto de la ruta —categoría/fecha/archivo— se conserva)
// y REESCRIBE todas las referencias (sitios publicados, historial de chat, avatares,
// assets importados) para que ninguna URL quede rota.
//
// Es SEGURO por diseño: copia→verifica→reescribe→borra (el viejo solo se borra al
// final). Idempotente: se puede re-ejecutar sin daño; se auto-cura si algo falló.
//
// Uso:
//   node scripts/reorganize-storage-taxonomy.mjs                 # DRY-RUN (no toca nada)
//   node scripts/reorganize-storage-taxonomy.mjs --execute --yes # aplica de verdad
//   ... --limit=50                                               # procesa solo N
import 'dotenv/config'
import { fileURLToPath } from 'url'
import fetch from 'node-fetch'
import { db } from '../src/config/database.js'
import {
  getStorageRuntimeConfig,
  getCurrentClientAccountContext,
  resolveBunnyObjectUrl,
  resolveBunnyPublicUrl,
  deleteBunnyObject
} from '../src/services/mediaStorageService.js'

// Tablas/columnas (texto o JSON) que guardan URLs públicas de media y deben
// reescribirse cuando un archivo cambia de ruta.
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
  const rest = segs.slice(2) // quita <root>/<id-viejo>
  const targetSegs = String(targetRoot).split('/').filter(Boolean)
  if (!targetSegs.length) return null
  return [...targetSegs, ...rest].join('/')
}

// Reescribe (en la DB) una URL vieja por la nueva en todas las tablas de referencia.
// REPLACE es exacto e idempotente: re-ejecutar no hace daño.
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
// metadata_json, incluida la miniatura).
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

async function main() {
  const argv = process.argv.slice(2)
  const EXECUTE = argv.includes('--execute')
  const CONFIRMED = argv.includes('--yes')
  const limitArg = argv.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Math.max(0, parseInt(limitArg.split('=')[1], 10) || 0) : 0
  const log = (...a) => console.log(...a)

  const config = await getStorageRuntimeConfig()
  if (config.provider !== 'bunny' || !config.bunnyConfigured) {
    log('❌ Bunny no está configurado en este entorno; no hay nada que migrar en el CDN.')
    process.exit(1)
  }
  const account = await getCurrentClientAccountContext()
  const targetRoot = account.rootPath // accounts/<slug>

  log('── Migración de taxonomía del Bunny central ──')
  log(`Cuenta:        ${account.label || account.id}`)
  log(`Destino nuevo: ${targetRoot}/`)
  log(`CDN base:      ${config.bunnyCdnBaseUrl}`)
  log(`Modo:          ${EXECUTE ? '⚠️  EXECUTE (mueve de verdad)' : 'DRY-RUN (solo reporta, no toca nada)'}\n`)

  const moves = await planMoves(db, config, targetRoot, limit)
  log(`Archivos a re-enraizar: ${moves.length}\n`)
  if (!moves.length) {
    log('✅ Nada que migrar: todo ya está bajo la nueva taxonomía.')
    process.exit(0)
  }

  log('Ejemplos (old → new):')
  for (const m of moves.slice(0, 6)) log(`  ${m.oldPath}\n    → ${m.newPath}`)
  log('')

  // Conteo de referencias por tabla, por prefijo de root viejo (rápido, informativo).
  const rootPrefixes = [...new Set(moves.map((m) => m.oldPath.split('/').slice(0, 2).join('/')))]
  log('Referencias afectadas por tabla (aprox., por prefijo viejo):')
  for (const [table, column] of REFERENCE_COLUMNS) {
    let count = 0
    for (const prefix of rootPrefixes) {
      const r = await db
        .get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ?`, [`%${config.bunnyCdnBaseUrl}/${prefix}/%`])
        .catch(() => ({ n: 0 }))
      count += Number(r?.n || 0)
    }
    log(`  ${table}.${column}: ${count}`)
  }
  log('')

  if (!EXECUTE) {
    log('DRY-RUN: no se movió ni reescribió nada.')
    log('Para aplicarlo: node scripts/reorganize-storage-taxonomy.mjs --execute --yes')
    process.exit(0)
  }
  if (!CONFIRMED) {
    log('⚠️  Falta --yes para confirmar el EXECUTE. Aborta por seguridad.')
    process.exit(1)
  }

  let ok = 0
  let failed = 0
  for (const m of moves) {
    try {
      // 1) Copiar (no mover) el archivo —y su miniatura— a la ruta nueva.
      await copyBunnyObject(config, m.oldPath, m.newPath)
      if (m.thumbOldPath && m.thumbNewPath) await copyBunnyObject(config, m.thumbOldPath, m.thumbNewPath)
      // 2) Verificar que el nuevo quedó accesible antes de tocar nada más.
      const check = await bunnyGet(config, m.newPath)
      if (!check.ok) throw new Error('el archivo nuevo no quedó accesible')
      // 3) Reescribir referencias externas + la fila del propio asset.
      await rewriteReferences(db, [
        [m.oldPublic, m.newPublic],
        [m.thumbOldPublic, m.thumbNewPublic]
      ])
      await updateAssetRow(db, m)
      // 4) Solo ahora borrar el viejo (y su miniatura).
      await deleteBunnyObject(config, m.oldPath)
      if (m.thumbOldPath) await deleteBunnyObject(config, m.thumbOldPath)
      ok++
      log(`✓ ${m.id}  ${m.oldPath} → ${m.newPath}`)
    } catch (err) {
      failed++
      log(`✗ ${m.id}  ${m.oldPath}  — ${err.message} (se conserva el viejo; re-ejecuta para reintentar)`)
    }
  }
  log(`\nHecho. OK: ${ok}, fallidos: ${failed}.`)
  process.exit(failed ? 1 : 0)
}

// Solo corre main() cuando se invoca como script (no al importarlo desde un test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
