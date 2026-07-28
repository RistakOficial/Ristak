import test from 'node:test'
import assert from 'node:assert/strict'
import { db } from '../src/config/database.js'
import { getMetaApiVersion } from '../src/config/constants.js'
import {
  getCurrentVersion,
  initializeVersion
} from '../src/services/metaVersionService.js'

test('Meta sube instalaciones rezagadas al piso probado v25', async () => {
  const previousPinnedVersion = process.env.META_API_VERSION
  const previousRows = await db.all(
    'SELECT version, updated_at FROM meta_api_version ORDER BY id ASC'
  )

  try {
    delete process.env.META_API_VERSION
    await db.run('DELETE FROM meta_api_version')
    await db.run(
      "INSERT INTO meta_api_version (version, updated_at) VALUES ('v22.0', CURRENT_TIMESTAMP)"
    )

    assert.equal(await initializeVersion(), 'v25.0')
    assert.equal(await getCurrentVersion(), 'v25.0')
    assert.equal(getMetaApiVersion(), 'v25.0')
  } finally {
    await db.run('DELETE FROM meta_api_version')
    for (const row of previousRows) {
      await db.run(
        'INSERT INTO meta_api_version (version, updated_at) VALUES (?, ?)',
        [row.version, row.updated_at]
      )
    }
    if (previousPinnedVersion === undefined) {
      delete process.env.META_API_VERSION
    } else {
      process.env.META_API_VERSION = previousPinnedVersion
    }
  }
})
