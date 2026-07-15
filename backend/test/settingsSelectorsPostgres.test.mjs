import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('PostgreSQL pagina selectores de Configuración con precisión y JSON importado acotado', {
  skip: !process.env.DATABASE_URL
}, async () => {
  const databaseUrl = new URL(process.env.DATABASE_URL)
  const pg = await import('pg')
  const OriginalPool = pg.default.Pool
  if (['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname)) {
    pg.default.Pool = class LocalPostgresTestPool extends OriginalPool {
      constructor(options) {
        super({ ...options, ssl: false })
      }
    }
  }

  let database
  let automations
  let sites
  try {
    [database, automations, sites] = await Promise.all([
      import('../src/config/database.js'),
      import('../src/services/automationsService.js'),
      import('../src/services/sitesService.js')
    ])
  } finally {
    pg.default.Pool = OriginalPool
  }

  assert.equal(database.databaseDialect, 'postgres')
  await database.db.exec(await readFile(
    new URL('../migrations/versioned/092_safe_jsonb.postgres.sql', import.meta.url),
    'utf8'
  ))
  for (const migration of [
    '105a_settings_selector_blocks_page.postgres.sql',
    '105b_settings_selector_imports_page.postgres.sql',
    '105c_settings_selector_blocks_search.postgres.sql',
    '105d_settings_selector_imports_search.postgres.sql'
  ]) {
    const sql = await readFile(new URL(`../migrations/versioned/${migration}`, import.meta.url), 'utf8')
    for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
      await database.db.run(statement)
    }
  }

  const selectorIndexes = await database.db.all(`
    SELECT indexname
    FROM pg_indexes
    WHERE indexname IN (
      'idx_public_site_blocks_form_catalog_page',
      'idx_public_site_imports_form_catalog_page',
      'idx_public_site_blocks_form_catalog_search',
      'idx_public_site_imports_form_catalog_search'
    )
  `)
  assert.equal(selectorIndexes.length, 4)

  const marker = `settings_selector_pg_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const siteIds = []
  const importedSiteId = `${marker}_imported`
  const importId = `${marker}_import`

  try {
    for (let index = 0; index < 64; index += 1) {
      const id = `${marker}_${String(index).padStart(3, '0')}`
      const timestamp = `2097-11-14T18:00:00.${String(123400 + index).padStart(6, '0')}Z`
      siteIds.push(id)
      await database.db.run(
        `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, created_at, updated_at)
         VALUES (?, ?, ?, 'standard_form', 'published', '{}', ?, ?)`,
        [id, `${marker} formulario ${index}`, `${marker}-${index}`, timestamp, timestamp]
      )
    }

    siteIds.push(importedSiteId)
    await database.db.run(
      `INSERT INTO public_sites (id, name, slug, site_type, status, theme_json, created_at, updated_at)
       VALUES (?, ?, ?, 'landing_page', 'published', '{}', NOW(), NOW())`,
      [importedSiteId, `${marker} importado`, `${marker}-importado`]
    )
    await database.db.run(
      `INSERT INTO public_site_imports (
         id, site_id, original_filename, html_sanitized, detected_forms_json,
         form_mappings_json, security_report_json, status
       ) VALUES (?, ?, 'landing.html', '<form></form>', '[]', ?::jsonb, '[]', 'ready')`,
      [
        importId,
        importedSiteId,
        JSON.stringify([{ formId: 'lead', formTitle: `${marker} lead`, fields: [] }])
      ]
    )

    const first = await automations.listAutomationFormsCatalogPage({ search: marker, limit: 20 })
    assert.equal(first.items.length, 20)
    assert.equal(first.hasMore, true)
    assert.ok(first.nextCursor)

    const decoded = JSON.parse(Buffer.from(first.nextCursor, 'base64url').toString('utf8'))
    assert.match(decoded.updatedAt, /\.\d{6}(?:\+00)?$/)

    const allIds = new Set()
    let cursor = ''
    for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
      const page = await automations.listAutomationFormsCatalogPage({ search: marker, limit: 20, cursor })
      page.items.forEach(item => allIds.add(item.id))
      if (!page.hasMore) break
      cursor = page.nextCursor || ''
    }
    assert.equal(allIds.size, 65)
    assert.ok(allIds.has(`${importedSiteId}:imported:lead`))

    const sitePage = await sites.listSiteSelectors({ kind: 'forms', search: marker, limit: 20 })
    assert.equal(sitePage.items.length, 20)
    assert.equal(sitePage.hasMore, true)
  } finally {
    await database.db.run('DELETE FROM public_site_imports WHERE id = ?', [importId]).catch(() => undefined)
    await database.db.run(
      `DELETE FROM public_sites WHERE id IN (${siteIds.map(() => '?').join(', ')})`,
      siteIds
    ).catch(() => undefined)
  }
})
