// Fase D — CLI de la migración de taxonomía del Bunny central.
// La lógica vive en src/services/storageTaxonomyMigration.js (misma que usa la
// auto-migración de arranque). Aquí solo se parsean argumentos y se corre.
//
// Uso:
//   node scripts/reorganize-storage-taxonomy.mjs                 # DRY-RUN (no toca nada)
//   node scripts/reorganize-storage-taxonomy.mjs --execute --yes # aplica, SIN borrar lo viejo (seguro)
//   node scripts/reorganize-storage-taxonomy.mjs --execute --yes --delete  # además borra lo viejo
//   ... --limit=50
import 'dotenv/config'
import { runStorageTaxonomyMigration } from '../src/services/storageTaxonomyMigration.js'

const argv = process.argv.slice(2)
const EXECUTE = argv.includes('--execute')
const CONFIRMED = argv.includes('--yes')
const DELETE_OLD = argv.includes('--delete')
const limitArg = argv.find((a) => a.startsWith('--limit='))
const limit = limitArg ? Math.max(0, parseInt(limitArg.split('=')[1], 10) || 0) : 0

const log = (...a) => console.log(...a)

if (EXECUTE && !CONFIRMED) {
  log('⚠️  Falta --yes para confirmar el EXECUTE. Aborta por seguridad.')
  process.exit(1)
}

log('── Migración de taxonomía del Bunny central ──')
log(`Modo: ${EXECUTE ? `EXECUTE${DELETE_OLD ? ' (+borra lo viejo)' : ' (sin borrar, seguro)'}` : 'DRY-RUN (no toca nada)'}\n`)

const res = await runStorageTaxonomyMigration({ dryRun: !EXECUTE, deleteOld: DELETE_OLD, limit, log })

if (res.skipped) {
  log(`\nOmitida: ${res.reason}`)
  process.exit(1)
}
if (!res.planned) {
  log('\n✅ Nada que migrar: todo ya está bajo la nueva taxonomía.')
  process.exit(0)
}
if (res.dryRun) {
  log(`\nDRY-RUN: ${res.planned} archivos se re-enraizarían. No se movió nada.`)
  log('Para aplicarlo (seguro, sin borrar): --execute --yes')
  process.exit(0)
}
log(`\nHecho. Migrados: ${res.migrated}/${res.planned}, fallidos: ${res.failed}${res.deletedOld ? '' : ' (lo viejo quedó intacto como respaldo)'}.`)
process.exit(res.failed ? 1 : 0)
