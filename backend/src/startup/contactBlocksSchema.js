import { readFile } from 'node:fs/promises'

// The same additive DDL is used by fresh bootstrap, legacy fast-path and the
// versioned migration. No runtime catch may silently disable the blocking gate.
export async function ensureContactBlocksSchema(database) {
  const sql = await readFile(new URL('../../migrations/versioned/169_contact_blocks.sql', import.meta.url), 'utf8')
  await database.exec(sql)
}
