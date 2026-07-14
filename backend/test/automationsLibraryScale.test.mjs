import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { databaseDialect, db } from '../src/config/database.js'
import { listAutomationsPage } from '../src/services/automationsService.js'

const backendServiceUrl = new URL('../src/services/automationsService.js', import.meta.url)
const frontendLibraryUrl = new URL('../../frontend/src/pages/Automations/AutomationLibrary.tsx', import.meta.url)
const frontendServiceUrl = new URL('../../frontend/src/services/automationsService.ts', import.meta.url)

test('la librería pagina por cursor, busca en servidor y no devuelve grafos en summaries ligeros', async () => {
  const marker = `automation_scale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const folderId = `${marker}_folder`
  const graph = JSON.stringify({
    nodes: [{
      id: 'start',
      type: 'start',
      position: { x: 0, y: 0 },
      config: { payload: 'x'.repeat(12_000) }
    }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })
  const flowPlaceholder = databaseDialect === 'postgres' ? '?::jsonb' : '?'

  try {
    if (databaseDialect === 'sqlite') {
      const migration = await readFile(
        new URL('../migrations/versioned/062_automations_library_pagination.sqlite.sql', import.meta.url),
        'utf8'
      )
      await db.exec(migration)
    }

    await db.run(
      `INSERT INTO automation_folders (id, name, position, created_at, updated_at)
       VALUES (?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [folderId, marker]
    )

    for (let index = 0; index < 145; index += 1) {
      const timestamp = `2098-11-${String(Math.floor(index / 24) + 1).padStart(2, '0')} ${String(index % 24).padStart(2, '0')}:00:00`
      await db.run(
        `INSERT INTO automations (
           id, folder_id, name, description, status, flow, published_flow,
           created_at, updated_at, published_at
         ) VALUES (?, ?, ?, ?, ?, ${flowPlaceholder}, ${flowPlaceholder}, ?, ?, ?)`,
        [
          `${marker}_${String(index).padStart(3, '0')}`,
          index < 35 ? folderId : null,
          `Flujo ${marker} ${index}`,
          `Descripción ${marker}`,
          index % 3 === 0 ? 'published' : 'draft',
          graph,
          index % 3 === 0 ? graph : null,
          timestamp,
          timestamp,
          index % 3 === 0 ? timestamp : null
        ]
      )
    }

    const firstPage = await listAutomationsPage({ search: marker, limit: 50 })
    assert.equal(firstPage.items.length, 50)
    assert.equal(firstPage.pageInfo.hasMore, true)
    assert.ok(firstPage.pageInfo.nextCursor)
    assert.ok(firstPage.items.every((item) => !('flow' in item)))
    assert.ok(
      Buffer.byteLength(JSON.stringify(firstPage), 'utf8') < 100_000,
      'cincuenta summaries no deben cargar 600 KB de grafos'
    )

    const secondPage = await listAutomationsPage({
      search: marker,
      limit: 50,
      cursor: firstPage.pageInfo.nextCursor
    })
    assert.equal(secondPage.items.length, 50)
    assert.equal(
      secondPage.items.some((item) => firstPage.items.some((first) => first.id === item.id)),
      false
    )

    const folderPage = await listAutomationsPage({ folderId, limit: 20 })
    assert.equal(folderPage.items.length, 20)
    assert.ok(folderPage.items.every((item) => item.folderId === folderId))
    assert.equal(folderPage.pageInfo.hasMore, true)

    const publishedPage = await listAutomationsPage({ search: marker, status: 'published', limit: 100 })
    assert.equal(publishedPage.items.length, 49)
    assert.ok(publishedPage.items.every((item) => item.status === 'published'))

    await assert.rejects(
      () => listAutomationsPage({ cursor: 'esto-no-es-un-cursor' }),
      (error) => error?.status === 400 && /Cursor/.test(error.message)
    )

    if (databaseDialect === 'sqlite') {
      const plan = await db.all(
        `EXPLAIN QUERY PLAN
         SELECT id
         FROM automations
         WHERE folder_id = ?
         ORDER BY COALESCE(updated_at, created_at, '1970-01-01 00:00:00') DESC, id DESC
         LIMIT 20`,
        [folderId]
      )
      assert.match(plan.map((row) => row.detail).join('\n'), /idx_automations_folder_updated_page/)
    }
  } finally {
    await db.run('DELETE FROM automations WHERE id LIKE ?', [`${marker}%`]).catch(() => undefined)
    await db.run('DELETE FROM automation_folders WHERE id = ?', [folderId]).catch(() => undefined)
  }
})

test('el contrato HTTP y la librería mantienen filtros y carga incremental server-side', async () => {
  const [backend, library, frontendService] = await Promise.all([
    readFile(backendServiceUrl, 'utf8'),
    readFile(frontendLibraryUrl, 'utf8'),
    readFile(frontendServiceUrl, 'utf8')
  ])

  const pagedList = backend.slice(
    backend.indexOf('export async function listAutomationsPage'),
    backend.indexOf('export async function getAutomation')
  )
  assert.match(pagedList, /LIMIT \?/)
  assert.match(pagedList, /limit \+ 1/)
  assert.match(pagedList, /SELECT id, flow, published_flow[\s\S]*WHERE id IN/)
  assert.match(pagedList, /reviewIds = includeReview/)
  assert.doesNotMatch(pagedList, /COUNT\(\*\)/)

  assert.match(library, /AUTOMATIONS_LIBRARY_PAGE_SIZE = 50/)
  assert.match(library, /search: debouncedQuery \|\| undefined/)
  assert.match(library, /cursor: append \? options\.cursor : null/)
  assert.match(library, /includeReview: false/)
  assert.match(library, /includeReview: true/)
  assert.match(library, /Cargar más/)
  assert.doesNotMatch(library, /automation\.name\.toLowerCase\(\)\.includes/)

  assert.match(frontendService, /OVERVIEW_PAGE_CACHE_TTL_MS = 15_000/)
  assert.match(frontendService, /OVERVIEW_PAGE_CACHE_MAX_ENTRIES = 40/)
  assert.match(frontendService, /params\.search = normalizedOptions\.search/)
  assert.match(frontendService, /invalidateAutomationListPages\(\)/)
})
